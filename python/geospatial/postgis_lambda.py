"""
===============================================================================
Geospatial Lambda: Aurora PostGIS + GeoJSON + MapBox
===============================================================================
READ-ONLY REFERENCE. Needs boto3 and a real Aurora cluster.

Two ways to reach Postgres from Lambda, and the choice matters more than the
SQL does:

  1. AURORA DATA API (used here). HTTP, IAM-authenticated, no connection at all.
     The credentials never leave Secrets Manager and there is no pool to
     exhaust. Slightly higher per-query latency; the right default for
     serverless.

  2. psycopg + RDS PROXY. A real Postgres connection, pooled and multiplexed by
     the proxy. Lower latency, supports cursors and COPY, needs VPC networking.
     Use it when the Data API's per-call overhead or its result-format
     limitations actually bite.

  What you must NOT do is open a raw psycopg connection per invocation. A
  thousand concurrent Lambdas means a thousand Postgres connections, and
  Postgres falls over in the low hundreds. This is the classic
  serverless-meets-relational failure, and RDS Proxy or the Data API is the
  fix - pick one before the first load test, not after.
"""

from __future__ import annotations

import json
import logging
import math
import os
from typing import Any

import boto3
from botocore.config import Config

logger = logging.getLogger()
logger.setLevel(logging.INFO)

rds_data = boto3.client("rds-data", config=Config(retries={"max_attempts": 3, "mode": "standard"}))

CLUSTER_ARN = os.environ["AURORA_CLUSTER_ARN"]
SECRET_ARN = os.environ["AURORA_SECRET_ARN"]
DATABASE = os.environ.get("AURORA_DATABASE", "meridian")


# =============================================================================
# Queries
# =============================================================================


def execute(sql: str, params: dict[str, Any]) -> list[dict[str, Any]]:
    """Run a parameterised statement and return plain dicts.

    ALWAYS named parameters, never f-strings or % formatting. A tenant_id comes
    from a JWT and a radius comes from a query string; both are
    attacker-influenced, and string-built SQL is how that becomes an incident.

    formatRecordsAs='JSON' is worth knowing about: without it the Data API
    returns a column-typed structure ({"stringValue": ...}) that you have to
    unpack by hand, and unpacking it by hand is where the bugs live.
    """
    response = rds_data.execute_statement(
        resourceArn=CLUSTER_ARN,
        secretArn=SECRET_ARN,
        database=DATABASE,
        sql=sql,
        parameters=[_param(name, value) for name, value in params.items()],
        formatRecordsAs="JSON",
    )
    return json.loads(response.get("formattedRecords", "[]"))


def _param(name: str, value: Any) -> dict[str, Any]:
    if isinstance(value, bool):
        return {"name": name, "value": {"booleanValue": value}}
    if isinstance(value, int):
        return {"name": name, "value": {"longValue": value}}
    if isinstance(value, float):
        return {"name": name, "value": {"doubleValue": value}}
    return {"name": name, "value": {"stringValue": str(value)}}


DRIVERS_WITHIN_RADIUS = """
    SELECT
        driver_id,
        name,
        region,
        headcount,
        ST_X(location::geometry) AS lon,
        ST_Y(location::geometry) AS lat,
        ROUND((ST_Distance(location, ST_MakePoint(:lon, :lat)::geography) / 1000)::numeric, 2) AS distance_km
    FROM drivers
    WHERE tenant_id = :tenant_id
      AND ST_DWithin(location, ST_MakePoint(:lon, :lat)::geography, :radius_m)
    ORDER BY location <-> ST_MakePoint(:lon, :lat)::geography
    LIMIT :max_rows;
"""
# Two things to be able to explain about that query:
#
#   ST_DWithin is INDEX-ASSISTED. The planner uses the GiST index for a bounding
#   box pre-filter, then refines with the exact distance. Writing
#   `WHERE ST_Distance(...) < n` instead computes a spherical distance for every
#   row in the table and loses the index entirely - same answer, ~100x the cost.
#
#   `<->` is the KNN distance operator. Ordering by it lets the index return
#   rows in distance order, instead of the planner sorting the whole result set.


INCIDENTS_AS_GEOJSON = """
    SELECT json_build_object(
        'type', 'FeatureCollection',
        'features', COALESCE(json_agg(
            json_build_object(
                'type', 'Feature',
                'id', d.driver_id,
                'geometry', ST_AsGeoJSON(s.location)::json,
                'properties', json_build_object(
                    'driverId',   d.driver_id,
                    'name',     s.name,
                    'severity', i.severity,
                    'title',    i.title,
                    'openedAt', i.opened_at
                )
            )
        ), '[]'::json)
    ) AS geojson
    FROM incidents i
    JOIN drivers d ON d.driver_id = ANY(i.driver_ids) AND s.tenant_id = i.tenant_id
    WHERE i.tenant_id = :tenant_id
      AND i.status <> 'resolved';
"""
# Building the FeatureCollection IN THE DATABASE means Lambda does no
# transformation at all: less code, less billed CPU time, and no opportunity to
# swap longitude and latitude on the way out.


CLUSTER_INCIDENTS = """
    SELECT
        ST_ClusterDBSCAN(location::geometry, eps := :eps_degrees, minpoints := 2) OVER () AS cluster_id,
        driver_id,
        ST_AsGeoJSON(location)::json AS geometry
    FROM drivers
    WHERE tenant_id = :tenant_id;
"""
# DBSCAN turns "eleven alerts" into "one regional outage" on a zoomed-out map.
# Note eps is in the SRID's units - DEGREES here, because the cast is to
# geometry. Roughly: 1 degree ~ 111km at the equator, less as you move poleward.


# =============================================================================
# Coordinate handling
# =============================================================================


def validate_lon_lat(lon: float, lat: float) -> None:
    """Reject out-of-range coordinates loudly.

    GeoJSON, PostGIS and MapBox GL all use [longitude, latitude].
    Leaflet, Google Maps and humans all say (latitude, longitude).

    A swapped pair is the single most common GIS bug, and it does not raise -
    it silently puts Dallas in Antarctica. Longitude has twice the valid range
    of latitude, so this check catches the swap whenever |lat| > 90, which is
    most real coordinates in the Americas.
    """
    if not (-180 <= lon <= 180):
        raise ValueError(f"longitude {lon} out of range - did you pass latitude first?")
    if not (-90 <= lat <= 90):
        raise ValueError(f"latitude {lat} out of range - did you pass longitude first?")


def haversine_km(lon1: float, lat1: float, lon2: float, lat2: float) -> float:
    """Great-circle distance. What ST_Distance(geography, geography) computes.

    Implemented here for the times you need a distance in a Lambda without a
    database round trip. ~0.5% error against a true ellipsoid (Vincenty) -
    fine for "which drivers are near the breakdown", not fine for surveying.
    """
    r = 6371.0
    d_lat = math.radians(lat2 - lat1)
    d_lon = math.radians(lon2 - lon1)

    h = (
        math.sin(d_lat / 2) ** 2
        + math.cos(math.radians(lat1)) * math.cos(math.radians(lat2)) * math.sin(d_lon / 2) ** 2
    )
    return 2 * r * math.asin(math.sqrt(h))


# =============================================================================
# MapBox
# =============================================================================


def severity_layer_style(source_id: str) -> dict[str, Any]:
    """The MapBox GL layer the front-end applies to our FeatureCollection.

    The key idea is DATA-DRIVEN EXPRESSIONS: colour and radius are computed on
    the GPU from `properties.severity` and `properties.impactScore`. No
    per-feature JavaScript, no re-render loop - change severity in the API and
    the map recolours itself.
    """
    return {
        "id": "drivers-circles",
        "type": "circle",
        "source": source_id,
        "paint": {
            "circle-color": [
                "match",
                ["get", "severity"],
                "critical", "#d7263d",
                "warning", "#f4a259",
                "info", "#4c86c8",
                "#3fa66b",  # default: ok
            ],
            "circle-radius": [
                "interpolate", ["linear"], ["zoom"],
                3, ["interpolate", ["linear"], ["get", "impactScore"], 0, 4, 40, 12],
                10, ["interpolate", ["linear"], ["get", "impactScore"], 0, 8, 40, 30],
            ],
            "circle-opacity": 0.85,
        },
    }


# =============================================================================
# Handler
# =============================================================================


def handler(event: dict[str, Any], context: Any) -> dict[str, Any]:
    """AppSync resolver for Query.driversNear and Query.mapLayer."""
    field = event["info"]["fieldName"]
    claims = event["identity"]["claims"]

    # The tenant comes from the VERIFIED token, never from event['arguments'].
    tenant_id = claims.get("custom:tenantId")
    if not tenant_id:
        raise PermissionError("no tenant claim on the token")

    args = event.get("arguments", {})

    if field == "driversNear":
        lon, lat = float(args["lon"]), float(args["lat"])
        validate_lon_lat(lon, lat)

        # Clamp the radius. An unbounded radius from a query string is a
        # denial-of-wallet vector: it makes every query return every row.
        radius_km = min(max(float(args.get("radiusKm", 100)), 0.1), 2000)

        return {
            "items": execute(
                DRIVERS_WITHIN_RADIUS,
                {
                    "tenant_id": tenant_id,
                    "lon": lon,
                    "lat": lat,
                    "radius_m": radius_km * 1000,
                    "max_rows": 100,
                },
            )
        }

    if field == "mapLayer":
        rows = execute(INCIDENTS_AS_GEOJSON, {"tenant_id": tenant_id})
        feature_collection = rows[0]["geojson"] if rows else {"type": "FeatureCollection", "features": []}

        return {
            "featureCollection": json.dumps(feature_collection),
            "layers": [severity_layer_style("meridian-drivers")],
        }

    raise ValueError(f"no resolver for {field}")

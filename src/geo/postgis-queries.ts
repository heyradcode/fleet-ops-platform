/**
 * ---------------------------------------------------------------------------
 * PostGIS on Aurora Serverless v2 - the queries that matter
 * ---------------------------------------------------------------------------
 * Why Aurora at all when we have DynamoDB? Because DynamoDB cannot answer
 * "which drivers are within 75km of this point", and it cannot answer "which
 * territory contains this position" at all. Spatial indexes and ad-hoc joins
 * are exactly what a relational engine is for. The split:
 *
 *   DynamoDB - hot, high-volume, known-key reads. Current driver position,
 *              telemetry, exceptions, incidents.
 *   Aurora   - reference data and anything spatial or analytical. Territories,
 *              geofences, route corridors, facilities.
 *
 * NOTE WHAT IS *NOT* HERE: the per-ping geofence check. At 11,000 readings a
 * second, a PostGIS round trip per ping is neither fast nor affordable. The hot
 * path does a bounding-box pre-filter in memory against geofences cached at
 * module scope (geo/spatial.ts), and PostGIS stays the source of truth for the
 * queries that are genuinely relational. Knowing which work belongs where is
 * most of the value of having both stores.
 *
 * Connecting from Lambda - the one thing people get wrong: a Lambda per request
 * means a Postgres connection per request, and Postgres dies at a few hundred.
 * Options, best first:
 *   1. RDS Proxy - pools and multiplexes connections. The default answer.
 *   2. Aurora Data API - HTTP, no connection at all, IAM-authed. Perfect for
 *      serverless; slightly higher latency. Used in the snippet below, and the
 *      reason this stack needs no VPC and therefore no NAT Gateway.
 *   3. Raw pg client with a module-scope pool - only for low concurrency.
 *
 * GEOMETRY vs GEOGRAPHY, the other guaranteed question:
 *   geometry  - planar/cartesian. Fast. Distances are in the SRID's units, so
 *               with SRID 4326 they are DEGREES, which is meaningless for
 *               "within 75km". Use it with a projected SRID.
 *   geography - spherical. `ST_DWithin` takes METRES and does the right thing
 *               across timezones and the antimeridian. Slower. Use this
 *               unless you have measured a reason not to.
 */

/**
 * Always parameterise. `$1`, `$2` - never string interpolation. A tenantId
 * arrives from a JWT and a radius arrives from a query string; both are
 * attacker-influenced.
 */
export const SQL = {
  /**
   * "Which drivers are within N metres of this point?"
   *
   * ST_DWithin is index-assisted: the planner uses the GiST index to do a bbox
   * pre-filter, then refines. Writing `ST_Distance(...) < n` instead LOSES the
   * index and forces a full scan - a very common and very expensive mistake.
   */
  driversWithinRadius: `
    SELECT
      driver_id,
      name,
      district_id,
      status,
      hos_remaining_minutes,
      ST_X(location::geometry) AS lon,
      ST_Y(location::geometry) AS lat,
      ROUND((ST_Distance(location, ST_MakePoint($2, $3)::geography) / 1000)::numeric, 2) AS distance_km
    FROM drivers
    WHERE tenant_id = $1
      AND ST_DWithin(location, ST_MakePoint($2, $3)::geography, $4)
    ORDER BY location <-> ST_MakePoint($2, $3)::geography
    LIMIT $5;
  `,

  /**
   * "Who could actually take this load?"
   *
   * The reassignment query, and the filters are not cosmetic: dispatching a
   * driver with no legal hours left is an hours-of-service violation, so the
   * platform must never surface the option. Enforcing that in SQL rather than
   * in the caller means every path gets it right, including the AI agent's
   * findNearbyAvailableDrivers tool.
   */
  availableDriversNear: `
    SELECT
      driver_id,
      name,
      status,
      hos_remaining_minutes,
      ROUND((ST_Distance(location, ST_MakePoint($2, $3)::geography) / 1000)::numeric, 2) AS distance_km
    FROM drivers
    WHERE tenant_id = $1
      AND ST_DWithin(location, ST_MakePoint($2, $3)::geography, $4)
      AND status <> 'off-duty'
      AND hos_remaining_minutes > $5
    ORDER BY location <-> ST_MakePoint($2, $3)::geography
    LIMIT 20;
  `,

  /**
   * "Which district contains this position?" - a spatial join.
   * ST_Contains is the polygon-membership test; pointInPolygon in spatial.ts
   * is the same algorithm, done in JS on the hot path.
   */
  districtContainingPoint: `
    SELECT t.district_id, t.name, t.region
    FROM territories t
    WHERE t.tenant_id = $1
      AND ST_Contains(t.boundary, ST_SetSRID(ST_MakePoint($2, $3), 4326));
  `,

  /**
   * "Which geofences is this driver inside?"
   *
   * The authoritative version of the check the ingest path does in memory.
   * Used for reconciliation and for anything that must be exactly right rather
   * than merely fast - a compliance report, a customer dispute.
   */
  geofencesContainingPoint: `
    SELECT g.geofence_id, g.name, g.kind
    FROM geofences g
    WHERE g.tenant_id = $1
      AND ST_Contains(g.boundary, ST_SetSRID(ST_MakePoint($2, $3), 4326));
  `,

  /**
   * "How far off the planned route is this driver?"
   *
   * ST_Distance against a LINESTRING geography returns metres to the nearest
   * point on the line - which IS route adherence. This is the query
   * deriveRouteAdherence() stands in for on the hot path.
   *
   * The `<->` operator in the ORDER BY is the KNN index operator: it uses the
   * GiST index to find nearest neighbours without measuring every row.
   */
  distanceFromCorridor: `
    SELECT
      c.corridor_id,
      c.name,
      ROUND(ST_Distance(c.path, ST_MakePoint($2, $3)::geography)::numeric, 0) AS metres
    FROM route_corridors c
    WHERE c.tenant_id = $1
      AND c.district_id = $4
    ORDER BY c.path <-> ST_MakePoint($2, $3)::geography
    LIMIT 1;
  `,

  /**
   * The dispatch board's map payload, built straight to GeoJSON in the database.
   *
   * ST_AsGeoJSON + json_build_object means Postgres hands you a
   * FeatureCollection the map can render with zero transformation in Lambda.
   * Less code, less CPU-time billed, no chance of a coordinate-order bug.
   */
  incidentsAsGeoJSON: `
    SELECT json_build_object(
      'type', 'FeatureCollection',
      'features', COALESCE(json_agg(
        json_build_object(
          'type', 'Feature',
          'id', d.driver_id,
          'geometry', ST_AsGeoJSON(d.location)::json,
          'properties', json_build_object(
            'driverId',   d.driver_id,
            'name',       d.name,
            'districtId', d.district_id,
            'status',     d.status,
            'severity',   i.severity,
            'title',      i.title,
            'openedAt',   i.opened_at
          )
        )
      ), '[]'::json)
    ) AS geojson
    FROM incidents i
    JOIN drivers d ON d.driver_id = ANY(i.driver_ids) AND d.tenant_id = i.tenant_id
    WHERE i.tenant_id = $1
      AND i.status <> 'resolved';
  `,

  /**
   * Cluster nearby open incidents. ST_ClusterDBSCAN groups points that are
   * within `eps` metres of at least `minpoints` neighbours - which is how you
   * turn "fourteen alerts" into "one road closure" on a zoomed-out map.
   *
   * This is the same idea as the merge rule in pipeline/steps.ts, applied at
   * render time rather than at detection time. Note the eps: metres, not
   * kilometres, and sized to a road closure rather than to a district.
   */
  clusterIncidents: `
    SELECT
      ST_ClusterDBSCAN(location::geometry, eps := $2, minpoints := 2) OVER () AS cluster_id,
      driver_id,
      ST_AsGeoJSON(location)::json AS geometry
    FROM drivers
    WHERE tenant_id = $1;
  `,
};

/**
 * Aurora Data API call. No connection pool, no VPC networking headache, IAM
 * auth, and the credentials never leave Secrets Manager.
 *
 *   import { RDSDataClient, ExecuteStatementCommand } from '@aws-sdk/client-rds-data';
 *
 *   const res = await new RDSDataClient({}).send(new ExecuteStatementCommand({
 *     resourceArn: process.env.AURORA_CLUSTER_ARN,
 *     secretArn:   process.env.AURORA_SECRET_ARN,
 *     database:    'meridian',
 *     sql:         SQL.availableDriversNear,
 *     parameters: [
 *       { name: 'tenantId', value: { stringValue: principal.tenantId } },
 *       { name: 'lon',      value: { doubleValue: lon } },
 *       { name: 'lat',      value: { doubleValue: lat } },
 *       { name: 'radiusM',  value: { doubleValue: radiusKm * 1000 } },
 *       { name: 'minHos',   value: { longValue: 60 } },
 *     ],
 *   }));
 *
 * Note the tenantId is bound from the verified JWT, not from the request body.
 * Row-level security in schema.sql enforces the same boundary a second time, so
 * even a query that forgot its tenant filter returns nothing.
 */
export const AURORA_DATA_API_EXAMPLE = SQL.availableDriversNear;

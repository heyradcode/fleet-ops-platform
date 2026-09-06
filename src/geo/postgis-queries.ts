/**
 * ---------------------------------------------------------------------------
 * PostGIS on Aurora Serverless v2 - the queries that matter
 * ---------------------------------------------------------------------------
 * Why Aurora at all when we have DynamoDB? Because DynamoDB cannot answer
 * "which sites are within 75km of this point". Spatial indexes and ad-hoc joins
 * are exactly what a relational engine is for. The split:
 *
 *   DynamoDB - hot, high-volume, known-key reads (signals, incidents)
 *   Aurora   - reference data + anything spatial or analytical (sites, regions)
 *
 * Connecting from Lambda - the one thing people get wrong: a Lambda per request
 * means a Postgres connection per request, and Postgres dies at a few hundred.
 * Options, best first:
 *   1. RDS Proxy - pools and multiplexes connections. The default answer.
 *   2. Aurora Data API - HTTP, no connection at all, IAM-authed. Perfect for
 *      serverless; slightly higher latency. Used in the snippet below.
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
   * "Which sites are within N metres of this point?"
   *
   * ST_DWithin is index-assisted: the planner uses the GiST index to do a bbox
   * pre-filter, then refines. Writing `ST_Distance(...) < n` instead LOSES the
   * index and forces a full scan - a very common and very expensive mistake.
   */
  sitesWithinRadius: `
    SELECT
      site_id,
      name,
      region,
      headcount,
      ST_X(location::geometry) AS lon,
      ST_Y(location::geometry) AS lat,
      ROUND((ST_Distance(location, ST_MakePoint($2, $3)::geography) / 1000)::numeric, 2) AS distance_km
    FROM sites
    WHERE tenant_id = $1
      AND ST_DWithin(location, ST_MakePoint($2, $3)::geography, $4)
    ORDER BY location <-> ST_MakePoint($2, $3)::geography
    LIMIT $5;
  `,

  /**
   * "Which service region contains this site?" - a spatial join.
   * ST_Contains is the polygon-membership test; pointInPolygon in spatial.ts
   * is the same algorithm, done in JS.
   */
  regionContainingPoint: `
    SELECT r.region_id, r.name
    FROM service_regions r
    WHERE r.tenant_id = $1
      AND ST_Contains(r.boundary, ST_SetSRID(ST_MakePoint($2, $3), 4326));
  `,

  /**
   * The reporting view, straight to GeoJSON in the database.
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
          'id', s.site_id,
          'geometry', ST_AsGeoJSON(s.location)::json,
          'properties', json_build_object(
            'siteId',   s.site_id,
            'name',     s.name,
            'severity', i.severity,
            'title',    i.title,
            'openedAt', i.opened_at
          )
        )
      ), '[]'::json)
    ) AS geojson
    FROM incidents i
    JOIN sites s ON s.site_id = ANY(i.site_ids) AND s.tenant_id = i.tenant_id
    WHERE i.tenant_id = $1
      AND i.status <> 'resolved';
  `,

  /**
   * Cluster nearby open incidents. ST_ClusterDBSCAN groups points that are
   * within `eps` metres of at least `minpoints` neighbours - which is how you
   * turn "eleven alerts" into "one regional outage" on a zoomed-out map.
   */
  clusterIncidents: `
    SELECT
      ST_ClusterDBSCAN(location::geometry, eps := $2, minpoints := 2) OVER () AS cluster_id,
      site_id,
      ST_AsGeoJSON(location)::json AS geometry
    FROM sites
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
 *     sql:         SQL.sitesWithinRadius,
 *     parameters: [
 *       { name: 'tenantId', value: { stringValue: principal.tenantId } },
 *       { name: 'lon',      value: { doubleValue: lon } },
 *       { name: 'lat',      value: { doubleValue: lat } },
 *       { name: 'radiusM',  value: { doubleValue: radiusKm * 1000 } },
 *       { name: 'limit',    value: { longValue: 50 } },
 *     ],
 *   }));
 *
 * Note the tenantId is bound from the verified JWT, not from the request body.
 */
export const AURORA_DATA_API_EXAMPLE = SQL.sitesWithinRadius;

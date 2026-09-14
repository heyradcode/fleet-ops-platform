/**
 * ---------------------------------------------------------------------------
 * PostGIS on Aurora Serverless v2 - the queries that matter
 * ---------------------------------------------------------------------------
 * Why Aurora at all when we have DynamoDB? Two questions it simply cannot
 * answer: "which sites are within 75km of this storm front", and - the one
 * asked far more often - "everything beneath this switch". Spatial indexes and
 * recursive joins are exactly what a relational engine is for. The split:
 *
 *   DynamoDB - hot, high-volume, known-key reads. Current device status,
 *              recent observations, alarms, incidents.
 *   Aurora   - the inventory, the topology, and anything spatial or
 *              analytical. Sites, devices, interfaces, aliases, regions.
 *
 * THE TOPOLOGY IS THE STRONGER ARGUMENT of the two. "Everything beneath this
 * switch" is one recursive CTE and one round trip; against a key-value store it
 * is one query per tier, and correlation asks it for every alarm it considers.
 * The spatial half is real but small - sites are the only thing with
 * coordinates worth indexing, because every device at a site shares one point.
 *
 * NOTE WHAT IS *NOT* HERE: a per-record lookup on the ingest path. At tens of
 * thousands of records a second, a round trip per syslog line costs more than
 * the pipeline it feeds. The hot path resolves against an inventory snapshot
 * held in memory (platform/inventory.ts), and Aurora stays the source of truth
 * that snapshot is built from. Knowing which work belongs where is most of the
 * value of having both stores.
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
   * Every device at one site, with its current status.
   *
   * The workhorse. Note that this is a plain indexed lookup, not a spatial one:
   * every device at a site shares the site's coordinate, so PostGIS has nothing
   * to contribute here. Reaching for ST_DWithin because the table happens to
   * have geometry in it is how a b-tree lookup becomes a sequential scan.
   */
  devicesAtSite: `
    SELECT d.device_id, d.name, d.role, d.vendor, d.status,
           s.name AS site_name, ST_X(s.location::geometry) AS lon,
                                ST_Y(s.location::geometry) AS lat
      FROM devices d
      JOIN sites   s ON s.site_id = d.site_id AND s.tenant_id = d.tenant_id
     WHERE d.tenant_id = $1
       AND d.site_id   = $2
     ORDER BY d.role, d.name;
  `,

  /**
   * Sites within a radius - the query that IS spatial.
   *
   * `ST_DWithin` on `geography` takes metres and uses the index; `ST_Distance`
   * in a WHERE clause does not. The difference is a scan of every site versus
   * an index lookup, and it is the single most common PostGIS mistake.
   */
  sitesWithinRadius: `
    SELECT site_id, name, region, headcount,
           ST_Distance(location, ST_MakePoint($2, $3)::geography) / 1000 AS distance_km
      FROM sites
     WHERE tenant_id = $1
       AND ST_DWithin(location, ST_MakePoint($2, $3)::geography, $4 * 1000)
     ORDER BY distance_km;
  `,

  /** Which service region contains this point. */
  regionContainingPoint: `
    SELECT region_id, name
      FROM regions
     WHERE tenant_id = $1
       AND ST_Contains(boundary::geometry, ST_MakePoint($2, $3)::geometry)
     LIMIT 1;
  `,

  /**
   * The topology walk, and the reason this is Postgres rather than DynamoDB.
   *
   * A recursive CTE answers "everything beneath this device" in one round trip.
   * The same question against a key-value store is one query per level, which
   * at four tiers is four sequential round trips per incident - and correlation
   * asks it for every alarm it considers.
   *
   * CYCLE is not decoration. LLDP discovery genuinely produces loops when a
   * link is mis-cabled, and without it this recurses until the connection dies.
   */
  subtreeOfDevice: `
    WITH RECURSIVE subtree AS (
      SELECT device_id, uplink_device_id, name, role, 0 AS depth
        FROM devices
       WHERE tenant_id = $1 AND device_id = $2
      UNION ALL
      SELECT d.device_id, d.uplink_device_id, d.name, d.role, s.depth + 1
        FROM devices d
        JOIN subtree s ON d.uplink_device_id = s.device_id
       WHERE d.tenant_id = $1 AND s.depth < 8
    ) CYCLE device_id SET is_cycle USING path
    SELECT device_id, name, role, depth
      FROM subtree
     WHERE depth > 0 AND NOT is_cycle
     ORDER BY depth, name;
  `,

  /**
   * Open incidents as GeoJSON, assembled by the database.
   *
   * `ST_AsGeoJSON` plus `json_build_object` means the API hands the client a
   * FeatureCollection without ever materialising one in application memory.
   * For a few hundred incidents that is a nicety; for the observation history
   * table it is the difference between a query and an out-of-memory kill.
   */
  incidentsAsGeoJSON: `
    SELECT json_build_object(
             'type', 'FeatureCollection',
             'features', COALESCE(json_agg(
               json_build_object(
                 'type', 'Feature',
                 'geometry', ST_AsGeoJSON(s.location::geometry)::json,
                 'properties', json_build_object(
                   'incidentId',  i.incident_id,
                   'title',       i.title,
                   'severity',    i.severity,
                   'siteId',      i.site_id,
                   'rootCause',   i.root_cause_device_id,
                   'deviceCount', COALESCE(array_length(i.device_ids, 1), 0)
                 )
               )
             ), '[]'::json)
           ) AS feature_collection
      FROM incidents i
      JOIN sites s ON s.site_id = i.site_id AND s.tenant_id = i.tenant_id
     WHERE i.tenant_id = $1
       AND i.status <> 'resolved';
  `,

  /**
   * Interface error rates over a window, for the capacity view.
   *
   * Runs against the observation history in Aurora rather than DynamoDB: this
   * is an analytical question over a time range, which is the access pattern a
   * key-value store is worst at and a relational one is built for.
   */
  interfaceErrorRates: `
    SELECT o.device_id, o.interface_id,
           SUM(o.value)                       AS errors,
           MAX(o.observed_at)                 AS last_seen,
           COUNT(*)                           AS samples
      FROM observations o
     WHERE o.tenant_id   = $1
       AND o.kind        = 'interface-errors'
       AND o.observed_at > NOW() - ($2 || ' hours')::interval
     GROUP BY o.device_id, o.interface_id
    HAVING SUM(o.value) > 0
     ORDER BY errors DESC
     LIMIT 50;
  `,
};

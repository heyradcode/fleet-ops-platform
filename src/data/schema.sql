-- ============================================================================
-- Aurora PostgreSQL + PostGIS schema
-- ============================================================================
-- Applied by the deploy pipeline (.github/workflows/terraform-apply.yml), not
-- by Terraform. `CREATE EXTENSION` is SQL, not a resource - and schema changes
-- want their own review and rollback story anyway.

CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS postgis_topology;

-- pg_trgm gives you fuzzy text search on site names. Cheap, and it saves you
-- from bolting on OpenSearch for what is really an autocomplete box.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- ----------------------------------------------------------------------------
-- Sites
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS sites (
    tenant_id   text NOT NULL,
    site_id     text NOT NULL,
    name        text NOT NULL,
    region      text NOT NULL,
    headcount   integer NOT NULL DEFAULT 0,

    -- GEOGRAPHY, not GEOMETRY.
    --   geography - spherical maths. ST_DWithin takes METRES and is correct
    --               across timezones and the antimeridian. Slower.
    --   geometry  - planar. Fast, but with SRID 4326 the distance unit is
    --               DEGREES, which is meaningless for "within 75km".
    -- Use geography unless you have measured a reason not to.
    location    geography(Point, 4326) NOT NULL,

    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now(),

    -- tenant_id FIRST in the primary key. Every query filters on it, and a
    -- leading tenant column keeps each tenant's rows physically clustered.
    PRIMARY KEY (tenant_id, site_id)
);

-- THE index that makes spatial queries fast. GiST is a general-purpose tree
-- for types with no natural linear order - exactly the case for geometry.
--
-- Without it, ST_DWithin degrades to a sequential scan computing a spherical
-- distance per row. With it, Postgres does an indexed bounding-box lookup and
-- then refines only the candidates. Two orders of magnitude on real data.
CREATE INDEX IF NOT EXISTS sites_location_gix ON sites USING GIST (location);

-- Composite index for the common "this tenant, this region" filter.
CREATE INDEX IF NOT EXISTS sites_tenant_region_idx ON sites (tenant_id, region);

-- Trigram index for fuzzy name search: WHERE name ILIKE '%dalas%'
CREATE INDEX IF NOT EXISTS sites_name_trgm_idx ON sites USING GIN (name gin_trgm_ops);

-- ----------------------------------------------------------------------------
-- Service regions
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS service_regions (
    tenant_id   text NOT NULL,
    region_id   text NOT NULL,
    name        text NOT NULL,

    -- Polygons stay as GEOMETRY: ST_Contains is a planar predicate and is
    -- both faster and better supported on geometry than on geography.
    boundary    geometry(MultiPolygon, 4326) NOT NULL,

    PRIMARY KEY (tenant_id, region_id),

    -- Reject invalid polygons at write time. Self-intersecting rings make
    -- ST_Contains return nonsense rather than an error, which is a genuinely
    -- horrible bug to track down six months later.
    CONSTRAINT boundary_is_valid CHECK (ST_IsValid(boundary))
);

CREATE INDEX IF NOT EXISTS regions_boundary_gix ON service_regions USING GIST (boundary);

-- ----------------------------------------------------------------------------
-- Incidents
-- ----------------------------------------------------------------------------
-- Signals live in DynamoDB (high volume, key-based access). Incidents are
-- mirrored here because reporting on them needs joins and aggregates.

CREATE TABLE IF NOT EXISTS incidents (
    tenant_id    text NOT NULL,
    incident_id  text NOT NULL,
    title        text NOT NULL,
    severity     text NOT NULL CHECK (severity IN ('info', 'warning', 'critical')),
    status       text NOT NULL CHECK (status IN ('open', 'acknowledged', 'resolved')),
    site_ids     text[] NOT NULL,
    opened_at    timestamptz NOT NULL,
    resolved_at  timestamptz,
    ai_summary   text,

    PRIMARY KEY (tenant_id, incident_id)
);

-- PARTIAL index: only open incidents are ever listed on the dashboard, and
-- resolved ones accumulate forever. Indexing the 1% you query keeps the index
-- small enough to stay in memory.
CREATE INDEX IF NOT EXISTS incidents_open_idx
    ON incidents (tenant_id, opened_at DESC)
    WHERE status <> 'resolved';

-- GIN index over the site_ids array, so `WHERE 'dal-01' = ANY(site_ids)` and
-- the containment operators are indexed rather than scanned.
CREATE INDEX IF NOT EXISTS incidents_sites_gin ON incidents USING GIN (site_ids);

-- ----------------------------------------------------------------------------
-- Row-level security: tenant isolation enforced by the database
-- ----------------------------------------------------------------------------
-- Defence in depth. Application code filters by tenant, IAM restricts the
-- DynamoDB partition keys, and RLS means that even a SQL injection or a
-- forgotten WHERE clause cannot read another tenant's rows.
--
-- The connection sets `SET LOCAL app.tenant_id = '<from the verified JWT>'`
-- at the start of each transaction; the policy reads it back.

ALTER TABLE sites ENABLE ROW LEVEL SECURITY;
ALTER TABLE service_regions ENABLE ROW LEVEL SECURITY;
ALTER TABLE incidents ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON sites;
CREATE POLICY tenant_isolation ON sites
    USING (tenant_id = current_setting('app.tenant_id', true));

DROP POLICY IF EXISTS tenant_isolation ON service_regions;
CREATE POLICY tenant_isolation ON service_regions
    USING (tenant_id = current_setting('app.tenant_id', true));

DROP POLICY IF EXISTS tenant_isolation ON incidents;
CREATE POLICY tenant_isolation ON incidents
    USING (tenant_id = current_setting('app.tenant_id', true));

-- IMPORTANT: RLS is bypassed by the table owner and by any role with the
-- BYPASSRLS attribute. The application must connect as a NON-owner role, or
-- these policies are decorative.
-- (The `true` second argument to current_setting means "return NULL rather
--  than error if unset", so an unset tenant matches nothing instead of
--  crashing - fail closed.)

-- ----------------------------------------------------------------------------
-- Seed data
-- ----------------------------------------------------------------------------
-- ST_MakePoint takes (LONGITUDE, LATITUDE) - x then y. Getting this backwards
-- is the most common GIS bug there is, and it fails silently.

INSERT INTO sites (tenant_id, site_id, name, region, headcount, location) VALUES
    ('acme', 'dal-01', 'Dallas HQ',          'us-south',   1200, ST_MakePoint(-96.7970,  32.7767)::geography),
    ('acme', 'aus-01', 'Austin Campus',      'us-south',    640, ST_MakePoint(-97.7431,  30.2672)::geography),
    ('acme', 'den-01', 'Denver Office',      'us-west',     310, ST_MakePoint(-104.9903, 39.7392)::geography),
    ('acme', 'chi-01', 'Chicago Datacentre', 'us-central',   85, ST_MakePoint(-87.6298,  41.8781)::geography),
    ('acme', 'phx-01', 'Phoenix Branch',     'us-west',     140, ST_MakePoint(-112.0740, 33.4484)::geography)
ON CONFLICT (tenant_id, site_id) DO UPDATE
    SET name = EXCLUDED.name,
        location = EXCLUDED.location,
        updated_at = now();

INSERT INTO service_regions (tenant_id, region_id, name, boundary) VALUES
    ('acme', 'us-south', 'US South', ST_Multi(ST_GeomFromText(
        'POLYGON((-106.0 25.5, -93.0 25.5, -93.0 36.5, -106.0 36.5, -106.0 25.5))', 4326)))
ON CONFLICT (tenant_id, region_id) DO NOTHING;

-- ----------------------------------------------------------------------------
-- Verify the index is actually being used
-- ----------------------------------------------------------------------------
-- Run this after any change to a spatial query. You want to see
-- "Index Scan using sites_location_gix". If you see "Seq Scan", something -
-- usually a function wrapped around the indexed column, or ST_Distance(...) < n
-- instead of ST_DWithin - has defeated the index.
--
--   EXPLAIN (ANALYZE, BUFFERS)
--   SELECT site_id, ST_Distance(location, ST_MakePoint(-96.797, 32.7767)::geography) / 1000 AS km
--   FROM sites
--   WHERE tenant_id = 'acme'
--     AND ST_DWithin(location, ST_MakePoint(-96.797, 32.7767)::geography, 400000);

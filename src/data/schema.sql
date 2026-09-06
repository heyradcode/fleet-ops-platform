-- ============================================================================
-- Aurora PostgreSQL + PostGIS schema
-- ============================================================================
-- Applied by the deploy pipeline (.github/workflows/terraform-apply.yml), not
-- by Terraform. `CREATE EXTENSION` is SQL, not a resource - and schema changes
-- want their own review and rollback story anyway.
--
-- WHAT LIVES HERE AND WHAT DOES NOT. This database holds reference data and
-- anything genuinely spatial: territories, geofences, route corridors,
-- facilities. Current driver position lives in DynamoDB, because it is
-- overwritten thousands of times a second and always read by key. Position
-- HISTORY lives in S3 as Parquet, because there is ~950M rows a day of it.
-- Putting either in here would make this database the bottleneck.

CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS postgis_topology;

-- pg_trgm gives you fuzzy text search on driver and facility names. Cheap, and
-- it saves you from bolting on OpenSearch for what is really an autocomplete box.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- ----------------------------------------------------------------------------
-- Drivers
-- ----------------------------------------------------------------------------
-- The relational mirror of the DynamoDB hot-state item. DynamoDB serves the
-- board; this copy exists so drivers can participate in spatial joins - "who is
-- inside this territory", "who is near this breakdown" - which DynamoDB cannot
-- answer at all.

CREATE TABLE IF NOT EXISTS drivers (
    tenant_id             text NOT NULL,
    driver_id             text NOT NULL,
    name                  text NOT NULL,
    district_id           text NOT NULL,
    vehicle_id            text NOT NULL,
    status                text NOT NULL
        CHECK (status IN ('driving', 'stopped', 'on-break', 'off-duty')),

    -- Minutes of legal drive time remaining. A CHECK rather than a comment:
    -- a negative value here would mean the platform is showing a dispatcher an
    -- option that is illegal to take.
    hos_remaining_minutes integer NOT NULL DEFAULT 0
        CHECK (hos_remaining_minutes >= 0),

    -- GEOGRAPHY, not GEOMETRY.
    --   geography - spherical maths. ST_DWithin takes METRES and is correct
    --               across timezones and the antimeridian. Slower.
    --   geometry  - planar. Fast, but with SRID 4326 the distance unit is
    --               DEGREES, which is meaningless for "within 75km".
    -- Use geography unless you have measured a reason not to.
    location              geography(Point, 4326) NOT NULL,

    created_at            timestamptz NOT NULL DEFAULT now(),
    updated_at            timestamptz NOT NULL DEFAULT now(),

    -- tenant_id FIRST in the primary key. Every query filters on it, and a
    -- leading tenant column keeps each tenant's rows physically clustered.
    PRIMARY KEY (tenant_id, driver_id)
);

-- GiST is the spatial index. Without it, ST_DWithin degrades to a sequential
-- scan and every "who is nearby" query reads the whole fleet.
CREATE INDEX IF NOT EXISTS drivers_location_gist ON drivers USING GIST (location);

-- The dispatcher's board: every driver in one district. Partial-ish covering
-- index so the common query never touches the heap.
CREATE INDEX IF NOT EXISTS drivers_district_idx ON drivers (tenant_id, district_id, status);

-- ----------------------------------------------------------------------------
-- Territories - the dispatch districts
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS territories (
    tenant_id   text NOT NULL,
    district_id text NOT NULL,
    name        text NOT NULL,
    region      text NOT NULL,

    -- The depot drivers start and end at.
    hub         geography(Point, 4326) NOT NULL,

    -- GEOMETRY here, not geography, and deliberately: ST_Contains is a planar
    -- predicate and is both faster and better supported on geometry. A district
    -- boundary is small enough that planar containment is exact for our
    -- purposes; distance queries still use geography.
    boundary    geometry(Polygon, 4326) NOT NULL,

    created_at  timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, district_id)
);

CREATE INDEX IF NOT EXISTS territories_boundary_gist ON territories USING GIST (boundary);

-- ----------------------------------------------------------------------------
-- Geofences - facilities, customer sites, restricted zones
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS geofences (
    tenant_id   text NOT NULL,
    geofence_id text NOT NULL,
    name        text NOT NULL,
    district_id text NOT NULL,
    kind        text NOT NULL
        CHECK (kind IN ('depot', 'customer', 'restricted', 'rest-stop')),
    boundary    geometry(Polygon, 4326) NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, geofence_id)
);

CREATE INDEX IF NOT EXISTS geofences_boundary_gist ON geofences USING GIST (boundary);

-- ----------------------------------------------------------------------------
-- Route corridors - the roads a planned route follows
-- ----------------------------------------------------------------------------
-- Distance from a corridor IS route adherence, and it is the join that makes a
-- road closure detectable: several drivers whose distance from the SAME
-- corridor jumps at the SAME place.

CREATE TABLE IF NOT EXISTS route_corridors (
    tenant_id   text NOT NULL,
    corridor_id text NOT NULL,
    name        text NOT NULL,
    district_id text NOT NULL,

    -- LINESTRING as geography, so ST_Distance returns metres directly rather
    -- than degrees. That is the number the route-adherence rule thresholds on.
    path        geography(LineString, 4326) NOT NULL,

    created_at  timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, corridor_id)
);

CREATE INDEX IF NOT EXISTS corridors_path_gist ON route_corridors USING GIST (path);
CREATE INDEX IF NOT EXISTS corridors_district_idx ON route_corridors (tenant_id, district_id);

-- ----------------------------------------------------------------------------
-- Incidents
-- ----------------------------------------------------------------------------
-- Mirrored from DynamoDB so incidents can be joined against driver positions
-- for the map payload. DynamoDB remains the write path.

CREATE TABLE IF NOT EXISTS incidents (
    tenant_id     text NOT NULL,
    incident_id   text NOT NULL,
    title         text NOT NULL,
    severity      text NOT NULL
        CHECK (severity IN ('ok', 'info', 'warning', 'critical')),
    status        text NOT NULL
        CHECK (status IN ('open', 'acknowledged', 'resolved')),
    district_id   text NOT NULL,
    driver_ids    text[] NOT NULL DEFAULT '{}',
    exception_ids text[] NOT NULL DEFAULT '{}',
    opened_at     timestamptz NOT NULL DEFAULT now(),
    ai_summary    text,
    PRIMARY KEY (tenant_id, incident_id)
);

-- GIN index over the driver_ids array, so `WHERE 'drv-1000' = ANY(driver_ids)`
-- and the containment operators are indexed rather than scanned.
CREATE INDEX IF NOT EXISTS incidents_drivers_gin ON incidents USING GIN (driver_ids);

CREATE INDEX IF NOT EXISTS incidents_open_idx ON incidents (tenant_id, district_id, opened_at DESC)
    WHERE status <> 'resolved';

-- ----------------------------------------------------------------------------
-- Row-level security: tenant isolation enforced by the database
-- ----------------------------------------------------------------------------
-- Defence in depth, and the layer people forget. Application code filters by
-- tenant, IAM restricts the DynamoDB partition keys, and RLS means that even a
-- SQL injection or a forgotten WHERE clause cannot read another tenant's rows.
--
-- The connection sets these at the start of each transaction, from the VERIFIED
-- JWT and never from the request body:
--
--   SET LOCAL app.tenant_id = '<claims custom:tenantId>';
--   SET LOCAL app.district  = '<claims custom:district, or empty for tenant-wide>';
--
-- EVERY SPATIAL TABLE NEEDS ITS OWN POLICY. Adding a table without one is the
-- easiest way to silently lose this layer: the table exists, queries work, and
-- nothing tells you isolation stopped applying to it.

ALTER TABLE drivers         ENABLE ROW LEVEL SECURITY;
ALTER TABLE territories     ENABLE ROW LEVEL SECURITY;
ALTER TABLE geofences       ENABLE ROW LEVEL SECURITY;
ALTER TABLE route_corridors ENABLE ROW LEVEL SECURITY;
ALTER TABLE incidents       ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON territories;
CREATE POLICY tenant_isolation ON territories
    USING (tenant_id = current_setting('app.tenant_id', true));

DROP POLICY IF EXISTS tenant_isolation ON geofences;
CREATE POLICY tenant_isolation ON geofences
    USING (tenant_id = current_setting('app.tenant_id', true));

DROP POLICY IF EXISTS tenant_isolation ON route_corridors;
CREATE POLICY tenant_isolation ON route_corridors
    USING (tenant_id = current_setting('app.tenant_id', true));

-- Drivers and incidents carry a SECOND boundary inside the tenant.
--
-- Tenant isolation is the hard wall - crossing it is a breach. District scope
-- is a narrower rule on top: a Dallas dispatcher has no business reading
-- Phoenix's board either. An empty `app.district` means tenant-wide, which is
-- what an admin or a regional manager gets; the application decides who is
-- allowed to set it that way (see platform/tenancy.ts, Scope).
--
-- Expressing scope here as well as in the application is the same defence-in-
-- depth argument as tenancy: two independent mechanisms, either of which alone
-- prevents the leak.
DROP POLICY IF EXISTS tenant_isolation ON drivers;
CREATE POLICY tenant_isolation ON drivers
    USING (
        tenant_id = current_setting('app.tenant_id', true)
        AND (
            COALESCE(current_setting('app.district', true), '') = ''
            OR district_id = current_setting('app.district', true)
        )
    );

DROP POLICY IF EXISTS tenant_isolation ON incidents;
CREATE POLICY tenant_isolation ON incidents
    USING (
        tenant_id = current_setting('app.tenant_id', true)
        AND (
            COALESCE(current_setting('app.district', true), '') = ''
            OR district_id = current_setting('app.district', true)
        )
    );

-- IMPORTANT: RLS is bypassed by the table owner and by any role with the
-- BYPASSRLS attribute. The application must connect as a NON-owner role, or
-- these policies are decorative.
-- (The `true` second argument to current_setting means "return NULL rather
--  than error if unset", so an unset tenant matches nothing instead of
--  crashing - fail closed.)

-- ----------------------------------------------------------------------------
-- Seed data
-- ----------------------------------------------------------------------------
-- Five districts and their depots. The fleet itself is generated at runtime
-- (src/data/generate.ts) rather than seeded here - the generator is readable
-- code that shows what a fleet looks like, where a few hundred INSERT rows
-- would just be noise that rots when the model changes.

INSERT INTO territories (tenant_id, district_id, name, region, hub, boundary) VALUES
    ('acme-freight', 'dal', 'Dallas',  'us-south',
     ST_MakePoint(-96.7970, 32.7767)::geography,
     ST_SetSRID(ST_MakeEnvelope(-97.20, 32.45, -96.35, 33.20), 4326)),
    ('acme-freight', 'aus', 'Austin',  'us-south',
     ST_MakePoint(-97.7431, 30.2672)::geography,
     ST_SetSRID(ST_MakeEnvelope(-98.05, 30.00, -97.45, 30.60), 4326)),
    ('acme-freight', 'den', 'Denver',  'us-west',
     ST_MakePoint(-104.9903, 39.7392)::geography,
     ST_SetSRID(ST_MakeEnvelope(-105.35, 39.45, -104.60, 40.05), 4326)),
    ('acme-freight', 'chi', 'Chicago', 'us-central',
     ST_MakePoint(-87.6298, 41.8781)::geography,
     ST_SetSRID(ST_MakeEnvelope(-88.05, 41.60, -87.45, 42.10), 4326)),
    ('acme-freight', 'phx', 'Phoenix', 'us-west',
     ST_MakePoint(-112.0740, 33.4484)::geography,
     ST_SetSRID(ST_MakeEnvelope(-112.45, 33.25, -111.75, 33.75), 4326))
ON CONFLICT (tenant_id, district_id) DO NOTHING;

-- One corridor per district as a worked example; the rest are in
-- src/data/polylines.ts, which is what the offline demo reads.
INSERT INTO route_corridors (tenant_id, corridor_id, name, district_id, path) VALUES
    ('acme-freight', 'dal-i35e', 'I-35E', 'dal',
     ST_MakeLine(ARRAY[
         ST_MakePoint(-96.8520, 33.0480), ST_MakePoint(-96.8410, 32.9620),
         ST_MakePoint(-96.8330, 32.8850), ST_MakePoint(-96.8080, 32.8090),
         ST_MakePoint(-96.8020, 32.7480), ST_MakePoint(-96.8190, 32.6720)
     ])::geography)
ON CONFLICT (tenant_id, corridor_id) DO NOTHING;

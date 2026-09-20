-- ============================================================================
-- Aurora PostgreSQL + PostGIS schema
-- ============================================================================
-- Applied by the deploy pipeline (.github/workflows/terraform-apply.yml), not
-- by Terraform. `CREATE EXTENSION` is SQL, not a resource - and schema changes
-- want their own review and rollback story anyway.
--
-- WHAT LIVES HERE AND WHAT DOES NOT. This database holds the INVENTORY and the
-- TOPOLOGY: sites, devices, interfaces, the aliases each device is known by,
-- and which device feeds which. Current device status lives in DynamoDB,
-- because it is overwritten constantly and always read by key. Observation
-- history lives in S3 as Parquet, and flow records live in their own bucket
-- entirely. Putting any of those in here would make this database the
-- bottleneck.
--
-- THE TOPOLOGY IS WHY THIS IS POSTGRES AT ALL. "Everything beneath this switch"
-- is a recursive CTE and one round trip. The same question against a key-value
-- store is one query per tier, and correlation asks it for every alarm it
-- considers.

CREATE EXTENSION IF NOT EXISTS postgis;

-- pg_trgm gives fuzzy text search over device and site names. Cheap, and it
-- saves bolting on OpenSearch for what is really an autocomplete box.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- ----------------------------------------------------------------------------
-- Sites
-- ----------------------------------------------------------------------------
-- The only genuinely spatial entity in the platform. Devices inherit their
-- coordinates from the site they sit in, because forty switches in one building
-- ARE at one coordinate and pretending otherwise produces a map nobody can use.

CREATE TABLE IF NOT EXISTS sites (
  tenant_id   TEXT NOT NULL,
  site_id     TEXT NOT NULL,
  name        TEXT NOT NULL,
  region      TEXT NOT NULL,
  headcount   INTEGER NOT NULL DEFAULT 0,
  -- GEOGRAPHY, not geometry. Distances come back in metres and are correct
  -- across timezones and the antimeridian without anyone choosing a projection.
  location    GEOGRAPHY(POINT, 4326) NOT NULL,
  PRIMARY KEY (tenant_id, site_id)
);

-- GIST, not b-tree. A b-tree cannot answer "within 50km"; this index is what
-- makes ST_DWithin an index seek rather than a sequential scan.
CREATE INDEX IF NOT EXISTS sites_location_gix ON sites USING GIST (location);

CREATE TABLE IF NOT EXISTS regions (
  tenant_id   TEXT NOT NULL,
  region_id   TEXT NOT NULL,
  name        TEXT NOT NULL,
  boundary    GEOGRAPHY(POLYGON, 4326) NOT NULL,
  PRIMARY KEY (tenant_id, region_id)
);

CREATE INDEX IF NOT EXISTS regions_boundary_gix ON regions USING GIST (boundary);

-- ----------------------------------------------------------------------------
-- Devices
-- ----------------------------------------------------------------------------
-- The relational mirror of the DynamoDB hot-state item, plus the one thing
-- DynamoDB cannot store usefully: the edge to the device above it.

CREATE TABLE IF NOT EXISTS devices (
  tenant_id         TEXT NOT NULL,
  device_id         TEXT NOT NULL,
  site_id           TEXT NOT NULL,
  name              TEXT NOT NULL,
  vendor            TEXT NOT NULL CHECK (vendor IN ('cisco', 'juniper', 'aruba')),
  platform          TEXT NOT NULL,
  role              TEXT NOT NULL CHECK (role IN (
                      'core', 'distribution', 'access',
                      'wan-edge', 'wireless-ap', 'firewall')),
  status            TEXT NOT NULL DEFAULT 'unknown',
  cpu_utilisation   NUMERIC(5,2) NOT NULL DEFAULT 0,
  interfaces_down   INTEGER NOT NULL DEFAULT 0,

  -- THE TOPOLOGY EDGE. Self-referencing, nullable (a site root has no uplink),
  -- and deliberately NOT declared as a foreign key to itself with ON DELETE
  -- CASCADE: decommissioning a distribution switch must not silently delete
  -- every device beneath it. Orphans are a data-quality problem to report, not
  -- a cascade to run.
  uplink_device_id  TEXT,

  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, device_id),
  FOREIGN KEY (tenant_id, site_id) REFERENCES sites (tenant_id, site_id)
);

CREATE INDEX IF NOT EXISTS devices_site_idx ON devices (tenant_id, site_id);
-- The index that makes the recursive topology walk cheap: each level of the
-- CTE is a lookup by uplink, not a scan.
CREATE INDEX IF NOT EXISTS devices_uplink_idx ON devices (tenant_id, uplink_device_id);
CREATE INDEX IF NOT EXISTS devices_name_trgm ON devices USING GIN (name gin_trgm_ops);

-- ----------------------------------------------------------------------------
-- Device aliases - the join that makes ingestion work at all
-- ----------------------------------------------------------------------------
-- The same switch arrives as a syslog hostname, an SNMP sysName, a source IP, a
-- chassis serial and an LLDP chassis-id. Four of those five are operator-
-- editable and one moves on its own, so the platform assigns its own device_id
-- and treats every vendor string as an alias pointing at it.
--
-- THE UNIQUE CONSTRAINT IS THE POINT. Two devices claiming one alias is a real
-- and recurring situation - a hostname reused after a hardware swap, or two
-- branches that both called their switch `sw1`. The database refuses it, and
-- the ingestion path refuses to resolve it, because guessing produces observations
-- silently attributed to the wrong box: wrong, and looks fine.

CREATE TABLE IF NOT EXISTS device_aliases (
  tenant_id   TEXT NOT NULL,
  alias_kind  TEXT NOT NULL CHECK (alias_kind IN (
                'syslog-hostname', 'snmp-sysname', 'mgmt-ip',
                'chassis-serial', 'lldp-chassis-id', 'controller-id')),
  -- Lowercased on write. Syslog and SNMP routinely disagree about the
  -- capitalisation of one box's name.
  alias_value TEXT NOT NULL,
  device_id   TEXT NOT NULL,
  PRIMARY KEY (tenant_id, alias_value),
  FOREIGN KEY (tenant_id, device_id) REFERENCES devices (tenant_id, device_id)
    ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS device_aliases_device_idx ON device_aliases (tenant_id, device_id);

-- ----------------------------------------------------------------------------
-- Interfaces
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS interfaces (
  tenant_id        TEXT NOT NULL,
  interface_id     TEXT NOT NULL,
  device_id        TEXT NOT NULL,
  -- Canonical and expanded: `GigabitEthernet1/0/1`, never `Gi1/0/1`. Cisco
  -- abbreviates in syslog and does not in SNMP, and an exact-match lookup on
  -- the abbreviated form silently fails to correlate the two feeds.
  name             TEXT NOT NULL,
  if_index         INTEGER,
  -- FALSE unless ifIndex persistence is known to be configured. Where it is
  -- not, a reload renumbers every port and a metric series keeps flowing while
  -- quietly describing a different cable.
  if_index_stable  BOOLEAN NOT NULL DEFAULT FALSE,
  speed_mbps       INTEGER NOT NULL,
  description      TEXT,
  PRIMARY KEY (tenant_id, interface_id),
  FOREIGN KEY (tenant_id, device_id) REFERENCES devices (tenant_id, device_id)
    ON DELETE CASCADE,
  UNIQUE (tenant_id, device_id, name)
);

CREATE INDEX IF NOT EXISTS interfaces_device_idx ON interfaces (tenant_id, device_id);

-- ----------------------------------------------------------------------------
-- Observations - the analytical mirror
-- ----------------------------------------------------------------------------
-- NOT the operational store. DynamoDB serves the board; this table holds a
-- retained window for the questions a key-value store is worst at: "what did
-- this interface's error rate do over the last fortnight".
--
-- PARTITIONED BY MONTH, because the retention policy is a DROP rather than a
-- DELETE. Deleting hundreds of millions of rows leaves the table bloated and
-- the autovacuum running for days; dropping a partition is instant.

CREATE TABLE IF NOT EXISTS observations (
  tenant_id       TEXT NOT NULL,
  observation_id  TEXT NOT NULL,
  device_id       TEXT NOT NULL,
  interface_id    TEXT,
  site_id         TEXT,
  vendor          TEXT NOT NULL,
  encoding        TEXT NOT NULL,
  -- The corroboration primitive. Indexed, because "did anything OTHER than the
  -- device itself see this" is the question correlation asks most.
  plane           TEXT NOT NULL CHECK (plane IN ('device', 'controller', 'external')),
  class           TEXT NOT NULL CHECK (class IN ('metric', 'event', 'flow')),
  kind            TEXT NOT NULL,
  value           DOUBLE PRECISION,
  unit            TEXT,
  state           TEXT,
  severity        TEXT NOT NULL,
  observed_at     TIMESTAMPTZ NOT NULL,
  received_at     TIMESTAMPTZ NOT NULL,
  clock_skew_ms   BIGINT,
  attributes      JSONB NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (tenant_id, observation_id, observed_at)
) PARTITION BY RANGE (observed_at);

CREATE INDEX IF NOT EXISTS observations_device_time_idx
  ON observations (tenant_id, device_id, observed_at DESC);
CREATE INDEX IF NOT EXISTS observations_plane_idx
  ON observations (tenant_id, plane, observed_at DESC);

-- ----------------------------------------------------------------------------
-- Alarms and incidents
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS alarms (
  tenant_id        TEXT NOT NULL,
  alarm_id         TEXT NOT NULL,
  device_id        TEXT NOT NULL,
  interface_id     TEXT,
  site_id          TEXT NOT NULL,
  kind             TEXT NOT NULL,
  severity         TEXT NOT NULL,
  observation_ids  TEXT[] NOT NULL DEFAULT '{}',
  -- The distinct vantage points. Two or more is the bar for an incident, and
  -- an array rather than a count so the board can say WHICH ones agreed.
  planes           TEXT[] NOT NULL DEFAULT '{}',
  uplink_device_id TEXT,
  raised_at        TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (tenant_id, alarm_id)
);

CREATE INDEX IF NOT EXISTS alarms_site_time_idx ON alarms (tenant_id, site_id, raised_at DESC);

CREATE TABLE IF NOT EXISTS incidents (
  tenant_id             TEXT NOT NULL,
  incident_id           TEXT NOT NULL,
  title                 TEXT NOT NULL,
  severity              TEXT NOT NULL,
  status                TEXT NOT NULL DEFAULT 'open'
                          CHECK (status IN ('open', 'acknowledged', 'resolved')),
  site_id               TEXT NOT NULL,
  device_ids            TEXT[] NOT NULL DEFAULT '{}',
  alarm_ids             TEXT[] NOT NULL DEFAULT '{}',
  -- The device correlation believes is the cause. Nullable, because "no single
  -- device dominates" is an honest answer and better than nominating whichever
  -- one sorted first.
  root_cause_device_id  TEXT,
  opened_at             TIMESTAMPTZ NOT NULL,
  ai_summary            TEXT,
  PRIMARY KEY (tenant_id, incident_id)
);

-- Partial index: open incidents are a tiny fraction of the table and the only
-- ones anybody queries interactively.
CREATE INDEX IF NOT EXISTS incidents_open_idx
  ON incidents (tenant_id, opened_at DESC)
  WHERE status <> 'resolved';

-- ----------------------------------------------------------------------------
-- Row-level security: tenancy enforced by the database, not by the query
-- ----------------------------------------------------------------------------
-- The application already builds every key from a verified token. RLS is the
-- belt to that pair of braces: even a query with a forgotten WHERE clause
-- returns nothing outside the connection's tenant.
--
-- The tenant is set per connection with
--   SET LOCAL app.tenant_id = '...';
-- from the verified JWT, inside the transaction. LOCAL matters - a plain SET on
-- a pooled connection leaks the previous caller's tenant to the next one, which
-- is the exact failure this is supposed to prevent.

ALTER TABLE devices        ENABLE ROW LEVEL SECURITY;
ALTER TABLE device_aliases ENABLE ROW LEVEL SECURITY;
ALTER TABLE interfaces     ENABLE ROW LEVEL SECURITY;
ALTER TABLE alarms         ENABLE ROW LEVEL SECURITY;
ALTER TABLE incidents      ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON devices
  USING (tenant_id = current_setting('app.tenant_id', TRUE));
CREATE POLICY tenant_isolation ON device_aliases
  USING (tenant_id = current_setting('app.tenant_id', TRUE));
CREATE POLICY tenant_isolation ON interfaces
  USING (tenant_id = current_setting('app.tenant_id', TRUE));
CREATE POLICY tenant_isolation ON alarms
  USING (tenant_id = current_setting('app.tenant_id', TRUE));
CREATE POLICY tenant_isolation ON incidents
  USING (tenant_id = current_setting('app.tenant_id', TRUE));

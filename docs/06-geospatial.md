# Geospatial

## The trap, first

```
GeoJSON, PostGIS, MapBox GL  →  [longitude, latitude]   (x, y)
Leaflet, Google Maps, humans →  (latitude, longitude)   (y, x)
```

A swapped pair **does not throw**. It silently puts Dallas in Antarctica, and
you find out from a customer.

Defences that actually work:

- Name variables `lon` and `lat`. Never `a`/`b`, never `coords[0]`.
- Range-check at every API boundary. Longitude has twice the valid range of
  latitude, so `|lat| > 90` catches the swap for most real coordinates.
- Have a test asserting a known distance. Dallas → Austin is ~293km; if your
  function says 1,800km, you swapped.

→ `validate_lon_lat` in `python/geospatial/postgis_lambda.py`, the 400 in
`src/api/rest-handler.ts`, and the swap test in `src/geo/spatial.test.ts`.

---

## GeoJSON (RFC 7946)

The wire format for everything spatial.

```json
{
  "type": "Feature",
  "id": "dal-01",
  "geometry": { "type": "Point", "coordinates": [-96.797, 32.7767] },
  "properties": { "name": "Dallas HQ", "severity": "critical", "impactScore": 31 }
}
```

Three things to know:

1. Positions are `[lon, lat]` (optionally with elevation).
2. `properties` is an arbitrary bag — and it is how your **business data gets
   onto the map**. MapBox styles read it directly, so `severity` in properties
   becomes marker colour with no client-side code at all.
3. The CRS is always WGS84 (EPSG:4326). RFC 7946 removed the `crs` member; if a
   vendor sends you EPSG:3857 "GeoJSON", it is not GeoJSON.

A `FeatureCollection` may carry a `bbox`, which lets the client fit the viewport
in one step instead of computing it.

Rings in a `Polygon` must be **closed** (last position equals first).
→ `src/geo/geojson.ts`

---

## TopoJSON

GeoJSON that stopped repeating itself.

In GeoJSON, Texas and Oklahoma each store the border between them, in full,
independently. Every shared edge is duplicated. For US counties that is ~10MB
your mobile users download.

TopoJSON stores each shared edge **once**, as an "arc", and each shape becomes a
list of arc indices. Two more tricks compound it:

- **Quantisation** — snap coordinates onto a fixed integer grid, so they become
  small integers instead of 15-significant-digit floats.
- **Delta encoding** — store each point as an offset from the previous one, so
  the integers stay tiny (and gzip loves them).

Routinely 80–90% smaller. The demo measures **76% on a 600-vertex polygon** with
quantisation and delta encoding alone.

**The cost:** nothing consumes TopoJSON directly. The client calls
`topojson.feature()` to expand it back to GeoJSON before rendering. And it is
lossy — quantisation trades sub-metre precision for bytes.

**Which to use:**

| | Use |
|---|---|
| **GeoJSON** | Points, small/simple geometry, anything an API returns per request |
| **TopoJSON** | Large polygon sets with shared borders, served from S3 + CloudFront and cached hard — a static basemap that rarely changes |

→ `src/geo/topojson.ts`

---

## PostGIS

### Why a relational database in a serverless stack

DynamoDB cannot answer *"which sites are within 75km of this point"*. Spatial
indexes and ad-hoc joins are exactly what Postgres is for.

```
DynamoDB — hot, high-volume, known-key reads   (signals, incidents)
Aurora   — reference data, spatial, analytical (sites, regions, reporting)
```

### `geometry` vs `geography`

| | `geometry` | `geography` |
|---|---|---|
| Maths | Planar / cartesian | Spherical |
| `ST_DWithin` units | The SRID's units — **degrees** at 4326 | **Metres** |
| Antimeridian, poles | Wrong | Correct |
| Speed | Faster | Slower |

Default to `geography` for points you measure distances between. Keep polygons
as `geometry` — `ST_Contains` is a planar predicate and is better supported
there.

### The index, and how to lose it

```sql
CREATE INDEX sites_location_gix ON sites USING GIST (location);
```

GiST is a general-purpose tree for types with no natural linear order.

```sql
-- FAST: index-assisted. Bounding-box pre-filter, then exact refinement.
WHERE ST_DWithin(location, ST_MakePoint($1,$2)::geography, $3)

-- SLOW: computes a spherical distance for EVERY row in the table.
WHERE ST_Distance(location, ST_MakePoint($1,$2)::geography) < $3
```

Same answer, roughly two orders of magnitude apart. `EXPLAIN (ANALYZE, BUFFERS)`
and look for `Index Scan using sites_location_gix`. If you see `Seq Scan`,
something — usually a function wrapped around the indexed column — defeated it.

`ORDER BY location <-> point` uses the **KNN operator**, letting the index return
rows already in distance order instead of the planner sorting the whole result.

### Build GeoJSON in the database

```sql
SELECT json_build_object(
  'type', 'FeatureCollection',
  'features', json_agg(json_build_object(
    'type', 'Feature',
    'geometry', ST_AsGeoJSON(s.location)::json,
    'properties', json_build_object('siteId', s.site_id, 'severity', i.severity)
  ))
) FROM incidents i JOIN sites s ON …
```

Postgres hands you a FeatureCollection the map can render with **zero**
transformation in Lambda: less code, less billed CPU, and no opportunity to swap
lon/lat on the way out.

### Clustering

`ST_ClusterDBSCAN(geom, eps, minpoints)` groups nearby points — how you turn
"eleven alerts" into "one regional outage" on a zoomed-out map. Note `eps` is in
the SRID's units: degrees when cast to `geometry` (~111km per degree at the
equator, less as you move poleward).

### Connecting from Lambda

The classic serverless-meets-relational failure: a Lambda per request means a
Postgres connection per request, and Postgres dies in the low hundreds.

1. **RDS Proxy** — pools and multiplexes. The default answer.
2. **Aurora Data API** — HTTP, IAM-authed, no connection at all. Slightly higher
   per-call latency; perfect for serverless. This project uses it.
3. **Raw `pg`/`psycopg` with a module-scope pool** — only at low concurrency.

→ `src/geo/postgis-queries.ts`, `src/data/schema.sql`,
`python/geospatial/postgis_lambda.py`

---

## MapBox

The back-end's four jobs (the front-end does the rendering):

1. **Geocoding** — address → `[lon, lat]` when a site is created. Always check
   the `relevance` score; a low score means MapBox guessed, and silently saving a
   guessed coordinate puts a site in the wrong state.
2. **Isochrones** — "everywhere reachable in 30 minutes by car", for
   field-engineer dispatch. This is the thing MapBox does that PostGIS cannot.
   It returns GeoJSON polygons you can feed straight into `ST_Contains` to ask
   "which engineers can reach this site inside the SLA?"
3. **Directions** — ETA for the nearest engineer.
4. **The style spec** — the layer JSON the client applies to your data.

### Data-driven styling

```json
"circle-color": [
  "match", ["get", "severity"],
  "critical", "#d7263d",
  "warning",  "#f4a259",
  "#3fa66b"
]
```

Colour and radius are computed **on the GPU** from `properties.severity` and
`properties.impactScore`. No per-feature JavaScript, no re-render loop — change
severity in the API and the map recolours itself. This is why the API bothers to
put derived values into GeoJSON properties.

### Token hygiene

- `pk.*` (public) tokens are safe in the browser **only if URL-restricted** in
  the MapBox dashboard — otherwise someone else spends your quota.
- `sk.*` (secret) tokens are server-only. Secrets Manager, never a Lambda env
  var that a stack trace can print, never the front-end bundle.
- **Cache server-side calls.** Geocoding the same address twice is billable
  twice. DynamoDB with a TTL attribute is the obvious place.

→ `src/geo/mapbox.ts`

/**
 * ---------------------------------------------------------------------------
 * MapBox integration
 * ---------------------------------------------------------------------------
 * Backend responsibilities (the front-end does the rendering):
 *   1. Geocoding    - "1 Main St, Dallas" -> [lon, lat], when a site is created.
 *   2. Isochrones   - "everywhere reachable in 30 min" for field-engineer
 *                     dispatch. This is the one MapBox does that PostGIS cannot.
 *   3. Directions   - ETA for the nearest engineer to a failed site.
 *   4. Style spec   - the layer JSON the client applies to our FeatureCollection.
 *
 * TOKEN HYGIENE, and they will ask:
 *   - pk.* (public) tokens are safe in the browser but MUST be URL-restricted
 *     in the MapBox dashboard, or someone else spends your quota.
 *   - sk.* (secret) tokens are server-only. Secrets Manager. Never in a Lambda
 *     env var that a stack trace can print, and never in the front-end bundle.
 *   - Server-side calls should be cached: geocoding the same address twice is
 *     billable twice. Cache in DynamoDB with a TTL attribute.
 */
import type { GeoFeatureCollection } from './geojson.ts';
import type { Position } from './spatial.ts';

const GEOCODE_BASE = 'https://api.mapbox.com/geocoding/v5/mapbox.places';
const ISOCHRONE_BASE = 'https://api.mapbox.com/isochrone/v1/mapbox';

/**
 * Forward geocoding.
 *   GET {base}/{encodeURIComponent(query)}.json?access_token=..&limit=1&country=us
 * Response: { features: [{ center: [lon, lat], place_name, relevance }] }
 * Always check `relevance` - a low score means MapBox guessed, and silently
 * saving a guessed coordinate is how a site ends up in the wrong state.
 */
export function geocodeUrl(address: string, token: string): string {
  const params = new URLSearchParams({ access_token: token, limit: '1', country: 'us' });
  return GEOCODE_BASE + '/' + encodeURIComponent(address) + '.json?' + params;
}

/**
 * Isochrone: the polygon reachable within N minutes by car.
 *   GET {base}/driving/{lon},{lat}?contours_minutes=15,30&polygons=true
 * Returns GeoJSON polygons you can feed straight into ST_Contains to ask
 * "which engineers can reach this site inside the SLA?"
 */
export function isochroneUrl(centre: Position, minutes: number[], token: string): string {
  const params = new URLSearchParams({
    access_token: token,
    contours_minutes: minutes.join(','),
    polygons: 'true',
  });
  return ISOCHRONE_BASE + '/driving/' + centre[0] + ',' + centre[1] + '?' + params;
}

/**
 * The MapBox GL style layer the front-end applies to our FeatureCollection.
 *
 * The key idea: `properties.severity` and `properties.impactScore` from
 * geojson.ts are read by DATA-DRIVEN EXPRESSIONS below. Colour and radius are
 * computed on the GPU from the data - no per-feature JS, no re-render loop.
 * Change severity in the API and the map recolours itself.
 */
export function severityLayerStyle(sourceId: string) {
  return {
    id: 'sites-circles',
    type: 'circle',
    source: sourceId,
    paint: {
      'circle-color': [
        'match', ['get', 'severity'],
        'critical', '#d7263d',
        'warning', '#f4a259',
        'info', '#4c86c8',
        '#3fa66b',                 // default: ok
      ],
      // Interpolate radius from impactScore, scaled by zoom level.
      'circle-radius': [
        'interpolate', ['linear'], ['zoom'],
        3, ['interpolate', ['linear'], ['get', 'impactScore'], 0, 4, 40, 12],
        10, ['interpolate', ['linear'], ['get', 'impactScore'], 0, 8, 40, 30],
      ],
      'circle-opacity': 0.85,
      'circle-stroke-width': 1,
      'circle-stroke-color': '#ffffff',
    },
  };
}

/** What the /map/sites REST endpoint returns: data plus how to draw it. */
export function mapPayload(fc: GeoFeatureCollection) {
  return {
    source: { id: 'meridian-sites', type: 'geojson', data: fc },
    layers: [severityLayerStyle('meridian-sites')],
    // Fit the viewport in one step using the FeatureCollection's own bbox.
    fitBounds: fc.bbox,
  };
}

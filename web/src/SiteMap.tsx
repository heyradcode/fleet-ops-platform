/**
 * ---------------------------------------------------------------------------
 * The site map
 * ---------------------------------------------------------------------------
 * A real basemap, with an honest fallback.
 *
 * OpenFreeMap serves vector tiles with no API key, no registration and no
 * quota, which removes the reason the first version drew on a blank canvas.
 * Geography matters to an operations team - "the whole Austin campus is dark"
 * is a sentence that wants Austin on the screen - so the basemap is the
 * default.
 *
 * It is still a network resource, and this board is meant to run with the cable
 * pulled. So the style is fetched with a short timeout, and if it does not
 * arrive the map falls back to the dark canvas. Same layers, same interactions,
 * one fewer thing on screen. The legend says which mode it is in, and lets you
 * switch.
 *
 * THE MAP IS OF SITES, NOT DEVICES, and that is the difference from a fleet
 * board rather than a simplification of one. Sixty trucks are sixty points and
 * a scatter plot is informative. Forty switches in one building share a single
 * coordinate exactly, so plotting devices produces forty markers stacked on one
 * pixel: unclickable, uncountable and actively misleading about where the
 * problem is. So a site is one circle, sized by how much is in it and coloured
 * by the worst thing happening there, and the device detail lives in a panel
 * beside the map where it can be read.
 *
 * The relation that matters between devices - which one feeds which - is not
 * geographic at all and is not drawn here. It is in the panel, as a tree.
 *
 * DATA-DRIVEN STYLING: colour and radius come from GeoJSON `properties` via
 * MapLibre expressions, evaluated on the GPU. No per-feature JavaScript and no
 * re-render loop, so a health frame is one `setData` call rather than a React
 * update per site.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import maplibregl, { type Map as MapLibreMap, type StyleSpecification } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';

import type { DeviceState, Site } from './transport/index.ts';

/** Campus zoom: one site and the streets around it. */
const FOCUS_ZOOM = 11;

/** No key, no registration, no quota. Vector tiles under the ODbL. */
const BASEMAP_URL = 'https://tiles.openfreemap.org/styles/dark';
const BASEMAP_TIMEOUT_MS = 4000;
const GROUND = '#0e1116';

const COLOUR = {
  healthy: '#3fb27f',
  degraded: '#f0a202',
  down: '#e5484d',
  unknown: '#7e8ca0',
} as const;

/** The offline style: a dark ground and nothing else. Layers are added on top. */
const FALLBACK_STYLE: StyleSpecification = {
  version: 8,
  sources: {},
  layers: [{ id: 'ground', type: 'background', paint: { 'background-color': GROUND } }],
};

export type BasemapMode = 'streets' | 'canvas';

type Props = {
  sites: Site[];
  devices: DeviceState[];
  selectedSiteId?: string;
  onSelectSite(siteId: string): void;
  /** Reported once the map has decided whether tiles are available. */
  onBasemap?(mode: BasemapMode): void;
  /** Force a mode. Undefined means "streets if reachable". */
  basemap?: BasemapMode;
};

type SiteRollup = {
  site: Site;
  total: number;
  down: number;
  degraded: number;
  worst: keyof typeof COLOUR;
};

export function SiteMap({
  sites, devices, selectedSiteId, onSelectSite, onBasemap, basemap,
}: Props) {
  const container = useRef<HTMLDivElement>(null);
  const map = useRef<MapLibreMap | null>(null);
  const [ready, setReady] = useState(false);

  const rollups = useMemo(() => rollUp(sites, devices), [sites, devices]);

  // Latest props, readable from callbacks created at mount. Reading props
  // directly inside `load` paints what the board had at MOUNT - an empty
  // estate, because it has not finished loading - and then never repaints.
  const latest = useRef({ rollups, selectedSiteId, onSelectSite });
  latest.current = { rollups, selectedSiteId, onSelectSite };

  // A fit key that changes when the SET of sites changes, not when their health
  // does. A health frame must never yank the viewport out from under a pan.
  const siteKey = useMemo(
    () => rollups.map((r) => r.site.siteId).sort().join(','),
    [rollups],
  );

  // --- Create the map once (per basemap mode) -----------------------------
  useEffect(() => {
    const el = container.current;
    if (!el) return;

    let cancelled = false;
    let m: MapLibreMap | null = null;

    (async () => {
      const { style, mode } = await resolveStyle(basemap);
      if (cancelled) return;
      onBasemap?.(mode);

      m = new maplibregl.Map({
        container: el,
        style,
        center: [-96.797, 32.7767],
        zoom: 3.6,
        // Attribution is a licence condition for OpenStreetMap-derived tiles,
        // not a courtesy. Compact keeps it out of the way without hiding it.
        attributionControl: mode === 'streets' ? { compact: true } : false,
        // Pitch and rotation are wrong for this: an operator compares sites
        // against a mental map, and a tilted north-up-optional view makes that
        // harder for no gain.
        pitchWithRotate: false,
        dragRotate: false,
        touchZoomRotate: false,
      });

      m.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-left');

      // The basemap style names a few sprite icons its sheet does not carry,
      // and MapLibre warns about each one per tile. A 1px transparent image
      // satisfies the lookup; nothing of ours is drawn from a sprite.
      m.on('styleimagemissing', (e) => {
        if (m && !m.hasImage(e.id)) {
          m.addImage(e.id, { width: 1, height: 1, data: new Uint8Array(4) });
        }
      });

      m.on('load', () => {
        if (!m || cancelled) return;
        addEstateLayers(m);

        m.on('click', 'site-dot', (e) => {
          const id = e.features?.[0]?.properties?.siteId;
          if (typeof id === 'string') latest.current.onSelectSite(id);
        });
        m.on('mouseenter', 'site-dot', () => { m!.getCanvas().style.cursor = 'pointer'; });
        m.on('mouseleave', 'site-dot', () => { m!.getCanvas().style.cursor = ''; });

        // Paint what the board has NOW, not what it had at mount.
        const p = latest.current;
        paint(m, p.rollups, p.selectedSiteId);
        setReady(true);
      });

      map.current = m;
    })();

    return () => {
      cancelled = true;
      setReady(false);
      m?.remove();
      map.current = null;
    };
    // Recreated only when the basemap mode is forced to change. The other
    // props are read through `latest`, so they are deliberately not deps.
  }, [basemap]);

  // --- Repaint on every health change --------------------------------------
  useEffect(() => {
    const m = map.current;
    if (!m || !ready) return;
    paint(m, rollups, selectedSiteId);
  }, [ready, rollups, selectedSiteId]);

  // --- Fit when the SET of sites changes, or when the map becomes ready -----
  useEffect(() => {
    const m = map.current;
    if (!m || !ready || rollups.length === 0) return;

    const bounds = new maplibregl.LngLatBounds();
    for (const r of rollups) bounds.extend([r.site.lon, r.site.lat]);
    m.fitBounds(bounds, {
      padding: { top: 60, right: 60, bottom: 60, left: 60 },
      maxZoom: 9,
      duration: 600,
    });
    // siteKey, not rollups: a health frame must not move the camera.
  }, [ready, siteKey]);

  // --- Ease to the selected site -------------------------------------------
  useEffect(() => {
    const m = map.current;
    if (!m || !ready || !selectedSiteId) return;

    const r = latest.current.rollups.find((x) => x.site.siteId === selectedSiteId);
    if (!r) return;

    // Only ever zoom IN. If the operator has already chosen a closer view,
    // taking it away from them is worse than doing nothing.
    m.easeTo({
      center: [r.site.lon, r.site.lat],
      zoom: Math.max(m.getZoom(), FOCUS_ZOOM),
      duration: 700,
    });
  }, [ready, selectedSiteId]);

  return <div className="map" ref={container} />;
}

/* -------------------------------------------------------------------------- */

/**
 * One row per site, with the worst thing happening in it.
 *
 * WORST, not an average. A site with thirty-nine healthy devices and one dead
 * core switch is not 97% well - it is down, and a mean would paint it green.
 */
function rollUp(sites: Site[], devices: DeviceState[]): SiteRollup[] {
  return sites.map((site) => {
    const mine = devices.filter((d) => d.siteId === site.siteId);
    const down = mine.filter((d) => d.status === 'down').length;
    const degraded = mine.filter((d) => d.status === 'degraded').length;

    const worst: keyof typeof COLOUR =
      down > 0 ? 'down'
        : degraded > 0 ? 'degraded'
          : mine.length === 0 ? 'unknown' : 'healthy';

    return { site, total: mine.length, down, degraded, worst };
  }).filter((r) => r.total > 0);
}

/**
 * Decide the style. Streets if the tiles answer within the timeout, otherwise
 * the canvas - and the caller is told which, so the legend can say so.
 */
async function resolveStyle(
  forced?: BasemapMode,
): Promise<{ style: StyleSpecification | string; mode: BasemapMode }> {
  if (forced === 'canvas') return { style: FALLBACK_STYLE, mode: 'canvas' };

  try {
    const res = await fetch(BASEMAP_URL, { signal: AbortSignal.timeout(BASEMAP_TIMEOUT_MS) });
    if (!res.ok) throw new Error(String(res.status));
    const style = await res.json() as StyleSpecification;
    // Tint the basemap's ground to ours, so the map does not read as a
    // different-coloured rectangle set into the console.
    for (const layer of style.layers) {
      if (layer.type === 'background') {
        layer.paint = { ...(layer.paint ?? {}), 'background-color': GROUND };
      }
    }
    return { style, mode: 'streets' };
  } catch {
    return { style: FALLBACK_STYLE, mode: 'canvas' };
  }
}

function addEstateLayers(m: MapLibreMap): void {
  m.addSource('sites', { type: 'geojson', data: emptyCollection() });

  // A halo under a site with anything down, so an outage is visible at the zoom
  // an operator actually sits at rather than only on hover.
  m.addLayer({
    id: 'site-alarm',
    type: 'circle',
    source: 'sites',
    filter: ['>', ['get', 'down'], 0],
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 3, 18, 10, 42],
      'circle-color': COLOUR.down,
      'circle-opacity': 0.2,
      'circle-blur': 0.4,
    },
  });

  m.addLayer({
    id: 'site-dot',
    type: 'circle',
    source: 'sites',
    paint: {
      // Radius by DEVICE COUNT, so a datacentre reads bigger than a branch.
      // Square-rooted, because area is what the eye compares - scaling the
      // radius linearly makes a 16-device site look four times a 4-device one.
      'circle-radius': [
        'interpolate', ['linear'], ['zoom'],
        3, ['*', 2.2, ['sqrt', ['get', 'total']]],
        10, ['*', 5.5, ['sqrt', ['get', 'total']]],
      ],
      'circle-color': [
        'match', ['get', 'worst'],
        'healthy', COLOUR.healthy,
        'degraded', COLOUR.degraded,
        'down', COLOUR.down,
        COLOUR.unknown,
      ],
      // A dark stroke separates a site from a same-coloured road beneath it.
      'circle-stroke-width': ['case', ['==', ['get', 'selected'], true], 2.5, 1.25],
      'circle-stroke-color': ['case', ['==', ['get', 'selected'], true], '#f0a202', GROUND],
    },
  });

  // The device count, drawn in the circle. A site map with no numbers on it
  // makes the operator hover every dot to learn what they are looking at.
  m.addLayer({
    id: 'site-label',
    type: 'symbol',
    source: 'sites',
    layout: {
      'text-field': ['get', 'label'],
      'text-size': ['interpolate', ['linear'], ['zoom'], 3, 9, 10, 12],
      'text-offset': [0, 1.6],
      'text-anchor': 'top',
      'text-allow-overlap': false,
    },
    paint: {
      'text-color': '#c8d2de',
      'text-halo-color': GROUND,
      'text-halo-width': 1.4,
    },
  });
}

function emptyCollection() {
  return { type: 'FeatureCollection' as const, features: [] };
}

function paint(m: MapLibreMap, rollups: SiteRollup[], selectedSiteId?: string) {
  const source = m.getSource('sites') as maplibregl.GeoJSONSource | undefined;
  if (!source) return;

  source.setData({
    type: 'FeatureCollection',
    features: rollups.map((r) => ({
      type: 'Feature' as const,
      id: r.site.siteId,
      geometry: { type: 'Point' as const, coordinates: [r.site.lon, r.site.lat] },
      // Everything the layers style on lives here. Adding a visual rule later
      // means adding a property and an expression, not a render pass.
      properties: {
        siteId: r.site.siteId,
        label: r.site.name + '  ' + r.total,
        total: r.total,
        down: r.down,
        degraded: r.degraded,
        worst: r.worst,
        selected: r.site.siteId === selectedSiteId,
      },
    })),
  });
}

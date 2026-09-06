/**
 * ---------------------------------------------------------------------------
 * The dispatch map
 * ---------------------------------------------------------------------------
 * A real basemap, with an honest fallback.
 *
 * OpenFreeMap serves vector tiles with no API key, no registration and no
 * quota, which removes the reason the first version drew on a blank canvas.
 * Roads matter to a dispatcher - "she's on the frontage road" is a sentence
 * that needs a frontage road on the screen - so the basemap is the default.
 *
 * It is still a network resource, and this board is meant to run with the
 * cable pulled. So the style is fetched with a short timeout, and if it does
 * not arrive the map falls back to the dark canvas: corridors and fleet on a
 * plain ground. Same layers, same interactions, one fewer thing on screen. The
 * legend says which mode it is in, and lets you switch.
 *
 * DATA-DRIVEN STYLING: colour and radius come from GeoJSON `properties` via
 * MapLibre expressions, evaluated on the GPU. No per-feature JavaScript, no
 * re-render loop, and updating sixty pins - or sixty thousand - is one
 * `setData` call. That is also what makes trace replay cheap: each tick is one
 * setData, not sixty React updates.
 *
 * TWO BUGS THE FIRST VERSION HAD, recorded so they stay fixed:
 *
 *   1. The `load` handler painted the props captured at MOUNT - an empty
 *      fleet, because the board had not loaded yet. Data arriving before the
 *      map was ready was then painted with stale props. Props now live in a
 *      ref the handler reads at call time.
 *   2. `fitBounds` bailed if the map was not ready, and nothing re-ran it. The
 *      view sat at the initial zoom over Dallas with sixty invisible dots on a
 *      black square - which is what "the map doesn't work" looked like. The
 *      fit now runs when readiness flips, and only when the SET of drivers
 *      changes, never on a position tick (that would fight the user's pan).
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import maplibregl, { type Map as MapLibreMap, type StyleSpecification } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';

import type { Driver } from './transport/index.ts';
import { CORRIDORS } from '../../src/data/polylines.ts';

/** No key, no registration, no quota. Vector tiles under the ODbL. */
const BASEMAP_URL = 'https://tiles.openfreemap.org/styles/dark';
const BASEMAP_TIMEOUT_MS = 4000;
const GROUND = '#0e1116';

const COLOUR = {
  driving: '#3fb27f',
  stopped: '#7e8ca0',
  'on-break': '#5c7fa8',
  'off-duty': '#3d4653',
} as const;

/** The offline style: a dark ground and nothing else. Layers are added on top. */
const FALLBACK_STYLE: StyleSpecification = {
  version: 8,
  sources: {},
  layers: [{ id: 'ground', type: 'background', paint: { 'background-color': GROUND } }],
};

export type BasemapMode = 'streets' | 'canvas';

type Props = {
  drivers: Driver[];
  flagged: Set<string>;
  selectedId?: string;
  onSelect(driverId: string): void;
  /** Reported once the map has decided whether tiles are available. */
  onBasemap?(mode: BasemapMode): void;
  /** Force a mode. Undefined means "streets if reachable". */
  basemap?: BasemapMode;
};

export function DispatchMap({ drivers, flagged, selectedId, onSelect, onBasemap, basemap }: Props) {
  const container = useRef<HTMLDivElement>(null);
  const map = useRef<MapLibreMap | null>(null);
  const [ready, setReady] = useState(false);

  // Latest props, readable from callbacks created at mount. Reading props
  // directly inside `load` is bug #1 above.
  const latest = useRef({ drivers, flagged, selectedId, onSelect });
  latest.current = { drivers, flagged, selectedId, onSelect };

  // A fit key that changes when the fleet CHANGES, not when it MOVES.
  const fleetKey = useMemo(
    () => drivers.map((d) => d.driverId).sort().join(','),
    [drivers],
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
        zoom: 4.2,
        // Attribution is a licence condition for OpenStreetMap-derived tiles,
        // not a courtesy. Compact keeps it out of the way without hiding it.
        attributionControl: mode === 'streets' ? { compact: true } : false,
        // Pitch and rotation are wrong for this: a dispatcher compares
        // positions against a mental map of their district, and a tilted
        // north-up-optional view makes that harder for no gain.
        pitchWithRotate: false,
        dragRotate: false,
        touchZoomRotate: false,
      });

      m.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-left');

      m.on('load', () => {
        if (!m || cancelled) return;
        addFleetLayers(m, mode);

        m.on('click', 'driver-dot', (e) => {
          const id = e.features?.[0]?.properties?.driverId;
          if (typeof id === 'string') latest.current.onSelect(id);
        });
        m.on('mouseenter', 'driver-dot', () => { m!.getCanvas().style.cursor = 'pointer'; });
        m.on('mouseleave', 'driver-dot', () => { m!.getCanvas().style.cursor = ''; });

        // Paint what the board has NOW, not what it had at mount.
        const p = latest.current;
        paint(m, p.drivers, p.flagged, p.selectedId);
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
    // Recreated only when the basemap mode is forced to change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [basemap]);

  // --- Update the fleet without touching the map --------------------------
  useEffect(() => {
    const m = map.current;
    if (!m || !ready) return;
    paint(m, drivers, flagged, selectedId);
  }, [ready, drivers, flagged, selectedId]);

  // --- Fit when the SET of drivers changes, or when the map becomes ready --
  useEffect(() => {
    const m = map.current;
    if (!m || !ready || drivers.length === 0) return;

    const bounds = new maplibregl.LngLatBounds();
    for (const d of drivers) bounds.extend([d.lon, d.lat]);
    m.fitBounds(bounds, { padding: { top: 60, right: 60, bottom: 60, left: 60 }, maxZoom: 10, duration: 600 });
    // fleetKey, not drivers: a position tick must not yank the viewport.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, fleetKey]);

  return <div className="map" ref={container} />;
}

/* -------------------------------------------------------------------------- */

/**
 * Decide the style. Streets if the tiles answer within the timeout, otherwise
 * the canvas - and the caller is told which, so the legend can say so.
 */
async function resolveStyle(forced?: BasemapMode): Promise<{ style: StyleSpecification | string; mode: BasemapMode }> {
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

function addFleetLayers(m: MapLibreMap, mode: BasemapMode): void {
  // --- Route corridors ---------------------------------------------------
  m.addSource('corridors', {
    type: 'geojson',
    data: {
      type: 'FeatureCollection',
      features: CORRIDORS.map((c) => ({
        type: 'Feature' as const,
        id: c.corridorId,
        geometry: { type: 'LineString' as const, coordinates: c.path },
        properties: { name: c.name, districtId: c.districtId },
      })),
    },
  });

  // Over a basemap the corridor has to read as "OUR planned route", distinct
  // from the roads underneath it, so it is brighter and carries a dark casing.
  // On the plain canvas it IS the road, and can be quieter.
  const onStreets = mode === 'streets';
  m.addLayer({
    id: 'corridor-casing',
    type: 'line',
    source: 'corridors',
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': GROUND, 'line-width': onStreets ? 7 : 5, 'line-opacity': onStreets ? 0.85 : 1 },
  });
  m.addLayer({
    id: 'corridor-line',
    type: 'line',
    source: 'corridors',
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: {
      'line-color': onStreets ? '#6b7d94' : '#313b48',
      'line-width': ['interpolate', ['linear'], ['zoom'], 4, 1.2, 9, 2.4, 12, 3.5],
    },
  });

  // --- The fleet -----------------------------------------------------------
  m.addSource('drivers', { type: 'geojson', data: emptyCollection() });

  // A halo under flagged drivers, so an exception is visible at the zoom a
  // dispatcher actually sits at rather than only on hover.
  m.addLayer({
    id: 'driver-flag',
    type: 'circle',
    source: 'drivers',
    filter: ['==', ['get', 'flagged'], true],
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 4, 10, 10, 18],
      'circle-color': '#e5484d',
      'circle-opacity': 0.22,
      'circle-blur': 0.4,
    },
  });

  m.addLayer({
    id: 'driver-dot',
    type: 'circle',
    source: 'drivers',
    paint: {
      // Radius by zoom, not by status: at district zoom the pins are the
      // information, and at national zoom they must not merge into a blob.
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 4, 3.4, 8, 5.5, 12, 8],
      // Colour straight off a property - the same expression the
      // severityLayerStyle() helper in src/geo/mapbox.ts produces.
      'circle-color': [
        'match', ['get', 'status'],
        'driving', COLOUR.driving,
        'stopped', COLOUR.stopped,
        'on-break', COLOUR['on-break'],
        'off-duty', COLOUR['off-duty'],
        COLOUR.stopped,
      ],
      // A dark stroke separates a pin from a same-coloured road beneath it.
      'circle-stroke-width': ['case', ['==', ['get', 'selected'], true], 2.5, 1.25],
      'circle-stroke-color': ['case', ['==', ['get', 'selected'], true], '#f0a202', GROUND],
    },
  });
}

function emptyCollection() {
  return { type: 'FeatureCollection' as const, features: [] };
}

function paint(m: MapLibreMap, drivers: Driver[], flagged: Set<string>, selectedId?: string) {
  const source = m.getSource('drivers') as maplibregl.GeoJSONSource | undefined;
  if (!source) return;

  source.setData({
    type: 'FeatureCollection',
    features: drivers.map((d) => ({
      type: 'Feature' as const,
      id: d.driverId,
      geometry: { type: 'Point' as const, coordinates: [d.lon, d.lat] },
      // Everything the layer styles on lives here. Adding a visual rule later
      // means adding a property and an expression, not a render pass.
      properties: {
        driverId: d.driverId,
        status: d.status,
        flagged: flagged.has(d.driverId),
        selected: d.driverId === selectedId,
      },
    })),
  });
}

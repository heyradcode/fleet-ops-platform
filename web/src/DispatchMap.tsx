/**
 * ---------------------------------------------------------------------------
 * The dispatch map
 * ---------------------------------------------------------------------------
 * NO BASEMAP, and that is a decision rather than a shortcut.
 *
 * MapLibre is a renderer, not a data source - it draws nothing without tiles,
 * and every tile source costs either an API key (which breaks clone-and-run) or
 * a large binary committed to the repository. Neither is worth it here, because
 * a dispatch board is not a map of the world: it is a map of YOUR ROADS and
 * YOUR TRUCKS. Streets you do not run on are noise.
 *
 * So the ground stays dark and the only things drawn are the route corridors
 * and the fleet. It is also, as it happens, what an ops console actually looks
 * like at 2am.
 *
 * DATA-DRIVEN STYLING: colour and radius come from GeoJSON `properties` via
 * MapLibre expressions, evaluated on the GPU. No per-feature JavaScript, no
 * re-render loop, and updating sixty pins - or sixty thousand - is one
 * `setData` call.
 */
import { useEffect, useRef } from 'react';
import maplibregl, { type Map as MapLibreMap } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';

import type { Driver } from './transport/index.ts';
import { CORRIDORS } from '../../src/data/polylines.ts';

const COLOUR = {
  driving: '#3fb27f',
  stopped: '#7e8ca0',
  'on-break': '#5c7fa8',
  'off-duty': '#3d4653',
} as const;

type Props = {
  drivers: Driver[];
  flagged: Set<string>;
  selectedId?: string;
  onSelect(driverId: string): void;
};

export function DispatchMap({ drivers, flagged, selectedId, onSelect }: Props) {
  const container = useRef<HTMLDivElement>(null);
  const map = useRef<MapLibreMap | null>(null);
  const ready = useRef(false);
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;

  // --- Create the map once ------------------------------------------------
  useEffect(() => {
    if (!container.current || map.current) return;

    const m = new maplibregl.Map({
      container: container.current,
      style: {
        version: 8,
        // An empty source set. The style spec requires `sources`, and ours is
        // genuinely empty until the corridors and fleet are added below.
        sources: {},
        layers: [{ id: 'ground', type: 'background', paint: { 'background-color': '#0e1116' } }],
        glyphs: undefined,
      },
      center: [-96.797, 32.7767],
      zoom: 4.2,
      attributionControl: false,
      // Pitch and rotation are wrong for this: a dispatcher compares positions
      // against a mental map of their district, and a tilted north-up-optional
      // view makes that harder for no gain.
      pitchWithRotate: false,
      dragRotate: false,
      touchZoomRotate: false,
    });

    m.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-left');

    m.on('load', () => {
      // --- Route corridors ------------------------------------------------
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

      // Two passes: a wide dim casing and a thin bright line. One line at one
      // width reads as a scratch; a casing gives it the weight of a road.
      m.addLayer({
        id: 'corridor-casing',
        type: 'line',
        source: 'corridors',
        paint: { 'line-color': '#1b222b', 'line-width': 5 },
      });
      m.addLayer({
        id: 'corridor-line',
        type: 'line',
        source: 'corridors',
        paint: { 'line-color': '#313b48', 'line-width': 1.5 },
      });

      // --- The fleet -------------------------------------------------------
      m.addSource('drivers', { type: 'geojson', data: emptyCollection() });

      // A halo under flagged drivers, so an exception is visible at the zoom a
      // dispatcher actually sits at rather than only on hover.
      m.addLayer({
        id: 'driver-flag',
        type: 'circle',
        source: 'drivers',
        filter: ['==', ['get', 'flagged'], true],
        paint: {
          'circle-radius': ['interpolate', ['linear'], ['zoom'], 4, 9, 10, 16],
          'circle-color': '#e5484d',
          'circle-opacity': 0.22,
        },
      });

      m.addLayer({
        id: 'driver-dot',
        type: 'circle',
        source: 'drivers',
        paint: {
          // Radius by zoom, not by status: at district zoom the pins are the
          // information, and at national zoom they must not merge into a blob.
          'circle-radius': ['interpolate', ['linear'], ['zoom'], 4, 3.2, 8, 5.5, 12, 8],
          // Colour straight off a property. This is the expression the
          // severityLayerStyle() helper in src/geo/mapbox.ts produces, and it
          // runs on the GPU rather than in a render loop.
          'circle-color': [
            'match', ['get', 'status'],
            'driving', COLOUR.driving,
            'stopped', COLOUR.stopped,
            'on-break', COLOUR['on-break'],
            'off-duty', COLOUR['off-duty'],
            COLOUR.stopped,
          ],
          'circle-stroke-width': ['case', ['==', ['get', 'selected'], true], 2, 1],
          'circle-stroke-color': ['case', ['==', ['get', 'selected'], true], '#f0a202', '#0e1116'],
        },
      });

      m.on('click', 'driver-dot', (e) => {
        const id = e.features?.[0]?.properties?.driverId;
        if (typeof id === 'string') onSelectRef.current(id);
      });
      m.on('mouseenter', 'driver-dot', () => { m.getCanvas().style.cursor = 'pointer'; });
      m.on('mouseleave', 'driver-dot', () => { m.getCanvas().style.cursor = ''; });

      ready.current = true;
      m.getSource('drivers') && paint(m, drivers, flagged, selectedId);
    });

    map.current = m;
    return () => { m.remove(); map.current = null; ready.current = false; };
    // Created once. Data updates go through the effect below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // --- Update the fleet without touching the map --------------------------
  useEffect(() => {
    const m = map.current;
    if (!m || !ready.current) return;
    paint(m, drivers, flagged, selectedId);
  }, [drivers, flagged, selectedId]);

  // --- Fit to whatever is on screen ---------------------------------------
  useEffect(() => {
    const m = map.current;
    if (!m || !ready.current || drivers.length === 0) return;

    const bounds = new maplibregl.LngLatBounds();
    for (const d of drivers) bounds.extend([d.lon, d.lat]);
    m.fitBounds(bounds, { padding: 70, maxZoom: 9, duration: 550 });
  }, [drivers]);

  return <div className="map" ref={container} />;
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

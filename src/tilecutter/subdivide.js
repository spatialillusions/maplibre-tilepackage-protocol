// Phase A: Subdivide a parent vector tile into a higher zoom target tile.
// Minimal dependency implementation using @mapbox/vector-tile for decode and @maplibre/vt-pbf for encode.
// Public API: subdivideVectorTile(parentPbf, parentZ, parentX, parentY, targetZ, targetX, targetY, options)
// Returns { data: Uint8Array, stats }

import {
  VectorTile,
  VectorTileFeature,
  VectorTileLayer,
} from "@mapbox/vector-tile";
import Protobuf from "pbf";
import Point from "@mapbox/point-geometry";
import { fromVectorTileJs } from "@maplibre/vt-pbf";

/**
 * Subdivide parent tile PBF into higher zoom target tile.
 * @param {ArrayBuffer|Uint8Array} parentPbf - Raw parent tile PBF bytes.
 * @param {number} parentZ
 * @param {number} parentX
 * @param {number} parentY
 * @param {number} targetZ
 * @param {number} targetX
 * @param {number} targetY
 * @param {object} options
 * @param {number} [options.buffer=128] - Clip buffer.
 * @param {string[]|RegExp} [options.includeLayers] - Layer filter.
 * @param {number} [options.maxDzWarn=8] - Warn if dz larger.
 * @returns {{ data: Uint8Array, stats: any }}
 */
export function subdivideVectorTile(
  parentPbf,
  parentZ,
  parentX,
  parentY,
  targetZ,
  targetX,
  targetY,
  options = {},
) {
  const t0 = performance.now ? performance.now() : Date.now();
  const { buffer = 128, includeLayers, maxDzWarn = 8 } = options;
  const dz = targetZ - parentZ;
  if (dz <= 0) {
    // Nothing to subdivide, caller should just use original bytes.
    return { data: toUint8(parentPbf), stats: { dz, passthrough: true } };
  }
  if (dz > maxDzWarn && console && console.warn) {
    console.warn(
      `subdivideVectorTile: high dz=${dz}, performance may degrade.`,
    );
  }
  // Validate containment.
  const scale = Math.pow(2, dz);
  const expectedParentX = Math.floor(targetX / scale);
  const expectedParentY = Math.floor(targetY / scale);
  if (expectedParentX !== parentX || expectedParentY !== parentY) {
    throw new Error(
      "Target tile not contained within parent tile coordinates.",
    );
  }

  const vt = new VectorTile(new Protobuf(toUint8(parentPbf)));

  const overzoomed = new OverzoomedVectorTile();
  let featuresIn = 0;
  let featuresOut = 0;
  for (const layerName in vt.layers) {
    if (!Object.prototype.hasOwnProperty.call(vt.layers, layerName)) continue;
    if (includeLayers) {
      if (Array.isArray(includeLayers) && !includeLayers.includes(layerName))
        continue;
      if (includeLayers instanceof RegExp && !includeLayers.test(layerName))
        continue;
    }
    const sourceLayer = vt.layers[layerName];
    const extent = sourceLayer.extent;
    const offsetX = (targetX - parentX * scale) * extent;
    const offsetY = (targetY - parentY * scale) * extent;

    const featureWrappers = [];
    for (let i = 0; i < sourceLayer.length; i++) {
      const feature = sourceLayer.feature(i);
      featuresIn++;
      let geometry = feature.loadGeometry(); // Array of rings (Point[])
      // Transform
      for (const ring of geometry) {
        for (const pt of ring) {
          pt.x = pt.x * scale - offsetX;
          pt.y = pt.y * scale - offsetY;
        }
      }
      // Clip
      geometry = clipGeometry(geometry, feature.type, -buffer, extent + buffer);
      if (!geometry || geometry.length === 0) continue;
      featureWrappers.push(
        new OverzoomedFeatureWrapper(
          feature.type,
          geometry,
          feature.properties,
          feature.id,
          extent,
        ),
      );
      featuresOut++;
    }
    if (featureWrappers.length > 0) {
      overzoomed.addLayer(
        new OverzoomedTileLayer(featureWrappers, layerName, extent),
      );
    }
  }
  const pbf = fromVectorTileJs(overzoomed);
  const data =
    pbf.byteOffset === 0 && pbf.byteLength === pbf.buffer.byteLength
      ? pbf
      : new Uint8Array(pbf);
  const t1 = performance.now ? performance.now() : Date.now();
  return { data, stats: { dz, featuresIn, featuresOut, ms: t1 - t0 } };
}

// --- Internal wrappers (adapted from overzoomed-geojson-vector-tile.ts) ---
class OverzoomedFeatureWrapper extends VectorTileFeature {
  constructor(type, geometry, properties, id, extent) {
    super(new Protobuf(), 0, extent, [], []);
    this.type = type; // 1=Point,2=LineString,3=Polygon
    this.properties = properties ? properties : {};
    this.extent = extent;
    this.myGeometry = geometry;
    this.id = id;
  }
  loadGeometry() {
    return this.myGeometry.map((ring) => ring.map((p) => new Point(p.x, p.y)));
  }
}

class OverzoomedTileLayer extends VectorTileLayer {
  constructor(features, name, extent) {
    super(new Protobuf());
    this._myFeatures = features;
    this.name = name;
    this.length = features.length;
    this.extent = extent;
    this.version = 2;
  }
  feature(i) {
    return this._myFeatures[i];
  }
}

class OverzoomedVectorTile {
  constructor() {
    this.layers = {};
  }
  addLayer(layer) {
    this.layers[layer.name] = layer;
  }
}

// --- Clipping helpers ---
function clipGeometry(geometry, type, min, max) {
  switch (type) {
    case 1:
      return clipPoints(geometry, min, max); // POINT
    case 2:
      return clipLinesWrapper(geometry, min, max, false); // LINESTRING
    case 3:
      return clipLinesWrapper(geometry, min, max, true); // POLYGON
    default:
      return [];
  }
}
function clipPoints(geometry, min, max) {
  const out = [];
  for (const ring of geometry) {
    for (const p of ring) {
      if (p.x >= min && p.x <= max && p.y >= min && p.y <= max) {
        out.push([p]);
      }
    }
  }
  return out;
}
function clipLinesWrapper(geometry, min, max, isPolygon) {
  const out = [];
  for (const line of geometry) {
    const clipped = clipAxis(line, min, max, 0, isPolygon);
    for (const seg of clipped) {
      const clippedY = clipAxis(seg, min, max, 1, isPolygon);
      for (const finalSeg of clippedY) out.push(finalSeg);
    }
  }
  return out;
}
function clipAxis(line, start, end, axis, isPolygon) {
  const intersect = axis === 0 ? intersectX : intersectY;
  let slice = [];
  const out = [];
  for (let i = 0; i < line.length - 1; i++) {
    const p1 = line[i];
    const p2 = line[i + 1];
    const a = axis === 0 ? p1.x : p1.y;
    const b = axis === 0 ? p2.x : p2.y;
    let exited = false;
    if (a < start && b > start) slice.push(intersect(p1, p2, start));
    else if (a > end && b < end) slice.push(intersect(p1, p2, end));
    else if (a >= start && a <= end) slice.push(p1);
    if (b < start && a >= start) {
      slice.push(intersect(p1, p2, start));
      exited = true;
    }
    if (b > end && a <= end) {
      slice.push(intersect(p1, p2, end));
      exited = true;
    }
    if (!isPolygon && exited) {
      out.push(slice);
      slice = [];
    }
  }
  const last = line[line.length - 1];
  const lastVal = axis === 0 ? last.x : last.y;
  if (lastVal >= start && lastVal <= end) slice.push(last);
  if (
    isPolygon &&
    slice.length > 0 &&
    !slice[0].equals(slice[slice.length - 1])
  ) {
    slice.push(new Point(slice[0].x, slice[0].y));
  }
  if (slice.length > 0) out.push(slice);
  return out;
}
function intersectX(p1, p2, x) {
  const t = (x - p1.x) / (p2.x - p1.x);
  return new Point(x, p1.y + (p2.y - p1.y) * t);
}
function intersectY(p1, p2, y) {
  const t = (y - p1.y) / (p2.y - p1.y);
  return new Point(p1.x + (p2.x - p1.x) * t, y);
}

function toUint8(data) {
  if (data instanceof Uint8Array) return data;
  return new Uint8Array(data);
}

export default subdivideVectorTile;

import {type VectorTile, VectorTileFeature, VectorTileLayer} from '@mapbox/vector-tile';
import Protobuf from 'pbf';
import Point from '@mapbox/point-geometry';
import {fromVectorTileJs} from '@maplibre/vt-pbf';
import {type LoadVectorTileResult} from './vector_tile_worker_source';
import type {CanonicalTileID} from './tile_id';

class OverzoomedFeatureWrapper extends VectorTileFeature {
    myGeometry: Point[][];

    constructor(type: 0 | 1 | 2 | 3, geometry: Point[][], properties: any, id: number, extent: number) {
        super(new Protobuf(), 0, extent, [], []);
        this.type = type;
        this.properties = properties ? properties : {};
        this.extent = extent;
        this.myGeometry = geometry;
        this.id = id;
    }

    loadGeometry() {
        // Clone the geometry and ensure all points are Point instances
        return this.myGeometry.map(ring => 
            ring.map(point => new Point(point.x, point.y))
        );
    }
}

class OverzoomedTileLayer extends VectorTileLayer {
    private _myFeatures: OverzoomedFeatureWrapper[];
    name: string;
    extent: number;
    version: number = 2;
    length: number;

    constructor(features: OverzoomedFeatureWrapper[], layerName: string, extent: number) {
        super(new Protobuf());
        this._myFeatures = features;
        this.name = layerName;
        this.length = features.length;
        this.extent = extent;
    }

    feature(i: number): VectorTileFeature {
        return this._myFeatures[i];
    }
}

export class OverzoomedVectorTile implements VectorTile {
    layers: Record<string, VectorTileLayer> = {};

    addLayer(layer: OverzoomedTileLayer) {
        this.layers[layer.name] = layer;
    }
}

/**
 * Encodes the virtual tile into binary vector tile form.
 * This is a convenience that allows `FeatureIndex` to operate the same way across `VectorTileSource` and `GeoJSONSource` data.
 * @param virtualVectorTile - a VectorTile created from GeoJSON data using geojson-vt
 * @returns
 */
export function toVirtualVectorTile(virtualVectorTile: VectorTile): LoadVectorTileResult {

    let pbf: Uint8Array = fromVectorTileJs(virtualVectorTile);
    if (pbf.byteOffset !== 0 || pbf.byteLength !== pbf.buffer.byteLength) {
        pbf = new Uint8Array(pbf);  // Compatibility with node Buffer (https://github.com/mapbox/pbf/issues/35)
    }

    return {
        vectorTile: virtualVectorTile,
        rawData: pbf.buffer
    };
}

export function sliceTileLayer(sourceLayer: VectorTileLayer, maxZoomTileID: CanonicalTileID, targetTileID: CanonicalTileID): OverzoomedTileLayer {
    const {extent} = sourceLayer;
    if (extent !== 4096) {
        console.log(`Warning: overzooming only tested with extent=4096, got extent=${extent}`);
    }
    const dz = targetTileID.z - maxZoomTileID.z;
    const scale = Math.pow(2, dz);
    
    // Calculate the target tile's position within the source tile in target coordinate space
    // This ensures all tiles share the same coordinate system
    const offsetX = (targetTileID.x - maxZoomTileID.x * scale) * extent;
    const offsetY = (targetTileID.y - maxZoomTileID.y * scale) * extent;

    const featureWrappers: OverzoomedFeatureWrapper[] = [];
    for (let index = 0; index < sourceLayer.length; index++) {
        const feature: VectorTileFeature = sourceLayer.feature(index);
        let geometry = feature.loadGeometry();
        
        // Transform all coordinates to target tile space
        for (const ring of geometry) {
            for (const point of ring) {
                point.x = point.x * scale - offsetX;
                point.y = point.y * scale - offsetY;
            }
        }
        
        // Clip in target tile space with buffer
        const buffer = 128;
        geometry = clip(geometry, feature.type, -buffer, extent + buffer, AxisType.X);
        geometry = clip(geometry, feature.type, -buffer, extent + buffer, AxisType.Y);
        
        if (geometry.length === 0) {
            continue;
        }
        
        featureWrappers.push(new OverzoomedFeatureWrapper(
            feature.type,
            geometry,
            feature.properties,
            feature.id,
            extent
        ));
    }
    return new OverzoomedTileLayer(featureWrappers, sourceLayer.name, extent);
}

const enum AxisType {
    X = 0,
    Y = 1
}

/* clip features between two vertical or horizontal axis-parallel lines:
 *     |        |
 *  ___|___     |     /
 * /   |   \____|____/
 *     |        |
 *
 * k1 and k2 are the line coordinates
 * axis: 0 for x, 1 for y
 * minAll and maxAll: minimum and maximum coordinate value for all features
 */
function clip(geometry: Point[][], type: number, start: number, end: number, axis: AxisType): Point[][] {
    //const min = axis === AxisType.X ? geometry.map(ring => ring.reduce((min, p) => Math.min(min, p.x), Infinity)).reduce((a, b) => Math.min(a, b), Infinity) : geometry.map(ring => ring.reduce((min, p) => Math.min(min, p.y), Infinity)).reduce((a, b) => Math.min(a, b), Infinity);
    //const max = axis === AxisType.Y ? geometry.map(ring => ring.reduce((max, p) => Math.max(max, p.y), -Infinity)).reduce((a, b) => Math.max(a, b), -Infinity) : geometry.map(ring => ring.reduce((max, p) => Math.max(max, p.x), -Infinity)).reduce((a, b) => Math.max(a, b), -Infinity);

    //if (max < start || min >= end) { // trivial reject
    //    return [];
    //}
    switch (type) {
        case 1: // POINT
            return clipPoints(geometry, start, end, axis);
        case 2: // LINESTRING
            return clipLines(geometry, start, end, axis, false);
        case 3: // POLYGON
            return clipLines(geometry, start, end, axis, true);
    }

    return null;
}

function clipPoints(geometry: Point[][], start: number, end: number, axis: AxisType): Point[][] {
    const newGeometry: Point[][] = [];
    for (const ring of geometry) {
        for (const point of ring) {
            const a = axis === AxisType.X ? point.x : point.y;
            if (a >= start && a <= end) {
                newGeometry.push([point]);
            }
        }
    }
    return newGeometry;
}

function clipLine(line: Point[], start: number, end: number, axis: AxisType, isPolygon: boolean): Point[][] {
    const intersect = axis === AxisType.X ? intersectX : intersectY;

    let slice: Point[] = [];
    const newLine: Point[][] = [];
    for (let i = 0; i < line.length - 1; i++) {
        const p1 = line[i];
        const p2 = line[i + 1];
        const a = axis === AxisType.X ? p1.x : p1.y;
        const b = axis === AxisType.X ? p2.x : p2.y;
        let exited = false;

        if (a < start) {
            // ---|-->  | (line enters the clip region from the left)
            if (b > start) {
                slice.push(intersect(p1, p2, start));
            }
        } else if (a > end) {
            // |  <--|--- (line enters the clip region from the right)
            if (b < end) {
                slice.push(intersect(p1, p2, end));
            }
        } else {
            slice.push(p1);
        }
        if (b < start && a >= start) {
            // <--|---  | or <--|-----|--- (line exits the clip region on the left)
            slice.push(intersect(p1, p2, start));
            exited = true;
        }
        if (b > end && a <= end) {
            // |  ---|--> or ---|-----|--> (line exits the clip region on the right)
            slice.push(intersect(p1, p2, end));
            exited = true;
        }

        if (!isPolygon && exited) {
            newLine.push(slice);
            slice = [];
        }
    }

    // add the last point
    const last = line.length - 1;
    const a = axis === AxisType.X ? line[last].x : line[last].y;
    if (a >= start && a <= end) {
        slice.push(line[last]);
    }

    // close the polygon if its endpoints are not the same after clipping
    if (isPolygon && slice.length > 0 && !slice[0].equals(slice[slice.length - 1])) {
        slice.push(new Point(slice[0].x, slice[0].y));
    }
    if (slice.length > 0) {
        newLine.push(slice);
    }
    return newLine;
}

function clipLines(geometry: Point[][], start: number, end: number, axis: AxisType, isPolygon: boolean): Point[][] {
    const newGeometry: Point[][] = [];
    for (const line of geometry) {
        const clippedLines = clipLine(line, start, end, axis, isPolygon);
        if (clippedLines.length > 0) {
            newGeometry.push(...clippedLines);
        }
    }
    return newGeometry;
}

function intersectX(p1: Point, p2: Point, x: number): Point {
    const t = (x - p1.x) / (p2.x - p1.x);
    return new Point(x, p1.y + (p2.y - p1.y) * t);
}

function intersectY(p1: Point, p2: Point, y: number): Point {
    const t = (y - p1.y) / (p2.y - p1.y);
    return new Point(p1.x + (p2.x - p1.x) * t, y);
}
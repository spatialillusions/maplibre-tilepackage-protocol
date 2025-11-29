# Vector Tile Subdivision (Tilecutter) Implementation Plan

## 1. Goal

Provide a pure JavaScript (ES module) function `subdivideVectorTile(parentTilePbf, parentZ, parentX, parentY, targetZ, targetX, targetY, options)` that returns a binary vector tile (PBF) representing the target (higher zoom) tile derived by slicing/scaling the parent tile. It should:

- Support arbitrary zoom increases (targetZ > parentZ).
- Work when target tile lies completely inside the parent tile (guaranteed for WebMercator Z/X/Y addressing).
- Use minimal dependencies (ideally only `pbf` + a lightweight vector-tile reader/encoder or custom minimal parser/encoder).
- Be optionally configurable (buffer size, layer allowlist, caching, geometry simplification toggle).
- Integrate into `Protocol.getData` as a fallback when a tile is missing (`this.errorOnMissingTile`).

## 2. Existing Code Overview (Current MapLibre Approach)

Relevant source files analyzed:

- `overzoomed-geojson-vector-tile.ts`: Implements overzooming by:
  - Wrapping features (`OverzoomedFeatureWrapper`) with custom geometry arrays (Point[][]).
  - Scaling geometry by `scale = 2^(dz)` and translating via offset into target tile coordinates.
  - Clipping geometries on X and Y axes with a buffer (128) using custom clipping code (`clip`, `clipLine`, etc.).
  - Rebuilding layers (`OverzoomedTileLayer`) and assembling a synthetic `VectorTile` instance.
  - Encoding back to PBF using `fromVectorTileJs` (dependency: `@maplibre/vt-pbf`).
- `vector_tile_worker_source.ts`: Uses `sliceTileLayer` to produce overzoomed layers for requested deeper zoom tiles, caching results.

### Dependencies Observed

- `@mapbox/vector-tile` for decoding input tiles.
- `pbf` for low-level protobuf reading.
- `@mapbox/point-geometry` for Point abstraction.
- `@maplibre/vt-pbf` for encoding synthetic tiles back into PBF.
- Internal MapLibre worker/layer/style abstractions (not needed for our focused subdivision function).

## 3. Minimum Viable Function Design

We only need to:

1. Decode layers & features from parent tile PBF.
2. For each target tile (single target requested):
   - Compute scale and offset.
   - Transform all feature coordinates.
   - Clip geometries to extent (with buffer).
3. Re-encode resulting layers to PBF.

### Extent and Coordinate Space

- Vector tiles typically use extent 4096 (but may vary per layer). We must preserve the original layer extents.
- Transformation formula (generalized):
  - `dz = targetZ - parentZ`
  - `scale = 2^dz`
  - `offsetX = (targetX - parentX * scale) * extent`
  - `offsetY = (targetY - parentY * scale) * extent`
  - For each point: `x' = x * scale - offsetX`, `y' = y * scale - offsetY`.

### Buffer & Clipping

- Maintain buffer (default 128) to allow symbol/icon placement consistency.
- Clip axis-aligned with inclusive range `[-buffer, extent + buffer]` for both X and Y.
- Discard features whose geometry becomes empty after clipping.

## 4. Arbitrary Zoom Subdivision Considerations

No need for iterative slicing (e.g., parent→child→grandchild). Direct scaling by `2^dz` preserves geometric correctness because coordinates are in tile-local extent space with uniform scaling across zoom levels.
Edge cases:

- Very large `dz` (e.g., >6) could inflate coordinate magnitudes causing performance issues; warn or cap.
- High zoom may produce large feature counts post-clipping for points/lines crossing tile boundaries; mitigate through optional geometry simplification (future enhancement).

## 5. Proposed Dependencies Strategy

Two implementation layers:

- Phase 1 (Pragmatic): Use `@mapbox/vector-tile` + `pbf` for decode; use `@maplibre/vt-pbf` for encode.
- Phase 2 (Optimization): Replace decode/encode with minimal custom routines:
  - Only parse layers, feature types, IDs, properties, and geometries (command stream of MVT spec: MoveTo, LineTo, ClosePath).
  - Re-emit using handcrafted encoder for our subset (POINT, LINESTRING, POLYGON).
  - Property map preserved verbatim.
    Tradeoff: Phase 1 faster to deliver; Phase 2 reduces bundle size and external dependencies.

## 6. Data Flow of New Function

1. Input parent tile ArrayBuffer or Uint8Array.
2. Decode into internal representation:
   - Layers: `{ name, extent, features: [{ type, id?, properties, geometry: Point[][] }] }`.
3. Transform & clip features for target tile.
4. Build new layers (only those with surviving features).
5. Encode to MVT PBF.
6. Return `{ data: Uint8Array, stats?: { featuresIn, featuresOut, dz, ms } }`.

## 7. API Sketch

```js
async function subdivideVectorTile(
  parentTilePbf,
  parentZ,
  parentX,
  parentY,
  targetZ,
  targetX,
  targetY,
  options = {},
) {
  const {
    buffer = 128,
    includeLayers, // array or regex; if omitted include all
    cache, // optional Map cache instance
    maxDzWarn = 8,
  } = options;
  // 1. Decode
  // 2. Transform & clip
  // 3. Encode
  // 4. Cache & return
}
```

## 8. Clipping Algorithm Reuse

Retain logic from `clipPoints`, `clipLine`, `clipLines`, axis iteration, with slight refactor:

- Accept plain `{x, y}` objects (remove dependency on Point class) for minimalism.
- Provide fast-path trivial reject (optional) if ring bbox outside.
- Preserve polygon closure after clipping.

## 9. Integration Into `Protocol.getData`

Fallback Workflow when `errorOnMissingTile` is true and tile missing:

1. Detect missing tile (`resp` null for `getZxy`).
2. If tile type is vector (`pbf`):
   - Descend: for `z' = z-1 ... minZoom`:
     - Attempt `getZxy(z', floor(x / 2^(z - z')), floor(y / 2^(z - z')))`. First found becomes parent.
   - If parent found:
     - Call `subdivideVectorTile(parentData, z', parentX, parentY, z, x, y)`.
     - Return as synthetic tile.
   - Else throw original `TileError`.
3. Mark response metadata (e.g. `synthetic: true`, `parentZ: z'`).
4. Optional in-memory cache keyed by `${z}/${x}/${y}` to reuse synthetic tiles.

## 10. Caching Strategy

- Avoid recomputing frequently requested synthetic tiles.
- Simple LRU (size configurable, default 512 entries) keyed by `parentZ,parentX,parentY|targetZ,targetX,targetY`.
- Invalidate wholesale if underlying archive changes (version stamp optional).

## 11. Performance & Memory Considerations

- Single-pass scaling + clipping per feature.
- Avoid cloning large geometry arrays unnecessarily; transform in-place then create new arrays only for surviving rings.
- Track counts to allow metrics logging.
- For huge polygons: potential optimization later (segment-level bbox pre-filter before clip).

## 12. Error Handling & Validation

- Validate `targetZ > parentZ` else return original tile or throw.
- Ensure target tile lies within parent: check `floor(targetX / 2^dz) === parentX` and same for Y.
- If extent mismatch across layers, process each layer independently with its own extent (offset uses its extent).
- Graceful return (empty tile) if no features survive; still produce valid empty layers if needed or omit layers entirely.

## 13. Testing Plan (Later Implementation Phase)

Unit tests (synthetic fixtures):

- Point features at quadrant centers scaling from z to z+1.
- Lines crossing tile boundaries (ensure clipping output correctness).
- Polygons partially inside target tile (closure preserved, holes behavior).
- Multi-level jump (dz = 3) verifying scale and offset math.
- Missing tile fallback integration path in `Protocol.getData` (mock `TilePackage`).

## 14. Incremental Delivery Plan

Phase A (Rapid Prototype):

- Implement using existing decode/encode deps.
- Integrate fallback path gated behind new option `autoSubdivideOnMissingTile`.
- Provide metrics console logging.

Phase B (Refinement):

- Add cache + layer filtering.
- Expose stats to caller.

Phase C (Dependency Reduction):

- Replace decode/encode with minimalist MVT subset implementation.
- Benchmark & document size savings.

Phase D (Optimizations):

- Geometry bbox pre-filter before clipping.
- Optional simplification for high dz.

## 15. Risks & Mitigations

- Large dz performance hit: add warning & optional cap.
- Encoding correctness for custom minimal encoder: cross-validate against `@maplibre/vt-pbf` outputs for test fixtures.
- Property map & feature IDs: ensure preserved; if absent assign stable sequential IDs.

## 16. Open Questions / Clarifications Needed

- Should synthetic tiles include attribution or other metadata flags?
- Accept returning a tile with fewer layers (omit empty)?
- Need support for feature filtering (e.g. max feature count)?
- Required compatibility with existing MapLibre feature querying APIs?

## 17. Next Steps

1. Confirm open questions.
2. Phase A function + Protocol integration behind option flag (completed: `subdivide.js`, option `subdivideMissingTile`).
3. Add unit tests for scale/clip correctness (pending).
4. Benchmark typical tile subdivision latency (pending).
5. Implement synthetic tile caching (pending).
6. Consider layer filtering and stats exposure in API (partial: includeLayers supported, stats returned).

---

Prepared implementation plan for vector tile subdivision. Ready to proceed to coding when approved.

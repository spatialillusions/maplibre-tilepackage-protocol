# Vector Tile Subdivision (Tilecutter) – Current Status & Future Work

## Implemented (Current State)

The following pieces are complete and in production code:

- `subdivideVectorTile(...)` Phase A implementation using existing decode (`@mapbox/vector-tile`) and encode (`@maplibre/vt-pbf`) libraries.
- Scale/offset math for arbitrary `dz = targetZ - parentZ` with containment validation.
- Geometry transformation and clipping (buffer default 128) for points, lines, polygons.
- Layer filtering via `includeLayers` (array or RegExp).
- Stats returned (`featuresIn`, `featuresOut`, `dz`, `ms`).
- Automatic parent selection via `coverageMap` (value=1) and subdivision fallback in `TilePackage.getZxyAttempt`.
- In‑memory cache of synthesized tiles (`SharedPromiseCache.subdivided`) with simple half-prune heuristic.
- Default `coverageCheck` enabled and propagated to both `FetchSource` and `FileSource`.
- Debug instrumentation removed (warnings only for failures & high dz).

## Deferred / Not Yet Implemented

The items below represent remaining or future enhancements. They supersede earlier phased plan language.

1. Unit Tests

- Synthetic fixtures for point, line, polygon, multi-dz (e.g. dz=1,2,3).
- Verify clipping correctness (edge touch, full outside, polygon ring closure).
- Regression tests for parent containment validation and empty output tiles.

2. Benchmarks

- Measure average subdivision latency for typical dz values (1–5) and publish a README table.
- Track memory footprint of cached tiles.

3. Cache Improvements

- Replace simple prune with true LRU (track lastUsed for subdivided tiles).
- Optional byte-size cap (e.g. max 64 MB) + eviction on overflow.
- Expose cache stats (hits, misses, evictions) via an API or debug callback.

4. Max dz Guard

- Configurable hard cap `maxDz` (skip synthesis beyond threshold; return empty tile or parent tile).
- Distinct from warning-only `maxDzWarn` currently in function.

5. Dependency Reduction (Minimal MVT Codec)

- Custom lightweight decoder: parse layers, feature type, properties, geometry command stream.
- Custom encoder for POINT, LINESTRING, POLYGON; property passthrough.
- Goal: shrink bundle size and reduce external dependencies.

6. Geometry Simplification (High dz)

- Optional per-layer simplification tolerance parameter (Douglas-Peucker or grid-based).
- Preserve topology for polygons; avoid slivers.

7. Synthetic Metadata & Flags

- Option to embed a small custom layer or feature attribute indicating `parentZ`/`dz` for diagnostics.
- API return could include `synthetic: true` marker (currently implicit via stats presence).

8. Parent Search Strategy Options

- Fallback mode that uses nearest ancestor even if value != 1 (for packages lacking proper coverage semantics).
- Configurable allowlist of coverage values (e.g. treat `1` or `"blob"` as valid parents).

9. Observability & Metrics

- Pluggable callback `onSubdivide(stats, context)`.
- Accumulate moving averages; expose via `TilePackage.getSubdivisionMetrics()`.

10. Memory & Concurrency Controls

- Limit parallel subdivision operations (queue) to avoid main-thread spikes.
- Optional Web Worker offload (future) for heavy dz.

11. Error Handling Extensions

- Graceful fallback: on subdivision failure, return blank tile vs warning.
- Configurable retry for transient decode issues.

12. Documentation Enhancements

- README section: “Overzoom Mechanics & Tradeoffs”.
- Guidance on choosing `maxDz` based on feature density.

13. Security / Validation

- Defensive checks on malformed PBF (guard against extremely large extents or geometry counts).

14. Feature Count / Size Limits

- Option `maxFeaturesOut` to truncate layers—report truncation in stats.

15. Layer-Specific Options

- Per-layer buffer overrides; per-layer simplification tolerance.

## Updated API Roadmap (Proposed Additions)

```ts
interface SubdivideOptions {
  buffer?: number; // existing
  includeLayers?: string[] | RegExp; // existing
  maxDzWarn?: number; // existing
  maxDz?: number; // NEW hard cap
  simplifyTolerance?: number; // NEW (all layers)
  onStats?: (stats, ctx) => void; // NEW callback
  maxFeaturesOut?: number; // NEW truncation limit
  parentStrategy?: "coverageValue" | "nearestAncestor"; // NEW
}
```

## Prioritization Suggestion (Next Steps)

1. Implement unit tests (foundation for safe refactors).
2. Add LRU cache + metrics collection.
3. Introduce `maxDz` guard & benchmark to inform default.
4. Optional: minimal codec prototype behind feature flag for size comparisons.
5. Geometry simplification + truncation limits for high-density datasets.
6. Parent strategy option for archives with unconventional coverage values.

## Risks & Mitigations (Current)

- High dz latency: mitigate with `maxDz` and caching.
- Memory growth from cache: LRU + size cap.
- Bundle size: address via minimal codec.
- Incorrect clipping for edge cases: comprehensive unit tests.

## Open Questions

- Should synthetic tiles preserve empty layers (current: omit empty)?
- Provide global toggle to disable stats collection for minimal overhead?
- Standardize metadata flag naming (`vtpk_synthetic`?) if added.

---

This document now reflects current implementation and focuses on forward-looking tasks. Completed exploratory/phase details were removed for clarity.

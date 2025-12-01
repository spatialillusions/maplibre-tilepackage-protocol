# maplibre-tilepackage-protocol

Custom MapLibre GL JS protocol for reading Esri `TPKX` (raster) and `VTPK` (vector) TilePackage archives.

Works with:

- Local files selected via an `<input type="file">` (no server required)
- Relative or absolute HTTP(S) URLs to remote TilePackages

The protocol streams tiles, glyphs and sprites directly from the archive. For VTPK it synthesizes a ready-to-use MapLibre style (rewriting sources + sprite + glyphs).

## Install

```bash
npm add maplibre-tilepackage-protocol
```

## Import (ESM)

```js
import {
  Protocol,
  FileSource,
  TilePackage,
} from "maplibre-tilepackage-protocol";
```

## Quick Start (Remote Raster TPKX)

```js
const protocol = new Protocol();
maplibregl.addProtocol("tilepackage", protocol.package);

const style = {
  version: 8,
  sources: {
    raster: {
      type: "raster",
      url: "tilepackage://https://example.com/data/example.tpkx",
    },
  },
  layers: [{ id: "raster", type: "raster", source: "raster" }],
};

new maplibregl.Map({ container: "map", style });
```

Equivalent explicit tiles form:

```js
tiles: ["tilepackage://https://example.com/data/example.tpkx/{z}/{x}/{y}"];
```

## Local File VTPK

```js
const protocol = new Protocol({ debug: true });
maplibregl.addProtocol("tilepackage", protocol.package);

async function initFromFile(file) {
  const pkg = new TilePackage(new FileSource(file)); // coverageCheck defaults ON
  protocol.add(pkg); // register so sprite/glyph URLs resolve
  const style = await pkg.getStyle();
  new maplibregl.Map({ container: "map", style });
}
```

On HTTP(S) you can instead point a style source to a relative URL:

```js
url: "tilepackage://./data/archive.vtpk";
```

## Vector Style Rewriting

`TilePackage#getStyle()` for VTPK replaces any `url` with a `tiles` array (`tilepackage://<key>/{z}/{x}/{y}`), and sets `sprite` & `glyphs` to protocol endpoints. This avoids extra TileJSON requests that fail under `file://`.

## Indexed Pyramids & Overzoom Fallback

Some VTPK archives have variable depth (gaps). Missing higher-zoom tiles are automatically synthesized from a parent using an internal subdivision algorithm when a coverage map (`tilemap/root.json`) is present.

Behavior:

- Parent search ascends until a node with value `1` in the coverage map.
- The parent vector tile is decoded, features clipped/scaled, and re-encoded to PBF.
- Generated tiles are cached (`SharedPromiseCache.subdivided`) to avoid repeat work.

Disable subdivision by constructing the package with `coverageCheck:false`:

```js
const pkg = new TilePackage(new FileSource(file), { coverageCheck: false });
```

If you prefer MapLibre's default empty tile behavior (no lower-zoom retention) you can set protocol option `errorOnMissingTile:true` to raise errors for missing PBF tiles.

### Caching

Overzoomed tiles are stored in-memory for the session. A simple size-based prune removes half of entries when exceeding `maxCacheEntries * 2`. (Future: LRU + byte-size thresholds.) Subdivision will be skipped entirely if the zoom delta exceeds the hard cap `maxDz` (default `8`).

### Performance Notes

- Large zoom jumps (high `dz`) cost more CPU; consider constraining user zoom range.
- Subdivision adds latency only on first request; subsequent hits are served from cache.
- Disable with `coverageCheck:false` for pure flat packages when you do not want synthesis.
- Tune with `maxDz` (e.g. set `maxDz:4`) to limit deep subdivision while allowing shallow overzoom.

## API Summary

- `new TilePackage(source, { coverageCheck, maxDz })` – `source` is URL string or `FileSource`. `coverageCheck` defaults to `true` enabling coverage map + overzoom; `maxDz` (default `8`) hard‑caps subdivision depth.
- `TilePackage#getHeader()` – name, zooms, bounds, tile type.
- `TilePackage#getStyle()` – raster style (TPKX) or rewritten vector style (VTPK).
- `TilePackage#getZxy(z,x,y)` – raw tile bytes (PBF or raster image ArrayBuffer).
- `Protocol.add(pkg)` – register local file-backed packages for glyph/sprite resolution.
- `Protocol` options: `metadata`, `errorOnMissingTile`, `debug`.

## Debug Logging

Enable `debug:true` in `Protocol` for tile fetch + instance events. Coverage ascent & subdivision messages use `[tilepackage coverage]` and `[tilepackage subdivide]` prefixes.

## Demo

The `example/` directory demonstrates local file selection, remote/relative URL input, auto-load of a demo archive, and overzoom fallback.

## TPKX Notes

TPKX contains a full raster pyramid; no style synthesis beyond setting a raster source.

## VTPK Notes

Flat and indexed VTPK archives are supported. Indexed packages rely on the overzoom fallback described above for visual continuity.

## Sample Data

Austria indexed VTPK sample:
https://cdn.basemap.at/offline/bmapv_vtpk_3857.vtpk

There is also a small example file in the example folder, and there is an online version of the example available here:
https://spatialillusions.com/maplibre-tilepackage-protocol/

## Acknowledgement

Inspired by concepts from PMTiles protocol (Protomaps LLC).

## Support

If this project helps you, consider supporting: https://buymeacoffee.com/spatialillusion

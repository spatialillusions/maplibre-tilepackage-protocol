export * from "./maplibre-gl-js-protocol.js";
export * from "./source.js";
import { FetchSource } from "./source.js";
import subdivideVectorTile from "./tilecutter/subdivide.js";
import defaultDecompress from "./default-decompress.js";
import getJsonFromFile from "./get-json-from-file.js";
import SharedPromiseCache from "./shared-promise-cache.js";

function calculateFilename(z, x, y, header) {
  const zoom = z.toString().padStart(2, "0");
  const baseRow = Math.floor(y / 128) * 128;
  const baseCol = Math.floor(x / 128) * 128;
  const rowHex = baseRow.toString(16).padStart(4, "0");
  const colHex = baseCol.toString(16).padStart(4, "0");
  const basePath = header.type === "tpkx" ? "tile" : "p12/tile";
  return `${basePath}/L${zoom}/R${rowHex}C${colHex}.bundle`;
}

function getTileInfoFromTileIndex(tileIndex, z, x, y) {
  const row = y % 128;
  const col = x % 128;
  return tileIndex[row][col];
}

class EtagMismatch extends Error {
  constructor(message) {
    super(message);
    this.name = "EtagMismatch";
  }
}

export class TilePackage {
  constructor(source, options) {
    // Default coverageCheck enabled; disable with coverageCheck:false
    this.coverageCheck = 1;
    if (options && options.coverageCheck === false) this.coverageCheck = 0;
    // Max dz guard (skip subdivision beyond this): default 8
    this.maxDz =
      options && typeof options.maxDz === "number" ? options.maxDz : 8;
    if (typeof source === "string") {
      const opts = this.coverageCheck
        ? { coverageCheck: this.coverageCheck }
        : undefined;
      this.source = new FetchSource(source, opts);
    } else {
      this.source = source;
      // Propagate default coverageCheck to existing Source instances if undefined
      if (this.source && this.source.coverageCheck === undefined) {
        this.source.coverageCheck = this.coverageCheck;
      }
    }
    this.decompress =
      options && options.decompress ? options.decompress : defaultDecompress;
    this.cache =
      options && options.cache ? options.cache : new SharedPromiseCache();
  }

  async getHeader() {
    return await this.cache.getHeader(this.source);
  }

  async getZxyAttempt(z, x, y, signal) {
    const header = await this.cache.getHeader(this.source);
    if (z < header.minZoom || z > header.maxZoom) return undefined;
    const file = calculateFilename(z, x, y, header);
    let tileInfo = null;
    if (header.files[file]) {
      const tileIndex = await this.cache.getTileIndex(
        this.source,
        file,
        header,
        signal,
      );
      tileInfo = getTileInfoFromTileIndex(tileIndex, z, x, y);
      if (tileInfo && tileInfo.tileSize > 0) {
        const tileOffset =
          header.files[file].absoluteOffset + tileInfo.tileOffset;
        const resp = await this.source.getBytes(
          tileOffset,
          tileInfo.tileSize,
          signal,
          header.etag,
        );
        const data = await this.decompress(resp.data, header.tileCompression);
        return { data, cacheControl: resp.cacheControl, expires: resp.expires };
      }
    }
    if (header.packageType === "vtpk" && header.coverageMap) {
      // Ascend to find parent with value 1
      let pz = z,
        px = x,
        py = y,
        foundParent = null;
      while (pz > header.minZoom) {
        pz -= 1;
        px = Math.floor(px / 2);
        py = Math.floor(py / 2);
        const level = header.coverageMap[pz];
        const val = level && level[px] ? level[px][py] : undefined;
        if (val === 1) {
          foundParent = { pz, px, py };
          break;
        }
      }
      if (foundParent) {
        const parent = await this.getZxyAttempt(
          foundParent.pz,
          foundParent.px,
          foundParent.py,
          signal,
        );
        if (parent && parent.data) {
          const cached = this.cache.getSubdivided(this.source, z, x, y);
          if (cached) {
            return {
              data: cached,
              cacheControl: parent.cacheControl,
              expires: parent.expires,
            };
          }
          const dz = z - foundParent.pz;
          if (dz > this.maxDz) {
            return undefined; // exceed hard cap
          }
          try {
            const { data: overzoomed } = subdivideVectorTile(
              parent.data,
              foundParent.pz,
              foundParent.px,
              foundParent.py,
              z,
              x,
              y,
              { buffer: 128, maxDzWarn: this.maxDz - 1 },
            );
            this.cache.setSubdivided(this.source, z, x, y, overzoomed);
            return {
              data: overzoomed,
              cacheControl: parent.cacheControl,
              expires: parent.expires,
            };
          } catch (e) {
            console.warn(
              `[tilepackage subdivide] failed for z=${z} x=${x} y=${y}:`,
              e,
            );
          }
        } else {
          console.warn(
            `[tilepackage subdivide] parent tile missing at z=${foundParent.pz} x=${foundParent.px} y=${foundParent.py}`,
          );
        }
      }
    }
    return undefined;
  }

  async getZxy(z, x, y, signal) {
    try {
      return await this.getZxyAttempt(z, x, y, signal);
    } catch (e) {
      if (e instanceof EtagMismatch) {
        this.cache.invalidate(this.source);
        return await this.getZxyAttempt(z, x, y, signal);
      }
      throw e;
    }
  }

  async getMetadataAttempt() {
    const header = await this.cache.getHeader(this.source);
    let metadata = {};
    if (header.packageType === "vtpk") {
      const resp = await this.source.getBytes(
        header.jsonMetadataOffset,
        header.jsonMetadataLength,
        undefined,
        header.etag,
      );
      const decoder = new TextDecoder("utf-8");
      metadata = JSON.parse(decoder.decode(resp.data));
    }
    metadata.name = header.name;
    return metadata;
  }

  async getMetadata() {
    try {
      return await this.getMetadataAttempt();
    } catch (e) {
      if (e instanceof EtagMismatch) {
        this.cache.invalidate(this.source);
        return await this.getMetadataAttempt();
      }
      throw e;
    }
  }

  async getResourceAttempt(file, signal) {
    const header = await this.cache.getHeader(this.source);
    if (!header.files[file]) return undefined;
    const resource = await this.cache.getResource(
      this.source,
      file,
      header,
      signal,
    );
    return {
      data: resource.data,
      cacheControl: resource.cacheControl,
      expires: resource.expires,
    };
  }

  async getResource(file, signal) {
    try {
      return await this.getResourceAttempt(file, signal);
    } catch (e) {
      if (e instanceof EtagMismatch) {
        this.cache.invalidate(this.source);
        return await this.getResourceAttempt(file, signal);
      }
      throw e;
    }
  }

  async getStyleAttempt() {
    const header = await this.cache.getHeader(this.source);
    const sourceKey = this.source.getKey();
    if (header.packageType === "vtpk") {
      const metadata = await getJsonFromFile(
        "p12/root.json",
        header.files,
        this.source,
      );
      const style = await getJsonFromFile(
        "p12/resources/styles/root.json",
        header.files,
        this.source,
      );
      if (style.sources && style.sources.esri) {
        delete style.sources.esri.url;
        style.sources.esri.tiles = [`tilepackage://${sourceKey}/{z}/{x}/{y}`];
        style.sources.esri.type = style.sources.esri.type || "vector";
        style.sources.esri.minzoom = header.minZoom || 0;
        style.sources.esri.maxzoom = header.maxZoom || 22;
      }
      for (const k in style.sources) {
        const src = style.sources[k];
        if (
          src &&
          typeof src.url === "string" &&
          src.url.startsWith("tilepackage://")
        ) {
          delete src.url;
          if (!src.tiles)
            src.tiles = [`tilepackage://${sourceKey}/{z}/{x}/{y}`];
        }
      }
      if (metadata.copyrightText)
        style.sources.esri.attribution = metadata.copyrightText;
      style.glyphs = `tilepackage://${sourceKey}/{fontstack}/{range}`;
      style.sprite = `tilepackage://${sourceKey}/sprite`;
      if (this.debug)
        console.debug(
          "[tilepackage style] rewritten esri source",
          style.sources.esri,
        );
      return style;
    }
    return {
      version: 8,
      sources: {
        esri: {
          type: "raster",
          tileSize: header.tileSize || 256,
          tiles: [`tilepackage://${sourceKey}/{z}/{x}/{y}`],
          maxzoom: header.maxZoom || 22,
          minzoom: header.minZoom || 0,
        },
      },
      layers: [{ id: "tilepackageraster", type: "raster", source: "esri" }],
    };
  }

  async getStyle() {
    try {
      return await this.getStyleAttempt();
    } catch (e) {
      if (e instanceof EtagMismatch) {
        this.cache.invalidate(this.source);
        return await this.getStyleAttempt();
      }
      throw e;
    }
  }

  async getTileJson(baseTilesUrl) {
    const header = await this.getHeader();
    const metadata = await this.getMetadata();
    const ext = header.tileType;
    const tileJson = {
      tilejson: "3.0.0",
      scheme: "xyz",
      tiles: [`${baseTilesUrl}/{z}/{x}/{y}${ext}`],
      name: metadata.name,
      version: header.version,
      bounds: [header.minLon, header.minLat, header.maxLon, header.maxLat],
    };
    if (metadata.vector_layers) tileJson.vector_layers = metadata.vector_layers;
    if (metadata.attribution) tileJson.attribution = metadata.attribution;
    if (metadata.description) tileJson.description = metadata.description;
    if (header.minZoom) tileJson.minzoom = header.minZoom;
    if (header.maxZoom) tileJson.maxzoom = header.maxZoom;
    return tileJson;
  }
}

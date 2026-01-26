export * from "./maplibre-gl-js-protocol.js";
export * from "./source.js";
import { FetchSource } from "./source.js";
import subdivideVectorTile from "./tilecutter/subdivide.js";
import defaultDecompress from "./default-decompress.js";
import getJsonFromFile from "./zip/get-json-from-file.js";
import SharedPromiseCache from "./shared-promise-cache.js";

function calculateFilename(z, x, y, header) {
  const zoom = z.toString().padStart(2, "0");
  const baseRow = Math.floor(y / 128) * 128;
  const baseCol = Math.floor(x / 128) * 128;
  const rowHex = baseRow.toString(16).padStart(4, "0");
  const colHex = baseCol.toString(16).padStart(4, "0");
  let basePath;
  if (header.type === "tpkx") {
    basePath = `tile`;
  } else {
    basePath = `p12/tile`;
  }
  return `${basePath}/L${zoom}/R${rowHex}C${colHex}.bundle`;
}

function getTileInfoFromTileIndex(tileIndex, z, x, y) {
  const row = y % 128;
  const col = x % 128;
  return tileIndex[row][col];
}

/**
 * Error thrown when a response for TilePackage over HTTP does not match previous, cached parts of the archive.
 * The default TilePackage implementation will catch this error once internally and retry a request.
 */
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
    if (typeof source === "string") {
      this.source = new FetchSource(source, this.coverageCheck);
    } else {
      this.source = source;
    }

    if (options && options.decompress) {
      this.decompress = options.decompress;
    } else {
      this.decompress = defaultDecompress;
    }

    if (options && options.cache) {
      this.cache = options.cache;
    } else {
      this.cache = new SharedPromiseCache();
    }
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
    if (!header.files[file]) {
      return undefined;
    }

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
      style.sources.esri.url = `tilepackage://${sourceKey}`;
      style.sources.esri.minzoom = 0; //header.maxZoom || 22;
      style.sources.esri.maxzoom = header.maxZoom || 22;
      if (metadata.copyrightText) {
        style.sources.esri.attribution = metadata.copyrightText;
      }
      style.glyphs = `tilepackage://${sourceKey}/{fontstack}/{range}`;
      style.sprite = `tilepackage://${sourceKey}/sprite`;
      return style;
    } else {
      const style = {
        version: 8,
        sources: {
          esri: {
            type: "raster",
            tileSize: header.tileSize || 256,
            url: `tilepackage://${sourceKey}`,
            maxzoom: header.maxZoom || 22,
          },
        },
        layers: [
          {
            id: "tilepackageraster",
            type: "raster",
            source: "esri",
          },
        ],
      };
      return style;
    }
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
    if (metadata.vector_layers) {
      tileJson.vector_layers = metadata.vector_layers;
    }
    if (metadata.attribution) {
      tileJson.attribution = metadata.attribution;
    }
    if (metadata.description) {
      tileJson.description = metadata.description;
    }
    if (header.minZoom) {
      tileJson.minzoom = header.minZoom;
    }
    if (header.maxZoom) {
      tileJson.maxzoom = header.maxZoom;
    }
    return tileJson;
  }
}

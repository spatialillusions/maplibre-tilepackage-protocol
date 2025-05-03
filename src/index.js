export * from "./maplibre-gl-js-protocol.js";
export * from "./source.js";
import { FetchSource } from "./source.js";
import defaultDecompress from "./default-decompress.js";
import getJsonFromFile from "./get-json-from-file.js";
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
  constructor(source, cache, decompress) {
    if (typeof source === "string") {
      this.source = new FetchSource(source);
    } else {
      this.source = source;
    }

    if (decompress) {
      this.decompress = decompress;
    } else {
      this.decompress = defaultDecompress;
    }

    if (cache) {
      this.cache = cache;
    } else {
      this.cache = new SharedPromiseCache();
    }
  }

  async getHeader() {
    return await this.cache.getHeader(this.source);
  }

  async getZxyAttempt(z, x, y, signal) {
    //y = (1 << z) - 1 - y; //TMS vs XYZ
    const header = await this.cache.getHeader(this.source);
    if (z < header.minZoom || z > header.maxZoom) {
      return undefined;
    }
    const file = calculateFilename(z, x, y, header);
    if (!header.files[file]) {
      return undefined;
    }
    const tileIndex = await this.cache.getTileIndex(
      this.source,
      file,
      header,
      signal,
    );
    const tileInfo = getTileInfoFromTileIndex(tileIndex, z, x, y);
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
      return {
        data: data,
        cacheControl: resp.cacheControl,
        expires: resp.expires,
      };
    } else {
      //return await this.getZxyAttempt(z - 1, x / 2, y / 2, signal);
      // Return undefined if the tile is not found
      return undefined;
    }
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
      const style = await getJsonFromFile(
        "p12/resources/styles/root.json",
        header.files,
        this.source,
      );
      style.sources.esri.url = `"tilepackage://${sourceKey}`;
      style.sources.esri.maxzoom = header.maxZoom || 22;
      style.glyphs = `tilepackage://${sourceKey}/{fontstack}/{range}`;
      style.sprite = `tilepackage://${sourceKey}/sprite`;

      return style;
    } else {
      return {
        version: 8,
        sources: {
          esri: {
            type: "raster",
            tileSize: header.tileSize || 256,
            url: `"tilepackage://${sourceKey}`,
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

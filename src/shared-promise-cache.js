import getHeaderAndFileList from "./get-header-and-filelist.js";

function deserializeIndex(dataView) {
  const index = [];

  //const M = BigInt(Math.pow(2, 40));
  for (let row = 0; row < 128; row++) {
    index[row] = [];
    for (let col = 0; col < 128; col++) {
      const tileIndexOffset = 8 * (128 * (row % 128) + (col % 128));
      // eslint-disable-next-line no-undef
      let tileOffset = BigInt(0);
      for (let i = 4; i >= 0; i--) {
        // Start from the last byte for little-endian
        tileOffset =
          // eslint-disable-next-line no-undef
          (tileOffset << BigInt(8)) |
          // eslint-disable-next-line no-undef
          BigInt(dataView.getUint8(tileIndexOffset + i));
      }
      // eslint-disable-next-line no-undef
      let tileSize = BigInt(0);
      for (let i = 2; i >= 0; i--) {
        // Start from the last byte for little-endian
        tileSize =
          // eslint-disable-next-line no-undef
          (tileSize << BigInt(8)) |
          // eslint-disable-next-line no-undef
          BigInt(dataView.getUint8(tileIndexOffset + 5 + i));
      }
      if (tileSize > 0) {
        index[row][col] = {
          row: row,
          col: col,
          tileOffset: Number(tileOffset),
          tileSize: Number(tileSize),
        };
      }
    }
  }

  return index;
}

async function getResource(source, file, header, signal) {
  const resp = await source.getBytes(
    header.files[file].absoluteOffset,
    header.files[file].size,
    signal,
    header.etag,
  );
  return resp;
}

async function getTileIndex(source, file, header, signal) {
  const offset = header.files[file].absoluteOffset + 64; // File header 64bytes
  const resp = await source.getBytes(
    offset,
    128 * 128 * 8,
    signal,
    header.etag,
  );
  const dataView = new DataView(resp.data, 0, 128 * 128 * 8);
  const directory = deserializeIndex(dataView);
  if (directory.length === 0) {
    throw new Error("Empty directory is invalid");
  }
  return directory;
}

/**
 * A cache for parts of a TilePackage archive where promises can be shared between requests.
 *
 * Only caches headers, resource files, and directories, not individual tile contents.
 */
export default class SharedPromiseCache {
  constructor(maxCacheEntries = 100) {
    this.cache = new Map();
    this.invalidations = new Map();
    this.maxCacheEntries = maxCacheEntries;
    this.counter = 1;
    //this.decompress = decompress;
    this.subdivided = new Map(); // key: sourceKey|z|x|y -> Uint8Array
  }

  async getHeader(source) {
    const cacheKey = source.getKey();
    const cacheValue = this.cache.get(cacheKey);
    if (cacheValue) {
      cacheValue.lastUsed = this.counter++;
      const data = await cacheValue.data;
      return data;
    }

    const p = new Promise((resolve, reject) => {
      getHeaderAndFileList(source)
        .then((res) => {
          /*
          if (res[1]) {
            this.cache.set(res[1][0], {
              lastUsed: this.counter++,
              data: Promise.resolve(res[1][2]),
            });
          }*/
          resolve(res[0]);
          this.prune();
        })
        .catch((e) => {
          reject(e);
        });
    });
    this.cache.set(cacheKey, { lastUsed: this.counter++, data: p });
    return p;
  }

  async getResource(source, file, header, signal) {
    const cacheKey = `${source.getKey()}|${header.etag || ""}|${file}|Resource`;
    const cacheValue = this.cache.get(cacheKey);
    if (cacheValue) {
      cacheValue.lastUsed = this.counter++;
      const data = await cacheValue.data;
      return data;
    }
    const p = new Promise((resolve, reject) => {
      getResource(source, file, header, signal)
        .then((resource) => {
          resolve(resource);
          this.prune();
        })
        .catch((e) => {
          reject(e);
        });
    });
    this.cache.set(cacheKey, { lastUsed: this.counter++, data: p });
    return p;
  }

  async getTileIndex(source, file, header, signal) {
    const cacheKey = `${source.getKey()}|${
      header.etag || ""
    }|${file}|TileIndex`;
    const cacheValue = this.cache.get(cacheKey);
    if (cacheValue) {
      cacheValue.lastUsed = this.counter++;
      const data = await cacheValue.data;
      return data;
    }
    const p = new Promise((resolve, reject) => {
      getTileIndex(source, file, header, signal)
        .then((directory) => {
          resolve(directory);
          this.prune();
        })
        .catch((e) => {
          reject(e);
        });
    });
    this.cache.set(cacheKey, { lastUsed: this.counter++, data: p });
    return p;
  }

  prune() {
    if (this.cache.size >= this.maxCacheEntries) {
      let minUsed = Infinity;
      let minKey = undefined;
      this.cache.forEach((cacheValue, key) => {
        if (cacheValue.lastUsed < minUsed) {
          minUsed = cacheValue.lastUsed;
          minKey = key;
        }
      });
      if (minKey) {
        this.cache.delete(minKey);
      }
    }
  }

  getSubdivided(source, z, x, y) {
    const key = `${source.getKey()}|${z}|${x}|${y}|Subdivided`;
    return this.subdivided.get(key);
  }

  setSubdivided(source, z, x, y, bytes) {
    const key = `${source.getKey()}|${z}|${x}|${y}|Subdivided`;
    if (!this.subdivided.has(key)) {
      this.subdivided.set(key, bytes);
      // Optional lightweight prune if huge:
      if (this.subdivided.size > this.maxCacheEntries * 2) {
        // Remove oldest half (no usage tracking kept; iterate arbitrary)
        let toRemove = Math.floor(this.subdivided.size / 2);
        for (const k of this.subdivided.keys()) {
          this.subdivided.delete(k);
          toRemove--;
          if (toRemove <= 0) break;
        }
      }
    }
  }

  async invalidate(source) {
    const key = source.getKey();
    if (this.invalidations.get(key)) {
      return await this.invalidations.get(key);
    }
    this.cache.delete(source.getKey());
    const p = new Promise((resolve, reject) => {
      this.getHeader(source)
        .then(() => {
          resolve();
          this.invalidations.delete(key);
        })
        .catch((e) => {
          reject(e);
        });
    });
    this.invalidations.set(key, p);
  }
}

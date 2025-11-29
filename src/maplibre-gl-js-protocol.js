import { TilePackage } from "./index.js";
import protocolGlyphs from "maplibre-local-glyphs";

function stringEndsIn(string, endings) {
  for (let i = 0; i < endings.length; i++) {
    if (string.slice(-endings[i].length) == endings[i]) return endings[i];
  }
  return false;
}

const converter = (getData) => (requestParameters, arg2) => {
  if (arg2 instanceof AbortController) {
    return getData(requestParameters, arg2);
  }
  const abortController = new AbortController();
  getData(requestParameters, abortController)
    .then(
      (result) => {
        return arg2(
          undefined,
          result.data,
          result.cacheControl || "",
          result.expires || "",
        );
      },
      (err) => {
        return arg2(err);
      },
    )
    .catch((e) => {
      return arg2(e);
    });
  return { cancel: () => abortController.abort() };
};

/**
 * MapLibre GL JS protocol. Must be added once globally.
 */
export class Protocol {
  /**
   * Initialize the MapLibre TilePackage protocol.
   *
   * * metadata: also load the metadata section of the TilePackage. required for some "inspect" functionality
   * and to automatically populate the map attribution. Requires an extra HTTP request.
   * * errorOnMissingTile: When a vector MVT tile is missing from the archive, raise an error instead of
   * returning the empty array. Not recommended. This is only to reproduce the behavior of ZXY tile APIs
   * which some applications depend on when overzooming.
   */
  constructor(options) {
    this.tiles = new Map();
    this.metadata = options ? options.metadata || false : false;
    this.errorOnMissingTile = options
      ? options.errorOnMissingTile || false
      : false;
    this.debug = options ? options.debug || false : false;
    this.getData = async (params, abortController) => {
      if (params.type === "json") {
        let tilePackageUrl = params.url.substr(14); // TODO fix this to be more robust
        // at the moment we depend on that the tilePackage URL starts with tilepackage://

        let spriteCheck = stringEndsIn(params.url, [
          "/sprite",
          "/sprite.json",
          "/sprite@2x.json",
        ]);
        if (spriteCheck) {
          // For some reason spirit and glyphs urls might loose the : in http://
          tilePackageUrl = tilePackageUrl.replace(/(https?)\/\/?/g, "$1://");
          tilePackageUrl = tilePackageUrl.slice(0, -spriteCheck.length);
          if (spriteCheck == "/sprite") {
            spriteCheck = "/sprite.json";
          }
        }

        let instance = this.tiles.get(tilePackageUrl);
        if (!instance) {
          instance = new TilePackage(tilePackageUrl);
          this.tiles.set(tilePackageUrl, instance);
        }

        if (spriteCheck) {
          // This is a request for a sprite json
          const file = `p12/resources/sprites${spriteCheck}`;
          const resp = await instance.getResource(file, abortController.signal);
          if (resp) {
            const decoder = new TextDecoder("utf-8");
            const json = JSON.parse(decoder.decode(resp.data));
            return {
              data: json,
            };
          }
        }
        // This is a request for a tile json
        if (this.metadata) {
          const tj = await instance.getTileJson(params.url);
          if (this.debug)
            console.debug("[tilepackage] tilejson (metadata)", tj);
          return { data: tj };
        }
        const h = await instance.getHeader();
        if (h.minLon >= h.maxLon || h.minLat >= h.maxLat) {
          console.error(
            `Bounds of TilePackage archive ${h.minLon},${h.minLat},${h.maxLon},${h.maxLat} are not valid.`,
          );
        }

        const synthesized = {
          tiles: [`${params.url}/{z}/{x}/{y}`],
          minzoom: h.minZoom,
          maxzoom: h.maxZoom,
          bounds: [h.minLon, h.minLat, h.maxLon, h.maxLat],
        };
        if (this.debug)
          console.debug("[tilepackage] tilejson (synthesized)", synthesized);
        return { data: synthesized };
        //}
      }
      // TODO handle other paths ???
      let re = new RegExp(/tilepackage:\/\/(.+)\/(\d+)\/(\d+)\/(\d+)/);
      let result = params.url.match(re);
      if (!result) {
        // This might be a request for glyphs or spirit
        let tilePackageUrl = params.url.substr(14);
        // For some reason spirit and glyphs urls might loose the : in http://
        tilePackageUrl = tilePackageUrl.replace(/(https?)\/\/?/g, "$1://");
        let spriteCheck = stringEndsIn(params.url, [
          "/sprite",
          "/sprite.png",
          "/sprite@2x.png",
        ]);
        if (spriteCheck) {
          // It looks like we are looking for a spirit png
          tilePackageUrl = tilePackageUrl.slice(0, -spriteCheck.length);
          if (spriteCheck == "/sprite") {
            spriteCheck = "/sprite.png";
          }
          let instance = this.tiles.get(tilePackageUrl);
          if (!instance) {
            instance = new TilePackage(tilePackageUrl);
            this.tiles.set(tilePackageUrl, instance);
          }
          const file = `p12/resources/sprites${spriteCheck}`;
          const resp = await instance.getResource(file, abortController.signal);
          if (resp) {
            return {
              data: new Uint8Array(resp.data),
              cacheControl: resp.cacheControl,
              expires: resp.expires,
            };
          }
        } else {
          // This is more likely a glyph url
          re = new RegExp(/^tilepackage:\/\/(.+?)\/([^/]+)\/([^/]+)$/);
          result = params.url.match(re);
          if (result && isNaN(result[2])) {
            const tilePackageUrl = result[1];
            let instance = this.tiles.get(tilePackageUrl);
            if (!instance) {
              instance = new TilePackage(tilePackageUrl);
              this.tiles.set(tilePackageUrl, instance);
            }
            const file = `p12/resources/fonts/${result[2]}/${result[3]}.pbf`;
            const resp = await instance.getResource(
              file,
              abortController.signal,
            );
            if (resp) {
              return {
                data: new Uint8Array(resp.data),
                cacheControl: resp.cacheControl,
                expires: resp.expires,
              };
            }

            // Fallback to local glyphs since we couldn't load the coorect from the vtpk
            const fallback = await protocolGlyphs({
              url: `glyphs://${result[2]}/${result[3]}`,
            });
            if (fallback) {
              return fallback;
            }

            return { data: null };
          }
        }
      }

      if (!result) {
        throw new Error("Invalid TilePackage protocol URL");
      }
      const tilePackageUrl = result[1];

      let instance = this.tiles.get(tilePackageUrl);
      if (!instance) {
        instance = new TilePackage(tilePackageUrl);
        this.tiles.set(tilePackageUrl, instance);
      }
      const z = result[2];
      const x = result[3];
      const y = result[4];
      const header = await instance.getHeader();
      const resp = await instance.getZxy(+z, +x, +y, abortController.signal);
      if (this.debug)
        console.debug("[tilepackage] tile fetch", {
          z: +z,
          x: +x,
          y: +y,
          found: !!resp,
        });
      if (resp) {
        return {
          data: new Uint8Array(resp.data),
          cacheControl: resp.cacheControl,
          expires: resp.expires,
        };
      }
      if (header.tileType === "pbf") {
        if (this.errorOnMissingTile) {
          //*
          const e = new Error(
            `Tile [${z},${x},${y}] not found in Tile Package, normal for VTPK with variable depth.`,
          );
          e.name = "TileError";
          if (this.debug)
            console.debug("[tilepackage] missing tile", { z, x, y });
          throw e;
        }
        return { data: new Uint8Array() };
      } else {
        return { data: null };
      }
    };

    this.package = converter(this.getData);
  }

  /**
   * Add a {@link TilePackage} instance to the global protocol instance.
   *
   * For remote fetch sources, references in MapLibre styles like tilePackage://http://...
   * will resolve to the same instance if the URLs match.
   */
  add(p) {
    this.tiles.set(p.source.getKey(), p);
    if (this.debug)
      console.debug("[tilepackage] add instance", p.source.getKey());
  }

  /**
   * Fetch a {@link TilePackage} instance by URL, for remote TilePackage instances.
   */
  get(url) {
    if (this.debug) console.debug("[tilepackage] get instance", url);
    return this.tiles.get(url);
  }
}

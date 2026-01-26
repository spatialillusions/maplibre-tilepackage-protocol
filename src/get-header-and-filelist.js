import getJsonFromFile from "./zip/get-json-from-file.js";
import getFilelistFromTilePackage from "./zip/get-filelist.js";

function xmlToJson(xmlString) {
  const parser = new DOMParser();
  const xmlDoc = parser.parseFromString(xmlString, "application/xml");
  const obj = {};

  function traverse(node, obj) {
    if (node.nodeType === 1) {
      // element
      const nodeName = node.nodeName;
      if (!obj[nodeName] && node.childNodes.length > 0) {
        obj[nodeName] = {};
      }
      if (node.childNodes.length == 1 && node.childNodes[0].nodeType == 3) {
        obj[nodeName] = node.childNodes[0].nodeValue.trim();
        return;
      }
      for (let i = 0; i < node.childNodes.length; i++) {
        traverse(node.childNodes[i], obj[nodeName]);
      }
    }
  }

  traverse(xmlDoc.documentElement, obj);
  return obj;
}

/**
 * Parse json into a Header object.
 */
export function jsonToHeader(json, files, etag) {
  let spatialReference;
  try {
    spatialReference = json.tileInfo.spatialReference.latestWkid;
    // eslint-disable-next-line no-unused-vars
  } catch (e) {
    spatialReference = undefined;
  }
  return {
    type: json.type,
    name: json.name,
    description: json.serviceDescription,
    attribution: json.copyrightText,
    version: json.version,
    metadataOffset: json.metadataOffset || 0,
    metadataLength: json.metadataLength || 0,
    packageType: json.tileInfo.format ? "vtpk" : "tpkx",
    spatialReference: spatialReference,
    tileCompression: json.resourceInfo
      ? json.resourceInfo.tileCompression || "none"
      : "none",
    tileType: json.tileInfo.format || json.tileImageInfo.format,
    tileSize: json.tileInfo.rows,
    minZoom: json.minZoom || json.minLOD,
    maxZoom: json.maxZoom || json.maxLOD,
    minLon: Number(json.extent.xmin),
    minLat: Number(json.extent.ymin),
    maxLon: Number(json.extent.xmax),
    maxLat: Number(json.extent.ymax),
    files: files,
    coverageMap: json.coverageMap,
    etag: etag,
  };
}

/**
 * Retrieve the header and root directory of a TilePackage archive.
 *
 * @param {Source} source - The source of the TilePackage archive.
 */
export default async function getHeaderAndFileList(source) {
  const key = source.getKey();
  const { files: tilePackageFiles, etag } =
    await getFilelistFromTilePackage(source);
  let root = {};
  if (key.indexOf(".tpkx") !== -1) {
    // TPKX
    root = await getJsonFromFile("root.json", tilePackageFiles, source);
    root.type = "tpkx";
    const iteminfo = await getJsonFromFile(
      "iteminfo.json",
      tilePackageFiles,
      source,
    );
    Object.keys(iteminfo).forEach((key) => {
      if (key !== "type") {
        root[key] = iteminfo[key];
      }
    });
  } else {
    // VTPK
    root = await getJsonFromFile("p12/root.json", tilePackageFiles, source);
    root.type = "vtpk";

    const iteminfoFile = "esriinfo/iteminfo.xml";
    if (tilePackageFiles[iteminfoFile]) {
      const iteminfoOffset = tilePackageFiles[iteminfoFile].absoluteOffset;

      const iteminfoData = await source.getBytes(
        iteminfoOffset,
        tilePackageFiles[iteminfoFile].size,
      );
      const decoder = new TextDecoder("utf-8");
      const iteminfoString = decoder.decode(iteminfoData.data);
      const iteminfo = xmlToJson(iteminfoString);
      Object.keys(iteminfo.ESRI_ItemInformation).forEach((key) => {
        if (key !== "type") {
          root[key] = iteminfo.ESRI_ItemInformation[key];
        }
      });
    }

    if (tilePackageFiles["p12/metadata.json"]) {
      const metadataOffset =
        tilePackageFiles["p12/metadata.json"].absoluteOffset;
      root.metadataOffset = metadataOffset;
      root.metadataLength = tilePackageFiles["p12/metadata.json"].size;
    }

    async function calculateCoverage(z, x, y, tilemap, coverageMap) {
      z = z + 1;
      x = x * 2;
      y = y * 2;
      if (coverageMap[z] == undefined) coverageMap[z] = {};
      if (coverageMap[z][x] == undefined) coverageMap[z][x] = {};
      if (coverageMap[z][x + 1] == undefined) coverageMap[z][x + 1] = {};
      coverageMap[z][x][y] = tilemap[0];
      if (isNaN(tilemap[0])) {
        calculateCoverage(z, x, y, tilemap[0], coverageMap);
      }
      coverageMap[z][x + 1][y] = tilemap[1];
      if (isNaN(tilemap[1])) {
        calculateCoverage(z, x + 1, y, tilemap[1], coverageMap);
      }
      coverageMap[z][x][y + 1] = tilemap[2];
      if (isNaN(tilemap[2])) {
        calculateCoverage(z, x, y + 1, tilemap[2], coverageMap);
      }
      coverageMap[z][x + 1][y + 1] = tilemap[3];
      if (isNaN(tilemap[3])) {
        calculateCoverage(z, x + 1, y + 1, tilemap[3], coverageMap);
      }
    }
    // Get and calculate the tilemap
    if (source.coverageCheck > 0 && tilePackageFiles["p12/tilemap/root.json"]) {
      const tilemap = await getJsonFromFile(
        "p12/tilemap/root.json",
        tilePackageFiles,
        source,
      );
      const coverageMap = {};
      coverageMap[0] = {};
      coverageMap[0][0] = {};
      coverageMap[0][0][0] = "blob";
      calculateCoverage(0, 0, 0, tilemap.index, coverageMap);
      root.coverageMap = coverageMap;
    }
  }

  const header = jsonToHeader(root, tilePackageFiles, etag);
  return [header, ""];
}

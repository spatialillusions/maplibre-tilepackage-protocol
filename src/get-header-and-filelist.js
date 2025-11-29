import getJsonFromFile from "./get-json-from-file.js";

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
  const fileSize = await source.getSize();
  const resp = await source.getBytes(fileSize - 98, 98);
  let v = new DataView(resp.data, 0, 98);
  let entriesCentralDirectory, sizeCentralDirectory, offsetCentralDirectory;
  //let bigZip64 = false;
  if (v.getUint32(0, true) === 0x06064b50) {
    // This is a ZIP64 tilepackage
    //bigZip64 = true;
    entriesCentralDirectory = Number(v.getBigUint64(32, true));
    sizeCentralDirectory = Number(v.getBigUint64(40, true));
    offsetCentralDirectory = Number(v.getBigUint64(48, true));
  } else {
    v = new DataView(resp.data, 98 - 22, 22);
    if (v.getUint32(0, true) === 0x06054b50) {
      // This is a ordinary zip archive
      entriesCentralDirectory = Number(v.getUint16(10, true));
      sizeCentralDirectory = Number(v.getUint32(12, true));
      offsetCentralDirectory = Number(v.getUint32(16, true));
    } else {
      throw new Error("Wrong magic number for Zip archive");
    }
  }

  const centralDirectory = await source.getBytes(
    offsetCentralDirectory,
    sizeCentralDirectory,
  );

  v = new DataView(centralDirectory.data, 0, sizeCentralDirectory);
  if (v.getUint32(0, true) !== 0x02014b50) {
    throw new Error("Wrong magic number for Central Directory archive");
  }

  let entryStart = 0;
  const tilePackageFiles = {};
  for (let i = 0; i < entriesCentralDirectory; i++) {
    if (entryStart >= sizeCentralDirectory) break;
    /*
        central file header signature   4 bytes  (0x02014b50)
        version made by                 2 bytes
        version needed to extract       2 bytes
        general purpose bit flag        2 bytes
        compression method              2 bytes
        last mod file time              2 bytes
        last mod file date              2 bytes
        crc-32                          4 bytes
        compressed size                 4 bytes
        uncompressed size               4 bytes
        file name length                2 bytes
        extra field length              2 bytes
        file comment length             2 bytes
        disk number start               2 bytes
        internal file attributes        2 bytes
        external file attributes        4 bytes
        relative offset of local header 4 bytes

        file name (variable size)
        extra field (variable size)
        file comment (variable size)
    */
    let sizeFile = v.getUint32(entryStart + 20, true);

    const sizeFileName = v.getUint16(entryStart + 28, true);

    const sizeExtraField = v.getUint16(entryStart + 30, true);

    const sizeComment = v.getUint16(entryStart + 32, true);

    let relativeOffset = v.getUint32(entryStart + 42, true);

    const vFilename = new DataView(
      centralDirectory.data,
      entryStart + 46,
      sizeFileName,
    );
    const decoder = new TextDecoder("utf-8");
    const filename = decoder.decode(vFilename);

    if (
      (sizeFile == 0xffffffff || relativeOffset == 0xffffffff) &&
      sizeExtraField > 0
    ) {
      const vExtended = new DataView(
        centralDirectory.data,
        entryStart + 46 + sizeFileName,
        32,
      );
      if (vExtended.getUint16(0, true) == 0x0001) {
        /*
        Value      Size       Description
        -----      ----       -----------
(ZIP64) 0x0001     2 bytes    Tag for this "extra" block type
        Size       2 bytes    Size of this "extra" block
        Original 
        Size       8 bytes    Original uncompressed file size
        Compressed
        Size       8 bytes    Size of compressed data
        Relative Header
        Offset     8 bytes    Offset of local header record
        Disk Start
        Number     4 bytes    Number of the disk on which
                              this file starts
      */

        let j = 0;
        if (sizeFile == 0xffffffff) {
          sizeFile = Number(vExtended.getBigUint64(4, true));
          j += 8;
        }
        if (relativeOffset == 0xffffffff) {
          relativeOffset = Number(vExtended.getBigUint64(4 + j, true));
        }
      }
    }

    tilePackageFiles[filename] = {
      filename: filename,
      size: sizeFile,
      relativeOffset: relativeOffset,
      absoluteOffset: relativeOffset + 30 + filename.length,
    };
    entryStart += 46 + sizeFileName + sizeExtraField + sizeComment;
  }

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
    } else {
      // Coverage map unavailable (either disabled or missing tilemap/root.json)
    }
  }

  const header = jsonToHeader(root, tilePackageFiles, resp.etag);
  return [header, ""];
}

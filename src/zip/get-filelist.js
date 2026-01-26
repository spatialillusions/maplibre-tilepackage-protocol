const ZIP64_EOCD_SIGNATURE = 0x06064b50;
const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_DIRECTORY_SIGNATURE = 0x02014b50;
const LOCAL_FILE_HEADER_SIGNATURE = 0x04034b50;
const MIN_EOCD_SIZE = 22;
const ZIP64_EOCD_SIZE = 56;
const MAX_TAIL_SCAN = 65536; // 64KB
const MAX_CENTRAL_DIR_SIZE = 500 * 1024 * 1024; // 500MB
const MAX_DIRECTORY_ENTRIES = 1000000;
const LOCAL_FILE_HEADER_BASE = 30;

function scanForSignature(view, signature, minSize) {
  for (let i = view.byteLength - minSize; i >= 0; i--) {
    if (view.getUint32(i, true) === signature) {
      return i;
    }
  }
  return -1;
}

function parseZip64EndOfCentralDirectory(view, position) {
  return {
    entries: Number(view.getBigUint64(position + 32, true)),
    size: Number(view.getBigUint64(position + 40, true)),
    offset: Number(view.getBigUint64(position + 48, true)),
  };
}

function parseEndOfCentralDirectory(view, position) {
  return {
    entries: view.getUint16(position + 10, true),
    size: view.getUint32(position + 12, true),
    offset: view.getUint32(position + 16, true),
  };
}

async function readLocalFileHeader(source, offset, decoder) {
  const headerResp = await source.getBytes(offset, LOCAL_FILE_HEADER_BASE);
  if (headerResp.data.byteLength < LOCAL_FILE_HEADER_BASE) {
    throw new Error("Local file header truncated before 30 bytes");
  }

  const headerView = new DataView(headerResp.data, 0, LOCAL_FILE_HEADER_BASE);
  const signature = headerView.getUint32(0, true);
  if (signature !== LOCAL_FILE_HEADER_SIGNATURE) {
    throw new Error(
      `Local file header signature mismatch (0x${signature.toString(16)})`,
    );
  }

  const filenameLength = headerView.getUint16(26, true);
  const extraFieldLength = headerView.getUint16(28, true);
  const trailingLength = filenameLength + extraFieldLength;
  let filename = "";

  if (filenameLength > 0) {
    const trailingResp = await source.getBytes(
      offset + LOCAL_FILE_HEADER_BASE,
      trailingLength,
    );
    if (trailingResp.data.byteLength < trailingLength) {
      throw new Error("Local header filename/extra data truncated");
    }
    const filenameView = new DataView(trailingResp.data, 0, filenameLength);
    filename = decoder.decode(filenameView);
  }

  return {
    filename,
    filenameLength,
    extraFieldLength,
    dataOffset:
      offset + LOCAL_FILE_HEADER_BASE + filenameLength + extraFieldLength,
  };
}

async function verifyLocalHeaderOffset({
  source,
  filename,
  relativeOffset,
  computedOffset,
  decoder,
  logger,
}) {
  try {
    const localHeader = await readLocalFileHeader(
      source,
      relativeOffset,
      decoder,
    );
    if (localHeader.filename !== filename) {
      logger(
        `Local header filename mismatch for ${filename}: found ${localHeader.filename} at offset ${relativeOffset}`,
      );
    }
    if (localHeader.dataOffset !== computedOffset) {
      logger(
        `Data offset mismatch for ${filename}: calculated ${computedOffset}, actual ${localHeader.dataOffset}`,
      );
    }
    return localHeader;
  } catch (error) {
    logger(
      `Failed to verify local header for ${filename} at ${relativeOffset}: ${error.message}`,
    );
    return null;
  }
}

export default async function getFilelistFromZip(source, options) {
  const resolvedOptions = options || {};
  const verifyOffsets =
    typeof resolvedOptions.verifyOffsets === "boolean"
      ? resolvedOptions.verifyOffsets
      : false;
  const verificationLogger =
    typeof resolvedOptions.verificationLogger === "function"
      ? resolvedOptions.verificationLogger
      : console.warn;
  const fileSize = await source.getSize();
  if (fileSize < MIN_EOCD_SIZE) {
    throw new Error(
      "File too small to be a valid ZIP archive (minimum 22 bytes)",
    );
  }

  const tailReadSize = Math.min(MAX_TAIL_SCAN, fileSize);
  const tailOffset = fileSize - tailReadSize;
  const tailResp = await source.getBytes(tailOffset, tailReadSize);
  const tailView = new DataView(tailResp.data, 0, tailReadSize);

  let entriesCentralDirectory;
  let sizeCentralDirectory;
  let offsetCentralDirectory;

  const zip64Pos = scanForSignature(
    tailView,
    ZIP64_EOCD_SIGNATURE,
    ZIP64_EOCD_SIZE,
  );
  if (zip64Pos !== -1) {
    const zip64Data = parseZip64EndOfCentralDirectory(tailView, zip64Pos);
    entriesCentralDirectory = zip64Data.entries;
    sizeCentralDirectory = zip64Data.size;
    offsetCentralDirectory = zip64Data.offset;
  } else {
    const eocdPos = scanForSignature(tailView, EOCD_SIGNATURE, MIN_EOCD_SIZE);
    if (eocdPos === -1) {
      throw new Error("End of Central Directory record not found in zip");
    }
    const eocdData = parseEndOfCentralDirectory(tailView, eocdPos);
    entriesCentralDirectory = eocdData.entries;
    sizeCentralDirectory = eocdData.size;
    offsetCentralDirectory = eocdData.offset;
  }

  if (sizeCentralDirectory > MAX_CENTRAL_DIR_SIZE) {
    throw new Error("Central directory size exceeds maximum allowed (500MB)");
  }
  if (entriesCentralDirectory > MAX_DIRECTORY_ENTRIES) {
    throw new Error("Too many entries in central directory (max 1000000)");
  }

  if (offsetCentralDirectory < 0) {
    throw new Error("Central directory offset is negative, file is corrupted");
  }

  const availableBytes = fileSize - offsetCentralDirectory;
  if (availableBytes < 0) {
    throw new Error("Central directory offset is beyond file size");
  }

  let safeCentralDirectorySize = sizeCentralDirectory;
  if (safeCentralDirectorySize > availableBytes) {
    console.warn(
      "Central directory size extends past end of file, clamping to available bytes",
    );
    safeCentralDirectorySize = availableBytes;
  }
  if (safeCentralDirectorySize <= 0) {
    throw new Error(
      "Central directory size is zero or negative after validation",
    );
  }

  const centralDirectory = await source.getBytes(
    offsetCentralDirectory,
    safeCentralDirectorySize,
  );
  const v = new DataView(centralDirectory.data, 0, safeCentralDirectorySize);

  if (v.getUint32(0, true) !== CENTRAL_DIRECTORY_SIGNATURE) {
    throw new Error("Wrong magic number for Central Directory archive");
  }

  const zipFiles = {};
  let entryStart = 0;
  const decoder = new TextDecoder("utf-8");

  for (let i = 0; i < entriesCentralDirectory; i++) {
    if (entryStart + 46 > safeCentralDirectorySize) {
      break;
    }

    const generalPurposeFlag = v.getUint16(entryStart + 8, true);
    const compressionMethod = v.getUint16(entryStart + 10, true);
    if (compressionMethod !== 0 && compressionMethod !== 8) {
      throw new Error(
        "Unsupported compression method: " +
          compressionMethod +
          " only STORE(0) and DEFLATE(8) are supported",
      );
    }
    let sizeFile = v.getUint32(entryStart + 20, true);
    const uncompressedSize = v.getUint32(entryStart + 24, true);
    const sizeFileName = v.getUint16(entryStart + 28, true);
    const sizeExtraField = v.getUint16(entryStart + 30, true);
    const sizeComment = v.getUint16(entryStart + 32, true);
    let relativeOffset = v.getUint32(entryStart + 42, true);

    const headerLength = 46 + sizeFileName + sizeExtraField + sizeComment;
    if (entryStart + headerLength > safeCentralDirectorySize) {
      break;
    }

    const filenameView = new DataView(
      centralDirectory.data,
      entryStart + 46,
      sizeFileName,
    );
    let filename;
    try {
      filename = decoder.decode(filenameView);
    } catch (error) {
      throw new Error(
        "Failed to decode filename in ZIP entry: " + error.message,
      );
    }

    const zip64SizeOverflow = sizeFile === 0xffffffff;
    const zip64UncompressedOverflow = uncompressedSize === 0xffffffff;
    const zip64OffsetOverflow = relativeOffset === 0xffffffff;
    const hasZip64Marker =
      zip64SizeOverflow || zip64UncompressedOverflow || zip64OffsetOverflow;
    let localExtraFieldZip64Length = 0;

    if (hasZip64Marker && sizeExtraField > 0) {
      const extraStart = entryStart + 46 + sizeFileName;
      const extraEnd = extraStart + sizeExtraField;
      if (extraEnd <= safeCentralDirectorySize) {
        const extraView = new DataView(
          centralDirectory.data,
          extraStart,
          sizeExtraField,
        );
        let extraOffset = 0;
        let iterations = 100;
        while (extraOffset + 4 <= sizeExtraField && iterations > 0) {
          iterations--;
          const headerId = extraView.getUint16(extraOffset, true);
          const dataSize = extraView.getUint16(extraOffset + 2, true);

          if (headerId === 0x0001) {
            // APPNOTE.TXT (4.5.3) – local header ZIP64 field only stores
            // the compressed/uncompressed sizes when a 64-bit value is needed.
            const dataStart = extraOffset + 4;
            const dataEnd = dataStart + dataSize;
            let cursor = dataStart;
            let localZip64DataSize = 0;

            if (zip64UncompressedOverflow) {
              if (cursor + 8 > dataEnd) {
                throw new Error(
                  "ZIP64 extra field truncated while reading uncompressed size",
                );
              }
              extraView.getBigUint64(cursor, true);
              cursor += 8;
              localZip64DataSize += 8;
            }

            if (zip64SizeOverflow) {
              if (cursor + 8 > dataEnd) {
                throw new Error(
                  "ZIP64 extra field truncated while reading compressed size",
                );
              }
              sizeFile = Number(extraView.getBigUint64(cursor, true));
              cursor += 8;
              localZip64DataSize += 8;
            }

            if (zip64OffsetOverflow) {
              if (cursor + 8 > dataEnd) {
                throw new Error(
                  "ZIP64 extra field truncated while reading relative offset",
                );
              }
              relativeOffset = Number(extraView.getBigUint64(cursor, true));
              cursor += 8;
            }

            if (localZip64DataSize > 0) {
              localExtraFieldZip64Length = 4 + localZip64DataSize;
            }
            break;
          }

          if (dataSize === 0) {
            extraOffset += 4;
          } else {
            extraOffset += 4 + dataSize;
          }
        }
      }
    }
    let absoluteOffset =
      relativeOffset + 30 + sizeFileName + localExtraFieldZip64Length;

    if (verifyOffsets) {
      const verification = await verifyLocalHeaderOffset({
        source,
        filename,
        relativeOffset,
        computedOffset: absoluteOffset,
        decoder,
        logger: verificationLogger,
      });
      if (verification && typeof verification.dataOffset === "number") {
        absoluteOffset = verification.dataOffset;
      }
    }
    zipFiles[filename] = {
      filename,
      size: sizeFile,
      generalPurposeFlag,
      compressionMethod,
      uncompressedSize,
      relativeOffset,
      absoluteOffset,
    };

    entryStart += headerLength;
  }

  return {
    files: zipFiles,
    etag: tailResp.etag,
  };
}

/* global globalThis */
import * as fflate from "fflate";

/**
 * Provide a decompression implementation that acts on `buf` and returns decompressed data.
 *
 * Should use the native DecompressionStream on browsers, zlib on node.
 * Should throw if the compression algorithm is not supported.
 */
export default async function defaultDecompress(buf, compression) {
  if (compression === "none" || compression === undefined) {
    return buf;
  }
  if (compression === "gzip") {
    if (typeof globalThis.DecompressionStream === "undefined") {
      return fflate.decompressSync(new Uint8Array(buf));
    }
    const stream = new Response(buf).body;
    if (!stream) {
      throw new Error("Failed to read response stream");
    }
    const result = stream.pipeThrough(
      new globalThis.DecompressionStream("gzip"),
    );
    return new Response(result).arrayBuffer();
  }
  throw new Error("Compression method not supported");
}

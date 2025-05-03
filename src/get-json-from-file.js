export default async function getJsonFromFile(file, tilePackageFiles, source) {
  const decoder = new TextDecoder("utf-8");
  if (tilePackageFiles[file]) {
    const fileOffset = tilePackageFiles[file].absoluteOffset;
    const fileJSON = await source.getBytes(
      fileOffset,
      tilePackageFiles[file].size,
    );
    return JSON.parse(decoder.decode(fileJSON.data));
  }
  return {};
}

export default async function getJsonFromZip(file, zipFiles, source) {
  //console.log("getJsonFromZip:", file);
  const decoder = new TextDecoder("utf-8");
  if (zipFiles[file]) {
    const fileOffset = zipFiles[file].absoluteOffset;
    const fileJSON = await source.getBytes(fileOffset, zipFiles[file].size);
    let text;
    try {
      text = decoder.decode(fileJSON.data);
    } catch (error) {
      throw new Error(
        "Failed to decode JSON bytes from " + file + ": " + error.message,
      );
    }

    const trimmed = text.trim();
    if (!trimmed) {
      throw new Error("JSON file " + file + " is empty or whitespace only");
    }

    const firstChar = trimmed[0];
    const lastChar = trimmed[trimmed.length - 1];
    const looksLikeJsonObject = firstChar === "{" && lastChar === "}";
    const looksLikeJsonArray = firstChar === "[" && lastChar === "]";
    if (!looksLikeJsonObject && !looksLikeJsonArray) {
      throw new Error(
        "File " +
          file +
          " does not appear to contain JSON (starts with '" +
          firstChar +
          "' and ends with '" +
          lastChar +
          "')",
      );
    }

    try {
      return JSON.parse(trimmed);
    } catch (error) {
      throw new Error(
        "Failed to parse JSON from " + file + ": " + error.message,
      );
    }
  }
  console.warn(`File ${file} not found in Zip file`);
  return {};
}

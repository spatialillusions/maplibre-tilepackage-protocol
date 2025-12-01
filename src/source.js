/* global globalThis */

/**
 * Interface for retrieving an archive from remote or local storage.
 */
export class Source {
  async getBytes() {
    throw new Error("Not implemented");
  }

  getKey() {
    throw new Error("Not implemented");
  }
}

/**
 * Use the Browser's File API, which is different from the NodeJS file API.
 * see https://developer.mozilla.org/en-US/docs/Web/API/File_API
 */
export class FileSource extends Source {
  constructor(file, options) {
    super();
    this.file = file;
    if (options && options.coverageCheck) {
      this.coverageCheck = options.coverageCheck;
    }
  }

  getKey() {
    return this.file.name;
  }

  async getSize() {
    return this.file.size;
  }

  // eslint-disable-next-line no-unused-vars
  async getBytes(offset, length, passedSignal, etag) {
    const blob = this.file.slice(offset, offset + length);
    const a = await blob.arrayBuffer();
    return { data: a };
  }
}

/**
 * Uses the browser Fetch API to make tile requests via HTTP.
 *
 * This method does not send conditional request headers If-Match because of CORS.
 * Instead, it detects ETag mismatches via the response ETag or the 416 response code.
 *
 * This also works around browser and storage-specific edge cases.
 */
export class FetchSource extends Source {
  constructor(url, options, customHeaders = new Headers()) {
    super();
    this.url = url;
    this.customHeaders = customHeaders;
    this.mustReload = false;
    // Safe global detection for legacy environments without globalThis
    const g =
      typeof globalThis !== "undefined"
        ? globalThis
        : typeof window !== "undefined"
        ? window
        : typeof self !== "undefined"
        ? self
        : {};
    let userAgent = "";
    if (g && typeof g.navigator !== "undefined") {
      userAgent = g.navigator.userAgent || "";
    }
    const isWindows = userAgent.indexOf("Windows") > -1;
    const isChromiumBased = /Chrome|Chromium|Edg|OPR|Brave/.test(userAgent);
    this.chromeWindowsNoCache = false;
    if (isWindows && isChromiumBased) {
      this.chromeWindowsNoCache = true;
    }
    if (options && options.coverageCheck) {
      this.coverageCheck = options.coverageCheck;
    }
  }

  getKey() {
    return this.url;
  }

  // eslint-disable-next-line no-unused-vars
  async getSize(passedSignal, etag) {
    if (this.size) return this.size;

    let controller;
    let signal;
    if (passedSignal) {
      signal = passedSignal;
    } else {
      controller = new AbortController();
      signal = controller.signal;
    }

    const requestHeaders = new Headers(this.customHeaders);
    requestHeaders.set("range", `bytes=${0}-${4}`);

    let cache;
    if (this.mustReload) {
      cache = "reload";
    } else if (this.chromeWindowsNoCache) {
      cache = "no-store";
    }

    const resp = await fetch(this.url, {
      signal: signal,
      cache: cache,
      headers: requestHeaders,
    });

    //Making sure that the server supports content-range and getting the file size
    const contentRange = resp.headers.get("Content-Range");
    if (resp.status === 206 && contentRange) {
      const fileSize = contentRange.split("/")[1];
      if (fileSize) {
        this.size = fileSize;
        return fileSize;
      }
    }
    if (resp.status === 206 && !contentRange) {
      // We didn't get a content-range response, getting head instead
      // Getting head is much slower but works. We need to get the size
      // of the file in some way since zip files has the catalog
      // directory at the end.
      const response = await fetch(this.url, {
        method: "HEAD",
      });
      if (response.ok) {
        const fileSize = response.headers.get("Content-Length");
        this.size = fileSize;
        return fileSize;
      }
    }

    if (resp.status === 200 && !contentRange) {
      if (controller) controller.abort();
      throw new Error(
        "Server returned no content-length header or content-length exceeding request. Check that your storage backend supports HTTP Byte Serving.",
      );
    }
    //const requestHeaders = new Headers(this.customHeaders);
    //requestHeaders.set("method", "HEAD");

    /*
    let controller;
    let signal;
    if (passedSignal) {
      signal = passedSignal;
    } else {
      controller = new AbortController();
      signal = controller.signal;
    }
    */
    /*
    try {
      const response = await fetch(this.url, { method: "HEAD" });
      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }
      const contentLength = response.headers.get("content-length");
      if (contentLength) {
        console.log(contentLength);
        this.size = contentLength;
        return contentLength;
      } else {
        console.error("Content-Length header is not available.");
      }
    } catch (error) {
      console.error("Error fetching headers:", error);
    }*/
  }

  setHeaders(customHeaders) {
    this.customHeaders = customHeaders;
  }

  async getBytes(offset, length, passedSignal, etag) {
    let controller;
    let signal;
    if (passedSignal) {
      signal = passedSignal;
    } else {
      controller = new AbortController();
      signal = controller.signal;
    }

    const requestHeaders = new Headers(this.customHeaders);
    requestHeaders.set("range", `bytes=${offset}-${offset + length - 1}`);

    let cache;
    if (this.mustReload) {
      cache = "reload";
    } else if (this.chromeWindowsNoCache) {
      cache = "no-store";
    }

    let resp = await fetch(this.url, {
      signal: signal,
      cache: cache,
      headers: requestHeaders,
    });

    if (offset === 0 && resp.status === 416) {
      const contentRange = resp.headers.get("Content-Range");
      if (!contentRange || !contentRange.startsWith("bytes */")) {
        throw new Error("Missing content-length on 416 response");
      }
      const actualLength = +contentRange.substr(8);
      resp = await fetch(this.url, {
        signal: signal,
        cache: "reload",
        headers: { range: `bytes=0-${actualLength - 1}` },
      });
    }

    let newEtag = resp.headers.get("Etag");
    if (newEtag && newEtag.startsWith("W/")) {
      newEtag = null;
    }

    if (resp.status === 416 || (etag && newEtag && newEtag !== etag)) {
      this.mustReload = true;
      throw new Error(
        `Server returned non-matching ETag ${etag} after one retry. Check browser extensions and servers for issues that may affect correct ETag headers.`,
      );
    }

    if (resp.status >= 300) {
      throw new Error(`Bad response code: ${resp.status}`);
    }

    const contentLength = resp.headers.get("Content-Length");
    if (resp.status === 200 && (!contentLength || +contentLength > length)) {
      if (controller) controller.abort();
      throw new Error(
        "Server returned no content-length header or content-length exceeding request. Check that your storage backend supports HTTP Byte Serving.",
      );
    }
    const a = await resp.arrayBuffer();
    return {
      data: a,
      etag: newEtag || undefined,
      cacheControl: resp.headers.get("Cache-Control") || undefined,
      expires: resp.headers.get("Expires") || undefined,
    };
  }
}

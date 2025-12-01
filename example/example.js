// Plain script (no modules) for running via file:// without CORS issues.
// Requires dist/bundle.js to have been loaded first, exposing window.TilePackageProtocol.
/* global maplibregl */
(function () {
  if (!window.TilePackageProtocol) {
    console.error(
      "TilePackageProtocol global not found. Load dist/bundle.js before example.js.",
    );
    return;
  }
  const { TilePackage, FileSource, Protocol } = window.TilePackageProtocol;
  let currentMap = null;
  let protocolInstance = null;

  async function initMap(pkg) {
    const header = await pkg.getHeader();
    console.log("TilePackage header:", header);
    if (header.spatialReference == 3857) {
      const style = await pkg.getStyle();
      console.log("TilePackage style:", style);
      if (!protocolInstance) {
        protocolInstance = new Protocol({
          metadata: true,
          subdivideMissingTile: true,
          debug: true,
        });
        console.debug("[example] Protocol initialized (debug:true)");
        // Critical: register existing TilePackage instance so protocol doesn't create FetchSource (causing file:/// fetch)
        protocolInstance.add(pkg);
        console.debug(
          "[example] TilePackage instance added to protocol with key",
          pkg.source.getKey(),
        );
        if (window.maplibregl && maplibregl.addProtocol) {
          maplibregl.addProtocol("tilepackage", protocolInstance.package);
          console.debug("[example] Protocol registered with maplibregl");
        } else {
          console.warn("[example] maplibregl.addProtocol unavailable");
        }
      }
      if (currentMap) {
        try {
          currentMap.remove();
          // eslint-disable-next-line no-unused-vars
        } catch (_) {
          /* empty */
        }
        currentMap = null;
      }
      currentMap = new maplibregl.Map({
        container: "map-element",
        localIdeographFontFamily: false,
        style: style,
      });
    } else {
      console.warn("Unsupported spatial reference", header.spatialReference);
    }
  }

  function initWithFile(file) {
    console.log("Selected file:", file.name);
    try {
      const fileSource = new FileSource(file);
      console.log("FileSource:", fileSource);
      const pkg = new TilePackage(fileSource);
      console.log("TilePackage:", pkg);
      initMap(pkg);
    } catch (err) {
      console.error("Failed to initialize map from file", err);
      alert(
        "Failed to initialize: " + (err && err.message ? err.message : err),
      );
    }
  }

  function sanitizeUrl(u) {
    if (!u) return null;
    u = u.trim();
    if (!u) return null;
    // Allow absolute http(s)
    if (/^https?:\/\//i.test(u)) return u;
    // Disallow protocol-relative and other schemes
    if (u.startsWith("//") || /^[a-zA-Z]+:\/.+/.test(u)) {
      alert("Unsupported or unsafe URL scheme");
      return null;
    }
    // Treat as relative path when not file://
    if (location.protocol !== "file:") {
      try {
        const resolved = new URL(u, window.location.href).href;
        console.debug("[example] Resolved relative URL to", resolved);
        return resolved;
        // eslint-disable-next-line no-unused-vars
      } catch (e) {
        alert("Invalid relative URL");
        return null;
      }
    }
    alert("URL must start with http:// or https:// when using file:// origin");
    return null;
  }

  async function initWithUrl(url) {
    const clean = sanitizeUrl(url);
    if (!clean) return;
    console.log("Loading remote TilePackage URL:", clean);
    try {
      const pkg = new TilePackage(clean);
      console.log("TilePackage (remote):", pkg);
      // Await map initialization so we only reflect URL on success
      await initMap(pkg);
      // If URL input exists and is empty, show the URL used for initialization
      const urlInput = document.getElementById("tilepackage-url");
      if (urlInput && !urlInput.value) {
        urlInput.value = clean;
      }
    } catch (err) {
      console.error("Failed to initialize map from URL", err);
      alert(
        "Failed to initialize: " + (err && err.message ? err.message : err),
      );
    }
  }

  window.addEventListener("DOMContentLoaded", () => {
    const input = document.getElementById("tilepackage-input");
    if (input) {
      input.addEventListener("change", (e) => {
        const file = e.target.files && e.target.files[0];
        if (file) initWithFile(file);
      });
    }
    const urlInput = document.getElementById("tilepackage-url");
    const urlButton = document.getElementById("tilepackage-load-url");
    if (urlButton && urlInput) {
      urlButton.addEventListener("click", () => initWithUrl(urlInput.value));
      urlInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          initWithUrl(urlInput.value);
        }
      });
    }
    // Auto-load demo vtpk when served via http/https (not file://)
    if (location.protocol !== "file:") {
      const demoName = "natural-earth.vtpk"; // present in example folder
      // Use relative path so it works regardless of host/port
      const demoUrl = demoName; // same directory as index.html
      console.log("Attempting auto-load of demo package:", demoUrl);
      initWithUrl(demoUrl);
    }
  });
})();

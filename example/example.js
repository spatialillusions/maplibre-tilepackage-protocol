// Plain script (no modules) for running via file:// without CORS issues.
// Requires dist/bundle.js to have been loaded first, exposing window.TilePackageProtocol.

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
        } catch (_) {}
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
    // Basic guard: only allow http/https
    if (!/^https?:\/\//i.test(u)) {
      alert("URL must start with http:// or https://");
      return null;
    }
    return u;
  }

  function initWithUrl(url) {
    const clean = sanitizeUrl(url);
    if (!clean) return;
    console.log("Loading remote TilePackage URL:", clean);
    try {
      const pkg = new TilePackage(clean);
      console.log("TilePackage (remote):", pkg);
      initMap(pkg);
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
      const demoName = "mgrs-grid.vtpk"; // present in example folder
      // Use relative path so it works regardless of host/port
      const demoUrl = demoName; // same directory as index.html
      console.log("Attempting auto-load of demo package:", demoUrl);
      initWithUrl(demoUrl);
    }
  });
})();

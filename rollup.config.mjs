// rollup.config.mjs
// node resolves makes npm packages be included in the bundle
import { nodeResolve } from "@rollup/plugin-node-resolve";
import commonjs from "@rollup/plugin-commonjs";

const externals = [
  "@mapbox/vector-tile",
  "pbf",
  "@mapbox/point-geometry",
  "@maplibre/vt-pbf",
  "maplibre-local-glyphs",
];

function onwarn(warning) {
  if (warning.code === "CIRCULAR_DEPENDENCY") return;
  console.warn(warning.message);
}

export default [
  // ESM library build (dependencies external)
  {
    input: "src/index.js",
    output: {
      file: "dist/index.esm.js",
      format: "esm",
      sourcemap: true,
    },
    // Keep selected externals; bundle fflate (omit from externals)
    external: externals,
    plugins: [nodeResolve({ browser: true }), commonjs()],
    onwarn,
  },
  // IIFE demo build (fully bundled)
  {
    input: "src/index.js",
    output: {
      file: "dist/bundle.js",
      format: "iife",
      name: "TilePackageProtocol",
      sourcemap: true,
    },
    plugins: [nodeResolve({ browser: true }), commonjs()],
    onwarn,
  },
];

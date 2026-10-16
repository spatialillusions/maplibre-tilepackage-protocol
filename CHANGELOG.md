# Changelog

## 1.2.2

- Remove the unused `maplibre-local-glyphs` dependency and its vulnerable
  installation-time dependency chain.
- Remove the commented-out local-glyph fallback and obsolete Rollup external
  entry. Glyph resources continue to be loaded from the tile package; missing
  resources still return no data.
- Raise the fflate minimum to 0.8.3 and Rollup minimum to 4.59.0 for published
  security fixes; refresh compatible direct and transitive dependency versions.
- Regenerate the lockfile for this release. Existing consumers must update their
  lockfiles to remove the unused dependency chain and receive dependency fixes.

# maplibre-tilepackage-protocol

As an ES6 module: `npm add maplibre-tilepackage-protocol`

```js
import * as tilePackage from "maplibre-tilepackage-protocol";
```

## MapLibre GL JS

Example of a TPKX/VTPK archive displayed in MapLibre GL JS:

```js
import * as tilePackage from "maplibre-tilepackage-protocol";
let protocol = new tilePackage.Protocol();
maplibregl.addProtocol("tilepackage",protocol.tile);
var style = {
"version": 8,
"sources": {
    "example_source": {
        "type": "raster",
        "url": "tilepackage://https://example.com/example.tpkx",
    ...
```

## TPKX

A TPKX file containes a full tile pyramid and you just treat it as any other raster source.

## VTPK

Primarily flat VTPK files are supported, see below for indexed VTPK files.

The file also contains everything you need for your map, such as a style with layers, glyphs, and spirits. You can get everything you need using the tilepackage.

```js
async initMap(package){
    const header = await package.getHeader();
    if (header.spatialReference == 3857) {
        const style = await package.getStyle();
        new maplibregl.Map({
            container: "map-element",
            localIdeographFontFamily: false,
            style: style,
        });
    }
}

const source = String || tilePackage.FileSource;
const package = new tilePackage.TilePackage(
        source,
      );
initMap(package)
```

A VTPK file may contain an indexed tile pyramid where some tiles are missing, because of this you should always initialze a vtpk file with:

```js
let protocol = new tilePackage.Protocol({
  errorOnMissingTile: true,
});
```

This will make tiles from lower zoom levels remain in view when you zoom into the map. Unfortunatly it is not possible to get the tiles to over scale in the same way as in ArcGIS Pro without modifying the source cache code in Maplibre. https://github.com/maplibre/maplibre-gl-js/issues/5618

# Acknowledgement

The code for this protocol was based on the PMTiles protocol by Protomaps LLC.

# Sample data

A sample dataset covering Austria can be downloaded from the following link. Note that this file is an indexed VTPK and won't display all tiles correctly without modifying Maplibre.

https://www.data.gv.at/katalog/de/dataset/basemap-at-verwaltungsgrundkarte-vektor-offline-osterreich#resources

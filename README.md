# Sea Level Globe

A 3D globe of the Earth's terrain, focused on the US west coast, where you can
raise the sea level and see which places the ocean would actually reach.
Low inland areas cut off from the sea, like Death Valley, stay dry until the
water can find a way in.

## What works now

- A 3D globe with real terrain that you can rotate, tilt and zoom
- Three base maps: shaded relief, satellite and plain
- Switches for city names, roads and borders

Coming next: the sea level slider (0 to 70 m), then high-detail coastal data
and rivers and lakes.

## Using it

Open the published site (see Settings → Pages in this repository for the link).
Drag to rotate, scroll or pinch to zoom, and right-drag or two-finger drag to tilt.

## Settings

`config.js` holds the settings you may want to change:

- `CESIUM_ION_TOKEN`: your Cesium ion access token, which loads the world
  terrain and satellite imagery. Without it the app uses Cesium's shared demo
  token and shows a warning banner.
- `START_VIEW`: the area the globe opens on.

## How it is built

A plain web page with no build step: `index.html`, `style.css`, `app.js` and
`config.js`, using [CesiumJS](https://cesium.com/platform/cesiumjs/) from a CDN.

Map data:

| Layer | Source |
| --- | --- |
| Terrain, satellite | Cesium ion (Cesium World Terrain, Bing Maps) |
| Shaded relief, roads | Esri World Hillshade and World Transportation |
| City names | CARTO labels, OpenStreetMap contributors |
| Country borders | Natural Earth via [world-atlas](https://github.com/topojson/world-atlas) |
| US state borders | US Census via [us-atlas](https://github.com/topojson/us-atlas) |

The border files in `data/` are made by `tools/make_borders.mjs`.

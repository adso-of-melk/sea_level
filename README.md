# Sea Level Globe

A 3D globe of the Earth's terrain, focused on the US west coast, where you can
raise the sea level and see which places the ocean would actually reach.
Low inland areas cut off from the sea, like Death Valley, stay dry until the
water can find a way in.

## What works now

- A 3D globe with real terrain that you can rotate, tilt and zoom
- Three base maps: shaded relief, satellite and plain
- Switches for city names, rivers and lakes, natural springs, watershed boundaries, roads and borders
- A compass: drag it to turn the map, click it to face north, or use the turn buttons
- A sea level slider from 0 to 70 m in 10 cm steps, or type a level. Water only
  reaches places the sea could actually flow to, and is shaded darker where it
  is deeper. Flooding is worked out from Washington to Baja California.
  0 m is today's average daily high tide.

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
| Rivers and lakes (US only) | USGS National Hydrography Dataset |
| Natural springs (US only; hot and warm springs in orange) | USGS Geographic Names Information System, made into `data/springs.json` by `tools/make_springs.mjs` |
| Watershed boundaries (US only) | USGS Watershed Boundary Dataset |
| City names | [Natural Earth](https://www.naturalearthdata.com/) populated places, made into `data/places.json` by `tools/make_places.mjs` |
| Country borders | Natural Earth via [world-atlas](https://github.com/topojson/world-atlas) |
| US state borders | US Census via [us-atlas](https://github.com/topojson/us-atlas) |

The border files in `data/` are made by `tools/make_borders.mjs`.

### Flood data

`tools/flood/build.py` works out, for every spot, the lowest sea level at which
ocean water can reach it, and saves the result as map tiles. The **Build flood
data** workflow (Actions tab → Run workflow) runs it on GitHub's computers and
attaches the tiles to the `flood-data` release. The **Publish site** workflow
adds those tiles when it publishes the app to GitHub Pages, so they never need
to be stored in the repository itself.

Elevation inside the US is the USGS 3DEP bare-earth model (about 10 m), which
leaves out trees and buildings. It is stepped down to about 30 m by keeping the
highest point of each 3 x 3 block, so levees and sea walls still hold water
back (very narrow creeks can be closed off the same way). Mexico and any gaps
use the Copernicus GLO-30 surface model (about 30 m), which measures the top of
trees and buildings, so flooding there can appear a little late.

Heights are measured from mean higher high water, the average daily high tide,
as in NOAA's Sea Level Rise Viewer. How far that tide sits above each model's
zero is read from 16 NOAA tide stations from San Diego to Seattle and blended
smoothly between them.

Builds from branches other than `main` publish to a separate
`flood-data-test` release, so they can be checked without changing the site.

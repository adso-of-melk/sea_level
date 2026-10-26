// Sea level slider: paints the land the sea would reach at the chosen rise.
//
// The map tiles in flood/ (made by tools/flood/build.py) hold, for each pixel,
// the lowest sea level at which ocean water can get there, plus the ground
// height. Painting a level is then just a comparison, so the slider is quick.

const FLOOD_URL = "flood/";
const MAX_CACHED_TILES = 800;

let floodMeta = null;
let seaLevelDm = 0; // the chosen rise, in decimetres

// ---- Reading tiles ----------------------------------------------------------

// Decoded tile pixels by "level/x/y", most recently used last. A tile with no
// file (nothing floods there) is stored as null.
const tileCache = new Map();

function loadTile(x, y, level) {
  const key = `${level}/${x}/${y}`;
  let pending = tileCache.get(key);
  if (pending) {
    tileCache.delete(key);
  } else {
    pending = fetch(`${FLOOD_URL}${key}.png`)
      .then((response) => (response.ok ? response.blob() : null))
      .then((blob) => (blob ? decodePixels(blob) : null))
      .catch(() => null);
  }
  tileCache.set(key, pending);
  if (tileCache.size > MAX_CACHED_TILES) {
    tileCache.delete(tileCache.keys().next().value);
  }
  return pending;
}

async function decodePixels(blob) {
  // Read the exact stored values: no colour management or alpha blending.
  const bitmap = await createImageBitmap(blob, {
    premultiplyAlpha: "none",
    colorSpaceConversion: "none",
  });
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  context.drawImage(bitmap, 0, 0);
  return context.getImageData(0, 0, canvas.width, canvas.height).data;
}

// ---- Painting water ---------------------------------------------------------

// Shallow water is pale, deep water is dark: 0 m to 20 m deep and beyond.
function waterColour(depthM) {
  const t = Math.min(Math.max(depthM, 0) / 20, 1);
  return [150 - 130 * t, 215 - 135 * t, 250 - 80 * t];
}

function paintTile(pixels) {
  const canvas = document.createElement("canvas");
  canvas.width = 256;
  canvas.height = 256;
  if (!pixels || seaLevelDm <= 0) return canvas;

  const context = canvas.getContext("2d");
  const image = context.createImageData(256, 256);
  const out = image.data;
  const { offsetM, stepM } = floodMeta.ground;
  for (let i = 0; i < pixels.length; i += 4) {
    const floodLevelDm = pixels[i] * 256 + pixels[i + 1];
    if (floodLevelDm > seaLevelDm) continue; // dry, or never floods
    const groundM = offsetM + pixels[i + 2] * stepM;
    const [r, g, b] = waterColour(seaLevelDm / 10 - groundM);
    out[i] = r;
    out[i + 1] = g;
    out[i + 2] = b;
    out[i + 3] = 200;
  }
  context.putImageData(image, 0, 0);
  return canvas;
}

// A Cesium imagery provider that serves painted water tiles.
function makeFloodProvider(meta) {
  const tilingScheme = new Cesium.GeographicTilingScheme();
  const empty = document.createElement("canvas");
  empty.width = 256;
  empty.height = 256;
  return {
    tilingScheme,
    rectangle: Cesium.Rectangle.fromDegrees(...meta.bounds),
    tileWidth: 256,
    tileHeight: 256,
    minimumLevel: 0,
    maximumLevel: meta.maxZoom,
    tileDiscardPolicy: undefined,
    errorEvent: new Cesium.Event(),
    credit: new Cesium.Credit("Flood levels from Copernicus GLO-30 elevation"),
    proxy: undefined,
    hasAlphaChannel: true,
    getTileCredits: () => undefined,
    pickFeatures: () => undefined,
    requestImage(x, y, level) {
      if (level < meta.minZoom) return Promise.resolve(empty);
      return loadTile(x, y, level).then(paintTile);
    },
  };
}

// ---- The water layer --------------------------------------------------------

let floodProvider = null;
let floodLayer = null;

// Cesium keeps painted tiles, so a new level needs a fresh layer. The old one
// stays until the new one has loaded, which avoids a flash of dry land.
function repaintWater() {
  if (!floodProvider) return;
  const old = floodLayer;
  floodLayer = new Cesium.ImageryLayer(floodProvider);
  // Just above the base map, under roads and city names.
  layers.add(floodLayer, old ? layers.indexOf(old) + 1 : 1);
  if (!old) return;
  const stopWaiting = viewer.scene.globe.tileLoadProgressEvent.addEventListener((queued) => {
    if (queued > 0) return;
    stopWaiting();
    layers.remove(old, true);
  });
}

// ---- Controls ---------------------------------------------------------------

const slider = document.getElementById("level-slider");
const levelBox = document.getElementById("level-number");
const floodStatus = document.getElementById("flood-status");

let repaintTimer = null;

function setSeaLevel(metres, { fromSlider = false } = {}) {
  const clamped = Math.min(Math.max(Number(metres) || 0, 0), 70);
  const dm = Math.round(clamped * 10);
  if (!fromSlider) slider.value = (dm / 10).toFixed(1);
  levelBox.value = (dm / 10).toFixed(1);
  if (dm === seaLevelDm) return;
  seaLevelDm = dm;
  // While dragging, repaint at most every 150 ms.
  if (repaintTimer) return;
  repaintTimer = setTimeout(() => {
    repaintTimer = null;
    repaintWater();
  }, 150);
}

slider.addEventListener("input", () => setSeaLevel(slider.value, { fromSlider: true }));
levelBox.addEventListener("change", () => setSeaLevel(levelBox.value));
levelBox.addEventListener("keydown", (event) => {
  if (event.key === "Enter") setSeaLevel(levelBox.value);
});

fetch(`${FLOOD_URL}meta.json`)
  .then((response) => {
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  })
  .then((meta) => {
    floodMeta = meta;
    floodProvider = makeFloodProvider(meta);
    repaintWater();
    floodStatus.textContent = "Flooding is worked out for Washington to Baja California.";
  })
  .catch(() => {
    slider.disabled = true;
    levelBox.disabled = true;
    floodStatus.textContent = "Flood data isn't available yet.";
  });

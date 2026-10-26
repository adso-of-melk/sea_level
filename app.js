// Sea Level Globe: a 3D globe with real terrain and switchable map layers.

if (window.CESIUM_ION_TOKEN) {
  Cesium.Ion.defaultAccessToken = window.CESIUM_ION_TOKEN;
}

// Start (and the home button) over the US west coast.
Cesium.Camera.DEFAULT_VIEW_RECTANGLE = Cesium.Rectangle.fromDegrees(...window.START_VIEW);
Cesium.Camera.DEFAULT_VIEW_FACTOR = 0;

const terrain = Cesium.Terrain.fromWorldTerrain();

const viewer = new Cesium.Viewer("globe", {
  terrain,
  baseLayer: false,
  baseLayerPicker: false,
  animation: false,
  timeline: false,
  sceneModePicker: false,
  fullscreenButton: false,
  geocoder: true,
  homeButton: true,
  navigationHelpButton: true,
  navigationInstructionsInitiallyVisible: false,
});

// If world terrain can't load (for example a mistyped token), show a smooth
// globe instead of a black screen.
terrain.errorEvent.addEventListener((error) => {
  console.error("World terrain failed to load:", error);
  viewer.scene.terrainProvider = new Cesium.EllipsoidTerrainProvider();
});

const layers = viewer.imageryLayers;

// ---- Base maps -------------------------------------------------------------

const baseMaps = {
  relief: () =>
    new Cesium.ImageryLayer(
      new Cesium.UrlTemplateImageryProvider({
        url: "https://server.arcgisonline.com/ArcGIS/rest/services/Elevation/World_Hillshade/MapServer/tile/{z}/{y}/{x}",
        maximumLevel: 16,
        credit: "Hillshade: Esri, USGS, NOAA",
      })
    ),
  satellite: () =>
    Cesium.ImageryLayer.fromProviderAsync(Cesium.IonImageryProvider.fromAssetId(2)),
  plain: () =>
    Cesium.ImageryLayer.fromProviderAsync(
      Cesium.TileMapServiceImageryProvider.fromUrl(
        Cesium.buildModuleUrl("Assets/Textures/NaturalEarthII")
      )
    ),
};

let baseLayer = null;

function setBaseMap(name) {
  if (baseLayer) layers.remove(baseLayer, true);
  baseLayer = baseMaps[name]();
  layers.add(baseLayer, 0);
}

// ---- Overlays --------------------------------------------------------------

const roads = layers.addImageryProvider(
  new Cesium.UrlTemplateImageryProvider({
    url: "https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Transportation/MapServer/tile/{z}/{y}/{x}",
    maximumLevel: 18,
    credit: "Roads: Esri, HERE, Garmin",
  })
);

const cities = layers.addImageryProvider(
  new Cesium.UrlTemplateImageryProvider({
    url: "https://{s}.basemaps.cartocdn.com/light_only_labels/{z}/{x}/{y}.png",
    subdomains: ["a", "b", "c", "d"],
    maximumLevel: 18,
    credit: "Labels: © CARTO, © OpenStreetMap contributors",
  })
);

const borderStyle = { clampToGround: true, stroke: Cesium.Color.WHITE.withAlpha(0.85), strokeWidth: 2 };
const borders = Promise.all([
  Cesium.GeoJsonDataSource.load("data/borders-countries.geojson", borderStyle),
  Cesium.GeoJsonDataSource.load("data/borders-us-states.geojson", {
    ...borderStyle,
    stroke: Cesium.Color.WHITE.withAlpha(0.55),
    strokeWidth: 1.5,
  }),
]).then((sources) => {
  sources.forEach((source) => viewer.dataSources.add(source));
  return sources;
});

// ---- Controls --------------------------------------------------------------

function bindCheckbox(id, apply) {
  const box = document.getElementById(id);
  box.addEventListener("change", () => apply(box.checked));
  apply(box.checked);
}

document.querySelectorAll('input[name="base"]').forEach((radio) => {
  radio.addEventListener("change", () => setBaseMap(radio.value));
});
setBaseMap(document.querySelector('input[name="base"]:checked').value);

bindCheckbox("show-roads", (on) => (roads.show = on));
bindCheckbox("show-cities", (on) => (cities.show = on));
bindCheckbox("show-borders", (on) =>
  borders.then((sources) => sources.forEach((source) => (source.show = on)))
);

const panel = document.getElementById("panel");
const panelToggle = document.getElementById("panel-toggle");
panelToggle.addEventListener("click", () => {
  const collapsed = panel.classList.toggle("collapsed");
  panelToggle.setAttribute("aria-expanded", String(!collapsed));
});
if (window.matchMedia("(max-width: 600px)").matches) panelToggle.click();

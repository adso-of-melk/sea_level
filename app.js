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

// City names from Natural Earth. Bigger places (lower rank) show from further
// away, so zooming in brings in smaller towns.
function visibleBelow(rank) {
  if (rank <= 1) return 2.0e7;
  if (rank <= 3) return 6.0e6;
  if (rank <= 4) return 3.0e6;
  if (rank <= 6) return 1.5e6;
  if (rank <= 7) return 8.0e5;
  return 4.0e5;
}

const cityLabels = viewer.scene.primitives.add(new Cesium.LabelCollection({ scene: viewer.scene }));
const cityDots = viewer.scene.primitives.add(new Cesium.BillboardCollection({ scene: viewer.scene }));

function dotImage(size) {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size + 2;
  const context = canvas.getContext("2d");
  context.beginPath();
  context.arc(size / 2 + 1, size / 2 + 1, size / 2, 0, 2 * Math.PI);
  context.fillStyle = "#ffffff";
  context.strokeStyle = "#000000";
  context.fill();
  context.stroke();
  return canvas;
}
// Names sit on the ground. Pulling them a little toward the viewer, and not
// letting nearby hills hide them when zoomed in, keeps them readable, while
// names on the far side of the globe stay hidden behind it.
const nudgeToward = new Cesium.Cartesian3(0, 0, -500);
const CLOSE_UP = 2.0e5;

const bigDot = dotImage(7);
const smallDot = dotImage(5);

// Each entry: { position, rank, reach, width, height, label, dot }, most
// important first.
const cityList = [];

fetch("data/places.json")
  .then((response) => response.json())
  .then((places) => {
    for (const [name, lon, lat, rank] of places) {
      const position = Cesium.Cartesian3.fromDegrees(lon, lat);
      const reach = visibleBelow(rank);
      const shownWithin = new Cesium.DistanceDisplayCondition(0, reach);
      const fontPx = rank <= 3 ? 15 : 13;
      const dot = cityDots.add({
        position,
        image: rank <= 3 ? bigDot : smallDot,
        heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
        distanceDisplayCondition: shownWithin,
        eyeOffset: nudgeToward,
        disableDepthTestDistance: CLOSE_UP,
      });
      const label = cityLabels.add({
        position,
        text: name,
        font: rank <= 3 ? "600 15px system-ui, sans-serif" : "13px system-ui, sans-serif",
        fillColor: Cesium.Color.WHITE,
        outlineColor: Cesium.Color.BLACK.withAlpha(0.85),
        outlineWidth: 3,
        style: Cesium.LabelStyle.FILL_AND_OUTLINE,
        pixelOffset: new Cesium.Cartesian2(0, -8),
        verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
        heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
        distanceDisplayCondition: shownWithin,
        eyeOffset: nudgeToward,
        disableDepthTestDistance: CLOSE_UP,
      });
      cityList.push({ position, reach, label, dot, width: name.length * fontPx * 0.6, height: fontPx + 4 });
    }
    declutterCities();
  });

// When the view stops moving, hide names that would overlap a more important
// one. Places are sorted by importance, so the first to claim a spot keeps it.
const screenSpot = new Cesium.Cartesian2();
function declutterCities() {
  const camera = viewer.camera;
  const scene = viewer.scene;
  const horizon = new Cesium.EllipsoidalOccluder(Cesium.Ellipsoid.WGS84, camera.positionWC);
  const taken = [];
  for (const city of cityList) {
    let show = Cesium.Cartesian3.distance(camera.positionWC, city.position) <= city.reach &&
      horizon.isPointVisible(city.position) &&
      scene.cartesianToCanvasCoordinates(city.position, screenSpot) !== undefined;
    if (show) {
      const box = {
        left: screenSpot.x - city.width / 2,
        right: screenSpot.x + city.width / 2,
        top: screenSpot.y - 8 - city.height,
        bottom: screenSpot.y + 4,
      };
      show = !taken.some((other) =>
        box.left < other.right && box.right > other.left && box.top < other.bottom && box.bottom > other.top
      );
      if (show) taken.push(box);
    }
    city.label.show = show;
    city.dot.show = show;
  }
}
viewer.camera.moveEnd.addEventListener(declutterCities);

viewer.creditDisplay.addStaticCredit(new Cesium.Credit("City names: Natural Earth"));

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
bindCheckbox("show-cities", (on) => {
  cityLabels.show = on;
  cityDots.show = on;
});
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

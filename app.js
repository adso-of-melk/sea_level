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

// Rivers, streams and lakes from the USGS National Hydrography Dataset, more
// of them the closer you zoom. It covers the US only.
const water = layers.addImageryProvider(
  new Cesium.UrlTemplateImageryProvider({
    url: "https://basemap.nationalmap.gov/arcgis/rest/services/USGSHydroCached/MapServer/tile/{z}/{y}/{x}",
    maximumLevel: 16,
    credit: "Rivers and lakes: USGS National Hydrography Dataset",
  })
);

// Watershed boundaries (the drainage divides between river basins) from the
// USGS Watershed Boundary Dataset, US only. Each level of detail, from large
// regions down to small subwatersheds, shows over its own range of zoom. The
// service is asked to draw them as brown dotted lines, thinner for smaller
// watersheds, and without its code labels.
const WATERSHEDS = "https://hydro.nationalmap.gov/arcgis/rest/services/wbd/MapServer";
const watershedLevels = [
  // [service layer, shown from scale, shown to scale, line width]
  [1, 110000000, 0, 2.8],
  [2, 13866974, 8000000, 2.6],
  [3, 8000000, 2000000, 2.4],
  [4, 2000000, 866686, 2.2],
  [5, 866687, 433343, 2.0],
  [6, 433346, 0, 1.8],
];
const watershedStyle = watershedLevels.map(([id, minScale, maxScale, width]) => ({
  id,
  source: { type: "mapLayer", mapLayerId: id },
  minScale,
  maxScale,
  drawingInfo: {
    renderer: {
      type: "simple",
      symbol: {
        type: "esriSFS",
        style: "esriSFSNull",
        outline: { type: "esriSLS", style: "esriSLSDot", color: [120, 80, 45, 230], width },
      },
    },
    showLabels: false,
  },
}));
const watersheds = layers.addImageryProvider(
  new Cesium.UrlTemplateImageryProvider({
    url:
      `${WATERSHEDS}/export?bbox={westProjected},{southProjected},{eastProjected},{northProjected}` +
      "&bboxSR=3857&imageSR=3857&size=256,256&format=png32&transparent=true&f=image" +
      `&dynamicLayers=${encodeURIComponent(JSON.stringify(watershedStyle))}`,
    credit: "Watersheds: USGS Watershed Boundary Dataset",
  })
);
watersheds.show = false;

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

function dotImage(size, fill = "#ffffff") {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size + 2;
  const context = canvas.getContext("2d");
  context.beginPath();
  context.arc(size / 2 + 1, size / 2 + 1, size / 2, 0, 2 * Math.PI);
  context.fillStyle = fill;
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

// Natural springs from the USGS Geographic Names Information System, loaded
// the first time the layer is switched on. Dots show within a few hundred
// kilometres and names only close up, never on top of each other. There are
// thousands of springs, so each dot and name is made only once the view first
// comes near it.
const SPRING_DOTS_WITHIN = 3.0e5;
const SPRING_NAMES_WITHIN = 4.0e4;
const springDots = viewer.scene.primitives.add(new Cesium.BillboardCollection({ scene: viewer.scene }));
const springLabels = viewer.scene.primitives.add(new Cesium.LabelCollection({ scene: viewer.scene }));
const springDotsWithin = new Cesium.DistanceDisplayCondition(0, SPRING_DOTS_WITHIN);
const springNamesWithin = new Cesium.DistanceDisplayCondition(0, SPRING_NAMES_WITHIN);
const coldSpringDot = dotImage(6, "#4fc3f7");
const hotSpringDot = dotImage(6, "#ff8a50");
// Each entry: { position, name, hot, width, height, dot, label }.
const springList = [];
let springsRequested = false;

function loadSprings() {
  if (springsRequested) return;
  springsRequested = true;
  fetch("data/springs.json")
    .then((response) => response.json())
    .then((springs) => {
      for (const [name, lon, lat, hot] of springs) {
        const position = Cesium.Cartesian3.fromDegrees(lon, lat);
        springList.push({ position, name, hot, width: name.length * 12 * 0.6, height: 16, dot: null, label: null });
      }
      updateSprings();
    });
}

function addSpringDot(spring) {
  spring.dot = springDots.add({
    position: spring.position,
    image: spring.hot ? hotSpringDot : coldSpringDot,
    heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
    distanceDisplayCondition: springDotsWithin,
    eyeOffset: nudgeToward,
    disableDepthTestDistance: CLOSE_UP,
  });
}

function springLabel(spring) {
  spring.label ??= springLabels.add({
    position: spring.position,
    text: spring.name,
    font: "12px system-ui, sans-serif",
    fillColor: Cesium.Color.fromCssColorString(spring.hot ? "#ffd0b8" : "#d4f1fd"),
    outlineColor: Cesium.Color.BLACK.withAlpha(0.85),
    outlineWidth: 3,
    style: Cesium.LabelStyle.FILL_AND_OUTLINE,
    pixelOffset: new Cesium.Cartesian2(0, -6),
    verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
    heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
    distanceDisplayCondition: springNamesWithin,
    eyeOffset: nudgeToward,
    disableDepthTestDistance: CLOSE_UP,
  });
  return spring.label;
}

// Once the view settles: add dots for springs that have come into range, and
// show each nearby spring's name unless it would overlap one already placed.
function updateSprings() {
  if (!springDots.show) return;
  const camera = viewer.camera;
  const horizon = new Cesium.EllipsoidalOccluder(Cesium.Ellipsoid.WGS84, camera.positionWC);
  const taken = [];
  for (const spring of springList) {
    const distance = Cesium.Cartesian3.distance(camera.positionWC, spring.position);
    if (!spring.dot && distance <= SPRING_DOTS_WITHIN) addSpringDot(spring);
    let show = distance <= SPRING_NAMES_WITHIN &&
      horizon.isPointVisible(spring.position) &&
      viewer.scene.cartesianToCanvasCoordinates(spring.position, screenSpot) !== undefined;
    if (show) {
      const box = {
        left: screenSpot.x - spring.width / 2,
        right: screenSpot.x + spring.width / 2,
        top: screenSpot.y - 6 - spring.height,
        bottom: screenSpot.y + 4,
      };
      show = !taken.some((other) =>
        box.left < other.right && box.right > other.left && box.top < other.bottom && box.bottom > other.top
      );
      if (show) taken.push(box);
    }
    if (show) springLabel(spring).show = true;
    else if (spring.label) spring.label.show = false;
  }
}
viewer.camera.moveEnd.addEventListener(updateSprings);

viewer.creditDisplay.addStaticCredit(new Cesium.Credit("Springs: USGS GNIS"));

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

bindCheckbox("show-water", (on) => (water.show = on));
bindCheckbox("show-watersheds", (on) => (watersheds.show = on));
bindCheckbox("show-roads", (on) => (roads.show = on));
bindCheckbox("show-cities", (on) => {
  cityLabels.show = on;
  cityDots.show = on;
});
bindCheckbox("show-springs", (on) => {
  springDots.show = on;
  springLabels.show = on;
  if (on) {
    loadSprings();
    updateSprings();
  }
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
// Start with the options hidden on phones and tablets, where they would cover
// much of the map. The title button brings them back.
if (window.matchMedia("(max-width: 900px), (max-height: 600px)").matches) panelToggle.click();

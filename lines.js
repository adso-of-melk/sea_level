// My lines: draw your own lines (borders, routes, notes) on the map and keep
// them.
//
// Lines are kept in this browser straight away. If a GitHub token is set up
// on this device (see "Keep lines on all my devices" in the panel), they are
// also saved as lines.geojson in a private GitHub repository, so every device
// with the token sees the same lines.

const LINES_KEY = "consonance-lines";
const LINES_UNSAVED_KEY = "consonance-lines-unsynced";
const TOKEN_KEY = "consonance-github-token";
const LINES_FILE = "lines.geojson";
const DEFAULT_COLOR = "#ffcc33";

// Each line: { id, name, color, points: [[lon, lat], ...] }.
let myLines = [];

const linesSource = new Cesium.CustomDataSource("my-lines");
viewer.dataSources.add(linesSource);

const linesList = document.getElementById("lines-list");
const linesStatus = document.getElementById("lines-status");
const drawButton = document.getElementById("draw-line");
const drawBar = document.getElementById("draw-bar");
const drawHint = document.getElementById("draw-hint");

// ---- Drawing lines on the map ----------------------------------------------

function lineMiddle(points) {
  const half = (points.length - 1) / 2;
  const a = points[Math.floor(half)];
  const b = points[Math.ceil(half)];
  return Cesium.Cartesian3.fromDegrees((a[0] + b[0]) / 2, (a[1] + b[1]) / 2);
}

function drawLine(line) {
  linesSource.entities.removeById(line.id);
  linesSource.entities.removeById(line.id + "-name");
  const color = Cesium.Color.fromCssColorString(line.color);
  linesSource.entities.add({
    id: line.id,
    polyline: {
      positions: Cesium.Cartesian3.fromDegreesArray(line.points.flat()),
      clampToGround: true,
      width: 3,
      material: color,
    },
  });
  if (line.name) {
    linesSource.entities.add({
      id: line.id + "-name",
      position: lineMiddle(line.points),
      label: {
        text: line.name,
        font: "600 14px system-ui, sans-serif",
        fillColor: color.brighten(0.4, new Cesium.Color()),
        outlineColor: Cesium.Color.BLACK.withAlpha(0.85),
        outlineWidth: 3,
        style: Cesium.LabelStyle.FILL_AND_OUTLINE,
        pixelOffset: new Cesium.Cartesian2(0, -6),
        verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
        heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
        distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, 3.0e6),
        disableDepthTestDistance: 2.0e5,
      },
    });
  }
}

function eraseLine(line) {
  linesSource.entities.removeById(line.id);
  linesSource.entities.removeById(line.id + "-name");
}

// ---- Drawing a new line ------------------------------------------------------

let drawing = null; // { points: [[lon, lat]], hover: Cartesian3 | null, dots: [] }
const drawHandler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);

// Double-clicking the map normally flies to whatever is under the cursor.
viewer.cesiumWidget.screenSpaceEventHandler.removeInputAction(
  Cesium.ScreenSpaceEventType.LEFT_DOUBLE_CLICK
);

function groundAt(screenPosition) {
  const ray = viewer.camera.getPickRay(screenPosition);
  return ray && viewer.scene.globe.pick(ray, viewer.scene);
}

function drawnPositions(withHover) {
  const positions = drawing.points.map(([lon, lat]) => Cesium.Cartesian3.fromDegrees(lon, lat));
  if (withHover && drawing.hover) positions.push(drawing.hover);
  return positions;
}

const preview = linesSource.entities.add({
  show: false,
  polyline: {
    positions: new Cesium.CallbackProperty(() => (drawing ? drawnPositions(true) : []), false),
    clampToGround: true,
    width: 3,
    material: new Cesium.PolylineDashMaterialProperty({ color: Cesium.Color.fromCssColorString(DEFAULT_COLOR) }),
  },
});

function updateDrawHint() {
  const count = drawing.points.length;
  drawHint.textContent =
    count === 0
      ? "Click or tap the map to place the first point."
      : count === 1
        ? "Keep placing points along the line."
        : `${count} points. Double-click, or press Finish, to end the line.`;
  document.getElementById("draw-undo").disabled = count === 0;
  document.getElementById("draw-finish").disabled = count < 2;
  preview.show = count + (drawing.hover ? 1 : 0) >= 2;
}

function addPoint(cartesian) {
  const spot = Cesium.Cartographic.fromCartesian(cartesian);
  drawing.points.push([Cesium.Math.toDegrees(spot.longitude), Cesium.Math.toDegrees(spot.latitude)]);
  drawing.dots.push(
    linesSource.entities.add({
      position: Cesium.Cartesian3.fromDegrees(...drawing.points.at(-1)),
      point: {
        pixelSize: 7,
        color: Cesium.Color.fromCssColorString(DEFAULT_COLOR),
        outlineColor: Cesium.Color.BLACK,
        outlineWidth: 1,
        heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
    })
  );
  updateDrawHint();
}

function undoPoint() {
  if (!drawing || drawing.points.length === 0) return;
  drawing.points.pop();
  linesSource.entities.remove(drawing.dots.pop());
  updateDrawHint();
}

function startDrawing() {
  if (drawing) return;
  drawing = { points: [], hover: null, dots: [] };
  drawButton.hidden = true;
  drawBar.hidden = false;
  viewer.scene.canvas.style.cursor = "crosshair";
  updateDrawHint();
}

function stopDrawing() {
  drawing.dots.forEach((dot) => linesSource.entities.remove(dot));
  const points = drawing.points;
  drawing = null;
  preview.show = false;
  drawButton.hidden = false;
  drawBar.hidden = true;
  viewer.scene.canvas.style.cursor = "";
  return points;
}

function finishDrawing() {
  if (!drawing || drawing.points.length < 2) return;
  const points = stopDrawing();
  const line = {
    id: "line-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    name: "",
    color: DEFAULT_COLOR,
    points: points.map(([lon, lat]) => [+lon.toFixed(6), +lat.toFixed(6)]),
  };
  myLines.push(line);
  drawLine(line);
  saveLines();
  showLinesList();
  // Ask for a name straight away; leaving it empty is fine.
  linesList.querySelector(`[data-id="${line.id}"] .line-name`)?.focus();
}

drawHandler.setInputAction((click) => {
  if (!drawing) return;
  const spot = groundAt(click.position);
  if (spot) addPoint(spot);
}, Cesium.ScreenSpaceEventType.LEFT_CLICK);

drawHandler.setInputAction(() => {
  if (!drawing) return;
  // The two clicks of a double-click each placed a point; keep only one.
  if (drawing.points.length > 2) undoPoint();
  finishDrawing();
}, Cesium.ScreenSpaceEventType.LEFT_DOUBLE_CLICK);

drawHandler.setInputAction((move) => {
  if (!drawing) return;
  drawing.hover = groundAt(move.endPosition) || null;
  preview.show = drawing.points.length >= 1 && drawing.points.length + (drawing.hover ? 1 : 0) >= 2;
}, Cesium.ScreenSpaceEventType.MOUSE_MOVE);

// Clicking a line while drawing shouldn't open its info box.
viewer.selectedEntityChanged.addEventListener((entity) => {
  if (entity && (drawing || entity.entityCollection === linesSource.entities)) {
    viewer.selectedEntity = undefined;
  }
});

drawButton.addEventListener("click", startDrawing);
document.getElementById("draw-undo").addEventListener("click", undoPoint);
document.getElementById("draw-finish").addEventListener("click", finishDrawing);
document.getElementById("draw-cancel").addEventListener("click", () => drawing && stopDrawing());
document.addEventListener("keydown", (event) => {
  if (!drawing || event.target.closest("input, textarea")) return;
  if (event.key === "Escape") stopDrawing();
  else if (event.key === "Enter") finishDrawing();
  else if (event.key === "Backspace" || (event.key === "z" && (event.ctrlKey || event.metaKey))) {
    event.preventDefault();
    undoPoint();
  }
});

// ---- The list of lines in the panel -------------------------------------------

function zoomToLine(line) {
  const lons = line.points.map((p) => p[0]);
  const lats = line.points.map((p) => p[1]);
  const pad = 0.15 * Math.max(Math.max(...lons) - Math.min(...lons), Math.max(...lats) - Math.min(...lats), 0.05);
  viewer.camera.flyTo({
    destination: Cesium.Rectangle.fromDegrees(
      Math.min(...lons) - pad, Math.min(...lats) - pad, Math.max(...lons) + pad, Math.max(...lats) + pad
    ),
  });
}

function showLinesList() {
  linesList.replaceChildren();
  for (const line of myLines) {
    const row = document.createElement("li");
    row.dataset.id = line.id;

    const color = document.createElement("input");
    color.type = "color";
    color.value = line.color;
    color.title = "Line colour";
    color.addEventListener("input", () => {
      line.color = color.value;
      drawLine(line);
    });
    color.addEventListener("change", saveLines);

    const name = document.createElement("input");
    name.type = "text";
    name.className = "line-name";
    name.value = line.name;
    name.placeholder = "Unnamed line";
    name.setAttribute("aria-label", "Line name");
    name.addEventListener("change", () => {
      line.name = name.value.trim();
      drawLine(line);
      saveLines();
    });
    name.addEventListener("keydown", (event) => event.key === "Enter" && name.blur());

    const go = document.createElement("button");
    go.type = "button";
    go.textContent = "Go";
    go.title = "Fly to this line";
    go.addEventListener("click", () => zoomToLine(line));

    const remove = document.createElement("button");
    remove.type = "button";
    remove.textContent = "✕";
    remove.title = "Delete this line";
    remove.setAttribute("aria-label", "Delete this line");
    remove.addEventListener("click", () => {
      // Two presses delete, so one slip doesn't lose a line.
      if (!remove.classList.contains("confirm")) {
        remove.classList.add("confirm");
        remove.textContent = "Delete?";
        setTimeout(() => {
          remove.classList.remove("confirm");
          remove.textContent = "✕";
        }, 3000);
        return;
      }
      myLines = myLines.filter((other) => other !== line);
      eraseLine(line);
      saveLines();
      showLinesList();
    });

    row.append(color, name, go, remove);
    linesList.append(row);
  }
  document.getElementById("lines-empty").hidden = myLines.length > 0;
}

// ---- Saving ----------------------------------------------------------------

function linesAsGeoJson() {
  return {
    type: "FeatureCollection",
    features: myLines.map((line) => ({
      type: "Feature",
      id: line.id,
      properties: { name: line.name, color: line.color },
      geometry: { type: "LineString", coordinates: line.points },
    })),
  };
}

function linesFromGeoJson(data) {
  const lines = [];
  for (const feature of data?.features || []) {
    const geometry = feature.geometry || {};
    const parts =
      geometry.type === "LineString" ? [geometry.coordinates]
      : geometry.type === "MultiLineString" ? geometry.coordinates
      : [];
    for (const coordinates of parts) {
      if (!Array.isArray(coordinates) || coordinates.length < 2) continue;
      lines.push({
        id: String(feature.id || "line-" + Math.random().toString(36).slice(2, 10)),
        name: String(feature.properties?.name || ""),
        color: /^#[0-9a-f]{6}$/i.test(feature.properties?.color) ? feature.properties.color : DEFAULT_COLOR,
        points: coordinates.map(([lon, lat]) => [+lon, +lat]),
      });
    }
  }
  return lines;
}

function storeGet(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}
function storeSet(key, value) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch { /* private window: nothing is kept */ }
}

function setStatus(text) {
  linesStatus.textContent = text;
}

let syncTimer = null;

function saveLines() {
  storeSet(LINES_KEY, JSON.stringify(linesAsGeoJson()));
  if (!githubReady()) {
    setStatus(myLines.length ? "Saved in this browser." : "");
    return;
  }
  storeSet(LINES_UNSAVED_KEY, "1");
  setStatus("Saving to GitHub…");
  clearTimeout(syncTimer);
  syncTimer = setTimeout(uploadLines, 1500);
}

// ---- Keeping lines on GitHub ---------------------------------------------------

const linesRepo = window.LINES_REPO || "";
let remoteSha = null; // the version of lines.geojson on GitHub we last saw

function githubReady() {
  return Boolean(linesRepo && storeGet(TOKEN_KEY));
}

function github(path, options = {}) {
  return fetch(`https://api.github.com/repos/${linesRepo}/contents/${path}`, {
    ...options,
    cache: "no-store",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${storeGet(TOKEN_KEY)}`,
      ...(options.body ? { "Content-Type": "application/json" } : {}),
    },
  });
}

function toBase64(text) {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

function fromBase64(base64) {
  const binary = atob(base64.replace(/\s/g, ""));
  return new TextDecoder().decode(Uint8Array.from(binary, (c) => c.charCodeAt(0)));
}

function explainGithubError(status) {
  if (status === 401) return "GitHub didn't accept the token. It may have expired: set up a new one below.";
  if (status === 403 || status === 404) {
    return `GitHub couldn't find ${linesRepo}, or the token isn't allowed to change it.`;
  }
  return `GitHub had a problem (error ${status}).`;
}

// Returns { lines, sha } from GitHub, or { lines: null } if there's no file yet.
async function downloadLines() {
  const response = await github(LINES_FILE);
  if (response.status === 404) {
    // Either no file yet (fine) or no access to the repository at all.
    const repo = await fetch(`https://api.github.com/repos/${linesRepo}`, {
      headers: { Authorization: `Bearer ${storeGet(TOKEN_KEY)}` },
    });
    if (!repo.ok) throw new Error(explainGithubError(repo.status));
    return { lines: null, sha: null };
  }
  if (!response.ok) throw new Error(explainGithubError(response.status));
  const file = await response.json();
  return { lines: linesFromGeoJson(JSON.parse(fromBase64(file.content))), sha: file.sha };
}

async function uploadLines(retry = true) {
  clearTimeout(syncTimer);
  const body = {
    message: `Update lines (${myLines.length})`,
    content: toBase64(JSON.stringify(linesAsGeoJson(), null, 1) + "\n"),
    ...(remoteSha ? { sha: remoteSha } : {}),
  };
  let response;
  try {
    response = await github(LINES_FILE, { method: "PUT", body: JSON.stringify(body) });
  } catch {
    setStatus("Couldn't reach GitHub. Saved in this browser; it will try again on the next change or reload.");
    return;
  }
  if ((response.status === 409 || response.status === 422) && retry) {
    // Our idea of the file's version was out of date; this device's lines win.
    try {
      remoteSha = (await downloadLines()).sha;
    } catch { /* reported by the retry */ }
    return uploadLines(false);
  }
  if (!response.ok) {
    setStatus(explainGithubError(response.status) + " Saved in this browser only.");
    return;
  }
  remoteSha = (await response.json()).content.sha;
  storeSet(LINES_UNSAVED_KEY, null);
  setStatus("Saved to GitHub.");
}

// ---- Starting up ---------------------------------------------------------------

function useLines(lines) {
  myLines.forEach(eraseLine);
  myLines = lines;
  myLines.forEach(drawLine);
  showLinesList();
}

// With merge set (just after a token is entered), lines drawn in this browser
// are added to the ones already on GitHub instead of being replaced by them.
async function loadLines(merge = false) {
  const local = linesFromGeoJson(JSON.parse(storeGet(LINES_KEY) || "null"));
  useLines(local);
  if (!githubReady()) {
    setStatus(local.length ? "Saved in this browser." : "");
    showSyncState();
    return;
  }
  setStatus("Loading lines from GitHub…");
  try {
    const remote = await downloadLines();
    remoteSha = remote.sha;
    const remoteIds = new Set((remote.lines || []).map((line) => line.id));
    const localOnly = local.filter((line) => !remoteIds.has(line.id));
    if (merge && remote.lines && localOnly.length) {
      useLines([...remote.lines, ...localOnly]);
      storeSet(LINES_KEY, JSON.stringify(linesAsGeoJson()));
      await uploadLines();
    } else if (storeGet(LINES_UNSAVED_KEY) || (remote.lines === null && local.length)) {
      // This device has changes GitHub hasn't got yet: send them.
      await uploadLines();
    } else {
      useLines(remote.lines || []);
      storeSet(LINES_KEY, JSON.stringify(linesAsGeoJson()));
      setStatus("Up to date with GitHub.");
    }
  } catch (error) {
    setStatus(error.message + " Showing the lines saved in this browser.");
  }
  showSyncState();
}

// ---- Panel: sync set-up, backup file -----------------------------------------------

const tokenBox = document.getElementById("github-token");

function showSyncState() {
  const ready = githubReady();
  document.getElementById("sync-on").hidden = !ready;
  document.getElementById("sync-off").hidden = ready;
  document.getElementById("sync-repo").textContent = linesRepo || "(not set in config.js)";
}

document.getElementById("save-token").addEventListener("click", () => {
  const token = tokenBox.value.trim();
  if (!token) return;
  storeSet(TOKEN_KEY, token);
  tokenBox.value = "";
  // Lines already drawn in this browser are added to the ones on GitHub.
  loadLines(true);
});

document.getElementById("forget-token").addEventListener("click", () => {
  storeSet(TOKEN_KEY, null);
  storeSet(LINES_UNSAVED_KEY, null);
  remoteSha = null;
  setStatus("This device no longer saves to GitHub. Lines stay in this browser.");
  showSyncState();
});

document.getElementById("download-lines").addEventListener("click", () => {
  const blob = new Blob([JSON.stringify(linesAsGeoJson(), null, 1)], { type: "application/geo+json" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = `my-lines-${new Date().toISOString().slice(0, 10)}.geojson`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
});

document.getElementById("load-lines").addEventListener("change", async (event) => {
  const file = event.target.files[0];
  event.target.value = "";
  if (!file) return;
  try {
    const known = new Set(myLines.map((line) => line.id));
    const added = linesFromGeoJson(JSON.parse(await file.text())).filter((line) => !known.has(line.id));
    myLines.push(...added);
    added.forEach(drawLine);
    showLinesList();
    saveLines();
    if (!githubReady()) setStatus(`Added ${added.length} line${added.length === 1 ? "" : "s"} from the file.`);
  } catch {
    setStatus("That file couldn't be read as a lines file.");
  }
});

bindCheckbox("show-lines", (on) => (linesSource.show = on));

loadLines();

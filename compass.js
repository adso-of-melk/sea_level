// Compass: shows which way is north, and turns the view.
// Drag the dial to rotate the map, click it to face north again,
// or use the turn buttons beneath it.

const TURN_STEP = Cesium.Math.toRadians(15);

// Turns the view by `radians` around the point at the centre of the screen.
// Positive turns clockwise, like turning your head to the right.
function turnView(radians) {
  const scene = viewer.scene;
  const camera = viewer.camera;
  const center = new Cesium.Cartesian2(scene.canvas.clientWidth / 2, scene.canvas.clientHeight / 2);
  const ray = camera.getPickRay(center);
  const target = ray && scene.globe.pick(ray, scene);

  if (!target) {
    // Looking at the sky: turn on the spot instead.
    camera.setView({
      orientation: { heading: camera.heading + radians, pitch: camera.pitch, roll: camera.roll },
    });
    return;
  }

  camera.lookAtTransform(Cesium.Transforms.eastNorthUpToFixedFrame(target));
  camera.rotateLeft(radians);
  camera.lookAtTransform(Cesium.Matrix4.IDENTITY);
}

// Wraps an angle into the range -pi..pi so we always turn the short way.
function shortestTurn(radians) {
  return Cesium.Math.negativePiToPi(radians);
}

// Turning around a point away from the camera shifts the camera's own heading
// slightly less than the turn, so a second small correction lands on north.
function faceNorth() {
  turnView(shortestTurn(-viewer.camera.heading));
  turnView(shortestTurn(-viewer.camera.heading));
}

const dial = document.getElementById("compass-dial");
const rose = document.getElementById("compass-rose");

// Keep the rose pointing at north as the view turns.
let shownHeading = null;
viewer.scene.postRender.addEventListener(() => {
  const degrees = Math.round(Cesium.Math.toDegrees(viewer.camera.heading) * 10) / 10;
  if (degrees === shownHeading) return;
  shownHeading = degrees;
  rose.setAttribute("transform", `rotate(${-degrees} 32 32)`);
  dial.title = `Facing ${Math.round(degrees) % 360}° · drag to turn, click to face north`;
});

// Dragging around the dial turns the map so north follows your pointer.
let drag = null;

function pointerAngle(event) {
  const box = dial.getBoundingClientRect();
  return Math.atan2(event.clientY - (box.top + box.height / 2), event.clientX - (box.left + box.width / 2));
}

dial.addEventListener("pointerdown", (event) => {
  dial.setPointerCapture(event.pointerId);
  drag = { angle: pointerAngle(event), turned: 0 };
});

dial.addEventListener("pointermove", (event) => {
  if (!drag) return;
  const angle = pointerAngle(event);
  const delta = shortestTurn(angle - drag.angle);
  drag.angle = angle;
  drag.turned += Math.abs(delta);
  turnView(-delta);
});

dial.addEventListener("pointerup", () => {
  // A click with almost no movement means "face north".
  if (drag && drag.turned < Cesium.Math.toRadians(3)) faceNorth();
  drag = null;
});

dial.addEventListener("pointercancel", () => (drag = null));

// Keyboard users: Enter or Space on the dial faces north.
dial.addEventListener("keydown", (event) => {
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    faceNorth();
  }
});

document.getElementById("turn-left").addEventListener("click", () => turnView(-TURN_STEP));
document.getElementById("turn-right").addEventListener("click", () => turnView(TURN_STEP));

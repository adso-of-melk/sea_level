// Builds the border line files in data/ from the world-atlas and us-atlas packages.
// Run from a folder where those packages and topojson-client are installed:
//   node make_borders.mjs <node_modules dir> <output dir>
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";

const [modules, out] = process.argv.slice(2);
const require = createRequire(join(modules, "x.js"));
const { mesh } = require("topojson-client");

// Keep 4 decimals (about 10 m), plenty for lines drawn on a globe.
const round = (geom) => ({
  type: geom.type,
  coordinates: geom.coordinates.map((line) =>
    line.map(([x, y]) => [+x.toFixed(4), +y.toFixed(4)])
  ),
});

function write(name, topoPath, object) {
  const topo = JSON.parse(readFileSync(join(modules, topoPath), "utf8"));
  // a !== b keeps only shared edges, so coastlines are left out.
  const lines = round(mesh(topo, topo.objects[object], (a, b) => a !== b));
  const geojson = { type: "Feature", properties: {}, geometry: lines };
  writeFileSync(join(out, name), JSON.stringify(geojson));
  console.log(name, lines.coordinates.length, "lines");
}

write("borders-countries.geojson", "world-atlas/countries-50m.json", "countries");
write("borders-us-states.geojson", "us-atlas/states-10m.json", "states");

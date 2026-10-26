// Builds data/places.json, the city names layer, from Natural Earth's
// "populated places (simple)" GeoJSON (public domain):
//   https://github.com/nvkelso/natural-earth-vector/blob/master/geojson/ne_10m_populated_places_simple.geojson
// Usage: node make_places.mjs <that file> <output file>
// Each entry is [name, longitude, latitude, scalerank]; a lower scalerank is a
// more important place, shown from further away.
import { readFileSync, writeFileSync } from "node:fs";

const [source, out] = process.argv.slice(2);
const places = JSON.parse(readFileSync(source, "utf8"))
  .features.map(({ properties: p }) => [p.name.replace(/\s+/g, " ").trim(), +p.longitude.toFixed(4), +p.latitude.toFixed(4), p.scalerank])
  .sort((a, b) => a[3] - b[3]);
writeFileSync(out, JSON.stringify(places));
console.log(places.length, "places");

// Builds data/springs.json, the natural springs layer, from the USGS
// Geographic Names Information System (public domain), one text file per state:
//   https://prd-tnm.s3.amazonaws.com/StagedProducts/GeographicNames/DomesticNames/DomesticNames_CA_Text.zip
// Usage: node make_springs.mjs <output file> <DomesticNames_XX.txt>...
// Only springs inside the flood map area (Washington to Baja California) are
// kept. Each entry is [name, longitude, latitude, hot]; hot is 1 for hot and warm
// springs.
import { readFileSync, writeFileSync } from "node:fs";

const [WEST, SOUTH, EAST, NORTH] = [-125, 31, -114, 49];

const [out, ...sources] = process.argv.slice(2);
const springs = [];
for (const source of sources) {
  const [header, ...rows] = readFileSync(source, "utf8").replace(/^﻿/, "").split(/\r?\n/);
  const column = Object.fromEntries(header.split("|").map((name, i) => [name, i]));
  for (const row of rows) {
    const cells = row.split("|");
    if (cells[column.feature_class] !== "Spring") continue;
    const lat = +cells[column.prim_lat_dec];
    const lon = +cells[column.prim_long_dec];
    if (!lat || !lon) continue; // no location recorded
    if (lon < WEST || lon > EAST || lat < SOUTH || lat > NORTH) continue;
    const name = cells[column.feature_name].replace(/\s+/g, " ").trim();
    springs.push([name, +lon.toFixed(4), +lat.toFixed(4), /\b(hot|warm|boiling)\b/i.test(name) ? 1 : 0]);
  }
}
writeFileSync(out, JSON.stringify(springs));
console.log(springs.length, "springs,", springs.filter((s) => s[3]).length, "hot");

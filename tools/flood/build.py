"""Builds the flood map tiles behind the sea level slider.

For every spot on the map this works out its "flood level": the lowest sea
level at which ocean water can reach it without passing over higher ground.
Death Valley, for example, is below today's sea level but stays dry until the
sea is high enough to spill over the mountains around it.

Steps:
  1. Load elevation in 1-degree tiles. Inside the US this is the USGS 3DEP
     bare-earth model (1/3 arc-second, about 10 m), which leaves out trees and
     buildings. Each 3 x 3 block of its cells keeps its highest point, so
     levees and sea walls survive the step down to 1 arc-second. Elsewhere,
     and wherever 3DEP has gaps, Copernicus GLO-30 (about 30 m) fills in.
     Missing Copernicus tiles are open ocean. Tiles that are entirely above
     the highest slider level can never flood, so they are not kept in memory.
  2. Measure every height from mean higher high water (the average daily high
     tide), the zero used by NOAA's sea level rise viewer. The local gap
     between that tide level and each model's zero comes from NOAA tide
     stations along the coast, blended smoothly between them.
  3. Spread water inland from the ocean, always taking the lowest reachable
     ground next (the Priority-Flood algorithm with one bucket per 10 cm).
     Water moves only north, south, east and west, never diagonally, so it
     cannot slip through a one-cell gap in a ridge.
  4. Cut the result into 256 x 256 PNG map tiles for the app. Each pixel holds
     the flood level in decimetres (red * 256 + green) and the ground height
     in half metres from -50 m (blue). 65535 means "never floods here".

Usage:
  python build.py --out site/flood                       # real data
  python build.py --source-dir dem/ --usgs-dir usgs/ --tide-datum none \
                  --out site/flood                       # local GeoTIFFs
"""

import argparse
import json
import os
import sys
import tempfile
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import date
from pathlib import Path

import numpy as np
import rasterio
from numba import njit
from numba.typed import List
from PIL import Image
from rasterio.windows import from_bounds

CELLS = 3600            # cells along each side of a 1-degree source tile
MAX_DM = 700            # highest slider level: 70 m, in decimetres
ABOVE_MAX = MAX_DM + 1  # elevation stored for anything that can never flood
LOW_DM = -1000          # elevations below -100 m are stored as -100 m
OCEAN_TILE = -2
HIGH_TILE = -1
NEVER = 65535           # tile pixel value: never floods within the slider range
# Ground the sea already covers at high tide is drawn as water from level 0
# if it is no more than this far below high tide (beaches, mudflats, marsh).
# Anything deeper is open water, which the base map already shows.
TIDAL_LAND_DM = -5

# US west coast, Baja California to Washington, plus the head of the Gulf of
# California (the Salton basin connects to the sea through it).
DEFAULT_BOUNDS = (-125, 31, -114, 49)  # west, south, east, north

COPERNICUS = "https://copernicus-dem-30m.s3.amazonaws.com"
USGS = "https://prd-tnm.s3.amazonaws.com/StagedProducts/Elevation/13/TIFF/current"

# Bare-earth data is fetched for tiles whose Copernicus low point is below
# this, since trees and buildings can hide lower ground underneath.
USGS_BELOW_DM = MAX_DM + 100

# NOAA tide stations used to place mean higher high water: id -> (lat, lon).
TIDE_STATIONS = {
    "9410170": (32.714, -117.174),  # San Diego
    "9410660": (33.720, -118.272),  # Los Angeles
    "9412110": (35.169, -120.754),  # Port San Luis
    "9413450": (36.605, -121.888),  # Monterey
    "9414290": (37.807, -122.465),  # San Francisco
    "9415020": (37.996, -122.977),  # Point Reyes
    "9416841": (38.915, -123.711),  # Arena Cove
    "9418767": (40.767, -124.217),  # North Spit, Humboldt Bay
    "9419750": (41.745, -124.184),  # Crescent City
    "9431647": (42.739, -124.498),  # Port Orford
    "9435380": (44.625, -124.043),  # South Beach, Newport
    "9439040": (46.207, -123.768),  # Astoria
    "9440910": (46.708, -123.967),  # Toke Point
    "9443090": (48.368, -124.617),  # Neah Bay
    "9444900": (48.112, -122.760),  # Port Townsend
    "9447130": (47.603, -122.339),  # Seattle
}
DATUM_API = "https://api.tidesandcurrents.noaa.gov/mdapi/prod/webapi/stations/{}/datums.json?units=metric"
# Typical west coast gaps, used only if the tide stations can't be reached.
FALLBACK_MHHW_ABOVE_NAVD88 = 1.9
FALLBACK_MHHW_ABOVE_MSL = 0.9

# Places reported at the end so a run can be checked at a glance.
CHECK_PLACES = {
    "San Francisco airport": (37.6213, -122.3790),
    "Sacramento": (38.5816, -121.4944),
    "Sacramento-San Joaquin Delta": (38.0500, -121.6000),
    "Long Beach": (33.7701, -118.1937),
    "Mexicali": (32.6245, -115.4523),
    "Salton Sea shore": (33.3500, -115.8500),
    "Death Valley, Badwater": (36.2297, -116.7678),
    "Seattle, Sodo": (47.5800, -122.3350),
}


# ---- 1. Elevation -----------------------------------------------------------

def tile_name(lat, lon):
    ns = "N" if lat >= 0 else "S"
    ew = "E" if lon >= 0 else "W"
    return f"Copernicus_DSM_COG_10_{ns}{abs(lat):02d}_00_{ew}{abs(lon):03d}_00_DEM"


def usgs_name(lat, lon):
    """3DEP tiles are named by their north-west corner."""
    return f"USGS_13_n{lat + 1:02d}w{-lon:03d}"


def _exists(url):
    """True if the URL is there, False if not, retrying network trouble."""
    for attempt in range(5):
        try:
            urllib.request.urlopen(urllib.request.Request(url, method="HEAD"), timeout=60)
            return True
        except urllib.error.HTTPError as error:
            if error.code in (403, 404):
                return False
            failure = error
        except urllib.error.URLError as error:
            failure = error
        time.sleep(2 ** attempt)
    raise RuntimeError(f"Could not reach {url}: {failure}")


def tile_location(lat, lon, source_dir):
    """Path or URL of a Copernicus tile, or None if there is none (open ocean)."""
    name = tile_name(lat, lon)
    if source_dir:
        path = Path(source_dir) / f"{name}.tif"
        return str(path) if path.exists() else None
    url = f"{COPERNICUS}/{name}/{name}.tif"
    return "/vsicurl/" + url if _exists(url) else None


def _download(url, path):
    for attempt in range(5):
        try:
            with urllib.request.urlopen(url, timeout=120) as response, open(path, "wb") as out:
                while chunk := response.read(1 << 22):
                    out.write(chunk)
            return
        except (urllib.error.URLError, OSError) as error:
            failure = error
            time.sleep(2 ** attempt)
    raise RuntimeError(f"Could not download {url}: {failure}")


def max_pool(metres, factor):
    """Shrinks a grid by factor, each new cell keeping the highest of the cells
    it covers. Gaps (NaN) are skipped unless the whole block is a gap."""
    n = metres.shape[0] // factor
    blocks = metres.reshape(n, factor, n, factor)
    return np.fmax.reduce(np.fmax.reduce(blocks, axis=3), axis=1)


def _resize(metres):
    """Brings any square grid to CELLS x CELLS: finer grids are max-pooled,
    anything else is resampled to the nearest cell."""
    size = metres.shape[0]
    if metres.shape[0] == metres.shape[1] and size % CELLS == 0:
        return max_pool(metres, size // CELLS) if size > CELLS else metres
    rows = np.arange(CELLS) * metres.shape[0] // CELLS
    cols = np.arange(CELLS) * metres.shape[1] // CELLS
    return metres[rows][:, cols]


def read_tile(location):
    """Reads one Copernicus tile in metres, CELLS x CELLS, north row first."""
    with rasterio.open(location) as src:
        metres = src.read(1, masked=True).astype(np.float32)
    # No-data cells (rare, mostly at the coast) are treated as sea level water.
    return _resize(metres.filled(-0.1))


def read_usgs(lat, lon, usgs_dir):
    """Reads the 3DEP bare-earth tile covering this 1-degree square in metres,
    CELLS x CELLS, with NaN where it has no data. None if there is no tile."""
    name = usgs_name(lat, lon)
    if usgs_dir:
        path = Path(usgs_dir) / f"{name}.tif"
        return _read_usgs_file(path, lat, lon) if path.exists() else None
    url = f"{USGS}/{name[8:]}/{name}.tif"
    if not _exists(url):
        return None
    handle, path = tempfile.mkstemp(suffix=".tif")
    os.close(handle)
    try:
        _download(url, path)
        return _read_usgs_file(path, lat, lon)
    finally:
        os.remove(path)


def _read_usgs_file(path, lat, lon):
    with rasterio.open(path) as src:
        window = from_bounds(lon, lat, lon + 1, lat + 1, src.transform).round_offsets().round_lengths()
        metres = src.read(1, window=window, masked=True, boundless=True).astype(np.float32)
    metres = metres.filled(np.nan)
    metres[metres < -1000] = np.nan  # stray no-data markers
    return _resize(metres)


# ---- Tide datum ---------------------------------------------------------------

def _datum_values(payload):
    """Pulls {name: metres} out of a NOAA datums reply, whichever shape it has."""
    values = {}
    for item in payload.get("datums") or []:
        name = item.get("name") or item.get("n")
        value = item.get("value", item.get("v"))
        try:
            values[str(name).upper()] = float(value)
        except (TypeError, ValueError):
            pass
    return values


def fetch_tide_gaps():
    """Returns {station: (lat, lon, MHHW above NAVD88, MHHW above MSL)} in
    metres for the tide stations that answer. Either gap may be None."""
    gaps = {}
    for station, (lat, lon) in TIDE_STATIONS.items():
        try:
            with urllib.request.urlopen(DATUM_API.format(station), timeout=60) as response:
                values = _datum_values(json.load(response))
        except (urllib.error.URLError, OSError, ValueError) as error:
            print(f"  tide station {station}: no answer ({error})", flush=True)
            continue
        mhhw = values.get("MHHW")
        if mhhw is None:
            continue
        navd = values.get("NAVD88")
        msl = values.get("MSL")
        gaps[station] = (lat, lon, None if navd is None else mhhw - navd, None if msl is None else mhhw - msl)
        print(f"  tide station {station}: MHHW is " +
              ", ".join(f"{gap:.2f} m above {name}" for name, gap in
                        (("NAVD88", gaps[station][2]), ("MSL", gaps[station][3])) if gap is not None),
              flush=True)
    return gaps


class TideDatum:
    """How far mean higher high water sits above each model's zero: NAVD88 for
    3DEP and mean sea level (taken as the EGM2008 geoid) for Copernicus.
    Between stations the gap is blended by inverse distance."""

    def __init__(self, gaps=None, fallback=(0.0, 0.0)):
        self.points = {"navd88": [], "msl": []}
        for lat, lon, navd, msl in (gaps or {}).values():
            if navd is not None:
                self.points["navd88"].append((lat, lon, navd))
            if msl is not None:
                self.points["msl"].append((lat, lon, msl))
        self.fallback = {"navd88": fallback[0], "msl": fallback[1]}

    @classmethod
    def from_noaa(cls):
        datum = cls(fetch_tide_gaps(), (FALLBACK_MHHW_ABOVE_NAVD88, FALLBACK_MHHW_ABOVE_MSL))
        for kind, points in datum.points.items():
            if len(points) < 5:
                print(f"WARNING: only {len(points)} tide stations give MHHW above {kind}; "
                      f"using {datum.fallback[kind]} m everywhere instead", flush=True)
                points.clear()
        return datum

    def gap_at(self, kind, lat, lon):
        points = self.points[kind]
        if not points:
            return self.fallback[kind]
        lats, lons, gaps = (np.array(column) for column in zip(*points))
        dist = np.hypot(lats - lat, (lons - lon) * np.cos(np.radians(lat))) + 1e-6
        weights = dist ** -2
        return float((weights * gaps).sum() / weights.sum())

    def gap_grid(self, kind, lat, lon):
        """The gap across one 1-degree tile, CELLS x CELLS, north row first,
        blended from its corners so neighbouring tiles meet without a step."""
        nw, ne = self.gap_at(kind, lat + 1, lon), self.gap_at(kind, lat + 1, lon + 1)
        sw, se = self.gap_at(kind, lat, lon), self.gap_at(kind, lat, lon + 1)
        t = ((np.arange(CELLS) + 0.5) / CELLS).astype(np.float32)
        north = nw + (ne - nw) * t
        south = sw + (se - sw) * t
        return north[None, :] + (south - north)[None, :] * t[:, None]

    def describe(self):
        return {kind: (f"{len(points)} NOAA tide stations" if points else f"{self.fallback[kind]} m everywhere")
                for kind, points in self.points.items()}


# ---- Loading ----------------------------------------------------------------

def load_tile(lat, lon, source_dir, usgs_dir, datum):
    """One tile in decimetres above MHHW, or OCEAN_TILE / HIGH_TILE.
    Also says whether bare-earth data was used."""
    location = tile_location(lat, lon, source_dir)
    if location is None:
        return OCEAN_TILE, False
    metres = read_tile(location)
    if metres.min() * 10 > USGS_BELOW_DM:
        return HIGH_TILE, False
    metres = metres - datum.gap_grid("msl", lat, lon)
    bare = read_usgs(lat, lon, usgs_dir) if usgs_dir is not False else None
    if bare is not None:
        bare = bare - datum.gap_grid("navd88", lat, lon)
        metres = np.where(np.isnan(bare), metres, bare)
    dm = np.clip(np.round(metres * 10), LOW_DM, ABOVE_MAX).astype(np.int16)
    if dm.min() > MAX_DM:
        return HIGH_TILE, bare is not None
    return dm, bare is not None


def load_elevation(bounds, source_dir, usgs_dir=False, datum=None, workers=1):
    """Returns (tile_index, elevation): tile_index[row, col] is a slot in
    elevation, OCEAN_TILE or HIGH_TILE. Row 0 is the northernmost tile.
    usgs_dir: a folder of 3DEP tiles, None to fetch them, False to skip them."""
    datum = datum or TideDatum()
    west, south, east, north = bounds
    rows, cols = north - south, east - west
    tile_index = np.full((rows, cols), OCEAN_TILE, np.int32)
    kept = []
    bare_tiles = 0
    with ThreadPoolExecutor(workers) as pool:
        for row in range(rows):
            lat = north - 1 - row
            loads = pool.map(lambda col: load_tile(lat, west + col, source_dir, usgs_dir, datum), range(cols))
            for col, (dm, bare) in enumerate(loads):
                bare_tiles += bare
                if isinstance(dm, int):
                    tile_index[row, col] = dm
                    continue
                tile_index[row, col] = len(kept)
                kept.append(dm)
            print(f"  elevation row {row + 1}/{rows}: {len(kept)} low tiles kept, "
                  f"{bare_tiles} with bare-earth data", flush=True)
    elevation = np.stack(kept) if kept else np.zeros((0, CELLS, CELLS), np.int16)
    return tile_index, elevation


# ---- 2. Flooding ------------------------------------------------------------

@njit(cache=True)
def _push(buckets, sizes, level, cell):
    queue = buckets[level]
    if sizes[level] == queue.shape[0]:
        bigger = np.empty(queue.shape[0] * 2, np.uint32)
        bigger[: queue.shape[0]] = queue
        buckets[level] = bigger
        queue = bigger
    queue[sizes[level]] = cell
    sizes[level] += 1


@njit(cache=True)
def _flood(elevation, flood_level, tile_index, seeds, seed_levels):
    tile_rows, tile_cols = tile_index.shape
    total_rows, total_cols = tile_rows * CELLS, tile_cols * CELLS

    buckets = List()
    for _ in range(MAX_DM + 1):
        buckets.append(np.empty(1024, np.uint32))
    sizes = np.zeros(MAX_DM + 1, np.int64)

    for i in range(seeds.shape[0]):
        cell = seeds[i]
        r, c = cell // total_cols, cell % total_cols
        slot = tile_index[r // CELLS, c // CELLS]
        local_r, local_c = r % CELLS, c % CELLS
        if flood_level[slot, local_r, local_c] >= 0:
            continue
        flood_level[slot, local_r, local_c] = seed_levels[i]
        _push(buckets, sizes, seed_levels[i], np.uint32(cell))

    d_rows = (-1, 1, 0, 0)
    d_cols = (0, 0, -1, 1)
    for level in range(MAX_DM + 1):
        i = 0
        while i < sizes[level]:
            cell = np.int64(buckets[level][i])
            i += 1
            r, c = cell // total_cols, cell % total_cols
            for k in range(4):
                nr, nc = r + d_rows[k], c + d_cols[k]
                if nr < 0 or nc < 0 or nr >= total_rows or nc >= total_cols:
                    continue
                slot = tile_index[nr // CELLS, nc // CELLS]
                if slot < 0:
                    continue
                local_r, local_c = nr % CELLS, nc % CELLS
                if flood_level[slot, local_r, local_c] >= 0:
                    continue
                ground = elevation[slot, local_r, local_c]
                if ground > MAX_DM:
                    continue
                reached = max(level, ground)
                flood_level[slot, local_r, local_c] = reached
                _push(buckets, sizes, reached, np.uint32(nr * total_cols + nc))
        buckets[level] = np.empty(0, np.uint32)


def find_seeds(tile_index, elevation):
    """Cells where the sea comes in: every low cell along an edge that touches
    an ocean tile, and sea cells (at or below 0 m) along the outer edge."""
    tile_rows, tile_cols = tile_index.shape
    total_cols = tile_cols * CELLS
    edge = np.arange(CELLS, dtype=np.int64)
    seeds, levels = [], []

    def neighbour(row, col):
        if 0 <= row < tile_rows and 0 <= col < tile_cols:
            return tile_index[row, col]
        return None  # outside the area we loaded

    for row in range(tile_rows):
        for col in range(tile_cols):
            slot = tile_index[row, col]
            if slot < 0:
                continue
            sides = {
                "north": (neighbour(row - 1, col), np.zeros(CELLS, np.int64), edge),
                "south": (neighbour(row + 1, col), np.full(CELLS, CELLS - 1, np.int64), edge),
                "west": (neighbour(row, col - 1), edge, np.zeros(CELLS, np.int64)),
                "east": (neighbour(row, col + 1), edge, np.full(CELLS, CELLS - 1, np.int64)),
            }
            for beside, local_r, local_c in sides.values():
                ground = elevation[slot, local_r, local_c].astype(np.int64)
                if beside == OCEAN_TILE:
                    use = ground <= MAX_DM
                elif beside is None:
                    use = ground <= 0
                else:
                    continue
                cells = (row * CELLS + local_r[use]) * total_cols + col * CELLS + local_c[use]
                seeds.append(cells)
                levels.append(np.maximum(ground[use], 0))

    if not seeds:
        return np.zeros(0, np.int64), np.zeros(0, np.int64)
    return np.concatenate(seeds), np.concatenate(levels)


def compute_flood_levels(tile_index, elevation):
    tile_rows, tile_cols = tile_index.shape
    if tile_rows * CELLS * tile_cols * CELLS >= 2 ** 32:
        raise ValueError("Area too large: cell numbers must fit in 32 bits")
    flood_level = np.full(elevation.shape, -1, np.int16)
    seeds, seed_levels = find_seeds(tile_index, elevation)
    _flood(elevation, flood_level, tile_index, seeds, seed_levels)
    return flood_level


# ---- 3. Map tiles -----------------------------------------------------------

@njit(cache=True)
def _sample(elevation, flood_level, tile_index, rows, cols, k, out_level, out_ground):
    """Fills one 256 x 256 map tile. Each pixel takes the lowest flood level
    among k x k sample points, so small low spots stay visible when zoomed out."""
    tile_rows, tile_cols = tile_index.shape
    total_rows, total_cols = tile_rows * CELLS, tile_cols * CELLS
    found = False
    for y in range(256):
        for x in range(256):
            best = NEVER
            best_ground = 0
            for sy in range(k):
                r = rows[y * k + sy]
                if r < 0 or r >= total_rows:
                    continue
                for sx in range(k):
                    c = cols[x * k + sx]
                    if c < 0 or c >= total_cols:
                        continue
                    slot = tile_index[r // CELLS, c // CELLS]
                    if slot < 0:
                        continue
                    level = flood_level[slot, r % CELLS, c % CELLS]
                    ground = elevation[slot, r % CELLS, c % CELLS]
                    if level < 0 or (level == 0 and ground < TIDAL_LAND_DM):
                        continue
                    if level < best:
                        best = level
                        best_ground = ground
            out_level[y, x] = best
            out_ground[y, x] = min(255, max(0, (best_ground + 500) // 5))
            if best != NEVER:
                found = True
    return found


def write_tiles(tile_index, elevation, flood_level, bounds, out, min_zoom, max_zoom):
    west, south, east, north = bounds
    out = Path(out)
    rows_low, cols_low = np.nonzero(tile_index >= 0)
    counts = {}
    for zoom in range(max_zoom, min_zoom - 1, -1):
        size = 180 / 2 ** zoom  # degrees per map tile (Cesium geographic tiling)
        pixel_arcsec = size * 3600 / 256
        k = int(min(8, max(1, round(pixel_arcsec))))
        offsets = (np.arange(256 * k) + 0.5) / (256 * k)
        written = 0
        # Only map tiles over a low source tile can hold anything.
        candidates = set()
        for row, col in zip(rows_low, cols_low):
            tile_west, tile_north = west + col, north - row
            for x in range(int((tile_west + 180) // size), int((tile_west + 1 + 180 - 1e-9) // size) + 1):
                for y in range(int((90 - tile_north) // size), int((90 - tile_north + 1 - 1e-9) // size) + 1):
                    candidates.add((x, y))
        level_px = np.empty((256, 256), np.uint16)
        ground_px = np.empty((256, 256), np.uint8)
        for x, y in sorted(candidates):
            lons = -180 + (x + offsets) * size
            lats = 90 - (y + offsets) * size
            cols = np.floor((lons - west) * CELLS).astype(np.int64)
            rows = np.floor((north - lats) * CELLS).astype(np.int64)
            if not _sample(elevation, flood_level, tile_index, rows, cols, k, level_px, ground_px):
                continue
            rgb = np.dstack([(level_px >> 8).astype(np.uint8), (level_px & 255).astype(np.uint8), ground_px])
            path = out / str(zoom) / str(x) / f"{y}.png"
            path.parent.mkdir(parents=True, exist_ok=True)
            Image.fromarray(rgb, "RGB").save(path, optimize=True)
            written += 1
        counts[zoom] = written
        print(f"  zoom {zoom}: {written} tiles", flush=True)
    return counts


# ---- Report -----------------------------------------------------------------

def flood_level_at(lat, lon, tile_index, flood_level, bounds):
    west, south, east, north = bounds
    r, c = int((north - lat) * CELLS), int((lon - west) * CELLS)
    if not (0 <= r < tile_index.shape[0] * CELLS and 0 <= c < tile_index.shape[1] * CELLS):
        return None
    slot = tile_index[r // CELLS, c // CELLS]
    if slot < 0:
        return None
    level = flood_level[slot, r % CELLS, c % CELLS]
    return None if level < 0 else level / 10


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--out", required=True, help="folder for the map tiles")
    parser.add_argument("--source-dir", help="read Copernicus GeoTIFF tiles from here instead of the internet")
    parser.add_argument("--usgs-dir", help="read 3DEP GeoTIFF tiles from here (with --source-dir, none are used otherwise)")
    parser.add_argument("--tide-datum", choices=["mhhw", "none"], default="mhhw",
                        help="measure heights from high tide (mhhw) or leave them as the models give them")
    parser.add_argument("--workers", type=int, default=4, help="tiles loaded at the same time")
    parser.add_argument("--bounds", type=int, nargs=4, default=DEFAULT_BOUNDS,
                        metavar=("WEST", "SOUTH", "EAST", "NORTH"), help="whole degrees")
    parser.add_argument("--min-zoom", type=int, default=4)
    parser.add_argument("--max-zoom", type=int, default=11)
    args = parser.parse_args(argv)
    bounds = tuple(args.bounds)

    started = time.time()
    if args.tide_datum == "mhhw":
        print("Reading tide levels", flush=True)
        datum = TideDatum.from_noaa()
    else:
        datum = TideDatum()
    usgs_dir = args.usgs_dir or (False if args.source_dir else None)
    print("Loading elevation", flush=True)
    tile_index, elevation = load_elevation(bounds, args.source_dir, usgs_dir, datum, args.workers)
    print(f"Flooding {elevation.shape[0]} low tiles", flush=True)
    flood_level = compute_flood_levels(tile_index, elevation)
    print("Writing map tiles", flush=True)
    counts = write_tiles(tile_index, elevation, flood_level, bounds, args.out, args.min_zoom, args.max_zoom)

    print("Flood levels at check places:")
    report = {}
    for place, (lat, lon) in CHECK_PLACES.items():
        level = flood_level_at(lat, lon, tile_index, flood_level, bounds)
        report[place] = level
        print(f"  {place}: " + ("never within 70 m" if level is None else f"{level:.1f} m"))

    meta = {
        "version": 1,
        "built": date.today().isoformat(),
        "source": "USGS 3DEP 1/3 arc-second bare earth (highest of each 3 x 3), "
                  "filled in with Copernicus GLO-30 (1 arc-second)",
        "zero": ("mean higher high water" if args.tide_datum == "mhhw" else "model datums (NAVD88 / EGM2008)"),
        "tideGaps": datum.describe(),
        "bounds": list(bounds),
        "minZoom": args.min_zoom,
        "maxZoom": args.max_zoom,
        "maxLevelDm": MAX_DM,
        "never": NEVER,
        "ground": {"offsetM": -50, "stepM": 0.5},
        "tiles": counts,
        "checks": report,
    }
    Path(args.out).mkdir(parents=True, exist_ok=True)
    (Path(args.out) / "meta.json").write_text(json.dumps(meta, indent=2))
    print(f"Done in {time.time() - started:.0f} s")


if __name__ == "__main__":
    sys.exit(main())

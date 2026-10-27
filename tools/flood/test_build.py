"""Checks the flood calculation on made-up terrain.

Run with:  python -m pytest tools/flood
"""

import json

import numpy as np
import pytest
import rasterio
from rasterio.transform import from_origin

import build

BOUNDS = (-2, 0, 0, 2)  # 2 x 2 one-degree tiles


def write_tile(folder, lat, lon, metres):
    path = folder / f"{build.tile_name(lat, lon)}.tif"
    profile = dict(driver="GTiff", width=build.CELLS, height=build.CELLS, count=1, dtype="float32",
                   crs="EPSG:4326", transform=from_origin(lon, lat + 1, 1 / 3600, 1 / 3600), compress="deflate")
    with rasterio.open(path, "w", **profile) as dst:
        dst.write(metres.astype(np.float32), 1)


@pytest.fixture(scope="module")
def built(tmp_path_factory):
    """North-west tile: missing, so open ocean.
    North-east tile: a 5 m plain beside the ocean, holding
      - a basin at -20 m behind a 30 m ridge,
      - a 1 m pocket behind a 40 m ridge whose only opening is diagonal.
    South-west tile: all 100 m, too high to ever flood.
    South-east tile: a 2 m strip reachable only through the north-east
      plain, and an 80 m hill."""
    folder = tmp_path_factory.mktemp("dem")
    n = build.CELLS

    ne = np.full((n, n), 5.0)
    ne[1000:1201, 1000:1201] = 30.0
    ne[1001:1200, 1001:1200] = -20.0
    ne[99:112, 99:112] = 40.0
    ne[100:111, 100:111] = 1.0
    ne[99, 99] = 5.0  # corner of the ridge is open, but only diagonally
    write_tile(folder, 1, -1, ne)

    write_tile(folder, 0, -2, np.full((n, n), 100.0))

    se = np.full((n, n), 80.0)
    se[:, 2000:2400] = 2.0
    write_tile(folder, 0, -1, se)

    tile_index, elevation = build.load_elevation(BOUNDS, str(folder))
    flood_level = build.compute_flood_levels(tile_index, elevation)
    out = tmp_path_factory.mktemp("tiles")
    counts = build.write_tiles(tile_index, elevation, flood_level, BOUNDS, out, 8, 11)
    return tile_index, flood_level, out, counts


def level_at(built, lat, lon):
    tile_index, flood_level, _, _ = built
    return build.flood_level_at(lat, lon, tile_index, flood_level, BOUNDS)


def cell(row, col, tile_lat=1, tile_lon=-1):
    """Centre of a cell in a source tile, as (lat, lon)."""
    return tile_lat + 1 - (row + 0.5) / 3600, tile_lon + (col + 0.5) / 3600


def test_tiles_are_sorted(built):
    tile_index = built[0]
    assert tile_index[0, 0] == build.OCEAN_TILE
    assert tile_index[1, 0] == build.HIGH_TILE
    assert tile_index[0, 1] >= 0 and tile_index[1, 1] >= 0


def test_plain_beside_ocean_floods_at_its_height(built):
    assert level_at(built, *cell(3000, 3000)) == pytest.approx(5.0)


def test_basin_below_sea_level_waits_for_its_ridge(built):
    assert level_at(built, *cell(1100, 1100)) == pytest.approx(30.0)


def test_water_cannot_slip_through_a_diagonal_gap(built):
    assert level_at(built, *cell(105, 105)) == pytest.approx(40.0)


def test_water_crosses_tile_edges(built):
    # The 2 m strip is only reachable over the 5 m plain to the north.
    assert level_at(built, *cell(1800, 2200, tile_lat=0)) == pytest.approx(5.0)


def test_high_ground_never_floods(built):
    assert level_at(built, *cell(1800, 100, tile_lat=0)) is None
    assert level_at(built, 0.5, -1.5) is None


def test_tiles_encode_level_and_ground(built):
    _, _, out, counts = built
    assert counts[11] > 0
    # Find the zoom 11 tile over the basin and decode its middle pixel.
    lat, lon = cell(1100, 1100)
    size = 180 / 2 ** 11
    x, y = int((lon + 180) // size), int((90 - lat) // size)
    px = int(((lon + 180) / size - x) * 256)
    py = int(((90 - lat) / size - y) * 256)
    with rasterio.open(out / "11" / str(x) / f"{y}.png") as png:
        r, g, b = (band[py, px] for band in png.read())
    assert int(r) * 256 + int(g) == 300          # 30.0 m flood level
    assert int(b) * 0.5 - 50 == pytest.approx(-20.0)  # ground height


def test_meta_written_by_main(tmp_path):
    folder = tmp_path / "dem"
    folder.mkdir()
    land = np.full((build.CELLS, build.CELLS), 3.0)
    land[:, :50] = 0.0  # sea along the west edge of the area
    write_tile(folder, 0, -1, land)
    build.main(["--source-dir", str(folder), "--out", str(tmp_path / "out"),
                "--bounds", "-1", "0", "0", "1", "--min-zoom", "10", "--max-zoom", "10",
                "--tide-datum", "none"])
    meta = json.loads((tmp_path / "out" / "meta.json").read_text())
    assert meta["maxLevelDm"] == 700 and meta["tiles"]["10"] > 0


# ---- Bare earth and tide datum ------------------------------------------------

def write_usgs_tile(folder, lat, lon, metres, overlap=6):
    """A 3DEP-style tile: named by its north-west corner, with a few cells of
    overlap all round and -999999 where there is no data."""
    n = metres.shape[0] + 2 * overlap
    padded = np.full((n, n), -999999.0, np.float32)
    padded[overlap:-overlap, overlap:-overlap] = np.where(np.isnan(metres), -999999.0, metres)
    step = 1 / metres.shape[0]
    profile = dict(driver="GTiff", width=n, height=n, count=1, dtype="float32", nodata=-999999.0,
                   crs="EPSG:4269", transform=from_origin(lon - overlap * step, lat + 1 + overlap * step, step, step))
    with rasterio.open(folder / f"{build.usgs_name(lat, lon)}.tif", "w", **profile) as dst:
        dst.write(padded, 1)


def test_max_pool_keeps_narrow_levees_and_skips_gaps():
    grid = np.zeros((6, 6), np.float32)
    grid[:, 1] = 4.0          # a levee one cell wide
    grid[3:, 3:] = np.nan     # a gap in the data
    grid[5, 5] = 2.0
    pooled = build.max_pool(grid, 3)
    assert pooled.tolist() == [[4.0, 0.0], [4.0, 2.0]]


def test_bare_earth_replaces_surface_model_and_heights_start_at_high_tide(tmp_path):
    cop, usgs = tmp_path / "cop", tmp_path / "usgs"
    cop.mkdir()
    usgs.mkdir()
    write_tile(cop, 1, -1, np.full((build.CELLS, build.CELLS), 5.0))
    bare = np.full((build.CELLS, build.CELLS), 3.0, np.float32)
    bare[:, :1800] = np.nan  # 3DEP stops halfway across, say at a border
    write_usgs_tile(usgs, 1, -1, bare)

    gaps = {"a": (1.5, -0.5, 1.0, 0.5)}  # MHHW 1.0 m above NAVD88, 0.5 m above MSL
    datum = build.TideDatum(gaps)
    tile_index, elevation = build.load_elevation((-1, 1, 0, 2), str(cop), str(usgs), datum)
    tile = elevation[tile_index[0, 0]]
    assert tile[100, 100] == 45    # Copernicus 5.0 m - 0.5 m
    assert tile[100, 3000] == 20   # 3DEP 3.0 m - 1.0 m


def test_tide_gap_follows_stations_and_tiles_meet_smoothly():
    datum = build.TideDatum({"south": (32.0, -117.0, 1.6, 0.8), "north": (47.0, -122.0, 2.8, 1.4)})
    assert datum.gap_at("navd88", 32.0, -117.0) == pytest.approx(1.6, abs=1e-3)
    assert 1.6 < datum.gap_at("navd88", 40.0, -120.0) < 2.8
    west = datum.gap_grid("msl", 40, -121)
    east = datum.gap_grid("msl", 40, -120)
    assert abs(west[1800, -1] - east[1800, 0]) < 1e-3


def test_tide_gap_falls_back_without_stations():
    assert build.TideDatum(fallback=(1.9, 0.9)).gap_at("navd88", 40, -120) == 1.9


def test_noaa_datum_replies_are_read_in_either_shape():
    assert build._datum_values({"datums": [{"name": "MHHW", "value": 1.5}, {"name": "NAVD88", "value": None}]}) == {"MHHW": 1.5}
    assert build._datum_values({"datums": [{"n": "MSL", "v": "0.95"}]}) == {"MSL": 0.95}


def test_land_under_high_tide_is_drawn_but_open_water_is_not(tmp_path):
    folder = tmp_path / "dem"
    folder.mkdir()
    land = np.full((build.CELLS, build.CELLS), 3.0)
    land[:, :100] = -3.0      # open water
    land[:, 100:200] = -0.2   # a beach that high tide covers
    write_tile(folder, 0, -1, land)
    tile_index, elevation = build.load_elevation((-1, 0, 0, 1), str(folder))
    flood_level = build.compute_flood_levels(tile_index, elevation)
    out = tmp_path / "out"
    build.write_tiles(tile_index, elevation, flood_level, (-1, 0, 0, 1), out, 11, 11)

    def pixel(lat, lon):
        size = 180 / 2 ** 11
        x, y = int((lon + 180) // size), int((90 - lat) // size)
        px, py = int(((lon + 180) / size - x) * 256), int(((90 - lat) / size - y) * 256)
        with rasterio.open(out / "11" / str(x) / f"{y}.png") as png:
            r, g, _ = (band[py, px] for band in png.read())
        return int(r) * 256 + int(g)

    assert pixel(0.5, -1 + 150 / 3600) == 0
    assert pixel(0.5, -1 + 50 / 3600) == build.NEVER

"""Download Belarus road data and build a local walking OSRM graph."""

from __future__ import annotations

import argparse
import shutil
import subprocess
import sys
import urllib.request
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = PROJECT_ROOT / "data" / "osrm"
PBF_PATH = DATA_DIR / "belarus-latest.osm.pbf"
SOURCE_GRAPH_PATH = DATA_DIR / "belarus-latest.osrm"
OSRM_GRAPH_PATH = DATA_DIR / "belarus.osrm"
OSRM_IMAGE = "ghcr.io/project-osrm/osrm-backend:latest"
DEFAULT_SOURCE = "https://download.geofabrik.de/europe/belarus-latest.osm.pbf"


def download_pbf(url: str) -> None:
    partial_path = PBF_PATH.with_suffix(PBF_PATH.suffix + ".part")
    request = urllib.request.Request(url, headers={"User-Agent": "SmartCityGuide/1.0 (offline walking routes)"})
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    with urllib.request.urlopen(request, timeout=60) as response, partial_path.open("wb") as destination:
        total = int(response.headers.get("Content-Length", "0"))
        downloaded = 0
        while True:
            chunk = response.read(1024 * 1024)
            if not chunk:
                break
            destination.write(chunk)
            downloaded += len(chunk)
            if total:
                print(f"Downloaded {downloaded / total:.0%} ({downloaded / 1024 / 1024:.0f} MiB)", flush=True)
    partial_path.replace(PBF_PATH)


def run_osrm(*arguments: str) -> None:
    subprocess.run(
        [
            "docker", "run", "--rm", "-t", "-v", f"{DATA_DIR}:/data",
            OSRM_IMAGE, *arguments,
        ],
        check=True,
    )


def rename_osrm_graph() -> None:
    if SOURCE_GRAPH_PATH.exists() and SOURCE_GRAPH_PATH != OSRM_GRAPH_PATH:
        if OSRM_GRAPH_PATH.exists():
            OSRM_GRAPH_PATH.unlink()
        SOURCE_GRAPH_PATH.replace(OSRM_GRAPH_PATH)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-url", default=DEFAULT_SOURCE, help="OSM PBF URL (Geofabrik Belarus by default)")
    parser.add_argument("--skip-download", action="store_true", help="use an existing data/osrm/belarus-latest.osm.pbf")
    args = parser.parse_args()

    if not shutil.which("docker"):
        raise SystemExit("Docker is required to build the offline OSRM graph.")
    if not args.skip_download:
        print("Downloading OSM road extract; this can take several minutes and requires internet.", flush=True)
        download_pbf(args.source_url)
    if not PBF_PATH.is_file():
        raise SystemExit(f"Missing {PBF_PATH}")

    print("Extracting walking network…", flush=True)
    run_osrm("osrm-extract", "-p", "/opt/foot.lua", "/data/belarus-latest.osm.pbf")
    print("Partitioning offline network…", flush=True)
    run_osrm("osrm-partition", "/data/belarus-latest.osrm")
    print("Customizing offline network…", flush=True)
    run_osrm("osrm-customize", "/data/belarus-latest.osrm")
    rename_osrm_graph()
    if not OSRM_GRAPH_PATH.is_file():
        raise SystemExit(f"Offline OSRM graph was not created at {OSRM_GRAPH_PATH}")
    print(f"Offline walking graph ready at {OSRM_GRAPH_PATH}. Start it with: docker compose --profile offline-routing up -d routing")


if __name__ == "__main__":
    main()
"""Flet desktop client for the Smart City Guide."""

from __future__ import annotations

import json
import hashlib
import logging
import mimetypes
import os
import re
import shutil
import ssl
import struct
import subprocess
import threading
import time
import urllib.request
import zlib
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Dict, List, Optional
from urllib.parse import parse_qs, quote, urlencode, urlparse

import flet as ft

try:
    from .native_map import NativeMapWindow
except ImportError:
    from native_map import NativeMapWindow

try:
    from .storage import CITY_COORDINATES, LocalStore
except ImportError:
    from storage import CITY_COORDINATES, LocalStore


CATEGORIES = ["Архитектура", "Кафе", "Парки", "Музеи"]
LOG_PATH = Path(__file__).resolve().parent.parent / "data" / "client.log"
LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
logging.basicConfig(filename=LOG_PATH, level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
logger = logging.getLogger("smart-guide.client")
BLOCKED_OSM_TILE_SHA256 = "b02c44252dac5a5e820ecef1e9bf9200e9407c042df668a466a1aa81a9ecca7a"
EMPTY_TILE_SHA256 = "9e4b4fea4fd112a12fa8b1eb48c504dc6bfe80cc630b88835243f2cef1a7c8c7"


def fetch_route_json(url: str, timeout: int = 8) -> dict:
    request = urllib.request.Request(url, headers={"User-Agent": "SmartCityGuide/1.0 (route lookup)"})
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.URLError as error:
        if not url.startswith("https://") or not isinstance(error.reason, ssl.SSLError):
            raise
        curl = shutil.which("curl")
        if not curl:
            raise
        result = subprocess.run(
            [curl, "--fail", "--silent", "--show-error", "--max-time", str(timeout), "--proto", "=https", url],
            capture_output=True,
            text=True,
            timeout=timeout + 2,
            check=False,
        )
        if result.returncode:
            raise RuntimeError(f"HTTPS route fallback failed: {result.stderr.strip()}") from error
        return json.loads(result.stdout)


def find_commons_photo(place: dict) -> tuple[str, str]:
    """Find a Commons image for a place that has no photo in the local catalogue."""
    searches = []
    wikidata_id = str(place.get("wikidata_id") or "")
    if re.fullmatch(r"Q\d+", wikidata_id):
        searches.append(f"haswbstatement:P180={wikidata_id}")
    name = str(place.get("name") or "").strip()
    city = str(place.get("city") or "").strip()
    if name:
        searches.append(f'"{name}" {city} Belarus'.strip())

    for search in searches:
        parameters = urlencode({
            "action": "query",
            "generator": "search",
            "gsrsearch": search,
            "gsrnamespace": "6",
            "gsrlimit": "5",
            "prop": "imageinfo",
            "iiprop": "url|extmetadata",
            "iiurlwidth": "900",
            "format": "json",
        })
        request = urllib.request.Request(
            f"https://commons.wikimedia.org/w/api.php?{parameters}",
            headers={"User-Agent": "SmartCityGuide/1.0 (Wikimedia Commons image lookup)"},
        )
        try:
            with urllib.request.urlopen(request, timeout=6) as response:
                payload = json.loads(response.read().decode("utf-8"))
        except Exception as error:
            logger.info("Поиск фото для %s в Wikimedia Commons не удался: %s", name, error)
            continue

        pages = (payload.get("query") or {}).get("pages") or {}
        for page in pages.values():
            info = (page.get("imageinfo") or [{}])[0]
            mime = str(info.get("mime") or "")
            if not mime.startswith("image/") or mime in {"image/svg+xml", "image/gif"}:
                continue
            filename = str(page.get("title") or "").removeprefix("File:")
            if not filename:
                continue
            metadata = info.get("extmetadata") or {}
            license_name = re.sub(r"<[^>]*>", "", str((metadata.get("LicenseShortName") or {}).get("value") or ""))
            credit = f"Wikimedia Commons: {filename}"
            if license_name:
                credit += f" · {license_name}"
            source = f"https://commons.wikimedia.org/wiki/Special:Redirect/file/{quote(filename)}"
            return source, credit
    return "", ""


def generate_placeholder_tile(r: int = 223, g: int = 230, b: int = 220, a: int = 255) -> bytes:
    width = height = 256
    def chunk(tag: bytes, data: bytes) -> bytes:
        return struct.pack("!I", len(data)) + tag + data + struct.pack("!I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    rows = bytearray()
    for _ in range(height):
        rows.append(0)
        for _ in range(width):
            rows.extend((r, g, b, a))
    png = bytearray(b"\x89PNG\r\n\x1a\n")
    png += chunk(b"IHDR", struct.pack("!IIBBBBB", width, height, 8, 6, 0, 0, 0))
    png += chunk(b"IDAT", zlib.compress(bytes(rows), level=9))
    png += chunk(b"IEND", b"")
    return bytes(png)


def start_map_server(store: Optional[LocalStore] = None) -> ThreadingHTTPServer:
    directory = str(Path(__file__).resolve().parent)
    local_store = store or LocalStore()
    boundary_path = Path(directory).parent / "data" / "belarus-boundary.geojson"
    tile_cache = boundary_path.parent / "offline" / "tiles"
    offline_city_manifest = boundary_path.parent / "offline" / "cities.json"
    router_start_lock = threading.Lock()
    router_start_requested = False
    router_start_failed = False
    photo_lookup_misses: Dict[int, float] = {}

    def saved_offline_cities() -> list[str]:
        try:
            saved = json.loads(offline_city_manifest.read_text(encoding="utf-8"))
            allowed = set(local_store.get_cities())
            return [city for city in saved if isinstance(city, str) and city in allowed] if isinstance(saved, list) else []
        except (OSError, json.JSONDecodeError):
            return []

    def offline_router_ready() -> bool:
        try:
            url = "http://127.0.0.1:5000/nearest/v1/foot/27.56653,53.90019?number=1"
            with urllib.request.urlopen(url, timeout=1.5) as response:
                return json.loads(response.read().decode("utf-8")).get("code") == "Ok"
        except Exception:
            return False

    def ensure_offline_router() -> str:
        nonlocal router_start_requested, router_start_failed
        with router_start_lock:
            if router_start_requested:
                return "starting"
        if offline_router_ready():
            return "ready"
        with router_start_lock:
            if router_start_failed:
                return "unavailable"
        if not (boundary_path.parent / "osrm" / "belarus.osrm.properties").is_file():
            return "graph-missing"
        docker = shutil.which("docker")
        if not docker:
            return "docker-required"
        with router_start_lock:
            if router_start_failed:
                return "unavailable"
            if router_start_requested:
                return "starting"
            router_start_requested = True
            try:
                process = subprocess.Popen(
                    [docker, "compose", "--profile", "offline-routing", "up", "-d", "routing"],
                    cwd=boundary_path.parent.parent,
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                    start_new_session=True,
                )
                def monitor_router_start() -> None:
                    nonlocal router_start_requested, router_start_failed
                    ready = process.wait() == 0
                    if ready:
                        for _ in range(30):
                            if offline_router_ready():
                                with router_start_lock:
                                    router_start_requested = False
                                    router_start_failed = False
                                return
                            time.sleep(2)
                    with router_start_lock:
                        router_start_requested = False
                        router_start_failed = True
                threading.Thread(target=monitor_router_start, daemon=True).start()
                return "starting"
            except OSError:
                router_start_requested = False
                return "unavailable"

    def configured_yandex_api_key() -> str:
        key = os.environ.get("YANDEX_MAPS_API_KEY", "").strip()
        if key:
            return key
        env_path = Path(directory).parent / ".env"
        try:
            for line in env_path.read_text(encoding="utf-8").splitlines():
                name, separator, value = line.partition("=")
                if separator and name.strip() == "YANDEX_MAPS_API_KEY":
                    return value.strip().strip("\"'")
        except OSError:
            pass
        return ""

    class MapHandler(SimpleHTTPRequestHandler):
        def __init__(self, *args: object, **kwargs: object) -> None:
            super().__init__(*args, directory=directory, **kwargs)

        def _send_json(self, payload: dict, status: int = 200) -> None:
            body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def _cache_info(self) -> dict[str, int]:
            image_directory = Path(directory).resolve() / "offline" / "images"
            cached_images = [
                path for pattern in ("*_thumb_320.*", "*_viewed.*")
                for path in image_directory.glob(pattern)
                if path.is_file()
            ]
            cached_tiles = []
            if tile_cache.exists():
                for path in tile_cache.rglob("*.png"):
                    if not path.is_file():
                        continue
                    try:
                        digest = hashlib.sha256(path.read_bytes()).hexdigest()
                        if digest not in {BLOCKED_OSM_TILE_SHA256, EMPTY_TILE_SHA256}:
                            cached_tiles.append(path)
                    except OSError:
                        continue
            files = cached_images + cached_tiles
            return {
                "tiles": len(cached_tiles),
                "photos": len(cached_images),
                "bytes": sum(path.stat().st_size for path in files),
            }

        def do_GET(self) -> None:
            request = urlparse(self.path)
            if request.path == "/api/map-config":
                self._send_json({"yandex_api_key": configured_yandex_api_key()})
                return
            if request.path == "/api/profile":
                self._send_json(local_store.get_user_profile())
                return
            if request.path == "/api/connectivity":
                online = False
                for url in (
                    "https://connectivitycheck.gstatic.com/generate_204",
                    "https://example.com/",
                ):
                    probe = urllib.request.Request(url, headers={"User-Agent": "SmartCityGuide/1.0"})
                    try:
                        with urllib.request.urlopen(probe, timeout=3):
                            online = True
                            break
                    except urllib.error.HTTPError:
                        # Any HTTP response confirms that the network is reachable.
                        online = True
                        break
                    except Exception:
                        continue
                self._send_json({"online": online})
                return
            if request.path == "/api/cache":
                self._send_json(self._cache_info())
                return
            if request.path == "/api/offline/cities":
                graph_path = boundary_path.parent / "osrm" / "belarus.osrm.properties"
                self._send_json({
                    "cities": saved_offline_cities(),
                    "router_available": offline_router_ready(),
                    "walking_graph_available": graph_path.is_file(),
                    "tiles_cached": self._cache_info()["tiles"],
                })
                return
            if request.path == "/api/city-highlights":
                requested_cities = list(dict.fromkeys(parse_qs(request.query).get("city", [])))[:12]
                highlights = []
                client_root = Path(directory).resolve()
                for city_name in requested_cities:
                    city_places = local_store.get_places(city=city_name)
                    if not city_places:
                        highlights.append({"city": city_name, "image_url": "", "place": ""})
                        continue
                    featured = next(
                        (place for place in city_places if place.get("image_path") or place.get("gallery_json") or place.get("image_source_url")),
                        city_places[0],
                    )
                    gallery = json.loads(str(featured.get("gallery_json") or "[]"))
                    image_paths = [str(featured.get("image_path") or ""), *(str(path) for path in gallery)]
                    image_url = ""
                    for image_path in image_paths:
                        if not image_path:
                            continue
                        image_file = (client_root / image_path).resolve()
                        if client_root in image_file.parents and image_file.is_file():
                            image_url = "/" + quote(image_path, safe="/")
                            break
                    if not image_url and featured.get("image_source_url"):
                        image_url = f"/api/photo/{featured['id']}?size=320"
                    highlights.append({
                        "city": city_name,
                        "place": str(featured.get("name") or ""),
                        "category": str(featured.get("category") or ""),
                        "image_url": image_url,
                    })
                self._send_json({"highlights": highlights})
                return
            if request.path == "/api/bootstrap":
                requested_city = parse_qs(request.query).get("city", ["Минск"])[0]
                cities = local_store.get_cities()
                centers = local_store.get_city_centers()
                fallback_city = "Минск" if "Минск" in cities else (cities[0] if cities else "Минск")
                city = requested_city if requested_city in cities else fallback_city
                all_cities_catalog = parse_qs(request.query).get("all", ["0"])[0] == "1"
                places = local_store.get_all_places() if all_cities_catalog else local_store.get_places(city=city)
                if all_cities_catalog:
                    catalog_fields = ("id", "city", "name")
                    places = [{field: place.get(field) for field in catalog_fields} for place in places]
                for place in places:
                    image_paths = json.loads(place.pop("gallery_json", "[]"))
                    if not image_paths and place.get("image_path"):
                        image_paths = [place["image_path"]]
                    place["images"] = ["/" + quote(str(path), safe="/") for path in image_paths]
                    if image_paths or place.get("image_source_url"):
                        place["photo_url"] = f"/api/photo/{place['id']}"
                    if not image_paths and place.get("image_source_url"):
                        place["image_url"] = f"/api/photo/{place['id']}"
                payload = {
                    "cities": cities,
                    "city": city,
                    "center": centers.get(city, [53.90019, 27.56653]),
                    "cityCenters": centers,
                    "places": places,
                }
                self._send_json(payload)
                return
            if request.path == "/api/boundary":
                body = boundary_path.read_bytes()
                self.send_response(200)
                self.send_header("Content-Type", "application/geo+json; charset=utf-8")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
                return
            photo_match = re.fullmatch(r"/api/photo/(\d+)", request.path)
            if photo_match:
                place_id = int(photo_match.group(1))
                preview_size = parse_qs(request.query).get("size", ["720"])[0] == "320"
                photo = local_store.get_place_photo(place_id)
                if not photo:
                    self.send_error(404, "Unknown Belarus attraction")
                    return
                client_root = Path(directory).resolve()
                image_directory = client_root / "offline" / "images"
                cached_path = str(photo.get("image_path") or "")
                if not cached_path and photo.get("gallery_json"):
                    cached_gallery = json.loads(str(photo["gallery_json"]) or "[]")
                    cached_path = cached_gallery[0] if cached_gallery else ""
                image_file = (client_root / cached_path).resolve() if cached_path else None
                if image_file and client_root not in image_file.parents:
                    self.send_error(403, "Invalid image path")
                    return
                full_image_file = image_file
                file_stem = re.sub(r"[^A-Za-z0-9_.-]", "_", str(photo.get("wikidata_id") or place_id))
                if preview_size:
                    cached_thumbnail = next(image_directory.glob(f"{file_stem}_thumb_320.*"), None)
                    if cached_thumbnail:
                        image_file = cached_thumbnail
                    elif full_image_file and full_image_file.is_file():
                        image_file = full_image_file
                    else:
                        image_file = None
                if not image_file or not image_file.is_file():
                    image_source = str(photo.get("image_source_url") or "")
                    if not image_source:
                        retry_after = photo_lookup_misses.get(place_id, 0)
                        if retry_after > time.monotonic():
                            self.send_error(404, "No photo is available")
                            return
                        image_source, image_credit = find_commons_photo(photo)
                        if not image_source:
                            photo_lookup_misses[place_id] = time.monotonic() + 120
                            if preview_size and full_image_file and full_image_file.is_file():
                                image_file = full_image_file
                            else:
                                self.send_error(404, "No photo is available")
                                return
                        else:
                            photo_lookup_misses.pop(place_id, None)
                            photo["image_source_url"] = image_source
                            local_store.set_place_photo_source(place_id, image_source, image_credit)
                    if image_source:
                        image_width = 320 if preview_size else 720
                        image_url = image_source + ("&" if "?" in image_source else "?") + f"width={image_width}"
                        image_request = urllib.request.Request(
                            image_url,
                            headers={"User-Agent": "SmartCityGuide/1.0 (local photo cache)"},
                        )
                        try:
                            with urllib.request.urlopen(image_request, timeout=6 if preview_size else 20) as response:
                                content_type = response.headers.get_content_type()
                                if not content_type.startswith("image/"):
                                    self.send_error(502, "Photo source returned a non-image response")
                                    return
                                image_bytes = response.read(10 * 1024 * 1024 + 1)
                            if len(image_bytes) > 10 * 1024 * 1024:
                                self.send_error(413, "Photo is too large to cache")
                                return
                        except Exception as error:
                            if preview_size and full_image_file and full_image_file.is_file():
                                image_file = full_image_file
                            else:
                                logger.info("Фото для place_id=%s недоступно: %s", place_id, error)
                                self.send_error(404, "Photo is not cached and the network is unavailable")
                                return
                        else:
                            extension = {"image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp"}.get(content_type, ".jpg")
                            image_directory.mkdir(parents=True, exist_ok=True)
                            image_file = image_directory / (f"{file_stem}_thumb_320{extension}" if preview_size else f"{file_stem}_viewed{extension}")
                            temporary_image = image_file.with_suffix(image_file.suffix + ".tmp")
                            temporary_image.write_bytes(image_bytes)
                            temporary_image.replace(image_file)
                            if not preview_size:
                                cached_path = image_file.relative_to(client_root).as_posix()
                                local_store.cache_place_photo(place_id, cached_path)
                image_bytes = image_file.read_bytes()
                self.send_response(200)
                self.send_header("Content-Type", mimetypes.guess_type(str(image_file))[0] or "application/octet-stream")
                self.send_header("Content-Length", str(len(image_bytes)))
                self.send_header("Cache-Control", "public, max-age=604800")
                self.end_headers()
                self.wfile.write(image_bytes)
                return
            tile_match = re.fullmatch(r"/api/tiles/(\d+)/(\d+)/(\d+)\.png", request.path)
            if tile_match:
                offline_only = parse_qs(request.query).get("offline", ["0"])[0] == "1"
                zoom, x_tile, y_tile = map(int, tile_match.groups())
                if zoom > 19 or x_tile >= 2 ** zoom or y_tile >= 2 ** zoom:
                    self.send_error(400, "Invalid tile coordinate")
                    return
                cached_tile = tile_cache / str(zoom) / str(x_tile) / f"{y_tile}.png"
                png_signature = b"\x89PNG\r\n\x1a\n"
                try:
                    cached_bytes = cached_tile.read_bytes() if cached_tile.is_file() else b""
                    if cached_bytes and (not cached_bytes.startswith(png_signature) or hashlib.sha256(cached_bytes).hexdigest() in {BLOCKED_OSM_TILE_SHA256, EMPTY_TILE_SHA256}):
                        cached_tile.unlink(missing_ok=True)
                        cached_bytes = b""
                    stale = not cached_bytes or (not offline_only and time.time() - cached_tile.stat().st_mtime > 7 * 24 * 60 * 60)
                    if stale and not offline_only:
                        try:
                            tile_request = urllib.request.Request(
                                f"https://tile.openstreetmap.org/{zoom}/{x_tile}/{y_tile}.png",
                                headers={"User-Agent": "SmartCityGuide/1.0 (offline map cache)"},
                            )
                            with urllib.request.urlopen(tile_request, timeout=8) as response:
                                if not response.headers.get("Content-Type", "").startswith("image/png"):
                                    raise ValueError("Tile provider returned a non-PNG response")
                                tile = response.read()
                            if not tile.startswith(png_signature) or hashlib.sha256(tile).hexdigest() == BLOCKED_OSM_TILE_SHA256:
                                raise ValueError("Tile provider returned invalid PNG data")
                            cached_tile.parent.mkdir(parents=True, exist_ok=True)
                            temporary_tile = cached_tile.with_suffix(".tmp")
                            temporary_tile.write_bytes(tile)
                            temporary_tile.replace(cached_tile)
                        except Exception:
                            tile = cached_bytes if cached_bytes else generate_placeholder_tile()
                    else:
                        tile = cached_bytes if cached_bytes else generate_placeholder_tile()
                    self.send_response(200)
                    self.send_header("Content-Type", "image/png")
                    self.send_header("Content-Length", str(len(tile)))
                    self.send_header("Cache-Control", "no-cache, must-revalidate" if offline_only else "public, max-age=604800")
                    self.end_headers()
                    self.wfile.write(tile)
                except Exception as error:
                    logger.info("OSM tile unavailable %s/%s/%s: %s", zoom, x_tile, y_tile, error)
                    self.send_error(404, "Tile is not cached and the network is unavailable")
                return
            road_tile_match = re.fullmatch(r"/api/offline/roads/(\d+)/(\d+)/(\d+)\.mvt", request.path)
            if road_tile_match:
                zoom, x_tile, y_tile = map(int, road_tile_match.groups())
                if zoom > 19 or x_tile >= 2 ** zoom or y_tile >= 2 ** zoom:
                    self.send_error(400, "Invalid tile coordinate")
                    return
                router_status = ensure_offline_router()
                if router_status != "ready":
                    messages = {
                        "starting": "Запускается локальная офлайн-карта. Подождите, пока загрузится дорожный граф.",
                        "docker-required": "Для офлайн-карты нужен запущенный Docker.",
                        "graph-missing": "Локальный дорожный граф не найден.",
                        "unavailable": "Docker не смог запустить локальный граф дорог. Проверьте запуск Docker.",
                    }
                    self._send_json({"error": messages.get(router_status, "Локальная карта недоступна."), "status": router_status}, 503)
                    return
                try:
                    tile_request = urllib.request.Request(
                        f"http://127.0.0.1:5000/tile/v1/foot/tile({x_tile},{y_tile},{zoom}).mvt",
                        headers={"User-Agent": "SmartCityGuide/1.0 (local offline road tiles)"},
                    )
                    with urllib.request.urlopen(tile_request, timeout=5) as response:
                        tile = response.read()
                    self.send_response(200)
                    self.send_header("Content-Type", "application/vnd.mapbox-vector-tile")
                    self.send_header("Content-Length", str(len(tile)))
                    self.send_header("Cache-Control", "no-store")
                    self.end_headers()
                    self.wfile.write(tile)
                except Exception as error:
                    logger.info("Локальный дорожный тайл недоступен %s/%s/%s: %s", zoom, x_tile, y_tile, error)
                    self._send_json({"error": "Локальный граф дорог не запущен. Сохраните офлайн-город и запустите Docker."}, 503)
                return
            if request.path == "/api/route":
                values = parse_qs(request.query)
                mode = values.get("mode", ["walk"])[0]
                if mode not in {"walk", "drive"}:
                    self._send_json({"error": "Неизвестный способ передвижения"}, 400)
                    return
                try:
                    origin_lat, origin_lon = map(float, values["from"][0].split(","))
                    target_lat, target_lon = map(float, values["to"][0].split(","))
                except (KeyError, ValueError, IndexError):
                    self._send_json({"error": "Не заданы координаты начала и конца маршрута"}, 400)
                    return
                coordinates = f"{origin_lon},{origin_lat};{target_lon},{target_lat}"
                profile = "foot" if mode == "walk" else "driving"
                route_url = f"/route/v1/{profile}/{coordinates}?overview=full&steps=true&geometries=geojson"
                public_router = f"https://router.project-osrm.org{route_url}"
                offline_only = values.get("offline", ["0"])[0] == "1"
                requested_city = values.get("city", [""])[0]
                if offline_only and requested_city not in saved_offline_cities():
                    self._send_json({"error": "Этот город не добавлен в офлайн-пакеты."}, 409)
                    return
                if offline_only and mode == "drive" and not os.environ.get("SMART_GUIDE_DRIVING_OSRM_URL"):
                    self._send_json({"error": "В офлайн-пакете доступны пешие маршруты. Автомобильный граф не установлен."}, 503)
                    return
                if offline_only:
                    local_osrm = os.environ.get(
                        "SMART_GUIDE_DRIVING_OSRM_URL" if mode == "drive" else "SMART_GUIDE_OSRM_URL",
                        "http://127.0.0.1:5000",
                    ).rstrip("/")
                    route_sources = ((f"{local_osrm}{route_url}", True),)
                elif mode == "walk":
                    local_osrm = os.environ.get("SMART_GUIDE_OSRM_URL", "http://127.0.0.1:5000").rstrip("/")
                    route_sources = ((f"{local_osrm}{route_url}", True), (public_router, False))
                else:
                    local_driving_osrm = os.environ.get("SMART_GUIDE_DRIVING_OSRM_URL", "").rstrip("/")
                    route_sources = (
                        ((f"{local_driving_osrm}{route_url}", True), (public_router, False))
                        if local_driving_osrm
                        else ((public_router, False),)
                    )
                for route_source, offline in route_sources:
                    try:
                        result = fetch_route_json(route_source)
                        if result.get("code") != "Ok" or not result.get("routes"):
                            continue
                        route = result["routes"][0]
                        steps = [
                            {
                                "name": step.get("name", ""),
                                "distance": step.get("distance", 0),
                                "type": step.get("maneuver", {}).get("type", "continue"),
                                "modifier": step.get("maneuver", {}).get("modifier", ""),
                                "location": step.get("maneuver", {}).get("location", []),
                            }
                            for leg in route.get("legs", [])
                            for step in leg.get("steps", [])
                        ]
                        self._send_json({"geometry": route["geometry"], "distance": route["distance"], "duration": route["duration"], "steps": steps, "offline": offline, "mode": mode})
                        return
                    except Exception as error:
                        logger.info("Маршрутизатор %s недоступен: %s", route_source.split("/")[2], error)
                self._send_json({"error": "Маршрут недоступен. Для офлайн-маршрута подготовьте дорожный пакет Беларуси."}, 503)
                return
            super().do_GET()

        def do_POST(self) -> None:
            request = urlparse(self.path)
            if request.path == "/api/offline/cities":
                try:
                    content_length = int(self.headers.get("Content-Length", "0"))
                    if content_length <= 0 or content_length > 512 * 1024:
                        raise ValueError("Неверный размер списка городов")
                    payload = json.loads(self.rfile.read(content_length).decode("utf-8"))
                    requested = payload.get("cities") if isinstance(payload, dict) else None
                    if not isinstance(requested, list) or any(not isinstance(city, str) for city in requested):
                        raise ValueError("Ожидался список городов")
                    allowed = set(local_store.get_cities())
                    cities = list(dict.fromkeys(city for city in requested if city in allowed))
                    offline_city_manifest.parent.mkdir(parents=True, exist_ok=True)
                    temporary_manifest = offline_city_manifest.with_suffix(".tmp")
                    temporary_manifest.write_text(json.dumps(cities, ensure_ascii=False), encoding="utf-8")
                    temporary_manifest.replace(offline_city_manifest)
                except (UnicodeDecodeError, json.JSONDecodeError, ValueError, OSError) as error:
                    self._send_json({"error": str(error)}, 400)
                    return

                routing_status = ensure_offline_router() if cities else "ready"
                self._send_json({"cities": cities, "routing_status": routing_status})
                return
            if request.path == "/api/cache/clear":
                try:
                    if tile_cache.exists():
                        shutil.rmtree(tile_cache)
                    image_directory = Path(directory).resolve() / "offline" / "images"
                    for pattern in ("*_thumb_320.*", "*_viewed.*"):
                        for cached_image in image_directory.glob(pattern):
                            if cached_image.is_file():
                                cached_image.unlink()
                    self._send_json(self._cache_info())
                except OSError as error:
                    self._send_json({"error": f"Не удалось очистить кеш: {error}"}, 500)
                return
            if request.path != "/api/profile":
                self.send_error(404, "Unknown API endpoint")
                return
            try:
                content_length = int(self.headers.get("Content-Length", "0"))
                if content_length <= 0 or content_length > 1024 * 1024:
                    raise ValueError("Invalid profile payload size")
                payload = json.loads(self.rfile.read(content_length).decode("utf-8"))
                name = payload.get("name", "Гость")
                visited_places = payload.get("visited_places", [])
                if not isinstance(name, str) or not isinstance(visited_places, list):
                    raise ValueError("Invalid profile payload")
            except (UnicodeDecodeError, json.JSONDecodeError, ValueError) as error:
                self._send_json({"error": str(error)}, 400)
                return
            local_store.save_user_profile(name, visited_places)
            self._send_json(local_store.get_user_profile())

        def log_message(self, format_string: str, *args: object) -> None:
            logger.info("Map HTTP: " + format_string, *args)

    server = ThreadingHTTPServer(("127.0.0.1", 0), MapHandler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    logger.info("Локальный сервер карты запущен: http://127.0.0.1:%s", server.server_port)
    return server


class SmartGuideApp:
    def __init__(self, page: ft.Page) -> None:
        self.page = page
        self.store = LocalStore()
        self.selected_categories: List[str] = []
        self.route_places: List[Dict[str, object]] = []
        self.offline_mode = True
        self.current_city = "Минск"
        self.user_name = "Гость"
        self.native_map: Optional[NativeMapWindow] = None
        self.map_status = ft.Text("Карта: еще не открыта", size=12, color="#9bb7b5")
        self.map_server = self._start_map_server()
        logger.info("Клиент запущен, map_server_port=%s", self.map_server.server_port)
        self.page.title = "Умный гид по городу"
        self.page.theme_mode = ft.ThemeMode.DARK
        self.page.theme = ft.Theme(color_scheme_seed=ft.Colors.TEAL, use_material3=True)
        self.page.bgcolor = "#0d171a"
        self.show_welcome()

    def _start_map_server(self) -> ThreadingHTTPServer:
        return start_map_server(self.store)

    def show_welcome(self) -> None:
        self.page.clean()
        name_field = ft.TextField(label="Как вас зовут?", autofocus=True, width=380)
        city_dropdown = ft.Dropdown(label="Выберите город", width=380, options=[ft.dropdown.Option(city) for city in self.store.get_cities()], value=self.current_city)

        def start(_: ft.ControlEvent) -> None:
            if not name_field.value or not name_field.value.strip():
                name_field.error_text = "Введите имя"
                self.page.update()
                return
            self.user_name = name_field.value.strip()
            self.show_dashboard(self.user_name, city_dropdown.value or self.current_city)

        card = ft.Container(width=520, padding=42, border_radius=28, bgcolor="#142428", border=ft.border.all(1, "#28474b"), content=ft.Column([
            ft.Row([ft.Icon(ft.Icons.EXPLORE, size=42, color=ft.Colors.TEAL_ACCENT), ft.Text("Умный гид", size=36, weight=ft.FontWeight.BOLD)], alignment=ft.MainAxisAlignment.CENTER),
            ft.Text("Откройте город в своем ритме", size=17, color="#9bb7b5", text_align=ft.TextAlign.CENTER),
            ft.Divider(color="#31575a"), name_field, city_dropdown,
            ft.FilledButton("Начать путешествие", icon=ft.Icons.ARROW_FORWARD, on_click=start, height=50, width=380),
        ], horizontal_alignment=ft.CrossAxisAlignment.CENTER, spacing=18))
        self.page.add(ft.Container(expand=True, padding=40, alignment=ft.alignment.center, content=card))
        self.page.update()

    def show_dashboard(self, user_name: str, city_name: str) -> None:
        self.user_name, self.current_city = user_name, city_name
        places = self.store.get_places(self.selected_categories, self.current_city)
        chips = [ft.Chip(label=ft.Text(category), selected=category in self.selected_categories, selected_color="#1f7773", on_select=self.toggle_category) for category in CATEGORIES]
        recommendations = ft.Column([self._place_card(place) for place in places[:3]], spacing=9)
        sidebar = ft.Container(width=350, padding=24, bgcolor="#102024", content=ft.Column([
            ft.Row([ft.CircleAvatar(content=ft.Text(user_name[:1].upper()), bgcolor=ft.Colors.TEAL), ft.Column([ft.Text(user_name, weight=ft.FontWeight.BOLD), ft.Text(city_name, size=12, color="#9bb7b5")], spacing=2, expand=True), ft.IconButton(ft.Icons.SWAP_HORIZ, tooltip="Сменить город", on_click=self.change_city)]),
            ft.Row([ft.Text("Исследуйте места рядом", size=13, color="#6f9695", expand=True), ft.IconButton(ft.Icons.REFRESH, tooltip="Сбросить фильтры", on_click=self.clear_filters)]),
            ft.Text("Фильтры по интересам", size=17, weight=ft.FontWeight.BOLD), ft.Row(chips, wrap=True, spacing=7, run_spacing=7),
            ft.Container(padding=12, border_radius=14, bgcolor="#183033", content=ft.Row([ft.Icon(ft.Icons.WIFI_OFF if self.offline_mode else ft.Icons.WIFI, color=ft.Colors.TEAL_ACCENT), ft.Column([ft.Text("Офлайн-режим", weight=ft.FontWeight.BOLD), ft.Text("SQLite-карта" if self.offline_mode else "OSRM-маршруты", size=11, color="#9bb7b5")], spacing=2, expand=True), ft.Switch(value=self.offline_mode, on_change=self.toggle_offline)])),
            ft.Divider(color="#244346"), ft.Row([ft.Text("Рекомендуем сегодня", size=17, weight=ft.FontWeight.BOLD), ft.Icon(ft.Icons.AUTO_AWESOME, color=ft.Colors.AMBER)]), recommendations,
            ft.Container(expand=True), ft.Text(f"В маршруте: {len(self.route_places)}", color="#9bb7b5", size=12), ft.FilledButton("Построить маршрут", icon=ft.Icons.DIRECTIONS_WALK, on_click=self.build_route, height=46, width=300),
        ], spacing=13, expand=True))
        map_url = f"http://127.0.0.1:{self.map_server.server_port}/map.html?city={quote(self.current_city)}"
        self.map_status.value = f"Карта: подключение к {map_url}"
        logger.info("Создание WebView: city=%s url=%s", self.current_city, map_url)
        self.map_url = map_url
        self.page.clean()
        map_panel = ft.Container(
            ft.Column([
                ft.Container(
                    padding=ft.padding.symmetric(horizontal=12, vertical=7),
                    bgcolor="#14272a",
                    border_radius=10,
                    content=ft.Row([
                        ft.Icon(ft.Icons.INFO_OUTLINE, size=16, color=ft.Colors.TEAL_ACCENT),
                        self.map_status,
                        ft.IconButton(ft.Icons.BUG_REPORT_OUTLINED, tooltip="Проверить map.html", on_click=self.check_map),
                        ft.IconButton(ft.Icons.OPEN_IN_NEW, tooltip="Открыть native-карту", on_click=self.open_native_map),
                    ]),
                ),
                ft.Container(
                    expand=True,
                    alignment=ft.alignment.center,
                    bgcolor="#172126",
                    content=ft.Column([
                        ft.Icon(ft.Icons.MAP_OUTLINED, size=72, color=ft.Colors.TEAL_ACCENT),
                        ft.Text("Native-карта готова", size=24, weight=ft.FontWeight.BOLD),
                        ft.Text("Откройте карту в отдельном окне приложения", color="#9bb7b5"),
                        ft.FilledButton("Открыть карту", icon=ft.Icons.OPEN_IN_NEW, on_click=self.open_native_map),
                    ], horizontal_alignment=ft.CrossAxisAlignment.CENTER, spacing=14),
                ),
            ], expand=True, spacing=8),
            expand=True,
            margin=12,
            border_radius=20,
            bgcolor="#172126",
            clip_behavior=ft.ClipBehavior.ANTI_ALIAS,
        )
        self.page.add(ft.Row([sidebar, ft.VerticalDivider(width=1, color="#203a3d"), map_panel], expand=True, spacing=0))
        self.page.update()
        logger.info("Используется native pywebview-карта: %s", map_url)

    def _map_status(self, message: str) -> None:
        logger.info("Статус карты: %s", message)
        self.page.snack_bar = ft.SnackBar(ft.Text(message), open=True)
        self.page.update()

    def check_map(self, _: ft.ControlEvent) -> None:
        url = f"http://127.0.0.1:{self.map_server.server_port}/map.html?city={quote(self.current_city)}"
        try:
            with urllib.request.urlopen(url, timeout=3) as response:
                size = response.headers.get("Content-Length", "неизвестно")
                self._map_status(f"HTML доступен, HTTP {response.status}, {size} байт")
        except Exception as error:
            self._map_status(f"ошибка localhost: {error}")

    def open_native_map(self, _: ft.ControlEvent) -> None:
        if self.native_map is None:
            self.native_map = NativeMapWindow(self.map_url, self._select_place_from_map)
        logger.info("Открытие native pywebview-карты: %s", self.map_url)
        self.native_map.open()
        self._map_status("native-карта открыта")

    def _select_place_from_map(self, place_id: int) -> None:
        place = next((item for item in self.store.get_places(city=self.current_city) if item["id"] == place_id), None)
        if place:
            self.add_to_route(place)

    def _place_card(self, place: Dict[str, object]) -> ft.Control:
        selected = any(item["id"] == place["id"] for item in self.route_places)
        return ft.Container(padding=10, border_radius=13, bgcolor="#172d31" if selected else "#14272a", content=ft.Row([
            ft.Icon(ft.Icons.ROUTE if selected else ft.Icons.PLACE_OUTLINED, color=ft.Colors.TEAL_ACCENT), ft.Column([ft.Text(str(place["name"]), weight=ft.FontWeight.BOLD, max_lines=1, overflow=ft.TextOverflow.ELLIPSIS), ft.Text(f'{place["category"]} · ★ {place["rating"]}', size=12, color="#9bb7b5")], spacing=2, expand=True),
            ft.IconButton(ft.Icons.CHECK if selected else ft.Icons.ADD, tooltip="Убрать из маршрута" if selected else "Добавить в маршрут", on_click=lambda _: self.add_to_route(place)),
        ]))

    def toggle_category(self, event: ft.ControlEvent) -> None:
        category = event.control.label.value
        if event.control.selected and category not in self.selected_categories:
            self.selected_categories.append(category)
        elif not event.control.selected and category in self.selected_categories:
            self.selected_categories.remove(category)
        self.show_dashboard(self.user_name, self.current_city)

    def toggle_offline(self, event: ft.ControlEvent) -> None:
        self.offline_mode = bool(event.control.value)
        self.page.snack_bar = ft.SnackBar(ft.Text("Офлайн-режим включен" if self.offline_mode else "Онлайн-маршруты включены"), open=True)
        self.page.update()

    def add_to_route(self, place: Dict[str, object]) -> None:
        if any(item["id"] == place["id"] for item in self.route_places):
            self.route_places = [item for item in self.route_places if item["id"] != place["id"]]
        else:
            self.route_places.append(place)
        self.show_dashboard(self.user_name, self.current_city)

    def handle_map_url(self, event: ft.ControlEvent) -> None:
        parsed = urlparse(event.data or "")
        values = parse_qs(parsed.query)
        if parsed.scheme == "smartguide" and parsed.netloc == "add" and values.get("id"):
            place_id = int(values["id"][0])
            place = next((item for item in self.store.get_places(city=self.current_city) if item["id"] == place_id), None)
            if place:
                self.add_to_route(place)

    def build_route(self, _: ft.ControlEvent) -> None:
        if not self.route_places:
            self.page.snack_bar = ft.SnackBar(ft.Text("Добавьте места в маршрут на карте или в рекомендациях."), open=True)
            self.page.update()
            return
        points = [[place["latitude"], place["longitude"]] for place in self.route_places]
        if self.native_map:
            self.native_map.build_route(points, self.offline_mode)
        self.page.snack_bar = ft.SnackBar(ft.Text("Маршрут построен на карте."), open=True)
        self.page.update()

    def clear_filters(self, _: ft.ControlEvent) -> None:
        self.selected_categories.clear()
        self.show_dashboard(self.user_name, self.current_city)

    def change_city(self, _: ft.ControlEvent) -> None:
        city = ft.Dropdown(label="Город", options=[ft.dropdown.Option(item) for item in self.store.get_cities()], value=self.current_city)

        def apply(_: ft.ControlEvent) -> None:
            self.route_places.clear()
            self.current_city = city.value or "Минск"
            self.close_dialog()
            self.show_dashboard(self.user_name, self.current_city)

        self.page.dialog = ft.AlertDialog(modal=True, title=ft.Text("Сменить город"), content=city, actions=[ft.TextButton("Отмена", on_click=lambda _: self.close_dialog()), ft.FilledButton("Применить", on_click=apply)])
        self.page.dialog.open = True
        self.page.update()

    def close_dialog(self) -> None:
        if self.page.dialog:
            self.page.dialog.open = False
            self.page.update()


def main(page: ft.Page) -> None:
    SmartGuideApp(page)


if __name__ == "__main__":
    map_store = LocalStore()
    map_server = start_map_server(map_store)
    map_url = f"http://127.0.0.1:{map_server.server_port}/map.html?city={quote('Минск')}"
    map_window = NativeMapWindow(map_url, lambda place_id: logger.info("Выбрано место: %s", place_id))
    logger.info("Запуск карты в главном окне приложения: %s", map_url)
    map_window.run()

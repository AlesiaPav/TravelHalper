"""Import POI for Belarus cities from Overpass and cache media locally.

This script loads tourist and cultural places for Minsk, Vitebsk and Polotsk,
fetches OpenStreetMap metadata, enriches it from Wikidata/Wikimedia, downloads
photos into the local cache directory and stores the result in the project's
offline SQLite catalog.
"""

from __future__ import annotations

import json
import re
import sys
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any

PROJECT_ROOT = Path(__file__).resolve().parent.parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from client.storage import LocalStore

CLIENT_ROOT = PROJECT_ROOT / "client"
IMAGE_ROOT = CLIENT_ROOT / "offline" / "images"
IMAGE_ROOT.mkdir(parents=True, exist_ok=True)

CITY_BOXES = {
    "Минск": (53.75, 27.35, 54.15, 27.95),
    "Витебск": (54.90, 29.50, 55.60, 30.80),
    "Полоцк": (55.45, 28.70, 55.55, 28.95),
}

OVERPASS_QUERY_TEMPLATE = """
[out:json][timeout:60];
(
  node["tourism"="attraction"]({min_lat},{min_lon},{max_lat},{max_lon});
  node["historic"]({min_lat},{min_lon},{max_lat},{max_lon});
  node["amenity"="museum"]({min_lat},{min_lon},{max_lat},{max_lon});
  node["tourism"="museum"]({min_lat},{min_lon},{max_lat},{max_lon});
  node["amenity"="cafe"]({min_lat},{min_lon},{max_lat},{max_lon});
  node["leisure"="park"]({min_lat},{min_lon},{max_lat},{max_lon});
  way["tourism"="attraction"]({min_lat},{min_lon},{max_lat},{max_lon});
  way["historic"]({min_lat},{min_lon},{max_lat},{max_lon});
  way["amenity"="museum"]({min_lat},{min_lon},{max_lat},{max_lon});
  way["tourism"="museum"]({min_lat},{min_lon},{max_lat},{max_lon});
  way["leisure"="park"]({min_lat},{min_lon},{max_lat},{max_lon});
);
out center tags;
""".strip()


def request_json(url: str, payload: dict[str, Any] | None = None, retries: int = 3) -> Any:
    data = None if payload is None else urllib.parse.urlencode(payload).encode("utf-8")
    last_error: Exception | None = None
    for attempt in range(retries + 1):
        try:
            request = urllib.request.Request(url, data=data, method="POST" if data else "GET")
            request.add_header("User-Agent", "SmartCityGuide/1.0")
            with urllib.request.urlopen(request, timeout=30) as response:
                return json.loads(response.read().decode("utf-8"))
        except (urllib.error.HTTPError, urllib.error.URLError, TimeoutError) as exc:
            last_error = exc
            if attempt >= retries:
                break
            delay = 2 ** attempt
            if isinstance(exc, urllib.error.HTTPError) and exc.code in {429, 500, 502, 503, 504}:
                import time
                time.sleep(delay)
            else:
                import time
                time.sleep(delay)
    raise RuntimeError(f"Request failed for {url}: {last_error}")


def fetch_overpass(city: str) -> list[dict[str, Any]]:
    min_lat, min_lon, max_lat, max_lon = CITY_BOXES[city]
    query = OVERPASS_QUERY_TEMPLATE.format(
        min_lat=min_lat,
        min_lon=min_lon,
        max_lat=max_lat,
        max_lon=max_lon,
    )
    payload = {"data": query}
    result = request_json("https://overpass-api.de/api/interpreter", payload, retries=3)
    items: list[dict[str, Any]] = []
    for element in result.get("elements", []):
        tags = element.get("tags", {}) or {}
        name = tags.get("name") or tags.get("name:be") or tags.get("name:ru") or tags.get("operator") or "Объект"
        if not name:
            continue
        lat = element.get("lat")
        lon = element.get("lon")
        if lat is None and element.get("center"):
            lat = element["center"].get("lat")
            lon = element["center"].get("lon")
        if lat is None or lon is None:
            continue
        items.append(
            {
                "id": element.get("id"),
                "name": name,
                "latitude": float(lat),
                "longitude": float(lon),
                "tags": tags,
            }
        )
    return items


def fetch_wikidata_photo(wikidata_id: str | None) -> tuple[str | None, str | None, str | None, str | None]:
    if not wikidata_id:
        return None, None, None, None
    try:
        meta = request_json(
            "https://www.wikidata.org/w/api.php",
            {
                "action": "wbgetentities",
                "ids": wikidata_id,
                "props": "labels|descriptions|claims",
                "format": "json",
                "languages": "ru|en",
            },
        )
    except Exception:
        return None, None, None, None

    entity = (meta.get("entities") or {}).get(wikidata_id)
    if not entity:
        return None, None, None, None

    description = None
    en_desc = entity.get("descriptions", {})
    if "ru" in en_desc:
        description = en_desc["ru"].get("value")
    elif "en" in en_desc:
        description = en_desc["en"].get("value")

    claims = entity.get("claims", {})
    image_name = None
    for field in ("P18", "P41", "P154"):
        values = claims.get(field) or []
        if values:
            image_name = values[0].get("mainsnak", {}).get("datavalue", {}).get("value")
            if image_name:
                break

    if not image_name:
        return description, None, None, None

    file_name = image_name.replace(" ", "_")
    local_name = re.sub(r"[^A-Za-z0-9_.-]", "_", file_name)
    local_path = IMAGE_ROOT / local_name
    if not local_path.exists():
        image_url = f"https://commons.wikimedia.org/wiki/Special:FilePath/{urllib.parse.quote(file_name)}"
        try:
            with urllib.request.urlopen(image_url, timeout=30) as response:
                body = response.read()
            local_path.write_bytes(body)
        except Exception:
            return description, None, None, None
    wiki_url = f"https://www.wikidata.org/wiki/{wikidata_id}"
    return description, str(local_path.relative_to(PROJECT_ROOT)), wiki_url, image_name


def classify(tags: dict[str, str]) -> str:
    if tags.get("tourism") == "attraction":
        return "Архитектура"
    if tags.get("historic"):
        return "История"
    if tags.get("amenity") == "museum" or tags.get("tourism") == "museum":
        return "Музеи"
    if tags.get("amenity") == "cafe":
        return "Кафе"
    if tags.get("leisure") == "park":
        return "Парки"
    if tags.get("tourism") == "viewpoint":
        return "Архитектура"
    return "Архитектура"


def build_place_entry(city: str, item: dict[str, Any]) -> dict[str, Any]:
    tags = item["tags"]
    wikidata_id = tags.get("wikidata")
    description, local_image, wiki_url, image_name = fetch_wikidata_photo(wikidata_id)
    if description is None:
        description = tags.get("description") or tags.get("short_description") or "Описание отсутствует."
    category = classify(tags)
    place = {
        "city": city,
        "name": item["name"],
        "category": category,
        "latitude": float(item["latitude"]),
        "longitude": float(item["longitude"]),
        "rating": 0,
        "wikidata_id": wikidata_id,
        "description": description,
        "history": "",
        "image_path": local_image or "",
        "images": [local_image] if local_image else [],
        "image_source_url": (
            f"https://commons.wikimedia.org/wiki/Special:FilePath/{urllib.parse.quote(image_name)}"
            if image_name else ""
        ),
        "image_credit": "Wikimedia Commons",
        "wiki_url": wiki_url or "",
        "source_url": f"https://www.openstreetmap.org/{'node' if item['id'] > 0 else 'way'}/{abs(item['id'])}",
        "rating_source": "",
    }
    return place


def deduplicate_places(places: list[dict[str, Any]]) -> list[dict[str, Any]]:
    seen: set[tuple[str, str, str]] = set()
    deduped: list[dict[str, Any]] = []
    for place in places:
        identifier = (
            place.get("city", ""),
            place.get("wikidata_id") or place.get("name", ""),
            place.get("source_url", ""),
        )
        if identifier in seen:
            continue
        seen.add(identifier)
        deduped.append(place)
    return deduped


def import_cities() -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    cities: list[dict[str, Any]] = []
    places: list[dict[str, Any]] = []
    for city_name, (lat, lon, _, _) in [
        ("Минск", (53.90019, 27.56653, 0, 0)),
        ("Витебск", (55.1904, 30.2049, 0, 0)),
        ("Полоцк", (55.4879, 28.7856, 0, 0)),
    ]:
        cities.append({"name": city_name, "latitude": lat, "longitude": lon, "geoname_id": None})
    for city_name in CITY_BOXES:
        try:
            items = fetch_overpass(city_name)
        except RuntimeError:
            continue
        unique_names: set[str] = set()
        for item in items:
            key = (item["name"], round(item["latitude"], 4), round(item["longitude"], 4))
            if key in unique_names:
                continue
            unique_names.add(key)
            places.append(build_place_entry(city_name, item))
    return cities, deduplicate_places(places)


def main() -> None:
    city_list, places = import_cities()
    store = LocalStore()
    store.replace_belarus_catalog(city_list, places)
    print(f"Imported {len(city_list)} cities and {len(places)} places")
    for place in places[:5]:
        print(place["name"], place["city"], place["category"], place["image_path"])


if __name__ == "__main__":
    main()

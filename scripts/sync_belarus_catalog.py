"""Build the offline Belarus city and attraction catalogue from open datasets."""

from __future__ import annotations

import argparse
import csv
import io
import json
import logging
import math
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import zipfile
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from typing import Dict, Iterable, List, Optional, Sequence, Tuple

PROJECT_ROOT = Path(__file__).resolve().parent.parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from client.storage import LocalStore


USER_AGENT = "SmartCityGuide/1.0 (Belarus offline catalogue)"
GEONAMES_URL = "https://download.geonames.org/export/dump/BY.zip"
WIKIDATA_API = "https://www.wikidata.org/w/api.php"
WIKIDATA_SPARQL = "https://query.wikidata.org/sparql"
BOUNDARY_PATH = PROJECT_ROOT / "data" / "belarus-boundary.geojson"
IMAGE_DIR = PROJECT_ROOT / "client" / "offline" / "images"
LOG = logging.getLogger("smart-guide.sync")

CITY_NAME_OVERRIDES = {
    "Baranovichi": "Барановичи",
    "Bobruisk": "Бобруйск",
    "Borisov": "Борисов",
    "Brest": "Брест",
    "Gomel": "Гомель",
    "Grodno": "Гродно",
    "Lida": "Лида",
    "Minsk": "Минск",
    "Mogilev": "Могилёв",
    "Mozyr": "Мозырь",
    "Novopolotsk": "Новополоцк",
    "Orsha": "Орша",
    "Pinsk": "Пинск",
    "Polotsk": "Полоцк",
    "Soligorsk": "Солигорск",
    "Vitebsk": "Витебск",
    "Zhlobin": "Жлобин",
    "Zhodino": "Жодино",
}
RUSSIAN_NAME_PATTERN = re.compile(r"^[А-Яа-яЁё][А-Яа-яЁё .,'’()\-–]*$")

POI_TYPES = {
    "Q570116": "Достопримечательность",
    "Q33506": "Музей",
    "Q4989906": "Памятник",
    "Q23413": "Замок",
    "Q16970": "Архитектура",
    "Q44613": "Монастырь",
    "Q22698": "Парк",
    "Q179049": "Природа",
    "Q839954": "Археология",
    "Q5003624": "Мемориал",
    "Q43501": "Зоопарк",
    "Q16560": "Дворец",
    "Q24354": "Театр",
}


def request_bytes(url: str, timeout: int = 30, retries: int = 2) -> Tuple[bytes, str]:
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    last_error: Optional[Exception] = None
    for attempt in range(retries + 1):
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                return response.read(), response.headers.get_content_type()
        except urllib.error.HTTPError as error:
            last_error = error
            if error.code == 429 and attempt < retries:
                try:
                    retry_after = float(error.headers.get("Retry-After", "0"))
                except ValueError:
                    retry_after = 0
                time.sleep(min(max(retry_after, 5 * (attempt + 1)), 45))
            elif attempt < retries:
                time.sleep(1.5 * (attempt + 1))
        except (urllib.error.URLError, TimeoutError) as error:
            last_error = error
            if attempt < retries:
                time.sleep(1.5 * (attempt + 1))
    raise RuntimeError(f"Request failed: {url}: {last_error}")


def request_json(url: str, timeout: int = 30) -> dict:
    body, _ = request_bytes(url, timeout)
    return json.loads(body.decode("utf-8"))


def parse_city_name(name: str, alternate_names: str) -> str:
    if name in CITY_NAME_OVERRIDES:
        return CITY_NAME_OVERRIDES[name]
    aliases = [
        re.sub(r"\s+", " ", value.strip())
        for value in alternate_names.split(",")
        if re.search(r"[А-Яа-яЁёІіЎў]", value)
    ]
    russian = [value for value in aliases if RUSSIAN_NAME_PATTERN.fullmatch(value)]
    if russian:
        return min(russian, key=lambda value: ("городской поселок" in value.casefold(), len(value)))
    return aliases[0] if aliases else name


def load_cities() -> List[dict]:
    archive, _ = request_bytes(GEONAMES_URL, timeout=60)
    city_rows: Dict[str, dict] = {}
    with zipfile.ZipFile(io.BytesIO(archive)) as source:
        with source.open("BY.txt") as stream:
            rows = csv.reader(io.TextIOWrapper(stream, encoding="utf-8"), delimiter="\t")
            for row in rows:
                if len(row) < 15 or row[6] != "P":
                    continue
                feature_code = row[7]
                population = int(row[14] or 0)
                if feature_code != "PPLC" and not feature_code.startswith("PPLA") and not (feature_code == "PPL" and population >= 1000):
                    continue
                name = parse_city_name(row[1], row[3])
                city_rows.setdefault(name, {
                    "name": name,
                    "latitude": float(row[4]),
                    "longitude": float(row[5]),
                    "geoname_id": int(row[0]),
                })
    return sorted(city_rows.values(), key=lambda city: city["name"].casefold())


def point_in_ring(longitude: float, latitude: float, ring: Sequence[Sequence[float]]) -> bool:
    inside = False
    previous = ring[-1]
    for current in ring:
        x1, y1 = current
        x2, y2 = previous
        if (y1 > latitude) != (y2 > latitude):
            crossing = (x2 - x1) * (latitude - y1) / (y2 - y1) + x1
            if longitude < crossing:
                inside = not inside
        previous = current
    return inside


def point_in_geometry(longitude: float, latitude: float, geometry: dict) -> bool:
    if geometry["type"] == "Polygon":
        polygons = [geometry["coordinates"]]
    elif geometry["type"] == "MultiPolygon":
        polygons = geometry["coordinates"]
    else:
        return False
    for polygon in polygons:
        if point_in_ring(longitude, latitude, polygon[0]) and not any(
            point_in_ring(longitude, latitude, hole) for hole in polygon[1:]
        ):
            return True
    return False


def coordinate_bounds(geometry: dict) -> Tuple[float, float, float, float]:
    points: List[Sequence[float]] = []
    coordinates = geometry["coordinates"]
    polygons = [coordinates] if geometry["type"] == "Polygon" else coordinates
    for polygon in polygons:
        for ring in polygon:
            points.extend(ring)
    return (
        min(point[0] for point in points),
        min(point[1] for point in points),
        max(point[0] for point in points),
        max(point[1] for point in points),
    )


def query_wikidata(geometry: dict, limit: int) -> Dict[str, dict]:
    west, south, east, north = coordinate_bounds(geometry)
    types = " ".join(f"wd:{identifier}" for identifier in POI_TYPES)
    query = f"""
        SELECT DISTINCT ?item ?coord ?type ?image ?inception ?article ?label ?description ?rating WHERE {{
      ?item wdt:P625 ?coord; wdt:P31 ?type.
      VALUES ?type {{ {types} }}
      FILTER(geof:latitude(?coord) >= {south} && geof:latitude(?coord) <= {north}
        && geof:longitude(?coord) >= {west} && geof:longitude(?coord) <= {east})
      OPTIONAL {{ ?item wdt:P18 ?image. }}
      OPTIONAL {{ ?item wdt:P571 ?inception. }}
            OPTIONAL {{ ?item wdt:P444 ?rating. }}
      OPTIONAL {{ ?article schema:about ?item; schema:isPartOf <https://be.wikipedia.org/>. }}
            OPTIONAL {{ ?item rdfs:label ?labelRu. FILTER(LANG(?labelRu) = "ru") }}
            OPTIONAL {{ ?item rdfs:label ?labelBe. FILTER(LANG(?labelBe) = "be") }}
            OPTIONAL {{ ?item rdfs:label ?labelEn. FILTER(LANG(?labelEn) = "en") }}
            BIND(COALESCE(?labelRu, ?labelBe, ?labelEn) AS ?label)
            OPTIONAL {{ ?item schema:description ?descriptionRu. FILTER(LANG(?descriptionRu) = "ru") }}
            OPTIONAL {{ ?item schema:description ?descriptionBe. FILTER(LANG(?descriptionBe) = "be") }}
            OPTIONAL {{ ?item schema:description ?descriptionEn. FILTER(LANG(?descriptionEn) = "en") }}
            BIND(COALESCE(?descriptionRu, ?descriptionBe, ?descriptionEn) AS ?description)
    }} LIMIT {limit}
    """
    parameters = urllib.parse.urlencode({"query": query, "format": "json"})
    url = f"{WIKIDATA_SPARQL}?{parameters}"
    body, _ = request_bytes(url, timeout=90)
    rows = json.loads(body.decode("utf-8"), strict=False)["results"]["bindings"]
    candidates: Dict[str, dict] = {}
    for row in rows:
        entity_id = row["item"]["value"].rsplit("/", 1)[-1]
        coordinate = re.fullmatch(r"Point\(([-0-9.]+) ([-0-9.]+)\)", row["coord"]["value"])
        if not coordinate:
            continue
        longitude, latitude = map(float, coordinate.groups())
        if not point_in_geometry(longitude, latitude, geometry):
            continue
        candidate = candidates.setdefault(entity_id, {
            "wikidata_id": entity_id,
            "latitude": latitude,
            "longitude": longitude,
            "type_id": row["type"]["value"].rsplit("/", 1)[-1],
        })
        for field in ("image", "inception", "article", "label", "description", "rating"):
            if row.get(field) and field not in candidate:
                candidate[field] = row[field]["value"]
    return candidates


def fetch_entities(entity_ids: Iterable[str]) -> Dict[str, dict]:
    identifiers = list(entity_ids)
    entities: Dict[str, dict] = {}
    for offset in range(0, len(identifiers), 50):
        batch = identifiers[offset:offset + 50]
        parameters = urllib.parse.urlencode({
            "action": "wbgetentities",
            "ids": "|".join(batch),
            "props": "labels|descriptions|claims|sitelinks",
            "languages": "ru|be|en",
            "format": "json",
        })
        response = request_json(f"{WIKIDATA_API}?{parameters}")
        entities.update(response.get("entities", {}))
        if offset + 50 < len(identifiers):
            time.sleep(1.0)
    return entities


def preferred_text(values: dict) -> str:
    for language in ("ru", "be", "en"):
        if language in values:
            return values[language]["value"]
    return ""


def entity_claim(entity: dict, property_id: str) -> Optional[object]:
    statements = entity.get("claims", {}).get(property_id, [])
    if not statements:
        return None
    try:
        return statements[0]["mainsnak"]["datavalue"]["value"]
    except (KeyError, TypeError):
        return None


def article_details(entity: dict) -> Tuple[str, str]:
    sitelinks = entity.get("sitelinks", {})
    for site in ("ruwiki", "bewiki", "enwiki"):
        page = sitelinks.get(site)
        if page:
            language = site[:-4]
            title = page["title"]
            article_url = f"https://{language}.wikipedia.org/wiki/{urllib.parse.quote(title.replace(' ', '_'))}"
            return article_url, f"{language}:{title}"
    return "", ""


def fetch_summary(article: str) -> dict:
    language, title = article.split(":", 1)
    path = urllib.parse.quote(title.replace(" ", "_"), safe="()_,.-")
    url = f"https://{language}.wikipedia.org/api/rest_v1/page/summary/{path}"
    try:
        return request_json(url, timeout=20)
    except Exception as error:
        LOG.info("No Wikipedia summary for %s: %s", title, error)
        return {}


def fetch_summary_url(article_url: str) -> dict:
    parsed = urllib.parse.urlparse(article_url)
    language = parsed.netloc.split(".", 1)[0]
    title = urllib.parse.unquote(parsed.path.rsplit("/", 1)[-1])
    if not language or not title:
        return {}
    rest_title = urllib.parse.quote(title.replace("_", " "), safe="()_,.-")
    try:
        return request_json(f"https://{language}.wikipedia.org/api/rest_v1/page/summary/{rest_title}", timeout=20)
    except Exception as error:
        LOG.info("No Wikipedia summary for %s: %s", title, error)
        return {}


def parse_rating(entity: dict) -> Tuple[float, str]:
    raw = entity_claim(entity, "P444")
    if not isinstance(raw, str):
        return 0.0, ""
    match = re.search(r"\b([0-5](?:[.,]\d+)?)\s*(?:/\s*5)?\b", raw)
    if not match:
        return 0.0, ""
    return float(match.group(1).replace(",", ".")), "Wikidata P444"


def nearest_city(latitude: float, longitude: float, cities: Sequence[dict]) -> str:
    def distance(city: dict) -> float:
        lat1, lat2 = math.radians(latitude), math.radians(city["latitude"])
        delta_lat = lat2 - lat1
        delta_lon = math.radians(city["longitude"] - longitude)
        value = math.sin(delta_lat / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin(delta_lon / 2) ** 2
        return 6371 * 2 * math.atan2(math.sqrt(value), math.sqrt(1 - value))

    return min(cities, key=distance)["name"]


def download_images(entity_id: str, filename: str, thumbnail_url: str, allow_download: bool) -> List[str]:
    IMAGE_DIR.mkdir(parents=True, exist_ok=True)
    cached_files = sorted(IMAGE_DIR.glob(f"{entity_id}*.*"))
    cached = [f"offline/images/{path.name}" for path in cached_files if path.suffix.lower() in (".jpg", ".jpeg", ".png", ".webp")]
    if cached or not allow_download or not (filename or thumbnail_url):
        return cached
    urls = []
    if filename:
        urls.append(f"https://commons.wikimedia.org/wiki/Special:Redirect/file/{urllib.parse.quote(filename)}?width=720")
    if thumbnail_url:
        urls.append(thumbnail_url)
    images = []
    for url in urls:
        try:
            content, content_type = request_bytes(url, timeout=20, retries=0)
            extension = {"image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp"}.get(content_type, ".jpg")
            suffix = f"_{len(images) + 1}" if images else ""
            destination = IMAGE_DIR / f"{entity_id}{suffix}{extension}"
            if not destination.exists():
                destination.write_bytes(content)
            images.append(f"offline/images/{destination.name}")
        except Exception as error:
            LOG.info("No image for %s from %s: %s", entity_id, url, error)
    return images


def make_place(candidate: dict, city: str, summary: dict) -> dict:
    entity_id = candidate["wikidata_id"]
    article_url = candidate.get("article", "")
    article_title = urllib.parse.unquote(urllib.parse.urlparse(article_url).path.rsplit("/", 1)[-1]).replace("_", " ")
    label = candidate.get("label") or article_title or entity_id
    description = candidate.get("description", "")
    inception_time = candidate.get("inception", "")
    year_match = re.match(r"[+-]?(\d{1,4})", inception_time.lstrip("+"))
    year = year_match.group(1) if year_match else ""
    history = summary.get("extract", "") or description
    if year and year not in history:
        history = f"Основано или построено: {year}. {history}".strip()
    image_url = candidate.get("image", "")
    image_filename = urllib.parse.unquote(urllib.parse.urlparse(image_url).path.rsplit("/", 1)[-1]) if image_url else ""
    rating_value = candidate.get("rating", "")
    rating_match = re.search(r"\b([0-5](?:[.,]\d+)?)\s*(?:/\s*5)?\b", rating_value)
    rating = float(rating_match.group(1).replace(",", ".")) if rating_match else 0.0
    rating_source = "Wikidata P444" if rating_match else ""
    wiki_url = article_url
    type_id = candidate.get("type_id", "")
    image_credit = f"Wikimedia Commons: {image_filename}" if image_filename else ""
    return {
        "city": city,
        "name": label,
        "category": POI_TYPES.get(type_id, "Достопримечательность"),
        "latitude": candidate["latitude"],
        "longitude": candidate["longitude"],
        "rating": rating,
        "wikidata_id": entity_id,
        "description": description,
        "history": history,
        "image_path": "",
        "images": [],
        "image_source_url": image_url,
        "image_credit": image_credit or ("Wikipedia thumbnail" if summary.get("thumbnail") else ""),
        "_image_filename": image_filename if isinstance(image_filename, str) else "",
        "_thumbnail_url": summary.get("thumbnail", {}).get("source", ""),
        "wiki_url": summary.get("content_urls", {}).get("desktop", {}).get("page", wiki_url),
        "source_url": f"https://www.wikidata.org/wiki/{entity_id}",
        "rating_source": rating_source,
    }


def build_places(candidates: Dict[str, dict], cities: Sequence[dict], summary_limit: int, photo_limit: int) -> List[dict]:
    article_by_id = {entity_id: candidate["article"] for entity_id, candidate in candidates.items() if candidate.get("article")}
    summaries: Dict[str, dict] = {}
    if summary_limit:
        prioritized_ids = sorted(
            article_by_id,
            key=lambda entity_id: (
                bool(candidates[entity_id].get("image")),
                bool(candidates[entity_id].get("label")),
            ),
            reverse=True,
        )[:summary_limit]
        selected_articles = {entity_id: article_by_id[entity_id] for entity_id in prioritized_ids}
        with ThreadPoolExecutor(max_workers=2) as executor:
            tasks = {executor.submit(fetch_summary_url, article): entity_id for entity_id, article in selected_articles.items()}
            for completed, task in enumerate(as_completed(tasks), start=1):
                summaries[tasks[task]] = task.result()
                if completed % 25 == 0:
                    LOG.info("Cached %s/%s selected Wikipedia summaries", completed, len(tasks))

    places: List[dict] = []
    for entity_id, candidate in candidates.items():
        latitude = candidate["latitude"]
        longitude = candidate["longitude"]
        place = make_place(candidate, nearest_city(latitude, longitude, cities), summaries.get(entity_id, {}))
        places.append(place)

    photo_candidates = [
        entity_id for entity_id, candidate in candidates.items() if candidate.get("image")
    ][:photo_limit]
    selected_photos = set(photo_candidates)
    with ThreadPoolExecutor(max_workers=2) as executor:
        tasks = {
            executor.submit(
                download_images,
                place["wikidata_id"],
                place.pop("_image_filename"),
                place.pop("_thumbnail_url"),
                place["wikidata_id"] in selected_photos,
            ): place
            for place in places
        }
        for completed, task in enumerate(as_completed(tasks), start=1):
            images = task.result()
            tasks[task]["images"] = images
            tasks[task]["image_path"] = images[0] if images else ""
            if completed % 100 == 0:
                LOG.info("Cached photos for %s/%s attractions", completed, len(tasks))
    return places


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dry-run", action="store_true", help="fetch and count data without changing SQLite")
    parser.add_argument("--summary-limit", type=int, default=0, help="maximum optional Wikipedia summaries; Wikidata descriptions are always retained")
    parser.add_argument("--photo-limit", type=int, default=0, help="maximum new Commons downloads; existing cached images are reused")
    parser.add_argument("--limit", type=int, default=8000, help="maximum Wikidata query rows")
    parser.add_argument("--log-level", default="INFO")
    args = parser.parse_args()
    logging.basicConfig(level=getattr(logging, args.log_level.upper(), logging.INFO), format="%(levelname)s %(message)s")

    boundary_document = json.loads(BOUNDARY_PATH.read_text(encoding="utf-8"))
    boundary = boundary_document["features"][0]["geometry"]
    cities = load_cities()
    if not cities:
        raise RuntimeError("GeoNames returned no Belarusian cities")
    LOG.info("Loaded %s Belarusian cities from GeoNames", len(cities))

    candidates = query_wikidata(boundary, args.limit)
    LOG.info("Found %s Wikidata attractions inside the Belarus border", len(candidates))
    if args.dry_run:
        polotsk = next((city for city in cities if city["name"] == "Полоцк"), None)
        near_polotsk = [candidate for candidate in candidates.values() if polotsk and math.hypot(candidate["latitude"] - polotsk["latitude"], candidate["longitude"] - polotsk["longitude"]) < 0.35]
        print(f"Cities: {len(cities)}; attractions: {len(candidates)}; Polotsk nearby: {len(near_polotsk)}")
        return

    places = build_places(candidates, cities, args.summary_limit, args.photo_limit)
    if not places:
        raise RuntimeError("Wikidata returned no Belarusian attractions; keeping the previous offline catalogue")
    LocalStore().replace_belarus_catalog(cities, places)
    print(f"Saved {len(cities)} Belarusian cities and {len(places)} attractions to data/offline.db")


if __name__ == "__main__":
    main()
"""SQLite storage for local city and place data."""

from __future__ import annotations

import sqlite3
import json
from pathlib import Path
from typing import Dict, List, Optional


PROJECT_ROOT = Path(__file__).resolve().parent.parent
DATABASE_PATH = PROJECT_ROOT / "data" / "offline.db"

CITY_COORDINATES = {
    "Минск": (53.90019, 27.56653),
    "Брест": (52.10894, 23.71749),
    "Витебск": (55.1904, 30.2049),
    "Полоцк": (55.4879, 28.7856),
}

RUSSIAN_DEMO_CITIES = ("Москва", "Санкт-Петербург", "Казань", "Сочи")


class LocalStore:
    def __init__(self, path: Path = DATABASE_PATH) -> None:
        self.path = path
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._initialize()

    def _connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.path)
        connection.row_factory = sqlite3.Row
        return connection

    def _initialize(self) -> None:
        with self._connect() as connection:
            connection.execute("CREATE TABLE IF NOT EXISTS cities (name TEXT PRIMARY KEY, latitude REAL NOT NULL, longitude REAL NOT NULL, country_code TEXT NOT NULL DEFAULT 'BY', geoname_id INTEGER)")
            connection.execute("CREATE TABLE IF NOT EXISTS user_profile (id INTEGER PRIMARY KEY CHECK (id = 1), name TEXT NOT NULL DEFAULT 'Гость', visited_places_json TEXT NOT NULL DEFAULT '[]')")
            connection.execute("""CREATE TABLE IF NOT EXISTS places (
                id INTEGER PRIMARY KEY AUTOINCREMENT, city TEXT NOT NULL DEFAULT 'Минск',
                name TEXT NOT NULL, category TEXT NOT NULL, latitude REAL NOT NULL,
                longitude REAL NOT NULL, rating REAL NOT NULL DEFAULT 0,
                country_code TEXT NOT NULL DEFAULT 'BY', wikidata_id TEXT,
                description TEXT NOT NULL DEFAULT '', history TEXT NOT NULL DEFAULT '',
                image_path TEXT NOT NULL DEFAULT '', gallery_json TEXT NOT NULL DEFAULT '[]',
                image_source_url TEXT NOT NULL DEFAULT '',
                image_credit TEXT NOT NULL DEFAULT '',
                wiki_url TEXT NOT NULL DEFAULT '', source_url TEXT NOT NULL DEFAULT '',
                rating_source TEXT NOT NULL DEFAULT '')""")
            columns = {row[1] for row in connection.execute("PRAGMA table_info(places)")}
            if "city" not in columns:
                connection.execute("ALTER TABLE places ADD COLUMN city TEXT NOT NULL DEFAULT 'Минск'")
            place_columns = {
                "country_code": "TEXT NOT NULL DEFAULT 'BY'",
                "wikidata_id": "TEXT",
                "description": "TEXT NOT NULL DEFAULT ''",
                "history": "TEXT NOT NULL DEFAULT ''",
                "image_path": "TEXT NOT NULL DEFAULT ''",
                "gallery_json": "TEXT NOT NULL DEFAULT '[]'",
                "image_source_url": "TEXT NOT NULL DEFAULT ''",
                "image_credit": "TEXT NOT NULL DEFAULT ''",
                "wiki_url": "TEXT NOT NULL DEFAULT ''",
                "source_url": "TEXT NOT NULL DEFAULT ''",
                "rating_source": "TEXT NOT NULL DEFAULT ''",
            }
            for column, definition in place_columns.items():
                if column not in columns:
                    connection.execute(f"ALTER TABLE places ADD COLUMN {column} {definition}")
            city_columns = {row[1] for row in connection.execute("PRAGMA table_info(cities)")}
            if "country_code" not in city_columns:
                connection.execute("ALTER TABLE cities ADD COLUMN country_code TEXT NOT NULL DEFAULT 'BY'")
            if "geoname_id" not in city_columns:
                connection.execute("ALTER TABLE cities ADD COLUMN geoname_id INTEGER")
            connection.executemany(
                "UPDATE cities SET country_code = 'RU' WHERE name = ?",
                [(name,) for name in RUSSIAN_DEMO_CITIES],
            )
            connection.executemany(
                "UPDATE places SET country_code = 'RU' WHERE city = ?",
                [(name,) for name in RUSSIAN_DEMO_CITIES],
            )
            connection.executemany(
                "INSERT OR IGNORE INTO cities (name, latitude, longitude, country_code) VALUES (?, ?, ?, 'BY')",
                [(name, lat, lon) for name, (lat, lon) in CITY_COORDINATES.items()],
            )
            connection.execute("DELETE FROM places WHERE id NOT IN (SELECT MIN(id) FROM places GROUP BY city, name)")
            connection.execute("CREATE UNIQUE INDEX IF NOT EXISTS places_wikidata_id ON places(wikidata_id) WHERE wikidata_id IS NOT NULL")

    def get_cities(self) -> List[str]:
        with self._connect() as connection:
            return [row[0] for row in connection.execute("SELECT name FROM cities WHERE country_code = 'BY' ORDER BY name")]

    def get_city_centers(self) -> Dict[str, List[float]]:
        with self._connect() as connection:
            rows = connection.execute("SELECT name, latitude, longitude FROM cities WHERE country_code = 'BY'")
            return {row[0]: [row[1], row[2]] for row in rows}

    def get_user_profile(self) -> Dict[str, object]:
        with self._connect() as connection:
            row = connection.execute(
                "SELECT name, visited_places_json FROM user_profile WHERE id = 1"
            ).fetchone()
        if not row:
            return {"name": "Гость", "visited_places": [], "initialized": False}
        try:
            visited_places = json.loads(row["visited_places_json"] or "[]")
        except json.JSONDecodeError:
            visited_places = []
        if not isinstance(visited_places, list):
            visited_places = []
        return {"name": row["name"], "visited_places": visited_places, "initialized": True}

    def save_user_profile(self, name: str, visited_places: List[Dict[str, object]]) -> None:
        safe_name = name.strip()[:40] or "Гость"
        safe_visited_places = [item for item in visited_places[:500] if isinstance(item, dict)]
        with self._connect() as connection:
            connection.execute(
                """INSERT INTO user_profile (id, name, visited_places_json) VALUES (1, ?, ?)
                ON CONFLICT(id) DO UPDATE SET name = excluded.name,
                    visited_places_json = excluded.visited_places_json""",
                (safe_name, json.dumps(safe_visited_places, ensure_ascii=False)),
            )

    def get_places(self, categories: Optional[List[str]] = None, city: str = "Москва") -> List[Dict[str, object]]:
        query = "SELECT * FROM places WHERE city = ? AND country_code = 'BY'"
        parameters: List[object] = [city]
        if categories:
            placeholders = ", ".join("?" for _ in categories)
            query += " AND category IN (" + placeholders + ")"
            parameters.extend(categories)
        query += " ORDER BY rating DESC, name"
        with self._connect() as connection:
            rows = connection.execute(query, parameters).fetchall()
        places = [dict(row) for row in rows]
        for place in places:
            if place["rating"] == 0:
                place["rating"] = None
        return places

    def get_all_places(self) -> List[Dict[str, object]]:
        with self._connect() as connection:
            rows = connection.execute(
                "SELECT * FROM places WHERE country_code = 'BY' ORDER BY city, rating DESC, name"
            ).fetchall()
        places = [dict(row) for row in rows]
        for place in places:
            if place["rating"] == 0:
                place["rating"] = None
        return places

    def get_place_photo(self, place_id: int) -> Optional[Dict[str, object]]:
        with self._connect() as connection:
            row = connection.execute(
                "SELECT id, wikidata_id, name, city, image_path, gallery_json, image_source_url, image_credit FROM places WHERE id = ? AND country_code = 'BY'",
                (place_id,),
            ).fetchone()
        return dict(row) if row else None

    def set_place_photo_source(self, place_id: int, image_source_url: str, image_credit: str) -> None:
        with self._connect() as connection:
            connection.execute(
                "UPDATE places SET image_source_url = ?, image_credit = ? WHERE id = ? AND country_code = 'BY' AND image_source_url = ''",
                (image_source_url, image_credit, place_id),
            )

    def cache_place_photo(self, place_id: int, image_path: str) -> None:
        with self._connect() as connection:
            row = connection.execute(
                "SELECT gallery_json, image_path FROM places WHERE id = ? AND country_code = 'BY'",
                (place_id,),
            ).fetchone()
            if not row:
                return
            try:
                gallery = json.loads(row["gallery_json"] or "[]")
            except json.JSONDecodeError:
                gallery = []
            if image_path not in gallery:
                gallery.append(image_path)
            connection.execute(
                "UPDATE places SET image_path = ?, gallery_json = ? WHERE id = ? AND country_code = 'BY'",
                (row["image_path"] or image_path, json.dumps(gallery, ensure_ascii=False), place_id),
            )

    def replace_belarus_catalog(self, cities: List[Dict[str, object]], places: List[Dict[str, object]]) -> None:
        with self._connect() as connection:
            connection.execute("DELETE FROM places WHERE country_code = 'BY'")
            connection.execute("DELETE FROM cities WHERE country_code = 'BY'")
            connection.executemany(
                "INSERT INTO cities (name, latitude, longitude, country_code, geoname_id) VALUES (?, ?, ?, 'BY', ?)",
                [(city["name"], city["latitude"], city["longitude"], city.get("geoname_id")) for city in cities],
            )
            connection.executemany(
                """INSERT INTO places (
                    city, name, category, latitude, longitude, rating, country_code,
                    wikidata_id, description, history, image_path, gallery_json, image_credit,
                    image_source_url, wiki_url, source_url, rating_source
                ) VALUES (?, ?, ?, ?, ?, ?, 'BY', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                [(
                    place["city"], place["name"], place["category"], place["latitude"],
                    place["longitude"], place.get("rating") or 0, place.get("wikidata_id"),
                    place.get("description", ""), place.get("history", ""),
                    place.get("image_path", ""),
                    json.dumps(place.get("images", []), ensure_ascii=False),
                    place.get("image_credit", ""),
                    place.get("image_source_url", ""),
                    place.get("wiki_url", ""), place.get("source_url", ""),
                    place.get("rating_source", ""),
                ) for place in places],
            )

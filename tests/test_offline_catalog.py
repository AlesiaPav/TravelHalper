from __future__ import annotations

import json
import ssl
import subprocess
import tempfile
import unittest
from http.client import HTTPConnection
from pathlib import Path
from urllib.error import URLError
from urllib.parse import quote
from unittest.mock import patch

from client.main import fetch_route_json, start_map_server
from client.storage import LocalStore
from scripts.prepare_offline_routing import OSRM_GRAPH_PATH


class FakeResponse:
    def __init__(self, payload: dict) -> None:
        self.body = json.dumps(payload).encode("utf-8")

    def __enter__(self) -> "FakeResponse":
        return self

    def __exit__(self, *args: object) -> None:
        return None

    def read(self) -> bytes:
        return self.body


class OfflineCatalogTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        database_path = Path(self.temp_dir.name) / "offline.db"
        self.store = LocalStore(database_path)
        cities = [{"name": "Полоцк", "latitude": 55.4879, "longitude": 28.7856, "geoname_id": 623317}]
        places = [{
            "city": "Полоцк",
            "name": "Софийский собор",
            "category": "Архитектура",
            "latitude": 55.4858,
            "longitude": 28.7583,
            "wikidata_id": "Q2465016",
            "description": "Собор в Полоцке",
            "history": "Построен в XI веке",
            "image_source_url": "https://example.invalid/sofia.jpg",
            "images": [],
        }]
        self.store.replace_belarus_catalog(cities, places)
        self.server = start_map_server(self.store)
        self.connection = HTTPConnection("127.0.0.1", self.server.server_port)

    def tearDown(self) -> None:
        self.connection.close()
        self.server.shutdown()
        self.server.server_close()
        self.temp_dir.cleanup()

    def get_json(self, path: str) -> tuple[int, dict]:
        self.connection.request("GET", path)
        response = self.connection.getresponse()
        return response.status, json.loads(response.read().decode("utf-8"))

    def get_bytes(self, path: str) -> tuple[int, bytes]:
        self.connection.request("GET", path)
        response = self.connection.getresponse()
        return response.status, response.read()

    def test_bootstrap_only_lists_belarus_and_has_polotsk(self) -> None:
        status, payload = self.get_json("/api/bootstrap?city=%D0%9C%D0%BE%D1%81%D0%BA%D0%B2%D0%B0")
        self.assertEqual(status, 200)
        self.assertEqual(payload["city"], "Полоцк")
        self.assertEqual(payload["cities"], ["Полоцк"])
        self.assertEqual(payload["places"][0]["name"], "Софийский собор")
        self.assertEqual(payload["places"][0]["image_url"], "/api/photo/1")

    def test_route_uses_local_osrm_and_returns_steps(self) -> None:
        osrm = {
            "code": "Ok",
            "routes": [{
                "geometry": {"type": "LineString", "coordinates": [[28.78, 55.48], [28.75, 55.48]]},
                "distance": 1250,
                "duration": 720,
                "legs": [{"steps": [{"name": "Замковая улица", "distance": 80, "maneuver": {"type": "turn", "modifier": "left"}}]}],
            }],
        }
        with patch("client.main.urllib.request.urlopen", return_value=FakeResponse(osrm)) as open_url:
            status, payload = self.get_json("/api/route?from=55.48,28.78&to=55.48,28.75")
        self.assertEqual(status, 200)
        self.assertTrue(payload["offline"])
        self.assertEqual(payload["distance"], 1250)
        self.assertEqual(payload["steps"][0]["name"], "Замковая улица")
        self.assertIn("127.0.0.1:5000/route/v1/foot/28.78,55.48;28.75,55.48", open_url.call_args.args[0].full_url)

    def test_car_route_uses_driving_profile_and_is_online(self) -> None:
        osrm = {
            "code": "Ok",
            "routes": [{
                "geometry": {"type": "LineString", "coordinates": [[28.78, 55.48], [28.75, 55.48]]},
                "distance": 1250,
                "duration": 180,
                "legs": [{"steps": [{"name": "проспект", "distance": 100, "maneuver": {"type": "turn", "modifier": "right", "location": [28.77, 55.48]}}]}],
            }],
        }
        with patch("client.main.urllib.request.urlopen", return_value=FakeResponse(osrm)) as open_url:
            status, payload = self.get_json("/api/route?from=55.48,28.78&to=55.48,28.75&mode=drive")
        self.assertEqual(status, 200)
        self.assertFalse(payload["offline"])
        self.assertEqual(payload["mode"], "drive")
        self.assertEqual(payload["steps"][0]["location"], [28.77, 55.48])
        self.assertIn("router.project-osrm.org/route/v1/driving/", open_url.call_args.args[0].full_url)

    def test_https_route_retries_with_verified_system_curl_after_tls_error(self) -> None:
        url = "https://router.project-osrm.org/route/v1/driving/27.5,53.9;28.7,55.4"
        route = {"code": "Ok", "routes": [{"distance": 10}]}
        process = subprocess.CompletedProcess(["curl"], 0, json.dumps(route), "")
        with (
            patch("client.main.urllib.request.urlopen", side_effect=URLError(ssl.SSLError("handshake failed"))),
            patch("client.main.shutil.which", return_value="/usr/bin/curl"),
            patch("client.main.subprocess.run", return_value=process) as run_curl,
        ):
            result = fetch_route_json(url)
        self.assertEqual(result["code"], "Ok")
        command = run_curl.call_args.args[0]
        self.assertIn("--proto", command)
        self.assertIn("=https", command)
        self.assertIn(url, command)

    def test_first_viewed_photo_is_persisted(self) -> None:
        place = self.store.get_places(city="Полоцк")[0]
        self.store.cache_place_photo(int(place["id"]), "offline/images/Q2465016_viewed.jpg")
        cached = self.store.get_place_photo(int(place["id"]))
        self.assertEqual(cached["image_path"], "offline/images/Q2465016_viewed.jpg")
        self.assertIn("Q2465016_viewed.jpg", cached["gallery_json"])

    def test_profile_api_persists_name_and_visited_places(self) -> None:
        payload = {"name": "Алиса", "visited_places": [{"id": 1, "name": "Софийский собор", "city": "Полоцк"}]}
        self.connection.request(
            "POST",
            "/api/profile",
            json.dumps(payload, ensure_ascii=False).encode("utf-8"),
            {"Content-Type": "application/json"},
        )
        response = self.connection.getresponse()
        saved = json.loads(response.read().decode("utf-8"))
        self.assertEqual(response.status, 200)
        self.assertEqual(saved["name"], "Алиса")
        status, loaded = self.get_json("/api/profile")
        self.assertEqual(status, 200)
        self.assertEqual(loaded["visited_places"][0]["city"], "Полоцк")

    def test_city_highlights_include_featured_place_and_photo(self) -> None:
        status, payload = self.get_json(f"/api/city-highlights?city={quote('Полоцк')}")
        self.assertEqual(status, 200)
        self.assertEqual(payload["highlights"][0]["place"], "Софийский собор")
        self.assertEqual(payload["highlights"][0]["image_url"], "/api/photo/1?size=320")

    def test_offline_routing_graph_matches_compose_service(self) -> None:
        self.assertEqual(OSRM_GRAPH_PATH.name, "belarus.osrm")
        self.assertTrue(str(OSRM_GRAPH_PATH).endswith("data/osrm/belarus.osrm"))

    def test_missing_tile_serves_placeholder_instead_of_403(self) -> None:
        with patch("client.main.urllib.request.urlopen", side_effect=OSError("blocked by OpenStreetMap")):
            status, payload = self.get_bytes("/api/tiles/14/9502/5145.png")
        self.assertEqual(status, 200)
        self.assertTrue(payload.startswith(b"\x89PNG"))


if __name__ == "__main__":
    unittest.main()
import importlib
import unittest


class ImportCatalogTests(unittest.TestCase):
    def test_import_module_loads_and_includes_polotsk_bbox(self):
        module = importlib.import_module("scripts.import_city_catalog")
        self.assertIn('node["tourism"="attraction"]', module.OVERPASS_QUERY_TEMPLATE)
        self.assertIn("Полоцк", module.CITY_BOXES)
        self.assertEqual(module.CITY_BOXES["Полоцк"], (55.45, 28.70, 55.55, 28.95))

    def test_deduplicate_places_removes_duplicate_wikidata_entries(self):
        module = importlib.import_module("scripts.import_city_catalog")
        places = [
            {"city": "Полоцк", "name": "Софийский собор", "wikidata_id": "Q2465016", "source_url": "https://example.com/1"},
            {"city": "Полоцк", "name": "Софийский собор", "wikidata_id": "Q2465016", "source_url": "https://example.com/1"},
            {"city": "Полоцк", "name": "Другой объект", "wikidata_id": "Q9999999", "source_url": "https://example.com/2"},
        ]
        deduped = module.deduplicate_places(places)
        self.assertEqual(len(deduped), 2)
        self.assertEqual({p["wikidata_id"] for p in deduped}, {"Q2465016", "Q9999999"})


if __name__ == "__main__":
    unittest.main()

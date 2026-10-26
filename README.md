# Умный гид по городу

Кроссплатформенное desktop-приложение на Python с клиент-серверным режимом и офлайн-пакетами городов.

## Структура проекта

```text
.
├── backend/
│   ├── __init__.py
│   ├── database.py       # async SQLAlchemy engine, sessions, PostGIS init
│   └── models.py         # City, Category, Place, place_categories
├── client/
│   └── __init__.py       # Flet-клиент добавляется на шаге 4
├── data/                 # локальные офлайн-файлы и импортированные данные
├── scripts/              # Overpass/OSM импорт добавляется на шаге 3
├── tests/                # тесты backend и client
├── .env.example
├── docker-compose.yml
└── requirements.txt
```

## Требования

- macOS 12+;
- Python 3.11+;
- Docker Desktop (для локального PostgreSQL/PostGIS).

## Запуск PostgreSQL/PostGIS

```bash
docker compose up -d db
cp .env.example .env
python3 -m venv .venv
source .venv/bin/activate
python -m pip install --upgrade pip
python -m pip install -r requirements.txt
```

Инициализация таблиц выполняется вызовом `await init_database()` из `backend.database` после запуска FastAPI. Для production-среды вместо `Base.metadata.create_all` следует подключить Alembic-миграции.

## Запуск desktop-клиента

В отдельном терминале, пока Docker и API работают:

```bash
source .venv/bin/activate
python -m client.main
```

При запуске `python -m client.main` открывается единое окно приложения: слева города, категории, поиск и список мест из SQLite, справа постоянно видна интерактивная карта. Кнопка «Найти меня на карте» запрашивает системный доступ к геопозиции macOS, показывает вашу позицию и расстояния до мест; если разрешение отклонено, включите его для запустившего приложение процесса в «Системные настройки → Конфиденциальность и безопасность → Службы геолокации».
Для OSM-подложки и определения местоположения нужен интернет; API-ключ OSM не нужен. Online-пешеходный маршрут в MVP запрашивается у публичного OSRM demo-сервера. У него нет гарантии доступности и коммерческого SLA, поэтому для production лучше поднять собственный OSRM/Valhalla или подключить провайдера с ключом.

## Геоданные

Колонки `cities.center`, `cities.boundary` и `places.location` используют PostGIS `GEOGRAPHY` в SRID 4326. Для записи координат используйте `geoalchemy2.shape.from_shape` и объект Shapely, например `Point(longitude, latitude)`.

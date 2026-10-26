const requestedCity = new URLSearchParams(location.search).get('city') || 'Минск';
const citySelect = document.getElementById('city-select');
const citySearch = document.getElementById('city-search');
const citySuggestions = document.getElementById('city-suggestions');
const placeList = document.getElementById('place-list');
const locationStatus = document.getElementById('location-status');
const loading = document.getElementById('loading');
const themeToggle = document.getElementById('theme-toggle');
const sortSelect = document.getElementById('sort-select');
const placeBrowser = document.getElementById('place-browser');
const mapPlaceSlot = document.getElementById('map-place-slot');
const placesPlaceSlot = document.getElementById('places-place-slot');
const mapView = document.getElementById('map-view');
const sidebarToggle = document.getElementById('sidebar-toggle');
let map;
let mapInitialization = null;
let cityLoadSequence = 0;
let currentCity = requestedCity;
let places = [];
let markers = new Map();
let selectedCategories = new Set();
let selectedPlaceIds = new Set();
let activeRoute = null;
let routeData = null;
let travelMode = 'walk';
let navigationActive = false;
let navigationWatchId = null;
let navigationLocationPolling = null;
let navigationStepIndex = 0;
let routeRequestSequence = 0;
let userMarker = null;
let userLocation = null;
let cityCenters = {};
let hoverTimer = null;
let hoveredPlaceId = null;
let visitedPlaces = readVisitedPlaces();
let randomPlaceId = null;
let miniGameQuestions = [];
let miniGameAnswers = {};
let miniGameStep = 0;
let miniGameRecommendation = null;
let jumpGame = null;
let jumpFrame = null;
let jumpHeld = {left: false, right: false};
let jumpPlaces = [];
let jumpCatalogPromise = null;
const jumpAudio = {
	music: new Audio('/static/GameSound/background.mp3'),
	correct: new Audio('/static/GameSound/CorrectAnswer.mp3'),
	incorrect: new Audio('/static/GameSound/UncorrectAnswer.mp3'),
	dead: new Audio('/static/GameSound/Dead.mp3'),
	hit: new Audio('/static/GameSound/hit.mp3')
};
jumpAudio.music.loop = true;
jumpAudio.music.volume = 0.35;
Object.values(jumpAudio).forEach(sound => { sound.preload = 'auto'; });
['correct', 'incorrect', 'dead', 'hit'].forEach(name => jumpAudio[name].load());

function playJumpSound(name) {
	const sound = jumpAudio[name];
	if (!sound) return;
	if (name !== 'music') sound.currentTime = 0;
	const playback = sound.play();
	if (playback?.catch) playback.catch(() => {});
}

function stopJumpMusic() {
	jumpAudio.music.pause();
	jumpAudio.music.currentTime = 0;
}

function stopJumpEffects() {
	['correct', 'incorrect', 'dead', 'hit'].forEach(name => {
		jumpAudio[name].pause();
		jumpAudio[name].currentTime = 0;
	});
}
const jumpDifficulties = {
	easy: {moveSpeed: 2.2, gravity: 0.20, jumpVelocity: -6.5, minGap: 54, gapRange: 12, spikeChance: 0.035, crumbleChance: 0.10},
	normal: {moveSpeed: 2.8, gravity: 0.23, jumpVelocity: -7, minGap: 58, gapRange: 16, spikeChance: 0.075, crumbleChance: 0.17},
	hard: {moveSpeed: 3.5, gravity: 0.27, jumpVelocity: -7.6, minGap: 63, gapRange: 19, spikeChance: 0.13, crumbleChance: 0.26}
};
let jumpRecord = (() => {
	try { return Number(localStorage.getItem('smart-guide-jump-record')) || 0; } catch (_) { return 0; }
})();
let rouletteCity = null;
let rouletteRunning = false;
let profileSaveQueue = Promise.resolve();
let activeCitySuggestionIndex = -1;
let offlineCities = readOfflineCities();
let offlineCityFilterEnabled = false;
let offlineStartupMode = false;
let offlineInternetMonitor = null;
let lastConnectivityResult = null;
let monitoredConnectivity = null;
let networkNoticeDismissed = false;
let startupLocationCity = null;
let setupSelectedCities = new Set();
let startupDecisionHandler = null;
let mapProvider = (() => {
	try {
		const saved = localStorage.getItem('smart-guide-map-provider');
		const wasChosen = localStorage.getItem('smart-guide-map-provider-user') === '1';
		return saved === 'offline' && wasChosen ? 'offline' : 'yandex';
	} catch (_) { return 'yandex'; }
})();
let activeMapProvider = null;
let yandexApiLoading = null;
let yandexApi = null;
let configuredYandexApiKey = null;

function readVisitedPlaces() {
	try {
		const saved = JSON.parse(localStorage.getItem('smart-guide-visited') || '[]');
		return Array.isArray(saved) ? saved : [];
	} catch (_) {
		return [];
	}
}

function readOfflineCities() {
	try {
		const saved = JSON.parse(localStorage.getItem('smart-guide-offline-cities') || '[]');
		return Array.isArray(saved) ? saved.filter(city => typeof city === 'string') : [];
	} catch (_) {
		return [];
	}
}

function setLocationStatus(message, isError = false) {
	locationStatus.textContent = message;
	locationStatus.classList.toggle('error', isError);
}

function distanceBetween(first, second) {
	const radians = value => value * Math.PI / 180;
	const latitudeDelta = radians(second[0] - first[0]);
	const longitudeDelta = radians(second[1] - first[1]);
	const value = Math.sin(latitudeDelta / 2) ** 2
		+ Math.cos(radians(first[0])) * Math.cos(radians(second[0])) * Math.sin(longitudeDelta / 2) ** 2;
	return 6371 * 2 * Math.atan2(Math.sqrt(value), Math.sqrt(1 - value));
}

function formatDistance(kilometers) {
	return kilometers < 1 ? `${Math.round(kilometers * 1000)} м` : `${kilometers.toFixed(1)} км`;
}

function closeCitySuggestions() {
	citySuggestions.hidden = true;
	citySearch.setAttribute('aria-expanded', 'false');
	citySearch.removeAttribute('aria-activedescendant');
	activeCitySuggestionIndex = -1;
}

function renderCitySuggestions(query) {
	const normalizedQuery = query.trim().toLocaleLowerCase('ru');
	citySuggestions.replaceChildren();
	activeCitySuggestionIndex = -1;
	if (!normalizedQuery) {
		closeCitySuggestions();
		return;
	}
	const matches = [...citySelect.options]
		.map(option => option.value)
		.filter(name => name.toLocaleLowerCase('ru').includes(normalizedQuery))
		.sort((first, second) => {
			const firstStarts = first.toLocaleLowerCase('ru').startsWith(normalizedQuery);
			const secondStarts = second.toLocaleLowerCase('ru').startsWith(normalizedQuery);
			return Number(secondStarts) - Number(firstStarts) || first.localeCompare(second, 'ru');
		})
		.slice(0, 8);
	if (!matches.length) {
		const empty = document.createElement('div');
		empty.className = 'city-suggestions-empty';
		empty.textContent = offlineCityFilterEnabled && !citySelect.options.length ? 'Нет сохранённых офлайн-городов' : 'Город не найден';
		citySuggestions.append(empty);
		citySuggestions.hidden = false;
		citySearch.setAttribute('aria-expanded', 'true');
		return;
	}
	matches.forEach((name, index) => {
		const option = document.createElement('button');
		option.className = 'city-suggestion';
		option.type = 'button';
		option.id = `city-suggestion-${index}`;
		option.setAttribute('role', 'option');
		option.setAttribute('aria-selected', 'false');
		const title = document.createElement('strong');
		title.textContent = name;
		const country = document.createElement('span');
		country.textContent = 'Беларусь';
		option.append(title, country);
		option.addEventListener('pointerdown', event => {
			event.preventDefault();
			selectCity(name);
		});
		citySuggestions.append(option);
	});
	citySuggestions.hidden = false;
	citySearch.setAttribute('aria-expanded', 'true');
}

function moveCitySuggestion(direction) {
	const options = citySuggestions.querySelectorAll('[role="option"]');
	if (!options.length) return false;
	activeCitySuggestionIndex = (activeCitySuggestionIndex + direction + options.length) % options.length;
	options.forEach((option, index) => {
		const active = index === activeCitySuggestionIndex;
		option.classList.toggle('active', active);
		option.setAttribute('aria-selected', String(active));
	});
	const activeOption = options[activeCitySuggestionIndex];
	citySearch.setAttribute('aria-activedescendant', activeOption.id);
	activeOption.scrollIntoView({block: 'nearest'});
	return true;
}

function selectCity(name) {
	citySearch.value = name;
	closeCitySuggestions();
	if (!citySelect.options.length || ![...citySelect.options].some(option => option.value === name)) return;
	if (citySelect.value !== name) {
		citySelect.value = name;
		citySelect.dispatchEvent(new Event('change'));
	}
}

class LeafletGeoObjects {
	constructor(owner) { this.owner = owner; this.items = new Set(); }
	add(item) {
		if (!item || !item._leafletLayer) return;
		this.items.add(item);
		item._leafletLayer.addTo(this.owner.leaflet);
		item._bindEvents();
	}
	remove(item) {
		if (!item) return;
		this.items.delete(item);
		if (this.owner.leaflet.hasLayer(item._leafletLayer)) this.owner.leaflet.removeLayer(item._leafletLayer);
	}
	indexOf(item) { return this.items.has(item) ? 0 : -1; }
}

function readMvtVarint(bytes, state) {
	let value = 0;
	let shift = 0;
	while (state.offset < bytes.length && shift < 53) {
		const byte = bytes[state.offset++];
		value += (byte & 0x7f) * (2 ** shift);
		if (!(byte & 0x80)) return value;
		shift += 7;
	}
	return value;
}

function readMvtFields(bytes) {
	const fields = [];
	const state = {offset: 0};
	while (state.offset < bytes.length) {
		const tag = readMvtVarint(bytes, state);
		const field = tag >> 3;
		const wire = tag & 7;
		if (wire === 0) fields.push([field, wire, readMvtVarint(bytes, state)]);
		else if (wire === 2) {
			const length = readMvtVarint(bytes, state);
			fields.push([field, wire, bytes.subarray(state.offset, state.offset + length)]);
			state.offset += length;
		} else if (wire === 1) state.offset += 8;
		else if (wire === 5) state.offset += 4;
		else break;
	}
	return fields;
}

function decodeMvtRoads(buffer) {
	const bytes = new Uint8Array(buffer);
	const roads = [];
	for (const [field, wire, layerBytes] of readMvtFields(bytes)) {
		if (field !== 3 || wire !== 2) continue;
		let extent = 4096;
		const features = [];
		for (const [layerField, layerWire, value] of readMvtFields(layerBytes)) {
			if (layerField === 5 && layerWire === 0) extent = value;
			if (layerField !== 2 || layerWire !== 2) continue;
			let geometryType = 0;
			let geometry = null;
			for (const [featureField, featureWire, featureValue] of readMvtFields(value)) {
				if (featureField === 3 && featureWire === 0) geometryType = featureValue;
				if (featureField === 4 && featureWire === 2) geometry = featureValue;
			}
			if (geometryType === 2 && geometry) features.push(geometry);
		}
		for (const geometry of features) roads.push({geometry, extent});
	}
	return roads;
}

function drawMvtRoadTile(canvas, buffer, zoom) {
	const ctx = canvas.getContext('2d');
	const size = canvas.width;
	ctx.fillStyle = '#e4e9e3';
	ctx.fillRect(0, 0, size, size);
	const roads = decodeMvtRoads(buffer);
	const width = Math.max(.65, Math.min(2.5, (zoom - 7) * .15));
	for (const {geometry, extent} of roads) {
		const state = {offset: 0};
		let x = 0;
		let y = 0;
		ctx.beginPath();
		while (state.offset < geometry.length) {
			const command = readMvtVarint(geometry, state);
			const operation = command & 7;
			const count = command >> 3;
			for (let i = 0; i < count; i++) {
				if (operation === 1 || operation === 2) {
					const dx = readMvtVarint(geometry, state);
					const dy = readMvtVarint(geometry, state);
					x += (dx >> 1) ^ -(dx & 1);
					y += (dy >> 1) ^ -(dy & 1);
					const px = x / extent * size;
					const py = y / extent * size;
					if (operation === 1) ctx.moveTo(px, py);
					else ctx.lineTo(px, py);
				} else if (operation === 7) ctx.closePath();
				else break;
			}
		}
		ctx.lineJoin = 'round';
		ctx.lineCap = 'round';
		ctx.strokeStyle = '#fffdf8';
		ctx.lineWidth = width + 1.5;
		ctx.stroke();
		ctx.strokeStyle = '#82958a';
		ctx.lineWidth = width;
		ctx.stroke();
	}
}

function createOfflineRoadLayer() {
	return window.L.GridLayer.extend({
		createTile(coords, done) {
			const canvas = document.createElement('canvas');
			const size = this.getTileSize();
			canvas.width = size.x;
			canvas.height = size.y;
		let attempts = 0;
		const requestTile = async () => {
			try {
				const response = await fetch(`/api/offline/roads/${coords.z}/${coords.x}/${coords.y}.mvt`);
				if (!response.ok) {
					const error = await response.json().catch(() => ({}));
					if (error.status === 'starting' && attempts++ < 30) {
						const status = document.getElementById('map-provider-status');
						if (status) status.textContent = error.error;
						window.setTimeout(requestTile, 1800);
						return;
					}
					throw new Error(error.error || 'Локальная карта дорог недоступна');
				}
				drawMvtRoadTile(canvas, await response.arrayBuffer(), coords.z);
				done(null, canvas);
			} catch (error) {
				drawMvtRoadTile(canvas, new ArrayBuffer(0), coords.z);
				if (!document.body.dataset.offlineMapError) {
					document.body.dataset.offlineMapError = 'shown';
					const status = document.getElementById('map-provider-status');
					if (status) status.textContent = error.message;
				}
				done(null, canvas);
			}
		};
		requestTile();
			return canvas;
		}
	});
}

class LeafletMapAdapter {
	constructor(elementId, options) {
		this.leaflet = window.L.map(elementId, {zoomControl: false, preferCanvas: true}).setView(options.center, options.zoom);
		this.geoObjects = new LeafletGeoObjects(this);
		this.container = {fitToViewport: () => this.leaflet.invalidateSize({pan: false})};
		window.L.control.zoom({position: 'bottomright'}).addTo(this.leaflet);
		const OfflineRoadTiles = createOfflineRoadLayer();
		new OfflineRoadTiles({minZoom: 5, maxZoom: 19, keepBuffer: 2, updateWhenIdle: true}).addTo(this.leaflet);
	}
	getCenter() { const center = this.leaflet.getCenter(); return [center.lat, center.lng]; }
	getZoom() { return this.leaflet.getZoom(); }
	setCenter(center, zoom = this.getZoom(), options = {}) {
		const duration = Number(options.duration) || 0;
		if (duration > 0) this.leaflet.flyTo(center, zoom, {duration: duration / 1000, easeLinearity: 0.25});
		else this.leaflet.setView(center, zoom, {animate: true, duration: 0.35});
	}
	setView(center, zoom) { this.leaflet.setView(center, zoom, {animate: true, duration: 0.45}); }
	flyTo(center, zoom, options = {}) { this.leaflet.flyTo(center, zoom, {duration: options.duration || 0.6}); }
	setBounds(bounds, options = {}) { this.leaflet.fitBounds(bounds, {padding: options.padding || [32, 32], animate: true}); }
	invalidateSize() { this.leaflet.invalidateSize({pan: false}); }
}

class LeafletPlacemark {
	constructor(coordinates, properties = {}, options = {}) {
		if (options.userLocation) {
			const icon = window.L.divIcon({
				className: 'offline-user-location-marker-shell',
				html: '<span class="offline-user-location-dot">⌖</span><span class="offline-user-location-label">Вы здесь</span>',
				iconSize: [110, 36],
				iconAnchor: [18, 18]
			});
			this._leafletLayer = window.L.marker(coordinates, {icon, keyboard: true, title: 'Ваше местоположение', zIndexOffset: 20000});
			this._eventHandlers = [];
			this.events = {add: (name, callback) => this._eventHandlers.push([name, callback])};
			this.options = {set: (name, value) => { if (name === 'zIndex') this._leafletLayer.setZIndexOffset(value); }};
			this.geometry = {setCoordinates: next => this._leafletLayer.setLatLng(next)};
			return;
		}
		const color = options.iconColor || '#397f73';
		const glyph = properties.iconContent || '•';
		const icon = window.L.divIcon({
			className: 'offline-map-marker-shell',
			html: `<span class="offline-map-marker" style="--marker-color:${color}"><span>${glyph}</span></span>`,
			iconSize: [34, 42],
			iconAnchor: [17, 37]
		});
		this._leafletLayer = window.L.marker(coordinates, {icon, keyboard: true, zIndexOffset: options.zIndex || 0});
		this._eventHandlers = [];
		this.events = {add: (name, callback) => this._eventHandlers.push([name, callback])};
		this._zIndexHover = options.zIndexHover || 10000;
		this.options = {set: (name, value) => {
			if (name === 'zIndex') this._leafletLayer.setZIndexOffset(value);
			if (name === 'zIndexHover') this._zIndexHover = value;
		}};
		this.geometry = {setCoordinates: next => this._leafletLayer.setLatLng(next)};
	}
	_bindEvents() {
		const names = {mouseenter: 'mouseover', mousemove: 'mousemove', mouseleave: 'mouseout', click: 'click'};
		for (const [name, callback] of this._eventHandlers) {
			this._leafletLayer.off(names[name]);
			this._leafletLayer.on(names[name], event => callback({originalEvent: event.originalEvent, latlng: event.latlng}));
		}
	}
}

function createUserPlacemark(coordinates) {
	return new window.ymaps.Placemark(coordinates, {}, {preset: 'islands#redCircleIcon', iconColor: '#df654f', userLocation: true});
}

class LeafletPolyline {
	constructor(coordinates, _properties = {}, options = {}) {
		this._leafletLayer = window.L.polyline(coordinates, {
			color: options.strokeColor || '#4d9b76',
			weight: options.strokeWidth || 6,
			opacity: options.strokeOpacity || 0.9
		});
		this.geometry = {getBounds: () => this._leafletLayer.getBounds()};
		this._bindEvents = () => {};
	}
}

class YandexMapAdapter {
	constructor(elementId, options) {
		this.native = new window.ymaps.Map(elementId, {center: options.center, zoom: options.zoom, controls: ['zoomControl']});
		this.geoObjects = this.native.geoObjects;
		this.container = this.native.container;
	}
	getCenter() { const center = this.native.getCenter(); return [center[0], center[1]]; }
	getZoom() { return this.native.getZoom(); }
	setCenter(center, zoom = this.getZoom(), options = {}) { return this.native.setCenter(center, zoom, {duration: Number(options.duration) || 0}); }
	setView(center, zoom) { return this.native.setCenter(center, zoom, {duration: 350}); }
	flyTo(center, zoom, options = {}) { return this.native.setCenter(center, zoom, {duration: Math.round((options.duration || .6) * 1000)}); }
	setBounds(bounds, options = {}) { return this.native.setBounds(bounds, {checkZoomRange: options.checkZoomRange, margin: options.padding || [32, 32]}); }
	invalidateSize() { this.native.container.fitToViewport(); }
	destroy() { this.native.destroy(); }
}

const leafletYmapsFacade = {
	Map: LeafletMapAdapter,
	Placemark: LeafletPlacemark,
	Polyline: LeafletPolyline,
	ready: callback => callback()
};

function loadYandexApi() {
	if (yandexApi) { window.ymaps = yandexApi; return Promise.resolve(yandexApi); }
	if (yandexApiLoading) return yandexApiLoading;
	yandexApiLoading = (async () => {
		if (!configuredYandexApiKey) {
			const response = await fetch('/api/map-config');
			if (!response.ok) throw new Error('Не удалось прочитать настройки карты');
			const config = await response.json();
			configuredYandexApiKey = config.yandex_api_key || '';
		}
		if (!configuredYandexApiKey) throw new Error('Ключ Яндекс Карт не настроен на сервере');
		return new Promise((resolve, reject) => {
			const script = document.createElement('script');
			script.src = `https://api-maps.yandex.ru/2.1/?apikey=${encodeURIComponent(configuredYandexApiKey)}&lang=ru_RU`;
			script.async = true;
			script.onload = () => {
				if (!window.ymaps?.ready) return reject(new Error('Яндекс Карты не загрузились'));
				window.ymaps.ready(() => { yandexApi = window.ymaps; resolve(yandexApi); });
			};
			script.onerror = () => reject(new Error('Не удалось загрузить Яндекс Карты. Проверьте интернет и ключ API.'));
			document.head.append(script);
		});
	})().catch(error => {
		yandexApiLoading = null;
		throw error;
	});
	return yandexApiLoading;
}

function initializeMap(center) {
	if (map) return Promise.resolve(map);
	if (mapInitialization) return mapInitialization;
	mapInitialization = (async () => {
		if (mapProvider === 'yandex') {
			try {
				await loadYandexApi();
				if (mapProvider === 'yandex') {
					activeMapProvider = 'yandex';
					map = new YandexMapAdapter('map', {center, zoom: 13});
				}
			} catch (error) {
				mapProvider = 'offline';
				activeMapProvider = 'offline';
				try { localStorage.setItem('smart-guide-map-provider', 'offline'); } catch (_) {}
				window.ymaps = leafletYmapsFacade;
				document.getElementById('map-provider').value = 'offline';
				document.getElementById('map-provider-status').textContent = `${error.message} Переключена офлайн-карта.`;
			}
		}
		if (!map) {
			if (!window.L) throw new Error('Офлайн-карта не загрузилась');
			window.ymaps = leafletYmapsFacade;
			activeMapProvider = 'offline';
			map = new LeafletMapAdapter('map', {center, zoom: 13});
		}
		updateMapProviderLabels();
		return new Promise(resolve => window.requestAnimationFrame(() => {
			map.invalidateSize();
			resolve(map);
		}));
	})().catch(error => {
		mapInitialization = null;
		throw error;
	});
	return mapInitialization;
}

function updateMapProviderLabels() {
	const isYandex = activeMapProvider === 'yandex';
	document.getElementById('map-subtitle').textContent = isYandex ? 'Яндекс Карты' : 'Офлайн-карта';
	document.getElementById('map-attribution').innerHTML = isYandex ? 'Яндекс Карты' : 'Дорожный граф © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap</a>';
	const status = document.getElementById('map-provider-status');
	if (status) status.textContent = isYandex ? 'Яндекс Карты · онлайн' : 'Офлайн-карта · локальный граф дорог';
}

async function switchMapProvider(nextProvider) {
	const status = document.getElementById('map-provider-status');
	const selector = document.getElementById('map-provider');
	status.textContent = nextProvider === 'yandex' ? 'Подключаем Яндекс Карты…' : 'Загружаем офлайн-карту…';
	if (nextProvider === 'yandex') {
		try {
			if (!configuredYandexApiKey) {
				const response = await fetch('/api/map-config');
				const config = await response.json();
				configuredYandexApiKey = config.yandex_api_key || '';
			}
		} catch (_) {}
		if (!configuredYandexApiKey) {
			status.textContent = 'Ключ Яндекс Карт не настроен на сервере.';
			selector.value = activeMapProvider || 'offline';
			return false;
		}
	}
	if (navigationActive) stopNavigation(false);
	if (map?.destroy) map.destroy();
	else if (map?.leaflet) map.leaflet.remove();
	map = null;
	mapInitialization = null;
	delete document.body.dataset.offlineMapError;
	activeRoute = null;
	userMarker = null;
	markers.clear();
	mapProvider = nextProvider;
	try {
		localStorage.setItem('smart-guide-map-provider', nextProvider);
		localStorage.setItem('smart-guide-map-provider-user', '1');
	} catch (_) {}
	try {
		await initializeMap(cityCenters[currentCity] || [53.9, 27.5667]);
		renderMarkers();
		if (userLocation) {
			userMarker = createUserPlacemark(userLocation);
			map.geoObjects.add(userMarker);
		}
		if (activeMapProvider !== nextProvider) {
			selector.value = activeMapProvider || 'offline';
			status.textContent = nextProvider === 'yandex'
				? 'Яндекс Карты не загрузились. Оставлена офлайн-карта.'
				: 'Офлайн-карта не загрузилась.';
			return false;
		}
		selector.value = activeMapProvider;
		status.textContent = nextProvider === 'yandex' ? 'Яндекс Карты · онлайн' : 'Офлайн-карта · локальный граф дорог';
		return true;
	} catch (error) {
		status.textContent = error.message || 'Не удалось переключить карту';
		selector.value = activeMapProvider || 'offline';
		return false;
	}
}

function photoSources(place) {
	const sources = Array.isArray(place.images) ? [...place.images] : [];
	return sources;
}

function fallbackPhoto(place, size = 720) {
	const source = place.photo_url || place.image_url || place.image_source_url || '';
	if (source.startsWith('/api/photo/')) return `${source}?size=${size}`;
	return source || (place.id != null ? `/api/photo/${place.id}?size=${size}` : '');
}

function hideHoverPreview(delay = 80) {
	window.clearTimeout(hoverTimer);
	hoverTimer = window.setTimeout(() => {
		document.getElementById('hover-preview').classList.remove('visible');
		hoveredPlaceId = null;
	}, typeof delay === 'number' ? delay : 80);
}

function positionHoverPreview(x, y) {
	const preview = document.getElementById('hover-preview');
	const bounds = document.getElementById('map').getBoundingClientRect();
	const anchorX = Number.isFinite(x) ? x : bounds.left + bounds.width / 2;
	const anchorY = Number.isFinite(y) ? y : bounds.top + bounds.height / 2;
	const previewWidth = preview.offsetWidth || 272;
	const previewHeight = preview.offsetHeight || 180;
	const left = anchorX + previewWidth + 20 > window.innerWidth ? anchorX - previewWidth - 14 : anchorX + 14;
	const top = anchorY + previewHeight + 16 > window.innerHeight ? anchorY - previewHeight - 12 : anchorY + 12;
	preview.style.left = `${Math.max(8, Math.min(left, window.innerWidth - previewWidth - 8))}px`;
	preview.style.top = `${Math.max(8, Math.min(top, window.innerHeight - previewHeight - 8))}px`;
}

function showHoverPreview(place, x, y) {
	const preview = document.getElementById('hover-preview');
	window.clearTimeout(hoverTimer);
	if (hoveredPlaceId === place.id && preview.classList.contains('visible')) {
		positionHoverPreview(x, y);
		return;
	}
	hoveredPlaceId = place.id;
	preview.dataset.placeId = String(place.id);
	preview.replaceChildren();
	const sources = [...photoSources(place), fallbackPhoto(place, 320)].filter(Boolean);
	if (sources.length) {
		const image = document.createElement('img');
		image.decoding = 'async';
		image.fetchPriority = 'high';
		let sourceIndex = 0;
		image.src = sources[0];
		image.alt = place.name;
		image.onerror = () => {
			sourceIndex += 1;
			if (sourceIndex < sources.length) image.src = sources[sourceIndex];
			else image.remove();
		};
		preview.append(image);
	} else {
		const empty = document.createElement('div');
		empty.className = 'empty-state';
		empty.textContent = 'Фото не добавлено в открытые источники';
		preview.append(empty);
	}
	const name = document.createElement('strong');
	name.textContent = place.name;
	const category = document.createElement('span');
	category.textContent = `${place.category} · ${place.rating == null ? 'Без рейтинга' : `★ ${Number(place.rating).toFixed(1)}`}`;
	preview.append(name, category);
	const description = document.createElement('p');
	description.textContent = place.description || 'Описание пока отсутствует в источнике.';
	preview.append(description);
	preview.classList.add('visible');
	positionHoverPreview(x, y);
}

function markerStyle(category) {
	const value = String(category || '').toLocaleLowerCase('ru');
	if (/кафе|ресторан|еда|бар/.test(value)) return {glyph: '☕', color: '#c36b3d'};
	if (/парк|природ|сад|сквер/.test(value)) return {glyph: '♧', color: '#47865f'};
	if (/музе|галере/.test(value)) return {glyph: '▤', color: '#4779a5'};
	if (/церк|собор|монаст|храм/.test(value)) return {glyph: '✛', color: '#9a6da9'};
	if (/истор|памят|археолог/.test(value)) return {glyph: '◆', color: '#b68136'};
	if (/архитект|достопримеч|замок/.test(value)) return {glyph: '⌂', color: '#397f73'};
	return {glyph: '★', color: '#677f9c'};
}

function markerEventPoint(event, place) {
	const domEvent = event?.get?.('domEvent') ?? event?.domEvent ?? event;
	const originalEvent = domEvent?.get?.('originalEvent') ?? domEvent?.originalEvent ?? domEvent;
	if (Number.isFinite(originalEvent?.clientX) && Number.isFinite(originalEvent?.clientY)) {
		return {x: originalEvent.clientX, y: originalEvent.clientY};
	}
	if (map?.leaflet) {
		const point = map.leaflet.latLngToContainerPoint([place.latitude, place.longitude]);
		const bounds = document.getElementById('map').getBoundingClientRect();
		return {x: bounds.left + point.x, y: bounds.top + point.y};
	}
	return {x: window.innerWidth / 2, y: window.innerHeight / 2};
}

function setTheme(theme) {
	const isLight = theme === 'light';
	document.documentElement.dataset.theme = isLight ? 'light' : 'dark';
	themeToggle.textContent = isLight ? '☾' : '☼';
	themeToggle.title = isLight ? 'Включить тёмную тему' : 'Включить светлую тему';
	themeToggle.setAttribute('aria-label', themeToggle.title);
	themeToggle.setAttribute('aria-pressed', String(isLight));
	document.getElementById('light-theme').setAttribute('aria-pressed', String(isLight));
	document.getElementById('dark-theme').setAttribute('aria-pressed', String(!isLight));
	try { localStorage.setItem('smart-guide-theme', isLight ? 'light' : 'dark'); } catch (_) {}
	if (jumpGame) drawJumpGame();
}

function setActiveView(viewName) {
	if (viewName !== 'game') stopJumpMusic();
	document.querySelectorAll('[data-view-panel]').forEach(panel => {
		panel.classList.toggle('active', panel.dataset.viewPanel === viewName);
	});
	document.querySelectorAll('.nav-tab').forEach(tab => {
		const active = tab.dataset.view === viewName;
		tab.classList.toggle('active', active);
		tab.setAttribute('aria-current', active ? 'page' : 'false');
	});
	if (viewName === 'places') placesPlaceSlot.append(placeBrowser);
	else if (viewName === 'map') mapPlaceSlot.append(placeBrowser);
	if (viewName === 'map') window.requestAnimationFrame(() => map && map.invalidateSize());
}

function setMapSidebarVisible(visible) {
	mapView.classList.toggle('sidebar-hidden', !visible);
	sidebarToggle.setAttribute('aria-expanded', String(visible));
	sidebarToggle.setAttribute('aria-label', visible ? 'Скрыть панель' : 'Показать панель');
	sidebarToggle.title = visible ? 'Скрыть панель' : 'Показать панель';
	sidebarToggle.textContent = visible ? '☰' : '☷';
	try { localStorage.setItem('smart-guide-sidebar-visible', String(visible)); } catch (_) {}
}

function updateProfile() {
	document.getElementById('profile-city').textContent = currentCity;
	document.getElementById('profile-route-count').textContent = `${selectedPlaceIds.size} мест`;
	document.getElementById('profile-visited-count').textContent = `${visitedPlaces.length} мест`;
	document.getElementById('settings-catalog-count').textContent = `${places.length} мест · ${currentCity}`;
	document.getElementById('places-intro').textContent = `Подборка мест города ${currentCity}`;
	document.getElementById('places-count').textContent = `${places.length} мест`;
	document.getElementById('visited-total').textContent = String(visitedPlaces.length);
	updateOfflineCityCount();
}

function isPlaceVisited(place) {
	return visitedPlaces.some(item => item.id === place.id && item.city === place.city);
}

function saveVisitedPlaces() {
	try { localStorage.setItem('smart-guide-visited', JSON.stringify(visitedPlaces)); } catch (_) {}
	updateProfile();
	renderVisitedPlaces();
	persistProfile().catch(error => console.error('Не удалось сохранить историю посещений:', error));
}

function persistProfile() {
	const name = document.getElementById('profile-name').value.trim() || 'Гость';
	const payload = {name, visited_places: visitedPlaces};
	try {
		localStorage.setItem('smart-guide-profile-name', name);
		localStorage.setItem('smart-guide-visited', JSON.stringify(visitedPlaces));
	} catch (_) {}
	profileSaveQueue = profileSaveQueue.catch(() => {}).then(async () => {
		const response = await fetch('/api/profile', {
			method: 'POST',
			headers: {'Content-Type': 'application/json'},
			body: JSON.stringify(payload)
		});
		if (!response.ok) throw new Error(`HTTP ${response.status}`);
		return response.json();
	});
	return profileSaveQueue;
}

async function loadPersistedProfile() {
	let legacyName = 'Гость';
	try { legacyName = localStorage.getItem('smart-guide-profile-name') || 'Гость'; } catch (_) {}
	try {
		const response = await fetch('/api/profile');
		if (!response.ok) throw new Error(`HTTP ${response.status}`);
		const profile = await response.json();
		if (profile.initialized) {
			document.getElementById('profile-name').value = profile.name || 'Гость';
			visitedPlaces = Array.isArray(profile.visited_places) ? profile.visited_places : [];
		} else {
			document.getElementById('profile-name').value = legacyName;
			await persistProfile();
		}
	} catch (error) {
		console.warn('Не удалось загрузить профиль из локальной базы:', error);
		document.getElementById('profile-name').value = legacyName;
	}
	const name = document.getElementById('profile-name').value.trim() || 'Гость';
	document.getElementById('profile-avatar').textContent = name.charAt(0).toLocaleUpperCase('ru');
	updateProfile();
	renderVisitedPlaces();
}

function toggleVisitedPlace(place) {
	const existingIndex = visitedPlaces.findIndex(item => item.id === place.id && item.city === place.city);
	if (existingIndex >= 0) {
		visitedPlaces.splice(existingIndex, 1);
	} else {
		visitedPlaces.unshift({
			id: place.id,
			name: place.name,
			category: place.category,
			city: place.city || currentCity,
			latitude: place.latitude,
			longitude: place.longitude,
			visitedAt: new Date().toISOString()
		});
	}
	saveVisitedPlaces();
	const button = document.getElementById('detail-visited');
	button.textContent = isPlaceVisited(place) ? '✓ Был здесь' : 'Был здесь';
	button.setAttribute('aria-pressed', String(isPlaceVisited(place)));
}

function renderVisitedPlaces() {
	const list = document.getElementById('visited-list');
	list.replaceChildren();
	if (!visitedPlaces.length) {
		const empty = document.createElement('p');
		empty.className = 'history-empty';
		empty.textContent = 'Отмечай места, где побывал, и они появятся здесь.';
		list.append(empty);
		return;
	}
	visitedPlaces.slice(0, 8).forEach(item => {
		const row = document.createElement('button');
		row.className = 'visited-entry';
		row.type = 'button';
		const name = document.createElement('strong');
		name.textContent = item.name;
		const meta = document.createElement('span');
		const date = item.visitedAt ? new Date(item.visitedAt).toLocaleDateString('ru-RU', {day: 'numeric', month: 'short'}) : '';
		meta.textContent = [item.city, item.category, date].filter(Boolean).join(' · ');
		row.append(name, meta);
		row.addEventListener('click', async () => {
			setActiveView('map');
			if (item.city && item.city !== currentCity) {
				citySelect.value = item.city;
				await loadCity(item.city);
			}
			const place = places.find(candidate => candidate.id === item.id) || item;
			openDetails(place);
		});
		list.append(row);
	});
}

function pickRandomPlace() {
	if (!places.length) return;
	const unvisited = places.filter(place => !isPlaceVisited(place));
	const choices = unvisited.length ? unvisited : places;
	let nextPlace = choices[Math.floor(Math.random() * choices.length)];
	if (choices.length > 1 && nextPlace.id === randomPlaceId) {
		nextPlace = choices[(choices.indexOf(nextPlace) + 1) % choices.length];
	}
	randomPlaceId = nextPlace.id;
	document.getElementById('profile-random-name').textContent = nextPlace.name;
	document.getElementById('profile-random-meta').textContent = `${nextPlace.category} · ${currentCity}`;
	document.getElementById('profile-random-description').textContent = nextPlace.description || 'Открой место и узнай его историю.';
	const image = document.getElementById('profile-random-photo');
	const imageSource = photoSources(nextPlace)[0] || fallbackPhoto(nextPlace, 320);
	image.hidden = !imageSource;
	image.alt = imageSource ? nextPlace.name : '';
	image.onerror = () => { image.hidden = true; };
	if (imageSource) image.src = imageSource;
	document.getElementById('profile-random-open').disabled = false;
}

const miniGameQuestionBank = [
	{key: 'interest', question: 'Чего сейчас хочется?', options: [
		{label: 'Вкусно поесть', value: 'food'}, {label: 'Культурного', value: 'culture'},
		{label: 'На свежий воздух', value: 'nature'}, {label: 'Красивой архитектуры', value: 'architecture'},
		{label: 'Удиви меня', value: 'surprise'}
	]},
	{key: 'distance', question: 'Далеко готовы прогуляться?', options: [
		{label: 'Хочу рядом', value: 'near'}, {label: 'Можно пройтись', value: 'any'}, {label: 'Готов(а) исследовать', value: 'far'}
	]},
	{key: 'mood', question: 'Какое настроение у прогулки?', options: [
		{label: 'Спокойно и красиво', value: 'calm'}, {label: 'Хочу впечатлений', value: 'impressive'}, {label: 'Без разницы', value: 'any'}
	]},
	{key: 'company', question: 'С кем отправимся?', options: [
		{label: 'Сам(а), без спешки', value: 'calm'}, {label: 'С друзьями', value: 'social'}, {label: 'Как получится', value: 'any'}
	]},
	{key: 'visit', question: 'Что выбираем сегодня?', options: [
		{label: 'Новое место', value: 'new'}, {label: 'Зайти туда, где уже был(а)', value: 'repeat'}, {label: 'Без разницы', value: 'any'}
	]},
	{key: 'history', question: 'Интересно узнать историю места?', options: [
		{label: 'Да, люблю такие истории', value: 'yes'}, {label: 'Лучше просто погулять', value: 'no'}, {label: 'Как получится', value: 'any'}
	]}
];

function shuffleItems(items) {
	const shuffled = [...items];
	for (let index = shuffled.length - 1; index > 0; index -= 1) {
		const other = Math.floor(Math.random() * (index + 1));
		[shuffled[index], shuffled[other]] = [shuffled[other], shuffled[index]];
	}
	return shuffled;
}

function miniGamePlaceTags(place) {
	const category = `${place.category || ''} ${place.name || ''} ${place.description || ''}`.toLocaleLowerCase('ru');
	const tags = new Set();
	if (/кафе|ресторан|еда|кухн|бар|пекар|кофейн|столов/.test(category)) tags.add('food');
	if (/музе|галере|театр|истор|памят|мемориал|монастыр|церк|культур|усадьб/.test(category)) tags.add('culture');
	if (/истор|музе|памят|мемориал|монастыр|церк|усадьб|замок|старин/.test(category)) tags.add('history');
	if (/парк|сад|сквер|озер|природ|набережн|лес/.test(category)) tags.add('nature');
	if (/архитект|замок|усадьб|дворец|здани/.test(category)) tags.add('architecture');
	if (/парк|сад|сквер|музе|монастыр|церк|набережн/.test(category)) tags.add('calm');
	if (/музе|театр|памят|мемориал|замок|галере/.test(category)) tags.add('impressive');
	if (/кафе|ресторан|парк|театр|площад/.test(category)) tags.add('social');
	return tags;
}

function beginMiniGame() {
	const alwaysAsk = miniGameQuestionBank.filter(question => question.key === 'visit' || question.key === 'history');
	const rotating = shuffleItems(miniGameQuestionBank.filter(question => question.key !== 'visit' && question.key !== 'history')).slice(0, 2);
	miniGameQuestions = shuffleItems([...alwaysAsk, ...rotating]);
	miniGameAnswers = {};
	miniGameStep = 0;
	miniGameRecommendation = null;
	document.getElementById('mini-game-result').hidden = true;
	document.getElementById('mini-game-answers').hidden = false;
	document.getElementById('mini-game-next').hidden = true;
	document.getElementById('mini-game-city').textContent = `Подберём идею среди мест города ${currentCity}.`;
	renderMiniGameQuestion();
}

function renderMiniGameQuestion() {
	if (miniGameStep >= miniGameQuestions.length) {
		showMiniGameRecommendation();
		return;
	}
	const question = miniGameQuestions[miniGameStep];
	const answers = document.getElementById('mini-game-answers');
	document.getElementById('mini-game-step').textContent = `ВОПРОС ${miniGameStep + 1} ИЗ ${miniGameQuestions.length}`;
	document.getElementById('mini-game-question').textContent = question.question;
	answers.replaceChildren();
	shuffleItems(question.options).forEach(option => {
		const button = document.createElement('button');
		button.type = 'button';
		button.className = 'mini-game-answer';
		button.textContent = option.label;
		button.addEventListener('click', () => {
			miniGameAnswers[question.key] = option.value;
			miniGameStep += 1;
			renderMiniGameQuestion();
		});
		answers.append(button);
	});
}

function showMiniGameRecommendation() {
	const answers = document.getElementById('mini-game-answers');
	const result = document.getElementById('mini-game-result');
	answers.hidden = true;
	document.getElementById('mini-game-step').textContent = 'ВАША ИДЕЯ';
	document.getElementById('mini-game-question').textContent = places.length ? `Для прогулки по ${currentCity} подойдёт:` : `В ${currentCity} пока нет мест для подбора`;
	result.replaceChildren();
	if (!places.length) {
		const message = document.createElement('p');
		message.textContent = 'Попробуйте выбрать другой город — каталог мест загрузится вместе с ним.';
		result.append(message);
	} else {
		const origin = userLocation || cityCenters[currentCity] || null;
		const candidates = places.map(place => {
			const tags = miniGamePlaceTags(place);
			const coords = Number.isFinite(Number(place.latitude)) && Number.isFinite(Number(place.longitude)) ? [Number(place.latitude), Number(place.longitude)] : null;
			const distance = origin && coords ? distanceBetween(origin, coords) : null;
			let score = Math.random() * 1.5;
			const interest = miniGameAnswers.interest;
			if (interest && interest !== 'surprise' && tags.has(interest)) score += 9;
			if (miniGameAnswers.mood && miniGameAnswers.mood !== 'any' && tags.has(miniGameAnswers.mood)) score += 4;
			if (miniGameAnswers.company && miniGameAnswers.company !== 'any' && tags.has(miniGameAnswers.company)) score += 2;
			const visited = isPlaceVisited(place);
			if (miniGameAnswers.visit === 'new') score += visited ? -100 : 5;
			if (miniGameAnswers.visit === 'repeat') score += visited ? 12 : -2;
			if (miniGameAnswers.history === 'yes' && tags.has('history')) score += 10;
			if (miniGameAnswers.history === 'no' && tags.has('history')) score -= 1.5;
			if (distance != null && miniGameAnswers.distance === 'near') score += distance <= 2 ? 5 : Math.max(0, 3 - distance / 3);
			if (distance != null && miniGameAnswers.distance === 'far') score += Math.min(distance, 12) / 3;
			return {place, distance, score};
		}).sort((first, second) => second.score - first.score);
		let selected = candidates[0];
		if (candidates.length > 1 && selected.place.id === miniGameRecommendation?.id) selected = candidates[1];
		miniGameRecommendation = selected.place;
		const name = document.createElement('strong');
		name.className = 'mini-game-place-name';
		name.textContent = selected.place.name;
		const meta = document.createElement('span');
		meta.className = 'mini-game-place-meta';
		meta.textContent = [selected.place.category, selected.distance == null ? '' : formatDistance(selected.distance)].filter(Boolean).join(' · ');
		const description = document.createElement('p');
		description.textContent = selected.place.description || 'Откройте карточку места, чтобы узнать о нём больше.';
		if (miniGameAnswers.visit === 'repeat' && !places.some(isPlaceVisited)) {
			description.textContent = 'Вы ещё не отмечали посещённые места в этом городе. Вот идея для первого знакомства: ' + description.textContent;
		}
	const open = document.createElement('button');
		open.type = 'button';
		open.className = 'profile-open-button mini-game-open';
		open.textContent = 'Показать место';
		open.addEventListener('click', () => { setActiveView('map'); openDetails(selected.place); });
		result.append(name, meta, description, open);
	}
	result.hidden = false;
	const next = document.getElementById('mini-game-next');
	next.hidden = false;
	next.textContent = 'Сыграть ещё';
}

function setMiniGameMode(mode) {
	document.querySelectorAll('[data-game-mode]').forEach(button => {
		const active = button.dataset.gameMode === mode;
		button.classList.toggle('active', active);
		button.setAttribute('aria-selected', String(active));
	});
	document.getElementById('mini-quiz-card').hidden = mode !== 'quiz';
	document.getElementById('mini-jump-card').hidden = mode !== 'jump';
	if (mode !== 'jump') stopJumpMusic();
	if (mode === 'jump') {
		drawJumpGame();
		if (!document.getElementById('mini-jump-card').classList.contains('is-game-fullscreen')) toggleJumpFullscreen();
	}
}

async function loadJumpCatalog() {
	if (jumpPlaces.length) return jumpPlaces;
	if (!jumpCatalogPromise) {
		jumpCatalogPromise = fetch(`/api/bootstrap?city=${encodeURIComponent(currentCity)}&all=1`)
			.then(response => { if (!response.ok) throw new Error(`HTTP ${response.status}`); return response.json(); })
			.then(payload => { jumpPlaces = Array.isArray(payload.places) ? payload.places : []; return jumpPlaces; })
			.catch(error => { console.warn('Не удалось загрузить общий каталог для игры:', error); jumpPlaces = places; return jumpPlaces; })
			.finally(() => { jumpCatalogPromise = null; });
	}
	return jumpCatalogPromise;
}

async function startJumpGame() {
	const canvas = document.getElementById('landmark-jump-canvas');
	stopJumpEffects();
	stopJumpMusic();
	document.querySelector('.jump-play-area').classList.remove('is-game-over');
	const catalog = await loadJumpCatalog();
	if (!catalog.length) {
		document.getElementById('jump-collected').textContent = `В каталоге ${currentCity} пока нет мест для сбора.`;
		return;
	}
	const width = canvas.width;
	const config = jumpDifficulties[document.getElementById('jump-difficulty').value] || jumpDifficulties.normal;
	const platforms = [{x: width / 2 - 48, y: 520, width: 96, spikes: [], crumbling: false, falling: false, fallVelocity: 0, landmark: null}];
	let nextY = 450;
	while (nextY > -80) {
		const platform = makeJumpPlatform(nextY, platforms[platforms.length - 1], platforms.length === 1 ? 32 : 100, config);
		platforms.push(platform);
		nextY -= config.minGap + Math.random() * config.gapRange;
	}
	const monsters = platforms.slice(2).filter((_, index) => index % 3 === 1).map(platform => makeJumpMonster(platform.y - 30, width));
	jumpGame = {width, height: canvas.height, player: {x: width / 2 - 21, y: 482, width: 42, height: 38, velocityY: config.jumpVelocity}, platforms, monsters, platformCount: platforms.length, camera: 0, nextY, collected: [], score: 0, lives: 3, invulnerableUntil: 0, elapsed: 0, config, paused: false, running: true, lastTime: 0};
	playJumpSound('music');
	jumpHeld = {left: false, right: false};
	document.getElementById('jump-collected').textContent = 'Собранные места появятся здесь';
	document.getElementById('jump-collection-count').textContent = '0';
	document.getElementById('jump-record').textContent = String(jumpRecord);
	document.getElementById('landmark-question-overlay').hidden = true;
	document.getElementById('jump-start').textContent = 'Начать заново';
	if (jumpFrame) cancelAnimationFrame(jumpFrame);
	jumpFrame = requestAnimationFrame(tickJumpGame);
}

function makeJumpMonster(y, width) {
	return {x: 0, y, width: 34, height: 26, centerX: 22 + Math.random() * (width - 78), range: 24 + Math.random() * 34, phase: Math.random() * Math.PI * 2, speed: 0.018 + Math.random() * 0.012};
}

function makeJumpPlatform(y, previous, maxOffset = 100, config = jumpDifficulties.normal) {
	const width = 96;
	const maxX = 12 + (420 - width);
	const preferredX = previous.x + (previous.width - width) / 2 + (Math.random() * maxOffset * 2 - maxOffset);
	const hasSpikes = Math.random() < config.spikeChance;
	// Keep one spike at an edge so there is always a generous landing lane.
	const spikes = hasSpikes ? [Math.random() < 0.5 ? 8 : 74] : [];
	const crumbling = !hasSpikes && Math.random() < config.crumbleChance;
	return {x: Math.max(12, Math.min(maxX, preferredX)), y, width, spikes, crumbling, falling: false, fallVelocity: 0, landmark: !hasSpikes && Math.random() < 0.13};
}

function playerHitsSpike(player, platform) {
	return platform.spikes.some(offset => player.x + player.width > platform.x + offset && player.x < platform.x + offset + 14);
}

function addJumpScore(points) {
	if (!jumpGame) return;
	jumpGame.score += points;
	if (jumpGame.score > jumpRecord) {
		jumpRecord = jumpGame.score;
		document.getElementById('jump-record').textContent = String(jumpRecord);
		try { localStorage.setItem('smart-guide-jump-record', String(jumpRecord)); } catch (_) {}
	}
}

function tickJumpGame(timestamp) {
	if (!jumpGame || !jumpGame.running) return;
	const game = jumpGame;
	const delta = Math.min((timestamp - (game.lastTime || timestamp)) / 16.67, 1.5);
	game.lastTime = timestamp;
	const player = game.player;
	game.elapsed += delta;
	game.monsters.forEach(monster => {
		monster.x = Math.max(8, Math.min(game.width - monster.width - 8, monster.centerX + Math.sin(game.elapsed * monster.speed + monster.phase) * monster.range));
	});
	if (jumpHeld.left) player.x -= game.config.moveSpeed * delta;
	if (jumpHeld.right) player.x += game.config.moveSpeed * delta;
	player.x = Math.max(0, Math.min(game.width - player.width, player.x));
	const previousBottom = player.y + player.height;
	player.velocityY += game.config.gravity * delta;
	player.y += player.velocityY * delta;
	game.platforms.forEach(platform => {
		if (platform.falling) {
			platform.fallVelocity += 0.32 * delta;
			platform.y += platform.fallVelocity * delta;
		}
	});
	if (player.velocityY > 0) {
		for (const platform of game.platforms) {
			if (platform.falling) continue;
			const overlaps = player.x + player.width > platform.x && player.x < platform.x + platform.width;
			if (overlaps && platform.spikes?.length && previousBottom <= platform.y - 16 && player.y + player.height >= platform.y - 16 && playerHitsSpike(player, platform)) {
				if (timestamp >= game.invulnerableUntil) {
					if (takeJumpHit(game, platform.y - player.height - 2)) return;
					break;
				}
			}
			if (overlaps && previousBottom <= platform.y && player.y + player.height >= platform.y) {
				player.y = platform.y - player.height;
				player.velocityY = game.config.jumpVelocity;
				addJumpScore(1);
				if (platform.crumbling) platform.falling = true;
				if (platform.landmark) {
					const pool = jumpPlaces.filter(place => !game.collected.some(item => item.id === place.id));
					if (pool.length) {
						const found = pool[Math.floor(Math.random() * pool.length)];
						game.collected.push(found);
						platform.landmark = null;
						document.getElementById('jump-collection-count').textContent = String(game.collected.length);
						renderJumpCollection();
						askLandmarkQuestion(found, game);
					}
				}
				break;
			}
		}
	}
	if (!game.paused && game.lives > 0 && timestamp >= game.invulnerableUntil) {
		const monster = game.monsters.find(item => player.x < item.x + item.width && player.x + player.width > item.x && player.y < item.y + item.height && player.y + player.height > item.y);
		if (monster && takeJumpHit(game, player.y - 12)) return;
	}
	if (game.paused) { drawJumpGame(); return; }
	if (player.y - game.camera < 220) game.camera = player.y - 220;
	while (game.nextY > game.camera - 100) {
		const previous = game.platforms.reduce((closest, platform) => platform.y > game.nextY && platform.y < closest.y ? platform : closest, game.platforms[0]);
		const platform = makeJumpPlatform(game.nextY, previous, 100, game.config);
		game.platforms.push(platform);
		game.platformCount += 1;
		if (game.platformCount % 3 === 0) game.monsters.push(makeJumpMonster(platform.y - 30, game.width));
		game.nextY -= game.config.minGap + Math.random() * game.config.gapRange;
	}
	game.platforms = game.platforms.filter(platform => platform.y - game.camera < game.height + 40);
	game.monsters = game.monsters.filter(monster => monster.y - game.camera < game.height + 40);
	if (player.y - game.camera > game.height + 35) {
		endJumpGame(game, 'Ты упал!');
		return;
	}
	drawJumpGame();
	jumpFrame = requestAnimationFrame(tickJumpGame);
}

function takeJumpHit(game, respawnY) {
	const now = performance.now();
	if (now < game.invulnerableUntil) return false;
	game.lives -= 1;
	if (game.lives > 0) playJumpSound('hit');
	game.invulnerableUntil = now + 1100;
	game.player.y = respawnY;
	game.player.velocityY = game.config.jumpVelocity;
	if (game.lives <= 0) {
		endJumpGame(game, 'У котика закончились сердечки!');
		return true;
	}
	return false;
}

function endJumpGame(game, message) {
	game.running = false;
	document.querySelector('.jump-play-area').classList.add('is-game-over');
	playJumpSound('dead');
	stopJumpMusic();
	game.endMessage = message;
	document.getElementById('jump-start').textContent = 'Сыграть ещё';
	document.getElementById('landmark-question-overlay').hidden = true;
	renderJumpCollection();
	const summary = document.createElement('span');
	summary.className = 'jump-gameover-summary';
	summary.textContent = `${message} · ${game.collected.length} мест · ${game.score} очков`;
	document.getElementById('jump-collected').prepend(summary);
	drawJumpGame();
}

function drawJumpGame() {
	const canvas = document.getElementById('landmark-jump-canvas');
	if (!canvas) return;
	const context = canvas.getContext('2d');
	const width = canvas.width;
	const height = canvas.height;
	const game = jumpGame;
	const lightTheme = document.documentElement.dataset.theme === 'light';
	const gradient = context.createLinearGradient(0, 0, 0, height);
	gradient.addColorStop(0, lightTheme ? '#edf4ec' : '#203a32');
	gradient.addColorStop(1, lightTheme ? '#dce9df' : '#101d1a');
	context.fillStyle = gradient;
	context.fillRect(0, 0, width, height);
	context.fillStyle = lightTheme ? 'rgba(57, 104, 72, .15)' : 'rgba(224, 235, 219, .16)';
	for (let index = 0; index < 22; index += 1) {
		const x = (index * 83 + 19) % width;
		const y = (index * 127 + 31) % height;
		context.beginPath(); context.arc(x, y, index % 3 === 0 ? 2 : 1, 0, Math.PI * 2); context.fill();
	}
	if (!game) {
		context.fillStyle = lightTheme ? '#203a2c' : '#edf3e8'; context.textAlign = 'center'; context.font = '600 19px system-ui'; context.fillText('Нажми «Начать игру»', width / 2, height / 2);
		context.font = '14px system-ui'; context.fillStyle = lightTheme ? '#61776a' : 'rgba(237,243,232,.72)'; context.fillText('Достопримечательности встречаются редко', width / 2, height / 2 + 30);
		return;
	}
	context.fillStyle = lightTheme ? 'rgba(255, 255, 255, .86)' : 'rgba(12, 24, 21, .8)'; context.beginPath(); context.roundRect(12, 12, 124, 54, 13); context.fill();
	context.fillStyle = lightTheme ? '#203a2c' : '#f1f3e9'; context.textAlign = 'left'; context.font = '700 13px system-ui'; context.fillText(`СЧЁТ  ${game.score}`, 24, 34);
	context.fillStyle = lightTheme ? '#61776a' : '#aab9ae'; context.font = '11px system-ui'; context.fillText(`РЕКОРД  ${jumpRecord}`, 24, 53);
	context.textAlign = 'right'; context.font = '700 21px system-ui';
	for (let index = 0; index < 3; index += 1) {
		context.fillStyle = index < game.lives ? '#f07878' : 'rgba(240,120,120,.3)';
		context.fillText('♥', width - 20 - index * 25, 37);
	}
	for (const monster of game.monsters) {
		const monsterY = monster.y - game.camera;
		context.fillStyle = lightTheme ? '#a987c2' : '#d7c1ef'; context.beginPath(); context.ellipse(monster.x + 17, monsterY + 13, 15, 12, 0, Math.PI, 0); context.fill();
		context.beginPath(); context.moveTo(monster.x + 2, monsterY + 13); context.lineTo(monster.x - 2, monsterY + 23); context.lineTo(monster.x + 8, monsterY + 19); context.fill();
		context.beginPath(); context.moveTo(monster.x + 32, monsterY + 13); context.lineTo(monster.x + 36, monsterY + 23); context.lineTo(monster.x + 26, monsterY + 19); context.fill();
		context.fillStyle = '#39443d'; context.beginPath(); context.arc(monster.x + 12, monsterY + 12, 2, 0, Math.PI * 2); context.arc(monster.x + 22, monsterY + 12, 2, 0, Math.PI * 2); context.fill();
	}
	for (const platform of game.platforms) {
		const y = platform.y - game.camera;
		context.globalAlpha = platform.falling ? .55 : 1;
		context.fillStyle = platform.crumbling ? (lightTheme ? '#bd9148' : '#c5a46a') : (lightTheme ? '#5b9a73' : '#7bb897');
		context.beginPath(); context.roundRect(platform.x, y, platform.width, 12, 7); context.fill();
		context.globalAlpha = 1;
		if (platform.spikes?.length) {
			context.fillStyle = '#e47770';
			for (const offset of platform.spikes) {
				const spikeX = platform.x + offset;
				context.beginPath(); context.moveTo(spikeX, y + 1); context.lineTo(spikeX + 7, y - 16); context.lineTo(spikeX + 14, y + 1); context.closePath(); context.fill();
			}
		}
		if (platform.landmark) {
			context.fillStyle = '#f0d98e'; context.font = '22px system-ui'; context.textAlign = 'center'; context.fillText('✦', platform.x + platform.width / 2, y - 7);
		}
	}
	const player = game.player;
	const catY = player.y - game.camera;
	context.globalAlpha = performance.now() < game.invulnerableUntil && Math.floor(performance.now() / 90) % 2 === 0 ? .38 : 1;
	const catColor = lightTheme ? '#587660' : '#f2eee2';
	context.strokeStyle = catColor; context.lineWidth = 5; context.lineCap = 'round'; context.beginPath(); context.moveTo(player.x + 9, catY + 29); context.quadraticCurveTo(player.x - 1, catY + 28, player.x + 3, catY + 18); context.stroke();
	context.fillStyle = catColor;
	context.beginPath(); context.moveTo(player.x + 7, catY + 17); context.lineTo(player.x + 8, catY + 2); context.lineTo(player.x + 19, catY + 10); context.closePath(); context.fill();
	context.beginPath(); context.moveTo(player.x + 23, catY + 10); context.lineTo(player.x + 34, catY + 2); context.lineTo(player.x + 35, catY + 17); context.closePath(); context.fill();
	context.beginPath(); context.ellipse(player.x + 21, catY + 25, 17, 12, 0, 0, Math.PI * 2); context.fill();
	context.beginPath(); context.arc(player.x + 21, catY + 17, 13, 0, Math.PI * 2); context.fill();
	context.fillStyle = '#9ab89c'; context.beginPath(); context.moveTo(player.x + 11, catY + 7); context.lineTo(player.x + 12, catY + 14); context.lineTo(player.x + 17, catY + 11); context.fill();
	context.beginPath(); context.moveTo(player.x + 25, catY + 11); context.lineTo(player.x + 30, catY + 14); context.lineTo(player.x + 31, catY + 7); context.fill();
	context.fillStyle = '#263c33'; context.beginPath(); context.ellipse(player.x + 16, catY + 18, 1.7, 2.4, 0, 0, Math.PI * 2); context.ellipse(player.x + 26, catY + 18, 1.7, 2.4, 0, 0, Math.PI * 2); context.fill();
	context.fillStyle = '#d88b8b'; context.beginPath(); context.moveTo(player.x + 19, catY + 22); context.lineTo(player.x + 23, catY + 22); context.lineTo(player.x + 21, catY + 25); context.closePath(); context.fill();
	context.strokeStyle = '#386e55'; context.lineWidth = 1; context.beginPath(); context.moveTo(player.x + 14, catY + 23); context.lineTo(player.x + 4, catY + 21); context.moveTo(player.x + 14, catY + 25); context.lineTo(player.x + 4, catY + 27); context.moveTo(player.x + 28, catY + 23); context.lineTo(player.x + 38, catY + 21); context.moveTo(player.x + 28, catY + 25); context.lineTo(player.x + 38, catY + 27); context.stroke();
	context.globalAlpha = 1;
	if (!game.running) {
		context.fillStyle = lightTheme ? 'rgba(239, 246, 239, .88)' : 'rgba(8, 16, 14, .74)'; context.fillRect(0, 0, width, height);
		context.textAlign = 'center'; context.fillStyle = lightTheme ? '#203a2c' : '#f3f2e9'; context.font = '650 22px system-ui'; context.fillText(game.endMessage || 'Раунд завершён', width / 2, height / 2 - 10);
		context.fillStyle = lightTheme ? '#52695a' : 'rgba(243, 242, 233, .78)'; context.font = '14px system-ui'; context.fillText('Нажми пробел, чтобы попробовать ещё', width / 2, height / 2 + 22);
	}
	context.textAlign = 'left';
}

function renderJumpCollection() {
	const list = document.getElementById('jump-collected');
	list.replaceChildren();
	if (!jumpGame?.collected.length) { list.textContent = 'Собранные места появятся здесь'; return; }
	[...jumpGame.collected].reverse().forEach(place => {
		const chip = document.createElement('span');
		chip.className = 'jump-collected-place';
		chip.textContent = `✦ ${place.name}`;
		chip.title = place.name;
		list.append(chip);
	});
}

function askLandmarkQuestion(place, game) {
	game.paused = true;
	const overlay = document.getElementById('landmark-question-overlay');
	overlay.classList.remove('answer-correct', 'answer-incorrect');
	const correctCity = place.city || currentCity;
	const catalogCities = offlineCityFilterEnabled ? offlineCities : Object.keys(cityCenters);
	const knownCities = [...new Set([...catalogCities, 'Минск', 'Витебск', 'Гродно', 'Гомель', 'Брест', 'Могилёв', 'Орша', 'Полоцк', 'Новополоцк', 'Лида'])]
		.filter(city => !offlineCityFilterEnabled || offlineCities.includes(city) || city === correctCity);
	const alternatives = shuffleItems(knownCities.filter(city => city !== correctCity)).slice(0, 3);
	const options = shuffleItems([correctCity, ...alternatives]);
	document.getElementById('landmark-question-place').textContent = `«${place.name}» — в каком городе находится?`;
	const feedback = document.getElementById('landmark-question-feedback');
	feedback.textContent = '';
	feedback.className = 'landmark-feedback';
	const optionList = document.getElementById('landmark-question-options');
	optionList.replaceChildren();
	delete optionList.dataset.answered;
	options.forEach(city => {
		const button = document.createElement('button');
		button.type = 'button';
		button.className = 'landmark-answer';
		button.textContent = city;
		button.addEventListener('click', () => {
			if (optionList.dataset.answered) return;
			optionList.dataset.answered = 'true';
			optionList.querySelectorAll('button').forEach(answer => { answer.disabled = true; });
			const feedback = document.getElementById('landmark-question-feedback');
			overlay.classList.remove('answer-correct', 'answer-incorrect');
			if (city === correctCity) {
				playJumpSound('correct');
				addJumpScore(10);
				feedback.textContent = 'Верно! +10 очков';
				feedback.className = 'landmark-feedback is-correct';
				overlay.classList.add('answer-correct');
			} else {
				playJumpSound('incorrect');
				feedback.textContent = 'Не угадали — продолжаем игру';
				feedback.className = 'landmark-feedback is-incorrect';
				overlay.classList.add('answer-incorrect');
			}
			window.setTimeout(() => {
				if (jumpGame !== game || !game.running) return;
				overlay.hidden = true;
				game.paused = false;
				game.lastTime = 0;
				jumpFrame = requestAnimationFrame(tickJumpGame);
			}, 650);
		});
		optionList.append(button);
	});
	overlay.hidden = false;
}

function setJumpDirection(direction, pressed) {
	jumpHeld[direction] = pressed;
}

function stopJumpGameplay() {
	if (jumpFrame) cancelAnimationFrame(jumpFrame);
	jumpFrame = null;
	jumpHeld = {left: false, right: false};
	jumpGame = null;
	stopJumpMusic();
	stopJumpEffects();
	document.querySelector('.jump-play-area').classList.remove('is-game-over');
	document.getElementById('landmark-question-overlay').hidden = true;
	drawJumpGame();
}

function toggleJumpFullscreen() {
	const card = document.getElementById('mini-jump-card');
	const entering = !card.classList.contains('is-game-fullscreen');
	if (!entering) stopJumpGameplay();
	card.classList.toggle('is-game-fullscreen', entering);
	document.getElementById('jump-fullscreen').textContent = entering ? 'Свернуть игру' : 'На весь экран';
	if (entering && card.requestFullscreen) card.requestFullscreen().catch(() => {});
	else if (!entering && document.fullscreenElement) document.exitFullscreen().catch(() => {});
}

function getNearbyCities() {
	const origin = userLocation || cityCenters[currentCity];
	if (!origin) return [];
	return Object.entries(cityCenters)
		.filter(([name, center]) => name !== currentCity && (!offlineCityFilterEnabled || offlineCities.includes(name)) && Array.isArray(center) && center.length === 2)
		.map(([name, center]) => ({name, center, distance: distanceBetween(origin, center)}))
		.filter(city => city.distance <= 200)
		.sort((first, second) => first.distance - second.distance)
		.slice(0, 12);
}

async function spinCityRoulette() {
	if (rouletteRunning) return;
	const candidates = getNearbyCities();
	const result = document.getElementById('city-roulette-result');
	const distance = document.getElementById('city-roulette-distance');
	const spinButton = document.getElementById('city-roulette-spin');
	const openButton = document.getElementById('city-roulette-open');
	const dialog = document.getElementById('city-roulette-dialog');
	const reelWindow = document.getElementById('roulette-reel-window');
	const track = document.getElementById('roulette-reel-track');
	const modalWinner = document.getElementById('roulette-winner-name');
	const modalMeta = document.getElementById('roulette-winner-meta');
	if (!dialog.open) dialog.showModal();
	if (!candidates.length) {
		result.textContent = 'Рядом пока нет вариантов';
		distance.textContent = 'Выбери другой город или попробуй позже';
		modalWinner.textContent = 'Рядом пока нет вариантов';
		modalMeta.textContent = 'Попробуй выбрать другой город';
		track.replaceChildren();
		return;
	}
	rouletteRunning = true;
	spinButton.disabled = true;
	openButton.disabled = true;
	document.getElementById('roulette-spin-again').disabled = true;
	document.getElementById('roulette-choose-city').disabled = true;
	rouletteCity = null;
	const winner = candidates[Math.floor(Math.random() * candidates.length)];
	result.textContent = 'Выбираем направление…';
	distance.textContent = 'Смотрим фотографии городов рядом';
	modalWinner.textContent = 'Лента набирает скорость';
	modalMeta.textContent = 'Остановимся на одном из ближайших городов';
	const params = new URLSearchParams();
	candidates.forEach(city => params.append('city', city.name));
	let highlightsByCity = new Map();
	try {
		const response = await fetch(`/api/city-highlights?${params}`);
		if (response.ok) {
			const payload = await response.json();
			highlightsByCity = new Map((payload.highlights || []).map(item => [item.city, item]));
		}
	} catch (error) {
		console.warn('Не удалось загрузить фото городов для рулетки:', error);
	}
	const winnerIndex = 25;
	const reelCities = Array.from({length: 31}, (_, index) => index === winnerIndex
		? winner
		: candidates[Math.floor(Math.random() * candidates.length)]);
	track.replaceChildren();
	track.style.transition = 'none';
	track.style.transform = 'translateX(0)';
	reelCities.forEach(city => {
		const highlight = highlightsByCity.get(city.name);
		const card = document.createElement('article');
		card.className = 'roulette-city-card';
		card.dataset.city = city.name;
		const image = document.createElement('img');
		image.alt = highlight?.place || city.name;
		image.decoding = 'async';
		image.loading = 'eager';
		image.src = highlight?.image_url || '';
		image.hidden = !highlight?.image_url;
		image.onerror = () => { image.hidden = true; };
		const imageFallback = document.createElement('span');
		imageFallback.className = 'roulette-city-fallback';
		imageFallback.textContent = city.name.slice(0, 1).toLocaleUpperCase('ru');
		const copy = document.createElement('div');
		copy.className = 'roulette-city-copy';
		const title = document.createElement('strong');
		title.textContent = city.name;
		const subtitle = document.createElement('span');
		subtitle.textContent = highlight?.place || formatDistance(city.distance);
		copy.append(title, subtitle);
		card.append(image, imageFallback, copy);
		track.append(card);
	});
	reelWindow.classList.add('is-spinning');
	await new Promise(resolve => window.requestAnimationFrame(() => window.requestAnimationFrame(resolve)));
	const winnerCard = track.children[winnerIndex];
	const targetOffset = reelWindow.clientWidth / 2 - winnerCard.offsetLeft - winnerCard.offsetWidth / 2;
	const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
	track.style.transition = reducedMotion ? 'none' : 'transform 4.8s cubic-bezier(0.08, 0.72, 0.12, 1)';
	track.style.transform = `translateX(${targetOffset}px)`;
	if (!reducedMotion) {
		await new Promise(resolve => {
			let resolved = false;
			const finish = () => {
				if (resolved) return;
				resolved = true;
				track.removeEventListener('transitionend', finish);
				resolve();
			};
			track.addEventListener('transitionend', finish);
			window.setTimeout(finish, 5200);
		});
	} else {
		await new Promise(resolve => window.setTimeout(resolve, 100));
	}
	rouletteCity = winner.name;
	reelWindow.classList.remove('is-spinning');
	result.textContent = winner.name;
	distance.textContent = `${formatDistance(winner.distance)} от ${userLocation ? 'вас' : currentCity}`;
	modalWinner.textContent = winner.name;
	modalMeta.textContent = `${formatDistance(winner.distance)} · ${highlightsByCity.get(winner.name)?.place || 'Пункт рядом с вами'}`;
	openButton.disabled = false;
	document.getElementById('roulette-spin-again').disabled = false;
	document.getElementById('roulette-choose-city').disabled = false;
	spinButton.disabled = false;
	rouletteRunning = false;
}

function openRouletteCity() {
	if (!rouletteCity) return;
	const dialog = document.getElementById('city-roulette-dialog');
	if (dialog.open) dialog.close();
	citySelect.value = rouletteCity;
	citySelect.dispatchEvent(new Event('change'));
	setActiveView('map');
}

function openDetails(place) {
	const dialog = document.getElementById('place-dialog');
	const localSources = photoSources(place);
	const remoteSource = fallbackPhoto(place, 720);
	const sources = [...localSources, ...(remoteSource && !localSources.includes(remoteSource) ? [remoteSource] : [])];
	const gallerySources = localSources.length ? localSources : sources;
	const photo = document.getElementById('detail-photo');
	const gallery = document.getElementById('detail-gallery');
	document.getElementById('detail-name').textContent = place.name;
	document.getElementById('detail-meta').textContent = `${place.category} · ${place.rating == null ? 'Рейтинг отсутствует в открытых данных' : `★ ${Number(place.rating).toFixed(1)}`}`;
	document.getElementById('detail-description').textContent = place.description || 'Описание пока отсутствует в источнике.';
	document.getElementById('detail-history').textContent = place.history || 'Историческая справка пока отсутствует в источнике.';
	document.getElementById('detail-credit').textContent = place.image_credit || '';
	const visitedButton = document.getElementById('detail-visited');
	visitedButton.textContent = isPlaceVisited(place) ? '✓ Был здесь' : 'Был здесь';
	visitedButton.setAttribute('aria-pressed', String(isPlaceVisited(place)));
	visitedButton.onclick = () => toggleVisitedPlace(place);
	const sourceLink = document.getElementById('detail-source');
	sourceLink.href = place.source_url || '#';
	sourceLink.hidden = !place.source_url;
	const articleLink = document.getElementById('detail-wikipedia');
	articleLink.href = place.wiki_url || '#';
	articleLink.hidden = !place.wiki_url;
	gallery.replaceChildren();
	photo.hidden = !sources.length;
	photo.alt = place.name;
	if (sources.length) {
		let sourceIndex = 0;
		photo.onerror = () => {
			sourceIndex += 1;
			if (sourceIndex < sources.length) photo.src = sources[sourceIndex];
			else photo.hidden = true;
		};
		photo.src = sources[0];
	}
	else photo.removeAttribute('src');
	gallerySources.slice(1).forEach((source, index) => {
		const button = document.createElement('button');
		button.className = 'dialog-thumb';
		button.type = 'button';
		button.setAttribute('aria-label', `Фото ${index + 2}`);
		const thumbnail = document.createElement('img');
		thumbnail.src = source;
		thumbnail.alt = '';
		button.append(thumbnail);
		button.addEventListener('click', () => {
			photo.src = source;
			gallery.querySelectorAll('.dialog-thumb').forEach(item => item.classList.remove('active'));
			button.classList.add('active');
		});
		gallery.append(button);
	});
	document.getElementById('detail-route').onclick = () => {
		selectedPlaceIds.clear();
		selectedPlaceIds.add(place.id);
		document.getElementById('route-count').textContent = '1';
		dialog.close();
		buildSelectedRoute();
	};
	if (!dialog.open) dialog.showModal();
	document.getElementById('detail-show-map').onclick = () => {
		dialog.close();
		map.flyTo([place.latitude, place.longitude], Math.max(map.getZoom(), 16), {duration: 0.45});
	};
}

function renderMarkers() {
	if (!map || !window.ymaps) return;
	markers.forEach(marker => map.geoObjects.remove(marker));
	markers.clear();
	places.forEach(place => {
		const style = markerStyle(place.category);
		const marker = new window.ymaps.Placemark(
			[place.latitude, place.longitude],
			{iconContent: style.glyph},
			{
				preset: 'islands#circleIcon',
				iconColor: style.color,
				zIndex: 0,
				zIndexHover: 10000,
				hideIconOnBalloonOpen: false
			}
		);
		marker.place = place;
		marker.events.add('mouseenter', event => {
			const point = markerEventPoint(event, place);
			showHoverPreview(place, point.x, point.y);
		});
		marker.events.add('mousemove', event => {
			const point = markerEventPoint(event, place);
			positionHoverPreview(point.x, point.y);
		});
		marker.events.add('mouseleave', hideHoverPreview);
		marker.events.add('click', () => openDetails(place));
		map.geoObjects.add(marker);
		markers.set(place.id, marker);
	});
	applyFilters();
}

function renderCategories() {
	const categories = [...new Set(places.map(place => place.category))].sort();
	const container = document.getElementById('categories');
	container.replaceChildren();
	const options = ['Все', ...categories];
	options.forEach(category => {
		const button = document.createElement('button');
		button.className = 'category-button';
		button.type = 'button';
		button.textContent = category;
		const active = category === 'Все' ? selectedCategories.size === 0 : selectedCategories.has(category);
		button.setAttribute('aria-pressed', String(active));
		button.addEventListener('click', () => {
			if (category === 'Все') {
				selectedCategories.clear();
			} else if (selectedCategories.has(category)) {
				selectedCategories.delete(category);
			} else {
				selectedCategories.add(category);
			}
			renderCategories();
			applyFilters();
		});
		container.append(button);
	});
}

function renderPlaces(filteredPlaces) {
	placeList.replaceChildren();
	if (!filteredPlaces.length) {
		const empty = document.createElement('div');
		empty.className = 'empty-state';
		empty.textContent = 'Подходящих мест не найдено';
		placeList.append(empty);
		return;
	}

	filteredPlaces.forEach((place, index) => {
		const row = document.createElement('article');
		row.className = 'place-row';
		row.style.animationDelay = `${Math.min(index * 25, 150)}ms`;
		row.tabIndex = 0;
		row.setAttribute('role', 'button');
		row.setAttribute('aria-label', `Показать на карте: ${place.name}`);
		const details = document.createElement('div');
		const name = document.createElement('div');
		name.className = 'place-name';
		name.textContent = place.name;
		const meta = document.createElement('div');
		meta.className = 'place-meta';
		const distance = userLocation ? ` · ${formatDistance(distanceBetween(userLocation, [place.latitude, place.longitude]))}` : '';
		const rating = place.rating == null ? 'Без рейтинга' : `★ ${Number(place.rating).toFixed(1)}`;
		meta.textContent = `${place.category} · ${rating}${distance}`;
		details.append(name, meta);
		const action = document.createElement('button');
		action.className = `place-action${selectedPlaceIds.has(place.id) ? ' selected' : ''}`;
		action.type = 'button';
		action.title = selectedPlaceIds.has(place.id) ? 'Убрать из маршрута' : 'Добавить в маршрут';
		action.setAttribute('aria-label', action.title);
		action.textContent = selectedPlaceIds.has(place.id) ? '✓' : '+';
		action.addEventListener('click', event => {
			event.stopPropagation();
			toggleRoutePlace(place.id);
		});
		const focusPlace = () => {
			openDetails(place);
		};
		row.addEventListener('click', focusPlace);
		row.addEventListener('mouseenter', event => showHoverPreview(place, event.clientX, event.clientY));
		row.addEventListener('mousemove', event => positionHoverPreview(event.clientX, event.clientY));
		row.addEventListener('mouseleave', hideHoverPreview);
		row.addEventListener('keydown', event => {
			if (event.key === 'Enter' || event.key === ' ') {
				event.preventDefault();
				focusPlace();
			}
		});
		row.append(details, action);
		placeList.append(row);
	});
}

function applyFilters() {
	const query = document.getElementById('search').value.trim().toLocaleLowerCase('ru');
	let visiblePlaces = places.filter(place => {
		const matchesCategory = selectedCategories.size === 0 || selectedCategories.has(place.category);
		const matchesQuery = `${place.name} ${place.category}`.toLocaleLowerCase('ru').includes(query);
		return matchesCategory && matchesQuery;
	});
	const sortMode = sortSelect.value;
	visiblePlaces.sort((first, second) => {
		if (sortMode === 'rating') return (Number(second.rating) || 0) - (Number(first.rating) || 0) || first.name.localeCompare(second.name, 'ru');
		if (sortMode === 'distance' && userLocation) return distanceBetween(userLocation, [first.latitude, first.longitude]) - distanceBetween(userLocation, [second.latitude, second.longitude]);
		return first.name.localeCompare(second.name, 'ru');
	});
	const visibleIds = new Set(visiblePlaces.map(place => place.id));
	markers.forEach((marker, id) => {
		if (visibleIds.has(id) && map.geoObjects.indexOf(marker) === -1) map.geoObjects.add(marker);
		if (!visibleIds.has(id) && map.geoObjects.indexOf(marker) !== -1) map.geoObjects.remove(marker);
	});
	visiblePlaces.forEach((place, index) => {
		const marker = markers.get(place.id);
		marker.options.set('zIndex', index + 1);
		marker.options.set('zIndexHover', visiblePlaces.length + 10000 + index);
	});
	document.getElementById('result-count').textContent = `${visiblePlaces.length} мест`;
	document.getElementById('map-place-count').textContent = `${visiblePlaces.length} найдено`;
	updateProfile();
	renderPlaces(visiblePlaces);
}

async function loadCity(city, fitMap = true) {
	if (offlineCityFilterEnabled && !offlineCities.includes(city)) {
		setLocationStatus('Этот город не сохранён для офлайн-режима', true);
		return;
	}
	const loadSequence = ++cityLoadSequence;
	loading.hidden = false;
	try {
		const response = await fetch(`/api/bootstrap?city=${encodeURIComponent(city)}`);
		if (!response.ok) throw new Error(`HTTP ${response.status}`);
		const payload = await response.json();
		if (loadSequence !== cityLoadSequence) return;
		currentCity = payload.city;
		places = payload.places;
		document.getElementById('city-label').textContent = currentCity;
		document.getElementById('map-city').textContent = currentCity;
		cityCenters = payload.cityCenters || {};
		loadJumpCatalog();
		populateCityPicker(payload.cities);
		citySearch.value = currentCity;
		closeCitySuggestions();
		document.getElementById('city-label').textContent = currentCity;
		document.getElementById('map-city').textContent = currentCity;
		document.getElementById('map-subtitle').textContent = `${places.length} мест · OpenStreetMap`;
		await initializeMap(payload.center);
		if (loadSequence !== cityLoadSequence) return;
		map.invalidateSize();
		if (fitMap) map.setView(payload.center, 13);
		selectedCategories.clear();
		renderCategories();
		renderMarkers();
		updateProfile();
		renderVisitedPlaces();
		pickRandomPlace();
	} catch (error) {
		if (loadSequence !== cityLoadSequence) return;
		console.error('Не удалось загрузить места:', error);
		setLocationStatus(error.message || 'Не удалось загрузить места из локальной базы', true);
		placeList.innerHTML = '<div class="empty-state">Проверьте локальный сервер приложения</div>';
	} finally {
		if (loadSequence === cityLoadSequence) loading.hidden = true;
	}
}

function populateCityPicker(cityNames = Object.keys(cityCenters)) {
	const availableNames = offlineCityFilterEnabled
		? cityNames.filter(name => offlineCities.includes(name))
		: cityNames;
	citySelect.replaceChildren();
	availableNames.forEach(name => {
		const option = document.createElement('option');
		option.value = name;
		option.textContent = name;
		option.selected = name === currentCity;
		citySelect.append(option);
	});
	if (!availableNames.includes(citySearch.value)) citySearch.value = availableNames.includes(currentCity) ? currentCity : '';
	if (!availableNames.length && offlineCityFilterEnabled) citySearch.placeholder = 'Нет сохранённых городов';
	else citySearch.placeholder = 'Найти город';
	closeCitySuggestions();
}

function showNoSavedOfflineCities() {
	cityLoadSequence += 1;
	loading.hidden = true;
	currentCity = '';
	places = [];
	selectedCategories.clear();
	citySelect.replaceChildren();
	citySearch.value = '';
	citySearch.placeholder = 'Нет сохранённых городов';
	document.getElementById('city-label').textContent = 'Нет офлайн-городов';
	document.getElementById('map-city').textContent = 'Офлайн-режим';
	document.getElementById('map-subtitle').textContent = 'Нет сохранённых городов';
	setLocationStatus('Нет сохранённых офлайн-городов. Подключитесь к интернету и сохраните город в настройках.');
	renderCategories();
	renderMarkers();
	applyFilters();
}

function toggleRoutePlace(placeId) {
	if (selectedPlaceIds.has(placeId)) selectedPlaceIds.delete(placeId);
	else selectedPlaceIds.add(placeId);
	document.getElementById('route-count').textContent = String(selectedPlaceIds.size);
	updateProfile();
	applyFilters();
}

function routeDistanceLabel(meters) {
	return meters >= 1000 ? `${(meters / 1000).toFixed(1)} км` : `${Math.max(0, Math.round(meters))} м`;
}

function localizedManeuver(step) {
	const modifier = step.modifier || '';
	const direction = modifier.includes('left') ? 'налево' : modifier.includes('right') ? 'направо' : modifier.includes('uturn') ? 'развернитесь' : '';
	if (step.type === 'arrive') return 'Вы прибыли в пункт назначения';
	if (step.type === 'depart') return 'Начните движение';
	if (step.type === 'turn' || step.type === 'end of road' || step.type === 'ramp') return direction ? `Поверните ${direction}` : 'Продолжайте по дороге';
	if (step.type === 'roundabout' || step.type === 'rotary') return 'На круговом движении';
	if (step.type === 'merge') return 'Перестройтесь и продолжайте движение';
	if (step.type === 'fork') return direction ? `На развилке держитесь ${direction}` : 'На развилке держитесь прямо';
	if (step.type === 'on ramp') return 'Въезжайте на съезд';
	return direction ? `Держитесь ${direction}` : 'Продолжайте движение';
}

function currentNavigationTarget() {
	const step = routeData?.result.steps[navigationStepIndex];
	if (!step?.location || step.location.length < 2) return null;
	return [Number(step.location[1]), Number(step.location[0])];
}

function renderNavigationStep() {
	if (!routeData) return;
	const step = routeData.result.steps[navigationStepIndex];
	if (!step) return;
	document.getElementById('navigation-instruction').textContent = localizedManeuver(step);
	document.getElementById('navigation-road').textContent = step.name || (travelMode === 'walk' ? 'Пешеходный маршрут' : 'Дорога');
	const icon = step.modifier?.includes('left') ? '↰' : step.modifier?.includes('right') ? '↱' : step.type === 'arrive' ? '●' : '↑';
	document.getElementById('navigation-maneuver-icon').textContent = icon;
}

function updateNavigationPosition(latitude, longitude, accuracy = 0) {
	if (!navigationActive || !routeData) return;
	userLocation = [latitude, longitude];
	if (!userMarker) {
		userMarker = createUserPlacemark(userLocation);
		map.geoObjects.add(userMarker);
	} else {
		userMarker.geometry.setCoordinates(userLocation);
	}
	const steps = routeData.result.steps;
	const thresholdKm = travelMode === 'walk' ? 0.035 : 0.08;
	let target = currentNavigationTarget();
	while (target && navigationStepIndex < steps.length - 1 && distanceBetween(userLocation, target) <= thresholdKm) {
		navigationStepIndex += 1;
		target = currentNavigationTarget();
		renderNavigationStep();
	}
	const remainingToManeuver = target ? distanceBetween(userLocation, target) * 1000 : 0;
	document.getElementById('navigation-distance').textContent = routeDistanceLabel(remainingToManeuver);
	const previousDistance = steps.slice(0, navigationStepIndex).reduce((total, step) => total + (Number(step.distance) || 0), 0);
	const traveledOnStep = Math.max(0, (Number(steps[navigationStepIndex]?.distance) || 0) - remainingToManeuver);
	const traveled = Math.min(routeData.result.distance, previousDistance + traveledOnStep);
	const progress = routeData.result.distance ? traveled / routeData.result.distance : 0;
	document.getElementById('navigation-progress-fill').style.width = `${Math.min(100, Math.max(0, progress * 100))}%`;
	const remainingMeters = Math.max(0, routeData.result.distance - traveled);
	const remainingMinutes = Math.max(1, Math.ceil(routeData.result.duration * (1 - progress) / 60));
	document.getElementById('navigation-eta').textContent = `${routeDistanceLabel(remainingMeters)} · около ${remainingMinutes} мин`;
	document.getElementById('navigation-remaining').textContent = `${routeDistanceLabel(remainingMeters)} · около ${remainingMinutes} мин${accuracy > 100 ? ` · GPS ±${Math.round(accuracy)} м` : ''}`;
	if (distanceBetween(map.getCenter(), userLocation) > 0.025) {
		map.setCenter(userLocation, map.getZoom(), {duration: 350, timingFunction: 'ease-in-out'});
	}
	if (steps[navigationStepIndex]?.type === 'arrive' && remainingToManeuver < thresholdKm * 1000) {
		document.getElementById('navigation-instruction').textContent = 'Вы прибыли в пункт назначения';
		document.getElementById('navigation-distance').textContent = '0 м';
		document.getElementById('navigation-progress-fill').style.width = '100%';
	}
}

function startNavigation() {
	if (!routeData || routeData.mode !== travelMode) return;
	navigationActive = true;
	navigationStepIndex = 0;
	const panel = document.getElementById('navigation-panel');
	panel.hidden = false;
	document.getElementById('navigation-destination').textContent = routeData.place.name;
	const initialDistance = routeDistanceLabel(routeData.result.distance);
	const initialMinutes = Math.max(1, Math.round(routeData.result.duration / 60));
	document.getElementById('navigation-eta').textContent = `${initialDistance} · около ${initialMinutes} мин`;
	document.getElementById('navigation-distance').textContent = initialDistance;
	document.getElementById('navigation-remaining').textContent = `До цели · ${initialDistance} · около ${initialMinutes} мин`;
	document.getElementById('navigation-progress-fill').style.width = '0%';
	renderNavigationStep();
	setActiveView('map');
	if (map) map.invalidateSize();
	const options = {enableHighAccuracy: true, maximumAge: 2000, timeout: 15000};
	if (window.pywebview?.api?.get_location) {
		const pollLocation = async () => {
			if (!navigationActive) return;
			try {
				const position = await window.pywebview.api.get_location();
				if (position.error) throw new Error(position.error);
				updateNavigationPosition(position.latitude, position.longitude, position.accuracy);
			} catch (error) {
				setLocationStatus(error.message || 'Не удалось обновить геопозицию', true);
			} finally {
				if (navigationActive) navigationLocationPolling = window.setTimeout(pollLocation, 5000);
			}
		};
		pollLocation();
	} else if (navigator.geolocation?.watchPosition) {
		navigationWatchId = navigator.geolocation.watchPosition(
			position => updateNavigationPosition(position.coords.latitude, position.coords.longitude, position.coords.accuracy),
			error => setLocationStatus(error.message || 'Потеряна геопозиция', true),
			options
		);
	} else {
		navigationActive = false;
		setLocationStatus('Навигация требует доступ к геопозиции', true);
		return;
	}
	setLocationStatus(`Навигация · ${travelMode === 'walk' ? 'пешком' : 'на машине'} · ${routeData.place.name}`);
}

function stopNavigation(clearRouteAfter = false) {
	navigationActive = false;
	if (navigationWatchId !== null && navigator.geolocation?.clearWatch) navigator.geolocation.clearWatch(navigationWatchId);
	if (navigationLocationPolling !== null) window.clearTimeout(navigationLocationPolling);
	navigationWatchId = null;
	navigationLocationPolling = null;
	document.getElementById('navigation-panel').hidden = true;
	if (clearRouteAfter) clearRoute();
}

async function buildSelectedRoute() {
	document.querySelector('.map-route-controls').hidden = false;
	const routePlaces = places.filter(place => selectedPlaceIds.has(place.id));
	if (!routePlaces.length) {
		setLocationStatus('Сначала добавьте места в маршрут', true);
		return;
	}
	if (!userLocation) {
		setLocationStatus('Сначала определите своё местоположение', true);
		return;
	}
	const place = routePlaces[0];
	const requestSequence = ++routeRequestSequence;
	const requestedMode = travelMode;
	const startButton = document.getElementById('route-start-button');
	startButton.hidden = true;
	const target = [place.latitude, place.longitude];
	const query = new URLSearchParams({from: userLocation.join(','), to: target.join(','), mode: requestedMode});
	if (offlineStartupMode && offlineCities.includes(currentCity)) {
		query.set('offline', '1');
		query.set('city', currentCity);
	}
	try {
		const response = await fetch(`/api/route?${query}`);
		const result = await response.json();
		if (requestSequence !== routeRequestSequence || requestedMode !== travelMode) return;
		if (!response.ok) throw new Error(result.error || 'Маршрут недоступен');
		const coordinates = (result.geometry && result.geometry.coordinates) ? result.geometry.coordinates.map(([lon, lat]) => [lat, lon]) : [];
		if (!coordinates.length) throw new Error('Маршрут не содержит геометрии');
		if (activeRoute) map.geoObjects.remove(activeRoute);
		routeData = {place, result, coordinates, mode: requestedMode};
		activeRoute = new window.ymaps.Polyline(coordinates, {}, {
			strokeColor: requestedMode === 'walk' ? '#4d9b76' : '#4785cf',
			strokeWidth: 7,
			strokeOpacity: 0.92
		});
		map.geoObjects.add(activeRoute);
		map.setBounds(activeRoute.geometry.getBounds(), {checkZoomRange: true, padding: [48, 48]});
		const distance = routeDistanceLabel(result.distance);
		const duration = `${Math.max(1, Math.round(result.duration / 60))} мин`;
		startButton.hidden = false;
		setLocationStatus(`Маршрут до «${place.name}» построен · ${distance} · ${duration} · ${result.offline ? 'офлайн' : 'онлайн'}`);
	} catch (error) {
		if (requestSequence !== routeRequestSequence) return;
		startButton.hidden = true;
		setLocationStatus(error.message || 'Не удалось построить маршрут', true);
	}
}

function clearRoute() {
	if (navigationActive) stopNavigation(false);
	selectedPlaceIds.clear();
	if (activeRoute && map) map.geoObjects.remove(activeRoute);
	activeRoute = null;
	routeData = null;
	document.getElementById('route-start-button').hidden = true;
	document.querySelector('.map-route-controls').hidden = true;
	document.getElementById('route-count').textContent = '0';
	applyFilters();
	setLocationStatus(userLocation ? 'Местоположение определено' : 'Местоположение не определено');
}

async function locateUser() {
	const buttons = [document.getElementById('locate-button'), document.getElementById('locate-text-button')];
	buttons.forEach(button => { button.disabled = true; });
	setLocationStatus('Запрашиваем разрешение на геолокацию…');
	let located = false;

	const showPosition = async (latitude, longitude, accuracy) => {
		userLocation = [latitude, longitude];
		located = true;
		sortSelect.querySelector('option[value="distance"]').disabled = false;
		if (map && window.ymaps) {
			if (userMarker) map.geoObjects.remove(userMarker);
			userMarker = createUserPlacemark(userLocation);
		}
		let closestCity = null;
		let closestDistance = Infinity;
		Object.entries(cityCenters).filter(([name]) => !offlineCityFilterEnabled || offlineCities.includes(name)).forEach(([name, center]) => {
			const distance = distanceBetween(userLocation, center);
			if (distance < closestDistance) {
				closestCity = name;
				closestDistance = distance;
			}
		});
		startupLocationCity = closestCity;
		if (accuracy <= 1000 && closestCity && closestCity !== currentCity && closestDistance < 60) {
			await loadCity(closestCity, false);
		}
		if (map && userMarker) {
			if (map.geoObjects.indexOf(userMarker) === -1) map.geoObjects.add(userMarker);
			const locationZoom = accuracy <= 50 ? 16 : accuracy <= 150 ? 15 : accuracy <= 500 ? 14 : accuracy <= 1500 ? 12 : 10;
			map.flyTo(userLocation, locationZoom, {duration: 0.6});
		}
		setLocationStatus(`Вы на карте · точность около ${Math.round(accuracy)} м${accuracy > 500 ? ' · приближение ограничено' : ''}`);
		applyFilters();
	};
	const showError = error => {
		const messages = {
			1: 'Разрешите доступ к геопозиции для приложения в настройках macOS',
			2: 'Не удалось определить координаты устройства',
			3: 'Истекло время ожидания геолокации'
		};
		setLocationStatus(messages[error.code] || error.message || 'Геолокация недоступна', true);
	};

	try {
		if (window.pywebview && window.pywebview.api && window.pywebview.api.get_location) {
			const position = await window.pywebview.api.get_location();
			if (position.error) throw new Error(position.error);
			await showPosition(position.latitude, position.longitude, position.accuracy);
		} else if (navigator.geolocation) {
			await new Promise((resolve, reject) => navigator.geolocation.getCurrentPosition(
				position => resolve(showPosition(position.coords.latitude, position.coords.longitude, position.coords.accuracy)),
				reject,
				{enableHighAccuracy: true, timeout: 15000, maximumAge: 30000}
			));
		} else {
			throw new Error('Геолокация недоступна в этой версии WebKit');
		}
	} catch (error) {
		showError(error);
	} finally {
		buttons.forEach(button => { button.disabled = false; });
	}
	return located;
}

function setStartupCheck(id, text, state) {
	const item = document.getElementById(id);
	item.textContent = `${text} · ${state}`;
	item.dataset.state = state === 'готово' || state === 'есть' ? 'done' : state === 'нет' || state === 'не определено' || state === 'ошибка' ? 'error' : 'pending';
}

function finishStartup() {
	const screen = document.getElementById('startup-screen');
	screen.classList.add('is-hidden');
	window.setTimeout(() => { screen.hidden = true; }, 380);
}

async function checkInternetConnection() {
	const controller = new AbortController();
	const timeoutId = window.setTimeout(() => controller.abort(), 10000);
	try {
		const response = await fetch('/api/connectivity', {signal: controller.signal});
		const result = await response.json();
		lastConnectivityResult = Boolean(result.online);
		setStartupCheck('startup-internet', 'Интернет', result.online ? 'есть' : 'нет');
		return lastConnectivityResult;
	} catch (_) {
		lastConnectivityResult = false;
		setStartupCheck('startup-internet', 'Интернет', 'нет');
		return false;
	} finally {
		window.clearTimeout(timeoutId);
	}
}

function showNetworkNotice(connected) {
	if (networkNoticeDismissed) return;
	if (connected && !offlineStartupMode) {
		document.getElementById('internet-restored-notice').hidden = true;
		return;
	}
	document.getElementById('network-notice-title').textContent = connected ? 'Интернет появился' : 'Интернет пропал';
	document.getElementById('network-notice-message').textContent = connected
		? 'Перейти в онлайн-режим?'
		: 'Попробовать переподключиться или продолжить офлайн?';
	const retryButton = document.getElementById('network-notice-retry');
	const actionButton = document.getElementById('network-notice-action');
	retryButton.textContent = connected ? 'Позже' : 'Переподключиться';
	retryButton.classList.toggle('primary', !connected);
	actionButton.textContent = connected ? 'Перейти онлайн' : 'Продолжить офлайн';
	actionButton.classList.toggle('primary', connected);
	document.getElementById('internet-restored-notice').hidden = false;
}

function startInternetMonitor(initialState = lastConnectivityResult) {
	if (offlineInternetMonitor) window.clearInterval(offlineInternetMonitor);
	monitoredConnectivity = initialState;
	const probe = async () => {
		const connected = await checkInternetConnection();
		if (monitoredConnectivity === null) {
			monitoredConnectivity = connected;
			return;
		}
		if (connected !== monitoredConnectivity) {
			monitoredConnectivity = connected;
			networkNoticeDismissed = false;
			showNetworkNotice(connected);
		}
	};
	window.addEventListener('online', probe);
	window.addEventListener('offline', probe);
	offlineInternetMonitor = window.setInterval(probe, 20000);
	probe();
}

async function retryInternetConnection(button) {
	button.disabled = true;
	const previousText = button.textContent;
	button.textContent = 'Проверяем…';
	const connected = await checkInternetConnection();
	button.disabled = false;
	button.textContent = previousText;
	if (connected) {
		monitoredConnectivity = true;
		networkNoticeDismissed = false;
		showNetworkNotice(true);
	} else {
		document.getElementById('network-notice-message').textContent = 'Подключение пока не найдено. Можно продолжить офлайн.';
	}
}

async function continueOfflineAfterLoss(button) {
	button.disabled = true;
	button.textContent = 'Переключаем…';
	try {
		await loadOfflineCityManifest();
		offlineStartupMode = true;
		offlineCityFilterEnabled = true;
		const availableOfflineCities = [...offlineCities];
		const selectedOfflineCity = availableOfflineCities.includes(currentCity) ? currentCity : availableOfflineCities[0];
		if (mapProvider !== 'offline' || activeMapProvider !== 'offline') await switchMapProvider('offline');
		if (selectedOfflineCity) {
			if (currentCity !== selectedOfflineCity) currentCity = selectedOfflineCity;
			await loadCity(selectedOfflineCity, true);
		} else {
			showNoSavedOfflineCities();
		}
		populateCityPicker(availableOfflineCities);
		setLocationStatus('Нет интернета · офлайн-режим');
		document.getElementById('internet-restored-notice').hidden = true;
		networkNoticeDismissed = false;
		refreshCacheInfo();
	} catch (error) {
		document.getElementById('network-notice-message').textContent = error.message || 'Не удалось включить офлайн-режим.';
	} finally {
		button.disabled = false;
		button.textContent = 'Продолжить офлайн';
	}
}

async function switchOnlineAfterRestore(button) {
	if (!offlineStartupMode) return;
	button.disabled = true;
	button.textContent = 'Переключаем…';
	const switched = await switchMapProvider('yandex');
	button.disabled = false;
	button.textContent = 'Перейти онлайн';
	if (!switched) return;
	offlineStartupMode = false;
	offlineCityFilterEnabled = false;
	monitoredConnectivity = true;
	document.getElementById('internet-restored-notice').hidden = true;
	document.getElementById('map-provider').value = 'yandex';
	populateCityPicker(Object.keys(cityCenters));
	setLocationStatus('Интернет восстановлен · онлайн-режим');
}

function showStartupOfflinePrompt() {
	setStartupCheck('startup-internet', 'Интернет', 'нет');
	document.getElementById('startup-message').textContent = 'Подключение не найдено';
	document.getElementById('startup-offline-message').textContent = 'Интернета нет. Продолжить офлайн или попробовать ещё?';
	document.getElementById('startup-offline-actions').hidden = false;
}

function waitForStartupChoice() {
	return new Promise(resolve => { startupDecisionHandler = resolve; });
}

function updateOfflineCityCount() {
	const count = document.getElementById('offline-cities-count');
	if (!count) return;
	count.textContent = `${offlineCities.length} ${offlineCities.length === 1 ? 'город' : 'городов'}`;
	const description = document.getElementById('offline-cities-description');
	const button = document.getElementById('manage-offline-cities');
	if (description) description.textContent = offlineCities.length
		? 'Каталог и пешие маршруты доступны офлайн; карта использует просмотренные тайлы.'
		: 'Добавьте города, чтобы подготовить каталог, фото и пешие маршруты для офлайн-режима.';
	if (button) button.textContent = offlineCities.length ? 'Управлять' : 'Добавить города';
}

async function loadOfflineCityManifest() {
	try {
		const response = await fetch('/api/offline/cities');
		if (!response.ok) return;
		const info = await response.json();
		offlineCities = Array.isArray(info.cities) ? info.cities : offlineCities;
		localStorage.setItem('smart-guide-offline-cities', JSON.stringify(offlineCities));
		updateOfflineCityCount();
	} catch (_) {
		updateOfflineCityCount();
	}
}

function renderOfflineCityOptions() {
	const container = document.getElementById('offline-city-options');
	const query = document.getElementById('offline-city-search').value.trim().toLocaleLowerCase('ru');
	container.replaceChildren();
	const names = Object.keys(cityCenters)
		.filter(name => !offlineStartupMode || offlineCities.includes(name))
		.sort((first, second) => first.localeCompare(second, 'ru'));
	const visibleNames = names.filter(name => name.toLocaleLowerCase('ru').includes(query));
	visibleNames.forEach(name => {
		const label = document.createElement('label');
		label.className = 'offline-city-option';
		const checkbox = document.createElement('input');
		checkbox.type = 'checkbox';
		checkbox.value = name;
		checkbox.checked = setupSelectedCities.has(name);
		checkbox.addEventListener('change', () => {
			if (checkbox.checked) setupSelectedCities.add(name);
			else setupSelectedCities.delete(name);
		});
		const text = document.createElement('span');
		text.textContent = name;
		if (name === startupLocationCity) {
			const recommended = document.createElement('small');
			recommended.textContent = 'рядом с вами';
			label.append(checkbox, text, recommended);
		} else if (!startupLocationCity && name === currentCity) {
			const recommended = document.createElement('small');
			recommended.textContent = 'выбран автоматически';
			label.append(checkbox, text, recommended);
		} else {
			label.append(checkbox, text);
		}
		container.append(label);
	});
	if (!visibleNames.length) {
		const empty = document.createElement('p');
		empty.className = 'empty-state';
		empty.textContent = offlineStartupMode ? 'Нет сохранённых офлайн-городов' : 'Город не найден';
		container.append(empty);
	}
	const downloadButton = document.getElementById('download-cities');
	if (offlineStartupMode) {
		downloadButton.disabled = true;
		downloadButton.title = 'Для скачивания городов требуется интернет';
	} else {
		downloadButton.disabled = false;
		downloadButton.title = '';
	}
}

async function refreshCacheInfo() {
	const label = document.getElementById('cache-size');
	try {
		const response = await fetch('/api/cache');
		const info = await response.json();
		const size = info.bytes < 1024 * 1024
			? `${Math.round(info.bytes / 1024)} КБ`
			: `${(info.bytes / (1024 * 1024)).toFixed(1)} МБ`;
		label.textContent = `${info.tiles} тайлов · ${info.photos} фото · ${size}`;
	} catch (_) {
		label.textContent = 'Не удалось прочитать кеш';
	}
}

async function saveOfflineCities() {
	if (offlineStartupMode) {
		document.getElementById('offline-download-status').textContent = 'Скачивание пропущено: подключитесь к интернету, чтобы добавить города.';
		return;
	}
	const selected = [...setupSelectedCities];
	const status = document.getElementById('offline-download-status');
	const progress = document.getElementById('offline-download-progress');
	const progressMessage = document.getElementById('offline-download-message');
	const button = document.getElementById('download-cities');
	button.disabled = true;
	const cityNames = [...new Set(selected)];
	let cachedPhotos = 0;
	progress.hidden = false;
	status.textContent = '';
	try {
		for (const city of selected) {
			progressMessage.textContent = `Сохраняем каталог и фотографии: ${city}…`;
			const response = await fetch(`/api/bootstrap?city=${encodeURIComponent(city)}`);
			if (!response.ok) continue;
			const payload = await response.json();
			const candidates = payload.places.filter(place => place.image_source_url).slice(0, 20);
			for (let index = 0; index < candidates.length; index += 4) {
				const batch = candidates.slice(index, index + 4);
				const results = await Promise.allSettled(batch.map(place => fetch(`/api/photo/${place.id}?size=320`)));
				cachedPhotos += results.filter(result => result.status === 'fulfilled' && result.value.ok).length;
			}
		}
		progressMessage.textContent = 'Включаем офлайн-маршрутизацию…';
		const manifestResponse = await fetch('/api/offline/cities', {
			method: 'POST', headers: {'Content-Type': 'application/json'},
			body: JSON.stringify({cities: cityNames})
		});
		const manifest = await manifestResponse.json();
		if (!manifestResponse.ok) throw new Error(manifest.error || 'Не удалось сохранить города');
		offlineCities = cityNames;
		localStorage.setItem('smart-guide-offline-cities', JSON.stringify(offlineCities));
		localStorage.setItem('smart-guide-initial-setup', 'done');
		updateOfflineCityCount();
		const routingMessages = {
			ready: 'Пешие маршруты готовы офлайн.',
			starting: 'Пеший маршрутизатор запускается; подождите немного и попробуйте снова.',
			'unavailable': 'Маршрутизатор не запущен. Проверьте Docker и повторите сохранение.',
			'docker-required': 'Для офлайн-маршрутов установите Docker и повторите сохранение.',
			'graph-missing': 'Дорожный граф Беларуси не найден на сервере.'
		};
		status.textContent = `${selected.length ? `Города сохранены, фото подготовлено: ${cachedPhotos}. ` : 'Список офлайн-городов обновлён. '}${routingMessages[manifest.routing_status] || 'Маршрутизация проверяется.'} Карта использует тайлы, просмотренные заранее.`;
		await refreshCacheInfo();
		if (manifest.routing_status === 'ready') window.setTimeout(() => document.getElementById('first-run-dialog').close(), 1400);
	} catch (error) {
		status.textContent = `Не удалось сохранить выбор: ${error.message}`;
	} finally {
		progress.hidden = true;
		button.disabled = false;
	}
}

function openOfflineCityManager(recommendCity = false) {
	setupSelectedCities = new Set(offlineCities);
	if (recommendCity && setupSelectedCities.size === 0) setupSelectedCities.add(startupLocationCity || currentCity);
	const setupNote = document.getElementById('offline-setup-note');
	if (recommendCity) {
		const recommendedCity = startupLocationCity || currentCity;
		const internetAvailable = document.getElementById('startup-internet').dataset.state === 'done';
		setupNote.textContent = `Для первого запуска выбрали ${recommendedCity}. Каталог и пешие маршруты подготовим офлайн${internetAvailable ? ', фотографии загрузим сейчас' : '; фотографии можно загрузить при появлении интернета'}. Тайлы карты сохраняются при просмотре районов онлайн.`;
	} else {
		setupNote.textContent = offlineStartupMode
			? 'Интернета нет. Доступны только уже сохранённые города; скачивание новых городов и фотографий пропущено.'
			: 'Выберите города, для которых подготовить офлайн-каталог и пешие маршруты. При подключении можно также загрузить фотографии; тайлы карты сохраняются при просмотре районов.';
	}
	document.getElementById('offline-city-search').value = '';
	document.getElementById('offline-download-status').textContent = '';
	renderOfflineCityOptions();
	const dialog = document.getElementById('first-run-dialog');
	if (!dialog.open) dialog.showModal();
}

async function startApplication() {
	const screen = document.getElementById('startup-screen');
	document.getElementById('map-provider').value = mapProvider;
	screen.hidden = false;
	setStartupCheck('startup-catalog', 'Каталог', 'загружаем');
	setStartupCheck('startup-internet', 'Интернет', 'проверяем');
	setStartupCheck('startup-location', 'Местоположение', 'определяем');
	const catalogTask = Promise.all([loadCity(requestedCity), loadPersistedProfile(), loadOfflineCityManifest()]).then(() => {
		setStartupCheck('startup-catalog', 'Каталог', 'готово');
	});
	const internetTask = checkInternetConnection();
	const internetAvailable = await Promise.race([
		internetTask,
		new Promise(resolve => window.setTimeout(() => resolve(null), 10000))
	]);
	if (internetAvailable !== true) {
		showStartupOfflinePrompt();
		const choice = await waitForStartupChoice();
		document.getElementById('startup-offline-actions').hidden = true;
		if (choice === 'offline') {
			offlineStartupMode = true;
			document.getElementById('startup-message').textContent = 'Продолжаем с локальной картой и каталогом';
			await loadOfflineCityManifest();
			offlineCityFilterEnabled = true;
			const availableOfflineCities = [...offlineCities];
			const selectedOfflineCity = availableOfflineCities.includes(currentCity) ? currentCity : availableOfflineCities[0];
			cityLoadSequence += 1;
			places = [];
			markers.forEach(marker => map?.geoObjects.remove(marker));
			markers.clear();
			if (selectedOfflineCity) currentCity = selectedOfflineCity;
			if (mapProvider !== 'offline' || activeMapProvider !== 'offline') await switchMapProvider('offline');
			if (selectedOfflineCity) await loadCity(selectedOfflineCity, true);
			else showNoSavedOfflineCities();
			setStartupCheck('startup-location', 'Местоположение', 'определяем');
			finishStartup();
			refreshCacheInfo();
			startInternetMonitor(false);
			locateUser();
			return;
		}
	}
	await catalogTask;
	document.getElementById('startup-message').textContent = 'Ищем ваше местоположение…';
	const locationTask = locateUser();
	const locationFound = await Promise.race([
		locationTask,
		new Promise(resolve => window.setTimeout(() => resolve(false), 17000))
	]);
	setStartupCheck('startup-location', 'Местоположение', locationFound ? 'готово' : 'не определено');
	finishStartup();
	await refreshCacheInfo();
	startInternetMonitor(lastConnectivityResult);
	if (localStorage.getItem('smart-guide-initial-setup') !== 'done') {
		openOfflineCityManager(true);
	}
}

citySelect.addEventListener('change', () => {
	if (navigationActive) stopNavigation(false);
	selectedPlaceIds.clear();
	routeData = null;
	document.querySelector('.map-route-controls').hidden = true;
	document.getElementById('route-start-button').hidden = true;
	document.getElementById('route-count').textContent = '0';
	if (activeRoute && map) map.geoObjects.remove(activeRoute);
	activeRoute = null;
	loadCity(citySelect.value);
});
citySearch.addEventListener('input', () => renderCitySuggestions(citySearch.value));
citySearch.addEventListener('focus', () => renderCitySuggestions(citySearch.value));
citySearch.addEventListener('keydown', event => {
	if (event.key === 'ArrowDown') {
		event.preventDefault();
		if (citySuggestions.hidden) renderCitySuggestions(citySearch.value);
		moveCitySuggestion(1);
	} else if (event.key === 'ArrowUp') {
		event.preventDefault();
		moveCitySuggestion(-1);
	} else if (event.key === 'Enter') {
		const active = citySuggestions.querySelector('[aria-selected="true"] strong')
			|| citySuggestions.querySelector('[role="option"] strong');
		if (active) {
			event.preventDefault();
			selectCity(active.textContent);
		}
	} else if (event.key === 'Escape') {
		closeCitySuggestions();
		citySearch.value = currentCity;
	}
});
document.addEventListener('pointerdown', event => {
	if (!event.target.closest('.city-picker')) closeCitySuggestions();
});
document.getElementById('search').addEventListener('input', applyFilters);
sortSelect.addEventListener('change', applyFilters);
document.querySelectorAll('[data-route-mode]').forEach(button => button.addEventListener('click', () => {
	if (travelMode === button.dataset.routeMode) return;
	travelMode = button.dataset.routeMode;
	document.querySelectorAll('[data-route-mode]').forEach(option => {
		const active = option === button;
		option.classList.toggle('active', active);
		option.setAttribute('aria-checked', String(active));
	});
	if (navigationActive) stopNavigation(false);
	document.getElementById('route-start-button').hidden = true;
	if (selectedPlaceIds.size && userLocation) {
		buildSelectedRoute();
	} else if (activeRoute) {
		setLocationStatus(`Выбран режим «${travelMode === 'walk' ? 'Пешком' : 'На машине'}» · построй маршрут заново`);
	}
}));
document.getElementById('navigation-stop').addEventListener('click', () => stopNavigation(false));
document.getElementById('navigation-finish').addEventListener('click', () => stopNavigation(true));
document.getElementById('route-start-button').addEventListener('click', startNavigation);
document.getElementById('locate-text-button').addEventListener('click', locateUser);
document.getElementById('build-route').addEventListener('click', buildSelectedRoute);
document.getElementById('clear-route').addEventListener('click', clearRoute);
document.getElementById('detail-close').addEventListener('click', () => document.getElementById('place-dialog').close());
window.addEventListener('resize', () => map && map.invalidateSize());
themeToggle.addEventListener('click', () => setTheme(document.documentElement.dataset.theme === 'light' ? 'dark' : 'light'));
document.getElementById('light-theme').addEventListener('click', () => setTheme('light'));
document.getElementById('dark-theme').addEventListener('click', () => setTheme('dark'));
document.querySelectorAll('.nav-tab').forEach(tab => tab.addEventListener('click', () => setActiveView(tab.dataset.view)));
document.getElementById('mini-game-next').addEventListener('click', beginMiniGame);
document.querySelectorAll('[data-game-mode]').forEach(button => button.addEventListener('click', () => setMiniGameMode(button.dataset.gameMode)));
document.getElementById('jump-start').addEventListener('click', startJumpGame);
document.getElementById('jump-fullscreen').addEventListener('click', toggleJumpFullscreen);
document.getElementById('jump-difficulty').addEventListener('change', event => {
	if (jumpGame?.running) jumpGame.config = jumpDifficulties[event.target.value] || jumpDifficulties.normal;
});
document.querySelectorAll('[data-jump-direction]').forEach(button => {
	const direction = button.dataset.jumpDirection;
	button.addEventListener('pointerdown', event => { event.preventDefault(); button.setPointerCapture(event.pointerId); setJumpDirection(direction, true); });
	['pointerup', 'pointercancel', 'lostpointercapture'].forEach(type => button.addEventListener(type, () => setJumpDirection(direction, false)));
});
window.addEventListener('keydown', event => {
	if (document.getElementById('mini-jump-card').hidden) return;
	if (event.key === 'Escape' && document.getElementById('mini-jump-card').classList.contains('is-game-fullscreen')) {
		stopJumpGameplay();
		document.getElementById('mini-jump-card').classList.remove('is-game-fullscreen');
		document.getElementById('jump-fullscreen').textContent = 'На весь экран';
		if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
		return;
	}
	if (event.code === 'Space' && !['INPUT', 'TEXTAREA'].includes(document.activeElement?.tagName)) {
		event.preventDefault();
		if (!jumpGame?.running) startJumpGame();
		return;
	}
	if (!jumpGame?.running || ['INPUT', 'TEXTAREA'].includes(document.activeElement?.tagName)) return;
	const direction = event.code === 'ArrowLeft' || event.code === 'KeyA' ? 'left'
		: event.code === 'ArrowRight' || event.code === 'KeyD' ? 'right' : null;
	if (direction) {
		event.preventDefault();
		setJumpDirection(direction, true);
	}
});
document.addEventListener('fullscreenchange', () => {
	const card = document.getElementById('mini-jump-card');
	if (document.fullscreenElement !== card && card.classList.contains('is-game-fullscreen')) {
		stopJumpGameplay();
		card.classList.remove('is-game-fullscreen');
		document.getElementById('jump-fullscreen').textContent = 'На весь экран';
	}
});
window.addEventListener('keyup', event => {
	if (event.code === 'ArrowLeft' || event.code === 'KeyA') setJumpDirection('left', false);
	if (event.code === 'ArrowRight' || event.code === 'KeyD') setJumpDirection('right', false);
});
window.addEventListener('blur', () => { jumpHeld = {left: false, right: false}; });
document.querySelectorAll('[data-open-map]').forEach(button => button.addEventListener('click', () => setActiveView('map')));
sidebarToggle.addEventListener('click', () => setMapSidebarVisible(mapView.classList.contains('sidebar-hidden')));
document.getElementById('locate-button').addEventListener('click', () => {
	setActiveView('map');
	locateUser();
});
document.getElementById('profile-save').addEventListener('click', async () => {
	const input = document.getElementById('profile-name');
	const name = input.value.trim() || 'Гость';
	input.value = name;
	document.getElementById('profile-avatar').textContent = name.charAt(0).toLocaleUpperCase('ru');
	const message = document.getElementById('profile-message');
	message.textContent = 'Сохраняем…';
	try {
		await persistProfile();
		message.textContent = 'Профиль сохранён';
	} catch (error) {
		message.textContent = 'Не удалось сохранить профиль в базе приложения';
		console.error('Ошибка сохранения профиля:', error);
	}
});
document.getElementById('random-place-spin').addEventListener('click', pickRandomPlace);
document.getElementById('profile-random-open').addEventListener('click', () => {
	const place = places.find(item => item.id === randomPlaceId);
	if (!place) return;
	setActiveView('map');
	openDetails(place);
});
document.getElementById('city-roulette-spin').addEventListener('click', spinCityRoulette);
document.getElementById('city-roulette-open').addEventListener('click', openRouletteCity);
document.getElementById('roulette-spin-again').addEventListener('click', spinCityRoulette);
document.getElementById('roulette-choose-city').addEventListener('click', openRouletteCity);
document.getElementById('roulette-dialog-close').addEventListener('click', () => document.getElementById('city-roulette-dialog').close());
document.getElementById('offline-city-search').addEventListener('input', renderOfflineCityOptions);
document.getElementById('download-cities').addEventListener('click', saveOfflineCities);
document.getElementById('manage-offline-cities').addEventListener('click', () => openOfflineCityManager());
document.getElementById('startup-continue-offline').addEventListener('click', () => {
	const resolveChoice = startupDecisionHandler;
	startupDecisionHandler = null;
	resolveChoice?.('offline');
});
document.getElementById('startup-retry-internet').addEventListener('click', async event => {
	const button = event.currentTarget;
	button.disabled = true;
	button.textContent = 'Проверяем…';
	document.getElementById('startup-offline-message').textContent = 'Проверяем подключение к интернету…';
	const connected = await checkInternetConnection();
	button.disabled = false;
	button.textContent = 'Попробовать ещё';
	if (connected) {
		document.getElementById('startup-offline-actions').hidden = true;
		document.getElementById('startup-message').textContent = 'Интернет появился, загружаем карту…';
		const resolveChoice = startupDecisionHandler;
		startupDecisionHandler = null;
		resolveChoice?.('online');
	} else {
		document.getElementById('startup-offline-message').textContent = 'Интернета нет. Можно продолжить офлайн или попробовать ещё.';
	}
});
document.getElementById('network-notice-retry').addEventListener('click', event => {
	if (monitoredConnectivity) {
		networkNoticeDismissed = true;
		document.getElementById('internet-restored-notice').hidden = true;
		return;
	}
	retryInternetConnection(event.currentTarget);
});
document.getElementById('network-notice-action').addEventListener('click', event => {
	if (monitoredConnectivity) switchOnlineAfterRestore(event.currentTarget);
	else continueOfflineAfterLoss(event.currentTarget);
});
document.getElementById('map-provider').addEventListener('change', event => {
	const selector = event.target;
	selector.disabled = true;
	const nextProvider = selector.value === 'offline' ? 'offline' : 'yandex';
	switchMapProvider(nextProvider).finally(() => { selector.disabled = false; });
});
document.getElementById('first-run-later').addEventListener('click', () => {
	localStorage.setItem('smart-guide-initial-setup', 'done');
	document.getElementById('first-run-dialog').close();
});
document.getElementById('clear-cache').addEventListener('click', () => document.getElementById('clear-cache-dialog').showModal());
document.getElementById('cancel-clear-cache').addEventListener('click', () => document.getElementById('clear-cache-dialog').close());
document.getElementById('confirm-clear-cache').addEventListener('click', async event => {
	const button = event.currentTarget;
	button.disabled = true;
	button.textContent = 'Очищаем…';
	try {
		const response = await fetch('/api/cache/clear', {method: 'POST'});
		const result = await response.json();
		if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
		await refreshCacheInfo();
		document.getElementById('clear-cache-dialog').close();
	} catch (error) {
		document.getElementById('cache-size').textContent = error.message || 'Не удалось очистить кеш';
	} finally {
		button.disabled = false;
		button.textContent = 'Очистить';
	}
});
document.getElementById('jump-record').textContent = String(jumpRecord);
try { setTheme(localStorage.getItem('smart-guide-theme') || 'dark'); } catch (_) { setTheme('dark'); }
try { setMapSidebarVisible(localStorage.getItem('smart-guide-sidebar-visible') !== 'false'); } catch (_) { setMapSidebarVisible(true); }
startApplication();

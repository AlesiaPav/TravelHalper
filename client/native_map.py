"""Native macOS map window powered by pywebview and WebKit."""

from __future__ import annotations

import threading
from pathlib import Path
from typing import Callable, Optional

import webview
try:
    import CoreLocation
    import objc
    from Foundation import NSObject
    from PyObjCTools import AppHelper
except ImportError:
    CoreLocation = None
    objc = None
    NSObject = object
    AppHelper = None


class _LocationDelegate(NSObject):
    def initWithProvider_(self, provider: "LocationProvider"):
        self = objc.super(_LocationDelegate, self).init()
        if self is not None:
            self.provider = provider
        return self

    def locationManagerDidChangeAuthorization_(self, manager: object) -> None:
        self.provider._authorization_changed(manager)

    def locationManager_didChangeAuthorizationStatus_(self, manager: object, status: int) -> None:
        self.provider._authorization_changed(manager)

    def locationManager_didUpdateLocations_(self, manager: object, locations: object) -> None:
        location = locations[-1]
        coordinate = location.coordinate()
        self.provider._finish({
            "latitude": coordinate.latitude,
            "longitude": coordinate.longitude,
            "accuracy": location.horizontalAccuracy(),
        })

    def locationManager_didFailWithError_(self, manager: object, error: object) -> None:
        self.provider._finish(error=str(error))


class LocationProvider:
    """Request one current position through macOS Location Services."""

    def __init__(self) -> None:
        self._event = threading.Event()
        self._lock = threading.Lock()
        self._result: Optional[dict[str, object]] = None
        self._manager: Optional[object] = None
        self._delegate: Optional[object] = None

    def get_location(self) -> dict[str, object]:
        if CoreLocation is None or AppHelper is None:
            return {"error": "Системная геолокация недоступна"}
        with self._lock:
            self._event.clear()
            self._result = None
            AppHelper.callAfter(self._start_request)
            if not self._event.wait(30):
                return {"error": "Истекло время ожидания геолокации"}
            return self._result or {"error": "Не удалось получить координаты"}

    def _start_request(self) -> None:
        self._manager = CoreLocation.CLLocationManager.alloc().init()
        self._delegate = _LocationDelegate.alloc().initWithProvider_(self)
        self._manager.setDelegate_(self._delegate)
        self._manager.setDesiredAccuracy_(CoreLocation.kCLLocationAccuracyNearestTenMeters)
        self._authorization_changed(self._manager)

    def _authorization_changed(self, manager: object) -> None:
        status = manager.authorizationStatus()
        allowed = (
            CoreLocation.kCLAuthorizationStatusAuthorizedAlways,
            CoreLocation.kCLAuthorizationStatusAuthorizedWhenInUse,
        )
        if status in allowed:
            manager.requestLocation()
        elif status in (
            CoreLocation.kCLAuthorizationStatusDenied,
            CoreLocation.kCLAuthorizationStatusRestricted,
        ):
            self._finish(error="Разрешите доступ к геопозиции для приложения в настройках macOS")
        else:
            manager.requestWhenInUseAuthorization()

    def _finish(self, result: Optional[dict[str, object]] = None, error: Optional[str] = None) -> None:
        self._result = result if result is not None else {"error": error or "Геолокация недоступна"}
        self._event.set()


class MapBridge:
    """Bridge exposed to JavaScript inside the native map window."""

    def __init__(self, on_place_selected: Callable[[int], None], location_provider: LocationProvider) -> None:
        self.on_place_selected = on_place_selected
        self.location_provider = location_provider

    def add_to_route(self, place_id: int) -> None:
        self.on_place_selected(int(place_id))

    def get_location(self) -> dict[str, object]:
        return self.location_provider.get_location()


class NativeMapWindow:
    """Open Leaflet in a native macOS WebKit window, without Safari."""

    def __init__(self, url: str, on_place_selected: Callable[[int], None]) -> None:
        self.url = url
        self.bridge = MapBridge(on_place_selected, LocationProvider())
        self.window: Optional[webview.Window] = None
        self._started = False

    def open(self) -> None:
        if self._started and self.window is not None:
            self.window.show()
            return
        self._started = True
        self.window = self._create_window()
        threading.Thread(target=self._start_webview, daemon=True).start()

    def run(self) -> None:
        self._started = True
        self.window = self._create_window()
        webview.start(gui="cocoa")

    def _create_window(self) -> webview.Window:
        return webview.create_window(
            "Умный гид: карта",
            self.url,
            js_api=self.bridge,
            width=1100,
            height=760,
            resizable=True,
        )

    def _start_webview(self) -> None:
        webview.start(gui="cocoa", debug=True)

    def build_route(self, points: list[list[float]], offline: bool) -> None:
        if self.window is None:
            return
        javascript = f"buildRoute({points!r}, {str(offline).lower()});"
        try:
            self.window.evaluate_js(javascript)
        except Exception:
            return
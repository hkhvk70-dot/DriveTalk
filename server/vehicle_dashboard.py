"""Owner-only dashboard access; no automatic wake or background vehicle polling."""
from __future__ import annotations

import threading
import time
from typing import Any, Callable
from urllib.parse import quote, urlencode


class DashboardError(RuntimeError):
    def __init__(self, status: int, message: str, retry_after: int = 0):
        super().__init__(message)
        self.status = status
        self.retry_after = retry_after


class VehicleDashboard:
    def __init__(self, fleet_base: str, token_supplier: Callable[[], str], request: Callable[..., dict],
                 configured_vin: str = "", clock: Callable[[], float] = time.monotonic):
        self.base = fleet_base.rstrip("/")
        self.token_supplier = token_supplier
        self.request = request
        self.configured_vin = configured_vin
        self.clock = clock
        self.lock = threading.RLock()
        self.target: str | None = None
        self.target_until = 0.0
        self.status_cache: dict | None = None
        self.status_until = 0.0
        self.data_cache: dict | None = None
        self.data_until = 0.0
        self.data_revision = 0
        self.data_fetched_at = None
        self.next_data_at = 0.0
        self.next_wake_at = 0.0
        self.upstream_blocked_until = 0.0
        self.command_sync_until = 0.0
        self.command_sync_reads = 0

    def begin_command_sync(self):
        """At most two spaced fresh reads after a command; never wake or poll forever."""
        with self.lock:
            self.command_sync_until = self.clock() + 30
            self.command_sync_reads = 2
            self.data_until = self.status_until = 0.0

    def invalidate(self):
        with self.lock:
            self.target = None
            self.target_until = self.status_until = self.data_until = 0.0
            self.status_cache = self.data_cache = None
            self.command_sync_until = 0.0
            self.command_sync_reads = 0

    def _call(self, path: str, *, wake: bool = False) -> dict:
        now = self.clock()
        if now < self.upstream_blocked_until:
            raise DashboardError(429, "Tesla 请求限流，请稍后再试", int(self.upstream_blocked_until - now) + 1)
        try:
            kwargs: dict[str, Any] = {"bearer": self.token_supplier()}
            if wake:
                kwargs["json_body"] = {}
            result = self.request(f"{self.base}/api/1/vehicles{path}", **kwargs)
        except Exception as error:
            status = getattr(error, "status", 502)
            if status == 429:
                wait = max(60, getattr(error, "retry_after", 60))
                self.upstream_blocked_until = now + wait
                raise DashboardError(429, "Tesla 请求限流，请稍后再试", wait) from error
            mapped = status if status in (401, 403, 404, 408, 412, 502, 503, 504) else 502
            raise DashboardError(mapped, "Tesla 请求未完成，请检查授权或稍后重试") from error
        if not isinstance(result, dict) or result.get("error"):
            raise DashboardError(502, "Tesla 返回了无效响应")
        return result

    def _target(self) -> str:
        if self.target and self.clock() < self.target_until:
            return self.target
        vehicles = self._call("").get("response")
        if not isinstance(vehicles, list):
            raise DashboardError(502, "Tesla 车辆列表响应无效")
        if self.configured_vin:
            matches = [v for v in vehicles if isinstance(v, dict) and v.get("vin") == self.configured_vin]
        else:
            matches = vehicles
        if len(matches) != 1 or not isinstance(matches[0], dict):
            raise DashboardError(409, "请在服务器配置唯一车辆 TESLA_VEHICLE_VIN")
        vehicle = matches[0]
        identity = vehicle.get("vin") or vehicle.get("id_s")
        if not isinstance(identity, str) or not identity:
            raise DashboardError(502, "Tesla 车辆标识无效")
        new_target = quote(identity, safe="")
        if self.target != new_target:
            self.status_cache = self.data_cache = None
            self.status_until = self.data_until = 0.0
        self.target = new_target
        self.target_until = self.clock() + 300
        return self.target

    def status(self) -> dict:
        with self.lock:
            target = self._target()
            if self.status_cache and self.clock() < self.status_until:
                return self.status_cache
            payload = self._call(f"/{target}").get("response")
            if not isinstance(payload, dict) or payload.get("state") not in ("online", "asleep", "offline", "unknown"):
                raise DashboardError(502, "Tesla 车辆状态响应无效")
            # Do not send account/vehicle identifiers to the browser.
            self.status_cache = {"response": {"state": payload["state"]}}
            self.status_until = self.clock() + 30
            return self.status_cache

    def data(self) -> dict:
        with self.lock:
            state = self.status()["response"]["state"]
            if state != "online":
                # Sleep is a valid result, not a reason to call wake_up.
                return {"response": {"state": state}}
            now = self.clock()
            syncing = now < self.command_sync_until and self.command_sync_reads > 0
            # An early-confirmed command may leave a short-lived cache. Outside
            # its sync window keep serving that labeled snapshot until the next
            # permitted read, instead of manufacturing a local 429.
            if self.data_cache and (now < self.data_until or (not syncing and now < self.next_data_at)):
                return self.data_cache
            if now < self.next_data_at and not syncing:
                raise DashboardError(429, "车辆数据读取间隔至少 60 秒", int(self.next_data_at - now) + 1)
            if syncing:
                self.command_sync_reads -= 1
            self.next_data_at = now + 60
            # Firmware 2023.38+ requires location_data explicitly. Location still
            # arrives in drive_state; requesting drive_state alone is insufficient.
            query = urlencode({"endpoints": "charge_state;climate_state;vehicle_state;drive_state;location_data"})
            result = self._call(f"/{self._target()}/vehicle_data?{query}")
            payload = result.get("response")
            if not isinstance(payload, dict):
                raise DashboardError(502, "Tesla 车辆数据响应无效")
            filtered = {key: payload[key] for key in ("charge_state", "climate_state", "vehicle_state", "drive_state") if key in payload}
            if not filtered:
                raise DashboardError(502, "Tesla 未返回仪表盘数据")
            filtered["state"] = payload.get("state", state)
            self.data_cache = {"response": filtered}
            self.data_revision += 1
            self.data_fetched_at = self.clock()
            self.data_until = self.clock() + (5 if syncing and self.command_sync_reads > 0 else 60)
            return self.data_cache

    def data_with_meta(self) -> dict:
        """Fresh means this call fetched vehicle_data, not just connection status.

        Keep the ordinary REST response unchanged. The AI readback uses explicit
        metadata instead of monkeypatching the shared dashboard transport.
        """
        with self.lock:
            before = self.data_revision
            snapshot = self.data()
            return {"snapshot": snapshot, "fresh": self.data_revision != before,
                    "revision": self.data_revision, "fetchedAt": self.data_fetched_at}

    def wake(self) -> dict:
        with self.lock:
            now = self.clock()
            if now < self.next_wake_at:
                raise DashboardError(429, "唤醒已请求，请稍后刷新车辆状态", int(self.next_wake_at - now) + 1)
            if self.status()["response"]["state"] != "asleep":
                raise DashboardError(409, "只有休眠车辆需要唤醒，请先刷新状态")
            self.next_wake_at = self.clock() + 60
            try:
                result = self._call(f"/{self._target()}/wake_up", wake=True)
                if not isinstance(result.get("response"), dict):
                    raise DashboardError(502, "Tesla 唤醒响应未确认")
                return {"accepted": True}
            finally:
                self.status_until = 0.0

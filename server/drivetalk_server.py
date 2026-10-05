#!/usr/bin/env python3
"""Private backend for DriveTalk's Tesla authorization and mobile alert feed.

The process exposes owner-authenticated read and explicit wake routes, never Tesla
tokens. Fleet Telemetry is added as a separate, mTLS-protected component; it
will write the latest route state into this service's local database.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import hmac
import html
import json
import logging
import os
import secrets
import sqlite3
import sys
import time
import threading
from contextlib import contextmanager
from dataclasses import dataclass
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, urlencode, urlparse
from urllib.request import Request, urlopen
from email.utils import parsedate_to_datetime

from vehicle_dashboard import DashboardError, VehicleDashboard
from vehicle_commands import VehicleCommands
from mobile_sessions import MobileSessions, session_cookie, TTL as SESSION_TTL

from cryptography.fernet import Fernet, InvalidToken
from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat, load_pem_public_key


LOG = logging.getLogger("drivetalk")
STATE_TTL_SECONDS = 10 * 60
DEFAULT_SCOPES = "openid offline_access vehicle_device_data vehicle_location vehicle_cmds"


class ConfigurationError(RuntimeError):
    pass


class TeslaRequestError(RuntimeError):
    def __init__(self, status: int, message: str, retry_after: int = 0) -> None:
        self.status = status
        self.retry_after = retry_after
        super().__init__(message)


def required_env(name: str) -> str:
    value = os.getenv(name, "").strip()
    if not value:
        raise ConfigurationError(f"Missing required setting: {name}")
    return value


def read_secret(path: Path) -> str:
    try:
        value = path.read_text(encoding="utf-8").strip()
    except OSError as error:
        raise ConfigurationError(f"Cannot read secret file: {path}") from error
    if not value:
        raise ConfigurationError(f"Secret file is empty: {path}")
    return value


@dataclass(frozen=True)
class Config:
    client_id: str
    client_secret_file: Path
    domain: str
    redirect_uri: str
    auth_base: str
    fleet_api_base: str
    scopes: str
    database_path: Path
    token_key_file: Path
    mobile_token_file: Path
    model_file: Path
    bind_host: str
    bind_port: int

    @classmethod
    def from_environment(cls) -> "Config":
        return cls(
            client_id=required_env("TESLA_CLIENT_ID"),
            client_secret_file=Path(os.getenv("TESLA_CLIENT_SECRET_FILE", "/opt/drivetalk/secrets/tesla-client-secret")),
            domain=required_env("TESLA_DOMAIN"),
            redirect_uri=required_env("TESLA_REDIRECT_URI"),
            auth_base=os.getenv("TESLA_AUTH_BASE", "https://auth.tesla.cn/oauth2/v3").rstrip("/"),
            fleet_api_base=os.getenv("TESLA_FLEET_API_BASE", "https://fleet-api.prd.cn.vn.cloud.tesla.cn").rstrip("/"),
            scopes=os.getenv("TESLA_SCOPES", DEFAULT_SCOPES),
            database_path=Path(os.getenv("DRIVETALK_DB_PATH", "/var/lib/drivetalk/state.sqlite3")),
            token_key_file=Path(os.getenv("DRIVETALK_TOKEN_KEY_FILE", "/opt/drivetalk/secrets/token-encryption.key")),
            mobile_token_file=Path(os.getenv("DRIVETALK_MOBILE_TOKEN_FILE", "/opt/drivetalk/secrets/mobile-api-token")),
            # Optional rights-cleared asset; public UI uses generated geometry.
            model_file=Path(os.getenv("DRIVETALK_MODEL_FILE", "/opt/drivetalk/assets/vehicle.glb")),
            bind_host=os.getenv("DRIVETALK_BIND_HOST", "127.0.0.1"),
            bind_port=int(os.getenv("DRIVETALK_BIND_PORT", "8788")),
        )

    @property
    def client_secret(self) -> str:
        return read_secret(self.client_secret_file)


class StateStore:
    def __init__(self, database_path: Path, cipher: Fernet) -> None:
        database_path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        self.database_path = database_path
        self.cipher = cipher
        with self._connect() as connection:
            connection.execute(
                "CREATE TABLE IF NOT EXISTS oauth_state (state_hash TEXT PRIMARY KEY, expires_at INTEGER NOT NULL)"
            )
            connection.execute(
                "CREATE TABLE IF NOT EXISTS protected_value (name TEXT PRIMARY KEY, value BLOB NOT NULL, updated_at INTEGER NOT NULL)"
            )

    @contextmanager
    def _connect(self):
        connection = sqlite3.connect(self.database_path, timeout=5)
        try:
            connection.execute("PRAGMA journal_mode=WAL")
            with connection:
                yield connection
        finally:
            # sqlite3's transaction context commits/rolls back but does not close.
            connection.close()

    def create_oauth_state(self) -> str:
        state = secrets.token_urlsafe(32)
        digest = hashlib.sha256(state.encode("utf-8")).hexdigest()
        now = int(time.time())
        with self._connect() as connection:
            connection.execute("DELETE FROM oauth_state WHERE expires_at < ?", (now,))
            connection.execute("INSERT INTO oauth_state(state_hash, expires_at) VALUES (?, ?)", (digest, now + STATE_TTL_SECONDS))
        return state

    def consume_oauth_state(self, state: str) -> bool:
        digest = hashlib.sha256(state.encode("utf-8")).hexdigest()
        now = int(time.time())
        with self._connect() as connection:
            row = connection.execute("SELECT expires_at FROM oauth_state WHERE state_hash = ?", (digest,)).fetchone()
            connection.execute("DELETE FROM oauth_state WHERE state_hash = ?", (digest,))
        return row is not None and row[0] >= now

    def save_protected_json(self, name: str, value: dict[str, Any]) -> None:
        encoded = json.dumps(value, separators=(",", ":")).encode("utf-8")
        encrypted = self.cipher.encrypt(encoded)
        with self._connect() as connection:
            connection.execute(
                "INSERT INTO protected_value(name, value, updated_at) VALUES (?, ?, ?) "
                "ON CONFLICT(name) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
                (name, encrypted, int(time.time())),
            )

    def has_protected_value(self, name: str) -> bool:
        with self._connect() as connection:
            return connection.execute("SELECT 1 FROM protected_value WHERE name = ?", (name,)).fetchone() is not None

    def load_protected_json(self, name: str) -> dict[str, Any] | None:
        with self._connect() as connection:
            row = connection.execute("SELECT value FROM protected_value WHERE name = ?", (name,)).fetchone()
        if row is None:
            return None
        try:
            return json.loads(self.cipher.decrypt(row[0]).decode("utf-8"))
        except (InvalidToken, UnicodeDecodeError, json.JSONDecodeError) as error:
            raise RuntimeError("Encrypted local state cannot be read") from error


def load_cipher(key_file: Path) -> Fernet:
    return Fernet(read_secret(key_file).encode("ascii"))


def request_tesla_json(url: str, form: dict[str, str] | None = None, *, bearer: str | None = None, json_body: dict | None = None) -> dict[str, Any]:
    headers = {"Accept": "application/json", "User-Agent": "DriveTalk/1.0"}
    data: bytes | None = None
    if form is not None:
        data = urlencode(form).encode("utf-8")
        headers["Content-Type"] = "application/x-www-form-urlencoded"
    elif json_body is not None:
        data = json.dumps(json_body).encode("utf-8")
        headers["Content-Type"] = "application/json"
    if bearer:
        headers["Authorization"] = f"Bearer {bearer}"
    request = Request(url, data=data, headers=headers, method="POST" if data is not None else "GET")
    try:
        with urlopen(request, timeout=15) as response:
            return json.loads(response.read().decode("utf-8"))
    except HTTPError as error:
        LOG.warning("Tesla request failed with HTTP %s", error.code)
        retry_after = 60
        try:
            raw = error.headers.get("Retry-After", "60")
            retry_after = int(raw) if raw.isdigit() else max(0, int(parsedate_to_datetime(raw).timestamp() - time.time()))
        except (ValueError, TypeError, AttributeError):
            pass
        raise TeslaRequestError(error.code, f"Tesla returned HTTP {error.code}", retry_after) from error
    except (URLError, TimeoutError, json.JSONDecodeError) as error:
        LOG.warning("Tesla request did not complete: %s", type(error).__name__)
        raise TeslaRequestError(502, "Tesla could not be reached") from error


def partner_token(config: Config) -> str:
    response = request_tesla_json(
        f"{config.auth_base}/token",
        {
            "grant_type": "client_credentials",
            "client_id": config.client_id,
            "client_secret": config.client_secret,
            "audience": config.fleet_api_base,
            "scope": "openid vehicle_device_data vehicle_cmds",
        },
    )
    token = response.get("access_token")
    if not isinstance(token, str) or not token:
        raise TeslaRequestError(502, "Tesla did not provide a partner token")
    return token


def register_partner_account(config: Config) -> dict[str, Any]:
    token = partner_token(config)
    payload = json.dumps({"domain": config.domain}).encode("utf-8")
    request = Request(
        f"{config.fleet_api_base}/api/1/partner_accounts",
        data=payload,
        headers={
            "Accept": "application/json",
            "Content-Type": "application/json",
            "Authorization": f"Bearer {token}",
            "User-Agent": "DriveTalk/1.0",
        },
        method="POST",
    )
    try:
        with urlopen(request, timeout=15) as response:
            body = response.read().decode("utf-8")
            return json.loads(body) if body else {"result": "registered"}
    except HTTPError as error:
        LOG.warning("Tesla registration failed with HTTP %s", error.code)
        raise TeslaRequestError(error.code, f"Tesla registration returned HTTP {error.code}") from error
    except (URLError, TimeoutError, json.JSONDecodeError) as error:
        LOG.warning("Tesla registration did not complete: %s", type(error).__name__)
        raise TeslaRequestError(502, "Tesla registration could not be completed") from error


def find_public_key(payload: Any) -> str | None:
    """Find Tesla's registered public key without printing the key itself."""
    if isinstance(payload, dict):
        value = payload.get("public_key")
        if isinstance(value, str) and value.strip():
            return value
        for nested_value in payload.values():
            found = find_public_key(nested_value)
            if found:
                return found
    elif isinstance(payload, list):
        for nested_value in payload:
            found = find_public_key(nested_value)
            if found:
                return found
    return None


def verify_partner_registration(config: Config) -> bool:
    """Check the partner-account key recorded by Tesla for this domain."""
    token = partner_token(config)
    response = request_tesla_json(
        f"{config.fleet_api_base}/api/1/partner_accounts/public_key?{urlencode({'domain': config.domain})}",
        bearer=token,
    )
    registered_key = find_public_key(response)
    if not registered_key:
        print("Tesla responded, but did not return a public key for this domain.")
        return False

    served_key_path = Path("/var/www/drivetalk/.well-known/appspecific/com.tesla.3p.public-key.pem")
    try:
        served_key = served_key_path.read_text(encoding="utf-8")
    except OSError:
        print("Tesla returned a public key, but the local served-key file could not be read.")
        return False

    normalized_registered = "".join(registered_key.split()).removeprefix("0x").lower()
    if normalized_registered.startswith("-----beginpublickey-----"):
        try:
            registered_public_key = load_pem_public_key(registered_key.encode("utf-8"))
            normalized_registered = registered_public_key.public_bytes(
                Encoding.X962, PublicFormat.UncompressedPoint
            ).hex()
        except ValueError:
            print("Tesla returned a public key in an unsupported PEM format.")
            return False
    try:
        served_public_key = load_pem_public_key(served_key.encode("utf-8"))
        normalized_served = served_public_key.public_bytes(Encoding.X962, PublicFormat.UncompressedPoint).hex()
    except ValueError:
        print("The locally served public-key file is not a valid PEM public key.")
        return False
    if hmac.compare_digest(normalized_registered, normalized_served):
        print("Tesla partner registration verified: the registered key matches the public key served by this domain.")
        return True

    print("Tesla returned a registered key, but it does not match this domain's served public key.")
    return False


def refresh_user_tokens(config: Config, store: StateStore) -> dict[str, Any]:
    current_tokens = store.load_protected_json("tesla_user_tokens")
    if not current_tokens or not isinstance(current_tokens.get("refresh_token"), str):
        raise ConfigurationError("Tesla user authorization is missing; open /auth/tesla/start again")
    response = request_tesla_json(
        f"{config.auth_base}/token",
        {
            "grant_type": "refresh_token",
            "client_id": config.client_id,
            "client_secret": config.client_secret,
            "refresh_token": current_tokens["refresh_token"],
            "audience": config.fleet_api_base,
        },
    )
    if not isinstance(response.get("access_token"), str):
        raise TeslaRequestError(502, "Tesla did not provide a refreshed user token")
    if not isinstance(response.get("refresh_token"), str):
        response["refresh_token"] = current_tokens["refresh_token"]
    store.save_protected_json("tesla_user_tokens", response)
    return response


def verify_user_region(config: Config) -> bool:
    store = StateStore(config.database_path, load_cipher(config.token_key_file))
    tokens = refresh_user_tokens(config, store)
    response = request_tesla_json(
        f"{config.fleet_api_base}/api/1/users/region",
        bearer=tokens["access_token"],
    )
    payload = response.get("response", response)
    if not isinstance(payload, dict):
        print("Tesla returned an unexpected region response.")
        return False
    region = payload.get("region", "unknown")
    regional_base = next(
        (
            value.rstrip("/")
            for value in payload.values()
            if isinstance(value, str) and "fleet-api" in value
        ),
        None,
    )
    if regional_base and regional_base != config.fleet_api_base:
        print(f"Tesla account region is {region}; it requires {regional_base}, not this server's API region.")
        return False
    print(f"Tesla account region verified: {region}.")
    return True


def verify_vehicle_access(config: Config) -> bool:
    """Perform a read-only vehicle-list call to verify user grant and scope."""
    store = StateStore(config.database_path, load_cipher(config.token_key_file))
    tokens = refresh_user_tokens(config, store)
    response = request_tesla_json(
        f"{config.fleet_api_base}/api/1/vehicles",
        bearer=tokens["access_token"],
    )
    payload = response.get("response", response)
    if isinstance(payload, list):
        count = len(payload)
    elif isinstance(payload, dict):
        vehicles = payload.get("vehicles", payload.get("results", []))
        count = len(vehicles) if isinstance(vehicles, list) else 0
    else:
        print("Tesla returned an unexpected vehicle-list response.")
        return False
    print(f"Tesla user authorization verified: {count} vehicle(s) visible to this application.")
    return count > 0


class DriveTalkApplication:
    def __init__(self, config: Config) -> None:
        self.config = config
        self.store = StateStore(config.database_path, load_cipher(config.token_key_file))
        self.token_lock = threading.RLock()
        self.cached_access_token: str | None = None
        self.access_token_until = 0.0
        self.dashboard = VehicleDashboard(config.fleet_api_base, self.user_access_token, request_tesla_json, os.getenv("TESLA_VEHICLE_VIN", "").strip())
        self.commands = VehicleCommands.from_environment(self.dashboard)
        self.sessions = MobileSessions(config.database_path.parent / 'mobile-sessions.sqlite3', lambda: read_secret(config.mobile_token_file))
        from grok_control import GrokControl
        self.grok = GrokControl(self.store, self.dashboard, self.commands)
        self.deepseek = GrokControl(self.store, self.dashboard, self.commands, provider='deepseek')
        from fish_voice import FishVoiceSettings
        self.voice = FishVoiceSettings(self.store)
        from aliyun_asr import AliAsrSettings
        self.asr = AliAsrSettings(self.store)
        from smarthome.account_ui import AccountUI
        self.smarthome = AccountUI(os.getenv('SMARTHOME_CREDENTIAL_DIR'))
        from smarthome.control_runtime import HomeControl
        self.home_control = HomeControl(self.smarthome, enabled=os.getenv('SMARTHOME_CONTROL_ENABLED') == '1')
        self.deepseek.home = self.home_control

    def user_access_token(self) -> str:
        with self.token_lock:
            if self.cached_access_token and time.monotonic() < self.access_token_until:
                return self.cached_access_token
            tokens = refresh_user_tokens(self.config, self.store)
            self.cached_access_token = tokens["access_token"]
            self.access_token_until = time.monotonic() + max(0, int(tokens.get("expires_in", 300)) - 60)
            return self.cached_access_token

    def authorization_url(self) -> str:
        state = self.store.create_oauth_state()
        query = urlencode(
            {
                "response_type": "code",
                "client_id": self.config.client_id,
                "redirect_uri": self.config.redirect_uri,
                "scope": self.config.scopes,
                "state": state,
                "nonce": secrets.token_urlsafe(24),
                "audience": self.config.fleet_api_base,
                "prompt_missing_scopes": "true",
                "require_requested_scopes": "true",
            }
        )
        return f"{self.config.auth_base}/authorize?{query}"

    def exchange_code(self, code: str, state: str) -> None:
        if not self.store.consume_oauth_state(state):
            raise TeslaRequestError(400, "The authorization session expired; start again")
        response = request_tesla_json(
            f"{self.config.auth_base}/token",
            {
                "grant_type": "authorization_code",
                "client_id": self.config.client_id,
                "client_secret": self.config.client_secret,
                "code": code,
                "audience": self.config.fleet_api_base,
                "redirect_uri": self.config.redirect_uri,
            },
        )
        if not isinstance(response.get("access_token"), str) or not isinstance(response.get("refresh_token"), str):
            raise TeslaRequestError(502, "Tesla did not provide the expected authorization tokens")
        self.store.save_protected_json("tesla_user_tokens", response)
        with self.token_lock:
            self.cached_access_token = None
            self.access_token_until = 0.0
        self.dashboard.invalidate()

    def mobile_token_is_valid(self, supplied_token: str | None) -> bool:
        if not supplied_token:
            return False
        return hmac.compare_digest(supplied_token, read_secret(self.config.mobile_token_file))

    def health_payload(self) -> dict[str, Any]:
        return {
            "ok": True,
            "teslaAuthorized": self.store.has_protected_value("tesla_user_tokens"),
            "telemetry": "not_configured",
        }

    @staticmethod
    def empty_alert_payload() -> dict[str, Any]:
        # Deliberately does not fabricate route or camera information before
        # the mTLS Fleet Telemetry receiver is configured.
        return {
            "vehicle": {"name": "Tesla"},
            "route": {
                "label": "等待车机导航同步",
                "destination": "未检测到车机导航",
                "remainingDistance": "—",
            },
            "current": {"roadName": "—", "speedKph": 0},
            "alerts": [],
        }


class DriveTalkHandler(BaseHTTPRequestHandler):
    server: "DriveTalkHttpServer"

    def log_message(self, format: str, *args: object) -> None:
        # Never log OAuth query strings; authorization codes must not enter logs.
        LOG.info("%s %s", self.command, urlparse(self.path).path)

    def send_json(self, status: HTTPStatus | int, payload: dict[str, Any], retry_after: int = 0, cookie: str | None = None) -> None:
        encoded = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(encoded)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        if cookie is not None:
            self.send_header('Set-Cookie', cookie)
        if retry_after:
            self.send_header("Retry-After", str(retry_after))
        self.end_headers()
        self.wfile.write(encoded)

    def send_page(self, status: HTTPStatus, title: str, message: str) -> None:
        body = (
            "<!doctype html><html lang='zh-CN'><meta charset='utf-8'>"
            "<meta name='viewport' content='width=device-width,initial-scale=1'>"
            f"<title>{html.escape(title)}</title>"
            "<body style='font-family:system-ui;margin:10vh auto;max-width:34rem;padding:0 1.5rem'>"
            f"<h1>{html.escape(title)}</h1><p>{html.escape(message)}</p></body></html>"
        ).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(body)

    def send_protected_model(self) -> None:
        """Stream the owner-supplied GLB only after the normal owner check."""
        app = self.server.application
        if not self.owner_authorized():
            self.send_json(HTTPStatus.UNAUTHORIZED, {"message": "手机未授权"})
            return
        model = getattr(app.config, "model_file", None)
        if not isinstance(model, Path) or model.suffix.lower() != ".glb" or not model.is_file():
            self.send_json(HTTPStatus.NOT_FOUND, {"message": "3D 车辆模型尚未部署"})
            return
        try:
            size = model.stat().st_size
            if not 0 < size <= 100 * 1024 * 1024:
                raise OSError("invalid model size")
            with model.open("rb") as stream:
                self.send_response(HTTPStatus.OK)
                self.send_header("Content-Type", "model/gltf-binary")
                self.send_header("Content-Length", str(size))
                self.send_header("Cache-Control", "private, no-store")
                self.send_header("X-Content-Type-Options", "nosniff")
                self.end_headers()
                while chunk := stream.read(64 * 1024):
                    self.wfile.write(chunk)
        except OSError:
            self.send_json(HTTPStatus.SERVICE_UNAVAILABLE, {"message": "3D 车辆模型暂不可用"})

    def owner_authorized(self) -> bool:
        app = self.server.application
        cookie = self.headers.get('Cookie')
        return app.mobile_token_is_valid(self.headers.get('X-DriveTalk-Token')) or bool(cookie and app.sessions.valid(cookie))

    def session_request(self, path: str) -> None:
        app = self.server.application
        if self.headers.get('Origin') != f'https://{app.config.domain}' or self.headers.get('Content-Type', '').split(';')[0] != 'application/json':
            self.send_json(403, {'message': '登录请求来源无效'})
            return
        try:
            length = int(self.headers.get('Content-Length', '0'))
            if not 1 <= length <= 64 or self.headers.get('Transfer-Encoding') or json.loads(self.rfile.read(length)) != {}:
                raise ValueError()
        except (ValueError, UnicodeDecodeError):
            self.send_json(400, {'message': '登录请求格式无效'})
            return
        if path.endswith('/logout'):
            app.sessions.revoke(self.headers.get('Cookie'))
            self.send_json(200, {'authenticated': False}, cookie=session_cookie())
            return
        if not app.sessions.allow_login():
            self.send_json(429, {'message': '登录尝试过多，请稍后再试'}, 300)
            return
        if not app.mobile_token_is_valid(self.headers.get('X-DriveTalk-Token')):
            self.send_json(401, {'message': '手机访问令牌无效'})
            return
        app.sessions.revoke(self.headers.get('Cookie'))
        value = app.sessions.create()
        self.send_json(200, {'authenticated': True, 'expiresIn': SESSION_TTL}, cookie=session_cookie(value, SESSION_TTL))

    def grok_request(self, path: str, *, post: bool = False) -> None:
        """Same-origin owner API; no public key setup page or provider credential echo."""
        app = self.server.application
        if not self.owner_authorized():
            self.send_json(401, {'message': '请先登录 DriveTalk'})
            return
        deepseek = path.startswith('/v1/vehicle/ai/deepseek/')
        voice = path == '/v1/vehicle/ai/voice/config'
        asr = path == '/v1/vehicle/ai/asr/config'
        assistant = app.asr if asr else app.voice if voice else app.deepseek if deepseek else app.grok
        if not post:
            config = assistant.config()
            if not deepseek and not voice and not asr: config['enabled'] = False  # Grok paused; keep its encrypted key untouched.
            self.send_json(200, config)
            return
        if self.headers.get('Origin') != f'https://{app.config.domain}' or self.headers.get('Content-Type', '').split(';')[0] != 'application/json':
            self.send_json(403, {'message': 'AI 请求来源无效'})
            return
        try:
            length = int(self.headers.get('Content-Length', '0'))
            if not 1 <= length <= 12000 or self.headers.get('Transfer-Encoding'):
                raise ValueError()
            payload = json.loads(self.rfile.read(length))
        except (ValueError, UnicodeDecodeError):
            self.send_json(400, {'message': 'AI 请求格式无效'})
            return
        started = False

        def emit(event, value):
            nonlocal started
            if not started:
                self.send_response(200)
                for name, val in [('Content-Type', 'text/event-stream; charset=utf-8'),
                                  ('Cache-Control', 'no-store'), ('X-Accel-Buffering', 'no'),
                                  ('X-Content-Type-Options', 'nosniff'), ('Connection', 'close')]:
                    self.send_header(name, val)
                self.end_headers()
                self.close_connection = True
                started = True
            frame = f'event: {event}\ndata: {json.dumps(value, ensure_ascii=False, allow_nan=False)}\n\n'
            self.wfile.write(frame.encode('utf-8'))
            self.wfile.flush()

        try:
            if path.endswith('/config'):
                if not deepseek and not voice and not asr and isinstance(payload, dict) and payload.get('enabled') is True:
                    raise DashboardError(503, 'Grok 已暂时搁置，请使用 DeepSeek')
                self.send_json(200, assistant.save(payload))
            else:
                if not deepseek:
                    raise DashboardError(503, 'Grok 已暂时搁置，请使用 DeepSeek；未发送车辆指令')
                assistant.chat(payload, emit)
        except (BrokenPipeError, ConnectionResetError):
            # Do not replay anything after the phone disconnects. Request reservation
            # is persisted before dispatch, so even process restart cannot replay it.
            self.close_connection = True
        except Exception as error:
            status = error.status if isinstance(error, DashboardError) else 503
            message = str(error) if isinstance(error, DashboardError) else 'AI 结果未确认，请检查车辆，勿重复发送'
            retry_after = error.retry_after if isinstance(error, DashboardError) else 0
            if not started:
                self.send_json(status, {'message': message}, retry_after)
            else:
                try:
                    emit('error', {'message': message, 'status': status, 'retryAfter': retry_after})
                    emit('done', {})
                except (BrokenPipeError, ConnectionResetError, OSError):
                    self.close_connection = True

    def smarthome_request(self, path: str, *, post: bool = False) -> None:
        app = self.server.application
        if not self.owner_authorized():
            self.send_json(401, {'message': '请先登录 DriveTalk'})
            return
        if not post:
            try:
                self.send_json(200, app.smarthome.status())
            except Exception:
                self.send_json(503, {'message': '米家状态暂不可用'})
            return
        if self.headers.get('Origin') != f'https://{app.config.domain}' or self.headers.get('Content-Type', '').split(';')[0] != 'application/json':
            self.send_json(403, {'message': '米家请求来源无效'})
            return
        try:
            length = int(self.headers.get('Content-Length', '0'))
            if not 1 <= length <= 80000 or self.headers.get('Transfer-Encoding'):
                raise ValueError()
            payload = json.loads(self.rfile.read(length))
            if path.endswith('/select'):
                if (not isinstance(payload, dict) or 'deviceIds' not in payload
                        or set(payload) - {'deviceIds', 'enableControl'}):
                    raise ValueError()
                if 'enableControl' in payload:
                    result = app.smarthome.select(payload['deviceIds'], enable_control=payload['enableControl'])
                else:
                    result = app.smarthome.select(payload['deviceIds'])
            else:
                if payload != {}:
                    raise ValueError()
                result = app.smarthome.cancel() if path.endswith('/cancel') else app.smarthome.start(path.rsplit('/', 1)[1])
            self.send_json(200, result)
        except Exception:
            self.send_json(409, {'message': '米家任务未启动或保存未确认，请读取状态后再操作；未自动重试'})

    def do_GET(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        app = self.server.application
        if parsed.path == '/v1/smarthome/status':
            self.smarthome_request(parsed.path)
            return
        if parsed.path in ('/v1/vehicle/ai/config', '/v1/vehicle/ai/deepseek/config', '/v1/vehicle/ai/voice/config', '/v1/vehicle/ai/asr/config'):
            self.grok_request(parsed.path)
            return
        if parsed.path == '/v1/vehicle/session':
            valid = app.sessions.valid(self.headers.get('Cookie'))
            self.send_json(200 if valid else 401, {'authenticated': valid})
            return
        if parsed.path == "/v1/vehicle/capabilities":
            if not self.owner_authorized():
                self.send_json(401, {"message": "手机未授权"})
                return
            self.send_json(200, app.commands.capabilities())
            return
        if parsed.path == "/v1/vehicle/model":
            self.send_protected_model()
            return
        if parsed.path in ("/v1/vehicle/status", "/v1/vehicle/data"):
            self.dashboard_request(parsed.path)
            return
        if parsed.path == "/healthz":
            self.send_json(HTTPStatus.OK, app.health_payload())
            return
        if parsed.path == "/auth/tesla/start":
            self.send_response(HTTPStatus.SEE_OTHER)
            self.send_header("Location", app.authorization_url())
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            return
        if parsed.path == "/auth/tesla/callback":
            query = parse_qs(parsed.query)
            error = query.get("error", [None])[0]
            code = query.get("code", [None])[0]
            state = query.get("state", [None])[0]
            if error or not isinstance(code, str) or not isinstance(state, str):
                self.send_page(HTTPStatus.BAD_REQUEST, "Tesla 授权未完成", "没有收到有效的授权结果；请返回后重新开始。")
                return
            try:
                app.exchange_code(code, state)
            except TeslaRequestError as request_error:
                self.send_page(HTTPStatus.BAD_GATEWAY, "Tesla 授权未完成", str(request_error))
                return
            self.send_page(HTTPStatus.OK, "Tesla 已连接", "授权信息已经安全保存在服务器。可以关闭此页面，继续下一步的车辆虚拟密钥与 Telemetry 配置。")
            return
        if parsed.path == "/v1/navigation/active-alerts":
            if not self.owner_authorized():
                self.send_json(HTTPStatus.UNAUTHORIZED, {"message": "手机未授权"})
                return
            self.send_json(HTTPStatus.OK, app.empty_alert_payload())
            return
        self.send_json(HTTPStatus.NOT_FOUND, {"message": "未找到接口"})

    def dashboard_request(self, path: str, *, wake: bool = False) -> None:
        app = self.server.application
        if not self.owner_authorized():
            self.send_json(HTTPStatus.UNAUTHORIZED, {"message": "仪表盘未授权"})
            return
        if wake:
            expected = f"https://{app.config.domain}"
            if self.headers.get("Origin") != expected or self.headers.get("Content-Type", "").split(";")[0] != "application/json":
                self.send_json(HTTPStatus.FORBIDDEN, {"message": "唤醒请求来源无效"})
                return
            try:
                length = int(self.headers.get("Content-Length", "0"))
                if length < 0 or length > 1024:
                    raise ValueError()
                body = self.rfile.read(length)
                if body and json.loads(body) != {}:
                    raise ValueError()
            except (ValueError, json.JSONDecodeError):
                self.send_json(HTTPStatus.BAD_REQUEST, {"message": "唤醒参数无效"})
                return
        try:
            payload = app.dashboard.wake() if wake else app.dashboard.status() if path.endswith("/status") else app.dashboard.data()
            self.send_json(HTTPStatus.OK, payload)
        except DashboardError as error:
            self.send_json(error.status, {"message": str(error)}, error.retry_after)
        except ConfigurationError:
            self.send_json(HTTPStatus.SERVICE_UNAVAILABLE, {"message": "车辆服务配置未就绪"})

    def do_POST(self) -> None:  # noqa: N802
        path = urlparse(self.path).path
        if path in ('/v1/smarthome/login', '/v1/smarthome/sync', '/v1/smarthome/cancel', '/v1/smarthome/select'):
            self.smarthome_request(path, post=True)
        elif path in ('/v1/vehicle/session/login', '/v1/vehicle/session/logout'):
            self.session_request(path)
        elif path in ('/v1/vehicle/ai/config', '/v1/vehicle/ai/chat', '/v1/vehicle/ai/deepseek/config', '/v1/vehicle/ai/deepseek/chat', '/v1/vehicle/ai/voice/config', '/v1/vehicle/ai/asr/config'):
            self.grok_request(path, post=True)
        elif path == "/v1/vehicle/command":
            app = self.server.application
            if not self.owner_authorized():
                self.send_json(401, {'message': '手机未授权'})
                return
            if self.headers.get('Origin') != f'https://{app.config.domain}' or self.headers.get('Content-Type', '').split(';')[0] != 'application/json':
                self.send_json(403, {'message': '命令请求来源无效'})
                return
            try:
                length = int(self.headers.get('Content-Length', '0'))
                if not 1 <= length <= 2048 or self.headers.get('Transfer-Encoding'):
                    raise ValueError()
                payload = json.loads(self.rfile.read(length))
            except (ValueError, UnicodeDecodeError):
                self.send_json(400, {'message': '命令请求格式无效'})
                return
            try:
                self.send_json(200, app.commands.execute(payload))
            except DashboardError as error:
                self.send_json(error.status, {'message': str(error), 'commandSent': getattr(error, 'command_sent', False)}, error.retry_after)
            except Exception:
                # Never expose OAuth, private key paths, proxy URLs or raw upstream data.
                self.send_json(503, {'message': '命令结果未确认，勿重复发送'})
        elif urlparse(self.path).path == "/v1/vehicle/wake":
            self.dashboard_request("/v1/vehicle/wake", wake=True)
        else:
            self.send_json(HTTPStatus.NOT_FOUND, {"message": "未找到接口"})


class DriveTalkHttpServer(ThreadingHTTPServer):
    def __init__(self, address: tuple[str, int], application: DriveTalkApplication) -> None:
        self.application = application
        super().__init__(address, DriveTalkHandler)


def create_secret_file(path: Path, contents: bytes) -> None:
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    if path.exists():
        raise ConfigurationError(f"Refusing to overwrite existing secret: {path}")
    previous_umask = os.umask(0o077)
    try:
        path.write_bytes(contents)
    finally:
        os.umask(previous_umask)
    path.chmod(0o600)


def main() -> int:
    parser = argparse.ArgumentParser(description="DriveTalk private backend")
    parser.add_argument(
        "command",
        choices=(
            "serve",
            "init-secrets",
            "register",
            "verify-registration",
            "verify-user-region",
            "verify-vehicle-access",
        ),
        nargs="?",
        default="serve",
    )
    args = parser.parse_args()
    try:
        config = Config.from_environment()
        if args.command == "init-secrets":
            create_secret_file(config.token_key_file, Fernet.generate_key() + b"\n")
            create_secret_file(config.mobile_token_file, base64.urlsafe_b64encode(secrets.token_bytes(32)) + b"\n")
            print("Created token-encryption.key and mobile-api-token. Keep both server-only.")
            return 0
        if args.command == "register":
            register_partner_account(config)
            print("Tesla partner registration request completed.")
            return 0
        if args.command == "verify-registration":
            return 0 if verify_partner_registration(config) else 1
        if args.command == "verify-user-region":
            return 0 if verify_user_region(config) else 1
        if args.command == "verify-vehicle-access":
            return 0 if verify_vehicle_access(config) else 1
        application = DriveTalkApplication(config)
    except TeslaRequestError as error:
        LOG.error("Tesla request failed: %s", error)
        return 2
    except (ConfigurationError, ValueError) as error:
        LOG.error("Configuration error: %s", error)
        return 2

    httpd = DriveTalkHttpServer((config.bind_host, config.bind_port), application)
    LOG.info("DriveTalk backend listening on %s:%s", config.bind_host, config.bind_port)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        return 0
    finally:
        httpd.server_close()


if __name__ == "__main__":
    logging.basicConfig(level=os.getenv("LOG_LEVEL", "INFO"), format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    sys.exit(main())

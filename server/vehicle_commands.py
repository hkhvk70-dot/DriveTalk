"""Owner gateway to a loopback Tesla HTTP signing proxy. Disabled by default."""
from __future__ import annotations

import json
import math
import os
import re
import ssl
import threading
import time
from email.utils import parsedate_to_datetime
from urllib.error import HTTPError, URLError
from urllib.parse import urlparse, urlencode
from urllib.request import Request, HTTPSHandler, HTTPRedirectHandler, ProxyHandler, build_opener

from vehicle_dashboard import DashboardError


def retry_after_seconds(headers):
    """Respect upstream backoff rather than reducing a long limit to 60s."""
    try:
        raw = headers.get('Retry-After', '60')
        return max(1, int(raw) if raw.isdigit() else int(parsedate_to_datetime(raw).timestamp() - time.time()))
    except (ValueError, TypeError, AttributeError):
        return 60


def map_command(command):
    if not isinstance(command, dict):
        raise DashboardError(400, '命令参数无效')
    name = command.get('name')
    schemas = {'lock': {'locked'}, 'climate': {'enabled'}, 'temperature': {'celsius'},
               'trunk': {'trunk'}, 'rearTrunk': {'open'}, 'vent': set(), 'closeWindows': set(), 'horn': set(), 'lights': set(), 'findCar': set(),
               'charging': {'enabled'}, 'chargeLimit': {'percent'}, 'chargePort': {'open'}, 'navigation': {'destination'}}
    if not isinstance(name, str) or name not in schemas or set(command) != schemas[name] | {'name'}:
        raise DashboardError(400, '命令不在允许列表内或参数无效')
    bool_fields = {'lock': 'locked', 'climate': 'enabled', 'charging': 'enabled', 'chargePort': 'open', 'rearTrunk': 'open'}
    if name in bool_fields and type(command[bool_fields[name]]) is not bool:
        raise DashboardError(400, '开关参数必须是布尔值')
    if name == 'lock': return ('door_lock' if command['locked'] else 'door_unlock', {})
    if name == 'climate': return ('auto_conditioning_start' if command['enabled'] else 'auto_conditioning_stop', {})
    if name == 'charging': return ('charge_start' if command['enabled'] else 'charge_stop', {})
    if name == 'chargePort': return ('charge_port_door_open' if command['open'] else 'charge_port_door_close', {})
    if name == 'rearTrunk': return ('actuate_trunk', {'which_trunk': 'rear'}) if command['open'] else ('drivetalk_close_trunk', {})
    if name == 'navigation':
        destination = command['destination']
        if not isinstance(destination, str) or not destination.strip() or len(destination) > 300 or re.search(r'[\x00-\x1f\x7f]|\w+://', destination):
            raise DashboardError(400, '请输入有效地址或地点名称，最多 300 字符；不支持链接或控制字符')
        return 'navigation_request', {'type': 'share_ext_content_raw', 'value': {'android.intent.extra.TEXT': destination.strip()}, 'locale': 'zh-CN', 'timestamp_ms': int(time.time() * 1000)}
    if name == 'temperature':
        value = command['celsius']
        if type(value) not in (int, float) or not math.isfinite(value) or not 15 <= value <= 28:
            raise DashboardError(400, '温度范围为 15–28°C')
        return 'set_temps', {'driver_temp': value, 'passenger_temp': value}
    if name == 'chargeLimit':
        value = command['percent']
        if type(value) is not int or not 50 <= value <= 100:
            raise DashboardError(400, '充电限值范围为 50%–100%')
        return 'set_charge_limit', {'percent': value}
    if name == 'trunk':
        if command['trunk'] not in ('front', 'rear'):
            raise DashboardError(400, '备箱参数无效')
        return 'actuate_trunk', {'which_trunk': command['trunk']}
    return {'findCar': ('find_car', {}), 'vent': ('window_control', {'command': 'vent'}), 'closeWindows': ('window_control', {'command': 'close'}),
            'horn': ('honk_horn', {}), 'lights': ('flash_lights', {})}[name]


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        # Never forward an OAuth Authorization header to a redirected host.
        raise DashboardError(502, '签名代理不允许重定向')


def navigation_rest_transport(base):
    # Tesla's official proxy marks navigation_request as REST-only, not signed.
    # Keep this exception server-side and restricted to the regional Tesla host.
    parsed = urlparse(base)
    hosts = ('fleet-api.prd.cn.vn.cloud.tesla.cn', 'fleet-api.prd.na.vn.cloud.tesla.com', 'fleet-api.prd.eu.vn.cloud.tesla.com')
    if parsed.scheme != 'https' or parsed.hostname not in hosts or parsed.port not in (None, 443) or parsed.username or parsed.password or parsed.query or parsed.fragment or parsed.path not in ('', '/'):
        raise ValueError('Navigation requires an official regional Tesla HTTPS host')
    opener = build_opener(ProxyHandler({}), HTTPSHandler(), NoRedirect())
    def send(path, body, bearer):
        if not re.fullmatch(r'/api/1/vehicles/[A-HJ-NPR-Z0-9]{17}/command/navigation_request', path):
            raise DashboardError(400, '导航接口无效')
        req = Request(base.rstrip('/') + path, data=json.dumps(body, allow_nan=False).encode(), method='POST',
                      headers={'Authorization': 'Bearer ' + bearer, 'Content-Type': 'application/json'})
        try:
            with opener.open(req, timeout=15) as response:
                raw = response.read(65537)
                if len(raw) > 65536: raise DashboardError(502, '导航响应过大')
                return json.loads(raw)
        except HTTPError as error:
            status = error.code if error.code in (400, 401, 403, 409, 429, 503, 504) else 502
            raise DashboardError(status, 'Tesla 未确认目的地发送；未自动重试', retry_after_seconds(error.headers) if status == 429 else 0) from error
        except (URLError, TimeoutError, ValueError) as error:
            raise DashboardError(502, '目的地发送结果未确认，请检查车机；勿重复发送') from error
    return send


def proxy_transport(base, ca_file):
    parsed = urlparse(base)
    if (parsed.scheme != 'https' or parsed.hostname not in ('localhost', '127.0.0.1', '::1')
            or parsed.username or parsed.password or parsed.query or parsed.fragment or parsed.path not in ('', '/')):
        raise ValueError('Signing proxy must be loopback HTTPS without a path')
    if not ca_file:
        raise ValueError('Signing proxy CA certificate is required')
    context = ssl.create_default_context(cafile=ca_file)
    opener = build_opener(ProxyHandler({}), HTTPSHandler(context=context), NoRedirect())

    def send(path, body, bearer):
        req = Request(base.rstrip('/') + path, data=json.dumps(body, allow_nan=False).encode(), method='POST',
                      headers={'Authorization': 'Bearer ' + bearer, 'Content-Type': 'application/json'})
        try:
            with opener.open(req, timeout=15) as response:
                raw = response.read(65537)
                if len(raw) > 65536: raise DashboardError(502, '签名代理响应过大')
                return json.loads(raw)
        except HTTPError as error:
            status = error.code if error.code in (401, 403, 409, 429, 503, 504) else 502
            raise DashboardError(status, '签名代理未确认命令；未自动重试', retry_after_seconds(error.headers) if status == 429 else 0) from error
        except (URLError, TimeoutError, ValueError) as error:
            raise DashboardError(502, '签名代理响应未确认；结果可能未知，勿重复发送') from error
    return send


class VehicleCommands:
    def __init__(self, dashboard, transport=None, clock=time.monotonic, navigation_transport=None, rear_close_enabled=False):
        self.dashboard = dashboard
        self.transport = transport
        self.navigation_transport = navigation_transport
        self.rear_close_enabled = rear_close_enabled
        self.clock = clock
        self.lock = threading.Lock()
        self.seen = {}
        self.next_at = 0.0

    @classmethod
    def from_environment(cls, dashboard):
        transport = None
        if os.getenv('DRIVETALK_COMMANDS_ENABLED') == 'true':
            transport = proxy_transport(os.getenv('DRIVETALK_SIGNING_PROXY_URL', ''),
                                        os.getenv('DRIVETALK_SIGNING_PROXY_CA_FILE', ''))
        return cls(dashboard, transport, navigation_transport=navigation_rest_transport(dashboard.base) if transport else None,
                   rear_close_enabled=os.getenv('DRIVETALK_TRUNK_CLOSE_ENABLED') == 'true')

    def capabilities(self):
        return {'commands': self.transport is not None, 'navigation': self.transport is not None and self.navigation_transport is not None,
                'rearTrunkClose': self.transport is not None and self.rear_close_enabled}

    def execute(self, payload):
        if self.transport is None:
            raise DashboardError(503, '控车签名代理未启用')
        if not isinstance(payload, dict) or set(payload) != {'command', 'requestId'}:
            raise DashboardError(400, '命令请求格式无效')
        request_id = payload['requestId']
        if not isinstance(request_id, str) or not re.fullmatch(r'[a-fA-F0-9-]{36}', request_id):
            raise DashboardError(400, '请求标识无效')
        request_id = request_id.lower()
        endpoint, body = map_command(payload['command'])
        if endpoint == 'navigation_request' and self.navigation_transport is None:
            raise DashboardError(503, '导航发送未启用')
        if endpoint == 'drivetalk_close_trunk' and not self.rear_close_enabled:
            raise DashboardError(503, '明确关闭后备箱的签名指令尚未启用')
        if not self.lock.acquire(blocking=False):
            raise DashboardError(409, '另一控车请求尚未完成')
        dispatched = False
        try:
            now = self.clock()
            self.seen = {key: expiry for key, expiry in self.seen.items() if expiry > now}
            if request_id in self.seen:
                raise DashboardError(409, '此请求已处理或结果未确认，禁止重复发送')
            if now < self.next_at:
                raise DashboardError(429, '控车冷却尚未结束', int(self.next_at - now) + 1)
            self.seen[request_id] = now + 300
            self.next_at = now + 10
            # Server chooses the owned vehicle; browser cannot supply a VIN or URL.
            with self.dashboard.lock:
                self.dashboard.status_until = 0.0
                if self.dashboard.status()['response']['state'] != 'online':
                    raise DashboardError(409, '车辆未上线，请显式唤醒后再操作')
                target = self.dashboard._target()
                if not re.fullmatch(r'[A-HJ-NPR-Z0-9]{17}', target):
                    raise DashboardError(409, '签名代理要求有效 VIN，拒绝使用数字车辆 ID')
                query = urlencode({'endpoints': 'drive_state;vehicle_state;charge_state'})
                fresh = self.dashboard._call(f'/{target}/vehicle_data?{query}').get('response')
                command = payload['command']
                if not isinstance(fresh, dict):
                    raise DashboardError(409, '最新车辆快照无效，拒绝控车')
                if command['name'] in ('trunk', 'rearTrunk', 'chargePort'):
                    drive = fresh.get('drive_state')
                    if not isinstance(drive, dict) or drive.get('shift_state') != 'P':
                        raise DashboardError(409, '备箱和充电口盖操作需从最新快照确认 P 档')
                if (command['name'] == 'rearTrunk' and command['open']) or (command['name'] == 'trunk' and command['trunk'] == 'rear'):
                    # Upstream OpenTrunk sends MOVE, so never send it on an open
                    # or unknown trunk: doing so could close instead of open.
                    state = fresh.get('vehicle_state', {}).get('rt') if isinstance(fresh.get('vehicle_state'), dict) else None
                    if type(state) not in (int, float) or not math.isfinite(state) or state < 0:
                        raise DashboardError(409, '未确认后备箱状态，请刷新后再打开')
                    if state > 0:
                        return {'accepted': True, 'alreadyInState': True}
                if payload['command']['name'] == 'chargePort' and not payload['command']['open']:
                    charge = fresh.get('charge_state')
                    if not isinstance(charge, dict) or charge.get('conn_charge_cable') not in ('<invalid>', ''):
                        raise DashboardError(409, '未确认充电线已拔除，拒绝关闭充电口')
                if command['name'] == 'charging' and command['enabled']:
                    charge = fresh.get('charge_state')
                    if not isinstance(charge, dict) or not charge.get('conn_charge_cable') or charge['conn_charge_cable'] == '<invalid>':
                        raise DashboardError(409, '未确认充电线已连接，拒绝开始充电')
                try:
                    endpoints = ['honk_horn', 'flash_lights'] if endpoint == 'find_car' else [endpoint]
                    for index, item in enumerate(endpoints):
                        try:
                            sender = self.navigation_transport if item == 'navigation_request' else self.transport
                            dispatched = True
                            result = sender(f'/api/1/vehicles/{target}/command/{item}', body, self.dashboard.token_supplier())
                            response = result.get('response') if isinstance(result, dict) else None
                            if not isinstance(response, dict) or response.get('result') is not True:
                                raise DashboardError(502, '车辆未确认命令成功；请检查车辆，勿重复操作')
                        except Exception as error:
                            if endpoint == 'find_car':
                                message = '鸣笛未确认，未发送闪灯' if index == 0 else '鸣笛已受理，闪灯未确认'
                                raise DashboardError(502, message + '；未自动重试') from error
                            raise
                    return {'accepted': True}
                finally:
                    # Invalidate even if proxy response is ambiguous. Never replay.
                    self.dashboard.data_until = self.dashboard.status_until = 0.0
                    self.dashboard.next_data_at = 0.0
                    if hasattr(self.dashboard, 'begin_command_sync'):
                        self.dashboard.begin_command_sync()
        except DashboardError as error:
            if error.status == 429:
                self.next_at = max(self.next_at, self.clock() + max(1, error.retry_after))
            error.command_sent = dispatched
            raise
        finally:
            self.lock.release()

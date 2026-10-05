"""Real SDK binding, dependency-injected for tests; never guesses MIoT IDs."""
import logging
import math
import time
import uuid

from .contracts import KINDS, validate
from .credential_store import validate_auth


def secure_api(store, *, login=False, sdk_class=None):
    if sdk_class is None:
        from mijiaAPI import mijiaAPI
        sdk_class = mijiaAPI
    if not all(callable(getattr(sdk_class, name, None)) for name in ('_init_session', '_save_auth_data', 'get_devices_prop', 'set_devices_prop')):
        raise RuntimeError('SDK 接口不兼容，停止使用')
    logging.getLogger('mijiaAPI').disabled = True

    class EncryptedAPI(sdk_class):
        def __init__(self):
            # The SDK constructor expects a JSON path. Give it a nonexistent
            # sentinel; persistence below is overridden to encrypt directly.
            sentinel = store.directory / ('.memory-only-' + uuid.uuid4().hex)
            if sentinel.exists():
                raise RuntimeError('内存凭证初始化冲突')
            super().__init__(auth_data_path=str(sentinel))
            if store.auth.exists():
                self.auth_data = store.load()
                self._init_session()
            elif not login:
                raise RuntimeError('尚未扫码登录')

        def _save_auth_data(self):
            self.auth_data['saveTime'] = int(time.time() * 1000)
            store.save(validate_auth(self.auth_data))

        def _init_session(self):
            old = getattr(self, 'session', None)
            if old is not None:
                old.close()
            super()._init_session()
            original = self.session.request

            def timed_request(*args, **kwargs):
                kwargs.setdefault('timeout', (5, 15))
                return original(*args, **kwargs)
            self.session.request = timed_request

    return EncryptedAPI()


def binding(prop):
    if not isinstance(prop, dict) or any(type(prop.get(key)) is not int or prop[key] <= 0 for key in ('siid', 'piid')):
        raise ValueError('缺少真实 MIoT 属性编号')
    return prop


def numeric_range(prop):
    values = tuple(prop.get(key) for key in ('min', 'max', 'step'))
    if any(type(v) not in (int, float) or not math.isfinite(v) for v in values):
        raise ValueError('缺少型号数值范围')
    low, high, step = values
    if high <= low or step <= 0:
        raise ValueError('型号数值范围错误')
    return low, high, step


def encode(name, value, prop):
    binding(prop)
    if name == 'on':
        if type(value) is not bool:
            raise ValueError('仅支持 MIoT 布尔开关')
        return value
    if name in ('mode', 'fan_level'):
        return enum_values(prop)[value] if isinstance(value, str) and value in enum_values(prop) else _invalid_enum()
    low, high, step = numeric_range(prop)
    if name == 'brightness':
        raw = low + (value - 1) / 99 * (high - low)
    else:
        raw = value
        if not low <= raw <= high:
            raise ValueError('数值不在该型号范围内')
        if name == 'target_temperature' and not math.isclose((raw - low) / step, round((raw - low) / step), abs_tol=1e-7):
            raise ValueError('设定温度不符合该型号步长')
    ticks = math.floor((high - low) / step + 1e-9)
    tick = min(ticks, max(0, round((raw - low) / step)))
    result = low + tick * step
    return int(result) if float(result).is_integer() else result


def decode(name, value, prop):
    if name == 'on':
        return value if type(value) is bool else None
    if name in ('mode', 'fan_level'):
        return next((key for key, code in enum_values(prop).items() if type(value) is int and value == code), None)
    low, high, _ = numeric_range(prop)
    if type(value) not in (int, float) or not math.isfinite(value) or not low <= value <= high:
        return None
    return round(1 + (value - low) / (high - low) * 99) if name == 'brightness' else value


def _invalid_enum():
    raise ValueError('型号不支持该模式或风速')


def enum_values(prop):
    values = prop.get('values')
    if (not isinstance(values, dict) or not values or len(values) > 10 or
            any(not isinstance(k, str) or type(v) is not int for k, v in values.items()) or
            len(set(values.values())) != len(values)):
        raise ValueError('缺少明确的型号枚举映射')
    return values


class MijiaBackend:
    def __init__(self, config, api):
        self.config, self.api = config, api

    def device(self, alias, kind=None):
        item = self.config.get('devices', {}).get(alias)
        if self.config.get('enabled') is not True or not isinstance(item, dict) or item.get('enabled') is not True:
            raise ValueError('设备未启用')
        if kind is not None and item.get('kind') != kind:
            raise ValueError('设备类型不匹配')
        if item.get('kind') not in ('light', 'plug', 'climate'):
            raise ValueError('摄像头不走 MIoT 属性控制')
        if not isinstance(item.get('did'), str) or not item['did']:
            raise ValueError('缺少设备 DID')
        return item

    @staticmethod
    def rows(result, expected, *, accepted_codes=(0,)):
        rows = result if isinstance(result, list) else [result]
        if len(rows) != len(expected) or not all(isinstance(row, dict) for row in rows):
            raise ValueError('设备响应不完整')
        indexed = {(str(row.get('did')), row.get('siid'), row.get('piid')): row for row in rows}
        if len(indexed) != len(expected):
            raise ValueError('设备响应重复')
        ordered = []
        for item in expected:
            row = indexed.get((item['did'], item['siid'], item['piid']))
            if row is None or type(row.get('code')) is not int or row['code'] not in accepted_codes:
                raise ValueError('设备返回拒绝或未知结果')
            ordered.append(row)
        return ordered

    def write(self, name, args):
        validate(name, args)
        alias = args['device_id']
        device = self.device(alias, KINDS[name])
        desired = {key: value for key, value in args.items() if key != 'device_id'}
        requests = self.validate_desired(device, desired)
        # Validate every mapping before writing anything. Do not retry POST.
        # mijiaAPI 4.4 also accepts write code 1. This is only acceptance,
        # never proof that the device has reached the requested state.
        # Reads deliberately keep the stricter code-0-only default.
        self.rows(self.api.set_devices_prop(requests), requests, accepted_codes=(0, 1))
        return {'accepted': True, 'confirmed': False, 'device_id': alias}

    @staticmethod
    def validate_desired(device, desired):
        if desired.get('on') is False and len(desired) != 1:
            raise ValueError('关灯不能同时调亮度或色温')
        if not set(desired) <= set(device.get('capabilities', ['on'])):
            raise ValueError('型号能力不支持')
        requests = []
        for key, value in desired.items():
            prop = binding(device.get('properties', {}).get(key))
            requests.append({'did': device['did'], 'siid': prop['siid'], 'piid': prop['piid'], 'value': encode(key, value, prop)})
        if len({(item['siid'], item['piid']) for item in requests}) != len(requests):
            raise ValueError('属性映射重复')
        return requests

    def read(self, alias):
        device = self.device(alias)
        props = device.get('properties', {})
        names = [name for name in ('on', 'brightness', 'color_temperature', 'target_temperature', 'mode', 'fan_level') if name in props]
        if 'on' not in names:
            raise ValueError('缺少开关映射')
        requests = []
        for name in names:
            prop = binding(props[name])
            if name in ('mode', 'fan_level'):
                enum_values(prop)
            elif name != 'on':
                numeric_range(prop)
            requests.append({'did': device['did'], 'siid': prop['siid'], 'piid': prop['piid']})
        if len({(item['siid'], item['piid']) for item in requests}) != len(requests):
            raise ValueError('属性映射重复')
        rows = self.rows(self.api.get_devices_prop(requests), requests)
        state = {name: decode(name, row.get('value'), props[name]) for name, row in zip(names, rows)}
        # Missing/invalid on is unknown, never False.
        return {'device_id': alias, 'available': type(state['on']) is bool, **state}

    def close(self):
        session = getattr(self.api, 'session', None)
        if session is not None:
            session.close()

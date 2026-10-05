"""Server-owned config selection. Never silently falls back between providers."""
from contextlib import asynccontextmanager
import json
from pathlib import Path

from .providers import HomeAssistantProvider, SmartHomeProvider, open_mcp


class DisabledProvider(SmartHomeProvider):
    async def set_device_state(self, device_id, desired):
        return {'accepted': False, 'code': 'disabled'}
    async def get_device_state(self, device_id):
        return {'available': False, 'on': None}
    async def trigger_camera(self, device_id, operation, seconds=None):
        return {'ok': False, 'code': 'disabled'}


def load_config(path):
    data = json.loads(Path(path).read_text(encoding='utf-8'))
    if not isinstance(data, dict) or type(data.get('enabled')) is not bool:
        raise ValueError('家居配置 enabled 必须是布尔值')
    if data.get('provider') not in ('mijia', 'ha') or not isinstance(data.get('devices'), dict):
        raise ValueError('设备后端配置错误')
    names = []
    for alias, device in data['devices'].items():
        if not isinstance(device, dict) or device.get('kind') not in ('light', 'plug', 'camera', 'climate'):
            raise ValueError('设备类型无效')
        name = device.get('name')
        if not isinstance(name, str) or not name or len(name) > 80:
            raise ValueError('设备显示名称错误')
        if type(device.get('enabled')) is not bool:
            raise ValueError('设备 enabled 必须是布尔值')
        names.append(name)
    if len(names) != len(set(names)):
        raise ValueError('设备显示名称不能重复')
    return data


@asynccontextmanager
async def open_provider(config_path):
    config_path = Path(config_path).resolve(strict=True)
    settings = load_config(config_path)
    if not settings['enabled']:
        yield DisabledProvider()
    elif settings['provider'] == 'ha':
        # Honest skeleton, not a guessed REST implementation.
        yield HomeAssistantProvider()
    else:
        async with open_mcp(Path(__file__).with_name('mcp_server.py'),
                            config_path, settings['devices']) as provider:
            yield provider

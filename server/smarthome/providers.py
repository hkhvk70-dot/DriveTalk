"""Abstract provider and MCP adapter. Optional dependencies load only on connection."""
from abc import ABC, abstractmethod
from contextlib import asynccontextmanager
import json
import os
import sys

from .contracts import list_tools


class SmartHomeProvider(ABC):
    async def list_tools(self):
        return list_tools()

    @abstractmethod
    async def set_device_state(self, device_id, desired):
        """Write once. Do not retry. Return accepted, not a fabricated state."""

    @abstractmethod
    async def get_device_state(self, device_id):
        """Fresh normalized read: available, on, brightness, color_temperature."""

    @abstractmethod
    async def trigger_camera(self, device_id, operation, seconds=None):
        """Camera backend is separate; never accept a model-supplied URL."""


class MijiaMCPProvider(SmartHomeProvider):
    def __init__(self, session, devices):
        self.session, self.devices = session, devices

    async def _call(self, name, args):
        result = await self.session.call_tool(name, arguments=args)
        if result.isError:
            raise RuntimeError('MCP 工具执行失败')
        data = result.structuredContent
        if data is None:
            texts = [item.text for item in result.content if getattr(item, 'type', '') == 'text']
            if len(texts) != 1 or len(texts[0]) > 65536:
                raise RuntimeError('MCP 返回格式错误')
            data = json.loads(texts[0])
        if not isinstance(data, dict):
            raise RuntimeError('MCP 返回不是对象')
        return data

    async def set_device_state(self, device_id, desired):
        name = {'light': 'toggle_light', 'plug': 'toggle_plug', 'climate': 'set_climate'}[self.devices[device_id]['kind']]
        return await self._call(name, {'device_id': device_id, **desired})

    async def get_device_state(self, device_id):
        # Internal read-only tool is NOT included in the model's public tools.
        return await self._call('read_device_state', {'device_id': device_id})

    async def trigger_camera(self, device_id, operation, seconds=None):
        args = {'device_id': device_id}
        if seconds is not None:
            args['seconds'] = seconds
        return await self._call('camera_' + operation, args)


@asynccontextmanager
async def open_mcp(server_path, config_path, devices):
    from mcp import ClientSession, StdioServerParameters
    from mcp.client.stdio import stdio_client
    # Never give the child unrelated Tesla, model or TTS credentials.
    env = {key: os.environ[key] for key in ('PATH', 'LANG', 'LC_ALL', 'TZ') if key in os.environ}
    env['SMARTHOME_CONFIG'] = str(config_path)
    params = StdioServerParameters(command=sys.executable,
        args=['-m', 'smarthome.mcp_server'], cwd=str(server_path.parent.parent), env=env)
    async with stdio_client(params) as (read, write):
        async with ClientSession(read, write) as session:
            await session.initialize()
            discovered = {item.name for item in (await session.list_tools()).tools}
            if not {item['name'] for item in list_tools()} | {'read_device_state'} <= discovered:
                raise RuntimeError('MCP 服务缺少固定工具或内部回读接口')
            yield MijiaMCPProvider(session, devices)


class HomeAssistantProvider(SmartHomeProvider):
    """Migration skeleton, intentionally not enabled for live writes."""
    async def set_device_state(self, device_id, desired):
        raise NotImplementedError('HA 写入尚未经过实体能力与回读验证')

    async def get_device_state(self, device_id):
        raise NotImplementedError('HA 状态归一化待实现')

    async def trigger_camera(self, device_id, operation, seconds=None):
        return {'ok': False, 'code': 'camera_not_configured'}

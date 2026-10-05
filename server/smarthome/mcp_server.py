"""Fixed MCP facade; defaults disabled, no login or network on discovery.

Run from server/: python -m smarthome.mcp_server
--schemas uses only the standard library, no credentials or network.
"""
import asyncio
from contextlib import ExitStack
import json
import os
from pathlib import Path
import sys

from .contracts import list_tools, validate


class Dispatcher:
    """One account/session in one child process, serialized by serve()."""
    def __init__(self, config, backend_factory=None):
        self.config = config
        self.backend_factory = backend_factory
        self.backend = None
        self.stack = ExitStack()

    def _backend(self):
        if self.backend is None:
            if self.backend_factory is not None:
                self.backend = self.backend_factory()
            else:
                from .credential_store import CredentialStore
                from .mijia_backend import MijiaBackend, secure_api
                path = Path(self.config['credential_dir'])
                if not path.is_absolute():
                    raise ValueError('凭证目录必须是服务端配置的绝对路径')
                store = CredentialStore(path)
                self.stack.enter_context(store.exclusive())
                self.backend = MijiaBackend(self.config, secure_api(store))
        return self.backend

    def call(self, name, arguments):
        if self.config.get('enabled') is not True or self.config.get('provider') != 'mijia':
            return {'ok': False, 'accepted': False, 'available': False,
                'code': 'disabled', 'message': '家居服务未启用，未执行操作'}
        try:
            if name == 'read_device_state':
                validate('camera_snapshot', arguments)  # Same alias-only schema.
                return self._backend().read(arguments['device_id'])
            validate(name, arguments)
            if name.startswith('camera_'):
                return {'ok': False, 'code': 'camera_not_configured',
                    'message': '摄像头取流与受保护媒体服务尚未适配'}
            return self._backend().write(name, arguments)
        except Exception:
            # Never echo SDK messages, device IDs, cookies or login links.
            return {'ok': False, 'accepted': False, 'confirmed': False,
                'available': False, 'code': 'device_request_failed',
                'result_unknown': name.startswith('toggle_') or name == 'set_climate',
                'message': '设备请求失败或配置不可用；未自动重试'}

    def close(self):
        try:
            if self.backend is not None:
                self.backend.close()
        finally:
            self.stack.close()


async def serve():
    from mcp.server import Server
    from mcp.server.stdio import stdio_server
    from mcp.types import TextContent, Tool
    server = Server('DriveTalk Smart Home')
    path = os.environ.get('SMARTHOME_CONFIG')
    config = json.loads(Path(path).read_text(encoding='utf-8')) if path else {'enabled': False}
    dispatcher = Dispatcher(config)
    lock = asyncio.Lock()

    @server.list_tools()
    async def tools():
        public = [Tool(**item) for item in list_tools()]
        # Internal probe for the bridge, never forwarded to the LLM.
        return public + [Tool(name='read_device_state', description='内部设备状态回读',
            inputSchema={'type': 'object', 'properties': {'device_id': {'type': 'string'}},
                'required': ['device_id'], 'additionalProperties': False})]

    @server.call_tool()
    async def call(name, arguments):
        async with lock:
            data = await asyncio.to_thread(dispatcher.call, name, arguments)
        return [TextContent(type='text', text=json.dumps(data, ensure_ascii=False, allow_nan=False))]

    try:
        async with stdio_server() as (read, write):
            await server.run(read, write, server.create_initialization_options())
    finally:
        dispatcher.close()


if __name__ == '__main__':
    if '--schemas' in sys.argv:
        print(json.dumps(list_tools(), ensure_ascii=False, indent=2))
    else:
        asyncio.run(serve())

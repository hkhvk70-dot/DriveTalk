"""Optional real stdio handshake against a DISABLED local server. No SDK account use."""
import asyncio
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from .providers import open_mcp


@unittest.skipUnless(importlib.util.find_spec('mcp'), 'Optional MCP SDK is not installed')
class MCPTransportTests(unittest.IsolatedAsyncioTestCase):
    async def test_disabled_subprocess_handshake_list_and_calls_without_credentials(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'config.json'
            path.write_text(json.dumps({'enabled': False, 'provider': 'mijia', 'devices': {}}), encoding='utf-8')
            async def probe():
                devices = {'lamp': {'kind': 'light'}}
                async with open_mcp(Path(__file__).with_name('mcp_server.py'), path, devices) as provider:
                    result = await provider.set_device_state('lamp', {'on': True})
                    self.assertFalse(result['accepted']); self.assertEqual(result['code'], 'disabled')
                    actual = await provider.get_device_state('lamp')
                    self.assertFalse(actual['available']); self.assertEqual(actual['code'], 'disabled')
            await asyncio.wait_for(probe(), 15)

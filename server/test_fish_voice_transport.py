"""Real loopback WebSocket + MessagePack; upstream is local, no external API."""
import asyncio
import json
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
import unittest
from cryptography.fernet import Fernet
from drivetalk_server import StateStore
from fish_voice import FishVoiceSettings, FishVoiceProxy, PATH, quiet_logger
try:
    import msgpack
    from websockets.asyncio.client import connect
    from websockets.asyncio.server import serve
    from websockets.exceptions import InvalidStatus
    AVAILABLE = True
except ImportError:
    AVAILABLE = False

TURN = '11111111-1111-4111-8111-111111111111'

@unittest.skipUnless(AVAILABLE, 'install requirements-voice.txt to run transport tests')
class TransportTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = TemporaryDirectory()
        settings = FishVoiceSettings(StateStore(Path(self.temp.name) / 'state.sqlite3', Fernet(Fernet.generate_key())))
        settings.save({'apiKey':'only-a-local-test-key', 'referenceId':'a'*32, 'enabled':True})
        self.frames = []; self.connections = 0; self.upstream_closed = asyncio.Event()
        async def upstream(socket):
            self.connections += 1
            try:
                await socket.send(msgpack.packb({'event':'authenticated'},use_bin_type=True))
                async for raw in socket:
                    value = msgpack.unpackb(raw, raw=False); self.frames.append(value)
                    if value['event'] == 'start':
                        await socket.send(msgpack.packb({'event':'ready','format':'pcm','sampleRate':32000,'channels':1,'bitDepth':16},use_bin_type=True))
                    elif value['event'] == 'text':
                        await socket.send(msgpack.packb({'event':'input_ack','inReplyTo':value['eventId']},use_bin_type=True))
                    elif value['event'] == 'flush':
                        await socket.send(msgpack.packb({'event':'audio','audio':b'\0\0\1\0','format':'pcm','sampleRate':32000,'channels':1,'bitDepth':16}, use_bin_type=True))
                        await socket.send(msgpack.packb({'event':'segment_completed','segmentId':value['segmentId']},use_bin_type=True))
                    elif value['event'] == 'stop':
                        await socket.send(msgpack.packb({'event':'finish','reason':'completed'}, use_bin_type=True)); return
            finally: self.upstream_closed.set()
        self.fish = await serve(upstream, '127.0.0.1', 0, logger=quiet_logger(), subprotocols=['realtime.tts.msgpack.v3'])
        port = self.fish.sockets[0].getsockname()[1]
        def connector(url, **kwargs):
            self.assertEqual(url, 'wss://realtime.fishaudio.org/v3/tts/live')
            self.assertEqual(kwargs['additional_headers']['Authorization'], 'Bearer only-a-local-test-key')
            return connect(f'ws://127.0.0.1:{port}', **kwargs)
        self.proxy = FishVoiceProxy(settings, SimpleNamespace(valid=lambda cookie:cookie=='test-owner'), 'console.example.invalid',
            connector=connector, pack=lambda v:msgpack.packb(v,use_bin_type=True),
            unpack=lambda raw:msgpack.unpackb(raw,raw=False,max_bin_len=262144,max_str_len=4096,max_array_len=64,max_map_len=64),
            capabilities=lambda:{'protocolVersion':'3','modes':['reliable'],'models':[{'id':'fishaudio-s21pro-flash','supportsStreaming':True,'outputFormats':['mp3','pcm']}]})
        self.relay = await serve(self.proxy.handle, '127.0.0.1', 0,
            process_request=self.proxy.process_request, logger=quiet_logger(), max_size=4096)
        self.url = f'ws://127.0.0.1:{self.relay.sockets[0].getsockname()[1]}{PATH}'

    async def asyncTearDown(self):
        self.relay.close(); await self.relay.wait_closed()
        self.fish.close(); await self.fish.wait_closed(); self.temp.cleanup()

    def client(self, headers=None):
        return connect(self.url, origin='https://console.example.invalid',
            additional_headers=headers or {'Cookie':'test-owner'}, proxy=None, logger=quiet_logger())

    async def start(self, socket):
        await socket.send(json.dumps({'event':'start','turnId':TURN}))
        ready = json.loads(await asyncio.wait_for(socket.recv(),2))
        self.assertEqual(ready['event'],'ready')

    async def test_real_handshake_pcm_before_end_and_messagepack_finish(self):
        async with self.client() as socket:
            await self.start(socket)
            await socket.send(json.dumps({'event':'text','sequence':0,'text':'第一句。'}))
            self.assertEqual(await asyncio.wait_for(socket.recv(),2), b'\0\0\1\0')
            # First audio has arrived while input is still writable.
            await socket.send(json.dumps({'event':'text','sequence':1,'text':'第二句。'}))
            self.assertIsInstance(await asyncio.wait_for(socket.recv(),2),bytes)
            await socket.send(json.dumps({'event':'stop','sequences':2}))
            finish = json.loads(await asyncio.wait_for(socket.recv(),2))
            self.assertEqual(finish,{'event':'finish','reason':'stop','turnId':TURN})
        self.assertEqual([v['event'] for v in self.frames],['start','text','flush','text','flush','stop'])
        self.assertEqual(self.frames[0]['request']['voiceId'],'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa')
        self.assertEqual(self.connections,1)

    async def test_missing_cookie_is_http_403_before_upstream(self):
        with self.assertRaises(InvalidStatus) as error:
            async with self.client({'Cookie':'not-owner'}): pass
        self.assertEqual(error.exception.response.status_code,403)
        self.assertEqual(self.connections,0)

    async def test_duplicate_origin_is_denied_not_server_error(self):
        with self.assertRaises(InvalidStatus) as error:
            async with self.client({'Cookie':'test-owner','Origin':'https://evil.invalid'}): pass
        self.assertEqual(error.exception.response.status_code,403)
        self.assertEqual(self.connections,0)

    async def test_disconnect_closes_upstream_without_reconnecting(self):
        async with self.client() as socket: await self.start(socket)
        await asyncio.wait_for(self.upstream_closed.wait(),2)
        self.assertEqual(self.connections,1)

if __name__ == '__main__': unittest.main()

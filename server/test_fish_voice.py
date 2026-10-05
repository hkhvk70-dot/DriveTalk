"""Fake sockets and encrypted temporary database only: no Fish or vehicle requests."""
import asyncio
import json
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
import unittest
from cryptography.fernet import Fernet
from drivetalk_server import StateStore, DriveTalkHttpServer
from fish_voice import FishVoiceSettings, FishVoiceProxy, VOICE_CONFIG, PATH
from vehicle_dashboard import DashboardError

TURN = '11111111-1111-4111-8111-111111111111'
KEY = 'fish-test-only-key-never-live'

class FakeSocket:
    def __init__(self):
        self.incoming = asyncio.Queue()
        self.sent = []
        self.closed = False
        self.request = SimpleNamespace(path=PATH, headers={'Origin': 'https://console.example.invalid', 'Cookie': 'test-session'})
    async def recv(self):
        value = await self.incoming.get()
        if isinstance(value, Exception): raise value
        return value
    async def send(self, value): self.sent.append(value)
    async def close(self, *args): self.closed = True

class VoiceTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.temp = TemporaryDirectory()
        self.path = Path(self.temp.name) / 'state.sqlite3'
        self.settings = FishVoiceSettings(StateStore(self.path, Fernet(Fernet.generate_key())))
        self.settings.save({'apiKey': KEY, 'referenceId': 'a' * 32, 'enabled': True})
        self.client, self.upstream = FakeSocket(), FakeSocket()
        self.calls = []
        owner = self
        class Connection:
            async def __aenter__(self): return owner.upstream
            async def __aexit__(self, *args): owner.upstream.closed = True
        def connect(url, **kwargs):
            self.calls.append((url, kwargs)); return Connection()
        # Deterministic JSON codec fake: real MessagePack transport is a separate adapter.
        self.codec_values = {}
        def pack(value): return json.dumps(value).encode()
        def unpack(raw): return self.codec_values[raw]
        self.proxy = FishVoiceProxy(self.settings, SimpleNamespace(valid=lambda cookie: cookie == 'test-session'),
                                   'console.example.invalid', connector=connect, pack=pack, unpack=unpack, capabilities=lambda: {'protocolVersion':'3','modes':['reliable'],'models':[{'id':'fishaudio-s21pro-flash','supportsStreaming':True,'outputFormats':['mp3','pcm']}]})
        self.codec_values[b'auth'] = {'event':'authenticated'}
        self.codec_values[b'ready'] = {'event':'ready','format':'pcm','sampleRate':32000,'channels':1,'bitDepth':16}
        self.upstream.incoming.put_nowait(b'auth'); self.upstream.incoming.put_nowait(b'ready')
        original_send = self.upstream.send
        async def upstream_send(raw):
            await original_send(raw)
            value = json.loads(raw)
            if value['event'] == 'text':
                self.codec_values[b'ack'] = {'event':'input_ack','inReplyTo':value['eventId']}
                await self.upstream.incoming.put(b'ack')
        self.upstream.send = upstream_send

    def tearDown(self): self.temp.cleanup()

    def test_key_encrypted_and_never_returned(self):
        self.assertNotIn(KEY.encode(), self.path.read_bytes())
        self.assertNotIn('apiKey', self.settings.config())
        for payload in ({'apiKey': 'x\nHeader'}, {'enabled': 'yes'}, {'referenceId': 'invalid'}, {'model': 'bad'}, {'url': 'http://evil'}):
            with self.assertRaises(DashboardError): self.settings.save(payload)
        self.settings.save({'clear': True})
        self.assertFalse(self.settings.config()['configured'])

    async def test_auth_before_handshake_rejects_foreign_origin_queries_and_no_cookie(self):
        connection = SimpleNamespace(respond=lambda code, text: code)
        for request in (SimpleNamespace(path=PATH, headers={'Origin': 'https://evil', 'Cookie': 'test-session'}),
                        SimpleNamespace(path=PATH + '?key=x', headers=self.client.request.headers),
                        SimpleNamespace(path=PATH, headers={'Origin': 'https://console.example.invalid'})):
            self.assertEqual(await self.proxy.process_request(connection, request), 403)
        self.assertIsNone(await self.proxy.process_request(connection, self.client.request))

    async def wait_for(self, condition):
        for _ in range(100):
            if condition(): return
            await asyncio.sleep(0.001)
        self.fail('fake pipeline did not advance')

    async def start(self):
        await self.client.incoming.put(json.dumps({'event': 'start', 'turnId': TURN}))
        task = asyncio.create_task(self.proxy.handle(self.client))
        await self.wait_for(lambda: self.client.sent)
        return task

    async def test_audio_arrives_before_text_end_then_flush_stop_finish_in_order(self):
        task = await self.start()
        await self.client.incoming.put(json.dumps({'event': 'text', 'sequence': 0, 'text': '第一句。'}))
        await self.wait_for(lambda: len(self.upstream.sent) == 3)
        self.codec_values[b'first'] = {'event': 'audio', 'audio': b'\x00\x00\x00\x01', 'format':'pcm','sampleRate':32000,'channels':1,'bitDepth':16}
        await self.upstream.incoming.put(b'first')
        await self.wait_for(lambda: any(isinstance(value, bytes) for value in self.client.sent))
        self.assertFalse(task.done())
        self.assertEqual([json.loads(v)['event'] for v in self.upstream.sent], ['start', 'text', 'flush'])
        settings = json.loads(self.upstream.sent[0])['request']
        self.assertEqual((settings['latency'], settings['chunkLength'], settings['format']), ('balanced', 100, 'mp3'))
        self.assertEqual(self.calls[0][0], 'wss://realtime.fishaudio.org/v3/tts/live')
        self.assertEqual(self.calls[0][1]['additional_headers']['Authorization'], 'Bearer ' + KEY)
        self.codec_values[b'complete'] = {'event':'segment_completed','segmentId':TURN+'-segment-1'}
        await self.upstream.incoming.put(b'complete')
        await self.client.incoming.put(json.dumps({'event': 'stop', 'sequences': 1}))
        await self.wait_for(lambda: len(self.upstream.sent) == 4)
        self.codec_values[b'finish'] = {'event': 'finish', 'reason': 'completed'}
        await self.upstream.incoming.put(b'finish')
        await asyncio.wait_for(task, 1)
        self.assertEqual(json.loads(self.client.sent[-1])['event'], 'finish')
        self.assertTrue(self.upstream.closed)
        self.assertNotIn(KEY, str(self.client.sent))

    async def test_disconnect_cancels_upstream_and_never_reconnects(self):
        task = await self.start()
        await self.client.incoming.put(ConnectionError('test closed'))
        await asyncio.wait_for(task, 1)
        self.assertTrue(self.upstream.closed)
        self.assertEqual(len(self.calls), 1)
        self.assertFalse(self.proxy.active)

    async def test_public_capability_http_failure_does_not_block_authenticated_ws(self):
        def blocked(): raise RuntimeError('Public GET unavailable')
        self.proxy.capabilities = blocked
        task = await self.start()
        self.assertEqual(json.loads(self.client.sent[0])['event'], 'ready')
        await self.client.incoming.put(ConnectionError('test end'))
        await asyncio.wait_for(task,1)

    async def test_mp3_segments_join_before_delivery_without_waiting_for_text_stop(self):
        self.codec_values[b'ready'] = {'event':'ready','format':'mp3'}
        task = await self.start()
        await self.client.incoming.put(json.dumps({'event':'text','sequence':0,'text':'你好。'}))
        await self.wait_for(lambda: len(self.upstream.sent) == 3)
        for frame, audio in ((b'one', b'ID3'), (b'two', b'mock-audio')):
            self.codec_values[frame] = {'event':'audio','audio':audio,'format':'mp3'}
            await self.upstream.incoming.put(frame)
        self.codec_values[b'complete'] = {'event':'segment_completed','segmentId':TURN+'-segment-1'}
        await self.upstream.incoming.put(b'complete')
        await self.wait_for(lambda: any(isinstance(v,bytes) for v in self.client.sent))
        self.assertIn(b'ID3mock-audio', self.client.sent)
        self.assertFalse(task.done())
        self.assertEqual(json.loads(self.client.sent[0])['format'], 'mp3')
        await self.client.incoming.put(ConnectionError('test end'))
        await asyncio.wait_for(task,1)

    async def test_duplicate_frame_or_revoked_cookie_stops_synthesis(self):
        task = await self.start()
        await self.client.incoming.put(json.dumps({'event': 'text', 'sequence': 1, 'text': '乱序。'}))
        await asyncio.wait_for(task, 1)
        self.assertEqual(len(self.upstream.sent), 1)
        self.assertEqual(json.loads(self.client.sent[-1])['event'], 'error')

    async def test_turn_dedup_and_daily_quota_persist(self):
        self.proxy.reserve(TURN)
        with self.assertRaises(ValueError): self.proxy.reserve(TURN)
        self.proxy.reserve_text(39999)
        with self.assertRaises(ValueError): self.proxy.reserve_text(2)

    def test_existing_key_and_compact_id_are_preserved_and_mapped_to_org(self):
        self.assertEqual(self.settings.config()['referenceId'], 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa')
        self.assertEqual(self.settings.config()['model'], 'fishaudio-s21pro-flash')
        self.settings.save({'model':'s2.1-pro','referenceId':'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'})
        self.assertEqual(self.settings.store.load_protected_json(VOICE_CONFIG)['apiKey'], KEY)

    async def test_unsupported_pcm_metadata_rejected_before_audio(self):
        self.codec_values[b'ready']['channels'] = 2
        task = await self.start()
        await asyncio.wait_for(task,1)
        self.assertEqual(json.loads(self.client.sent[-1])['event'],'error')
        self.assertFalse(any(isinstance(v,bytes) for v in self.client.sent))

    async def test_provider_error_is_sanitized_and_never_retried(self):
        task = await self.start()
        self.codec_values[b'error'] = {'event':'error','message':KEY,'code':'quota_exceeded'}
        await self.upstream.incoming.put(b'error')
        await asyncio.wait_for(task,1)
        self.assertNotIn(KEY,str(self.client.sent))
        self.assertEqual(len(self.calls),1)

if __name__ == '__main__': unittest.main()

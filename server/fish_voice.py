"""Encrypted voice settings and bounded Fish WS relay. No vehicle capabilities."""
import asyncio
from datetime import date
import json
import logging
import re
import threading
import uuid
import time
from urllib.request import urlopen
from vehicle_dashboard import DashboardError

VOICE_CONFIG = 'fish-voice-settings-v1'
MODEL = 'fishaudio-s21pro-flash'
LEGACY_MODELS = ('s1', 's2-pro', 's2.1-pro', 's2.1-pro-free')
MODELS = (MODEL, *LEGACY_MODELS)
PATH = '/v1/vehicle/ai/voice/live'
UPSTREAM = 'wss://realtime.fishaudio.org/v3/tts/live'
SUBPROTOCOL = 'realtime.tts.msgpack.v3'


def voice_id(value):
    if not isinstance(value, str) or not re.fullmatch(r'(?:[a-fA-F0-9]{32}|[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12})', value.strip()):
        raise ValueError('Invalid voice')
    return str(uuid.UUID(value.strip()))


def read_capabilities():
    # Fixed public endpoint, no credentials, TTL-cached by the relay.
    with urlopen('https://realtime.fishaudio.org/v3/tts/capabilities', timeout=6) as response:
        raw = response.read(65537)
        if len(raw) > 65536: raise ValueError('Capability limit')
        return json.loads(raw)


class FishVoiceSettings:
    def __init__(self, store):
        self.store = store
        self.lock = threading.Lock()

    def config(self):
        value = self.store.load_protected_json(VOICE_CONFIG) or {}
        return {'configured': bool(value.get('apiKey') and value.get('referenceId')),
                'enabled': value.get('enabled') is True, 'model': MODEL,
                'referenceId': voice_id(value['referenceId']) if value.get('referenceId') else ''}

    def save(self, payload):
        if not isinstance(payload, dict) or set(payload) - {'apiKey', 'referenceId', 'model', 'enabled', 'clear'}:
            raise DashboardError(400, '语音配置格式无效')
        with self.lock:
            value = dict(self.store.load_protected_json(VOICE_CONFIG) or {})
            if 'clear' in payload and type(payload['clear']) is not bool:
                raise DashboardError(400, '清除参数无效')
            if payload.get('clear') is True:
                value = {'enabled': False, 'model': MODEL}
            else:
                for field, pattern in [('apiKey', r'[A-Za-z0-9_.-]{16,256}'), ('referenceId', r'(?:[a-fA-F0-9]{32}|[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12})')]:
                    if field in payload:
                        if not isinstance(payload[field], str) or not re.fullmatch(pattern, payload[field].strip()):
                            raise DashboardError(400, 'Fish Key 或音色 ID 无效')
                        value[field] = voice_id(payload[field]) if field == 'referenceId' else payload[field].strip()
                if 'model' in payload:
                    if payload['model'] not in MODELS: raise DashboardError(400, 'Fish 模型名称无效')
                    value['model'] = MODEL
                if 'enabled' in payload:
                    if type(payload['enabled']) is not bool: raise DashboardError(400, '启用参数无效')
                    value['enabled'] = payload['enabled']
                if value.get('enabled') and not (value.get('apiKey') and value.get('referenceId')):
                    raise DashboardError(400, '请先保存 Fish Key 与音色 ID')
            self.store.save_protected_json(VOICE_CONFIG, value)
            return self.config()


class FishVoiceProxy:
    def __init__(self, settings, sessions, domain, *, connector, pack, unpack, capabilities=read_capabilities):
        self.settings, self.sessions, self.domain = settings, sessions, domain
        self.connector, self.pack, self.unpack = connector, pack, unpack
        self.active = False
        self.capabilities = capabilities
        self.capability_until = 0

    async def check_capabilities(self):
        if time.monotonic() < self.capability_until: return
        value = await asyncio.to_thread(self.capabilities)
        if str(value.get('protocolVersion')) != '3' or 'reliable' not in value.get('modes', []): raise ValueError('Unsupported protocol')
        if not any(m.get('id') == MODEL and m.get('supportsStreaming') is True and 'mp3' in m.get('outputFormats', []) for m in value.get('models', [])):
            raise ValueError('Unsupported streaming model')
        self.capability_until = time.monotonic() + 300

    def authorized(self, request):
        try:
            if hasattr(request.headers, 'get_all') and any(len(request.headers.get_all(name)) != 1 for name in ('Origin', 'Cookie')):
                return False
            return (request.path == PATH and request.headers.get('Origin') == 'https://' + self.domain
                    and self.sessions.valid(request.headers.get('Cookie', '')))
        except (ValueError, KeyError):
            # websockets Headers rejects duplicate Origin/Cookie; fail closed.
            return False

    async def process_request(self, connection, request):
        if not self.authorized(request): return connection.respond(403, 'Voice session denied')

    def reserve(self, turn_id):
        runtime = self.settings.store.load_protected_json('fish-voice-runtime-v1') or {}
        if runtime.get('day') != date.today().isoformat():
            runtime = {'day': date.today().isoformat(), 'turns': [], 'characters': 0}
        if turn_id in runtime['turns']: raise ValueError('Repeated turn')
        if len(runtime['turns']) >= 100: raise ValueError('Voice quota')
        runtime['turns'].append(turn_id)
        self.settings.store.save_protected_json('fish-voice-runtime-v1', runtime)

    def reserve_text(self, length):
        runtime = self.settings.store.load_protected_json('fish-voice-runtime-v1')
        if runtime['characters'] + length > 40_000: raise ValueError('Voice text quota')
        runtime['characters'] += length
        self.settings.store.save_protected_json('fish-voice-runtime-v1', runtime)

    async def handle(self, client):
        if self.active or not self.authorized(client.request):
            await client.close(1008, 'Voice unavailable'); return
        self.active = True
        turn_id = ''
        try:
            await asyncio.wait_for(self.relay(client), timeout=90)
        except Exception:
            # Provider exceptions / bodies / keys must never enter logs or UI.
            try: await client.send(json.dumps({'event': 'error', 'turnId': getattr(client, 'voice_turn', turn_id)}))
            except Exception: pass
        finally:
            self.active = False
            await client.close()

    async def relay(self, client):
        raw = await asyncio.wait_for(client.recv(), 8)
        if not isinstance(raw, str) or len(raw) > 4096: raise ValueError('Invalid start')
        start = json.loads(raw)
        if not isinstance(start, dict) or set(start) != {'event', 'turnId'} or start['event'] != 'start' or not isinstance(start['turnId'], str) or not re.fullmatch(r'[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}', start['turnId']):
            raise ValueError('Invalid start')
        turn_id = start['turnId'].lower()
        client.voice_turn = start['turnId']
        settings = self.settings.store.load_protected_json(VOICE_CONFIG) or {}
        if settings.get('enabled') is not True or not self.settings.config()['configured']: raise ValueError('Not configured')
        self.reserve(turn_id)
        # ready 是本回合的实际格式协商结果。公开 capabilities GET 在部分网络/UA
        # 返回 HTTP 错误，不应作为已鉴权 WS 的必经门槛，更不能误报成余额不足。
        # Fixed upstream host, TLS verified, no redirects/reconnect/retries or key in URL.
        async with self.connector(UPSTREAM,
                                  additional_headers={'Authorization': 'Bearer ' + settings['apiKey']}, subprotocols=[SUBPROTOCOL],
                                  open_timeout=8, max_size=262144, max_queue=4, write_limit=32768,
                                  proxy=None, compression=None, logger=quiet_logger()) as upstream:
            def decode(raw):
                if not isinstance(raw, bytes) or len(raw) > 262144: raise ValueError('Invalid frame')
                value = self.unpack(raw)
                if not isinstance(value, dict): raise ValueError('Invalid event')
                return value
            authenticated = decode(await asyncio.wait_for(upstream.recv(), 8))
            if authenticated.get('event') != 'authenticated': raise ValueError('Authentication failed')
            await upstream.send(self.pack({'event':'start', 'mode':'reliable', 'eventId':turn_id+'-start', 'requestId':turn_id,
                'request':{'format':'mp3','voiceId':voice_id(settings['referenceId']), 'modelId':MODEL,
                           'latency':'balanced','chunkLength':100}}))
            while True:
                ready = decode(await asyncio.wait_for(upstream.recv(), 8))
                if ready.get('event') == 'warning': continue
                if ready.get('event') != 'ready': raise ValueError('Start rejected')
                break
            rate = ready.get('sampleRate')
            audio_format = ready.get('format')
            if audio_format not in ('mp3', 'pcm'):
                raise ValueError('Unsupported audio format')
            if audio_format == 'pcm' and (type(rate) is not int or not 8000 <= rate <= 48000 or ready.get('channels') != 1 or ready.get('bitDepth') != 16):
                raise ValueError('Unsupported PCM metadata')
            await client.send(json.dumps({'event': 'ready', 'turnId': start['turnId'], 'format': 'mp3' if audio_format == 'mp3' else 'pcm_s16le', 'sampleRate': rate}))
            stopped = False
            pending_ack = None
            pending_segment = None
            ack_id = segment_id = ''
            async def send_text():
                nonlocal stopped, pending_ack, pending_segment, ack_id, segment_id
                sequence, total = 0, 0
                while True:
                    raw = await asyncio.wait_for(client.recv(), 35)
                    if not self.authorized(client.request) or not self.settings.config()['enabled']: raise ValueError('Revoked')
                    if not isinstance(raw, str) or len(raw) > 4096: raise ValueError('Invalid frame')
                    value = json.loads(raw)
                    if not isinstance(value, dict) or stopped: raise ValueError('Invalid event')
                    if value.get('event') == 'stop' and set(value) == {'event', 'sequences'} and type(value['sequences']) is int and value['sequences'] == sequence:
                        stopped = True
                        await upstream.send(self.pack({'event': 'stop', 'eventId':turn_id+'-stop'}))
                    elif value.get('event') == 'text' and set(value) == {'event', 'sequence', 'text'}:
                        text = value['text']
                        if type(value['sequence']) is not int or value['sequence'] != sequence or not isinstance(text, str) or not text.strip() or len(text) > 300 or total + len(text) > 6000:
                            raise ValueError('Invalid text')
                        self.reserve_text(len(text)); sequence += 1; total += len(text)
                        ack_id = turn_id+'-text-'+str(sequence)
                        segment_id = turn_id+'-segment-'+str(sequence)
                        pending_ack = asyncio.get_running_loop().create_future()
                        pending_segment = asyncio.get_running_loop().create_future()
                        await upstream.send(self.pack({'event': 'text', 'eventId':ack_id, 'sequence':sequence, 'text': text}))
                        await asyncio.wait_for(pending_ack, 35)
                        await upstream.send(self.pack({'event': 'flush', 'eventId':turn_id+'-flush-'+str(sequence), 'segmentId':segment_id}))
                        # Sentence N+1 is synthesized while sentence N is playing on the phone.
                        await asyncio.wait_for(pending_segment, 35)
                    else: raise ValueError('Invalid event')
            async def receive_audio():
                received = 0
                segment_audio = bytearray()
                while True:
                    raw = await asyncio.wait_for(upstream.recv(), 35)
                    if not self.authorized(client.request) or not self.settings.config()['enabled']: raise ValueError('Revoked')
                    value = decode(raw)
                    if value.get('event') == 'audio':
                        audio = value.get('audio')
                        if not isinstance(audio, bytes) or not audio: raise ValueError('Invalid PCM')
                        if value.get('format') != audio_format:
                            raise ValueError('Audio format changed')
                        if audio_format == 'pcm' and (value.get('sampleRate') != rate or value.get('channels') != 1 or value.get('bitDepth') != 16):
                            raise ValueError('PCM metadata changed')
                        received += len(audio)
                        if received > 8_000_000: raise ValueError('Too much audio')
                        if pending_segment is None or pending_segment.done(): raise ValueError('Unexpected audio')
                        if audio_format == 'mp3':
                            segment_audio.extend(audio)
                            if len(segment_audio) > 1_000_000: raise ValueError('Segment limit')
                        else:
                            await client.send(audio)
                    elif value.get('event') == 'input_ack':
                        if pending_ack is None or pending_ack.done() or value.get('inReplyTo') != ack_id: raise ValueError('Invalid ack')
                        pending_ack.set_result(None)
                    elif value.get('event') == 'segment_completed':
                        if pending_segment is None or pending_segment.done() or value.get('segmentId') != segment_id: raise ValueError('Invalid segment')
                        if audio_format == 'mp3':
                            if not segment_audio: raise ValueError('Empty MP3 segment')
                            await client.send(bytes(segment_audio))
                            segment_audio.clear()
                        pending_segment.set_result(None)
                    elif value.get('event') in ('usage','segment_accepted','warning','pong'):
                        continue
                    elif value.get('event') == 'finish' and value.get('reason') == 'completed' and stopped:
                        await client.send(json.dumps({'event': 'finish', 'reason': 'stop', 'turnId': start['turnId']})); return
                    else: raise ValueError('Fish synthesis error')
            tasks = [asyncio.create_task(send_text()), asyncio.create_task(receive_audio())]
            try:
                done, _ = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
                for task in done: task.result()
            finally:
                for task in tasks: task.cancel()
                await asyncio.gather(*tasks, return_exceptions=True)


async def main():
    import msgpack
    from websockets.asyncio.client import connect
    from websockets.asyncio.server import serve
    from drivetalk_server import Config, StateStore, load_cipher, read_secret
    from mobile_sessions import MobileSessions
    config = Config.from_environment()
    store = StateStore(config.database_path, load_cipher(config.token_key_file))
    sessions = MobileSessions(config.database_path.parent / 'mobile-sessions.sqlite3', lambda: read_secret(config.mobile_token_file))
    proxy = FishVoiceProxy(FishVoiceSettings(store), sessions, config.domain, connector=connect,
        pack=lambda value: msgpack.packb(value, use_bin_type=True),
        unpack=lambda raw: msgpack.unpackb(raw, raw=False, max_bin_len=262144, max_str_len=4096, max_array_len=64, max_map_len=64))
    logger = quiet_logger()
    async with serve(proxy.handle, '127.0.0.1', 8790, process_request=proxy.process_request,
                     max_size=4096, max_queue=4, write_limit=32768, logger=logger):
        await asyncio.Future()

def quiet_logger():
    logger = logging.getLogger('drivetalk.voice.websocket')
    logger.disabled = True  # WS errors may include provider headers; UI gets static error only.
    return logger

if __name__ == '__main__': asyncio.run(main())

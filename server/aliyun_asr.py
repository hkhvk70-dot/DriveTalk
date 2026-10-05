"""Authenticated, bounded Fun-ASR relay. No audio persistence or vehicle capabilities."""
import asyncio
from datetime import date
import json
import math
import re
import threading
import uuid
from vehicle_dashboard import DashboardError
from fish_voice import quiet_logger

CONFIG = 'aliyun-asr-settings-v1'
RUNTIME = 'aliyun-asr-runtime-v1'
PATH = '/v1/vehicle/ai/asr/live'
MODEL = 'fun-asr-realtime'
BYTES_PER_SECOND = 32000
MAX_SECONDS = 120
DAILY_SECONDS = 3600


class AliAsrSettings:
    def __init__(self, store):
        self.store = store
        self.lock = threading.Lock()

    def private(self):
        return self.store.load_protected_json(CONFIG) or {}

    def config(self):
        value = self.private()
        configured = bool(value.get('apiKey') and value.get('workspaceId'))
        return {'configured': configured, 'enabled': configured and value.get('enabled') is True,
                'workspaceId': value.get('workspaceId', ''), 'model': MODEL, 'region': 'cn-beijing',
                'silenceMs': 2000, 'maxSeconds': MAX_SECONDS, 'dailySeconds': DAILY_SECONDS}

    def save(self, payload):
        if not isinstance(payload, dict) or set(payload) - {'apiKey', 'workspaceId', 'enabled', 'clear'}:
            raise DashboardError(400, '阿里云识别配置格式无效')
        with self.lock:
            value = dict(self.private())
            if any(type(payload[f]) is not bool for f in ('enabled', 'clear') if f in payload):
                raise DashboardError(400, '识别开关格式无效')
            if payload.get('clear'):
                value = {'enabled': False}
            else:
                for field, pattern in [('apiKey', r'[A-Za-z0-9_.-]{16,256}'),
                                       ('workspaceId', r'[A-Za-z0-9][A-Za-z0-9-]{0,62}')]:
                    if field in payload:
                        if not isinstance(payload[field], str) or not re.fullmatch(pattern, payload[field].strip()):
                            raise DashboardError(400, '请填写有效的百炼北京区 Key 和 Workspace ID')
                        value[field] = payload[field].strip()
                if 'enabled' in payload:
                    value['enabled'] = payload['enabled']
                if value.get('enabled') and not (value.get('apiKey') and value.get('workspaceId')):
                    raise DashboardError(400, '请先填写百炼北京区 Key 和 Workspace ID')
            value['revision'] = str(uuid.uuid4())  # Changing/clearing config invalidates active capture.
            self.store.save_protected_json(CONFIG, value)
            return self.config()


class AsrFault(Exception):
    def __init__(self, code):
        self.code = code


class Transcript:
    """Provider hypotheses replace the same sentence; never append partial duplicates."""
    def __init__(self):
        self.sentences = {}

    def update(self, sentence):
        if not isinstance(sentence, dict):
            raise AsrFault('asr-protocol')
        if sentence.get('heartbeat') is True:
            return self.text
        number, text, final = sentence.get('sentence_id'), sentence.get('text'), sentence.get('sentence_end')
        if type(number) is not int or not 1 <= number <= 1000 or not isinstance(text, str) or type(final) is not bool:
            raise AsrFault('asr-protocol')
        previous = self.sentences.get(number)
        if number not in self.sentences and number != len(self.sentences) + 1:
            raise AsrFault('asr-protocol')
        if previous and previous[1] and not final:
            raise AsrFault('asr-protocol')
        self.sentences[number] = (text, final)
        if len(self.text) > 12000:
            raise AsrFault('too-long')
        return self.text

    @property
    def text(self):
        return ''.join(self.sentences[k][0] for k in sorted(self.sentences))

    @property
    def complete(self):
        return bool(self.text.strip()) and all(final for text, final in self.sentences.values() if text.strip())


class AliAsrProxy:
    def __init__(self, settings, sessions, domain, *, connector):
        self.settings, self.sessions, self.domain = settings, sessions, domain
        self.connector = connector
        self.active = False

    def authorized(self, request):
        try:
            if hasattr(request.headers, 'get_all') and any(len(request.headers.get_all(n)) != 1 for n in ('Origin', 'Cookie')):
                return False
            return request.path == PATH and request.headers.get('Origin') == 'https://' + self.domain and self.sessions.valid(request.headers.get('Cookie', ''))
        except (ValueError, KeyError):
            return False

    async def process_request(self, connection, request):
        if not self.authorized(request):
            return connection.respond(403, 'ASR session denied')

    def reserve(self, turn_id=None, seconds=0):
        # Dedicated relay is single-process/single-active; only encrypted quota counters persist.
        with self.settings.lock:
            value = self.settings.store.load_protected_json(RUNTIME) or {}
            if value.get('day') != date.today().isoformat():
                value = {'day': date.today().isoformat(), 'turns': [], 'seconds': 0}
            if turn_id is not None:
                if turn_id in value['turns'] or len(value['turns']) >= 300:
                    raise AsrFault('asr-quota')
                value['turns'].append(turn_id)
            if value['seconds'] + seconds > DAILY_SECONDS:
                raise AsrFault('asr-quota')
            value['seconds'] += seconds
            self.settings.store.save_protected_json(RUNTIME, value)

    async def handle(self, client):
        if not self.authorized(client.request) or self.active:
            await client.close(1008, 'ASR unavailable')
            return
        self.active = True
        try:
            await asyncio.wait_for(self.relay(client), 145)
        except Exception as error:
            code = error.code if isinstance(error, AsrFault) else 'asr-network'
            status = getattr(getattr(error, 'response', None), 'status_code', None)
            if status in (401, 403): code = 'asr-provider'
            elif status == 429: code = 'asr-rate-limit'
            elif isinstance(error, TimeoutError): code = 'asr-timeout'
            try:
                await client.send(json.dumps({'event': 'error', 'code': code}))
            except Exception:
                pass
        finally:
            self.active = False
            await client.close()

    async def relay(self, client):
        start = json.loads(await asyncio.wait_for(client.recv(), 8))
        if not isinstance(start, dict) or set(start) != {'event', 'turnId'} or start['event'] != 'start':
            raise AsrFault('asr-protocol')
        turn_id = start['turnId']
        if not isinstance(turn_id, str) or str(uuid.UUID(turn_id)) != turn_id:
            raise AsrFault('asr-protocol')
        config = self.settings.private()
        if not self.settings.config()['enabled']:
            raise AsrFault('asr-config')
        self.reserve(turn_id)
        url = f"wss://{config['workspaceId']}.cn-beijing.maas.aliyuncs.com/api-ws/v1/inference"

        def check():
            current = self.settings.private()
            if not self.authorized(client.request) or not current.get('enabled') or current.get('revision') != config.get('revision'):
                raise AsrFault('asr-config')

        # TLS verified, fixed provider domain, no redirect, retries or proxy credential leakage.
        async with self.connector(url, additional_headers={'Authorization': 'Bearer ' + config['apiKey']},
                                  open_timeout=8, max_size=65536, max_queue=4, write_limit=32768,
                                  compression=None, proxy=None, logger=quiet_logger()) as upstream:
            check()
            await upstream.send(json.dumps({'header': {'action': 'run-task', 'task_id': turn_id, 'streaming': 'duplex'},
                'payload': {'task_group': 'audio', 'task': 'asr', 'function': 'recognition', 'model': MODEL,
                    'parameters': {'format': 'pcm', 'sample_rate': 16000, 'max_sentence_silence': 2000,
                                   'semantic_punctuation_enabled': False, 'heartbeat': True},
                    'input': {'context': [{'role': 'user', 'content': [{'type': 'input_text',
                        'text': '特斯拉、后备箱、前备箱、充电口盖、空调、二十一度、米家、示例区域甲、示例区域乙、智能插座'}]}]}}}))

            async def event():
                check()
                raw = await asyncio.wait_for(upstream.recv(), 18)
                if not isinstance(raw, str):
                    raise AsrFault('asr-protocol')
                value = json.loads(raw)
                header = value.get('header', {})
                if header.get('task_id') != turn_id:
                    raise AsrFault('asr-protocol')
                if header.get('event') == 'task-failed':
                    # Never relay provider error text/headers or supplied credentials.
                    raise AsrFault('asr-provider')
                return value

            first = await event()
            if first['header']['event'] != 'task-started':
                raise AsrFault('asr-protocol')
            await client.send(json.dumps({'event': 'ready', 'turnId': turn_id}))
            stopping = None
            transcript = Transcript()

            async def audio():
                nonlocal stopping
                total = charged = 0
                began = asyncio.get_running_loop().time()
                while True:
                    raw = await asyncio.wait_for(client.recv(), 18)
                    check()
                    if stopping is not None:
                        raise AsrFault('asr-protocol')
                    if isinstance(raw, bytes):
                        if not raw or len(raw) > 16384 or len(raw) % 2:
                            raise AsrFault('asr-protocol')
                        total += len(raw)
                        # Bound both duration and faster-than-real-time abuse (1 second slack).
                        if total > MAX_SECONDS * BYTES_PER_SECOND or total > (asyncio.get_running_loop().time() - began + 1) * BYTES_PER_SECOND:
                            raise AsrFault('asr-quota')
                        seconds = math.ceil(total / BYTES_PER_SECOND)
                        if seconds > charged:
                            self.reserve(seconds=seconds - charged)
                            charged = seconds
                        await upstream.send(raw)
                    else:
                        value = json.loads(raw)
                        if not isinstance(value, dict) or set(value) != {'event', 'reason'} or value['event'] != 'stop' or value['reason'] not in ('complete', 'stopped', 'timeout', 'no-speech'):
                            raise AsrFault('asr-protocol')
                        stopping = value['reason']
                        await upstream.send(json.dumps({'header': {'action': 'finish-task', 'task_id': turn_id, 'streaming': 'duplex'}, 'payload': {'input': {}}}))
                        # Keep reading to detect disconnect/replay while waiting for task-finished.

            async def results():
                while True:
                    value = await event()
                    kind = value['header']['event']
                    if kind == 'result-generated':
                        text = transcript.update(value.get('payload', {}).get('output', {}).get('sentence'))
                        await client.send(json.dumps({'event': 'partial', 'turnId': turn_id, 'text': text}))
                    elif kind == 'task-finished' and stopping is not None:
                        reason = stopping
                        if reason == 'complete' and not transcript.complete:
                            reason = 'no-speech' if not transcript.text else 'asr-incomplete'
                        await client.send(json.dumps({'event': 'finish', 'turnId': turn_id, 'text': transcript.text, 'reason': reason}))
                        return
                    else:
                        raise AsrFault('asr-protocol')

            tasks = [asyncio.create_task(audio()), asyncio.create_task(results())]
            try:
                done, _ = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
                for task in done:
                    task.result()
            finally:
                for task in tasks:
                    task.cancel()
                await asyncio.gather(*tasks, return_exceptions=True)


async def main():
    from websockets.asyncio.client import connect
    from websockets.asyncio.server import serve
    from drivetalk_server import Config, StateStore, load_cipher, read_secret
    from mobile_sessions import MobileSessions
    config = Config.from_environment()
    store = StateStore(config.database_path, load_cipher(config.token_key_file))
    sessions = MobileSessions(config.database_path.parent / 'mobile-sessions.sqlite3', lambda: read_secret(config.mobile_token_file))
    proxy = AliAsrProxy(AliAsrSettings(store), sessions, config.domain, connector=connect)
    async with serve(proxy.handle, '127.0.0.1', 8791, process_request=proxy.process_request,
                     max_size=16384, max_queue=4, write_limit=32768, logger=quiet_logger()):
        await asyncio.Future()


if __name__ == '__main__':
    asyncio.run(main())

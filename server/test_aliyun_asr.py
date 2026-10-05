import asyncio
import copy
import json
from types import SimpleNamespace
import unittest
import uuid
from aliyun_asr import AliAsrSettings, AliAsrProxy, Transcript, AsrFault, PATH, RUNTIME, CONFIG
from vehicle_dashboard import DashboardError


class Store:
    def __init__(self): self.values = {}
    def load_protected_json(self, key): return copy.deepcopy(self.values.get(key))
    def save_protected_json(self, key, value): self.values[key] = copy.deepcopy(value)


class SettingsTests(unittest.TestCase):
    def setUp(self): self.store = Store(); self.settings = AliAsrSettings(self.store)
    def test_encrypted_namespace_and_public_key_redaction(self):
        value = self.settings.save({'apiKey':'test-only-not-a-real-key','workspaceId':'test-space','enabled':True})
        self.assertTrue(value['enabled']); self.assertNotIn('apiKey', value)
        self.assertEqual(set(self.store.values), {CONFIG})
    def test_clear_and_disable(self):
        self.settings.save({'apiKey':'test-only-not-a-real-key','workspaceId':'123','enabled':True})
        first = self.settings.private()['revision']
        self.settings.save({'enabled':False})
        self.assertNotEqual(first, self.settings.private()['revision'])
        self.assertTrue(self.settings.config()['configured'])
        self.assertFalse(self.settings.save({'clear':True})['configured'])
        self.assertNotIn('apiKey', self.settings.private())
    def test_invalid_config_cannot_set_endpoint_or_enable_missing_key(self):
        for value in [{'enabled':True}, {'workspaceId':'../evil'}, {'workspaceId':'x.y'},
                      {'apiKey':'bad\r\nkey'}, {'baseUrl':'http://localhost'}, {'enabled':1}, {'clear':'yes'}]:
            with self.assertRaises(DashboardError): self.settings.save(value)
        self.assertEqual(self.store.values, {})
    def test_hypotheses_replace_and_sentences_accumulate(self):
        t = Transcript()
        def update(i,text,end): return t.update({'sentence_id':i,'text':text,'sentence_end':end})
        self.assertEqual(update(1,'调到二',False),'调到二')
        self.assertEqual(update(1,'调到21度。',True),'调到21度。')
        self.assertEqual(update(2,'请打开',False),'调到21度。请打开'); self.assertFalse(t.complete)
        self.assertEqual(update(2,'请不要打开后备箱。',True),'调到21度。请不要打开后备箱。'); self.assertTrue(t.complete)
        self.assertEqual(t.update({'heartbeat':True,'sentence_id':0}), t.text)
        with self.assertRaises(AsrFault): update(1,'stale',False)
    def test_invalid_sentence_and_length(self):
        for value in [{}, {'sentence_id':True,'text':'x','sentence_end':True}, {'sentence_id':1,'text':'x','sentence_end':'yes'},
                      {'sentence_id':1,'text':'x'*12001,'sentence_end':False}]:
            with self.assertRaises(AsrFault): Transcript().update(value)
    def test_missing_sentence_is_rejected_but_empty_next_sentence_is_not_audio(self):
        t = Transcript()
        with self.assertRaises(AsrFault): t.update({'sentence_id':2,'text':'请打开','sentence_end':True})
        t.update({'sentence_id':1,'text':'请不要打开。','sentence_end':True})
        t.update({'sentence_id':2,'text':'','sentence_end':False})
        self.assertTrue(t.complete)


class Socket:
    def __init__(self): self.incoming = asyncio.Queue(); self.sent = []; self.closed = False
    async def recv(self): return await self.incoming.get()
    async def send(self, value): self.sent.append(value)
    async def close(self, *args): self.closed = True


class RelayTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.store = Store(); settings = AliAsrSettings(self.store)
        settings.save({'apiKey':'test-only-not-a-real-key','workspaceId':'space-123','enabled':True})
        self.calls = []; self.upstream = Socket()
        parent = self
        class Connector:
            def __call__(self, url, **kwargs): parent.calls.append((url,kwargs)); return self
            async def __aenter__(self): return parent.upstream
            async def __aexit__(self,*args): parent.upstream.closed = True
        self.valid = True
        self.proxy = AliAsrProxy(settings,SimpleNamespace(valid=lambda cookie:self.valid and cookie=='owner'),'unit.example',connector=Connector())
        self.client = Socket(); self.client.request = SimpleNamespace(path=PATH,headers={'Origin':'https://unit.example','Cookie':'owner'})
        self.id = str(uuid.uuid4())
    async def put_event(self, kind, **payload):
        await self.upstream.incoming.put(json.dumps({'header':{'event':kind,'task_id':self.id},'payload':payload}))
    async def start(self):
        await self.client.incoming.put(json.dumps({'event':'start','turnId':self.id}))
        await self.put_event('task-started')
        task = asyncio.create_task(self.proxy.handle(self.client))
        for _ in range(30):
            if self.client.sent: break
            await asyncio.sleep(0)
        return task
    async def test_protocol_pcm_and_task_finish(self):
        task = await self.start()
        self.assertEqual(json.loads(self.client.sent[0])['event'],'ready')
        await self.client.incoming.put(bytes(3200))
        await self.client.incoming.put(json.dumps({'event':'stop','reason':'complete'}))
        for _ in range(30):
            if len(self.upstream.sent) >= 3: break
            await asyncio.sleep(0)
        await self.put_event('result-generated',output={'sentence':{'sentence_id':1,'text':'空调调至21度。','sentence_end':True}})
        await self.put_event('task-finished')
        await asyncio.wait_for(task,1)
        result = json.loads(self.client.sent[-1]); self.assertEqual(result['reason'],'complete')
        self.assertEqual(result['text'],'空调调至21度。')
        self.assertEqual(self.calls[0][0],'wss://space-123.cn-beijing.maas.aliyuncs.com/api-ws/v1/inference')
        self.assertIsNone(self.calls[0][1]['proxy'])
        request = json.loads(self.upstream.sent[0]); self.assertEqual(request['payload']['parameters']['max_sentence_silence'],2000)
        self.assertEqual(self.upstream.sent[1],bytes(3200)); self.assertTrue(self.upstream.closed)
        self.assertEqual(self.store.values[RUNTIME]['seconds'],1)
    async def test_failed_provider_redacts_error_and_closes(self):
        task = await self.start()
        await self.upstream.incoming.put(json.dumps({'header':{'event':'task-failed','task_id':self.id,'error_message':'test-only-not-a-real-key'}}))
        await asyncio.wait_for(task,1)
        self.assertEqual(json.loads(self.client.sent[-1]),{'event':'error','code':'asr-provider'})
        self.assertTrue(self.upstream.closed); self.assertFalse(self.proxy.active)
    async def test_revoked_config_stops_without_reconnect(self):
        task = await self.start(); self.proxy.settings.save({'enabled':False})
        await self.client.incoming.put(bytes(3200))
        await asyncio.wait_for(task,1)
        self.assertEqual(json.loads(self.client.sent[-1])['code'],'asr-config'); self.assertEqual(len(self.calls),1)
    async def test_bad_auth_and_path_do_not_connect(self):
        for field,value in [('path',PATH+'?key=x'),('headers',{'Origin':'https://other.example','Cookie':'owner'})]:
            client = Socket(); client.request = copy.deepcopy(self.client.request); setattr(client.request,field,value)
            await self.proxy.handle(client); self.assertTrue(client.closed)
        self.assertEqual(self.calls,[])
    async def test_duplicate_turn_and_quota(self):
        self.proxy.reserve(self.id)
        with self.assertRaises(AsrFault): self.proxy.reserve(self.id)
        self.proxy.reserve(seconds=3600)
        with self.assertRaises(AsrFault): self.proxy.reserve(seconds=1)
    async def test_binary_audio_has_strict_size_and_alignment(self):
        task = await self.start(); await self.client.incoming.put(b'x')
        await asyncio.wait_for(task,1)
        self.assertEqual(json.loads(self.client.sent[-1])['code'],'asr-protocol')
        self.assertEqual(len(self.upstream.sent),1)
    async def test_session_revocation_on_result_blocks_transcript(self):
        task = await self.start(); self.valid = False
        await self.put_event('result-generated',output={'sentence':{'sentence_id':1,'text':'开锁','sentence_end':True}})
        await asyncio.wait_for(task,1)
        self.assertEqual(json.loads(self.client.sent[-1])['event'],'error')
        self.assertNotIn('开锁',str(self.client.sent))
    async def test_duplicate_headers_fail_closed(self):
        class Headers(dict):
            def get_all(self, key): return [self[key], self[key]]
        self.client.request.headers = Headers(self.client.request.headers)
        await self.proxy.handle(self.client); self.assertEqual(self.calls,[])
    async def test_incomplete_or_manual_finish_is_not_complete(self):
        for stop in ('complete','stopped','timeout'):
            self.id = str(uuid.uuid4()); self.client = Socket(); self.client.request = SimpleNamespace(path=PATH,headers={'Origin':'https://unit.example','Cookie':'owner'})
            task = await self.start()
            await self.client.incoming.put(json.dumps({'event':'stop','reason':stop}))
            for _ in range(20): await asyncio.sleep(0)
            await self.put_event('result-generated',output={'sentence':{'sentence_id':1,'text':'打开后','sentence_end':False}})
            await self.put_event('task-finished'); await asyncio.wait_for(task,1)
            result = json.loads(self.client.sent[-1])
            self.assertEqual(result['reason'], 'asr-incomplete' if stop == 'complete' else stop)
            self.assertEqual(result['text'],'打开后')


if __name__ == '__main__': unittest.main()

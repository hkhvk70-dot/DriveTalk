import copy
import http.client
import json
import threading
from types import SimpleNamespace
import unittest
from drivetalk_server import DriveTalkHttpServer
from aliyun_asr import AliAsrSettings


class Store:
    def __init__(self): self.value = None
    def load_protected_json(self, _key): return copy.deepcopy(self.value)
    def save_protected_json(self, _key, value): self.value = copy.deepcopy(value)


class AsrHTTPTests(unittest.TestCase):
    def setUp(self):
        self.settings = AliAsrSettings(Store())
        app = SimpleNamespace(config=SimpleNamespace(domain='owner.invalid'), asr=self.settings,
            mobile_token_is_valid=lambda token: token == 'test-owner', sessions=SimpleNamespace(valid=lambda cookie:cookie == 'owner'))
        self.server = DriveTalkHttpServer(('127.0.0.1',0),app)
        self.thread = threading.Thread(target=self.server.serve_forever,daemon=True); self.thread.start()
    def tearDown(self): self.server.shutdown(); self.server.server_close(); self.thread.join()
    def request(self, method='GET', body=None, **headers):
        connection = http.client.HTTPConnection(*self.server.server_address,timeout=3)
        try:
            connection.request(method,'/v1/vehicle/ai/asr/config',body=body,headers=headers)
            response = connection.getresponse(); return response.status,dict(response.getheaders()),json.loads(response.read())
        finally: connection.close()
    def test_owner_required_read_and_save(self):
        self.assertEqual(self.request()[0],401)
        self.assertEqual(self.request('POST','{}')[0],401)
        self.assertIsNone(self.settings.store.value)
    def test_origin_required_to_save(self):
        headers={'Cookie':'owner','Content-Type':'application/json','Origin':'https://other.invalid'}
        self.assertEqual(self.request('POST','{}',**headers)[0],403)
        self.assertIsNone(self.settings.store.value)
    def test_save_does_not_call_asr_provider_or_pause_as_grok(self):
        body=json.dumps({'apiKey':'test-only-not-real-key','workspaceId':'unit-space','enabled':True})
        headers={'Cookie':'owner','Content-Type':'application/json','Origin':'https://owner.invalid'}
        status,cache,value=self.request('POST',body,**headers)
        self.assertEqual(status,200); self.assertEqual(cache['Cache-Control'],'no-store')
        self.assertTrue(value['enabled']); self.assertNotIn('apiKey',value)
        self.assertTrue(self.request(Cookie='owner')[2]['enabled'])
    def test_invalid_endpoint_is_rejected_without_mutation(self):
        headers={'X-DriveTalk-Token':'test-owner','Content-Type':'application/json','Origin':'https://owner.invalid'}
        self.assertEqual(self.request('POST','{"baseUrl":"http://localhost"}',**headers)[0],400)
        self.assertIsNone(self.settings.store.value)


if __name__ == '__main__': unittest.main()

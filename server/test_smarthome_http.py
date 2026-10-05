import http.client
import json
import threading
from types import SimpleNamespace
import unittest
from drivetalk_server import DriveTalkHttpServer


class HomeHTTPTests(unittest.TestCase):
    def setUp(self):
        self.calls = []
        def action(value):
            self.calls.append(value); return {'controlConnected': False}
        app = SimpleNamespace(config=SimpleNamespace(domain='owner.invalid'),
            mobile_token_is_valid=lambda v: v == 'test-owner', sessions=SimpleNamespace(valid=lambda v: False),
            smarthome=SimpleNamespace(status=lambda: {'available': False}, start=action,
                                      cancel=lambda: action('cancel'), select=action))
        self.server = DriveTalkHttpServer(('127.0.0.1', 0), app)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True); self.thread.start()
    def tearDown(self): self.server.shutdown(); self.server.server_close(); self.thread.join()
    def request(self, path='status', method='GET', body=None, headers=None):
        connection = http.client.HTTPConnection(*self.server.server_address)
        connection.request(method, '/v1/smarthome/' + path, body, headers or {})
        response = connection.getresponse(); result = response.status, json.loads(response.read())
        connection.close(); return result
    def headers(self):
        return {'X-DriveTalk-Token': 'test-owner', 'Origin': 'https://owner.invalid', 'Content-Type': 'application/json'}
    def test_owner_required_for_read_and_post(self):
        self.assertEqual(self.request()[0], 401)
        self.assertEqual(self.request('login', 'POST', '{}')[0], 401)
        self.assertFalse(self.calls)
    def test_origin_and_content_type_enforced(self):
        for headers in (dict(self.headers(), Origin='https://evil.invalid'),
                        dict(self.headers(), **{'Content-Type': 'text/plain'})):
            self.assertEqual(self.request('login', 'POST', '{}', headers)[0], 403)
        self.assertFalse(self.calls)
    def test_status_no_cloud_operation(self):
        self.assertEqual(self.request(headers=self.headers()), (200, {'available': False}))
        self.assertFalse(self.calls)
    def test_parameter_whitelist(self):
        self.assertEqual(self.request('login', 'POST', '{"password":"not-accepted"}', self.headers())[0], 409)
        self.assertFalse(self.calls)
    def test_explicit_operations_dispatched_once(self):
        self.assertEqual(self.request('login', 'POST', '{}', self.headers())[0], 200)
        self.assertEqual(self.request('select', 'POST', '{"deviceIds":[]}', self.headers())[0], 200)
        self.assertEqual(self.calls, ['login', []])

    def test_control_selection_grant_is_distinct_and_whitelisted(self):
        def select(ids, *, enable_control=False):
            if type(enable_control) is not bool: raise ValueError('Invalid grant')
            self.calls.append((ids, enable_control)); return {'controlGranted': enable_control}
        self.server.application.smarthome.select = select
        headers = self.headers()
        self.assertEqual(self.request('select', 'POST', '{"deviceIds":[],"enableControl":true}', headers)[0], 200)
        self.assertEqual(self.calls, [([], True)])
        self.assertEqual(self.request('select', 'POST', '{"deviceIds":[],"enableControl":"true"}', headers)[0], 409)
        self.assertEqual(self.request('select', 'POST', '{"deviceIds":[],"enableControl":true,"url":"evil"}', headers)[0], 409)
        self.assertEqual(self.request('select', 'POST', '{"deviceIds":[],"enableControl":true}', dict(headers, Origin='https://evil.invalid'))[0], 403)
        self.assertEqual(self.calls, [([], True)])


if __name__ == '__main__': unittest.main()

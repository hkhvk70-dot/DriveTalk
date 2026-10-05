import http.client
import json
import threading
import unittest
from types import SimpleNamespace
from drivetalk_server import DriveTalkHttpServer
from vehicle_dashboard import DashboardError
from vehicle_commands import VehicleCommands


class DashboardHttpTests(unittest.TestCase):
    def setUp(self):
        self.calls = []
        def status():
            self.calls.append('status')
            return {'response': {'state': 'asleep'}}
        def wake():
            self.calls.append('wake')
            return {'accepted': True}
        self.dashboard = SimpleNamespace(status=status, data=status, wake=wake)
        app = SimpleNamespace(config=SimpleNamespace(domain='example.test'),
                              mobile_token_is_valid=lambda value: value == 'test-only',
                              dashboard=self.dashboard)
        app.commands = VehicleCommands(self.dashboard)
        self.server = DriveTalkHttpServer(('127.0.0.1', 0), app)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()

    def request(self, method='GET', path='/v1/vehicle/status', headers=None, body=None):
        connection = http.client.HTTPConnection('127.0.0.1', self.server.server_port, timeout=3)
        try:
            connection.request(method, path, body=body, headers=headers or {})
            response = connection.getresponse()
            return response.status, dict(response.getheaders()), json.loads(response.read())
        finally:
            connection.close()

    def test_missing_or_wrong_token_never_calls_vehicle(self):
        self.assertEqual(self.request()[0], 401)
        self.assertEqual(self.request(headers={'X-DriveTalk-Token': 'wrong'})[0], 401)
        self.assertEqual(self.calls, [])

    def test_authorized_status_has_no_store_cache_header(self):
        status, headers, payload = self.request(headers={'X-DriveTalk-Token': 'test-only'})
        self.assertEqual(status, 200)
        self.assertEqual(headers['Cache-Control'], 'no-store')
        self.assertEqual(payload['response']['state'], 'asleep')

    def test_wake_requires_same_origin(self):
        headers = {'X-DriveTalk-Token': 'test-only', 'Content-Type': 'application/json'}
        self.assertEqual(self.request('POST', '/v1/vehicle/wake', headers, '{}')[0], 403)
        headers['Origin'] = 'https://other.test'
        self.assertEqual(self.request('POST', '/v1/vehicle/wake', headers, '{}')[0], 403)
        self.assertEqual(self.calls, [])

    def test_explicit_wake_and_invalid_body(self):
        headers = {'X-DriveTalk-Token': 'test-only', 'Content-Type': 'application/json',
                   'Origin': 'https://example.test'}
        self.assertEqual(self.request('POST', '/v1/vehicle/wake', headers, '{"unlock":true}')[0], 400)
        self.assertEqual(self.request('POST', '/v1/vehicle/wake', headers, '{}')[2], {'accepted': True})
        self.assertEqual(self.calls, ['wake'])

    def test_rate_limit_preserves_retry_after(self):
        def limited():
            raise DashboardError(429, '等待重试', 90)
        self.dashboard.status = limited
        status, headers, _ = self.request(headers={'X-DriveTalk-Token': 'test-only'})
        self.assertEqual(status, 429)
        self.assertEqual(headers['Retry-After'], '90')

    def test_no_unlock_route(self):
        self.assertEqual(self.request('POST', '/v1/vehicle/unlock')[0], 404)
        self.assertEqual(self.calls, [])

    def test_capabilities_is_protected_and_disabled_by_default(self):
        self.assertEqual(self.request(path='/v1/vehicle/capabilities')[0], 401)
        result = self.request(path='/v1/vehicle/capabilities', headers={'X-DriveTalk-Token': 'test-only'})
        self.assertEqual(result[2], {'commands': False, 'navigation': False, 'rearTrunkClose': False})

    def test_model_route_is_owner_protected_and_never_calls_vehicle(self):
        self.assertEqual(self.request(path='/v1/vehicle/model')[0], 401)
        self.assertEqual(self.request(path='/v1/vehicle/model', headers={'X-DriveTalk-Token': 'test-only'})[0], 404)
        self.assertEqual(self.calls, [])

    def test_command_requires_token_origin_json_and_explicit_gate(self):
        body = json.dumps({'command': {'name': 'horn'}, 'requestId': '00000000-0000-4000-8000-000000000001'})
        self.assertEqual(self.request('POST', '/v1/vehicle/command', body=body)[0], 401)
        headers = {'X-DriveTalk-Token': 'test-only', 'Content-Type': 'application/json'}
        self.assertEqual(self.request('POST', '/v1/vehicle/command', headers, body)[0], 403)
        headers['Origin'] = 'https://example.test'
        self.assertEqual(self.request('POST', '/v1/vehicle/command', headers, body)[0], 503)
        self.assertEqual(self.request('POST', '/v1/vehicle/command', headers, '{bad')[0], 400)
        self.assertEqual(self.calls, [])


if __name__ == '__main__':
    unittest.main()

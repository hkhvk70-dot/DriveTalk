import http.client
from pathlib import Path
from tempfile import TemporaryDirectory
import threading
from types import SimpleNamespace
import unittest
from mobile_sessions import MobileSessions, COOKIE_NAME, TTL, session_cookie
from drivetalk_server import DriveTalkHttpServer

class SessionTests(unittest.TestCase):
    def setUp(self):
        self.temp = TemporaryDirectory()
        self.path = Path(self.temp.name) / 'sessions.db'
        self.now = 1000
        self.owner = 'test-only-owner'
        self.sessions = MobileSessions(self.path, lambda: self.owner, lambda: self.now)
    def tearDown(self): self.temp.cleanup()
    def cookie(self, value): return COOKIE_NAME + '=' + value
    def test_private_opaque_persistence(self):
        value = self.sessions.create()
        self.assertTrue(self.sessions.valid(self.cookie(value)))
        self.assertNotIn(value.encode(), self.path.read_bytes())
        self.assertNotIn(self.owner.encode(), self.path.read_bytes())
        reopened = MobileSessions(self.path, lambda: self.owner, lambda: self.now)
        self.assertTrue(reopened.valid(self.cookie(value)))
    def test_expiry_revoke_rotation_and_tampering(self):
        value = self.sessions.create()
        self.assertFalse(self.sessions.valid(self.cookie(value + 'x')))
        self.owner = 'rotated'; self.assertFalse(self.sessions.valid(self.cookie(value)))
        self.owner = 'test-only-owner'
        self.sessions.revoke(self.cookie(value)); self.assertFalse(self.sessions.valid(self.cookie(value)))
        value = self.sessions.create(); self.now += TTL
        self.assertFalse(self.sessions.valid(self.cookie(value)))
    def test_cookie_flags_and_login_limits(self):
        header = session_cookie('test', TTL)
        for flag in ('Secure', 'HttpOnly', 'SameSite=Strict', 'Path=/', 'Max-Age=2592000'): self.assertIn(flag, header)
        self.assertNotIn('Domain=', header)
        for _ in range(20): self.assertTrue(self.sessions.allow_login())
        self.assertFalse(self.sessions.allow_login())
        self.now += 301; self.assertTrue(self.sessions.allow_login())
    def test_http_login_resume_and_logout_without_vehicle_calls(self):
        app = SimpleNamespace(sessions=self.sessions, config=SimpleNamespace(domain='console.example.invalid'),
                              mobile_token_is_valid=lambda value: value == self.owner,
                              commands=SimpleNamespace(capabilities=lambda: {'commands': True}))
        server = DriveTalkHttpServer(('127.0.0.1', 0), app)
        thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
        def request(path, method='GET', headers=None):
            connection = http.client.HTTPConnection(*server.server_address)
            connection.request(method, path, '{}' if method == 'POST' else None, headers or {})
            response = connection.getresponse()
            result = (response.status, response.getheader('Set-Cookie'), response.read())
            connection.close(); return result
        try:
            headers = {'Origin': 'https://console.example.invalid', 'Content-Type': 'application/json', 'X-DriveTalk-Token': self.owner}
            bad = dict(headers, Origin='https://evil.invalid')
            self.assertEqual(request('/v1/vehicle/session/login', 'POST', bad)[0], 403)
            self.assertEqual(request('/v1/vehicle/session')[0], 401)
            status, cookie, _ = request('/v1/vehicle/session/login', 'POST', headers)
            self.assertEqual(status, 200); self.assertIn('HttpOnly', cookie)
            browser = {'Cookie': cookie.split(';')[0]}
            self.assertEqual(request('/v1/vehicle/session', headers=browser)[0], 200)
            self.assertEqual(request('/v1/vehicle/capabilities', headers=browser)[0], 200)
            self.assertEqual(request('/v1/vehicle/command', 'POST', browser)[0], 403)
            logout = dict(browser, Origin='https://console.example.invalid', **{'Content-Type': 'application/json'})
            self.assertEqual(request('/v1/vehicle/session/logout', 'POST', logout)[0], 200)
            self.assertEqual(request('/v1/vehicle/session', headers=browser)[0], 401)
        finally:
            server.shutdown(); server.server_close(); thread.join()

if __name__ == '__main__': unittest.main()

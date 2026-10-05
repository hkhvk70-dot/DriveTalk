import hashlib
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from .account_ui import AccountUI, safe_login_url, account_worker
from .credential_store import CredentialStore
from .discovery import sync_account
from .test_discovery import Account, prop
from .test_mijia import AUTH, FakeSession


class Process:
    def __init__(self): self.alive = True; self.stopped = False
    def is_alive(self): return self.alive
    def terminate(self): self.alive = False; self.stopped = True
    def join(self, timeout=0): pass
    def close(self): pass


class Pipe:
    def __init__(self, events=()): self.events = list(events)
    def poll(self): return bool(self.events)
    def recv(self): return self.events.pop(0)
    def close(self): pass


class AccountUITests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.store = CredentialStore(self.root); self.store.initialize(); self.store.save(AUTH)
        self.api = Account([{'did': 'private-did', 'name': '测试灯', 'model': 'vendor.light.test'}])
        self.inventory = sync_account(self.api, self.store, lambda m: {'model': m, 'properties': [prop()]})
        self.ui = AccountUI(self.root, ready=lambda: True)
    def tearDown(self): self.ui.cancel(); self.temp.cleanup()

    def test_status_private_and_does_not_call_cloud(self):
        calls = self.api.lists
        result = self.ui.status()
        self.assertTrue(result['configured']); self.assertEqual(len(result['devices']), 1)
        self.assertFalse(result['controlConnected']); self.assertEqual(calls, self.api.lists)
        self.assertNotIn('private-did', str(result)); self.assertNotIn(AUTH['serviceToken'], str(result))

    def test_disabled_does_not_make_credential_directory(self):
        ui = AccountUI(None, ready=lambda: True)
        self.assertFalse(ui.status()['available'])
        with self.assertRaises(ValueError): ui.start('login')

    def test_missing_sdk_blocks_cloud_start(self):
        self.ui.ready = lambda: False
        self.assertFalse(self.ui.status()['available'])
        with self.assertRaises(ValueError): self.ui.start('login')

    def test_relative_path_rejected(self):
        with self.assertRaises(ValueError): AccountUI('credentials')

    def test_safe_qr_origin(self):
        self.assertEqual(safe_login_url('https://account.xiaomi.com/pass/qr?ticket=test'),
                         'https://account.xiaomi.com/pass/qr?ticket=test')
        self.assertEqual(safe_login_url('https://ak.account.xiaomi.com/longPolling/login?ticket=test'),
                         'https://ak.account.xiaomi.com/longPolling/login?ticket=test')
        for url in ('http://account.xiaomi.com/', 'https://evil.invalid/',
                    'https://account.xiaomi.com.evil.invalid/', 'https://u@account.xiaomi.com/',
                    'https://account.xiaomi.com:8080/', 'https://ak.account.xiaomi.com.evil.invalid/',
                    'http://ak.account.xiaomi.com/', 'https://u@ak.account.xiaomi.com/',
                    'https://ak.account.xiaomi.com:8080/', None):
            with self.assertRaises(ValueError): safe_login_url(url)

    def test_status_reports_bounded_cooldown_without_cloud_requests(self):
        self.ui.clock = lambda: 10
        self.ui.next_start = 39.2
        self.assertEqual(self.ui.status()['retryAfter'], 30)
        with self.assertRaisesRegex(ValueError, '冷却'):
            self.ui.start('login')
        self.ui.clock = lambda: 40
        self.assertEqual(self.ui.status()['retryAfter'], 0)

    def test_device_selection_saved_not_activated(self):
        alias = next(iter(self.inventory['devices']))
        result = self.ui.select([alias])
        self.assertTrue(result['devices'][0]['enabled']); self.assertFalse(result['controlConnected'])
        self.assertFalse(self.store.load_inventory()['suggested_config']['enabled'])
        self.assertFalse(next(iter(self.store.load_inventory()['suggested_config']['devices'].values()))['enabled'])

    def test_unknown_or_duplicate_selection_rejected(self):
        alias = next(iter(self.inventory['devices']))
        before = (self.root / 'inventory.enc').read_bytes()
        for aliases in (['other'], [alias, alias], [1], None):
            with self.assertRaises(ValueError): self.ui.select(aliases)
        self.assertEqual((self.root / 'inventory.enc').read_bytes(), before)

    def test_mismatched_account_catalog_hidden_and_selection_blocked(self):
        auth = dict(AUTH, userId='another-account'); self.store.save(auth)
        result = self.ui.status()
        self.assertTrue(result['storageError']); self.assertEqual(result['devices'], [])
        with self.assertRaises(ValueError): self.ui.select([])

    def test_timeout_kills_process_and_removes_qr(self):
        self.ui.process = process = Process(); self.ui.pipe = Pipe()
        self.ui.started = 0; self.ui.clock = lambda: 181
        self.ui.job = {'state': 'waiting_scan', 'loginUrl': 'private-ticket'}
        self.assertEqual(self.ui.status()['job'], {'state': 'timeout'})
        self.assertTrue(process.stopped)

    def test_cancel_does_not_delete_auth_or_inventory(self):
        old_auth, old_inventory = self.store.auth.read_bytes(), (self.root / 'inventory.enc').read_bytes()
        self.ui.process = process = Process(); self.ui.pipe = Pipe()
        result = self.ui.cancel()
        self.assertEqual(result['job'], {'state': 'cancelled'}); self.assertTrue(process.stopped)
        self.assertEqual(self.store.auth.read_bytes(), old_auth)
        self.assertEqual((self.root / 'inventory.enc').read_bytes(), old_inventory)

    def test_process_failure_clears_qr(self):
        self.ui.process = Process(); self.ui.process.alive = False
        self.ui.pipe = Pipe(); self.ui.started = self.ui.clock()
        self.ui.job = {'state': 'waiting_scan', 'qrSvg': 'private'}
        self.assertEqual(self.ui.status()['job'], {'state': 'failed'})

    def test_invalid_child_qr_rejected(self):
        self.ui.process = process = Process(); self.ui.started = self.ui.clock()
        self.ui.pipe = Pipe([{'state': 'waiting_scan', 'loginUrl': 'https://evil.invalid', 'qrSvg': 'anything'}])
        self.assertEqual(self.ui.status()['job'], {'state': 'failed'})
        self.assertTrue(process.stopped)

    def test_worker_errors_sanitized(self):
        class Sender:
            def __init__(self): self.events = []
            def send(self, value): self.events.append(value)
            def close(self): pass
        connection = Sender()
        with patch('smarthome.account_ui.secure_api', side_effect=RuntimeError('secret upstream auth')):
            account_worker(connection, str(self.root), 'sync')
        self.assertEqual(connection.events, [{'state': 'failed'}])

    def test_worker_accepts_actual_official_qr_host_offline(self):
        class Sender:
            def __init__(self): self.events = []
            def send(self, value): self.events.append(value)
            def close(self): pass
        class QRAPI:
            def _get_qr_login_data(self):
                return {'loginUrl': 'https://ak.account.xiaomi.com/longPolling/login?ticket=mock'}
            def _complete_qr_login(self, data): return AUTH
        connection = Sender()
        class Image:
            def save(self, buffer): buffer.write(b'<svg/>')
        import sys
        from types import SimpleNamespace
        modules = {'qrcode': SimpleNamespace(make=lambda *a, **k: Image()),
                   'qrcode.image': SimpleNamespace(),
                   'qrcode.image.svg': SimpleNamespace(SvgPathImage=Image)}
        with patch('smarthome.account_ui.secure_api', return_value=QRAPI()), \
                patch('smarthome.account_ui.sync_account') as sync, patch.dict(sys.modules, modules):
            account_worker(connection, str(self.root), 'login')
        self.assertEqual([event['state'] for event in connection.events], ['waiting_scan', 'syncing', 'done'])
        self.assertTrue(connection.events[0]['loginUrl'].startswith('https://ak.account.xiaomi.com/'))
        self.assertNotIn(AUTH['serviceToken'], str(connection.events))
        sync.assert_called_once()


if __name__ == '__main__': unittest.main()

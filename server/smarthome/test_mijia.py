"""SDK doubles only. No imports of or network calls to mijiaAPI."""
import copy
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from cryptography.fernet import InvalidToken
from .credential_store import CredentialStore
from .mcp_server import Dispatcher
from .mijia_backend import MijiaBackend, decode, encode, secure_api


AUTH = {'ua': 'test-agent', 'ssecurity': 'test-security', 'userId': 'test-user',
        'cUserId': 'test-c-user', 'serviceToken': 'private-test-token'}
CONFIG = {'enabled': True, 'provider': 'mijia', 'devices': {
    'lamp': {'kind': 'light', 'enabled': True, 'did': 'test-private-did',
             'capabilities': ['on', 'brightness', 'color_temperature'],
             'properties': {'on': {'siid': 2, 'piid': 1},
                 'brightness': {'siid': 2, 'piid': 2, 'min': 1, 'max': 255, 'step': 1},
                 'color_temperature': {'siid': 2, 'piid': 3, 'min': 2700, 'max': 6500, 'step': 100}}}}}


class FakeSession:
    def __init__(self):
        self.closed = False
    def request(self, *args, **kwargs):
        return kwargs
    def close(self):
        self.closed = True


class FakeSDK:
    def __init__(self, auth_data_path):
        if Path(auth_data_path).exists():
            raise AssertionError('SDK unexpectedly read plaintext')
        self.auth_data = {}
    def _init_session(self):
        self.session = FakeSession()
    def _save_auth_data(self):
        raise AssertionError('Original plaintext persistence called')
    def get_devices_prop(self, rows):
        return rows
    def set_devices_prop(self, rows):
        return rows
    def login(self):
        self.auth_data = dict(AUTH)
        self._save_auth_data()
        self._init_session()
        return self.auth_data


class FakeAPI:
    def __init__(self):
        self.session = FakeSession()
        self.writes = []
        self.values = {1: True, 2: 128, 3: 4000}
        self.partial = False
    def set_devices_prop(self, rows):
        self.writes.append(rows)
        return [{**row, 'code': (-4001 if self.partial and row['piid'] == 3 else 0)} for row in rows]
    def get_devices_prop(self, rows):
        return [{**row, 'code': 0, 'value': self.values[row['piid']]} for row in reversed(rows)]


class CredentialTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.store = CredentialStore(Path(self.temp.name) / 'credentials')
        self.store.initialize()

    def test_ciphertext_roundtrip_no_plaintext(self):
        self.store.save(AUTH)
        self.assertEqual(self.store.load(), AUTH)
        self.assertNotIn(b'private-test-token', self.store.auth.read_bytes())
        self.assertEqual(sorted(p.name for p in self.store.directory.iterdir()), ['auth.enc', 'credential.key'])

    def test_ciphertext_tampering_fails(self):
        self.store.save(AUTH)
        encoded = bytearray(self.store.auth.read_bytes())
        encoded[-10] ^= 1
        self.store.auth.write_bytes(encoded)
        with self.assertRaises(InvalidToken):
            self.store.load()

    def test_invalid_auth_preserves_old_ciphertext(self):
        self.store.save(AUTH)
        old = self.store.auth.read_bytes()
        with self.assertRaises(ValueError):
            self.store.save({'serviceToken': 'incomplete'})
        self.assertEqual(self.store.auth.read_bytes(), old)

    def test_missing_key_never_regenerated_over_ciphertext(self):
        self.store.save(AUTH)
        self.store.key.unlink()
        with self.assertRaises(ValueError):
            self.store.initialize()

    def test_atomic_failure_preserves_old_and_cleans_temporary(self):
        self.store.save(AUTH)
        with patch('smarthome.credential_store.os.replace', side_effect=OSError('mock')):
            with self.assertRaises(OSError):
                self.store.save({**AUTH, 'serviceToken': 'new-token'})
        self.assertEqual(self.store.load(), AUTH)
        self.assertEqual(list(self.store.directory.glob('.auth-*')), [])

    def test_lock_rejects_second_process_handle(self):
        with self.store.exclusive():
            with self.assertRaises(OSError):
                with self.store.exclusive():
                    self.fail('must not acquire twice')
        with self.store.exclusive():
            pass

    def test_sdk_login_never_uses_plaintext_writer(self):
        api = secure_api(self.store, login=True, sdk_class=FakeSDK)
        api.login()
        self.assertEqual(self.store.load()['serviceToken'], AUTH['serviceToken'])
        self.assertEqual(list(self.store.directory.glob('.memory-only-*')), [])

    def test_sdk_refresh_encrypts_new_token(self):
        self.store.save(AUTH)
        api = secure_api(self.store, sdk_class=FakeSDK)
        api.auth_data['serviceToken'] = 'new-private-test-token'
        api._save_auth_data()
        self.assertEqual(self.store.load()['serviceToken'], 'new-private-test-token')
        self.assertNotIn(b'new-private-test-token', self.store.auth.read_bytes())

    def test_sdk_session_timeout_and_old_session_closed(self):
        self.store.save(AUTH)
        api = secure_api(self.store, sdk_class=FakeSDK)
        self.assertEqual(api.session.request()['timeout'], (5, 15))
        old = api.session
        api._init_session()
        self.assertTrue(old.closed)

    def test_unlogged_sdk_rejected(self):
        with self.assertRaises(RuntimeError):
            secure_api(self.store, sdk_class=FakeSDK)


class MappingTests(unittest.TestCase):
    def setUp(self):
        self.api = FakeAPI()
        self.config = copy.deepcopy(CONFIG)
        self.backend = MijiaBackend(self.config, self.api)

    def test_write_accepted_not_confirmed(self):
        result = self.backend.write('toggle_light', {'device_id': 'lamp', 'on': True})
        self.assertTrue(result['accepted'])
        self.assertFalse(result['confirmed'])
        self.assertEqual(len(self.api.writes), 1)

    def test_write_code_one_accepted_but_never_confirmed(self):
        with patch.object(self.api, 'set_devices_prop', return_value=[
                {'did': 'test-private-did', 'siid': 2, 'piid': 1, 'code': 1}]) as write:
            result = self.backend.write('toggle_light', {'device_id': 'lamp', 'on': True})
        self.assertTrue(result['accepted'])
        self.assertFalse(result['confirmed'])
        self.assertEqual(write.call_count, 1)

    def test_read_code_one_not_accepted_as_physical_state(self):
        with patch.object(self.api, 'get_devices_prop', return_value=[
                {'did': 'test-private-did', 'siid': 2, 'piid': n, 'code': 1, 'value': True}
                for n in (1, 2, 3)]):
            with self.assertRaises(ValueError):
                self.backend.read('lamp')

    def test_invalid_write_receipts_never_accepted(self):
        expected = [{'did': 'test-private-did', 'siid': 2, 'piid': 1}]
        for code in (True, '1', None, -4001, 2):
            with self.assertRaises(ValueError):
                MijiaBackend.rows([{**expected[0], 'code': code}], expected, accepted_codes=(0, 1))
        with self.assertRaises(ValueError):
            MijiaBackend.rows([{**expected[0], 'did': 'wrong', 'code': 1}], expected, accepted_codes=(0, 1))

    def test_normalized_read_reordered_response(self):
        state = self.backend.read('lamp')
        self.assertTrue(state['available'])
        self.assertTrue(state['on'])
        self.assertEqual(state['brightness'], 50)
        self.assertEqual(state['color_temperature'], 4000)
        self.assertNotIn('test-private-did', json.dumps(state))

    def test_missing_value_not_false(self):
        self.api.values[1] = None
        state = self.backend.read('lamp')
        self.assertIsNone(state['on'])
        self.assertFalse(state['available'])

    def test_bad_mapping_validated_before_write(self):
        del self.config['devices']['lamp']['properties']['color_temperature']
        with self.assertRaises(ValueError):
            self.backend.write('toggle_light', {'device_id': 'lamp', 'on': True, 'color_temperature': 4000})
        self.assertEqual(self.api.writes, [])

    def test_model_temperature_bounds_before_write(self):
        with self.assertRaises(ValueError):
            self.backend.write('toggle_light', {'device_id': 'lamp', 'on': True, 'color_temperature': 8000})
        self.assertEqual(self.api.writes, [])

    def test_partial_write_not_retried(self):
        self.api.partial = True
        with self.assertRaises(ValueError):
            self.backend.write('toggle_light', {'device_id': 'lamp', 'on': True, 'color_temperature': 4000})
        self.assertEqual(len(self.api.writes), 1)

    def test_duplicate_mapping_rejected(self):
        self.config['devices']['lamp']['properties']['brightness']['piid'] = 1
        with self.assertRaises(ValueError):
            self.backend.write('toggle_light', {'device_id': 'lamp', 'on': True, 'brightness': 50})
        self.assertEqual(self.api.writes, [])

    def test_scaled_brightness_and_steps(self):
        prop = self.config['devices']['lamp']['properties']['brightness']
        self.assertEqual(encode('brightness', 1, prop), 1)
        self.assertEqual(encode('brightness', 100, prop), 255)
        self.assertEqual(decode('brightness', 128, prop), 50)
        self.assertIsNone(decode('brightness', float('nan'), prop))

    def test_disabled_dispatcher_does_not_initialize_api(self):
        dispatcher = Dispatcher({'enabled': False}, backend_factory=lambda: self.fail('must not initialize'))
        self.assertEqual(dispatcher.call('toggle_light', {'device_id': 'lamp', 'on': True})['code'], 'disabled')

    def test_dispatcher_write_and_read_mock(self):
        dispatcher = Dispatcher(self.config, backend_factory=lambda: self.backend)
        self.assertTrue(dispatcher.call('toggle_light', {'device_id': 'lamp', 'on': True})['accepted'])
        self.assertEqual(dispatcher.call('read_device_state', {'device_id': 'lamp'})['brightness'], 50)
        dispatcher.close()
        self.assertTrue(self.api.session.closed)

    def test_camera_explicitly_unavailable(self):
        dispatcher = Dispatcher(self.config, backend_factory=lambda: self.fail('must not initialize'))
        result = dispatcher.call('camera_snapshot', {'device_id': 'camera'})
        self.assertEqual(result['code'], 'camera_not_configured')

    def test_dispatcher_never_echoes_sdk_error(self):
        dispatcher = Dispatcher(self.config, backend_factory=lambda: (_ for _ in ()).throw(RuntimeError('private-token')))
        result = dispatcher.call('toggle_light', {'device_id': 'lamp', 'on': True})
        self.assertNotIn('private-token', json.dumps(result))
        dispatcher.close()

    def test_unknown_raw_pressure_like_value_does_not_become_boolean(self):
        self.api.values[1] = 1
        state = self.backend.read('lamp')
        self.assertIsNone(state['on'])
        self.assertFalse(state['available'])

    def test_config_disabled_does_not_create_sdk_or_credentials(self):
        from .factory import load_config
        path = Path(__file__).with_name('config.example.json')
        settings = load_config(path)
        self.assertFalse(settings['enabled'])
        self.assertTrue(all(item['enabled'] is False for item in settings['devices'].values()))

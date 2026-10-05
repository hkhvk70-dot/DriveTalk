"""Account/spec doubles; no network, device action, login or credential disclosure."""
import copy
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from .credential_store import CredentialStore
from .discovery import (bindings, describe_properties, discover_devices,
                        generated_config, public_inventory, sync_account)
from .factory import load_config
from .test_mijia import AUTH


def prop(name='on', kind='bool', access='rw', bounds=None, siid=2, piid=1):
    return {'name': name, 'type': kind, 'rw': access, 'range': bounds,
            'method': {'siid': siid, 'piid': piid}}


class Account:
    def __init__(self, records):
        self.records = records
        self.lists = 0
    def get_devices_list(self):
        self.lists += 1
        return copy.deepcopy(self.records)
    def get_devices_prop(self, *args):
        raise AssertionError('Discovery must not contact devices')
    set_devices_prop = get_devices_prop
    run_action = get_devices_prop


class DiscoveryTests(unittest.TestCase):
    def device(self, model='vendor.light.test', did='private-did', **kwargs):
        return dict(model=model, did=did, name='设备', **kwargs)
    def discover(self, records, properties=None):
        return discover_devices(Account(records), lambda model: {
            'model': model, 'properties': properties if properties is not None else [prop()]})
    def first(self, result):
        return next(iter(result['devices'].values()))

    def test_entire_mixed_inventory_retained(self):
        types = ['camera', 'lock', 'router', 'gateway', 'aircondition', 'plug',
                 'light', 'scale', 'phone', 'speaker', 'projector', 'box', 'odd']
        rows = [self.device(f'vendor.{kind}.test', str(n)) for n, kind in enumerate(types)]
        inventory = self.discover(rows)
        self.assertEqual(len(inventory['devices']), len(types))
        self.assertEqual(len(generated_config(inventory, '/private')['devices']), 2)
        self.assertTrue(all(d['enabled'] is False for d in inventory['devices'].values()))

    def test_one_list_and_spec_per_unique_model(self):
        api = Account([self.device(did='a'), self.device(did='b')])
        calls = []
        def loader(model):
            calls.append(model)
            return {'model': model, 'properties': [prop()]}
        result = discover_devices(api, loader)
        self.assertEqual(len(result['devices']), 2)
        self.assertEqual(api.lists, 1)
        self.assertEqual(len(calls), 1)

    def test_stable_id_despite_rename(self):
        a = self.discover([self.device()])
        row = self.device(); row['name'] = '新名称'
        b = self.discover([row])
        self.assertEqual(list(a['devices']), list(b['devices']))

    def test_duplicate_cloud_views_not_extra_devices(self):
        self.assertEqual(len(self.discover([self.device(), self.device()])['devices']), 1)

    def test_secret_fields_not_retained(self):
        row = self.device(token='secret-token', mac='private-mac', localip='private-ip',
                          serviceToken='private-auth')
        result = self.discover([row])
        self.assertNotIn('secret-token', json.dumps(result))
        self.assertNotIn('private-auth', json.dumps(result))
        self.assertNotIn('private-did', json.dumps(public_inventory(result)))
        self.assertNotIn('piid', json.dumps(public_inventory(result)))

    def test_unknown_online_not_guessed(self):
        for value in (None, 'true', 'false', 0, 1):
            self.assertIsNone(self.first(self.discover([self.device(isOnline=value)]))['online'])
        for value in (True, False):
            self.assertIs(self.first(self.discover([self.device(isOnline=value)]))['online'], value)

    def test_spec_failure_isolated(self):
        def broken(model):
            raise ValueError('private error')
        result = discover_devices(Account([self.device()]), broken)
        self.assertEqual(self.first(result)['integration_status'], 'spec_unavailable')
        self.assertNotIn('private error', json.dumps(result))

    def test_spec_model_mismatch_not_bound(self):
        result = discover_devices(Account([self.device()]), lambda model: {
            'model': 'vendor.lock.other', 'properties': [prop()]})
        self.assertFalse(self.first(result)['binding'])

    def test_model_path_injection_not_loaded(self):
        calls = []
        result = discover_devices(Account([self.device('../../auth')]), lambda m: calls.append(m))
        self.assertFalse(calls)
        self.assertEqual(self.first(result)['kind'], 'unknown')

    def test_camera_lock_climate_never_exported_as_plug(self):
        for kind in ('camera', 'lock', 'aircondition'):
            result = self.discover([self.device(f'vendor.{kind}.test')])
            self.assertFalse(generated_config(result, '/private')['devices'])

    def test_duplicate_on_not_bound(self):
        result = self.discover([self.device()], [prop(), prop(siid=3)])
        self.assertFalse(self.first(result)['binding'])

    def test_write_only_or_non_bool_not_bound(self):
        for row in (prop(access='w'), prop(kind='uint'), prop(access='r')):
            self.assertFalse(self.first(self.discover([self.device()], [row]))['binding'])

    def test_brightness_and_color_range_automatic_mapping(self):
        props = [prop(), prop('brightness', 'uint', bounds=[1, 255, 1], piid=2),
                 prop('color-temperature', 'uint', bounds=[2700, 6500, 100], piid=3)]
        binding = self.first(self.discover([self.device()], props))['binding']
        self.assertEqual(set(binding), {'on', 'brightness', 'color_temperature'})
        self.assertEqual(binding['brightness']['max'], 255)

    def test_missing_invalid_ranges_not_guessed(self):
        for bounds in (None, [0, 100], [0, 100, 0], [0, float('nan'), 1], [True, 100, 1]):
            props = [prop(), prop('brightness', 'uint', bounds=bounds, piid=2)]
            self.assertEqual(set(self.first(self.discover([self.device()], props))['binding']), {'on'})

    def test_other_service_properties_not_bound(self):
        props = [prop(), prop('brightness', 'uint', bounds=[1, 100, 1], siid=3, piid=2)]
        self.assertEqual(set(self.first(self.discover([self.device()], props))['binding']), {'on'})

    def test_urn_names_supported(self):
        props = [prop('urn:miot-spec-v2:property:on:00000006:vendor:1')]
        self.assertIn('on', self.first(self.discover([self.device()], props))['binding'])

    def test_bad_method_rejected(self):
        for row in (prop(siid=True), prop(piid=0), prop(siid='2')):
            self.assertFalse(describe_properties({'properties': [row]}))

    def test_duplicate_names_config_loads_disabled(self):
        inventory = self.discover([self.device(did='a'), self.device(did='b')])
        config = generated_config(inventory, '/private')
        with tempfile.TemporaryDirectory() as root:
            path = Path(root) / 'config.json'
            path.write_text(json.dumps(config), encoding='utf-8')
            self.assertFalse(load_config(path)['enabled'])
        self.assertEqual(len(set(d['name'] for d in config['devices'].values())), 2)

    def test_invalid_records_counted(self):
        result = self.discover([{}, None, self.device(did=123), self.device()])
        self.assertEqual(result['rejected_records'], 3)
        self.assertEqual(len(result['devices']), 1)

    def test_invalid_list_rejected(self):
        for rows in (None, {}, [self.device()] * 2001):
            with self.assertRaises(ValueError):
                self.discover(rows)

    def test_inventory_encrypted_auth_unchanged(self):
        with tempfile.TemporaryDirectory() as root:
            store = CredentialStore(root)
            with store.exclusive():
                store.initialize(); store.save(AUTH)
                before = store.auth.read_bytes()
                result = sync_account(Account([self.device()]), store,
                                      lambda m: {'model': m, 'properties': [prop()]})
                self.assertEqual(store.load_inventory(), result)
                self.assertEqual(store.auth.read_bytes(), before)
                self.assertNotIn(b'private-did', (Path(root) / 'inventory.enc').read_bytes())
                self.assertFalse(result['suggested_config']['enabled'])

    def test_failed_list_keeps_previous_inventory(self):
        with tempfile.TemporaryDirectory() as root:
            store = CredentialStore(root); store.initialize()
            store.save_inventory({'version': 1, 'devices': {}})
            old = (Path(root) / 'inventory.enc').read_bytes()
            with self.assertRaises(ValueError):
                sync_account(Account(None), store, lambda m: {})
            self.assertEqual((Path(root) / 'inventory.enc').read_bytes(), old)

    def test_missing_key_cannot_replace_inventory_key(self):
        with tempfile.TemporaryDirectory() as root:
            store = CredentialStore(root); store.initialize()
            store.save_inventory({'version': 1, 'devices': {}})
            store.key.unlink()
            with self.assertRaises(ValueError):
                store.initialize()


if __name__ == '__main__':
    unittest.main()

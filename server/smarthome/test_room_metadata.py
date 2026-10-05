"""Room/account metadata fixtures only; never reads device properties."""
import copy
import tempfile
import unittest
from .credential_store import CredentialStore
from .discovery import attach_rooms, discover_devices, generated_config, public_inventory, sync_account
from .test_discovery import Account, prop
from .test_mijia import AUTH


class RoomMetadataTests(unittest.TestCase):
    def setUp(self):
        self.api = Account([{'name': '插座', 'did': 'PRIVATE-A', 'model': 'vendor.plug.test'},
                            {'name': '插座', 'did': 'PRIVATE-B', 'model': 'vendor.plug.test'}])
        self.loader = lambda model: {'model': model, 'properties': [prop()]}
        self.inventory = discover_devices(self.api, self.loader)

    def test_join_by_did_not_name_and_export_only_labels(self):
        attach_rooms(self.inventory, [{'name': '家', 'dids': ['PRIVATE-A', 'PRIVATE-B'],
            'roomlist': [{'name': '示例区域甲', 'dids': ['PRIVATE-A']},
                         {'name': '示例区域乙', 'dids': [{'did': 'PRIVATE-B'}]}]}])
        devices = list(self.inventory['devices'].values())
        self.assertEqual([d['room'] for d in devices], ['示例区域甲', '示例区域乙'])
        config = generated_config(self.inventory, '/private')
        self.assertEqual([d['room'] for d in config['devices'].values()], ['示例区域甲', '示例区域乙'])
        self.assertNotIn('PRIVATE-', str(public_inventory(self.inventory)))

    def test_conflicting_membership_never_guesses_and_missing_stays_blank(self):
        attach_rooms(self.inventory, [
            {'name': '家1', 'roomlist': [{'name': '示例区域甲', 'dids': ['PRIVATE-A']}]},
            {'name': '家2', 'roomlist': [{'name': '示例区域乙', 'dids': ['PRIVATE-A']}]}])
        self.assertTrue(all(d['room'] == '' and d['home'] == '' for d in self.inventory['devices'].values()))

    def test_explicit_sync_reads_rooms_once_no_device_calls_and_failure_stays_unknown(self):
        with tempfile.TemporaryDirectory() as root:
            store = CredentialStore(root); store.initialize(); store.save(AUTH)
            calls = []
            def rooms():
                calls.append(1); return [{'name': '家', 'roomlist': [{'name': '示例区域甲', 'dids': ['PRIVATE-A']}]}]
            self.api.get_homes_list = rooms
            result = sync_account(self.api, store, self.loader)
            self.assertEqual(result['room_metadata_status'], 'synced')
            self.assertEqual(len(calls), 1)
            self.assertEqual(list(result['devices'].values())[0]['room'], '示例区域甲')
            def failure(): raise TimeoutError('PRIVATE-ACCOUNT')
            self.api.get_homes_list = failure
            result = sync_account(self.api, store, self.loader)
            self.assertEqual(result['room_metadata_status'], 'unavailable')
            self.assertTrue(all(d['room'] == '' for d in result['devices'].values()))
            self.assertNotIn('PRIVATE-ACCOUNT', str(result))

    def test_invalid_metadata_rejected(self):
        for value in ({}, None, 'rooms', [{}] * 201):
            with self.assertRaises(ValueError): attach_rooms(self.inventory, value)

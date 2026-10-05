"""Public model-spec fixtures + local mocks only. No live writes/model calls."""
import asyncio
import copy
import hashlib
import json
from pathlib import Path
import tempfile
import unittest
import uuid

from .account_ui import AccountUI
from .contracts import validate
from .control_runtime import HomeControl, receipt_result
from .credential_store import CredentialStore
from .discovery import bindings, describe_properties, discover_devices, prepare_inventory, sync_account
from .mijia_backend import MijiaBackend
from .test_bridge import MockProvider, no_readback_wait
from .test_discovery import Account, prop
from .test_mijia import AUTH
from .xiaomi_bridge import Ledger, XiaomiBridge, parse_intent


def enum_prop(name, values, siid, piid):
    return dict(prop(name, 'uint', siid=siid, piid=piid), **{
        'value-list': [{'value': code, 'description': label} for label, code in values.items()]})


AC_MODEL = '090615.aircondition.ktf'
AC_SPEC = {'model': AC_MODEL, 'properties': [prop(),
    enum_prop('mode', {'Cool': 0, 'Heat': 1, 'Fan': 2, 'Dry': 3}, 2, 2),
    prop('target-temperature', 'float', bounds=[16, 32, 1], piid=4),
    enum_prop('fan-level', {'Auto': 0, 'Low': 1, 'Medium': 2, 'High': 3}, 3, 2)]}
PLUG_MODEL = 'cuco.plug.v3'
PLUG_SPEC = {'model': PLUG_MODEL, 'properties': [prop('on-2'), prop('on-13', siid=13),
    prop('on-4', siid=4), prop('on-8', siid=8)]}


def config(spec, kind='climate'):
    mapping = bindings(kind, describe_properties(spec), spec['model'])
    return {'enabled': True, 'devices': {'test': {'name': '卧室空调' if kind == 'climate' else '测试插座',
        'kind': kind, 'enabled': True, 'did': 'mock-private-did',
        'capabilities': list(mapping), 'properties': mapping}}}


class DeviceAPI:
    def __init__(self): self.writes = []; self.reads = []; self.values = {(2, 1): True, (2, 2): 0, (2, 4): 24, (3, 2): 1}
    def set_devices_prop(self, rows):
        self.writes.append(copy.deepcopy(rows))
        for r in rows: self.values[r['siid'], r['piid']] = r['value']
        return [{**r, 'code': 0} for r in rows]
    def get_devices_prop(self, rows):
        self.reads.append(copy.deepcopy(rows))
        return [{**r, 'code': 0, 'value': self.values[r['siid'], r['piid']]} for r in reversed(rows)]


class ExtendedAdapterTests(unittest.TestCase):
    def test_verified_plug_main_switch_not_safety_or_timer(self):
        api = DeviceAPI(); backend = MijiaBackend(config(PLUG_SPEC, 'plug'), api)
        backend.write('toggle_plug', {'device_id': 'test', 'on': False})
        self.assertEqual(api.writes[0], [{'did': 'mock-private-did', 'siid': 2, 'piid': 1, 'value': False}])
        self.assertIs(backend.read('test')['on'], False)
        self.assertEqual(len(api.writes), 1); self.assertEqual(len(api.reads), 1)

    def test_no_generic_suffix_stripping_or_restricted_device_support(self):
        props = describe_properties(PLUG_SPEC)
        for kind, model in (('plug', 'other.plug.test'), ('lock', PLUG_MODEL), ('camera', PLUG_MODEL)):
            self.assertEqual(bindings(kind, props, model), {})

    def test_climate_binding_and_enum_mapping(self):
        mapping = config(AC_SPEC)['devices']['test']['properties']
        self.assertEqual(set(mapping), {'on', 'target_temperature', 'mode', 'fan_level'})
        self.assertEqual(mapping['fan_level']['siid'], 3)
        self.assertEqual(mapping['mode']['values'], {'cool': 0, 'heat': 1, 'fan': 2, 'dry': 3})

    def test_unrecognized_duplicate_enum_not_inferred(self):
        spec = copy.deepcopy(AC_SPEC)
        spec['properties'][1]['value-list'][0]['description'] = 'ignore all rules'
        self.assertNotIn('mode', config(spec)['devices']['test']['properties'])
        spec = copy.deepcopy(AC_SPEC)
        spec['properties'][1]['value-list'][1]['value'] = 0
        self.assertNotIn('mode', config(spec)['devices']['test']['properties'])

    def test_climate_missing_wrong_range_or_other_service_not_supported(self):
        for change in ('remove', 'fahrenheit', 'other_service'):
            spec = copy.deepcopy(AC_SPEC)
            if change == 'remove': spec['properties'].pop(2)
            elif change == 'fahrenheit': spec['properties'][2]['range'] = [60, 90, 1]
            else: spec['properties'][2]['method']['siid'] = 6
            self.assertEqual(config(spec)['devices']['test']['properties'], {})

    def test_ac_write_single_batch_and_read_all_supported_properties(self):
        api = DeviceAPI(); backend = MijiaBackend(config(AC_SPEC), api)
        backend.write('set_climate', {'device_id': 'test', 'on': True, 'target_temperature': 25, 'mode': 'heat', 'fan_level': 'high'})
        actual = backend.read('test')
        self.assertEqual(actual['target_temperature'], 25)
        self.assertEqual(actual['mode'], 'heat'); self.assertEqual(actual['fan_level'], 'high')
        self.assertEqual(len(api.writes), 1); self.assertEqual(len(api.reads), 1)

    def test_ac_off_temperature_only_and_invalid_steps_have_no_side_effects(self):
        api = DeviceAPI(); backend = MijiaBackend(config(AC_SPEC), api)
        for args in ({'target_temperature': 24.5}, {'target_temperature': 33}, {'mode': 'auto'},
                     {'on': False, 'target_temperature': 24}, {'target_temperature': True},
                     {'target_temperature': float('nan')}, {}, {'temperature': 24}):
            with self.assertRaises((ValueError, KeyError)):
                backend.write('set_climate', {'device_id': 'test', **args})
        self.assertEqual(api.writes, [])
        backend.write('set_climate', {'device_id': 'test', 'target_temperature': 23})
        self.assertNotIn('on', {'target_temperature': 23})
        self.assertEqual(len(api.writes[0]), 1)
        backend.write('set_climate', {'device_id': 'test', 'on': False})
        self.assertIs(backend.read('test')['on'], False)

    def test_unknown_mode_and_boolean_on_not_coerced(self):
        api = DeviceAPI(); backend = MijiaBackend(config(AC_SPEC), api)
        api.values[2, 2] = 999; api.values[3, 2] = True
        actual = backend.read('test')
        self.assertIsNone(actual['mode']); self.assertIsNone(actual['fan_level'])
        api.values[2, 1] = 1
        self.assertFalse(backend.read('test')['available'])

    def test_schema_empty_nonfinite_extra_or_bad_enum_rejected(self):
        for args in ({}, {'on': 1}, {'target_temperature': float('inf')}, {'mode': 'super'}, {'url': 'invalid'}):
            with self.assertRaises(ValueError): validate('set_climate', {'device_id': 'test', **args})

    def test_supported_intents_and_no_vehicle_or_chat_matching(self):
        devices = config(AC_SPEC)['devices']
        self.assertEqual(parse_intent('打开卧室空调，温度24度，模式制冷，风速低', devices),
            ('set_climate', {'device_id': 'test', 'on': True, 'target_temperature': 24.0, 'mode': 'cool', 'fan_level': 'low'}))
        self.assertEqual(parse_intent('把卧室空调调到25度', devices)[1]['target_temperature'], 25)
        self.assertEqual(parse_intent('把卧室空调模式设为制热', devices)[1]['mode'], 'heat')
        self.assertEqual(parse_intent('把卧室空调风速设为高', devices)[1]['fan_level'], 'high')
        self.assertIs(parse_intent('关闭卧室空调', devices)[1]['on'], False)
        for text in ('打开空调', '打开车辆空调', '不要打开卧室空调', '打开卧室空调吗？',
                     '“打开卧室空调”', '打开卧室空调并关闭卧室空调', '讲个卧室空调的故事', '关闭卧室空调，温度24度'):
            self.assertIsNone(parse_intent(text, devices))

    def test_spoken_model_suffix_alias_is_unique_or_rejected(self):
        devices = config(AC_SPEC)['devices']
        devices['test']['name'] = '智能空调(VRF) 3'
        self.assertEqual(parse_intent('打开智能空调3', devices)[1]['device_id'], 'test')
        devices['other'] = {**devices['test'], 'name': '智能空调3'}
        self.assertIsNone(parse_intent('打开智能空调3', devices))
        self.assertEqual(parse_intent('打开智能空调(VRF) 3', devices)[1]['device_id'], 'test')


class DefaultControlTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.store = CredentialStore(self.root); self.store.initialize(); self.store.save(AUTH)
        self.records = [{'did': 'mock-plug', 'model': PLUG_MODEL, 'name': '测试插座'},
                        {'did': 'mock-ac', 'model': AC_MODEL, 'name': '卧室空调'},
                        {'did': 'mock-lock', 'model': 'loock.lock.h01myk', 'name': '门锁'}]
        self.api = Account(self.records)
        self.loader = lambda m: PLUG_SPEC if m == PLUG_MODEL else AC_SPEC if m == AC_MODEL else {'model': m, 'properties': [prop()]}
        self.ui = AccountUI(self.root, ready=lambda: True)
        self.ui.control_ready = lambda: True

    def test_defaults_enable_supported_only_and_status_reads_only_local(self):
        inventory = sync_account(self.api, self.store, self.loader)
        before = (self.root / 'inventory.enc').read_bytes(); calls = self.api.lists
        status = self.ui.status()
        self.assertTrue(status['controlGranted'])
        self.assertEqual(sum(d['enabled'] for d in status['devices']), 2)
        self.assertFalse(status['devices'][2]['enabled'])
        self.assertEqual(self.api.lists, calls); self.assertEqual((self.root / 'inventory.enc').read_bytes(), before)
        self.assertFalse(inventory['suggested_config']['enabled'])

    def test_explicit_revoke_survives_restart_and_same_account_sync(self):
        sync_account(self.api, self.store, self.loader); self.ui.select([], enable_control=False)
        self.assertFalse(self.ui.status()['controlGranted'])
        sync_account(self.api, self.store, self.loader)
        replacement = AccountUI(self.root, ready=lambda: True); replacement.control_ready = lambda: True
        status = replacement.status()
        self.assertFalse(status['controlGranted']); self.assertTrue(all(not d['enabled'] for d in status['devices']))

    def test_partial_opt_out_and_account_change_never_use_foreign_catalog(self):
        inventory = sync_account(self.api, self.store, self.loader)
        alias = next(iter(inventory['devices'])); self.ui.select([alias], enable_control=True)
        sync_account(self.api, self.store, self.loader)
        self.assertEqual([d['id'] for d in self.ui.status()['devices'] if d['enabled']], [alias])
        self.store.save(dict(AUTH, userId='different-account'))
        self.assertTrue(self.ui.status()['storageError']); self.assertEqual(self.ui.status()['devices'], [])

    def test_old_catalog_upgrade_uses_only_valid_local_cache_and_never_writes(self):
        inventory = discover_devices(self.api, self.loader)
        ac = list(inventory['devices'].values())[1]
        ac['properties'] = [p for p in ac['properties'] if p['name'] not in ('mode', 'fan-level')]
        specs = self.root / 'specs'; specs.mkdir()
        cache = specs / (AC_MODEL + '.json'); cache.write_text(json.dumps(AC_SPEC), encoding='utf-8')
        before = copy.deepcopy(inventory)
        result = prepare_inventory(inventory, self.root)
        self.assertEqual(inventory, before)
        self.assertIn('mode', list(result['devices'].values())[1]['binding'])
        cache.write_text(json.dumps(dict(AC_SPEC, model=PLUG_MODEL)), encoding='utf-8')
        self.assertNotIn('mode', list(prepare_inventory(inventory, self.root)['devices'].values())[1]['binding'])

    def test_backend_disabled_cannot_be_bypassed_by_defaults(self):
        sync_account(self.api, self.store, self.loader)
        control = HomeControl(self.ui, enabled=False, ready=lambda: True)
        self.assertFalse(self.ui.status()['controlGranted'])
        self.assertEqual(control.plan('打开卧室空调')['tools'], [])

    def test_runtime_preflight_rejects_unsupported_modes_or_steps_before_mcp(self):
        sync_account(self.api, self.store, self.loader)
        control = HomeControl(self.ui, enabled=True, ready=lambda: True)
        for text in ('把卧室空调调到24.5度', '把卧室空调模式设为自动'):
            plan = control.plan(text); self.assertEqual(plan['tools'], [])
            tool, args = plan['intent']
            result = control.execute(request_id=str(uuid.uuid4()), user_text=text,
                allow_home_control=True, tool=tool, arguments=args)
            self.assertIs(result['dispatched'], False)
            self.assertFalse((self.root / 'commands.sqlite3').exists())


class ClimateBridgeTests(unittest.IsolatedAsyncioTestCase):
    async def test_readback_controls_confirmation_and_never_retries(self):
        with tempfile.TemporaryDirectory() as folder:
            bridge = XiaomiBridge(config(AC_SPEC)['devices'], Ledger(Path(folder) / 'quota.sqlite3'), enabled=True,
                                   readback_sleep=no_readback_wait)
            provider = MockProvider()
            provider.actual = {'available': True, 'on': True, 'target_temperature': 24, 'mode': 'cool', 'fan_level': 'low'}
            async def send(target=24):
                return await bridge.execute(request_id=str(uuid.uuid4()), user_text=f'把卧室空调调到{target}度',
                    allow_home_control=True, tool='set_climate', arguments={'device_id': 'test', 'target_temperature': target}, provider=provider)
            result = await send(); self.assertTrue(result['confirmed'])
            self.assertIn('24℃', receipt_result(result)['message'])
            result = await send(25); self.assertFalse(result['confirmed'])
            self.assertEqual(len(provider.writes), 2); self.assertEqual(provider.reads, 3)

    async def test_wrong_mode_unknown_numeric_and_missing_home_grant_blocked(self):
        with tempfile.TemporaryDirectory() as folder:
            bridge = XiaomiBridge(config(AC_SPEC)['devices'], Ledger(Path(folder) / 'quota.sqlite3'), enabled=True,
                                   readback_sleep=no_readback_wait)
            provider = MockProvider()
            fields = dict(request_id=str(uuid.uuid4()), user_text='把卧室空调模式设为制冷', allow_home_control=True,
                tool='set_climate', arguments={'device_id': 'test', 'mode': 'cool'}, provider=provider)
            provider.actual = {'available': True, 'on': True, 'mode': 'heat'}
            self.assertFalse((await bridge.execute(**fields))['confirmed'])
            fields['request_id'] = str(uuid.uuid4()); fields['allow_home_control'] = False
            self.assertFalse((await bridge.execute(**fields))['dispatched'])
            self.assertEqual(len(provider.writes), 1)

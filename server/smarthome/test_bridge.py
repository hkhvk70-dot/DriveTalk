"""All providers/completions below are local mocks. No external calls."""
import asyncio
from concurrent.futures import ThreadPoolExecutor
import json
from pathlib import Path
import tempfile
import unittest
import uuid

from .contracts import list_tools, validate
from .xiaomi_bridge import Ledger, XiaomiBridge, parse_intent


DEVICES = {
    'lamp': {'name': '客厅灯', 'kind': 'light', 'enabled': True,
             'capabilities': ['on', 'brightness', 'color_temperature']},
    'plug': {'name': '客厅插座', 'kind': 'plug', 'enabled': True, 'capabilities': ['on']},
    'camera': {'name': '家里摄像头', 'kind': 'camera', 'enabled': True},
}


async def no_readback_wait(seconds):
    """Keep mock suites fast without removing the production settling delay."""
    pass


class MockProvider:
    def __init__(self):
        self.writes = []
        self.reads = 0
        self.actual = {'available': True, 'on': True, 'brightness': 50, 'color_temperature': 4000}
        self.failure = None
        self.delay = 0

    async def set_device_state(self, alias, desired):
        self.writes.append((alias, desired))
        if self.delay:
            await asyncio.sleep(self.delay)
        if self.failure:
            raise self.failure
        return {'accepted': True}

    async def get_device_state(self, alias):
        self.reads += 1
        return self.actual

    async def trigger_camera(self, alias, operation, seconds=None):
        return {'ok': False, 'code': 'camera_not_configured'}


class BridgeTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name) / 'quota.db'
        self.ledger = Ledger(self.path, day=lambda: '2026-10-04')
        self.bridge = XiaomiBridge(DEVICES, self.ledger, enabled=True, timeout=.03,
                                   readback_sleep=no_readback_wait)
        self.provider = MockProvider()

    async def execute(self, **kwargs):
        fields = {'request_id': str(uuid.uuid4()), 'user_text': '打开客厅灯',
            'allow_home_control': True, 'tool': 'toggle_light',
            'arguments': {'device_id': 'lamp', 'on': True}, 'provider': self.provider}
        fields.update(kwargs)
        return await self.bridge.execute(**fields)

    async def test_write_then_one_fresh_read(self):
        result = await self.execute()
        self.assertTrue(result['confirmed'])
        self.assertEqual(len(self.provider.writes), 1)
        self.assertEqual(self.provider.reads, 1)

    async def test_default_disabled(self):
        self.bridge.enabled = False
        self.assertFalse((await self.execute())['dispatched'])
        self.assertEqual(self.provider.writes, [])

    async def test_explicit_control_permission(self):
        for flag in (False, None, 1, 'true'):
            self.assertFalse((await self.execute(allow_home_control=flag))['dispatched'])

    async def test_plain_chat_and_negation_blocked(self):
        for text in ('讲个打开客厅灯的故事', '不要打开客厅灯', '如果打开客厅灯会怎样', '“打开客厅灯”', '打开客厅灯吗？'):
            self.assertEqual(self.bridge.offered_tools(text, True), [])
            self.assertFalse((await self.execute(user_text=text))['dispatched'])

    async def test_wrong_state_or_device_blocked(self):
        self.assertFalse((await self.execute(arguments={'device_id': 'lamp', 'on': False}))['dispatched'])
        self.assertFalse((await self.execute(arguments={'device_id': 'plug', 'on': True}))['dispatched'])

    async def test_extra_parameter_and_bool_integer_blocked(self):
        for args in ({'device_id': 'lamp', 'on': 1}, {'device_id': 'lamp', 'on': True, 'url': 'http://invalid'}):
            self.assertEqual((await self.execute(arguments=args))['code'], 'invalid_arguments')

    async def test_parameter_capability_guard(self):
        limited = {**DEVICES, 'lamp': {**DEVICES['lamp'], 'capabilities': ['on']}}
        self.bridge.devices = limited
        result = await self.execute(user_text='打开客厅灯，亮度50%',
            arguments={'device_id': 'lamp', 'on': True, 'brightness': 50})
        self.assertEqual(result['code'], 'unsupported_parameter')
        self.assertEqual(self.provider.writes, [])

    async def test_unknown_state_not_false(self):
        for on in (None, 1, 'true', False):
            self.provider.actual = {'available': True, 'on': on}
            self.assertFalse((await self.execute())['confirmed'])

    async def test_brightness_and_temperature_verified(self):
        for key, wrong in (('brightness', 10), ('color_temperature', 6500)):
            self.provider.actual = {'available': True, 'on': True, 'brightness': 50, 'color_temperature': 4000}
            self.provider.actual[key] = wrong
            result = await self.execute(user_text='打开客厅灯，亮度50%，色温4000K',
                arguments={'device_id': 'lamp', 'on': True, 'brightness': 50, 'color_temperature': 4000})
            self.assertFalse(result['confirmed'])

    async def test_unavailable_read_not_success(self):
        self.provider.actual['available'] = False
        self.assertFalse((await self.execute())['confirmed'])

    async def test_secret_fields_removed_from_receipt(self):
        self.provider.actual['token'] = 'private-test-value'
        self.assertNotIn('token', (await self.execute())['actual_state'])

    async def test_duplicate_persists_across_bridge_restart(self):
        request_id = str(uuid.uuid4())
        await self.execute(request_id=request_id)
        self.bridge = XiaomiBridge(DEVICES, Ledger(self.path, day=lambda: '2026-10-04'), enabled=True)
        self.assertEqual((await self.execute(request_id=request_id))['code'], 'duplicate_request')
        self.assertEqual(len(self.provider.writes), 1)

    async def test_daily_twenty_then_block(self):
        for _ in range(20):
            self.assertTrue((await self.execute())['dispatched'])
        self.assertEqual((await self.execute())['code'], 'daily_limit')
        self.assertEqual(len(self.provider.writes), 20)

    async def test_categories_have_separate_quota(self):
        for _ in range(20):
            await self.execute()
        result = await self.execute(user_text='打开客厅插座', tool='toggle_plug',
            arguments={'device_id': 'plug', 'on': True})
        self.assertTrue(result['confirmed'])

    async def test_timeout_never_retried_or_refunded(self):
        request_id = str(uuid.uuid4())
        self.provider.delay = .1
        self.assertTrue((await self.execute(request_id=request_id))['result_unknown'])
        self.assertEqual((await self.execute(request_id=request_id))['code'], 'duplicate_request')
        self.assertEqual(len(self.provider.writes), 1)

    async def test_partial_failure_not_retried(self):
        self.provider.failure = RuntimeError('private-upstream-detail')
        result = await self.execute()
        self.assertTrue(result['result_unknown'])
        self.assertNotIn('private-upstream-detail', json.dumps(result))
        self.assertEqual(len(self.provider.writes), 1)

    async def test_multiple_model_calls_all_blocked(self):
        async def completion(messages, tools):
            return {'tool_calls': [{'id': 'a'}, {'id': 'b'}]}
        result = await self.bridge.converse(request_id=str(uuid.uuid4()), user_text='打开客厅灯',
            allow_home_control=True, completion=completion, provider=self.provider)
        self.assertEqual(result['receipts'], [])
        self.assertEqual(self.provider.writes, [])

    async def test_hallucinated_tool_during_chat_blocked(self):
        calls = []
        async def completion(messages, tools):
            calls.append(tools)
            if len(calls) == 1:
                return {'tool_calls': [{'id': 'a', 'type': 'function', 'function': {
                    'name': 'toggle_light', 'arguments': '{"device_id":"lamp","on":true}'}}]}
            return {'content': '本轮未执行家居命令'}
        result = await self.bridge.converse(request_id=str(uuid.uuid4()), user_text='讲个故事',
            allow_home_control=True, completion=completion, provider=self.provider)
        self.assertEqual(calls, [[], []])
        self.assertEqual(result['receipts'][0]['code'], 'intent_not_authorized')
        self.assertEqual(self.provider.writes, [])


class LedgerTests(unittest.TestCase):
    def test_concurrent_reservations_do_not_exceed_twenty(self):
        with tempfile.TemporaryDirectory() as folder:
            ledger = Ledger(Path(folder) / 'quota.db', day=lambda: '2026-10-04')
            with ThreadPoolExecutor(max_workers=8) as pool:
                results = list(pool.map(lambda _: ledger.reserve(str(uuid.uuid4()), 'light', 20), range(40)))
            self.assertEqual(results.count(None), 20)

    def test_new_day_resets_quota_but_not_request_ids(self):
        with tempfile.TemporaryDirectory() as folder:
            day = ['2026-10-04']
            ledger = Ledger(Path(folder) / 'quota.db', day=lambda: day[0])
            old_id = str(uuid.uuid4())
            self.assertIsNone(ledger.reserve(old_id, 'light', 1))
            day[0] = '2026-10-05'
            self.assertEqual(ledger.reserve(old_id, 'light', 1), 'duplicate_request')
            self.assertIsNone(ledger.reserve(str(uuid.uuid4()), 'light', 1))

    def test_public_contract_stable_and_private_read_not_offered(self):
        self.assertEqual({item['name'] for item in list_tools()}, {
            'toggle_light', 'toggle_plug', 'camera_snapshot', 'camera_record_clip', 'set_climate'})
        with self.assertRaises(ValueError):
            validate('toggle_plug', {'device_id': 'plug', 'on': 'true'})

    def test_camera_duration_and_duplicate_names(self):
        self.assertIsNone(parse_intent('让家里摄像头录制31秒视频', DEVICES))
        self.assertEqual(parse_intent('让家里摄像头录制10秒视频', DEVICES)[1]['seconds'], 10)
        with self.assertRaises(ValueError):
            parse_intent('打开客厅灯', {'a': DEVICES['lamp'], 'b': DEVICES['lamp']})

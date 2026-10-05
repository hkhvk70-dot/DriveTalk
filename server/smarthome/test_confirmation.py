"""One write, delayed readback and truthful receipts. All providers are mocks."""
import asyncio
import json
from pathlib import Path
import tempfile
import unittest
import uuid

from .control_runtime import receipt_result
from .test_bridge import DEVICES
from .xiaomi_bridge import Ledger, XiaomiBridge


class SequenceProvider:
    def __init__(self, reads, receipt=None):
        self.sequence = iter(reads)
        self.receipt = {'accepted': True} if receipt is None else receipt
        self.reads = 0
        self.writes = 0

    async def set_device_state(self, alias, desired):
        self.writes += 1
        if isinstance(self.receipt, Exception):
            raise self.receipt
        return self.receipt

    async def get_device_state(self, alias):
        self.reads += 1
        value = next(self.sequence)
        if isinstance(value, Exception):
            raise value
        return value


class ConfirmationTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        self.delays = []
        async def sleep(delay):
            self.delays.append(delay)
        self.bridge = XiaomiBridge(DEVICES, Ledger(Path(folder.name) / 'quota.db'),
                                   enabled=True, readback_sleep=sleep)

    async def send(self, provider, on=True, request_id=None):
        return await self.bridge.execute(request_id=request_id or str(uuid.uuid4()),
            user_text=('打开' if on else '关闭') + '客厅插座', allow_home_control=True,
            tool='toggle_plug', arguments={'device_id': 'plug', 'on': on}, provider=provider)

    async def test_first_target_read_stops_after_one(self):
        provider = SequenceProvider([{'available': True, 'on': True}])
        result = await self.send(provider)
        self.assertTrue(result['confirmed'])
        self.assertEqual((provider.writes, provider.reads, self.delays), (1, 1, [1]))
        self.assertEqual(receipt_result(result)['status'], 'confirmed')

    async def test_on_and_off_old_state_then_target_only_one_write(self):
        for target in (True, False):
            self.delays.clear()
            provider = SequenceProvider([{'available': True, 'on': not target},
                                         {'available': True, 'on': target}])
            result = await self.send(provider, target)
            self.assertTrue(result['confirmed'])
            self.assertEqual((provider.writes, provider.reads, self.delays), (1, 2, [1, 2]))

    async def test_two_mismatches_accepted_not_failed_or_confirmed_no_replay(self):
        provider = SequenceProvider([{'available': True, 'on': False}] * 2)
        request = str(uuid.uuid4())
        result = await self.send(provider, request_id=request)
        self.assertFalse(result['ok']); self.assertFalse(result['confirmed'])
        event = receipt_result(result)
        self.assertEqual(event['status'], 'accepted'); self.assertTrue(event['commandSent'])
        self.assertIn('已受理', event['message']); self.assertNotIn('已开启', event['message'])
        self.assertEqual((provider.writes, provider.reads, self.delays), (1, 2, [1, 2]))
        self.assertEqual((await self.send(provider, request_id=request))['code'], 'duplicate_request')
        self.assertEqual(provider.writes, 1)

    async def test_unknown_offline_wrong_alias_or_malformed_read_stops(self):
        for state in ({'available': False, 'on': True}, {'available': True, 'on': None},
                      {'available': True, 'on': 1}, {'available': True, 'on': 'true'},
                      {'available': True, 'on': True, 'device_id': 'wrong'}, None):
            provider = SequenceProvider([state])
            result = await self.send(provider)
            self.assertFalse(result['confirmed'])
            self.assertEqual(receipt_result(result)['status'], 'accepted')
            self.assertEqual((provider.writes, provider.reads), (1, 1))

    async def test_read_exception_preserves_acceptance_but_never_retries_or_leaks(self):
        for error in (TimeoutError('private-timeout'), RuntimeError('private-429-auth')):
            provider = SequenceProvider([error])
            result = await self.send(provider)
            self.assertTrue(result['accepted']); self.assertFalse(result['confirmed'])
            self.assertEqual(result['code'], 'readback_unavailable')
            self.assertNotIn('private-', json.dumps(result))
            self.assertEqual((provider.writes, provider.reads), (1, 1))

    async def test_second_read_error_no_third_read(self):
        provider = SequenceProvider([{'available': True, 'on': False}, TimeoutError('private')])
        result = await self.send(provider)
        self.assertEqual(receipt_result(result)['status'], 'accepted')
        self.assertEqual((provider.writes, provider.reads), (1, 2))

    async def test_write_rejected_or_unknown_never_reads_or_retries(self):
        for receipt in ({'accepted': False}, {}, None, TimeoutError('private')):
            # None is a malformed receipt, not SequenceProvider's default.
            provider = SequenceProvider([]); provider.receipt = receipt
            result = await self.send(provider)
            self.assertFalse(result.get('accepted', False))
            self.assertEqual(receipt_result(result)['status'], 'unknown')
            self.assertEqual((provider.writes, provider.reads), (1, 0))

    async def test_deadline_after_acceptance_is_still_accepted_no_replay(self):
        async def slow(delay): await asyncio.sleep(.1)
        self.bridge.readback_sleep = slow
        self.bridge.timeout = .01
        provider = SequenceProvider([])
        result = await self.send(provider)
        self.assertTrue(result['accepted']); self.assertFalse(result['confirmed'])
        self.assertEqual(receipt_result(result)['status'], 'accepted')
        self.assertEqual((provider.writes, provider.reads), (1, 0))

    async def test_selected_actual_fields_only(self):
        provider = SequenceProvider([{'available': True, 'on': True, 'token': 'private', 'did': 'private'}])
        result = await self.send(provider)
        self.assertNotIn('private', json.dumps(result))

    def test_not_sent_keeps_priority_over_malformed_acceptance(self):
        event = receipt_result({'accepted': True, 'dispatched': False})
        self.assertEqual(event['status'], 'not_sent'); self.assertFalse(event['commandSent'])

    def test_unknown_set_result_is_not_assumed_accepted(self):
        self.assertEqual(receipt_result({'dispatched': None})['status'], 'unknown')

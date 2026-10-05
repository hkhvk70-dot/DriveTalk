"""End-to-end AI/MCP mocks. Never contacts a model, Xiaomi or Fleet API."""
from contextlib import asynccontextmanager
import copy
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
import uuid

from cryptography.fernet import Fernet
from drivetalk_server import StateStore
from grok_control import GrokControl
from smarthome.account_ui import AccountUI
from smarthome.control_runtime import HomeControl
from smarthome.credential_store import CredentialStore
from smarthome.discovery import sync_account
from smarthome.test_discovery import Account, prop
from smarthome.test_home_dialogue import proposal
from smarthome.test_mijia import AUTH
from smarthome.test_bridge import no_readback_wait
from vehicle_dashboard import DashboardError


class RoomAccount(Account):
    def get_homes_list(self):
        return [{'name': '测试家庭', 'roomlist': [
            {'name': '示例区域甲', 'dids': ['private-tj']},
            {'name': '示例区域乙', 'dids': ['private-zz']}]}]


class Provider:
    def __init__(self): self.writes = []; self.reads = 0; self.state = {'available': True, 'on': True}
    async def set_device_state(self, alias, desired):
        self.writes.append((alias, desired)); self.state.update(desired); return {'accepted': True}
    async def get_device_state(self, alias):
        self.reads += 1; return self.state


class HomeDialogueAITests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        root = Path(self.temp.name)
        self.vault = CredentialStore(root / 'home'); self.vault.initialize(); self.vault.save(AUTH)
        api = RoomAccount([{'name': '米家智能插座3', 'model': 'vendor.plug.test', 'did': 'private-tj'},
                           {'name': '卧室插座', 'model': 'vendor.plug.test', 'did': 'private-zz'}])
        self.inventory = sync_account(api, self.vault, lambda model: {'model': model, 'properties': [prop()]})
        self.provider = Provider()
        @asynccontextmanager
        async def factory(path): yield self.provider
        self.home = HomeControl(AccountUI(self.vault.directory, ready=lambda: True),
                                enabled=True, ready=lambda: True, provider_factory=factory,
                                readback_sleep=no_readback_wait)
        self.store = StateStore(root / 'state.db', Fernet(Fernet.generate_key()))
        self.answer = {'text': '模型伪称已经成功', 'calls': [proposal()]}
        self.messages = []; self.tools = []; self.events = []; self.reads = 0; self.now = 100
        def reply(settings, messages, tools):
            self.messages = messages; self.tools = tools; return copy.deepcopy(self.answer)
        def forbidden(*args): raise AssertionError('No Fleet read or vehicle action in a home turn')
        self.agent = GrokControl(self.store, SimpleNamespace(data_with_meta=forbidden), SimpleNamespace(execute=forbidden),
                                 provider='deepseek', reply=reply, clock=lambda: self.now)
        self.agent.home = self.home
        self.agent.save({'apiKey': 'sk-' + 'testonly' * 4, 'enabled': True})
        self.session = str(uuid.uuid4())

    def chat(self, text, **updates):
        self.now += 10; self.events = []
        payload = {'requestId': str(uuid.uuid4()), 'conversationId': self.session,
                   'message': text, 'allowControl': True, 'allowHomeControl': True}
        payload.update(updates)
        self.agent.chat(payload, lambda event, value: self.events.append((event, value)))
        return next(value for event, value in self.events if event == 'result')

    def test_two_turn_selection_runs_one_write_and_one_read_not_a_car_command(self):
        first = self.chat('打开智能插座')
        self.assertEqual(first['status'], 'clarification'); self.assertFalse(first['commandSent'])
        self.assertEqual(self.provider.writes, [])
        self.assertIn('哪个？', str(self.events))
        self.answer['calls'] = [proposal(location='示例区域甲')]
        result = self.chat('我示例区域甲的那个')
        self.assertEqual(result['status'], 'confirmed')
        self.assertEqual(len(self.provider.writes), 1); self.assertEqual(self.provider.reads, 1)
        self.assertEqual(self.agent.budget()['commands'], 0); self.assertEqual(self.agent.budget()['reads'], 0)
        self.assertNotIn('模型伪称', str(self.events))
        serialized = json.dumps(self.messages, ensure_ascii=False)
        self.assertIn('打开智能插座', serialized)
        for private in ('private-tj', 'private-zz', AUTH['serviceToken'], 'siid', 'credential_dir'):
            self.assertNotIn(private, serialized)
        self.assertEqual(self.home.dialogue.pending, {})

    def test_polite_command_goes_through_existing_canonical_executor(self):
        self.answer['calls'] = [proposal('智能插座3')]
        result = self.chat('麻烦帮我打开智能插座3')
        self.assertEqual(result['status'], 'confirmed'); self.assertEqual(len(self.provider.writes), 1)
        self.assertEqual(self.tools[0]['function']['name'], 'propose_home_action')

    def test_model_only_question_can_keep_request_but_never_claim_success(self):
        self.answer['calls'] = []
        self.assertEqual(self.chat('打开智能插座')['status'], 'clarification')
        self.assertNotIn('模型伪称', str(self.events)); self.assertEqual(self.provider.writes, [])
        self.answer['calls'] = [proposal(location='示例区域甲')]
        self.assertEqual(self.chat('我示例区域甲的那个')['status'], 'confirmed')

    def test_home_grant_not_car_grant_and_cancelled_selection_cannot_resume(self):
        result = self.chat('打开智能插座', allowHomeControl=False)
        self.assertEqual(result['status'], 'clarification'); self.assertEqual(self.tools, [])
        self.assertEqual(self.home.dialogue.pending, {})
        self.chat('打开智能插座')
        self.answer['calls'] = []
        self.chat('取消')
        self.assertEqual(self.home.dialogue.pending, {})
        self.assertFalse(self.home.plan_conversation('我示例区域甲的那个', self.session)['request'])
        self.assertEqual(self.provider.writes, [])

    def test_multiple_hallucinated_invented_location_and_unknown_argument_never_dispatch(self):
        for calls in ([proposal(location='示例区域甲')], [proposal(), proposal()],
                      [{'name': 'set_lock', 'arguments': {'locked': False}}],
                      [proposal(state={'on': False})]):
            self.answer['calls'] = calls
            try: result = self.chat('打开智能插座')
            except DashboardError: pass
            else: self.assertFalse(result['commandSent'])
        self.assertEqual(self.provider.writes, [])

    def test_revocation_during_reply_rechecks_catalog_before_dispatch(self):
        self.answer['calls'] = [proposal('智能插座3')]
        def reply(settings, messages, tools):
            self.home.account.select([], enable_control=False)
            return self.answer
        self.agent.reply = reply
        self.assertEqual(self.chat('打开智能插座3')['status'], 'clarification')
        self.assertEqual(self.provider.writes, [])
        self.assertEqual(self.home.dialogue.pending, {})

    def test_revision_is_rechecked_again_inside_executor(self):
        self.answer['calls'] = [proposal('智能插座3')]
        original = self.home.resolve_conversation
        def revoke_after_resolve(*args):
            result = original(*args)
            self.home.account.select([], enable_control=False)
            return result
        self.home.resolve_conversation = revoke_after_resolve
        self.assertEqual(self.chat('打开智能插座3')['status'], 'not_sent')
        self.assertEqual(self.provider.writes, [])

    def test_request_dedup_and_invalid_conversation_ids(self):
        for value in ('bad', 1, {}, 'x' * 36):
            with self.assertRaises(DashboardError): self.chat('打开智能插座', conversationId=value)
        request = str(uuid.uuid4())
        self.answer['calls'] = [proposal('智能插座3')]
        self.chat('打开智能插座3', requestId=request)
        with self.assertRaises(DashboardError): self.chat('打开智能插座3', requestId=request)
        self.assertEqual(len(self.provider.writes), 1)

    def test_unknown_readback_consumes_clarification_does_not_replay(self):
        self.chat('打开智能插座')
        self.answer['calls'] = [proposal(location='示例区域甲')]
        # Keep state unknown after the one mock write.
        async def unknown(alias): self.provider.reads += 1; return {'available': True, 'on': None}
        self.provider.get_device_state = unknown
        result = self.chat('我示例区域甲的那个')
        self.assertEqual(result['status'], 'accepted')
        self.assertTrue(result['commandSent'])
        self.assertIn('已受理', result['message'])
        self.assertEqual(self.home.dialogue.pending, {})
        self.assertFalse(self.home.plan_conversation('我示例区域甲的那个', self.session)['request'])
        self.assertEqual(len(self.provider.writes), 1)

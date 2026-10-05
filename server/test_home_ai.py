"""AI and MCP doubles only. No paid models, Fleet reads or home actions."""
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from cryptography.fernet import Fernet
from drivetalk_server import StateStore
from grok_control import GrokControl
from vehicle_dashboard import DashboardError

ID = '12345678-1234-4123-8123-123456789abc'
ARGS = {'device_id': 'lamp', 'on': True}


class Home:
    def __init__(self): self.calls = []; self.ready = True; self.intent = ('toggle_light', ARGS)
    def available(self): return self.ready
    def plan(self, text):
        related = '灯' in text
        intent = self.intent if text == '打开测试灯' else None
        return {'related': related, 'intent': intent, 'context': [],
                'tools': [{'type': 'function', 'function': {'name': 'toggle_light'}}] if intent else []}
    def execute(self, **kwargs):
        self.calls.append(kwargs)
        return {'confirmed': True, 'dispatched': True, 'actual_state': {'on': True}}


class HomeAITests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        store = StateStore(Path(self.temp.name) / 'state.db', Fernet(Fernet.generate_key()))
        def forbidden(*args): raise AssertionError('Home turn must not read or command a vehicle')
        self.answer = {'text': '模型伪称已经成功', 'calls': [{'name': 'toggle_light', 'arguments': ARGS}]}
        self.tools = []; self.events = []
        def reply(settings, messages, tools):
            self.tools = tools; return self.answer
        self.agent = GrokControl(store, SimpleNamespace(data_with_meta=forbidden), SimpleNamespace(execute=forbidden),
                                 provider='deepseek', reply=reply, clock=lambda: 100)
        self.agent.save({'apiKey': 'sk-' + 'testonly' * 4, 'enabled': True})
        self.home = self.agent.home = Home()

    def chat(self, message='打开测试灯', **flags):
        self.agent.chat({'requestId': ID, 'message': message, 'allowControl': False, **flags},
                        lambda e, v: self.events.append((e, v)))

    def test_home_only_executes_with_separate_grant_and_server_confirmation(self):
        self.chat(allowHomeControl=True)
        self.assertEqual(len(self.home.calls), 1)
        self.assertEqual(self.agent.budget()['commands'], 0)
        result = next(v for e, v in self.events if e == 'result')
        self.assertEqual(result['status'], 'confirmed'); self.assertEqual(result['target'], 'home')
        self.assertNotIn('模型伪称', str(self.events))
        self.assertEqual(self.tools[0]['function']['name'], 'toggle_light')

    def test_car_permission_cannot_authorize_home(self):
        with self.assertRaises(DashboardError): self.chat(allowControl=True)
        self.assertEqual(self.home.calls, []); self.assertEqual(self.tools, [])

    def test_disabled_bridge_blocks_before_provider(self):
        self.home.ready = False
        with self.assertRaises(DashboardError) as error: self.chat(allowHomeControl=True)
        self.assertEqual(error.exception.status, 503); self.assertEqual(self.tools, [])

    def test_cross_tool_target_and_multiple_calls_never_dispatch(self):
        for calls in ([{'name': 'set_climate', 'arguments': {'on': True}}],
                      [{'name': 'toggle_light', 'arguments': {'device_id': 'other', 'on': True}}],
                      [{'name': 'toggle_light', 'arguments': ARGS}] * 2):
            self.agent.runtime['seen'] = {}; self.agent.next_at = 0
            self.answer['calls'] = calls
            with self.assertRaises(DashboardError): self.chat(allowHomeControl=True, allowControl=True)
        self.assertEqual(self.home.calls, [])

    def test_pure_chat_hallucinated_tool_rejected(self):
        with self.assertRaises(DashboardError): self.chat('讲讲测试灯', allowHomeControl=True)
        self.assertEqual(self.home.calls, [])

    def test_normal_home_topic_chat_is_not_censored(self):
        self.answer = {'text': '灯泡的原理介绍', 'calls': []}
        self.chat('讲讲测试灯')
        self.assertIn(('text', {'text': '灯泡的原理介绍'}), self.events)
        self.assertEqual(self.home.calls, [])

    def test_missing_tool_never_claims_requested_action_completed(self):
        self.answer['calls'] = []
        self.chat(allowHomeControl=True)
        self.assertNotIn('模型伪称', str(self.events)); self.assertEqual(self.home.calls, [])

    def test_repeat_request_blocked_and_invalid_grants_rejected(self):
        for flag in ('true', 1):
            with self.assertRaises(DashboardError): self.chat(allowHomeControl=flag)
        self.chat(allowHomeControl=True); self.agent.next_at = 0
        with self.assertRaises(DashboardError): self.chat(allowHomeControl=True)
        self.assertEqual(len(self.home.calls), 1)

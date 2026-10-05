"""Semantic proposals, local catalogs and a fake clock. Zero model/device I/O."""
import copy
import unittest

from .home_dialogue import HomeDialogue, PROPOSAL_TOOL


def device(name, kind='plug', room='', enabled=True):
    mapping = {'on': {'siid': 2, 'piid': 1}}
    if kind == 'climate':
        mapping['target_temperature'] = {'siid': 2, 'piid': 4, 'min': 16, 'max': 32, 'step': 1}
    return {'name': name, 'kind': kind, 'home': '测试家庭', 'room': room,
            'enabled': enabled, 'did': 'PRIVATE-DID', 'capabilities': list(mapping), 'properties': mapping}


def proposal(name='智能插座', location='', state=None, kind='plug'):
    return {'name': 'propose_home_action', 'arguments': {
        'kind': kind, 'device_phrase': name, 'location_phrase': location,
        'state': {'on': True} if state is None else state}}


class HomeDialogueTests(unittest.TestCase):
    def setUp(self):
        self.now = 100
        self.dialogue = HomeDialogue(clock=lambda: self.now)
        self.config = {'devices': {'tj': device('米家智能插座3', room='示例区域甲'),
                                   'zz': device('卧室插座', room='示例区域乙'),
                                   'ac3': device('Smart Air Conditioner (VRF) 3', 'climate', '示例区域乙'),
                                   'ac4': device('Smart Air Conditioner (VRF) 4', 'climate', '示例区域乙')}}
        self.config['_catalog'] = list(self.config['devices'].values())

    def prepare(self, text, session='page-one'):
        return self.dialogue.prepare(text, self.config, session)

    def resolve(self, text, call=None, session='page-one'):
        return self.dialogue.resolve(self.prepare(text, session), call)

    def test_generic_request_asks_and_location_reply_selects_one(self):
        result = self.resolve('打开智能插座', proposal())
        self.assertIsNone(result['intent']); self.assertIn('哪个？', result['question'])
        plan = self.prepare('我示例区域甲的那个')
        self.assertEqual(plan['context']['pending_request'], '打开智能插座')
        result = self.dialogue.resolve(plan, proposal(location='示例区域甲'))
        self.assertEqual(result['intent'], ('toggle_plug', {'device_id': 'tj', 'on': True}))
        self.assertEqual(result['execution_text'], '打开米家智能插座3')
        self.assertEqual(self.dialogue.pending, {})

    def test_polite_phrase_and_short_brandless_name_are_not_exact_templates(self):
        for text in ('麻烦帮我打开智能插座3', '请帮我把智能插座3打开一下'):
            # 开一下 / 打开一下 is still exactly one action token.
            result = self.resolve(text, proposal('智能插座3'))
            self.assertEqual(result['intent'][1]['device_id'], 'tj', text)

    def test_same_room_requires_device_name_on_third_turn(self):
        self.resolve('打开智能空调', proposal('智能空调', kind='climate'))
        result = self.resolve('我示例区域乙的那个', proposal('智能空调', '示例区域乙', kind='climate'))
        self.assertIsNone(result['intent'])
        result = self.resolve('智能空调3', proposal('智能空调', '示例区域乙', kind='climate'))
        self.assertEqual(result['intent'][1]['device_id'], 'ac3')

    def test_model_may_ask_without_tool_then_follow_up_can_resolve(self):
        self.resolve('打开智能插座')
        result = self.resolve('我示例区域甲的那个', proposal(location='示例区域甲'))
        self.assertEqual(result['intent'][1]['device_id'], 'tj')

    def test_natural_short_selection_and_unrelated_city_talk(self):
        for text in ('示例区域甲的插座', '我在示例区域甲家里的那个智能插座', '好的，就示例区域甲的那个吧'):
            self.resolve('打开智能插座', proposal())
            result = self.resolve(text, proposal(location='示例区域甲'))
            self.assertEqual(result['intent'][1]['device_id'], 'tj', text)
        self.resolve('打开智能插座', proposal())
        self.assertFalse(self.prepare('示例区域甲今天天气好吗')['request'])

    def test_cancel_topic_change_and_new_action_do_not_reuse_old_request(self):
        for text in ('取消', '算了', '今天天气怎么样', '打开智能空调3'):
            self.resolve('打开智能插座', proposal())
            plan = self.prepare(text)
            self.assertIsNone(plan['context']['pending_request'])
            self.assertEqual(self.dialogue.pending, {})
        self.assertFalse(self.prepare('我示例区域甲的那个')['request'])

    def test_expiry_page_isolation_and_revision_change(self):
        self.resolve('打开智能插座', proposal())
        self.assertFalse(self.prepare('我示例区域甲的那个', 'other-page')['request'])
        self.now += 121
        result = self.resolve('我示例区域甲的那个', proposal(location='示例区域甲'))
        self.assertIsNone(result['intent']); self.assertIn('过期', result['question'])
        self.resolve('打开智能插座', proposal())
        self.config['devices']['tj']['enabled'] = False
        result = self.resolve('我示例区域甲的那个', proposal(location='示例区域甲'))
        self.assertIsNone(result['intent']); self.assertIn('变化', result['question'])

    def test_unknown_or_missing_rooms_never_guessed_even_if_only_one_plug(self):
        self.config['devices'] = {'tj': device('米家智能插座3')}
        for text in ('打开示例区域甲的智能插座', '打开未知区域智能插座'):
            self.assertIsNone(self.resolve(text, proposal())['intent'])
        self.resolve('打开智能插座')
        result = self.resolve('我示例区域甲的那个', proposal())
        self.assertIsNone(result['intent'])

    def test_model_cannot_invent_location_number_or_on_off(self):
        for text, call in (('打开智能插座', proposal(location='示例区域甲')),
                           ('打开智能插座3', proposal(state={'on': False})),
                           ('打开智能插座99', proposal()),
                           ('打开智能插座3', proposal('卧室插座')),
                           ('打开智能插座', proposal('米家智能插座3'))):
            self.assertIsNone(self.resolve(text, call)['intent'], text)

    def test_specific_location_and_number_are_enforced_if_model_omits_them(self):
        result = self.resolve('打开示例区域甲的智能插座', proposal())
        self.assertEqual(result['intent'][1]['device_id'], 'tj')
        result = self.resolve('打开智能空调3', proposal('智能空调', kind='climate'))
        self.assertEqual(result['intent'][1]['device_id'], 'ac3')
        result = self.resolve('打开米家智能插座3', proposal('插座'))
        self.assertEqual(result['intent'][1]['device_id'], 'tj')
        result = self.resolve('把智能空调3调到24度', proposal('空调', state={'target_temperature': 24}, kind='climate'))
        self.assertEqual(result['intent'][1]['device_id'], 'ac3')

    def test_device_number_is_not_a_suffix_match(self):
        self.config['devices'] = {'twelve': device('智能插座12', room='示例区域甲')}
        self.assertIsNone(self.resolve('打开插座2', proposal('插座'))['intent'])

    def test_negation_questions_quotes_conditions_multiple_actions_are_not_requests(self):
        for text in ('不要打开智能插座', '打开智能插座吗？', '“打开智能插座”',
                     '如果打开智能插座', '怎么打开智能插座', '打开智能插座并关闭灯泡',
                     '打开插座和灯泡', '昨天我打开智能插座', '关闭插座，同时开启空调'):
            plan = self.prepare(text)
            self.assertFalse(plan['request'], text); self.assertEqual(plan['tools'], [])
            self.assertIsNone(self.dialogue.resolve(plan, proposal())['intent'])

    def test_multi_target_longest_name_does_not_select_one_and_ignore_rest(self):
        for text in ('打开智能插座3和卧室插座', '打开智能插座3、卧室插座',
                     '打开智能空调3和智能空调4'):
            plan = self.prepare(text)
            self.assertFalse(plan['request'])
            self.assertIsNone(self.dialogue.resolve(plan, proposal())['intent'])

    def test_climate_scope_clarification_never_converts_pending_home_to_vehicle(self):
        result = self.resolve('打开空调', proposal('空调', kind='climate'))
        self.assertIn('车辆空调', result['question'])
        result = self.resolve('家里的', proposal('空调', kind='climate'))
        self.assertIsNone(result['intent']); self.assertIn('哪个', result['question'])
        self.resolve('打开空调')
        result = self.resolve('车上的', proposal('空调', kind='climate'))
        self.assertIsNone(result['intent']); self.assertIn('重新说', result['question'])
        self.assertFalse(self.prepare('打开车辆空调')['related'])

    def test_existing_explicit_car_commands_and_new_underspecified_home_setpoint(self):
        for text in ('闪灯', '鸣笛', '锁车', '打开后备箱', '打开车辆空调'):
            self.resolve('打开智能插座', proposal())
            self.assertFalse(self.prepare(text)['related'], text)
        self.resolve('打开智能空调', proposal('智能空调', kind='climate'))
        plan = self.prepare('把温度调到24度')
        self.assertTrue(plan['related'])
        self.assertIsNone(plan['context']['pending_request'])
        self.assertIsNone(self.dialogue.resolve(plan, proposal('温度', state={'target_temperature': 24}, kind='climate'))['intent'])

    def test_setpoint_grounding_range_step_and_missing_requested_fields(self):
        for text, value in (('把智能空调3调到24度', 24),
                            ('请帮我把智能空调3调成24度', 24.0)):
            result = self.resolve(text, proposal('智能空调3', state={'target_temperature': value}, kind='climate'))
            self.assertEqual(result['intent'][1]['target_temperature'], value)
        for text, state in (('把智能空调3调到24度', {'target_temperature': 25}),
                            ('把智能空调3调到24.5度', {'target_temperature': 24.5}),
                            ('打开智能空调3，温度24度', {'on': True})):
            self.assertIsNone(self.resolve(text, proposal('智能空调3', state=state, kind='climate'))['intent'])

    def test_disabled_device_and_malformed_proposals_are_not_execution(self):
        self.config['devices']['tj']['enabled'] = False
        result = self.resolve('打开智能插座3', proposal('智能插座3'))
        self.assertIsNone(result['intent']); self.assertIn('取消控制', result['question'])
        for field, value in (('kind', []), ('device_phrase', 3), ('location_phrase', None), ('state', {'on': 1})):
            call = proposal(); call['arguments'][field] = value
            self.assertIsNone(self.resolve('打开智能插座', call)['intent'])
        call = proposal(); call['arguments']['device_id'] = 'tj'
        self.assertIsNone(self.resolve('打开智能插座', call)['intent'])

    def test_catalog_to_model_excludes_did_and_binding(self):
        plan = self.prepare('打开智能插座')
        self.assertNotIn('PRIVATE-DID', str(plan['context']))
        self.assertNotIn('siid', str(plan['context']))
        self.assertNotIn('device_id', str(PROPOSAL_TOOL))

    def test_pending_is_bounded_and_no_confirm_reply_replays(self):
        self.dialogue.capacity = 2
        for session in ('a', 'b', 'c'):
            self.resolve('打开智能插座', proposal(), session)
        self.assertEqual(len(self.dialogue.pending), 2)
        self.assertNotIn('a', self.dialogue.pending)
        self.assertFalse(self.prepare('好的', 'c')['request'])

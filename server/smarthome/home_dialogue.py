"""LLM proposes; the server resolves a grounded, unique target before dispatch.

Only an unfinished clarification is kept, in memory, for two minutes. Never
trust client-supplied history, model-selected device IDs, or a past action as
permission for a new one. No I/O, SDK calls or quota reservations in this file.
"""
import copy
import hashlib
import json
import re
import time

from .contracts import validate
from .xiaomi_bridge import fingerprint, parse_intent

KINDS = {'light': ('灯泡', '智能灯', '灯具', '灯'),
         'plug': ('智能插座', '插座'),
         'climate': ('智能空调', '空调')}
TOOLS = {'light': 'toggle_light', 'plug': 'toggle_plug', 'climate': 'set_climate'}
MODE = {'制冷': 'cool', '制热': 'heat', '送风': 'fan', '除湿': 'dry', '自动': 'auto'}
FAN = {'自动': 'auto', '低': 'low', '中': 'medium', '高': 'high'}
ACTION = re.compile(r'打开|开启|启动|点亮|关闭|关掉|关上|熄灭|调到|调成|设为|设置为|开一下|关一下')
UNSAFE = re.compile(r'不要|别|不用|不许|取消|算了|不需要|不想|别再|不准|停止操作|'
                    r'如果|假如|假设|比如|例如|曾经|昨天|原理|怎么|如何|能否|能不能|可以吗|吗|么|是否|'
                    r'[?？“”"「」『』]|同时|然后|再把|再开|并且|以及|和.*(?:打开|开启|关闭|关掉)|'
                    r'(?:灯|插座|空调|\d)\s*(?:和|与|、|还有|及)|\band\b|'
                    r'忽略|绕过|权限|授权|工具|系统提示|指令|执行代码|API')
LOCATION = re.compile(r'(?:我)?(?:在)?(.{1,30}?)(?:的)?(?:那个|那台|那一个|这一台)[。！!]?')

PROPOSAL_TOOL = {'type': 'function', 'function': {
    'name': 'propose_home_action',
    'description': '理解用户本轮明确家居请求，提出一个动作。此工具不直接执行；后端会核对原话、房间和唯一设备，歧义时追问。不能猜测位置或设备编号。',
    'parameters': {'type': 'object', 'additionalProperties': False,
        'required': ['kind', 'device_phrase', 'location_phrase', 'state'],
        'properties': {
            'kind': {'type': 'string', 'enum': list(KINDS)},
            'device_phrase': {'type': 'string', 'minLength': 1, 'maxLength': 80,
                'description': '从当前原话或服务端待澄清请求原样摘取设备称呼，如智能插座；不是设备ID'},
            'location_phrase': {'type': 'string', 'maxLength': 80,
                'description': '原话明确说出的房间或家庭名称，如示例区域甲；未说明填空串，不能按目录猜测'},
            'state': {'type': 'object', 'additionalProperties': False,
                'properties': {
                    'on': {'type': 'boolean'},
                    'target_temperature': {'type': 'number', 'minimum': 16, 'maximum': 32},
                    'brightness': {'type': 'integer', 'minimum': 1, 'maximum': 100},
                    'color_temperature': {'type': 'integer', 'minimum': 1000, 'maximum': 10000},
                    'mode': {'type': 'string', 'enum': list(MODE.values())},
                    'fan_level': {'type': 'string', 'enum': list(FAN.values())},
                }},
        }}}}


def norm(value):
    return re.sub(r'[\s（）()]', '', value).casefold()


def spoken_names(device):
    names = {device['name']}
    # Stable category translation, not per-device programming or fuzzy guessing.
    if device['kind'] == 'climate':
        translated = re.sub(r'Smart Air Conditioner', '智能空调', device['name'], flags=re.I)
        names.update((translated, re.sub(r'\s+', '', re.sub(r'[（(]VRF[）)]', '', translated, flags=re.I))))
    if device['kind'] == 'plug':
        names.add(re.sub(r'^米家', '', device['name']))
    return sorted(names)


def direct_request(text):
    """Broad imperative guard, not an exact sentence template.

    Interpretation belongs to the model. This independent guard stops quoted,
    negative, question, conditional, multi-action and historical statements.
    """
    if UNSAFE.search(text) or len(ACTION.findall(text)) != 1:
        return False
    prefix = text[:ACTION.search(text).start()].strip()
    polite = r'(?:请|你|帮我|给我|麻烦|麻烦你|拜托|现在|我想|我要|先|一下|\s)*'
    return bool(re.fullmatch(polite + r'(?:把.{1,100})?', prefix))


def selection_only(text, selectors):
    """Allow short natural selection replies, not unrelated talk about a city."""
    remainder = norm(text.strip('。！!，,'))
    if not any(norm(value) in remainder for value in selectors):
        return False
    for value in sorted(set(selectors), key=len, reverse=True):
        remainder = remainder.replace(norm(value), '')
    for words in KINDS.values():
        for word in sorted(words, key=len, reverse=True):
            remainder = remainder.replace(norm(word), '')
    remainder = re.sub(r'那个|那台|那一个|这一台|这个|这台|我的|我|在|家里|米家|的|就|吧|好的', '', remainder)
    remainder = re.sub(r'[，,。！!]', '', remainder)
    return not remainder


def canonical(device, state):
    """Use the existing MCP bridge and its strict gates, not a second executor."""
    name = device['name']
    if 'on' in state:
        text = ('打开' if state['on'] else '关闭') + name
        for key, label, suffix in (('brightness', '亮度', '%'), ('color_temperature', '色温', 'K'),
                                   ('target_temperature', '温度', '度')):
            if key in state:
                text += f'，{label}{state[key]:g}{suffix}'
        for key, words, label in (('mode', MODE, '模式'), ('fan_level', FAN, '风速')):
            if key in state:
                text += '，' + label + next(k for k, v in words.items() if v == state[key])
        return text
    if set(state) == {'target_temperature'}:
        return f'把{name}调到{state["target_temperature"]:g}度'
    if set(state) == {'mode'}:
        return '把' + name + '设为' + next(k for k, v in MODE.items() if v == state['mode'])
    if set(state) == {'fan_level'}:
        return '把' + name + '风速设为' + next(k for k, v in FAN.items() if v == state['fan_level'])
    return ''


def grounded_state(original, kind, state):
    if not isinstance(state, dict) or not state:
        return False
    try:
        validate(TOOLS[kind], {'device_id': 'proposal', **state})
    except (ValueError, KeyError, TypeError):
        return False
    action = ACTION.search(original)[0]
    required = {'brightness': '亮度', 'color_temperature': '色温',
                'target_temperature': '温度', 'mode': '模式', 'fan_level': '风速'}
    if any(word in original and key not in state for key, word in required.items()):
        return False
    if 'on' in state:
        positive = action in ('打开', '开启', '启动', '点亮', '开一下')
        negative = action in ('关闭', '关掉', '关上', '熄灭', '关一下')
        if not (positive or negative) or state['on'] is not positive:
            return False
    elif action not in ('调到', '调成', '设为', '设置为'):
        return False
    # A model cannot invent setpoints or quietly add extra operations.
    for key, suffix in (('target_temperature', r'(?:度|℃)'), ('brightness', '%'), ('color_temperature', '[Kk]')):
        if key in state:
            numbers = re.findall(r'(\d+(?:\.\d+)?)\s*' + suffix, original)
            if not any(float(n) == state[key] for n in numbers):
                return False
    for key, words, label in (('mode', MODE, '模式'), ('fan_level', FAN, '风速')):
        if key in state:
            phrase = next((k for k, v in words.items() if v == state[key]), None)
            if phrase is None or not re.search(label + r'.{0,5}' + re.escape(phrase), original):
                return False
    return True


class HomeDialogue:
    def __init__(self, *, clock=time.monotonic, ttl=120, capacity=32):
        self.clock, self.ttl, self.capacity = clock, ttl, capacity
        self.pending = {}  # Protected by HomeControl.account.lock / AI serial lock.

    def forget(self, conversation_id):
        self.pending.pop(conversation_id, None)

    def prepare(self, text, config, conversation_id):
        devices = config['devices'] if config else {}
        catalog = config.get('_catalog', []) if config else []
        revision = hashlib.sha256(json.dumps(config, sort_keys=True, ensure_ascii=False).encode()).hexdigest()
        now = self.clock()
        pending = self.pending.pop(conversation_id, None)
        self.pending = {key: value for key, value in self.pending.items() if value['expires'] > now}
        expired = pending and (now >= pending['expires'] or pending['revision'] != revision)
        # New verbs replace an old request. A follow-up must only select a
        # location/name; free-form conversation, "yes", or silence is not consent.
        selectors = [value for d in devices.values() for value in
                     (*spoken_names(d), d.get('home', ''), d.get('room', '')) if value]
        followup = bool(pending and not ACTION.search(text) and not UNSAFE.search(text)
                        and len(text) <= 100 and (LOCATION.fullmatch(text.strip()) or selection_only(text, selectors) or
                            text.strip('。！!') in ('家里的', '家里', '米家的', '米家', '车上的', '车辆的') or
                            any(norm(text.strip('。！!')) == norm(value) for value in selectors)))
        original = pending['original'] if followup and not expired else text
        phrases = [*pending['phrases'], text][-4:] if followup and not expired else [text]
        if original not in phrases:
            phrases.insert(0, original)
        related = bool(pending and followup) or bool(re.search(r'米家|家居|家里|摄像头|门锁', text))
        related = related or any(word in text for words in KINDS.values() for word in words if word != '灯')
        related = related or bool('灯' in text and ACTION.search(text))
        # A new underspecified setpoint while clarifying home control must not
        # silently become a car command. Explicit vehicle nouns still route out.
        vehicle_noun = bool(re.search(r'后备箱|前备箱|充电口|车窗|车辆|车上|车里|车载|特斯拉', text))
        related = related or bool(pending and ACTION.search(text) and not vehicle_noun)
        related = related or any(norm(n) in norm(text) for d in catalog for n in spoken_names(d))
        related = related or bool(pending and re.fullmatch(r'(?:取消|算了|不用了|不要了)[。！!]?', text.strip()))
        joined = '\n'.join(phrases)
        vehicle_scope = bool(re.search(r'车辆|车上|车里|车载|特斯拉', joined))
        home_scope = bool(re.search(r'米家|家居|家里|智能空调', joined)) or any(
            value in joined for d in devices.values() for value in (d.get('room'), d.get('home')) if value)
        home_scope = home_scope or any(norm(n) in norm(joined) for d in devices.values() if d['kind'] == 'climate'
                                       for n in spoken_names(d))
        scope_ambiguous = '空调' in original and not home_scope and not vehicle_scope
        if vehicle_scope and not home_scope and not followup:
            related = False
        mentioned_kinds = {kind for kind, words in KINDS.items() if any(word in original for word in words)}
        request = direct_request(original) and len(mentioned_kinds) <= 1 and not (followup and expired)
        return {'related': related, 'request': request, 'original': original,
                'phrases': phrases, 'latest': text, 'revision': revision, 'conversation_id': conversation_id,
                'devices': devices, 'catalog': catalog, 'intent': None, 'context': {
                    'devices': [{'name': d['name'], 'spoken_names': spoken_names(d), 'kind': d['kind'],
                                 'home': d.get('home', ''), 'room': d.get('room', ''),
                                 'selected': d.get('enabled') is True, 'capabilities': d.get('capabilities', [])}
                                for d in devices.values()],
                    'pending_request': original if followup and not expired else None,
                    'note': '目录不是当前状态。空房间表示未知，不猜房间。泛称不等于指定某台。提出结构化建议，由后端判断唯一性后执行或追问。'},
                'tools': [copy.deepcopy(PROPOSAL_TOOL)] if request else [],
                'expired': bool(followup and expired), 'scope_ambiguous': scope_ambiguous,
                'vehicle_followup': bool(vehicle_scope and followup and not home_scope)}

    def remember(self, plan):
        now = self.clock()
        self.pending = {key: value for key, value in self.pending.items() if value['expires'] > now}
        if len(self.pending) >= self.capacity:
            self.pending.pop(next(iter(self.pending)))
        self.pending[plan['conversation_id']] = {'original': plan['original'],
            'phrases': plan['phrases'], 'revision': plan['revision'], 'expires': now + self.ttl}

    def resolve(self, plan, call):
        """A pure proposal may yield a question or a canonical authorized request."""
        def question(message, remember=True):
            if remember and plan['request']:
                self.remember(plan)
            return {'question': message, 'intent': None}
        if plan['expired']:
            return question('刚才的设备澄清已过期或目录已变化，请重新说完整指令。', False)
        if plan['vehicle_followup']:
            return question('你要操作车辆空调，请重新说“打开车辆空调”等完整指令；不会把待澄清家居动作转为控车。', False)
        if plan['scope_ambiguous']:
            return question('你说的是车辆空调，还是家里的米家空调？本轮还没有执行。')
        if not plan['request']:
            return question('这轮没有明确家居操作请求，未执行任何动作。', False)
        if call is None:
            return question('你想操作哪台设备？请说明设备名称和所在房间；本轮还没有执行。')
        args = call.get('arguments')
        if (call.get('name') != 'propose_home_action' or not isinstance(args, dict)
                or set(args) != {'kind', 'device_phrase', 'location_phrase', 'state'}):
            return question('模型提出的家居建议格式不符合要求，本轮未执行。', False)
        kind, name, location, state = (args[k] for k in ('kind', 'device_phrase', 'location_phrase', 'state'))
        if (not isinstance(kind, str) or kind not in KINDS or not isinstance(name, str) or not 1 <= len(name) <= 80
                or not isinstance(location, str) or len(location) > 80
                or not any(name in phrase for phrase in plan['phrases'])
                or (location and not any(location in phrase for phrase in plan['phrases']))
                or not grounded_state(plan['original'], kind, state)):
            return question('家居建议与原话中的设备或动作不一致，本轮未执行。', False)
        generic = norm(name) in {norm(value) for value in KINDS[kind]}
        candidates = [(alias, d) for alias, d in plan['devices'].items() if d['kind'] == kind and
                      (generic or any(norm(name) == norm(value) for value in spoken_names(d)))]
        # A named location must not disappear merely because the model omitted
        # location_phrase or the old catalog has no room metadata yet.
        user_locations = set()
        for phrase in plan['phrases']:
            selection = LOCATION.fullmatch(phrase.strip())
            if selection and not ACTION.search(phrase):
                user_locations.add(selection[1].rstrip('的'))
            if name in phrase and ACTION.search(phrase):
                prefix = phrase[:phrase.index(name)].strip()
                prefix = re.sub(r'^(?:请|你|帮我|给我|麻烦|麻烦你|拜托|现在|我想|我要|先|\s)*', '', prefix)
                prefix = re.sub(r'^(?:打开|开启|启动|点亮|关闭|关掉|关上|熄灭|开一下|关一下|把)', '', prefix)
                prefix = prefix.removesuffix('智能').removesuffix('米家')
                prefix = prefix.strip().removesuffix('的')
                if prefix and prefix not in ('一下', '那个', '这个'):
                    user_locations.add(prefix)
        for explicit_location in user_locations:
            candidates = [(alias, d) for alias, d in candidates if explicit_location in
                          (d.get('home'), d.get('room'), d.get('home', '') + d.get('room', ''))]
        if generic:
            numbers = {match for phrase in plan['phrases'] for match in
                       re.findall(re.escape(name) + r'(?:\s*[（(]VRF[）)])?\s*(\d+)', phrase, re.I)}
            if numbers:
                candidates = [(alias, d) for alias, d in candidates if all(any(
                    (match := re.search(r'(\d+)$', norm(value))) and match[1] == number
                    for value in spoken_names(d)) for number in numbers)]
        if location:
            candidates = [(alias, d) for alias, d in candidates if location in
                          (d.get('home'), d.get('room'), (d.get('home', '') + d.get('room', '')))]
        # Explicit names/numbers/locations in either turn further narrow even if
        # the model omits them; it may not widen a user's specific target.
        joined = '\n'.join(plan['phrases'])
        all_locations = {value for d in plan['devices'].values() for value in
                         (d.get('home'), d.get('room')) if value}
        mentioned_locations = {value for value in all_locations if value in joined}
        if mentioned_locations:
            candidates = [(alias, d) for alias, d in candidates if mentioned_locations <=
                          {d.get('home'), d.get('room')}]
        specific = {alias for alias, d in plan['devices'].items() if d['kind'] == kind and
                    any(norm(value) in norm(joined) and norm(value) not in
                        {norm(word) for word in KINDS[kind]} for value in spoken_names(d))}
        # Longest names win: "空调3" must not also mean the unnumbered "空调".
        if specific:
            longest = max(len(norm(value)) for alias, d in plan['devices'].items() if alias in specific
                          for value in spoken_names(d) if norm(value) in norm(joined))
            specific = {alias for alias, d in plan['devices'].items() if alias in specific and
                        any(len(norm(value)) == longest and norm(value) in norm(joined) for value in spoken_names(d))}
            candidates = [(alias, d) for alias, d in candidates if alias in specific]
        if not candidates:
            return question('没找到与你说的名称和房间相符的已适配设备。若房间未同步，请先在设置中同步米家设备。')
        if len(candidates) > 1:
            choices = '；'.join(' / '.join(filter(None, (d.get('home'), d.get('room'), spoken_names(d)[-1])))
                               for _, d in candidates[:8])
            return question('哪个？' + choices + '。你可以回答“示例区域甲的那个”，或说具体设备名称。本轮尚未执行。')
        alias, device = candidates[0]
        if device.get('enabled') is not True:
            return question('这台设备已被取消控制授权，请在设置中重新允许；本轮未执行。', False)
        try:
            text = canonical(device, state)
            intent = parse_intent(text, plan['devices'])
            if not intent or fingerprint(*intent) != fingerprint(TOOLS[kind], {'device_id': alias, **state}):
                raise ValueError('不可规范化')
            if not set(state) <= set(device['capabilities']):
                raise ValueError('功能不支持')
            from .mijia_backend import MijiaBackend
            MijiaBackend.validate_desired(device, state)
        except (ValueError, KeyError, TypeError, StopIteration):
            return question('该型号不支持这些参数，或参数超出范围、步长；本轮未执行。', False)
        # Consume before dispatch. An unknown result or a later "好的" cannot replay.
        self.forget(plan['conversation_id'])
        return {'intent': intent, 'execution_text': text, 'question': None}

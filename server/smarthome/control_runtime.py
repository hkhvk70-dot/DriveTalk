"""Selected account inventory -> fixed MCP tools. No network on construction.

Only the authenticated DeepSeek request's separate home grant may dispatch.
No plaintext Xiaomi auth, arbitrary device IDs, model URLs or automatic retries.
"""
import asyncio
import hashlib
import importlib.util
import json
from pathlib import Path
import re
import tempfile
import threading

from .credential_store import CredentialStore
from .discovery import generated_config, prepare_inventory
from .factory import open_provider
from .mijia_backend import MijiaBackend
from .xiaomi_bridge import Ledger, XiaomiBridge, denial, fingerprint, parse_intent
from .home_dialogue import HomeDialogue


PHONE_CONTEXT = re.compile(r'^【手机GPS参考：(速度未知/信号不可用|\d+(?:\.\d+)? km/h)。不是车辆传感器数据，不用于替代控车安全检查。】\n')


class HomeControl:
    def __init__(self, account, *, enabled=False, ready=None, provider_factory=open_provider, timeout=45,
                 readback_sleep=asyncio.sleep):
        self.account = account
        self.enabled = enabled
        self.ready = ready or (lambda: importlib.util.find_spec('mcp') is not None)
        self.provider_factory = provider_factory
        self.timeout = timeout
        self.readback_sleep = readback_sleep
        self.lock = threading.Lock()
        self.dialogue = HomeDialogue()
        account.control_ready = self.available

    def available(self):
        return self.enabled is True and self.account.directory is not None and self.ready()

    def _config(self):
        self.account._update()
        if self.account.directory is None or self.account.process is not None:
            return None
        try:
            store = CredentialStore(self.account.directory)
            with store.exclusive():
                auth = store.load()
                inventory = store.load_inventory()
                if inventory.get('account_fingerprint') != hashlib.sha256(str(auth['userId']).encode()).hexdigest():
                    return None
                inventory = prepare_inventory(inventory, store.directory)
                config = generated_config(inventory, store.directory)
                config['_known_names'] = [device['name'] for device in inventory['devices'].values()]
                config['_catalog'] = [{k: d.get(k, '') for k in ('name', 'kind', 'home', 'room')}
                                      for d in inventory['devices'].values()]
                config['_account'] = inventory['account_fingerprint']
                for alias, device in config['devices'].items():
                    device['enabled'] = (inventory.get('control_granted') is True
                                         and inventory['devices'][alias].get('enabled') is True)
                # A temporary private config is used only while a command executes.
                config['enabled'] = True
                return config
        except Exception:
            return None

    def plan(self, text):
        original = PHONE_CONTEXT.sub('', text, count=1)
        with self.account.lock:
            config = self._config()
        if config is None:
            return {'related': bool(re.search(r'米家|家居|家里|灯泡|插座', original)), 'intent': None, 'tools': [], 'context': []}
        devices = config['devices']
        intent = parse_intent(original, devices)
        related = intent is not None or any(name in original for name in config['_known_names']) or bool(re.search(r'米家|家居|家里|灯泡|插座|智能空调', original))
        bridge = XiaomiBridge(devices, None, enabled=self.available())
        allowed = intent is not None and devices[intent[1]['device_id']]['enabled'] is True
        if intent:
            allowed = allowed and set(intent[1]).difference({'device_id'}) <= set(devices[intent[1]['device_id']]['capabilities'])
            if allowed:
                try:
                    MijiaBackend.validate_desired(devices[intent[1]['device_id']],
                        {k: v for k, v in intent[1].items() if k != 'device_id'})
                except (ValueError, KeyError, TypeError):
                    allowed = False
        tools = bridge.offered_tools(original, allowed)
        if intent:
            # Reduce what is disclosed to the model to the single target's catalog entry.
            alias = intent[1]['device_id']; target = devices[alias]
            context = [{'device_id': alias, 'name': target['name'], 'kind': target['kind'],
                        'capabilities': target['capabilities'], 'selected': target['enabled']}]
            for tool in tools:
                tool['function']['parameters']['properties']['device_id']['enum'] = [alias]
        else:
            context = []
        return {'related': related, 'intent': intent, 'tools': tools, 'context': context}

    def plan_conversation(self, text, conversation_id):
        original = PHONE_CONTEXT.sub('', text, count=1)
        with self.account.lock:
            plan = self.dialogue.prepare(original, self._config(), conversation_id)
            if not self.available():
                plan['tools'] = []
            return plan

    def resolve_conversation(self, plan, call, allow_home_control):
        with self.account.lock:
            if allow_home_control is not True or not self.available():
                self.dialogue.forget(plan['conversation_id'])
                return {'intent': None, 'question': '本页没有允许控家或服务尚未就绪，本轮未执行。'}
            # Resolve against the same account/catalog revision, not a stale
            # plan after a login/sync/revocation during the model response.
            import copy
            current = self._config()
            revision = hashlib.sha256(json.dumps(current, sort_keys=True, ensure_ascii=False).encode()).hexdigest()
            if revision != plan['revision']:
                self.dialogue.forget(plan['conversation_id'])
                return {'intent': None, 'question': '米家账号或设备目录已变化，请重新说完整指令。'}
            return self.dialogue.resolve(copy.deepcopy(plan), call)

    def execute(self, *, request_id, user_text, allow_home_control, tool, arguments, expected_revision=None):
        if allow_home_control is not True or not self.available():
            return denial('disabled', '本轮未执行家居命令：控家未允许或服务未就绪')
        if not self.lock.acquire(blocking=False):
            return denial('busy', '上一条家居操作尚未结束')
        try:
            # Prevent account sync/selection changes during one write and bounded readback.
            with self.account.lock:
                original = PHONE_CONTEXT.sub('', user_text, count=1)
                config = self._config()
                if config is None:
                    return denial('account_unavailable', '请先完成米家登录和设备同步')
                if expected_revision is not None and expected_revision != hashlib.sha256(
                        json.dumps(config, sort_keys=True, ensure_ascii=False).encode()).hexdigest():
                    return denial('catalog_changed', '米家账号或设备目录已变化，本轮未执行')
                intent = parse_intent(original, config['devices'])
                if intent is None or fingerprint(tool, arguments) != fingerprint(*intent):
                    return denial('intent_not_authorized', '本轮未执行家居命令：与明确请求不符')
                device = config['devices'][arguments['device_id']]
                if not device['enabled']:
                    return denial('device_not_allowed', '请先在设置中选择允许控制的设备')
                if not set(arguments).difference({'device_id'}) <= set(device['capabilities']):
                    return denial('unsupported_parameter', '该型号不支持请求的功能')
                try:
                    MijiaBackend.validate_desired(device, {k: v for k, v in arguments.items() if k != 'device_id'})
                except (ValueError, KeyError, TypeError):
                    return denial('unsupported_parameter', '参数不符合型号范围、步长或模式；未发送')
                # 700 directory + 600 temporary JSON contains only the private mapping,
                # not decrypted auth. It is removed after MCP finishes or is cancelled.
                with tempfile.TemporaryDirectory(prefix='.home-command-', dir=self.account.directory) as directory:
                    path = Path(directory) / 'config.json'
                    with path.open('x', encoding='utf-8') as stream:
                        path.chmod(0o600)
                        json.dump(config, stream, ensure_ascii=False, allow_nan=False)
                    ledger_path = self.account.directory / 'commands.sqlite3'
                    ledger = Ledger(ledger_path)
                    ledger_path.chmod(0o600)
                    bridge = XiaomiBridge(config['devices'], ledger, enabled=True, timeout=max(.01, self.timeout - 5),
                                          readback_sleep=self.readback_sleep)
                    async def perform():
                        async with self.provider_factory(path) as provider:
                            return await bridge.execute(request_id=request_id, user_text=original,
                                allow_home_control=True, tool=tool, arguments=arguments, provider=provider)
                    try:
                        return asyncio.run(asyncio.wait_for(perform(), self.timeout))
                    except Exception:
                        return {'ok': False, 'confirmed': False, 'dispatched': None,
                                'result_unknown': True, 'code': 'result_unknown',
                                'message': '家居结果未知；不自动重试，请检查设备实际状态'}
        finally:
            self.lock.release()


def receipt_result(receipt):
    """Deterministic server result only; model prose cannot claim completion."""
    if receipt.get('confirmed') is True:
        state = receipt.get('actual_state', {})
        description = '已开启' if state.get('on') is True else '已关闭' if state.get('on') is False else '目标状态'
        details = []
        if type(state.get('target_temperature')) in (int, float):
            details.append(f"设定温度 {state['target_temperature']:g}℃")
        for key, labels in (('mode', {'cool': '制冷', 'heat': '制热', 'fan': '送风', 'dry': '除湿', 'auto': '自动'}),
                            ('fan_level', {'auto': '自动风', 'low': '低风', 'medium': '中风', 'high': '高风'})):
            if state.get(key) in labels:
                details.append(labels[state[key]])
        if details:
            description += '，' + '、'.join(details)
        return {'status': 'confirmed', 'commandSent': True, 'target': 'home',
                'message': f'家居设备{description}，已通过状态回读确认。'}
    if receipt.get('dispatched') is False:
        return {'status': 'not_sent', 'commandSent': False, 'target': 'home',
                'message': receipt.get('message', '家居命令未发送；请检查设备选择或次数限制。')}
    if receipt.get('accepted') is True:
        return {'status': 'accepted', 'commandSent': True, 'target': 'home',
                'message': '家居命令已受理，但状态回读尚未确认；设备可能已执行。请查看实际状态，不要重复发送，未自动重发指令。'}
    return {'status': 'unknown', 'commandSent': receipt.get('dispatched'), 'target': 'home',
            'message': '家居目标状态尚未确认；请检查设备，不要重复发送。'}

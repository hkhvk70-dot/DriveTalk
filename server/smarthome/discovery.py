"""Read-only account inventory; never invoke device properties or actions.

Discover everything, but do not equate discovery with control support. Only
unambiguous supported bindings can be exported to the fixed tool bridge.
No display name or user-provided MIoT method becomes an executable tool.
"""
from collections import Counter
from datetime import datetime, timezone
import copy
import hashlib
import json
import math
from pathlib import Path
import re


MODEL = re.compile(r'^[a-zA-Z0-9_-]+(?:\.[a-zA-Z0-9_-]+){1,5}$')
CATEGORIES = {
    'light': 'light', 'lamp': 'light', 'plug': 'plug', 'outlet': 'plug',
    'aircondition': 'climate', 'airconditioner': 'climate', 'acpartner': 'climate',
    'camera': 'camera', 'cat_eye': 'camera', 'cateye': 'camera',
    'lock': 'lock', 'doorlock': 'lock', 'router': 'router', 'gateway': 'gateway',
    'speaker': 'speaker', 'wifispeaker': 'speaker', 'scale': 'scale', 'scales': 'scale',
    'projector': 'projector', 'tv': 'media', 'box': 'media', 'tvbox': 'media',
    'phone': 'phone', 'watch': 'wearable',
    'vacuum': 'vacuum', 'curtain': 'curtain', 'sensor': 'sensor',
}
STANDARD = {'on', 'brightness', 'color-temperature', 'target-temperature',
            'temperature', 'relative-humidity', 'mode', 'fan-level',
            'battery-level', 'power', 'electric-power', 'status', 'volume'}
ENUMS = {'mode': {'cool': 'cool', 'heat': 'heat', 'fan': 'fan', 'dry': 'dry', 'auto': 'auto'},
         'fan-level': {'auto': 'auto', 'low': 'low', 'medium': 'medium', 'high': 'high'}}


def text(value, limit=80):
    if not isinstance(value, str):
        return ''
    return ''.join(c for c in value if c.isprintable()).strip()[:limit]


def property_name(value):
    # Official MIoT URNs, as well as the SDK's short names, are supported.
    value = text(value, 200)
    if value.startswith('urn:miot-spec-v2:property:'):
        return value.split(':')[3]
    return value


def describe_properties(spec):
    result = []
    rows = spec.get('properties', []) if isinstance(spec, dict) else []
    if not isinstance(rows, list):
        return result
    for row in rows[:500]:
        if not isinstance(row, dict):
            continue
        name = property_name(row.get('name'))
        method = row.get('method')
        if not name or not isinstance(method, dict):
            continue
        if any(type(method.get(k)) is not int or method[k] <= 0 for k in ('siid', 'piid')):
            continue
        access = row.get('rw')
        if access not in ('r', 'w', 'rw', 'wr', ''):
            continue
        item = {'name': name, 'type': text(row.get('type'), 20),
                'readable': 'r' in access, 'writable': 'w' in access,
                'siid': method['siid'], 'piid': method['piid']}
        bounds = row.get('range')
        if isinstance(bounds, (list, tuple)) and len(bounds) == 3:
            if (all(type(n) in (int, float) and math.isfinite(n) for n in bounds)
                    and bounds[1] > bounds[0] and bounds[2] > 0):
                item['range'] = list(bounds)
        # Do not retain free-form descriptions, enum text, tokens or raw actions.
        enum_rows = row.get('value-list')
        if name in ENUMS and isinstance(enum_rows, list) and 0 < len(enum_rows) <= 20:
            pairs = [(ENUMS[name].get(text(v.get('description'), 20).lower()), v.get('value'))
                     for v in enum_rows if isinstance(v, dict)]
            if (len(pairs) == len(enum_rows) and all(k and type(v) is int for k, v in pairs)
                    and len({k for k, _ in pairs}) == len(pairs)
                    and len({v for _, v in pairs}) == len(pairs)):
                item['values'] = dict(pairs)
        result.append(item)
    return result


def bindings(kind, properties, model=None):
    if kind not in ('light', 'plug', 'climate'):
        return {}
    # This plug has many safety/timer switches. Only the verified outlet service
    # is the main switch; never strip arbitrary '-N' suffixes from other models.
    if model == 'cuco.plug.v3':
        properties = [dict(p, name='on') if p['name'] == 'on-2' and p['siid'] == 2 and p['piid'] == 1
                      else p for p in properties]
    counts = Counter(p['name'] for p in properties)
    methods = Counter((p['siid'], p['piid']) for p in properties)
    mapped = {}
    for prop in properties:
        name = prop['name']
        if counts[name] != 1 or methods[prop['siid'], prop['piid']] != 1 or not prop['readable'] or not prop['writable']:
            continue
        method = {'siid': prop['siid'], 'piid': prop['piid']}
        if name == 'on' and prop['type'] == 'bool':
            mapped['on'] = method
        elif kind == 'light' and name in ('brightness', 'color-temperature'):
            if prop['type'] not in ('int', 'uint', 'float') or 'range' not in prop:
                continue
            low, high, step = prop['range']
            if name == 'color-temperature' and not (1500 <= low < high <= 9000):
                continue
            method.update(min=low, max=high, step=step)
            mapped[name.replace('-', '_')] = method
        elif kind == 'climate' and name == 'target-temperature' and prop['type'] in ('int', 'uint', 'float') and 'range' in prop:
            low, high, step = prop['range']
            if 16 <= low < high <= 32:
                method.update(min=low, max=high, step=step)
                mapped['target_temperature'] = method
        elif kind == 'climate' and name in ENUMS and prop['type'] in ('int', 'uint') and prop.get('values'):
            method['values'] = dict(prop['values'])
            mapped[name.replace('-', '_')] = method
    # Numeric properties must belong to the same service as the switch.
    if 'on' not in mapped:
        return {}
    if kind == 'climate' and 'target_temperature' not in mapped:
        return {}
    mapped = {k: v for k, v in mapped.items()
              if v['siid'] == mapped['on']['siid'] or (kind == 'climate' and k == 'fan_level')}
    return {} if kind == 'climate' and 'target_temperature' not in mapped else mapped


def prepare_inventory(inventory, credential_dir):
    """Local-only schema upgrade + user's default-on policy (2026-10-04).

    No account/device request and no file writes. Explicit selections/revocations
    override defaults. Never enable a camera, lock or unsupported mapping.
    """
    result = copy.deepcopy(inventory)
    specs = {}
    explicit = inventory.get('control_selection_version') == 1
    for device in result['devices'].values():
        model = device.get('model', '')
        if MODEL.fullmatch(model):
            device['kind'] = CATEGORIES.get(model.split('.')[1], 'unknown')
            if model not in specs:
                path = Path(credential_dir) / 'specs' / (model + '.json')
                try:
                    if path.is_symlink() or path.stat().st_size > 1000000:
                        raise ValueError('规格缓存无效')
                    raw = json.loads(path.read_text(encoding='utf-8'))
                    specs[model] = describe_properties(raw) if raw.get('model') == model else None
                except (OSError, ValueError, TypeError, AttributeError):
                    specs[model] = None
        props = specs.get(model) if specs.get(model) is not None else device.get('properties', [])
        mapping = bindings(device['kind'], props, model)
        device['binding'] = mapping
        device['capabilities'] = sorted(mapping) if mapping else device.get('capabilities', [])
        if mapping:
            device['integration_status'] = 'binding_ready_disabled'
        elif device.get('integration_status') == 'binding_ready_disabled':
            device['integration_status'] = 'adapter_required'
        device['enabled'] = bool(mapping) and (device.get('enabled') is True if explicit else True)
    result['control_granted'] = (inventory.get('control_granted') is True if explicit else
                                 any(d['enabled'] for d in result['devices'].values()))
    return result


def discover_devices(api, spec_loader):
    """One account list request, at most one spec lookup per unique model.

    Does not call get_devices_prop/set_devices_prop/run_action, wake devices,
    join Wi-Fi, unlock doors or open any camera stream.
    """
    records = api.get_devices_list()
    if not isinstance(records, list) or len(records) > 2000:
        raise ValueError('设备清单响应错误')
    devices, specifications = {}, {}
    rejected = 0
    for raw in records:
        if not isinstance(raw, dict):
            rejected += 1
            continue
        did = raw.get('did')
        if not isinstance(did, str) or not did or len(did) > 200:
            rejected += 1
            continue
        alias = 'device_' + hashlib.sha256(did.encode()).hexdigest()[:24]
        if alias in devices:
            continue  # Same cloud device can appear via multiple room/group views.
        model = text(raw.get('model'), 160)
        valid_model = bool(MODEL.fullmatch(model))
        kind = CATEGORIES.get(model.split('.')[1], 'unknown') if valid_model else 'unknown'
        if valid_model and model not in specifications:
            try:
                spec = spec_loader(model)
                if not isinstance(spec, dict) or spec.get('model') != model:
                    raise ValueError('规格型号不匹配')
                specifications[model] = describe_properties(spec)
            except Exception:
                specifications[model] = None  # No secret-bearing error in inventory.
        props = specifications.get(model)
        mapping = bindings(kind, props or [], model)
        online = raw.get('isOnline')
        if type(online) is not bool:
            online = None  # Missing/unknown never becomes offline or online.
        status = ('binding_ready_disabled' if mapping else
                  'camera_adapter_required' if kind == 'camera' else
                  'restricted_read_only' if kind == 'lock' else
                  'spec_unavailable' if props is None else 'adapter_required')
        devices[alias] = {
            'id': alias, 'did': did, 'name': text(raw.get('name')) or '未命名设备',
            'model': model, 'kind': kind, 'online': online,
            'home': text(raw.get('home_name')), 'room': text(raw.get('room_name')),
            'enabled': False, 'integration_status': status,
            'capabilities': sorted({p['name'] for p in props or [] if p['name'] in STANDARD}),
            'properties': props or [], 'binding': mapping,
        }
    return {'version': 1, 'synced_at': datetime.now(timezone.utc).isoformat(),
            'devices': devices, 'rejected_records': rejected}


def public_inventory(inventory):
    """Safe catalog for a future authenticated UI. No DID or executable IDs."""
    keys = ('id', 'name', 'model', 'kind', 'online', 'home', 'room',
            'enabled', 'integration_status', 'capabilities')
    return {'version': 1, 'synced_at': inventory['synced_at'],
            'devices': [{key: device[key] for key in keys}
                        for device in inventory['devices'].values()]}


def attach_rooms(inventory, homes):
    """Join the SDK's home/room metadata by DID, never by display name.

    Conflicting/shared memberships stay unknown. This is account metadata,
    not a device property read. No raw home IDs or extra fields are retained.
    """
    if not isinstance(homes, list) or len(homes) > 200:
        raise ValueError('家庭目录格式错误')
    memberships = {}
    def ids(values):
        if not isinstance(values, list):
            return []
        return [str(v.get('did')) if isinstance(v, dict) else str(v) for v in values[:4000]]
    for home in homes:
        if not isinstance(home, dict):
            continue
        home_name = text(home.get('name'))
        for did in ids(home.get('dids')):
            memberships.setdefault(did, set()).add((home_name, ''))
        rooms = home.get('roomlist')
        for room in rooms[:1000] if isinstance(rooms, list) else []:
            if isinstance(room, dict):
                for did in ids(room.get('dids')):
                    memberships.setdefault(did, set()).add((home_name, text(room.get('name'))))
    for device in inventory['devices'].values():
        labels = memberships.get(device['did'], set())
        specific = {pair for pair in labels if pair[1]}
        home_names = {pair[0] for pair in labels if pair[0]}
        if labels:
            device['home'] = next(iter(home_names)) if len(home_names) == 1 else ''
            device['room'] = next(iter(specific))[1] if len(specific) == 1 and len(home_names) <= 1 else ''
    return inventory


def generated_config(inventory, credential_dir):
    """Export only existing adapter-supported bindings, all disabled.

    Never overwrite the active config or preserve previous control grants across
    a rebind. All other devices remain visible in the encrypted inventory.
    """
    eligible = [d for d in inventory['devices'].values() if d['binding']]
    counts = Counter(d['name'] for d in eligible)
    devices = {}
    for device in eligible:
        name = device['name']
        if counts[name] > 1:
            name = name[:50] + ' · ' + device['id'][-12:]
        devices[device['id']] = {
            'name': name, 'kind': device['kind'], 'enabled': False,
            'home': device.get('home', ''), 'room': device.get('room', ''),
            'model': device['model'], 'did': device['did'],
            'capabilities': list(device['binding']), 'properties': device['binding'],
        }
    return {'enabled': False, 'provider': 'mijia',
            'credential_dir': str(credential_dir), 'devices': devices}


def sync_account(api, store, spec_loader=None):
    if spec_loader is None:
        from mijiaAPI import get_device_info
        # SDK model specification cache has no account information. Model is
        # validated before it is used as any path component.
        spec_loader = lambda model: get_device_info(model, cache_path=store.directory / 'specs')
    inventory = discover_devices(api, spec_loader)
    # Only the explicit login/sync job accesses Xiaomi. Planning/chat never
    # fetches room metadata, and missing/failed metadata is not guessed.
    if callable(getattr(api, 'get_homes_list', None)):
        try:
            attach_rooms(inventory, api.get_homes_list())
            inventory['room_metadata_status'] = 'synced'
        except Exception:
            for device in inventory['devices'].values():
                device['home'] = device['room'] = ''
            inventory['room_metadata_status'] = 'unavailable'
    # Prevent a failed re-login/sync from pairing an old device list with a
    # different Xiaomi account. This fingerprint never leaves the private vault.
    inventory['account_fingerprint'] = hashlib.sha256(str(store.load()['userId']).encode('utf-8')).hexdigest()
    # Same-account refresh preserves an explicit opt-out. New/account-changed
    # inventories use defaults, never another account's grant or device flags.
    try:
        old = store.load_inventory()
    except FileNotFoundError:
        old = {}
    if old.get('account_fingerprint') == inventory['account_fingerprint'] and old.get('control_selection_version') == 1:
        inventory['control_selection_version'] = 1
        inventory['control_granted'] = old.get('control_granted') is True
        for alias, device in inventory['devices'].items():
            device['enabled'] = old.get('devices', {}).get(alias, {}).get('enabled') is True
    inventory = prepare_inventory(inventory, store.directory)
    inventory['suggested_config'] = generated_config(inventory, store.directory)
    store.save_inventory(inventory)
    return inventory

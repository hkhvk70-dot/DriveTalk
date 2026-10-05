"""Provider-neutral public tools; no DID, credentials or arbitrary URLs."""
import copy
import math


DEVICE = {'type': 'string', 'pattern': '^[a-zA-Z0-9_-]+$', 'minLength': 1, 'maxLength': 64}


def tool(name, description, properties, required):
    return {'name': name, 'description': description, 'inputSchema': {
        'type': 'object', 'properties': properties, 'required': required,
        'additionalProperties': False}}


TOOLS = [
    tool('toggle_light', '明确设置灯泡开关及可选亮度、色温；不能反转状态。', {
        'device_id': DEVICE, 'on': {'type': 'boolean'},
        'brightness': {'type': 'integer', 'minimum': 1, 'maximum': 100},
        'color_temperature': {'type': 'integer', 'minimum': 1500, 'maximum': 9000},
    }, ['device_id', 'on']),
    tool('toggle_plug', '明确设置插座开关。', {
        'device_id': DEVICE, 'on': {'type': 'boolean'},
    }, ['device_id', 'on']),
    tool('camera_snapshot', '按本轮明确请求抓拍；未适配时返回不可用。', {
        'device_id': DEVICE,
    }, ['device_id']),
    tool('camera_record_clip', '按本轮明确请求录制指定时长的视频。', {
        'device_id': DEVICE, 'seconds': {'type': 'integer', 'minimum': 1, 'maximum': 30},
    }, ['device_id', 'seconds']),
    tool('set_climate', '明确设置家居空调开关、目标温度、模式或风速；不控制车辆空调。', {
        'device_id': DEVICE, 'on': {'type': 'boolean'},
        'target_temperature': {'type': 'number', 'minimum': 16, 'maximum': 32},
        'mode': {'type': 'string', 'enum': ['cool', 'heat', 'fan', 'dry', 'auto']},
        'fan_level': {'type': 'string', 'enum': ['auto', 'low', 'medium', 'high']},
    }, ['device_id']),
]
KINDS = dict(zip((item['name'] for item in TOOLS), ('light', 'plug', 'camera', 'camera', 'climate')))


def list_tools():
    return copy.deepcopy(TOOLS)


def openai_tools(names):
    return [{'type': 'function', 'function': {
        'name': item['name'], 'description': item['description'],
        'parameters': copy.deepcopy(item['inputSchema'])}}
        for item in TOOLS if item['name'] in names]


def validate(name, args):
    schema = next((item['inputSchema'] for item in TOOLS if item['name'] == name), None)
    if schema is None or not isinstance(args, dict):
        raise ValueError('未知工具或参数格式错误')
    if not set(schema['required']).issubset(args) or not set(args).issubset(schema['properties']):
        raise ValueError('参数缺失或含额外字段')
    if name == 'set_climate' and (len(args) == 1 or (args.get('on') is False and len(args) > 2)):
        raise ValueError('空调需明确目标参数；关闭时不同时调整其他参数')
    import re
    for key, value in args.items():
        rule = schema['properties'][key]
        if rule['type'] == 'boolean' and type(value) is not bool:
            raise ValueError('开关必须为布尔值')
        if rule['type'] == 'integer':
            if type(value) is not int or not rule['minimum'] <= value <= rule['maximum']:
                raise ValueError('数值超出范围')
        if rule['type'] == 'number':
            if type(value) not in (int, float) or not math.isfinite(value) or not rule['minimum'] <= value <= rule['maximum']:
                raise ValueError('数值超出范围')
        if rule['type'] == 'string':
            if not isinstance(value, str) or len(value) > 64 or (
                    value not in rule['enum'] if 'enum' in rule else not re.fullmatch(rule['pattern'], value)):
                raise ValueError('设备编号无效')

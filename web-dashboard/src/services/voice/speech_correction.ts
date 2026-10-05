export interface SpeechCorrection {
  original: string;
  text: string;
  needsReview: boolean;
}

const digits: Record<string, number> = {零:0,〇:0,一:1,二:2,两:2,三:3,四:4,五:5,六:6,七:7,八:8,九:9};

/** 只解析明确数字，不让聊天模型猜温度，也不修改设备/动作目标。 */
function temperatureNumber(input: string): number | null {
  if (/^\d{1,2}(?:\.\d{1,2})?$/.test(input)) return Number(input);
  const parts = input.split('点');
  if (parts.length > 2) return null;
  const whole = parts[0];
  let integer: number;
  if (/^[零〇一二两三四五六七八九]{1,2}$/.test(whole)) {
    integer = Number([...whole].map(char => digits[char]).join(''));
  } else {
    const match = /^([一二两三四五六七八九]?)十([一二三四五六七八九]?)$/.exec(whole);
    if (!match) return null;
    integer = (match[1] ? digits[match[1]] : 1) * 10 + (match[2] ? digits[match[2]] : 0);
  }
  if (parts.length === 1) return integer;
  if (!/^[零〇一二三四五六七八九]{1,2}$/.test(parts[1])) return null;
  return Number(`${integer}.${[...parts[1]].map(char => digits[char]).join('')}`);
}

/**
 * 仅用于 ASR 最终结果。整句白名单：不改普通聊天、否定/问句、复合指令、设备名称。
 * 中文数字是等价格式化；同音词只是建议，必须人工确认，不能自动进入控车。
 * 它不是准确率/置信度模型，未匹配的识别错误仍可能存在。
 */
export function correctSpeechTemperature(original: string): SpeechCorrection {
  const unchanged = {original, text:original, needsReview:false};
  const match = /^(请帮我|麻烦帮我|帮我|请|麻烦)?(把|将)?((?:车内|车上|车辆|汽车|特斯拉)?空调)(?:的?温度)?(调整至|调整到|调至|调到|调为|设置为|设置成|设置到|设为|设到|跳至|跳到|调制)\s*([零〇一二两三四五六七八九十点是时\d.\s]+?)\s*(摄氏度|度|℃|°C|°)([。！!，,；;]?)$/u.exec(original);
  if (!match) return unchanged;
  const rawNumber = match[5].replace(/\s/g, '');
  let number = temperatureNumber(rawNumber);
  let needsReview = ['跳至','跳到','调制'].includes(match[4]);
  if (number === null && /^[零〇一二两三四五六七八九点是时]+$/.test(rawNumber)
      && /[是时]/.test(rawNumber)) {
    // “二是一”→“二十一”只能作为候选，不能静默自动执行。
    number = temperatureNumber(rawNumber.replace(/[是时]/g, '十'));
    needsReview = true;
  }
  // 不截断/钳制未知数字或越界值，不把 221 度擅自改成 21 度。
  if (number === null || number < 15 || number > 28) return {...unchanged, needsReview:true};
  return {
    original,
    text:`${match[1] ?? ''}${match[2] ?? ''}${match[3]}调至${number}度${match[7]}`,
    needsReview,
  };
}

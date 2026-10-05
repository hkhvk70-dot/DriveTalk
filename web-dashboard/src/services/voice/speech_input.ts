import { correctSpeechTemperature } from './speech_correction.ts';

interface RecognitionResult { isFinal: boolean; 0: {transcript: string} }
export interface SpeechEngine {
  lang: string; continuous: boolean; interimResults: boolean; maxAlternatives: number;
  onresult: ((event: {resultIndex: number; results: ArrayLike<RecognitionResult>}) => void) | null;
  onerror: ((event: {error: string}) => void) | null;
  onend: (() => void) | null;
  onstatus?: ((status: 'loading' | 'ready' | 'finalizing') => void) | null;
  start(): void; abort(): void; stop?(): void;
}
export interface NativeSpeechBridge { version: number; available: boolean; silenceMs?: number; engine?: string; cloudPcm?: boolean; request(action: 'start' | 'cancel' | 'begin' | 'end' | 'continue' | 'stop' | 'cloud-prepare' | 'cloud-continue' | 'cloud-record' | 'cloud-heard', id: string): boolean }
type SpeechWindow = {SpeechRecognition?: new () => SpeechEngine; webkitSpeechRecognition?: new () => SpeechEngine;
  __DriveTalkNativeSpeech?: NativeSpeechBridge};
export function speechFactory(surface: SpeechWindow = window as unknown as SpeechWindow): (() => SpeechEngine) | undefined {
  const native = surface.__DriveTalkNativeSpeech;
  if (native && [1,2,3,4].includes(native.version)) return native.available ? () => new NativeSpeechEngine(native, window) : undefined;
  const Constructor = surface.SpeechRecognition ?? surface.webkitSpeechRecognition;
  return Constructor ? () => new Constructor() : undefined;
}

export const SPEECH_TEXT_LIMIT = 12000;
// 原生120秒后优雅停止并等待5秒结果；网页多留1秒，避免竞争取消原生最终回调。
export const SPEECH_CAPTURE_LIMIT_MS = 126000;
export function speechTimingHint(surface: SpeechWindow = window as unknown as SpeechWindow): string {
  const native = surface.__DriveTalkNativeSpeech;
  if ([3,4].includes(native?.version ?? 0) && native?.engine === 'offline-vosk') return '手动备用：手机本地离线识别；停说约2秒结束，最长2分钟。小型中文模型可能误识别，控车前请核对文字。';
  if (native?.version === 3) return native.silenceMs === 2000
    ? '已请求停止说话后2秒结束收音（由手机识别服务决定）；单段保护上限2分钟。'
    : '此 APK 仍请求2.5秒停顿，请安装2.0.6或更新版本以使用2秒设置。';
  if (native) return '旧版 APK 仍有20秒限制，请安装2.0.6或更新版本以使用2秒停顿设置。';
  return '网页识别结束时机由浏览器决定；2秒停顿设置需要新版 Android APK。';
}

let session = false;
export function speechSessionActive(): boolean { return session; }
export function beginSpeechSession(): boolean {
  const native = (window as unknown as SpeechWindow).__DriveTalkNativeSpeech;
  if (native && ![2,3,4].includes(native.version)) return false; // 旧 APK 不冒称支持自动续听。
  session = !native || native.request('begin', crypto.randomUUID());
  return session;
}
export function endSpeechSession(): void {
  session = false;
  const native = (window as unknown as SpeechWindow).__DriveTalkNativeSpeech;
  if (native && [2,3,4].includes(native.version)) native.request('end', crypto.randomUUID());
}

/** Android 只回传识别文字/有限错误码；识别结果不会自动进入 AI 或车辆执行器。 */
export class NativeSpeechEngine implements SpeechEngine {
  lang = 'zh-CN'; continuous = false; interimResults = false; maxAlternatives = 1;
  onresult: SpeechEngine['onresult'] = null;
  onerror: SpeechEngine['onerror'] = null;
  onend: SpeechEngine['onend'] = null;
  onstatus: SpeechEngine['onstatus'] = null;
  private id: string | undefined;
  private bridge: NativeSpeechBridge;
  private events: EventTarget;
  constructor(bridge: NativeSpeechBridge, events: EventTarget) { this.bridge = bridge; this.events = events; }
  start(): void {
    if (this.id) return; // 同一引擎重复启动不能取消正在识别的半句。
    this.id = crypto.randomUUID();
    this.events.addEventListener('drivetalk-native-speech', this.receive);
    try { if (!this.bridge.request(session && [2,3,4].includes(this.bridge.version) ? 'continue' : 'start', this.id)) throw new Error('原生收音请求未允许'); }
    catch (error) { this.abort(); throw error; }
  }
  stop(): void {
    if (!this.id) return;
    if (![3,4].includes(this.bridge.version) || !this.bridge.request('stop', this.id)) this.onerror?.({error:'stopped'});
  }
  abort(): void {
    const id = this.id; this.id = undefined;
    this.events.removeEventListener('drivetalk-native-speech', this.receive);
    if (id) this.bridge.request('cancel', id);
  }
  private receive = (event: Event): void => {
    const value = (event as CustomEvent).detail;
    if (!this.id || value?.id !== this.id) return;
    if (['result','partial','draft'].includes(value.type) && typeof value.text === 'string') {
      if (value.text.length > SPEECH_TEXT_LIMIT) {this.onerror?.({error:'too-long'}); return;}
      this.onresult?.({resultIndex:0,results:[{isFinal:value.type === 'result',0:{transcript:value.text}}]});
      if (value.type === 'draft') this.onerror?.({error:['timeout','too-long','offline-unavailable','audio-capture','not-allowed'].includes(value.reason) ? value.reason : 'stopped'});
    } else if (value.type === 'error') this.onerror?.({error:String(value.error)});
    else if (value.type === 'status' && ['loading','ready'].includes(value.text)) this.onstatus?.(value.text);
  };
}
/** 半双工：只在用户点击时收音；最终结果只填入输入框，不执行车辆动作。 */
export class SpeechInput {
  private engine: SpeechEngine | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private finalTimer: ReturnType<typeof setTimeout> | undefined;
  private preview = '';
  private stopping: 'timeout' | 'stopped' | undefined;
  private readonly factory: () => SpeechEngine;
  private readonly onText: (text: string) => void;
  private readonly onActive: (active: boolean) => void;
  private readonly onError: (message: string, code?: string) => void;
  private readonly onPreview: (text: string) => void;
  private readonly onStatus: (status: 'loading' | 'ready' | 'finalizing' | 'idle') => void;
  constructor(factory: () => SpeechEngine, onText: (text: string) => void,
    onActive: (active: boolean) => void, onError: (message: string, code?: string) => void,
    onPreview: (text: string) => void = () => {},
    onStatus: (status: 'loading' | 'ready' | 'finalizing' | 'idle') => void = () => {}) {
    this.factory = factory; this.onText = onText; this.onActive = onActive; this.onError = onError; this.onPreview = onPreview;
    this.onStatus = onStatus;
  }
  start(): void {
    if (this.engine) return; // 定时续听和点击竞争时只启动一次，保留当前草稿。
    this.preview = ''; this.stopping = undefined;
    const engine = this.factory(); this.engine = engine;
    engine.onstatus = status => {if (this.engine === engine) this.onStatus(status);};
    engine.lang = 'zh-CN'; engine.continuous = false; engine.interimResults = true; engine.maxAlternatives = 1;
    engine.onresult = event => {
      if (this.engine !== engine) return;
      const result = event.results[event.resultIndex];
      const text = result?.[0]?.transcript?.trim();
      if (text && text.length > SPEECH_TEXT_LIMIT) {this.fail('too-long'); return;}
      if (text) {this.preview = text; this.onPreview(text);} // 最新假设替换旧假设，不重复拼接，不发送指令。
      if (!result?.isFinal) return;
      if (this.stopping) {this.fail(this.stopping); return;}
      this.abort();
      if (text) {
        const correction = correctSpeechTemperature(text);
        if (correction.needsReview) {
          this.onPreview(correction.text);
          this.onError(`识别原文：“${correction.original}”。${correction.text !== correction.original
            ? `建议：“${correction.text}”。` : '温度数字无法明确确认。'}已暂停连续会话，本句未自动发送；请核对或修改文字后点击发送。`, 'recognition-review');
        } else this.onText(correction.text);
      }
      else this.onError('没有识别到有效短句，请重试或使用键盘输入。');
    };
    engine.onerror = event => {if (this.engine === engine) {
      this.fail(this.stopping ?? event.error);
    }};
    engine.onend = () => {if (this.engine === engine) this.fail(this.stopping ?? 'ended');};
    this.timer = setTimeout(() => this.stop('timeout'), SPEECH_CAPTURE_LIMIT_MS);
    try {this.onActive(true); engine.start();}
    catch {this.abort(); this.onError('无法启动语音识别，请使用输入法语音输入。', 'unavailable');}
  }
  /** 用户停止/保护时限只保留草稿；等待最终结果，不直接取消或自动执行半句。 */
  stop(reason: 'timeout' | 'stopped' = 'stopped'): void {
    if (!this.engine || this.stopping) return;
    this.stopping = reason; clearTimeout(this.timer);
    if (!this.engine.stop) {this.fail(reason); return;}
    this.finalTimer = setTimeout(() => this.fail(reason), 6000);
    try {this.engine.stop();} catch {this.fail(reason);}
  }
  private fail(code: string): void {
    if (!this.engine) return;
    const draft = this.preview;
    this.abort();
    const reasons: Record<string,string> = {
      'not-allowed':'麦克风权限未允许，请在系统设置中允许 DriveTalk 使用麦克风。',
      network:'手机系统语音识别服务报告网络失败，已暂停连续会话，不再自动重启收音。请检查系统语音识别服务，或使用输入法语音输入。',
      'no-speech':'没有识别到清晰语音，请重试。',
      timeout:'本段收音达到保护时限，已停止。',
      stopped:'已停止收音。',
      ended:'识别服务已结束，但未返回完整结果。',
      'too-long':'识别文字过长，已停止收音。',
      busy:'系统语音识别服务正忙，请稍后再试。',
      'offline-unavailable':'手机本地识别模型或录音初始化失败，已停止；没有切回网络识别，也没有重发消息。',
      'audio-capture':'手机麦克风读取失败，已停止；请检查录音权限或其他正在使用麦克风的应用。',
      'asr-network':'阿里云识别连接中断，已暂停连续会话；没有切换引擎或重发录音。',
      'asr-timeout':'阿里云识别连接或最终结果超时，已停止。',
      'asr-config':'阿里云识别配置未就绪、已变更或登录失效，请检查设置。',
      'asr-provider':'阿里云拒绝识别任务，请检查百炼北京区 Key、Workspace、模型权限和额度。',
      'asr-quota':'已达到本应用识别频次或音频时长上限，已停止。',
      'asr-rate-limit':'阿里云识别服务正在限流，已停止；请稍后手动重试。',
      'asr-backpressure':'音频上传拥塞，已停止；未丢弃中间语音继续执行。',
      'asr-protocol':'识别响应格式异常，已停止。',
      'asr-incomplete':'识别任务结束但完整文字未确认，已停止。',
    };
    if (draft) this.onPreview(draft);
    // 有半句时禁用自动续听/发送，防止覆盖草稿或执行不完整的车/家指令。
    this.onError((reasons[code] ?? '系统语音识别不可用，请使用输入法语音输入。')
      + (draft ? '已保留识别草稿，未自动发送；请确认后再发送。' : '没有可保留的识别文字。'), draft ? 'draft' : code);
  }
  abort(): void {
    const engine = this.engine; this.engine = undefined; clearTimeout(this.timer); clearTimeout(this.finalTimer);
    if (engine) {
      engine.onresult = engine.onerror = engine.onend = null;
      engine.onstatus = null;
      try {engine.abort();} catch { /* 收音已结束。 */ }
    }
    this.onActive(false);
    this.onStatus('idle');
  }
  get isActive(): boolean { return this.engine !== undefined; }
}

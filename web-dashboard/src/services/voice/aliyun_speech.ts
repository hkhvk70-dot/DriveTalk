import type { SpeechEngine, NativeSpeechBridge } from './speech_input.ts';

interface Capture {
  prepare(): Promise<void>;
  start(): void;
  stop(): void;
  abort(): void;
  heard(): void;
}
interface CaptureCallbacks { pcm(bytes: Uint8Array): void; ready(): void; ended(reason: string): void }
type CaptureFactory = (id: string, callbacks: CaptureCallbacks) => Capture;
type SocketFactory = (url: string) => WebSocket;
export function cloudCaptureSupported(): boolean {
  const native = (window as unknown as {__DriveTalkNativeSpeech?: NativeSpeechBridge}).__DriveTalkNativeSpeech;
  return native ? native.version === 4 && native.cloudPcm === true : !!navigator.mediaDevices?.getUserMedia && !!window.AudioContext;
}

/** 一次收音对应一个 WS 任务，所有分句仅预览；只有本机正常停说+task-finished 才是最终结果。 */
export class AliyunSpeechEngine implements SpeechEngine {
  lang = 'zh-CN'; continuous = false; interimResults = true; maxAlternatives = 1;
  onresult: SpeechEngine['onresult'] = null;
  onerror: SpeechEngine['onerror'] = null;
  onend: SpeechEngine['onend'] = null;
  onstatus: SpeechEngine['onstatus'] = null;
  private id?: string;
  private socket?: WebSocket;
  private capture?: Capture;
  private timer?: ReturnType<typeof setTimeout>;
  private stopReason?: string;
  private lastText = '';
  private ready = false;
  private readonly continuing: () => boolean;
  private readonly makeSocket: SocketFactory;
  private readonly makeCapture: CaptureFactory;
  constructor(continuing: () => boolean = () => false, makeSocket: SocketFactory = url => new WebSocket(url), makeCapture?: CaptureFactory) {
    this.continuing = continuing; this.makeSocket = makeSocket;
    this.makeCapture = makeCapture ?? ((id, callbacks) => {
      const native = (window as unknown as {__DriveTalkNativeSpeech?: NativeSpeechBridge}).__DriveTalkNativeSpeech;
      return native ? new NativePcmCapture(native, id, callbacks, this.continuing()) : new BrowserPcmCapture(callbacks);
    });
  }
  start(): void {
    if (this.id) return;
    const id = crypto.randomUUID(); this.id = id; this.lastText = ''; this.ready = false; this.stopReason = undefined;
    this.onstatus?.('loading');
    const callbacks: CaptureCallbacks = {
      pcm: bytes => {
        if (this.id !== id) return;
        const ws = this.socket;
        if (!this.ready || this.stopReason || !ws || ws.readyState !== 1) {this.fail('asr-network'); return;}
        if (ws.bufferedAmount > 64000) {this.fail('asr-backpressure'); return;}
        if (!bytes.length || bytes.length > 16384 || bytes.length % 2) {this.fail('audio-capture'); return;}
        try {ws.send(bytes);} catch {this.fail('asr-network');}
      },
      ready: () => {if (this.id === id) this.onstatus?.('ready');},
      ended: reason => {
        if (this.id !== id) return;
        if (['complete','stopped','timeout','no-speech'].includes(reason)) this.finishCapture(reason);
        else this.fail(reason);
      },
    };
    this.capture = this.makeCapture(id, callbacks);
    // 在用户点击时请求授权；task-started 前不上传（浏览器授权会启动媒体轨道）。
    this.timer = setTimeout(() => this.fail('asr-timeout'), 60000);
    void this.capture.prepare().then(() => {
      if (this.id !== id) return;
      const location = window.location;
      if (location.protocol !== 'https:') {this.fail('asr-config'); return;}
      clearTimeout(this.timer);
      this.timer = setTimeout(() => this.fail('asr-timeout'), 18000);
      try {
        const ws = this.makeSocket(`wss://${location.host}/v1/vehicle/ai/asr/live`); this.socket = ws;
        ws.onopen = () => {if (this.id === id) ws.send(JSON.stringify({event:'start',turnId:id}));};
        ws.onmessage = event => {if (this.id === id) this.receive(event.data);};
        ws.onerror = ws.onclose = () => {if (this.id === id) this.fail('asr-network');};
      } catch {this.fail('asr-network');}
    }).catch(() => {if (this.id === id) this.fail('not-allowed');});
  }
  private receive(raw: unknown): void {
    try {
      if (typeof raw !== 'string' || raw.length > 100000) throw Error();
      const value = JSON.parse(raw);
      if (value.event === 'error') {
        this.fail(['asr-config','asr-quota','asr-provider','asr-protocol','asr-rate-limit','asr-timeout','too-long'].includes(value.code) ? value.code : 'asr-network'); return;
      }
      if (value.turnId !== this.id) throw Error();
      if (value.event === 'ready' && !this.ready && !this.stopReason) {
        this.ready = true; clearTimeout(this.timer);
        this.timer = setTimeout(() => this.fail('timeout'), 125000);
        this.capture?.start(); return;
      }
      if (!this.ready || !['partial','finish'].includes(value.event) || typeof value.text !== 'string' || value.text.length > 12000) throw Error();
      if (value.text !== this.lastText && value.text.trim()) this.capture?.heard();
      this.lastText = value.text;
      const final = value.event === 'finish' && value.reason === 'complete' && this.stopReason === 'complete';
      if (final && !value.text.trim()) {this.fail('no-speech'); return;}
      if (value.event === 'finish' && !this.stopReason) throw Error();
      if (final) {
        const callback = this.onresult; this.abort();
        callback?.({resultIndex:0,results:[{isFinal:true,0:{transcript:value.text}}]}); return;
      }
      this.onresult?.({resultIndex:0,results:[{isFinal:final,0:{transcript:value.text}}]});
      if (value.event === 'finish' && !final) this.fail(['timeout','stopped','no-speech'].includes(value.reason) ? value.reason : 'asr-incomplete');
    } catch {this.fail('asr-protocol');}
  }
  private finishCapture(reason: string): void {
    if (!this.id || this.stopReason) return;
    if (!this.ready || this.socket?.readyState !== 1) {this.fail('asr-network'); return;}
    this.stopReason = reason; clearTimeout(this.timer);
    this.onstatus?.('finalizing');
    this.timer = setTimeout(() => this.fail('asr-timeout'), 10000);
    try {this.socket.send(JSON.stringify({event:'stop',reason}));} catch {this.fail('asr-network');}
  }
  stop(): void { if (!this.ready) this.fail('stopped'); else this.capture?.stop(); }
  private fail(code: string): void {
    if (!this.id) return;
    this.abort(); this.onerror?.({error:code});
  }
  abort(): void {
    this.id = undefined; clearTimeout(this.timer);
    this.capture?.abort(); this.capture = undefined;
    const ws = this.socket; this.socket = undefined;
    if (ws) {ws.onopen = ws.onmessage = ws.onerror = ws.onclose = null; ws.close();}
  }
}

class NativePcmCapture implements Capture {
  private resolve?: () => void;
  private reject?: () => void;
  private active = false;
  private bridge: NativeSpeechBridge;
  private id: string;
  private callbacks: CaptureCallbacks;
  private continuing: boolean;
  constructor(bridge: NativeSpeechBridge, id: string, callbacks: CaptureCallbacks, continuing: boolean) {
    this.bridge = bridge; this.id = id; this.callbacks = callbacks; this.continuing = continuing;
  }
  prepare(): Promise<void> {
    if (this.bridge.version !== 4 || !this.bridge.cloudPcm) return Promise.reject(Error('APK needs upgrade'));
    this.active = true; window.addEventListener('drivetalk-native-speech', this.receive);
    return new Promise((resolve, reject) => {
      this.resolve = resolve; this.reject = () => reject(Error('Microphone unavailable'));
      try {if (!this.bridge.request(this.continuing ? 'cloud-continue' : 'cloud-prepare', this.id)) this.reject();}
      catch {this.reject();}
    });
  }
  start(): void {if (!this.bridge.request('cloud-record', this.id)) this.callbacks.ended('audio-capture');}
  stop(): void {if (!this.bridge.request('stop', this.id)) this.callbacks.ended('stopped');}
  heard(): void {this.bridge.request('cloud-heard', this.id);}
  abort(): void {
    this.active = false; window.removeEventListener('drivetalk-native-speech', this.receive);
    try {this.bridge.request('cancel', this.id);} catch { /* 页面离开时原生仍会取消。 */ }
    this.reject?.(); this.resolve = this.reject = undefined;
  }
  private receive = (event: Event) => {
    const value = (event as CustomEvent).detail;
    if (!this.active || value?.id !== this.id) return;
    if (value.type === 'prepared') {this.resolve?.(); this.resolve = this.reject = undefined;}
    else if (value.type === 'status' && value.text === 'ready') this.callbacks.ready();
    else if (value.type === 'capture-end') this.callbacks.ended(String(value.reason));
    else if (value.type === 'error') {this.reject?.(); this.callbacks.ended(String(value.error));}
    else if (value.type === 'pcm') {
      try {
        if (typeof value.text !== 'string' || value.text.length > 22000) throw Error();
        this.callbacks.pcm(Uint8Array.from(atob(value.text), c => c.charCodeAt(0)));
      } catch {this.callbacks.ended('audio-capture');}
    }
  };
}

/** 普通浏览器路径；Android APK 使用上述原生 PCM 桥，不依赖 WebView 的网页录音权限。 */
class BrowserPcmCapture implements Capture {
  private active = false;
  private stream?: MediaStream;
  private context?: AudioContext;
  private node?: ScriptProcessorNode;
  private source?: MediaStreamAudioSourceNode;
  private startAt = 0; private lastVoice = 0; private voicedMs = 0; private heardVoice = false;
  private callbacks: CaptureCallbacks;
  constructor(callbacks: CaptureCallbacks) { this.callbacks = callbacks; }
  async prepare(): Promise<void> {
    this.active = true;
    this.context = new AudioContext({sampleRate:16000});
    // 先解锁 AudioContext；等待上游就绪才连接处理节点。
    await this.context.resume();
    const stream = await navigator.mediaDevices.getUserMedia({audio:{channelCount:1,echoCancellation:true,noiseSuppression:true},video:false});
    if (!this.active) {stream.getTracks().forEach(t => t.stop()); return;}
    this.stream = stream;
    if (this.context.sampleRate !== 16000) throw Error('Unsupported sample rate');
  }
  start(): void {
    if (!this.active || !this.context || !this.stream) {this.callbacks.ended('audio-capture'); return;}
    this.startAt = this.lastVoice = performance.now();
    this.source = this.context.createMediaStreamSource(this.stream);
    this.node = this.context.createScriptProcessor(2048, 1, 1);
    this.node.onaudioprocess = event => {
      if (!this.active) return;
      const samples = event.inputBuffer.getChannelData(0);
      const bytes = new Uint8Array(samples.length * 2), view = new DataView(bytes.buffer); let power = 0;
      samples.forEach((value, i) => {const pcm = Math.round(Math.max(-1, Math.min(1, value)) * 32767); view.setInt16(i * 2, pcm, true); power += pcm * pcm;});
      this.callbacks.pcm(bytes);
      if (!this.active) return;
      const now = performance.now();
      this.voicedMs = Math.sqrt(power / samples.length) >= 350 ? this.voicedMs + samples.length / 16 : 0;
      if (this.voicedMs >= 300) this.heard();
      if (now - this.startAt >= 120000) this.end('timeout');
      else if (this.heardVoice && now - this.lastVoice >= 2000) this.end('complete');
      else if (!this.heardVoice && now - this.startAt >= 15000) this.end('no-speech');
    };
    this.source.connect(this.node); this.node.connect(this.context.destination); // 输出始终为零，不回放麦克风。
    this.callbacks.ready();
  }
  heard(): void {this.heardVoice = true; this.lastVoice = performance.now();}
  stop(): void {this.end('stopped');}
  private end(reason: string): void {if (!this.active) return; this.abort(); this.callbacks.ended(reason);}
  abort(): void {
    this.active = false;
    if (this.node) {this.node.onaudioprocess = null; this.node.disconnect();}
    this.source?.disconnect(); this.stream?.getTracks().forEach(t => t.stop());
    if (this.context) void this.context.close().catch(() => {});
  }
}

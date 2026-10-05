export interface FishAudioOptions {
  turnId: string;
  signal: AbortSignal;
  onAudio: (bytes: Uint8Array, sequence: number, sampleRate: number, format?: 'mp3' | 'pcm_s16le') => void;
  /** 注入 socket 仅用于测试；生产地址固定为本机登录会话所在的 HTTPS 域。 */
  location?: Pick<Location, 'href'>;
  socketFactory?: (url: string) => WebSocket;
}

/** 浏览器只连接自己的代理。Fish Bearer Key 与 MessagePack 留在服务器。 */
export class FishAudioWs {
  readonly completed: Promise<void>;
  private socket: WebSocket;
  private resolveDone!: () => void;
  private rejectDone!: (error: Error) => void;
  private resolveReady!: () => void;
  private rejectReady!: (error: Error) => void;
  private ready: Promise<void>;
  private timer: ReturnType<typeof setTimeout>;
  private readyTimer: ReturnType<typeof setTimeout>;
  private ended = false;
  private textStopped = false;
  private connected = false;
  private sampleRate = 24000;
  private format: 'mp3' | 'pcm_s16le' = 'pcm_s16le';
  private textSequence = 0;
  private audioSequence = 0;
  private characters = 0;
  private receivedBytes = 0;
  private readonly options: FishAudioOptions;

  static async connect(options: FishAudioOptions): Promise<FishAudioWs> {
    options.signal.throwIfAborted();
    const session = new FishAudioWs(options);
    await session.ready;
    return session;
  }

  private constructor(options: FishAudioOptions) {
    this.options = options;
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(options.turnId)) throw new Error('语音回合标识无效');
    const page = new URL((options.location ?? window.location).href);
    if (page.protocol !== 'https:') throw new Error('语音连接需要 HTTPS');
    const url = new URL('/v1/vehicle/ai/voice/live', page);
    url.protocol = 'wss:';
    this.socket = (options.socketFactory ?? (value => new WebSocket(value)))(url.href);
    this.completed = new Promise<void>((resolve, reject) => { this.resolveDone = resolve; this.rejectDone = reject; });
    this.ready = new Promise<void>((resolve, reject) => { this.resolveReady = resolve; this.rejectReady = reject; });
    // ready 失败时调用者尚未拿到实例，completed 也可能已经拒绝。
    void this.completed.catch(() => {});
    this.socket.binaryType = 'arraybuffer';
    this.readyTimer = setTimeout(() => this.fail(new Error('语音连接超时，请暂时关闭朗读后发送文字')), 25000);
    this.timer = setTimeout(() => this.fail(new Error('语音回合超时')), 90_000);
    this.socket.onopen = () => {
      try { this.send({ event: 'start', turnId: options.turnId }); }
      catch (error) { this.fail(error instanceof Error ? error : new Error('语音连接失败')); }
    };
    this.socket.onmessage = event => {
      if (this.ended) return;
      try {
        if (event.data instanceof ArrayBuffer) {
          if (!this.connected) throw new Error('语音协议未就绪');
          this.receivedBytes += event.data.byteLength;
          if (!event.data.byteLength || event.data.byteLength > 1_000_000 || this.receivedBytes > 8_000_000) throw new Error('语音音频超出限制');
          options.onAudio(new Uint8Array(event.data), this.audioSequence++, this.sampleRate, this.format);
          return;
        }
        if (typeof event.data !== 'string' || event.data.length > 4096) throw new Error('语音协议无效');
        const value = JSON.parse(event.data);
        if (value?.turnId !== options.turnId) throw new Error('语音回合不匹配');
        if (value.event === 'ready' && !this.connected && (value.format === 'mp3' || (value.format === 'pcm_s16le' && Number.isInteger(value.sampleRate) && value.sampleRate >= 8000 && value.sampleRate <= 48000))) {
          this.format = value.format;
          this.sampleRate = value.format === 'mp3' ? 0 : value.sampleRate;
          this.connected = true; clearTimeout(this.readyTimer); this.resolveReady();
        } else if (value.event === 'finish' && value.reason === 'stop' && this.textStopped) {
          this.ended = true; this.cleanup(); this.resolveDone(); this.socket.close(1000);
        } else throw new Error(value.event === 'error' ? '语音合成失败，请检查后端配置或额度' : '语音协议未确认');
      } catch (error) { this.fail(error instanceof Error ? error : new Error('语音解析失败')); }
    };
    this.socket.onerror = () => this.fail(new Error('语音连接失败'));
    this.socket.onclose = () => { if (!this.ended) this.fail(new Error('语音连接提前中断')); };
    options.signal.addEventListener('abort', this.onAbort, { once: true });
    if (options.signal.aborted) this.onAbort();
  }

  sendSentence(text: string): void {
    if (!this.connected || this.textStopped || this.ended) throw new Error('语音会话不可写入');
    if (!text.trim() || Array.from(text).length > 300 || this.characters + text.length > 6000) throw new Error('语音文本超出限制');
    this.send({ event: 'text', sequence: this.textSequence++, text });
    this.characters += text.length;
  }

  finishText(): void {
    if (this.ended || this.textStopped) return;
    if (!this.connected) throw new Error('语音尚未连接');
    this.textStopped = true;
    this.send({ event: 'stop', sequences: this.textSequence });
  }

  cancel(): void { this.fail(new DOMException('语音已打断', 'AbortError')); }
  private onAbort = () => this.cancel();

  private send(value: object): void {
    if (this.ended) return;
    if (this.socket.readyState !== 1 || this.socket.bufferedAmount > 32_768) {
      const error = new Error('语音发送缓冲已满或连接中断'); this.fail(error); throw error;
    }
    try { this.socket.send(JSON.stringify(value)); }
    catch (error) {
      const failure = error instanceof Error ? error : new Error('语音发送失败');
      this.fail(failure); throw failure;
    }
  }

  private fail(error: Error): void {
    if (this.ended) return;
    this.ended = true; this.cleanup();
    this.rejectReady(error); this.rejectDone(error);
    this.socket.close(1000);
  }
  private cleanup(): void {
    clearTimeout(this.timer); clearTimeout(this.readyTimer);
    this.options.signal.removeEventListener('abort', this.onAbort);
  }
}

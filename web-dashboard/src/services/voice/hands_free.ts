export interface CaptureState {enabled:boolean; listening:boolean; sending:boolean; speaking:boolean; synthesizing:boolean; busy:boolean; hidden:boolean; preparing?:boolean}
export function canResumeCapture(state: CaptureState): boolean {
  return state.enabled && !state.preparing && !state.listening && !state.sending && !state.speaking && !state.synthesizing && !state.busy && !state.hidden;
}
/** 只重启识别；绝不重试模型请求、语音合成或车辆指令。 */
export function speechRecovery(code: string | undefined, failures: number) {
  if (code === 'no-speech') return {retry:true, delay:1500, failures};
  const count = failures + 1;
  // 网络故障不是静默结束，自动重启会反复开关麦克风；需用户明确再次开启。
  return {retry:code === 'busy' && count < 3, delay:count * 3000, failures:count};
}

/** 音频解锁期间不启动续听；停止/离页后迟到的 Promise 不能开启新麦克风会话。 */
export class CaptureStartup {
  private revision = 0;
  private pending = false;
  get preparing(): boolean { return this.pending; }
  cancel(): void { this.revision++; this.pending = false; }
  async start(prepare: () => Promise<void>, allowed: () => boolean, capture: () => void): Promise<boolean> {
    if (this.pending) return false;
    const ticket = ++this.revision;
    this.pending = true;
    try {
      await prepare();
      if (ticket !== this.revision || !allowed()) return false;
      capture(); return true;
    } catch (error) {
      if (ticket !== this.revision) return false;
      throw error;
    } finally { if (ticket === this.revision) this.pending = false; }
  }
}

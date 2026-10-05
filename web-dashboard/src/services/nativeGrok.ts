import type { GrokEvent, GrokConfig } from './grokApi';

interface Bridge { version: number; request(payload: Record<string, unknown>): boolean }
type NativeWindow = Window & { __DriveTalkNativeGrok?: Bridge };
export function nativeGrokAvailable(): boolean {
  return typeof window !== 'undefined' && [1,2].includes((window as NativeWindow).__DriveTalkNativeGrok?.version ?? 0);
}
export function nativeGrokConversationAvailable(): boolean {
  return typeof window !== 'undefined' && (window as NativeWindow).__DriveTalkNativeGrok?.version === 2;
}
export interface GrokHistoryMessage { role:'user'|'assistant'; content:string }
export function grokHistory(turns: readonly {provider:string;status:string;question:string;answer:string}[]): GrokHistoryMessage[] {
  // 仅最近成功 Grok 对话，排除 DeepSeek、错误/中断半句、执行状态、GPS和凭据；只在内存保存。
  const history: GrokHistoryMessage[]=[];let length=0;
  for (const turn of [...turns].reverse()) {
    if (turn.provider!=='Grok'||turn.status!=='no_command'||!turn.question.trim()||!turn.answer.trim()) continue;
    const size=turn.question.length+turn.answer.length;
    if (history.length+2>12 || length+size>12000) break;
    history.unshift({role:'user',content:turn.question},{role:'assistant',content:turn.answer});length+=size;
  }
  return history;
}

// 不用 fetch：请求由 Android TLS 网络层发出，Key 不返回网页或存入 localStorage。
export function nativeGrokRequest(
  payload: Record<string, unknown>, signal?: AbortSignal, onEvent?: (event: GrokEvent) => void,
  target: Window = window,
): Promise<GrokConfig | void> {
  return new Promise((resolve, reject) => {
    const bridge = (target as NativeWindow).__DriveTalkNativeGrok;
    if (!bridge || ![1,2].includes(bridge.version)) {reject(new Error('手机直连 Grok 需要新版 Android APK。')); return;}
    if (payload.action==='chat'&&bridge.version!==2) {reject(new Error('请升级到2.0.4 APK，旧版仍有固定提示词且不支持多轮上下文。'));return;}
    if (signal?.aborted) {reject(new Error('请求已停止')); return;}
    const id = crypto.randomUUID(); let sequence = 0, settled = false;
    const cleanup = () => {clearTimeout(timer); target.removeEventListener('drivetalk-native-grok', receive); signal?.removeEventListener('abort', abort);};
    const finish = (error?: Error, config?: GrokConfig) => {
      if (settled) return; settled = true; cleanup(); if (error) reject(error); else resolve(config);
    };
    const abort = () => {bridge.request({action:'cancel',id}); finish(new Error('Grok 回复已停止；未发送车辆动作。'));};
    const receive = (event: Event) => {
      const data = (event as CustomEvent).detail;
      if (!data || data.id !== id || settled) return;
      try {
        if (data.type === 'error') finish(new Error(typeof data.message === 'string' ? data.message : 'Grok 连接失败'));
        else if (data.type === 'config') {
          if ('apiKey' in data || typeof data.configured !== 'boolean' || typeof data.enabled !== 'boolean' || typeof data.model !== 'string' || typeof data.persona !== 'string') throw new Error('本机配置响应无效');
          finish(undefined, {configured:data.configured,enabled:data.enabled,model:data.model,persona:data.persona});
        } else if (data.type === 'text_delta') {
          if (data.sequence !== sequence++ || typeof data.message !== 'string') throw new Error('Grok 文本流顺序异常');
          onEvent?.({type:'text_delta',turnId:id,sequence:data.sequence,message:data.message});
        } else if (data.type === 'text_done') onEvent?.({type:'text_done',turnId:id});
        else if (data.type === 'result') onEvent?.({type:'result',status:'no_command',message:'手机直连 Grok；未发送车辆动作。',commandSent:false});
        else if (data.type === 'done') finish();
      } catch (error) {bridge.request({action:'cancel',id}); finish(error instanceof Error ? error : new Error('Grok 回复异常'));}
    };
    const timer = setTimeout(() => {bridge.request({action:'cancel',id}); finish(new Error('手机直连 Grok 超时，请检查手机代理是否覆盖 DriveTalk；未自动重试。'));}, payload.action === 'chat' ? 125000 : 15000);
    target.addEventListener('drivetalk-native-grok', receive); signal?.addEventListener('abort', abort, {once:true});
    try { if (!bridge.request({...payload,id})) finish(new Error('本机 Grok 正忙或未允许请求，请稍后手动重试。')); }
    catch {finish(new Error('本机 Grok 接口不可用'));}
  });
}
export async function nativeGrokConfig(updates?: {apiKey?:string;model?:string;persona?:string;enabled?:boolean;clear?:boolean}): Promise<GrokConfig> {
  const config = await nativeGrokRequest({action:updates ? 'save' : 'config',...updates});
  if (!config) throw new Error('本机配置未返回');
  return config;
}
export async function chatNativeGrok(message: string, _allowControl: boolean, signal: AbortSignal, onEvent: (event:GrokEvent)=>void, history:GrokHistoryMessage[]=[]): Promise<void> {
  if (!message.trim() || message.length > 2000) throw new Error('消息长度须为1–2000字');
  await nativeGrokRequest({action:'chat',message,history},signal,onEvent);
}

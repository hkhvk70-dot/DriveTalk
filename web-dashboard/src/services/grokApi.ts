import { parseVehicleResponse } from './vehicleApi.ts';
import type { VehicleData } from '../types/tesla.ts';

export interface GrokConfig { configured: boolean; enabled: boolean; model: string; persona: string }
export type GrokEvent =
  | { type: 'text_delta'; turnId: string; sequence: number; message: string }
  | { type: 'text_done'; turnId: string }
  | { type: 'status' | 'text' | 'tool_call'; message: string }
  | { type: 'result'; status: string; message: string; commandSent?: boolean | null; target?: 'home' }
  | { type: 'snapshot'; data: VehicleData; fresh: boolean }
  | { type: 'usage'; promptTokens?: number; completionTokens?: number };

let cooldownUntil = 0;
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

async function failure(response: Response): Promise<never> {
  const payload: unknown = await response.json().catch(() => null);
  const header = response.headers.get('Retry-After');
  if (response.status === 429) {
    const seconds = header && /^\d+$/.test(header) ? Number(header) : 60;
    cooldownUntil = Date.now() + Math.max(1, seconds) * 1000;
  }
  const message = object(payload) && typeof payload.message === 'string' && payload.message.length < 300 ? payload.message : `AI 服务返回 HTTP ${response.status}`;
  throw new Error(`${message}；未自动重试`);
}

/** Key only exists briefly in the password field and encrypted same-origin POST. */
export async function grokConfig(updates?: { apiKey?: string; model?: string; enabled?: boolean; clear?: boolean; persona?: string }, fetcher: typeof fetch = fetch): Promise<GrokConfig> {
  const response = await fetcher('/v1/vehicle/ai/deepseek/config', {
    method: updates ? 'POST' : 'GET', credentials: 'same-origin', cache: 'no-store',
    headers: { Accept: 'application/json', ...(updates ? { 'Content-Type': 'application/json' } : {}) },
    signal: AbortSignal.timeout(12_000), ...(updates ? { body: JSON.stringify(updates) } : {}),
  });
  if (!response.ok) return failure(response);
  const value: unknown = await response.json();
  if (!object(value) || 'apiKey' in value || typeof value.configured !== 'boolean' || typeof value.enabled !== 'boolean' || typeof value.model !== 'string' || typeof value.persona !== 'string' || value.persona.length > 2000) throw new Error('AI 配置响应无效');
  return { configured: value.configured, enabled: value.enabled, model: value.model, persona: value.persona };
}

/** POST SSE, not EventSource: no keys/commands in URL, no automatic replay. */
export async function chatGrok(message: string, allowControl: boolean, signal: AbortSignal, onEvent: (event: GrokEvent) => void, fetcher: typeof fetch = fetch, options: { allowHomeControl?: boolean; conversationId?: string } = {}): Promise<void> {
  if (!message.trim() || message.length > 2000) throw new Error('请输入 1–2000 字的消息');
  if (Date.now() < cooldownUntil) throw new Error(`AI 冷却中，还需等待 ${Math.ceil((cooldownUntil - Date.now()) / 1000)} 秒`);
  signal.throwIfAborted();
  if (options.conversationId !== undefined && !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(options.conversationId)) throw new Error('家居会话标识无效');
  const requestId = crypto.randomUUID();
  let textSequence = 0, textEnded = false;
  const response = await fetcher('/v1/vehicle/ai/deepseek/chat', {
    method: 'POST', credentials: 'same-origin', cache: 'no-store',
    headers: { Accept: 'text/event-stream', 'Content-Type': 'application/json' },
    signal: AbortSignal.any([signal, AbortSignal.timeout(120_000)]),
    body: JSON.stringify({ requestId, message: message.trim(), allowControl,
      ...(options.conversationId ? { conversationId: options.conversationId } : {}),
      ...(options.allowHomeControl === true ? { allowHomeControl: true } : {}) }),
  });
  if (!response.ok) return failure(response);
  if (!response.body || !response.headers.get('Content-Type')?.includes('text/event-stream')) throw new Error('AI 流式接口尚未部署或响应无效');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '', done = false, total = 0;
  function frame(text: string) {
    const lines = text.split('\n');
    const event = lines.find(line => line.startsWith('event:'))?.slice(6).trim();
    const raw = lines.filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
    if (!raw || !event) return;
    const value: unknown = JSON.parse(raw);
    if (!object(value)) throw new Error('AI 流格式无效');
    if (event === 'done') { done = true; return; }
    if (event === 'error') {
      if (value.status === 429) cooldownUntil = Date.now() + (typeof value.retryAfter === 'number' && value.retryAfter > 0 ? value.retryAfter : 60) * 1000;
      throw new Error(typeof value.message === 'string' ? value.message.slice(0, 300) : 'AI 请求未确认');
    }
    if (event === 'text_delta') {
      if (textEnded || value.turnId !== requestId || value.sequence !== textSequence ||
          typeof value.text !== 'string' || !value.text || value.text.length > 8000) throw new Error('AI 文本增量缺失或乱序');
      onEvent({ type: 'text_delta', turnId: requestId, sequence: textSequence++, message: value.text });
    } else if (event === 'text_done') {
      if (textEnded || value.turnId !== requestId || value.sequences !== textSequence) throw new Error('AI 文本流结束标识无效');
      textEnded = true;
      onEvent({ type: 'text_done', turnId: requestId });
    } else if (event === 'snapshot') {
      const data = parseVehicleResponse({ response: value.response }).response;
      if (data && typeof value.fresh === 'boolean') onEvent({ type: 'snapshot', data, fresh: value.fresh });
    } else if (event === 'result' && typeof value.message === 'string' && typeof value.status === 'string') {
      onEvent({ type: 'result', message: value.message.slice(0, 1000), status: value.status,
        commandSent: value.commandSent === null || typeof value.commandSent === 'boolean' ? value.commandSent : undefined,
        ...(value.target === 'home' ? { target: 'home' as const } : {}) });
    } else if (event === 'text' && typeof value.text === 'string') {
      onEvent({ type: 'text', message: value.text.slice(0, 8000) });
    } else if ((event === 'status' || event === 'tool_call') && typeof value.message === 'string') {
      onEvent({ type: event, message: value.message.slice(0, 1000) });
    } else if (event === 'usage') {
      onEvent({ type: 'usage', promptTokens: typeof value.promptTokens === 'number' ? value.promptTokens : undefined,
        completionTokens: typeof value.completionTokens === 'number' ? value.completionTokens : undefined });
    }
  }
  try {
    while (!done) {
      signal.throwIfAborted();
      const chunk = await reader.read();
      total += chunk.value?.length ?? 0;
      if (total > 500_000) throw new Error('AI 回复过大，已停止读取');
      buffer += decoder.decode(chunk.value, { stream: !chunk.done });
      buffer = buffer.replace(/\r\n/g, '\n');
      let separator: number;
      while ((separator = buffer.indexOf('\n\n')) >= 0 && !done) {
        const complete = buffer.slice(0, separator); buffer = buffer.slice(separator + 2);
        frame(complete);
      }
      if (buffer.length > 64000) throw new Error('AI 数据帧过大');
      if (chunk.done) break;
    }
    if (!done) throw new Error('连接中断，指令结果可能未知，请先检查车辆；不要重复发送');
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

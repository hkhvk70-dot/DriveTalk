export class HttpRequestError extends Error {
  readonly status: number;
  constructor(status: number) { super(`服务返回 HTTP ${status}`); this.status = status; }
}

/** GET-only retries. Never retry writes, user cancellation, 401/403 or invalid JSON. */
export async function fetchWithRetry(
  url: string,
  init: RequestInit = {},
  options: { retries?: number; timeoutMs?: number; fetcher?: typeof fetch; sleep?: (ms: number) => Promise<void> } = {},
): Promise<Response> {
  const readOnly = (init.method ?? 'GET').toUpperCase() === 'GET';
  const retries = readOnly ? Math.min(2, Math.max(0, options.retries ?? 2)) : 0;
  const fetcher = options.fetcher ?? fetch;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  for (let attempt = 0; ; attempt++) {
    init.signal?.throwIfAborted();
    let response: Response;
    try {
      const timeout = AbortSignal.timeout(options.timeoutMs ?? 12_000);
      response = await fetcher(url, { ...init, signal: init.signal ? AbortSignal.any([init.signal, timeout]) : timeout });
    } catch (error) {
      if (init.signal?.aborted || attempt >= retries || !(error instanceof TypeError || (error instanceof DOMException && error.name === 'TimeoutError'))) throw error;
      await sleep(300 * 2 ** attempt); continue;
    }
    if (response.ok) return response;
    const retryable = [429, 502, 503, 504].includes(response.status);
    if (!retryable || attempt >= retries) { await response.body?.cancel(); throw new HttpRequestError(response.status); }
    const header = response.headers.get('Retry-After');
    const parsed = header == null ? 0 : /^\d+(\.\d+)?$/.test(header) ? Number(header) * 1000 : Date.parse(header) - Date.now();
    // Do not ignore a long server backoff by retrying earlier than requested.
    if (Number.isFinite(parsed) && parsed > 30_000) { await response.body?.cancel(); throw new HttpRequestError(response.status); }
    await response.body?.cancel();
    await sleep(Math.max(300 * 2 ** attempt, Number.isFinite(parsed) ? parsed : 0));
  }
}

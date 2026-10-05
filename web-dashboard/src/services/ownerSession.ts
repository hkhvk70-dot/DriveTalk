/** Only opaque HttpOnly cookies persist. No local/sessionStorage credentials. */
export async function ownerSession(action: 'status' | 'login' | 'logout', token?: string, fetcher: typeof fetch = fetch): Promise<boolean> {
  const response = await fetcher(`/v1/vehicle/session${action === 'status' ? '' : `/${action}`}`, {
    method: action === 'status' ? 'GET' : 'POST', credentials: 'same-origin', cache: 'no-store',
    signal: AbortSignal.timeout(12_000),
    headers: { Accept: 'application/json', ...(action === 'status' ? {} : { 'Content-Type': 'application/json' }), ...(token ? { 'X-DriveTalk-Token': token.trim() } : {}) },
    ...(action === 'status' ? {} : { body: '{}' }),
  });
  if (action === 'status' && response.status === 401) return false;
  if (!response.ok) throw new Error(response.status === 401 ? '访问令牌无效，请重新输入' : `登录服务返回 HTTP ${response.status}；未自动重试`);
  const payload = await response.json() as { authenticated?: unknown };
  if (payload.authenticated !== (action !== 'logout')) throw new Error('登录状态未确认');
  return action !== 'logout';
}

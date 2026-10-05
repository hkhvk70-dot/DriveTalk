import { Link } from 'react-router-dom';
import { useState } from 'react';
import { useVehicleStore } from '../stores/mobileVehicleStore';
import ConfirmButton from '../components/common/ConfirmButton';
import GrokSettingsCard from '../components/ai/GrokSettingsCard';
import AsrSettingsCard from '../components/ai/AsrSettingsCard';
import VoiceSettingsCard from '../components/ai/VoiceSettingsCard';
import NativeGrokSettingsCard from '../components/ai/NativeGrokSettingsCard';
import SmartHomeSettingsCard from '../components/smarthome/SmartHomeSettingsCard';

export default function SettingsPage() {
  const source = useVehicleStore((s) => s.source);
  const busy = useVehicleStore((s) => s.isLoading);
  const theme = useVehicleStore((s) => s.theme);
  const setTheme = useVehicleStore((s) => s.setTheme);
  const policy = useVehicleStore((s) => s.wakePolicy);
  const setPolicy = useVehicleStore((s) => s.setWakePolicy);
  const asleep = useVehicleStore((s) => s.vehicleData?.state === 'asleep');
  const simulateSleep = useVehicleStore((s) => s.simulateSleep);
  const connect = useVehicleStore((s) => s.connect);
  const disconnect = useVehicleStore((s) => s.disconnect);
  const commands = useVehicleStore((s) => s.commandsEnabled);
  const received = useVehicleStore((s) => s.lastUpdatedAt);
  const [token, setToken] = useState('');
  const [remember, setRemember] = useState(true);
  const remembered = useVehicleStore((s) => s.remembered);
  return <section className="space-y-5">
    <div className="mobile-card space-y-3 p-5"><h2 className="text-sm font-medium">账户与数据来源</h2><p className="text-xs leading-6 text-neutral-400">{source === 'mock' ? '当前使用独立模拟车辆，没有连接你的真实账户。' : !received ? '尚未成功读取真实快照' : commands ? '真实快照 · 控车代理已配置（不代表车辆配对已验证）' : '真实快照 · 只读模式'}</p>
      {source === 'mock' || !received ? <form onSubmit={(e) => { e.preventDefault(); const value = token; setToken(''); void connect(value, remember); }} className="space-y-3">
        <label className="block text-xs text-neutral-400">DriveTalk 手机访问令牌<input aria-label="DriveTalk 手机访问令牌" type="password" autoComplete="off" spellCheck={false} disabled={busy} value={token} onChange={(e) => setToken(e.target.value)} className="mt-2 w-full rounded-xl bg-white/5 p-3 text-sm" /></label>
        <label className="flex items-center gap-2 text-xs text-neutral-400"><input type="checkbox" checked={remember} disabled={busy} onChange={e => setRemember(e.target.checked)} />记住登录 30 天（仅限私人手机）</label>
        <button type="submit" disabled={busy || !token.trim()} className="mobile-button w-full">连接并读取真实快照</button>
      </form> : null}
      {source === 'live' && <button disabled={busy} onClick={() => void disconnect()} className="mobile-button w-full">退出并清除保存的登录</button>}
      <p className="text-xs leading-6 text-neutral-500">只填写 DriveTalk 访问令牌，不是 Tesla Secret。{remembered ? '已记住登录；原始令牌不保存到网页本地存储，30 天后需重新登录。' : '未记住登录时，令牌仅在内存中。'}读取不会自动唤醒。请在自己的 HTTPS 域名使用；本地预览未配置云端转发。</p><Link to="/legacy" className="mobile-button">打开原仪表盘 →</Link></div>
    <GrokSettingsCard />
    <NativeGrokSettingsCard />
    <VoiceSettingsCard />
    <AsrSettingsCard />
    <SmartHomeSettingsCard />
    <section className="mobile-card space-y-4 p-5"><h2 className="text-sm font-medium">App 设置</h2><label className="flex items-center justify-between gap-3 text-sm">主题<select aria-label="App 主题" value={theme} onChange={(e) => setTheme(e.target.value as 'dark' | 'light')} className="rounded-lg bg-white/10 p-2"><option value="dark">深色</option><option value="light">浅色</option></select></label>
      <div><p className="text-sm">唤醒策略：{source === 'live' || policy === 'manual' ? '每次休眠需确认' : '模拟控车时允许唤醒'}</p><p className="my-2 text-xs leading-6 text-neutral-500">真实车辆始终逐次确认唤醒，读取不自动唤醒，不自动重试命令。</p>
        {source === 'mock' && (policy === 'manual' ? <ConfirmButton disabled={busy} title="模拟控车时自动唤醒？" description="仅改变模拟车辆行为，真实车辆仍需逐次确认唤醒。" action={async () => { setPolicy('on-command'); return true; }}>模拟控车时自动唤醒</ConfirmButton> : <button disabled={busy} className="mobile-button" onClick={() => setPolicy('manual')}>恢复每次确认</button>)}
      </div>
    </section>
    {source === 'mock' && <section className="mobile-card p-5"><h2 className="mb-3 text-sm font-medium">Mock 测试工具</h2><button disabled={busy} className="mobile-button w-full" onClick={() => simulateSleep(!asleep)}>{asleep ? '恢复模拟在线' : '模拟车辆休眠'}</button><p className="mt-3 text-xs text-neutral-500">只修改本地模拟数据，不调用 Fleet API。</p></section>}
    <section><h2 className="mb-3 text-sm font-medium">高级车辆功能</h2><div className="mobile-card divide-y divide-white/5 px-5">{['哨兵模式', '代客模式', 'PIN to Drive', '远程启动', '软件更新预约', '添加 / 删除驾驶员'].map((name) => <div key={name} className="flex items-center justify-between gap-3 py-4"><span className="text-sm">{name}</span><span className="text-[11px] text-neutral-500">未接入</span></div>)}</div><p className="mt-3 text-xs leading-6 text-neutral-500">这些功能需逐项核对 API、车辆支持及安全要求，不提供假开关。</p></section>
    <p className="text-center text-xs leading-6 text-neutral-500">不是官方 App 的完整替代品。控车须经服务器签名代理，每次操作需确认。记住登录仅限私人设备；手机遗失时请立即撤销登录。主题与唤醒偏好仅保存在本次会话中。</p>
  </section>;
}

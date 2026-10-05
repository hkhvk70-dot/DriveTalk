import { useEffect, useRef, useState } from 'react';
import { homeAccount, jobActive, type HomeAccount } from '../../services/smartHomeApi';
import { useVehicleStore } from '../../stores/mobileVehicleStore';

const labels: Record<string, string> = {
  light: '灯具', plug: '插座', climate: '空调', camera: '摄像头 / 猫眼', lock: '门锁',
  router: '路由器', gateway: '网关', speaker: '音箱', scale: '体脂秤', phone: '手机',
  projector: '投影仪', media: '电视 / 盒子', wearable: '手环 / 穿戴设备', unknown: '待识别', vacuum: '扫地机', curtain: '窗帘', sensor: '传感器',
};
const states: Record<string, string> = {
  idle: '尚未开始', starting: '正在准备登录…', waiting_scan: '等待扫码确认', syncing: '正在同步账号设备…',
  done: '同步完成', failed: '任务失败，请检查账号或后端配置', timeout: '任务超时，已停止等待', cancelled: '任务已取消',
};
const integrations: Record<string, string> = {
  binding_ready_disabled: '已适配控制映射（仍需实机验收）', camera_adapter_required: '视频适配尚未完成',
  restricted_read_only: '门锁控制未开放', spec_unavailable: '型号规格暂不可用', adapter_required: '专用适配尚未完成',
};

export default function SmartHomeSettingsCard() {
  const available = useVehicleStore(s => s.source === 'live' && s.remembered);
  const [account, setAccount] = useState<HomeAccount | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState('');
  const [retryUntil, setRetryUntil] = useState(0);
  const [cooldown, setCooldown] = useState(0);
  const controller = useRef<AbortController | null>(null);
  const generation = useRef(0);
  const alive = useRef(true);
  function accept(value: HomeAccount) {
    setAccount(value); setSelected(value.devices.filter(d => d.enabled).map(d => d.id));
    setRetryUntil(Date.now() + value.retryAfter * 1000);
    setCooldown(value.retryAfter);
  }
  // Local countdown only; it must not add cloud requests or replay a POST.
  useEffect(() => {
    const update = () => setCooldown(Math.max(0, Math.ceil((retryUntil - Date.now()) / 1000)));
    update();
    const timer = setInterval(update, 500);
    return () => clearInterval(timer);
  }, [retryUntil]);
  useEffect(() => {
    alive.current = true;
    const current = ++generation.current;
    controller.current?.abort(); controller.current = new AbortController();
    setAccount(null); setSelected([]); setBusy(false); setNotice(''); setRetryUntil(0); setCooldown(0);
    if (available) void homeAccount('status', undefined, controller.current.signal)
      .then(value => { if (alive.current && current === generation.current) accept(value); })
      .catch(error => { if (alive.current && current === generation.current && error.name !== 'AbortError') setNotice(error.message); });
    return () => { alive.current = false; ++generation.current; controller.current?.abort(); };
  }, [available]);
  useEffect(() => {
    if (!available || !account || !jobActive(account.job.state)) return;
    // Only bounded account-task status polling, never device polling or writes.
    let active = true;
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const deadline = Date.now() + 185000;
    async function poll() {
      try {
        const value = await homeAccount('status', undefined, abort.signal);
        if (!active) return;
        accept(value);
        if (jobActive(value.job.state) && Date.now() < deadline) timer = setTimeout(poll, 2000);
      } catch (error) {
        if (active && error instanceof Error && error.name !== 'AbortError') setNotice(`${error.message}；状态查询已停止，请手动刷新`);
      }
    }
    timer = setTimeout(poll, 2000);
    return () => { active = false; clearTimeout(timer); abort.abort(); };
  }, [available, account?.job.state]);

  async function run(action: 'status' | 'login' | 'sync' | 'cancel' | 'select') {
    if (!available || busy) return;
    if ((action === 'login' || action === 'sync') && !window.confirm('将连接小米云读取账号设备及型号规格；不会操作设备。已适配设备默认允许语音控制，同账号同步保留明确关闭的设备，是否继续？')) return;
    const current = ++generation.current;
    controller.current?.abort(); controller.current = new AbortController();
    setBusy(true); setNotice('');
    try {
      const value = await homeAccount(action, action === 'select' ? selected : undefined, controller.current.signal,
        undefined, action === 'select' && account?.controlConnected === true);
      if (alive.current && current === generation.current) {
        accept(value);
        if (action === 'select') setNotice(value.controlGranted ? '已保存所选设备；语音页默认允许控家，无需再次勾选。' : '设备选择已保存，控家授权已关闭。');
      }
    } catch (error) {
      if (alive.current && current === generation.current && error instanceof Error && error.name !== 'AbortError') setNotice(error.message);
    } finally { if (alive.current && current === generation.current) setBusy(false); }
  }
  const working = !!account && jobActive(account.job.state);
  const canStart = available && account?.available && !busy && !working && cooldown === 0;
  const devices = account?.devices.filter(d => `${d.name} ${d.home} ${d.room} ${labels[d.kind] ?? d.kind}`.includes(filter)) ?? [];
  return <section className="mobile-card space-y-4 p-5">
    <h2 className="text-sm font-medium">米家账号与设备</h2>
    <p className="text-xs leading-6 text-neutral-400">一次扫码，自动发现账号设备。凭证和设备目录加密存于后端，不需要逐台输入型号。</p>
    {!available && <p className="text-xs text-amber-200">请先连接 DriveTalk 并记住登录。模拟模式不会访问小米。</p>}
    {available && account && !account.available && <p className="text-xs leading-6 text-amber-200">米家后端未配置或依赖未安装；此时不能扫码，不影响原有车控。</p>}
    {account?.storageError && <p className="text-xs text-red-300">加密账号文件无法读取，需要检查服务器配置；不要删除密钥重建。</p>}
    <div className="grid grid-cols-2 gap-2">
      <button className="mobile-button text-xs" disabled={!canStart} onClick={() => void run('login')}>{account?.configured ? '重新登录 / 扫码' : '登录小米账号'}</button>
      <button className="mobile-button text-xs" disabled={!canStart || !account?.configured} onClick={() => void run('sync')}>同步全部设备</button>
      <button className="mobile-button text-xs" disabled={!available || busy} onClick={() => void run('status')}>读取任务状态</button>
      {working && <button className="mobile-button text-xs" disabled={busy} onClick={() => void run('cancel')}>取消等待</button>}
    </div>
    {account && <p className="text-xs text-neutral-400" role="status">{states[account.job.state]}{account.syncedAt ? ` · ${new Date(account.syncedAt).toLocaleString()}` : ''}</p>}
    {cooldown > 0 && <p className="text-xs text-amber-200" role="status">登录 / 同步冷却中，请等待 {cooldown} 秒再操作；不会自动重试。</p>}
    {account?.job.state === 'waiting_scan' && account.job.qrSvg && <div className="space-y-3 text-center">
      <img className="mx-auto h-56 w-56 rounded-xl bg-white p-3" alt="米家账号登录二维码" referrerPolicy="no-referrer" src={`data:image/svg+xml;base64,${account.job.qrSvg}`} />
      <p className="text-xs leading-6 text-neutral-400">使用米家 App 扫码并确认。可在另一台设备打开此页面扫码；不要把二维码或链接发给他人。</p>
      <a className="mobile-button text-xs" href={account.job.loginUrl} target="_blank" rel="noreferrer noopener">打开小米官方登录链接</a>
    </div>}
    {!!account?.devices.length && <>
      <p className="text-sm">已发现 {account.devices.length} 台设备</p>
      <input aria-label="筛选米家设备" value={filter} onChange={e => setFilter(e.target.value)} placeholder="按设备 / 家庭 / 房间筛选" className="w-full rounded-xl bg-white/5 p-3 text-sm" />
      <div className="max-h-[32rem] space-y-2 overflow-y-auto">
        {devices.map(device => <label key={device.id} className="flex items-start gap-3 rounded-xl bg-white/5 p-3">
          <input className="mt-1" type="checkbox" checked={selected.includes(device.id)} disabled={busy || working || device.integration_status !== 'binding_ready_disabled'}
            onChange={e => setSelected(previous => e.target.checked ? [...previous, device.id] : previous.filter(id => id !== device.id))} />
          <span className="min-w-0 flex-1"><span className="block break-words text-sm">{device.name}</span>
            <span className="block text-xs leading-6 text-neutral-400">{labels[device.kind] ?? '待识别'} · {device.online === null ? '在线状态未知' : device.online ? '在线' : '离线'}{device.home || device.room ? ` · ${device.home} ${device.room}` : ''}</span>
            <span className="block text-xs leading-5 text-neutral-500">{integrations[device.integration_status] ?? '尚未接入'} · {device.model || '型号未知'}</span>
            {device.integration_status === 'binding_ready_disabled' && <span className="block text-xs leading-5 text-neutral-400">{device.enabled ? '已允许控制' : '未选择'} · {device.kind === 'climate' ? '开关 / 调温；模式、风速按型号支持' : device.kind === 'plug' ? '开关' : '开关 / 亮度 / 色温按型号支持'}</span>}
          </span>
        </label>)}
      </div>
      <button className="mobile-button w-full text-xs" disabled={busy || working || !available} onClick={() => void run('select')}>{account?.controlConnected ? selected.length ? '保存并允许所选设备控家' : '清空设备选择并撤销控家授权' : '保存设备选择（暂不启用控家）'}</button>
    </>}
    <p role="status" className="break-words text-xs leading-6 text-amber-200">{notice}</p>
    <p className="text-xs leading-6 text-neutral-500">已适配的灯具、插座和空调默认允许控制，可取消选择后保存关闭；明确关闭会跨重启和同账号同步保留。自动发现不代表全部可控，门锁、摄像头、路由器等仍不开放控制。{account?.controlConnected ? '语音桥接已就绪，仍须主动发送明确指令。' : '语音桥接尚未就绪，默认勾选不会绕过后端检查。'}取消等待不撤销已保存账号。</p>
  </section>;
}

import { create } from 'zustand';
import type { VehicleData } from '../types/tesla.ts';
import { createMobileMock } from '../mocks/mobileVehicle.ts';
import { createMobileMockApi, type MobileVehicleApi, type VehicleCommand } from '../services/mobileVehicleApi.ts';
import { createMobileLiveApi } from '../services/mobileLiveApi.ts';
import { ownerSession } from '../services/ownerSession.ts';

type WakeState = 'idle' | 'checking' | 'needs-confirmation' | 'waking' | 'online' | 'error';
type WakePolicy = 'manual' | 'on-command';
type Theme = 'dark' | 'light';

interface MobileVehicleStore {
  commandsEnabled: boolean;
  navigationEnabled: boolean;
  rearTrunkCloseEnabled: boolean;
  connect(token: string, remember?: boolean): Promise<boolean>;
  restoreSession(): Promise<boolean>;
  remembered: boolean;
  disconnect(): Promise<void>;
  source: 'mock' | 'live';
  vehicleData: VehicleData | null;
  isLoading: boolean;
  pendingCommand: string | null;
  error: string | null;
  notice: string | null;
  wakeState: WakeState;
  wakePolicy: WakePolicy;
  theme: Theme;
  lastUpdatedAt: number | null;
  refresh(): Promise<boolean>;
  checkAndWakeUp(confirmed?: boolean): Promise<boolean>;
  executeCommand(command: VehicleCommand): Promise<boolean>;
  toggleLock(): Promise<boolean>;
  setTemperature(celsius: number): Promise<boolean>;
  sendNavigation(destination: string): Promise<boolean>;
  findCar(): Promise<boolean>;
  simulateSleep(asleep: boolean): void;
  setWakePolicy(policy: WakePolicy): void;
  setTheme(theme: Theme): void;
  clearMessages(): void;
  runAssistant(action: () => Promise<void>): Promise<boolean>;
  receiveAssistantSnapshot(data: VehicleData, fresh: boolean): void;
}

function validate(command: VehicleCommand, data: VehicleData) {
  if (['trunk', 'rearTrunk', 'chargePort'].includes(command.name) && data.drive_state?.shift_state !== 'P') throw new Error('备箱和充电口盖操作需确认 P 档');
  if (command.name === 'temperature' && (!Number.isFinite(command.celsius) || command.celsius < 15 || command.celsius > 28)) throw new Error('温度范围为 15–28°C');
  if (command.name === 'chargeLimit' && (!Number.isInteger(command.percent) || command.percent < 50 || command.percent > 100)) throw new Error('充电限值范围为 50%–100%');
  if (command.name === 'navigation' && (!command.destination.trim() || command.destination.length > 300 || /[\x00-\x1f\x7f]|\w+:\/\//.test(command.destination))) throw new Error('请输入有效地址或地点名称，最多 300 字符；不支持链接或控制字符');
}

export function createMobileVehicleStore(
  api: MobileVehicleApi = createMobileMockApi(),
  options: { source?: 'mock' | 'live'; waitMs?: number; wakeTimeoutMs?: number; syncWaitMs?: number } = {},
) {
  let source = options.source ?? 'mock';
  let restoreStarted = false;
  return create<MobileVehicleStore>()((set, get) => {
    const receive = (vehicleData: VehicleData) => set({ vehicleData, lastUpdatedAt: Date.now() });
    async function job(name: string, action: () => Promise<boolean>) {
      if (get().isLoading) return false;
      set({ isLoading: true, pendingCommand: name, error: null, notice: null });
      try { return await action(); }
      catch (error) {
        set({ error: error instanceof Error ? error.message : '操作失败', wakeState: ['checking', 'waking'].includes(get().wakeState) ? 'error' : get().wakeState });
        return false;
      } finally { set({ isLoading: false, pendingCommand: null }); }
    }
    async function awake(confirmed: boolean) {
      set({ wakeState: 'checking' });
      const previous = get().vehicleData;
      const statusOnly = source === 'live' && previous && api.connectionStatus;
      let snapshot = statusOnly ? { ...previous, state: await api.connectionStatus!() } : await api.read();
      if (statusOnly) set({ vehicleData: snapshot }); // Not a fresh data read: preserve lastUpdatedAt.
      else receive(snapshot);
      if (snapshot.state === 'online') { set({ wakeState: 'online' }); return true; }
      if (snapshot.state !== 'asleep') throw new Error('车辆离线或状态未知');
      if (source === 'live' && !confirmed) {
        set({ wakeState: 'needs-confirmation', notice: '真实车辆休眠，必须显式确认唤醒；未发送命令。' });
        return false;
      }
      if (!confirmed && get().wakePolicy === 'manual') {
        set({ wakeState: 'needs-confirmation', notice: '车辆休眠中，请先确认唤醒；未发送命令。' });
        return false;
      }
      set({ wakeState: 'waking', notice: '正在唤醒车辆……' });
      const deadline = Date.now() + (options.wakeTimeoutMs ?? 60_000);
      await api.wake(); // Exactly one wake request; never automatically resent.
      while (Date.now() < deadline) {
        snapshot = await api.read(); receive(snapshot);
        if (snapshot.state === 'online') { set({ wakeState: 'online', notice: null }); return true; }
        await new Promise<void>((resolve) => setTimeout(resolve, options.waitMs ?? 3000));
      }
      throw new Error('唤醒等待超时，请手动刷新，不要连续唤醒');
    }
    async function refreshAfterCommand(command?: VehicleCommand) {
      const matches = (data: VehicleData): boolean | undefined => {
        if (!command) return undefined;
        const v = data.vehicle_state, c = data.climate_state, b = data.charge_state;
        switch (command.name) {
          case 'rearTrunk': return typeof v?.rt === 'number' ? (v.rt > 0) === command.open : false;
          case 'trunk': return (command.trunk === 'rear' ? v?.rt : v?.ft)! > 0;
          case 'lock': return v?.locked === command.locked;
          case 'climate': return c?.is_climate_on === command.enabled;
          case 'temperature': return c?.driver_temp_setting === command.celsius;
          case 'chargePort': return b?.charge_port_door_open === command.open;
          case 'chargeLimit': return b?.charge_limit_soc === command.percent;
          case 'charging': return typeof b?.charging_state === 'string' && (b.charging_state === 'Charging') === command.enabled;
          case 'vent': return [v?.fd_window, v?.fp_window, v?.rd_window, v?.rp_window].every(x => typeof x === 'number' && x > 0);
          case 'closeWindows': return [v?.fd_window, v?.fp_window, v?.rd_window, v?.rp_window].every(x => x === 0);
          default: return undefined;
        }
      };
      try {
        for (let attempt = 0; attempt < (source === 'live' ? 2 : 1); attempt++) {
          if (source === 'live') {
            set({ notice: '命令已受理，正在同步车辆状态与 3D 模型……' });
            await new Promise<void>(resolve => setTimeout(resolve, options.syncWaitMs ?? [3000, 8000][attempt]));
          }
          const snapshot = await api.read(); receive(snapshot);
          if (snapshot.state !== 'online') { set({ notice: '车辆已离线或休眠，停止同步；未自动唤醒。' }); return; }
          const confirmed = matches(snapshot);
          if (confirmed !== false || source === 'mock') {
            set({ notice: command?.name === 'navigation' ? '目的地发送已受理，请在车机确认路线；快照已回读。' : '操作后快照已更新 · 非实时数据流' }); return;
          }
        }
        set({ notice: '命令已受理，已自动回读 2 次；车辆快照尚未确认目标状态，可稍后刷新。未重发命令。' });
      }
      catch (error) { set({ notice: `命令已受理，但快照同步暂停：${error instanceof Error ? error.message : '读取失败'}。勿重复发送命令。` }); }
    }
    return {
      commandsEnabled: source === 'mock',
      navigationEnabled: source === 'mock',
      rearTrunkCloseEnabled: source === 'mock',
      remembered: false,
      restoreSession: () => {
        if (restoreStarted) return Promise.resolve(false);
        restoreStarted = true;
        return job('恢复登录', async () => {
          if (!await ownerSession('status')) { set({ notice: '请在控制与设置中连接车辆；可勾选记住登录。' }); return false; }
          api.dispose?.(); api = createMobileLiveApi(null); source = 'live';
          set({ source, remembered: true, vehicleData: null, lastUpdatedAt: null, commandsEnabled: false, navigationEnabled: false, rearTrunkCloseEnabled: false, wakeState: 'idle' });
          receive(await api.read());
          const capability = await api.capabilities!();
          set({ commandsEnabled: capability.commands, navigationEnabled: capability.navigation === true, rearTrunkCloseEnabled: capability.rearTrunkClose === true, notice: '已恢复登录 · 读取不自动唤醒' });
          return true;
        });
      },
      connect: (token, remember = false) => job('连接真实车辆', async () => {
        if (remember) {
          if (!token.trim() || /[\r\n]/.test(token)) throw new Error('请输入有效的 DriveTalk 访问令牌');
          await ownerSession('login', token);
        } else if (get().remembered) { await ownerSession('logout'); }
        const next = createMobileLiveApi(remember ? null : token, import.meta.env?.VITE_VEHICLE_COMMAND_PROXY_URL || '/v1/vehicle');
        // Remove all mock/previous-account data before reading a new session.
        api.dispose?.(); api = next; source = 'live';
        set({ source, remembered: remember, vehicleData: null, lastUpdatedAt: null, commandsEnabled: false, navigationEnabled: false, rearTrunkCloseEnabled: false, wakeState: 'idle', wakePolicy: 'manual' });
        const snapshot = await next.read(); receive(snapshot);
        const capability = await next.capabilities!();
        set({ commandsEnabled: capability.commands, navigationEnabled: capability.navigation === true, rearTrunkCloseEnabled: capability.rearTrunkClose === true, notice: capability.commands ? '真实快照已连接 · 控车需逐次确认' : '真实快照已连接 · 控车代理未启用，当前只读' });
        return true;
      }),
      disconnect: async () => {
        if (get().isLoading) return;
        if (get().remembered) {
          set({ isLoading: true, pendingCommand: '退出登录' });
          try { await ownerSession('logout'); }
          catch { set({ isLoading: false, pendingCommand: null, error: '退出未确认，请重试；保存的登录尚未清除。' }); return; }
          set({ isLoading: false, pendingCommand: null });
        }
        api.dispose?.(); api = createMobileMockApi(); source = 'mock';
        set({ source, remembered: false, vehicleData: createMobileMock(), lastUpdatedAt: Date.now(), commandsEnabled: true, navigationEnabled: true, rearTrunkCloseEnabled: true, wakeState: 'online', wakePolicy: 'manual', error: null, notice: '已退出并清除保存的登录 · 返回模拟模式' });
      },
      source, vehicleData: source === 'mock' ? createMobileMock() : null,
      isLoading: false, pendingCommand: null, error: null,
      notice: source === 'mock' ? '模拟模式 · 不连接真实车辆' : '真实适配器尚未接入',
      wakeState: source === 'mock' ? 'online' : 'idle', wakePolicy: 'manual', theme: 'dark',
      lastUpdatedAt: source === 'mock' ? Date.now() : null,
      refresh: () => job('刷新快照', async () => {
        const snapshot = await api.read(); receive(snapshot);
        set({ wakeState: snapshot.state === 'online' ? 'online' : 'idle', notice: '快照已更新 · 非实时数据流' }); return true;
      }),
      checkAndWakeUp: (confirmed = false) => job('唤醒车辆', () => awake(confirmed)),
      executeCommand: (command) => job(command.name, async () => {
        if (!get().commandsEnabled) throw new Error('控车代理未启用，当前仅允许读取');
        if (source === 'live' && command.name === 'navigation' && !get().navigationEnabled) throw new Error('服务器尚未启用地址发送');
          if (source === 'live' && command.name === 'rearTrunk' && !command.open && !get().rearTrunkCloseEnabled) throw new Error('服务器尚未启用关闭后备箱');
        // Validate input before any network or wake request where possible.
        if (command.name === 'temperature' || command.name === 'chargeLimit' || command.name === 'navigation') validate(command, get().vehicleData ?? {}); // Validate input before requests; no fabricated gear.
        if (!(await awake(false))) return false;
        validate(command, get().vehicleData!);
        try { await api.command(command); }
        catch (error) {
          const rejected = (error as { commandSent?: unknown })?.commandSent === false;
          throw new Error(`${error instanceof Error ? error.message : '命令失败'}。${rejected ? '指令未发送到车辆。' : '结果可能未知，请先刷新；未自动重试。'}`);
        }
        set({ notice: source === 'mock' ? '模拟命令已执行' : command.name === 'navigation' ? '目的地发送已受理，请在车机确认路线；快照可能暂未同步。' : '命令已受理；车辆状态以回读快照为准。' });
        await refreshAfterCommand(command); return true;
      }),
      toggleLock: () => {
        const locked = get().vehicleData?.vehicle_state?.locked;
        if (typeof locked !== 'boolean') { set({ error: '锁闭状态未知，请先刷新' }); return Promise.resolve(false); }
        return get().executeCommand({ name: 'lock', locked: !locked });
      },
      setTemperature: (celsius) => get().executeCommand({ name: 'temperature', celsius }),
      sendNavigation: (destination) => get().executeCommand({ name: 'navigation', destination: destination.trim() }),
      findCar: () => job('鸣笛与闪灯', async () => {
        if (!get().commandsEnabled) throw new Error('控车代理未启用，当前仅允许读取');
        if (!(await awake(false))) return false;
        validate({ name: 'horn' }, get().vehicleData!);
        if (source === 'live') {
          await api.command({ name: 'findCar' });
          set({ notice: '鸣笛与闪灯已受理' }); await refreshAfterCommand(); return true;
        }
        try { await api.command({ name: 'horn' }); }
        catch { throw new Error('鸣笛结果未确认，未发送闪灯；请检查车辆，勿重复操作。'); }
        try { await api.command({ name: 'lights' }); }
        catch { throw new Error('鸣笛已受理，但闪灯结果未确认；未自动重试。'); }
        set({ notice: source === 'mock' ? '模拟寻车完成' : '鸣笛与闪灯已受理' }); return true;
      }),
      simulateSleep: (asleep) => {
        if (get().isLoading || source !== 'mock' || !api.simulateSleep) return;
        api.simulateSleep(asleep);
        set((state) => ({ vehicleData: state.vehicleData ? { ...state.vehicleData, state: asleep ? 'asleep' : 'online' } : null, wakeState: asleep ? 'idle' : 'online', error: null, notice: asleep ? '模拟车辆休眠中' : '模拟车辆在线' }));
      },
      setWakePolicy: (wakePolicy) => { if (!get().isLoading) set({ wakePolicy }); },
      setTheme: (theme) => set({ theme }),
      clearMessages: () => set({ error: null, notice: null }),
      runAssistant: (action) => job('DeepSeek 助手', async () => { await action(); return true; }),
      receiveAssistantSnapshot: (data, fresh) => {
        if (source !== 'live') return;
        set({ vehicleData: data, ...(fresh ? { lastUpdatedAt: Date.now() } : {}),
              wakeState: data.state === 'online' ? 'online' : 'idle' });
      },
    };
  });
}

export const useVehicleStore = createMobileVehicleStore();

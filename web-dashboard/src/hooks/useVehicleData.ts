import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createVehicleApi, VehicleApiError } from '../services/vehicleApi';
import { VehicleSession } from '../services/vehicleSession';
import { useVehicleStore } from '../stores/vehicleStore';

export interface VehicleDataOptions {
  mode: 'mock' | 'live';
  /** Same-origin owner backend path. Never a Tesla API URL. */
  backendPath?: string;
  /** Separate DriveTalk owner token, held in memory; never a Tesla OAuth token. */
  ownerAccessToken?: string;
}

export function useVehicleData({ mode, backendPath = '', ownerAccessToken = '' }: VehicleDataOptions) {
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const controller = useRef<AbortController | null>(null);
  const generation = useRef(0);
  const configured = mode === 'live' && !!ownerAccessToken.trim() && backendPath.startsWith('/') && !backendPath.startsWith('//');
  const session = useMemo(() => configured ? new VehicleSession(createVehicleApi(backendPath, ownerAccessToken)) : null, [configured, backendPath, ownerAccessToken]);

  const refresh = useCallback(async () => {
    if (!session || document.hidden || controller.current) return;
    const abort = new AbortController();
    controller.current = abort;
    setBusy(true);
    setNotice(null);
    const current = generation.current;
    try {
      const result = await session.read(abort.signal);
      if (abort.signal.aborted || generation.current !== current) return;
      if (!result) { setNotice('请稍后再刷新（请求间隔至少 60 秒）'); return; }
      const store = useVehicleStore.getState();
      if (result.data) store.receiveResponse(result.data);
      store.setConnectionState(result.state);
      if (!result.data) setNotice(result.state === 'asleep' ? '车辆休眠中，需要时点击唤醒' : '车辆当前不在线，未请求车辆数据');
    } catch (error) {
      if (!abort.signal.aborted && generation.current === current) useVehicleStore.getState().failRequest(error instanceof VehicleApiError ? error.message : '无法读取车辆服务，请检查连接');
    } finally {
      if (generation.current === current) { controller.current = null; setBusy(false); }
    }
  }, [session]);

  const wakeUp = useCallback(async () => {
    if (controller.current || useVehicleStore.getState().connectionState !== 'asleep') return;
    if (mode === 'mock') {
      useVehicleStore.getState().loadMock('parked');
      setNotice('模拟唤醒完成，未向车辆发送命令');
      return;
    }
    if (!session) return;
    const abort = new AbortController();
    const current = generation.current;
    controller.current = abort;
    setBusy(true);
    try {
      const accepted = await session.wake(abort.signal);
      if (!abort.signal.aborted && current === generation.current) {
        setNotice(accepted ? '唤醒请求已受理；稍后点击刷新确认车辆是否在线' : '唤醒请求已发送过，请稍后再试');
      }
    } catch (error) {
      if (!abort.signal.aborted && current === generation.current) {
        useVehicleStore.getState().failRequest(error instanceof VehicleApiError ? error.message : '唤醒结果未确认，请先刷新状态；不会自动重发命令');
      }
    } finally {
      if (generation.current === current) { controller.current = null; setBusy(false); }
    }
  }, [mode, session]);

  useEffect(() => {
    generation.current++;
    setNotice(null);
    setBusy(false);
    const store = useVehicleStore.getState();
    if (mode === 'mock') store.loadMock('parked');
    else {
      store.reset();
      // Defer past StrictMode's setup/cleanup cycle so it cannot consume the
      // session cooldown with an immediately-aborted development-only request.
      const startedGeneration = generation.current;
      queueMicrotask(() => {
        if (generation.current === startedGeneration && session && !document.hidden) void refresh();
      });
    }
    const onVisibility = () => { if (document.hidden) controller.current?.abort(); };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      generation.current++;
      controller.current?.abort();
      controller.current = null;
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [mode, session, refresh]);

  // No continuous REST vehicle_data polling. A live driving display needs Telemetry.
  return { refresh, wakeUp, busy, notice, configured };
}

import type { VehicleDataResponse, VehicleConnectionState } from '../types/tesla.ts';
import { VehicleApiError, type VehicleTransport } from './vehicleApi.ts';

export interface VehicleReadResult { state: VehicleConnectionState; data: VehicleDataResponse | null }

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const aborted = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', aborted); resolve(); }, ms);
    signal.addEventListener('abort', aborted, { once: true });
  });
}

/** One session per Hook; suppresses overlapping reads and repeated wake requests. */
export class VehicleSession {
  private busy = false;
  private nextReadAt = 0;
  private nextWakeAt = 0;
  private transport: VehicleTransport;
  private now: () => number;
  private wait: (ms: number, signal: AbortSignal) => Promise<void>;

  constructor(transport: VehicleTransport, now = Date.now, wait = delay) {
    this.transport = transport; this.now = now; this.wait = wait;
  }

  private async retryRead<T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      signal.throwIfAborted();
      try { return await operation(); } catch (error) {
        if (signal.aborted) throw error;
        if (error instanceof VehicleApiError && error.status === 429) {
          this.nextReadAt = this.now() + Math.max(60_000, error.retryAfterMs);
          throw error;
        }
        const retryable = error instanceof TypeError || (error instanceof VehicleApiError && [502, 503, 504].includes(error.status));
        if (!retryable || attempt >= 2) throw error;
        await this.wait(1000 * 2 ** attempt, signal);
      }
    }
  }

  async read(signal: AbortSignal): Promise<VehicleReadResult | null> {
    if (this.busy || this.now() < this.nextReadAt) return null;
    this.busy = true;
    this.nextReadAt = this.now() + 60_000;
    try {
      const state = await this.retryRead(() => this.transport.getStatus(signal), signal);
      if (state !== 'online') return { state, data: null };
      const data = await this.retryRead(() => this.transport.getData(signal), signal);
      return { state: data.response?.state ?? state, data };
    } finally { this.busy = false; }
  }

  async wake(signal: AbortSignal): Promise<boolean> {
    if (this.busy || this.now() < this.nextWakeAt) return false;
    this.busy = true;
    this.nextWakeAt = this.now() + 60_000;
    try {
      // POST is never automatically retried: a timeout may still mean it was accepted.
      await this.transport.wake(signal);
      this.nextReadAt = 0;
      return true;
    } finally { this.busy = false; }
  }
}

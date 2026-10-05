import { create } from 'zustand';
import type { VehicleConnectionState, VehicleData, VehicleDataResponse } from '../types/tesla';
import { createMockVehicleResponse, type MockScenario } from '../mocks/vehicleData';

export type RequestStatus = 'idle' | 'loading' | 'success' | 'error';

export interface VehicleStore {
  vehicleData: VehicleData | null;
  connectionState: VehicleConnectionState;
  requestStatus: RequestStatus;
  error: string | null;
  lastUpdatedAt: number | null; // last successfully received snapshot, local epoch ms
  source: 'mock' | 'live';
  mockScenario: MockScenario | null;
  beginRequest: () => void;
  receiveResponse: (payload: VehicleDataResponse) => void;
  setConnectionState: (state: VehicleConnectionState) => void;
  failRequest: (message: string) => void;
  loadMock: (scenario: MockScenario) => void;
  reset: () => void;
}

const emptyState = {
  vehicleData: null,
  connectionState: 'unknown',
  requestStatus: 'idle',
  error: null,
  lastUpdatedAt: null,
  source: 'live',
  mockScenario: null,
} as const;

export const useVehicleStore = create<VehicleStore>()((set) => ({
  ...emptyState,
  // This staged UI starts in mock mode. The live Hook will reset before connecting.
  vehicleData: createMockVehicleResponse('parked').response,
  connectionState: 'online',
  requestStatus: 'success',
  lastUpdatedAt: Date.now(),
  source: 'mock',
  mockScenario: 'parked',

  beginRequest: () => set({ requestStatus: 'loading', error: null }),
  receiveResponse: (payload) => {
    if (payload.error || payload.response === null) {
      set({ requestStatus: 'error', error: payload.error_description ?? payload.error ?? '车辆数据为空' });
      return;
    }
    set({
      // Replace complete REST snapshots; avoid carrying missing fields from an older response.
      vehicleData: payload.response,
      connectionState: payload.response.state ?? 'unknown',
      requestStatus: 'success', error: null, lastUpdatedAt: Date.now(),
      source: 'live', mockScenario: null,
    });
  },
  setConnectionState: (connectionState) => set({ connectionState }),
  failRequest: (error) => set({ requestStatus: 'error', error }),
  loadMock: (scenario) => {
    const payload = createMockVehicleResponse(scenario);
    set({
      vehicleData: payload.response,
      connectionState: payload.response?.state ?? 'unknown',
      requestStatus: payload.response ? 'success' : 'idle',
      error: null,
      lastUpdatedAt: payload.response ? Date.now() : null,
      source: 'mock', mockScenario: scenario,
    });
  },
  reset: () => set(emptyState),
}));

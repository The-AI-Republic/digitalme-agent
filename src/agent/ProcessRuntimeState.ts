export interface ProcessRuntimeState {
  activeRequestCount: number;
  draining: boolean;
}

export function initialProcessRuntimeState(): ProcessRuntimeState {
  return { activeRequestCount: 0, draining: false };
}

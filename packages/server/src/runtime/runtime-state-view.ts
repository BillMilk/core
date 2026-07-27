import type { RuntimeStateDto } from '@agent-tower/shared';

const states = new Map<string, RuntimeStateDto>();

export function setRuntimeStateSnapshot(state: RuntimeStateDto): void {
  if (state.turnState === 'DISPOSED') {
    states.delete(state.sessionId);
    return;
  }
  states.set(state.sessionId, state);
}

export function getRuntimeStateSnapshot(sessionId: string): RuntimeStateDto | undefined {
  return states.get(sessionId);
}

export function isRuntimeAwaitingPermission(sessionId: string): boolean {
  return states.get(sessionId)?.turnState === 'AWAITING_PERMISSION';
}

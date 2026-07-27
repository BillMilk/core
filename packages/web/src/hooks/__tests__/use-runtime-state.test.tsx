// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RuntimeType, SessionStatus } from '@agent-tower/shared';
import { ServerEvents } from '@agent-tower/shared/socket';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { handlers, socket, getMock } = vi.hoisted(() => {
  const handlers = new Map<string, (payload?: any) => void>();
  return {
    handlers,
    socket: {
      on: vi.fn((event: string, handler: (payload?: any) => void) => {
        handlers.set(event, handler);
      }),
      off: vi.fn((event: string) => {
        handlers.delete(event);
      }),
    },
    getMock: vi.fn(),
  };
});

vi.mock('@/lib/socket/manager', () => ({
  socketManager: { connect: () => socket },
}));

vi.mock('@/lib/api-client', () => ({
  apiClient: {
    get: getMock,
    post: vi.fn(),
  },
}));

import {
  isRuntimeTurnActive,
  isSessionStatusActive,
  useRuntimeState,
} from '../use-sessions';

const idleState = {
  sessionId: 'session-1',
  runtimeType: RuntimeType.ACP,
  turnState: 'IDLE' as const,
  capabilities: { loadSession: true, terminalInput: false, terminalResize: false, permissions: true },
  pendingPermissions: [],
};

function Probe() {
  const { data } = useRuntimeState('session-1');
  return <div data-state={data?.turnState}>{data?.turnState ?? 'loading'}</div>;
}

describe('useRuntimeState reconnect behavior', () => {
  let container: HTMLDivElement;
  let root: Root;
  let queryClient: QueryClient;

  beforeEach(() => {
    handlers.clear();
    socket.on.mockClear();
    socket.off.mockClear();
    getMock.mockReset().mockResolvedValue(idleState);
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    queryClient.clear();
    container.remove();
  });

  it('accepts live runtime state and refetches authoritative state on reconnect', async () => {
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <Probe />
        </QueryClientProvider>,
      );
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(queryClient.getQueryData(['sessions', 'runtime', 'session-1'])).toMatchObject({ turnState: 'IDLE' });

    act(() => {
      handlers.get(ServerEvents.SESSION_RUNTIME_STATE_CHANGED)?.({
        sessionId: 'session-1',
        state: { ...idleState, turnState: 'AWAITING_PERMISSION' },
      });
    });
    expect(queryClient.getQueryData(['sessions', 'runtime', 'session-1']))
      .toMatchObject({ turnState: 'AWAITING_PERMISSION' });

    await act(async () => {
      handlers.get('connect')?.();
      await Promise.resolve();
    });
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: ['sessions', 'runtime', 'session-1'],
    });
    expect(getMock).toHaveBeenCalledWith('/sessions/session-1/runtime');
  });
});

describe('session activity state', () => {
  it.each([
    ['RUNNING', true],
    ['AWAITING_PERMISSION', true],
    ['CANCELLING', true],
    ['IDLE', false],
    ['DISPOSED', false],
  ] as const)('treats Runtime turn state %s as active=%s', (turnState, expected) => {
    expect(isRuntimeTurnActive(turnState)).toBe(expected);
  });

  it('keeps persistent PENDING/RUNNING status as an initialization and reconnect fallback', () => {
    expect(isSessionStatusActive(SessionStatus.PENDING)).toBe(true);
    expect(isSessionStatusActive(SessionStatus.RUNNING)).toBe(true);
    expect(isSessionStatusActive(SessionStatus.COMPLETED)).toBe(false);
    expect(isSessionStatusActive(SessionStatus.FAILED)).toBe(false);
    expect(isSessionStatusActive(SessionStatus.CANCELLED)).toBe(false);
  });
});

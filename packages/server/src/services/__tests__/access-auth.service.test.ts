import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';

const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-tower-access-auth-service-'));
const dbPath = path.join(testDir, 'test.db');
process.env.AGENT_TOWER_DATABASE_URL = `file:${dbPath}`;
process.env.AGENT_TOWER_DATA_DIR = testDir;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const serverRoot = path.resolve(__dirname, '../../..');
const schemaPath = path.join(serverRoot, 'prisma/schema.prisma');

let prisma: PrismaClient;
let AccessAuthService: typeof import('../access-auth.service.js').AccessAuthService;
let getAccessAuthCookieName: typeof import('../access-auth.service.js').getAccessAuthCookieName;
let isAccessAuthCookieName: typeof import('../access-auth.service.js').isAccessAuthCookieName;
let LEGACY_ACCESS_AUTH_COOKIE_NAME: typeof import('../access-auth.service.js').LEGACY_ACCESS_AUTH_COOKIE_NAME;
let SocketGateway: typeof import('../../socket/socket-gateway.js').SocketGateway;
let getEventBus: typeof import('../../core/container.js').getEventBus;
let ClientEvents: typeof import('../../socket/events.js').ClientEvents;
let ServerEvents: typeof import('../../socket/events.js').ServerEvents;

class FakeAdapter {
  rooms = new Map<string, Set<string>>();
}

class FakeNamespace {
  sockets = new Map<string, FakeSocket>();
  adapter = new FakeAdapter();

  addSocket(socket: FakeSocket) {
    this.sockets.set(socket.id, socket);
  }
}

class FakeSocket {
  id: string;
  accessAuthSessionSecretGeneration = AccessAuthService.getSessionSecretGeneration();
  emitted: Array<{ event: string; payload: unknown }> = [];
  disconnected = false;
  private handlers = new Map<string, (...args: any[]) => void>();

  constructor(
    id: string,
    private readonly namespace: FakeNamespace,
  ) {
    this.id = id;
    this.namespace.addSocket(this);
  }

  on(event: string, handler: (...args: any[]) => void) {
    this.handlers.set(event, handler);
    return this;
  }

  emit(event: string, payload?: unknown) {
    this.emitted.push({ event, payload });
    return true;
  }

  join(room: string) {
    const sockets = this.namespace.adapter.rooms.get(room) ?? new Set<string>();
    sockets.add(this.id);
    this.namespace.adapter.rooms.set(room, sockets);
  }

  leave(room: string) {
    this.namespace.adapter.rooms.get(room)?.delete(this.id);
  }

  disconnect() {
    this.disconnected = true;
  }

  receive(event: string, payload?: unknown, ack?: (response: unknown) => void) {
    this.handlers.get(event)?.(payload, ack);
  }
}

function buildSocketGateway() {
  const namespace = new FakeNamespace();
  const sessionManager = {
    writeInput: vi.fn(),
    resize: vi.fn(),
  };
  const terminalManager = {
    write: vi.fn(),
    resize: vi.fn(),
    cleanupBySocket: vi.fn(),
  };
  const gateway = new SocketGateway(
    namespace as any,
    getEventBus(),
    sessionManager as any,
    terminalManager as any,
  );

  return { namespace, gateway, sessionManager, terminalManager };
}

describe('AccessAuthService', () => {
  beforeAll(async () => {
    execFileSync(
      'pnpm',
      ['exec', 'prisma', 'db', 'push', '--skip-generate', `--schema=${schemaPath}`],
      {
        cwd: serverRoot,
        env: { ...process.env, AGENT_TOWER_DATABASE_URL: `file:${dbPath}` },
        stdio: 'pipe',
      },
    );

    const serviceModule = await import('../access-auth.service.js');
    const utilsModule = await import('../../utils/index.js');
    const socketGatewayModule = await import('../../socket/socket-gateway.js');
    const containerModule = await import('../../core/container.js');
    const socketEventsModule = await import('../../socket/events.js');
    AccessAuthService = serviceModule.AccessAuthService;
    getAccessAuthCookieName = serviceModule.getAccessAuthCookieName;
    isAccessAuthCookieName = serviceModule.isAccessAuthCookieName;
    LEGACY_ACCESS_AUTH_COOKIE_NAME = serviceModule.LEGACY_ACCESS_AUTH_COOKIE_NAME;
    SocketGateway = socketGatewayModule.SocketGateway;
    getEventBus = containerModule.getEventBus;
    ClientEvents = socketEventsModule.ClientEvents;
    ServerEvents = socketEventsModule.ServerEvents;
    prisma = utilsModule.prisma;
  });

  beforeEach(async () => {
    await prisma.accessAuthSettings.deleteMany();
    AccessAuthService.__test.resetSettingsCache();
    AccessAuthService.__test.resetLoginRateLimit();
    AccessAuthService.__test.resetSessionSecretGeneration();
  });

  afterAll(async () => {
    await prisma.$disconnect();
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('is disabled by default and treats requests as authenticated', async () => {
    await expect(AccessAuthService.getPublicStatus(null)).resolves.toEqual({
      enabled: false,
      authenticated: true,
    });
  });

  it('derives a stable, isolated cookie name from the data directory', () => {
    const instanceA = path.join(testDir, 'instance-a');
    const equivalentInstanceA = path.join(testDir, 'nested', '..', 'instance-a');
    const instanceB = path.join(testDir, 'instance-b');

    expect(getAccessAuthCookieName(instanceA)).toBe(getAccessAuthCookieName(equivalentInstanceA));
    expect(getAccessAuthCookieName(instanceA)).not.toBe(getAccessAuthCookieName(instanceB));
    expect(getAccessAuthCookieName(instanceA)).toMatch(/^agent-tower-access-[a-f0-9]{16}$/);
    expect(isAccessAuthCookieName(LEGACY_ACCESS_AUTH_COOKIE_NAME)).toBe(true);
    expect(isAccessAuthCookieName(getAccessAuthCookieName(instanceA))).toBe(true);
    expect(isAccessAuthCookieName('agent-tower-access-unrelated')).toBe(false);
  });

  it('prefers this instance cookie, falls back to legacy, and ignores other instances', () => {
    const currentCookieName = AccessAuthService.cookieName;
    const otherCookieName = getAccessAuthCookieName(path.join(testDir, 'other-instance'));

    expect(AccessAuthService.extractCookieFromHeaderWithSource(
      `${LEGACY_ACCESS_AUTH_COOKIE_NAME}=legacy-token; ${currentCookieName}=scoped-token`,
    )).toEqual({ token: 'scoped-token', source: 'scoped' });
    expect(AccessAuthService.extractCookieFromHeaderWithSource(
      `${LEGACY_ACCESS_AUTH_COOKIE_NAME}=legacy-token`,
    )).toEqual({ token: 'legacy-token', source: 'legacy' });
    expect(AccessAuthService.extractCookieFromHeaderWithSource(
      `${otherCookieName}=other-token`,
    )).toEqual({ token: null, source: null });
  });

  it('initializes default settings safely under concurrent status requests', async () => {
    const results = await Promise.all(
      Array.from({ length: 8 }, () => AccessAuthService.getPublicStatus(null)),
    );

    expect(results).toEqual(Array.from({ length: 8 }, () => ({
      enabled: false,
      authenticated: true,
    })));

    await expect(prisma.accessAuthSettings.count()).resolves.toBe(1);
    expect(AccessAuthService.__test.getSettingsDatabaseLoadCount()).toBe(1);

    await AccessAuthService.getPublicStatus(null);
    expect(AccessAuthService.__test.getSettingsDatabaseLoadCount()).toBe(1);
  });

  it('refreshes cached settings and invalidates sessions changed by another process', async () => {
    let currentTime = 1_000_000;
    AccessAuthService.__test.setLoginRateLimitClock(() => currentTime);
    await AccessAuthService.updateSettings({
      enabled: true,
      newPassword: 'shared-db-pass',
    });
    const login = await AccessAuthService.login('shared-db-pass');

    await prisma.accessAuthSettings.update({
      where: { id: 'singleton' },
      data: { sessionSecret: 'externally-rotated-session-secret' },
    });

    await expect(AccessAuthService.validateSessionToken(login.sessionToken)).resolves.toBe(true);
    currentTime += AccessAuthService.__test.SETTINGS_CACHE_TTL_MS;
    await expect(AccessAuthService.validateSessionToken(login.sessionToken)).resolves.toBe(false);
    expect(AccessAuthService.getSessionSecretGeneration()).toBe(2);
  });

  it('enables, logs in, and invalidates old sessions after password change', async () => {
    const enabled = await AccessAuthService.updateSettings({
      enabled: true,
      newPassword: 'first-pass',
    });
    expect(enabled.settings).toMatchObject({
      enabled: true,
      passwordConfigured: true,
    });
    expect(enabled.sessionToken).toBeTruthy();

    await expect(AccessAuthService.login('wrong-pass')).rejects.toMatchObject({
      code: 'ACCESS_AUTH_INVALID_PASSWORD',
      statusCode: 401,
    });

    const firstLogin = await AccessAuthService.login('first-pass');
    expect(firstLogin.status.authenticated).toBe(true);
    expect(await AccessAuthService.validateSessionToken(firstLogin.sessionToken)).toBe(true);
    await expect(AccessAuthService.validateSessionTokenWithGeneration(firstLogin.sessionToken)).resolves.toEqual({
      valid: true,
      generation: 1,
    });

    await AccessAuthService.updateSettings({
      currentPassword: 'first-pass',
      newPassword: 'second-pass',
    });

    expect(await AccessAuthService.validateSessionToken(firstLogin.sessionToken)).toBe(false);
    await expect(AccessAuthService.login('first-pass')).rejects.toMatchObject({
      code: 'ACCESS_AUTH_INVALID_PASSWORD',
    });
    await expect(AccessAuthService.login('second-pass')).resolves.toMatchObject({
      status: {
        enabled: true,
        authenticated: true,
      },
    });
  });

  it('rejects session token validation when generation changes during the consistency check', async () => {
    await AccessAuthService.updateSettings({
      enabled: true,
      newPassword: 'first-pass',
    });
    const login = await AccessAuthService.login('first-pass');

    AccessAuthService.__test.setBeforeValidateSessionTokenWithGenerationHook(() => {
      AccessAuthService.__test.notifySessionSecretRotated();
      AccessAuthService.__test.setBeforeValidateSessionTokenWithGenerationHook(null);
    });

    await expect(AccessAuthService.validateSessionTokenWithGeneration(login.sessionToken)).resolves.toEqual({
      valid: false,
      generation: 1,
    });
  });

  it('disconnects existing sockets when access auth is enabled', async () => {
    const { namespace, gateway, sessionManager } = buildSocketGateway();
    const oldSocket = new FakeSocket('socket-old', namespace);
    gateway.register(oldSocket as any);

    try {
      await AccessAuthService.updateSettings({
        enabled: true,
        newPassword: 'enabled-pass',
      });

      expect(oldSocket.disconnected).toBe(true);

      oldSocket.disconnected = false;
      oldSocket.receive(ClientEvents.INPUT, { sessionId: 'session-1', data: 'whoami\n' });
      getEventBus().emit('session:stdout', { sessionId: 'session-1', data: 'secret output' });

      expect(sessionManager.writeInput).not.toHaveBeenCalled();
      expect(oldSocket.disconnected).toBe(true);
      expect(oldSocket.emitted).not.toContainEqual({
        event: ServerEvents.SESSION_STDOUT,
        payload: { sessionId: 'session-1', data: 'secret output' },
      });
    } finally {
      gateway.destroy();
    }
  });

  it('disconnects existing sockets when the access password changes', async () => {
    const { namespace, gateway, sessionManager, terminalManager } = buildSocketGateway();

    try {
      await AccessAuthService.updateSettings({
        enabled: true,
        newPassword: 'first-pass',
      });

      const oldSocket = new FakeSocket('socket-old', namespace);
      gateway.register(oldSocket as any);

      await AccessAuthService.updateSettings({
        currentPassword: 'first-pass',
        newPassword: 'second-pass',
      });

      expect(oldSocket.disconnected).toBe(true);

      oldSocket.disconnected = false;
      oldSocket.receive(ClientEvents.INPUT, { sessionId: 'session-1', data: 'whoami\n' });
      oldSocket.receive(ClientEvents.RESIZE, { sessionId: 'session-1', cols: 120, rows: 30 });
      oldSocket.receive(ClientEvents.TERMINAL_INPUT, { terminalId: 'terminal-1', data: 'date\n' });
      oldSocket.receive(ClientEvents.TERMINAL_RESIZE, { terminalId: 'terminal-1', cols: 100, rows: 24 });

      expect(sessionManager.writeInput).not.toHaveBeenCalled();
      expect(sessionManager.resize).not.toHaveBeenCalled();
      expect(terminalManager.write).not.toHaveBeenCalled();
      expect(terminalManager.resize).not.toHaveBeenCalled();
      expect(oldSocket.disconnected).toBe(true);
    } finally {
      gateway.destroy();
    }
  });

  it('requires the current password to disable access auth and clears old sessions', async () => {
    const enabled = await AccessAuthService.updateSettings({
      enabled: true,
      newPassword: 'first-pass',
    });

    await expect(AccessAuthService.updateSettings({
      enabled: false,
      currentPassword: 'wrong-pass',
    })).rejects.toMatchObject({
      code: 'ACCESS_AUTH_INVALID_CURRENT_PASSWORD',
    });

    const disabled = await AccessAuthService.updateSettings({
      enabled: false,
      currentPassword: 'first-pass',
    });
    expect(disabled.settings).toMatchObject({
      enabled: false,
      passwordConfigured: false,
    });
    expect(disabled.clearSession).toBe(true);

    await AccessAuthService.updateSettings({
      enabled: true,
      newPassword: 'second-pass',
    });
    expect(await AccessAuthService.validateSessionToken(enabled.sessionToken)).toBe(false);
  });

  it('requires passwords to be at least 8 characters', async () => {
    await expect(AccessAuthService.updateSettings({
      enabled: true,
      newPassword: 'short',
    })).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
    });
  });

  it('rate limits repeated failed login attempts by identifier and clears the limit after cooldown', async () => {
    let currentTime = 1_000_000;
    AccessAuthService.__test.setLoginRateLimitClock(() => currentTime);
    await AccessAuthService.updateSettings({
      enabled: true,
      newPassword: 'correct-pass',
    });

    for (let i = 0; i < AccessAuthService.__test.MAX_FAILED_LOGIN_ATTEMPTS; i += 1) {
      await expect(AccessAuthService.login('wrong-pass', '203.0.113.10')).rejects.toMatchObject({
        code: 'ACCESS_AUTH_INVALID_PASSWORD',
        statusCode: 401,
      });
    }

    await expect(AccessAuthService.login('correct-pass', '203.0.113.10')).rejects.toMatchObject({
      code: 'ACCESS_AUTH_RATE_LIMITED',
      statusCode: 429,
    });

    await expect(AccessAuthService.login('correct-pass', '203.0.113.11')).resolves.toMatchObject({
      status: {
        enabled: true,
        authenticated: true,
      },
    });

    currentTime += AccessAuthService.__test.LOGIN_COOLDOWN_MS + 1;
    await expect(AccessAuthService.login('correct-pass', '203.0.113.10')).resolves.toMatchObject({
      status: {
        enabled: true,
        authenticated: true,
      },
    });

    await expect(AccessAuthService.login('wrong-pass', '203.0.113.10')).rejects.toMatchObject({
      code: 'ACCESS_AUTH_INVALID_PASSWORD',
    });
  });

  it('creates short-lived workspace-bound preview access tokens and rotates them with password changes', async () => {
    let currentTime = 1_000_000;
    AccessAuthService.__test.setLoginRateLimitClock(() => currentTime);
    await AccessAuthService.updateSettings({
      enabled: true,
      newPassword: 'correct-pass',
    });

    const token = await AccessAuthService.createPreviewAccessToken('workspace-1');

    expect(await AccessAuthService.validatePreviewAccessToken(token, 'workspace-1')).toBe(true);
    expect(await AccessAuthService.validatePreviewAccessToken(token, 'workspace-2')).toBe(false);

    currentTime += AccessAuthService.__test.PREVIEW_ACCESS_TOKEN_TTL_MS + 1;
    expect(await AccessAuthService.validatePreviewAccessToken(token, 'workspace-1')).toBe(false);

    currentTime = 2_000_000;
    const rotatedToken = await AccessAuthService.createPreviewAccessToken('workspace-1');
    expect(await AccessAuthService.validatePreviewAccessToken(rotatedToken, 'workspace-1')).toBe(true);

    await AccessAuthService.updateSettings({
      currentPassword: 'correct-pass',
      newPassword: 'changed-pass',
    });

    expect(await AccessAuthService.validatePreviewAccessToken(rotatedToken, 'workspace-1')).toBe(false);
  });
});

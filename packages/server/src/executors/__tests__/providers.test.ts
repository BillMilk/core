import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RuntimeType, type ProviderBackupFile } from '@agent-tower/shared';
import { AgentType } from '../../types/index.js';
import {
  canDeleteProvider,
  createProvider,
  createProviderBackup,
  deleteProvider,
  getAllProviders,
  getDefaultProviders,
  getDefaultProvider,
  importProvidersFromBackup,
  previewProviderImport,
  reloadProviders,
} from '../providers.js';

const originalDataDir = process.env.AGENT_TOWER_DATA_DIR;

let tempDataDir = '';

function writeUserProviders(providers: unknown[]) {
  fs.writeFileSync(
    path.join(tempDataDir, 'providers.json'),
    JSON.stringify({ providers }, null, 2),
    'utf-8'
  );
}

describe('providers backup/import', () => {
  beforeEach(() => {
    tempDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-tower-providers-'));
    process.env.AGENT_TOWER_DATA_DIR = tempDataDir;
    reloadProviders();
  });

  afterEach(() => {
    if (originalDataDir === undefined) {
      delete process.env.AGENT_TOWER_DATA_DIR;
    } else {
      process.env.AGENT_TOWER_DATA_DIR = originalDataDir;
    }

    if (tempDataDir) {
      fs.rmSync(tempDataDir, { recursive: true, force: true });
    }

    reloadProviders();
  });

  it('exports only user-level provider data', () => {
    writeUserProviders([
      {
        id: 'codex-default',
        name: 'Codex Proxy',
        agentType: AgentType.CODEX,
        env: { OPENAI_API_KEY: 'sk-proxy' },
        config: { fullAuto: false, model: 'gpt-5.3-codex' },
        settings: 'model = "gpt-5.3-codex"',
        isDefault: true,
      },
      {
        id: 'custom-codex',
        name: 'Codex Local',
        agentType: AgentType.CODEX,
        env: { OPENAI_API_KEY: 'sk-local' },
        config: { fullAuto: true },
        isDefault: false,
        createdAt: '2026-03-23T00:00:00.000Z',
      },
    ]);

    reloadProviders();

    const backup = createProviderBackup();

    expect(backup.kind).toBe('provider-backup');
    expect(backup.providers.map(provider => provider.id)).toEqual(['codex-default', 'custom-codex']);
    expect(backup.providers.every(provider => provider.builtIn === undefined)).toBe(true);
  });

  it('previews and imports create/overwrite/skip actions correctly', () => {
    writeUserProviders([
      {
        id: 'same-provider',
        name: 'Same Provider',
        agentType: AgentType.CODEX,
        env: { OPENAI_API_KEY: 'same-key' },
        config: { fullAuto: true },
        isDefault: false,
        createdAt: '2026-03-20T00:00:00.000Z',
      },
      {
        id: 'overwrite-provider',
        name: 'Claude Old',
        agentType: AgentType.CLAUDE_CODE,
        env: { ANTHROPIC_API_KEY: 'old-key' },
        config: { dangerouslySkipPermissions: true },
        isDefault: false,
      },
    ]);

    reloadProviders();

    const backup: ProviderBackupFile = {
      version: 1,
      kind: 'provider-backup',
      exportedAt: '2026-03-23T10:00:00.000Z',
      mode: 'full',
      providers: [
        {
          id: 'same-provider',
          name: 'Same Provider',
          agentType: AgentType.CODEX,
          env: { OPENAI_API_KEY: 'same-key' },
          config: { fullAuto: true },
          isDefault: false,
        },
        {
          id: 'overwrite-provider',
          name: 'Claude New',
          agentType: AgentType.CLAUDE_CODE,
          env: { ANTHROPIC_API_KEY: 'new-key' },
          config: { dangerouslySkipPermissions: false },
          isDefault: true,
        },
        {
          id: 'new-provider',
          name: 'Gemini Team',
          agentType: AgentType.GEMINI_CLI,
          env: { GEMINI_API_KEY: 'new-provider-key' },
          config: { yolo: false },
          isDefault: false,
          createdAt: '2026-03-23T11:00:00.000Z',
        },
      ],
    };

    const preview = previewProviderImport(backup);
    expect(preview.summary).toEqual({
      create: 1,
      overwrite: 1,
      skip: 1,
    });

    const result = importProvidersFromBackup(backup);
    expect(result.summary).toEqual(preview.summary);

    const providers = getAllProviders();
    expect(providers.find(provider => provider.id === 'new-provider')?.name).toBe('Gemini Team');
    expect(providers.find(provider => provider.id === 'overwrite-provider')?.env).toEqual({
      ANTHROPIC_API_KEY: 'new-key',
    });
    expect(providers.find(provider => provider.id === 'overwrite-provider')?.isDefault).toBe(true);
    expect(providers.find(provider => provider.id === 'claude-code-default')?.isDefault).toBe(false);
    expect(providers.find(provider => provider.id === 'same-provider')?.name).toBe('Same Provider');
  });

  it('imports Codex native provider settings byte-for-byte without requiring a custom table', () => {
    const settings = '# native settings\nmodel_provider = "ollama"\nmodel = "local-model"\n';
    const backup: ProviderBackupFile = {
      version: 1,
      kind: 'provider-backup',
      exportedAt: '2026-07-15T00:00:00.000Z',
      mode: 'full',
      providers: [{
        id: 'native-codex-import',
        name: 'Native Codex Import',
        agentType: AgentType.CODEX,
        env: { OLLAMA_HOST: 'http://localhost:11434' },
        config: { model: 'local-model' },
        settings,
        isDefault: false,
      }],
    };

    expect(importProvidersFromBackup(backup).summary.create).toBe(1);
    const imported = getAllProviders().find(item => item.id === 'native-codex-import');
    expect(imported?.settings).toBe(settings);
    expect(imported?.env).toEqual({ OLLAMA_HOST: 'http://localhost:11434' });
  });

  it('deletes a user override for a built-in provider by restoring the default provider', () => {
    writeUserProviders([
      {
        id: 'claude-code-default',
        name: 'Claude Override',
        agentType: AgentType.CLAUDE_CODE,
        env: { ANTHROPIC_BASE_URL: 'https://proxy.example.com' },
        config: { dangerouslySkipPermissions: true, model: 'claude-opus-4-6' },
        isDefault: true,
      },
    ]);

    reloadProviders();

    const beforeDelete = getAllProviders().find(provider => provider.id === 'claude-code-default');
    expect(beforeDelete).toBeDefined();
    expect(beforeDelete?.builtIn).toBe(true);
    expect(canDeleteProvider(beforeDelete!)).toBe(true);

    expect(deleteProvider('claude-code-default')).toBe(true);

    const restored = getAllProviders().find(provider => provider.id === 'claude-code-default');
    const defaultProvider = getDefaultProviders().find(provider => provider.id === 'claude-code-default');

    expect(restored).toBeDefined();
    expect(defaultProvider).toBeDefined();
    expect(restored?.name).toBe(defaultProvider?.name);
    expect(restored?.env).toEqual(defaultProvider?.env);
    expect(canDeleteProvider(restored!)).toBe(false);
  });

  it('rejects deleting a pure built-in provider', () => {
    reloadProviders();

    const builtInProvider = getAllProviders().find(provider => provider.id === 'claude-code-default');
    expect(builtInProvider).toBeDefined();
    expect(canDeleteProvider(builtInProvider!)).toBe(false);

    expect(() => deleteProvider('claude-code-default')).toThrow(/Cannot delete built-in provider/);
  });

  it('keeps CLI and ACP defaults isolated for the same agent identity', () => {
    expect(getDefaultProvider(AgentType.CODEX, RuntimeType.CLI)?.id).toBe('codex-default');
    expect(getDefaultProvider(AgentType.CODEX, RuntimeType.ACP)?.id).toBe('codex-acp-default');
    expect(getDefaultProvider(AgentType.CLAUDE_CODE, RuntimeType.CLI)?.id).toBe('claude-code-default');
    expect(getDefaultProvider(AgentType.CLAUDE_CODE, RuntimeType.ACP)?.id).toBe('claude-code-acp-default');
    expect(getDefaultProvider(AgentType.QWEN_CODE, RuntimeType.ACP)?.id).toBe('qwen-code-acp-default');
  });

  it('rejects unsupported Agent/Runtime combinations', () => {
    expect(() => createProvider({
      name: 'Gemini ACP',
      agentType: AgentType.GEMINI_CLI,
      runtimeType: RuntimeType.ACP,
      env: {},
      config: {},
      isDefault: false,
    })).toThrow(/does not support the 'ACP' runtime/);

    expect(() => createProvider({
      name: 'Qwen CLI',
      agentType: AgentType.QWEN_CODE,
      runtimeType: RuntimeType.CLI,
      env: {},
      config: {},
      isDefault: false,
    })).toThrow(/does not support the 'CLI' runtime/);
  });
});

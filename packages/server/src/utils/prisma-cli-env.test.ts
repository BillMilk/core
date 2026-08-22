import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ensureSqliteDatabaseFile,
  getPrismaCacheBaseDir,
  preparePrismaCliEnv,
} from './prisma-cli-env.js';

const tempRoots: string[] = [];

function makeTempRoot(): string {
  const root = path.join(os.tmpdir(), `agent-tower-prisma-env-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  tempRoots.push(root);
  return root;
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('prisma-cli-env', () => {
  it('creates a missing SQLite file without replacing an existing database', () => {
    const dataDir = makeTempRoot();
    const dbPath = path.join(dataDir, 'nested', 'data.db');

    ensureSqliteDatabaseFile(dbPath);
    expect(readFileSync(dbPath)).toHaveLength(0);

    writeFileSync(dbPath, 'existing-database');
    ensureSqliteDatabaseFile(dbPath);
    expect(readFileSync(dbPath, 'utf-8')).toBe('existing-database');
  });

  it('redirects Prisma CLI cache into the Agent Tower data directory', () => {
    const dataDir = makeTempRoot();
    const dbPath = path.join(dataDir, 'data.db');
    const originalCacheDir = process.env.CACHE_DIR;

    const env = preparePrismaCliEnv(dataDir, dbPath, {
      PATH: '/usr/bin',
      CACHE_DIR: '/readonly/cache',
    });

    expect(env.PATH).toBe('/usr/bin');
    expect(env.AGENT_TOWER_DATABASE_URL).toBe(`file:${dbPath}`);
    expect(env.CACHE_DIR).toBe(path.join(dataDir, 'cache'));
    expect(getPrismaCacheBaseDir(dataDir)).toBe(path.join(dataDir, 'cache'));
    expect(existsSync(path.join(dataDir, 'cache'))).toBe(true);
    expect(process.env.CACHE_DIR).toBe(originalCacheDir);
  });
});

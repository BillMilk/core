import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { McpConfigResponse, McpConfigRuntimeMode } from '@agent-tower/shared';
import { INTERNAL_API_TOKEN_ENV, requireInternalApiTokenFromEnv } from '../utils/internal-api-token.js';

const SERVER_NAME = 'agent-tower';
const require = createRequire(import.meta.url);
const serviceDir = path.dirname(fileURLToPath(import.meta.url));
const serverPackageRoot = path.resolve(serviceDir, '..', '..');
const serviceRuntimeRoot = path.relative(serverPackageRoot, serviceDir).split(path.sep)[0];

export interface ManagedMcpLaunchSpec {
  serverName: string
  runtimeMode: McpConfigRuntimeMode
  command: string
  args: string[]
  entry: string
}

function resolveRuntimeMode(env: NodeJS.ProcessEnv): McpConfigRuntimeMode {
  return env.AGENT_TOWER_DESKTOP_RUNTIME_MODE === 'packaged' ? 'desktop-packaged' : 'workspace';
}

function requireRuntimeFile(filePath: string, label: string, runtimeMode: string): string {
  if (!existsSync(filePath)) {
    throw new Error(`Agent Tower MCP ${label} not found for ${runtimeMode} runtime: ${filePath}`);
  }
  return filePath;
}

function resolveWorkspaceLaunch(env: NodeJS.ProcessEnv): Omit<ManagedMcpLaunchSpec, 'serverName' | 'runtimeMode'> {
  const command = env.AGENT_TOWER_DESKTOP_NODE || process.execPath;
  const explicitEntry = env.AGENT_TOWER_MCP_ENTRY?.trim();
  if (explicitEntry) {
    const entry = requireRuntimeFile(path.resolve(explicitEntry), 'entry', 'workspace');
    return { command, args: [entry], entry };
  }

  if (serviceRuntimeRoot === 'src') {
    const entry = requireRuntimeFile(path.join(serverPackageRoot, 'src', 'mcp', 'index.ts'), 'entry', 'development-source');
    let tsxLoader: string;
    try {
      tsxLoader = require.resolve('tsx');
    } catch (error) {
      throw new Error('Agent Tower MCP tsx loader not found for development-source runtime', { cause: error });
    }
    requireRuntimeFile(tsxLoader, 'tsx loader', 'development-source');
    return { command, args: ['--import', tsxLoader, entry], entry };
  }

  const entry = requireRuntimeFile(path.join(serverPackageRoot, 'dist', 'mcp', 'index.js'), 'entry', 'workspace');
  return { command, args: [entry], entry };
}

export function resolveManagedMcpLaunchSpec(
  env: NodeJS.ProcessEnv = process.env,
): ManagedMcpLaunchSpec {
  const runtimeMode = resolveRuntimeMode(env);
  if (runtimeMode === 'desktop-packaged') {
    const entry = requireRuntimeFile(
      path.resolve(env.AGENT_TOWER_MCP_ENTRY || path.join(serverPackageRoot, 'dist', 'mcp', 'index.js')),
      'entry',
      runtimeMode,
    );
    return {
      serverName: SERVER_NAME,
      runtimeMode,
      command: env.AGENT_TOWER_NODE_RUNTIME || process.execPath,
      args: [entry],
      entry,
    };
  }

  return {
    serverName: SERVER_NAME,
    runtimeMode,
    ...resolveWorkspaceLaunch(env),
  };
}

function resolveBackendUrl(env: NodeJS.ProcessEnv): string {
  const configuredUrl = env.AGENT_TOWER_URL?.trim();
  if (configuredUrl) return configuredUrl;

  const configuredPort = env.AGENT_TOWER_PORT?.trim();
  if (configuredPort) return `http://127.0.0.1:${configuredPort}`;

  throw new Error('AGENT_TOWER_URL or AGENT_TOWER_PORT is required for managed Agent Tower MCP');
}

function buildConfigJson(command: string, args: string[], env: Record<string, string>): string {
  const serverConfig = {
    command,
    args,
    ...(Object.keys(env).length > 0 ? { env } : {}),
  };
  return JSON.stringify({
    mcpServers: {
      [SERVER_NAME]: serverConfig,
    },
  }, null, 2);
}

export function buildMcpConfigResponse(options: {
  env?: NodeJS.ProcessEnv
} = {}): McpConfigResponse {
  const env = options.env ?? process.env;
  const launch = resolveManagedMcpLaunchSpec(env);
  const configEnv: Record<string, string> = {
    [INTERNAL_API_TOKEN_ENV]: requireInternalApiTokenFromEnv(env),
    AGENT_TOWER_URL: resolveBackendUrl(env),
  };
  if (env.AGENT_TOWER_PORT) {
    configEnv.AGENT_TOWER_PORT = env.AGENT_TOWER_PORT;
  }

  if (launch.runtimeMode === 'desktop-packaged' && env.ELECTRON_RUN_AS_NODE === '1') {
    configEnv.ELECTRON_RUN_AS_NODE = '1';
  }

  const configJson = buildConfigJson(launch.command, launch.args, configEnv);

  return {
    serverName: launch.serverName,
    runtimeMode: launch.runtimeMode,
    command: launch.command,
    args: launch.args,
    env: configEnv,
    config: JSON.parse(configJson) as McpConfigResponse['config'],
    configJson,
  };
}

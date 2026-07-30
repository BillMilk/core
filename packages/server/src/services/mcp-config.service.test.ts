import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { buildMcpConfigResponse, resolveManagedMcpLaunchSpec } from './mcp-config.service.js'

const serverPackageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const sourceMcpEntry = path.join(serverPackageRoot, 'src', 'mcp', 'index.ts')

describe('mcp-config service', () => {
  it('builds packaged desktop config from bundled runtime paths', () => {
    const config = buildMcpConfigResponse({
      env: {
        AGENT_TOWER_DESKTOP_RUNTIME_MODE: 'packaged',
        AGENT_TOWER_NODE_RUNTIME: 'C:\\Program Files\\Agent Tower\\resources\\runtime\\node\\node.exe',
        AGENT_TOWER_MCP_ENTRY: sourceMcpEntry,
        AGENT_TOWER_DATA_DIR: '/Users/test/.agent-tower',
        AGENT_TOWER_URL: 'http://127.0.0.1:12580',
        AGENT_TOWER_PORT: '12580',
        AGENT_TOWER_INTERNAL_TOKEN: 'test-internal-token',
      } as NodeJS.ProcessEnv,
    })

    expect(config.runtimeMode).toBe('desktop-packaged')
    expect(config.command).toBe('C:\\Program Files\\Agent Tower\\resources\\runtime\\node\\node.exe')
    expect(config.args).toEqual([sourceMcpEntry])
    expect(config.env).toEqual({
      AGENT_TOWER_INTERNAL_TOKEN: 'test-internal-token',
      AGENT_TOWER_URL: 'http://127.0.0.1:12580',
      AGENT_TOWER_PORT: '12580',
    })
    expect(config.configJson).toContain(sourceMcpEntry)
    expect(config.configJson).not.toContain('agent-tower-mcp')
  })

  it('keeps Electron node-mode env only for packaged fallback config', () => {
    const config = buildMcpConfigResponse({
      env: {
        AGENT_TOWER_DESKTOP_RUNTIME_MODE: 'packaged',
        AGENT_TOWER_NODE_RUNTIME: '/app/Contents/MacOS/Agent Tower',
        AGENT_TOWER_MCP_ENTRY: sourceMcpEntry,
        AGENT_TOWER_DATA_DIR: '/Users/test/.agent-tower',
        AGENT_TOWER_URL: 'http://127.0.0.1:12580',
        AGENT_TOWER_PORT: '12580',
        AGENT_TOWER_INTERNAL_TOKEN: 'test-internal-token',
        ELECTRON_RUN_AS_NODE: '1',
      } as NodeJS.ProcessEnv,
    })

    expect(config.command).toBe('/app/Contents/MacOS/Agent Tower')
    expect(config.env).toEqual({
      AGENT_TOWER_INTERNAL_TOKEN: 'test-internal-token',
      AGENT_TOWER_URL: 'http://127.0.0.1:12580',
      AGENT_TOWER_PORT: '12580',
      ELECTRON_RUN_AS_NODE: '1',
    })
  })

  it('honors an explicit workspace entry without global agent-tower-mcp command', () => {
    const config = buildMcpConfigResponse({
      env: {
        AGENT_TOWER_MCP_ENTRY: sourceMcpEntry,
        AGENT_TOWER_DATA_DIR: '/tmp/agent-tower-desktop-dev/data',
        AGENT_TOWER_URL: 'http://127.0.0.1:42232',
        AGENT_TOWER_INTERNAL_TOKEN: 'test-internal-token',
      } as NodeJS.ProcessEnv,
    })

    expect(config.runtimeMode).toBe('workspace')
    expect(config.command).toBe(process.execPath)
    expect(config.args).toEqual([sourceMcpEntry])
    expect(config.env).toEqual({
      AGENT_TOWER_INTERNAL_TOKEN: 'test-internal-token',
      AGENT_TOWER_URL: 'http://127.0.0.1:42232',
    })
    expect(config.configJson).not.toContain('agent-tower-mcp')
  })

  it('launches the source MCP with the repository tsx loader in development', () => {
    const launch = resolveManagedMcpLaunchSpec({} as NodeJS.ProcessEnv)

    expect(launch.runtimeMode).toBe('workspace')
    expect(launch.command).toBe(process.execPath)
    expect(launch.entry).toBe(sourceMcpEntry)
    expect(launch.args).toEqual([
      '--import',
      expect.stringMatching(/[\\/]tsx[\\/]dist[\\/]loader\.mjs$/),
      sourceMcpEntry,
    ])
  })

  it('fails clearly when an explicit MCP entry is missing', () => {
    const missingEntry = path.join(serverPackageRoot, 'missing', 'mcp', 'index.js')
    expect(() => resolveManagedMcpLaunchSpec({
      AGENT_TOWER_MCP_ENTRY: missingEntry,
    } as NodeJS.ProcessEnv)).toThrow(`Agent Tower MCP entry not found for workspace runtime: ${missingEntry}`)
  })

  it('fails clearly when internal token env is missing', () => {
    expect(() => buildMcpConfigResponse({
      env: {
        AGENT_TOWER_MCP_ENTRY: sourceMcpEntry,
        AGENT_TOWER_URL: 'http://127.0.0.1:42232',
      } as NodeJS.ProcessEnv,
    })).toThrow('AGENT_TOWER_INTERNAL_TOKEN is required')
  })

  it('fails clearly when the managed MCP backend endpoint is missing', () => {
    expect(() => buildMcpConfigResponse({
      env: {
        AGENT_TOWER_MCP_ENTRY: sourceMcpEntry,
        AGENT_TOWER_INTERNAL_TOKEN: 'test-internal-token',
      } as NodeJS.ProcessEnv,
    })).toThrow('AGENT_TOWER_URL or AGENT_TOWER_PORT is required')
  })
})

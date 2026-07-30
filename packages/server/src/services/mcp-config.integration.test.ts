import { createServer, type Server } from 'node:http'
import { AddressInfo } from 'node:net'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { afterEach, describe, expect, it } from 'vitest'
import { buildMcpConfigResponse } from './mcp-config.service.js'

describe('managed MCP launch', () => {
  let backend: Server | undefined
  let client: Client | undefined

  afterEach(async () => {
    await client?.close().catch(() => undefined)
    client = undefined
    if (backend?.listening) {
      await new Promise<void>((resolve, reject) => {
        backend!.close(error => error ? reject(error) : resolve())
      })
    }
    backend = undefined
  })

  it('starts the generated development MCP and calls the configured backend', async () => {
    const requests: Array<{ path: string, token?: string }> = []
    backend = createServer((request, response) => {
      requests.push({
        path: request.url ?? '',
        token: request.headers['x-agent-tower-internal-token'] as string | undefined,
      })
      if (request.url?.startsWith('/api/system/workspace-context')) {
        response.writeHead(404, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ error: 'No active workspace' }))
        return
      }
      if (request.url?.startsWith('/api/projects')) {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ projects: [{ id: 'project-1', name: 'Managed MCP Test' }] }))
        return
      }
      response.writeHead(404, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: 'Not Found' }))
    })
    await new Promise<void>((resolve, reject) => {
      backend!.once('error', reject)
      backend!.listen(0, '127.0.0.1', resolve)
    })
    const port = (backend.address() as AddressInfo).port
    const config = buildMcpConfigResponse({
      env: {
        AGENT_TOWER_URL: `http://127.0.0.1:${port}`,
        AGENT_TOWER_PORT: String(port),
        AGENT_TOWER_INTERNAL_TOKEN: 'managed-mcp-test-token',
      } as NodeJS.ProcessEnv,
    })

    const stderr: string[] = []
    const transport = new StdioClientTransport({
      command: config.command,
      args: config.args,
      cwd: process.cwd(),
      env: { ...getDefaultEnvironment(), ...config.env },
      stderr: 'pipe',
    })
    transport.stderr?.on('data', chunk => stderr.push(String(chunk)))
    client = new Client({ name: 'agent-tower-mcp-launch-test', version: '1.0.0' })

    try {
      await client.connect(transport)
    } catch (error) {
      throw new Error(`Managed MCP failed to initialize: ${stderr.join('')}`, { cause: error })
    }

    const tools = await client.listTools()
    expect(tools.tools.map(tool => tool.name)).toContain('list_projects')

    const result = await client.callTool({ name: 'list_projects', arguments: {} })
    expect(JSON.stringify(result.content)).toContain('Managed MCP Test')
    expect(requests.some(request => request.path.startsWith('/api/projects'))).toBe(true)
    expect(requests.every(request => request.token === 'managed-mcp-test-token')).toBe(true)
  }, 20_000)
})

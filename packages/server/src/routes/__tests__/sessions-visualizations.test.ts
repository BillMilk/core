import Fastify, { type FastifyInstance } from 'fastify';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sessionRoutes } from '../sessions.js';
import {
  AgentVisualizationError,
  AgentVisualizationService,
} from '../../services/agent-visualization.service.js';
import {
  AgentArtifactError,
  AgentArtifactService,
} from '../../services/agent-artifact.service.js';

describe('session visualization route', () => {
  let app: FastifyInstance;
  let readSpy: ReturnType<typeof vi.spyOn>;
  let downloadSpy: ReturnType<typeof vi.spyOn>;
  let tempDir: string;

  beforeEach(async () => {
    readSpy = vi.spyOn(AgentVisualizationService.prototype, 'read');
    downloadSpy = vi.spyOn(AgentArtifactService.prototype, 'findOrPublish');
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-tower-artifact-route-'));
    app = Fastify();
    await app.register(sessionRoutes, { prefix: '/api' });
  });

  afterEach(async () => {
    readSpy.mockRestore();
    downloadSpy.mockRestore();
    await app.close();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('serves the wrapped document with a sandboxed no-store policy', async () => {
    readSpy.mockResolvedValue('<!doctype html><p>Visualization</p>');

    const response = await app.inject({
      method: 'GET',
      url: '/api/sessions/session-1/visualizations/result.html',
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/html');
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['content-security-policy']).toContain('sandbox allow-scripts');
    expect(response.body).toContain('Visualization');
    expect(readSpy).toHaveBeenCalledWith('session-1', 'result.html');
  });

  it('maps visualization service errors to structured HTTP errors', async () => {
    readSpy.mockRejectedValue(new AgentVisualizationError(
      'VISUALIZATION_NOT_FOUND',
      404,
      'Visualization not found',
    ));

    const response = await app.inject({
      method: 'GET',
      url: '/api/sessions/session-1/visualizations/missing.html',
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({
      error: 'Visualization not found',
      code: 'VISUALIZATION_NOT_FOUND',
    });
  });

  it('serves a published artifact as a verified browser download', async () => {
    const storagePath = path.join(tempDir, 'report.pdf');
    await fs.writeFile(storagePath, 'pdf bytes');
    downloadSpy.mockResolvedValue({
      id: 'artifact-1',
      sourcePath: 'output/report.pdf',
      originalName: '报告.pdf',
      mimeType: 'application/pdf',
      sizeBytes: Buffer.byteLength('pdf bytes'),
      storagePath,
      hash: 'hash',
    });

    const response = await app.inject({
      method: 'GET',
      url: '/api/sessions/session-1/artifacts/download?path=output%2Freport.pdf',
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('application/pdf');
    expect(response.headers['content-length']).toBe(String(Buffer.byteLength('pdf bytes')));
    expect(response.headers['content-disposition']).toContain('attachment;');
    expect(response.headers['content-disposition']).toContain("filename*=UTF-8''");
    expect(response.body).toBe('pdf bytes');
    expect(downloadSpy).toHaveBeenCalledWith('session-1', 'output/report.pdf');
  });

  it('maps artifact service failures to structured HTTP errors', async () => {
    downloadSpy.mockRejectedValue(new AgentArtifactError(
      'INVALID_ARTIFACT_PATH',
      400,
      'Invalid artifact path',
    ));

    const response = await app.inject({
      method: 'GET',
      url: '/api/sessions/session-1/artifacts/download?path=..%2Fsecret.txt',
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      error: 'Invalid artifact path',
      code: 'INVALID_ARTIFACT_PATH',
    });
  });
});

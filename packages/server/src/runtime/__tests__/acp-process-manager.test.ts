import { describe, expect, it } from 'vitest';
import { AcpProcessManager, type AcpProcessExit } from '../acp/process-manager.js';

function managerFor(source: string) {
  return new AcpProcessManager({
    command: process.execPath,
    args: ['-e', source],
    cwd: process.cwd(),
    env: { ...process.env },
  });
}

function waitForExit(manager: AcpProcessManager): Promise<AcpProcessExit> {
  return new Promise((resolve) => manager.onExit(resolve));
}

describe('AcpProcessManager', () => {
  it('forwards valid NDJSON and bounds/redacts stderr diagnostics', async () => {
    const manager = managerFor([
      "process.stderr.write('authorization: token-secretvalue123\\n')",
      "process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:1,result:{ok:true}})+'\\n')",
    ].join(';'));
    const streams = await manager.start();
    const exit = waitForExit(manager);
    const reader = streams.output.getReader();
    const decoder = new TextDecoder();
    let output = '';
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      output += decoder.decode(chunk.value, { stream: true });
    }

    expect(JSON.parse(output.trim())).toMatchObject({ id: 1, result: { ok: true } });
    await expect(exit).resolves.toMatchObject({
      exitCode: 0,
      stderrExcerpt: expect.stringContaining('[REDACTED]'),
    });
  });

  it('rejects malformed ACP stdout frames', async () => {
    const manager = managerFor("process.stdout.write('not-json\\n')");
    const streams = await manager.start();
    const reader = streams.output.getReader();

    await expect(reader.read()).rejects.toMatchObject({ code: 'protocol_violation' });
    await waitForExit(manager);
  });

  it('terminates the detached adapter process on stop', async () => {
    const manager = managerFor("process.on('SIGTERM',()=>process.exit(0));process.stdout.write('{}\\n');setInterval(()=>{},1000)");
    const streams = await manager.start();
    await streams.output.getReader().read();

    await expect(manager.stop()).resolves.toMatchObject({ exitCode: 0 });
  });
});

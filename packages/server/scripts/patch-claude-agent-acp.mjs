import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const SUPPORTED_VERSION = '0.59.0';
const PATCH_MARKER = 'AGENT_TOWER_DEFER_CLAUDE_CONTEXT_USAGE';

export async function patchClaudeAgentAcp(options = {}) {
  const moduleRequire = options.moduleRoot
    ? createRequire(path.join(path.resolve(options.moduleRoot), 'package.json'))
    : require;
  let packagePath;
  let adapterPath;
  try {
    packagePath = moduleRequire.resolve('@agentclientprotocol/claude-agent-acp/package.json');
    adapterPath = moduleRequire.resolve('@agentclientprotocol/claude-agent-acp/dist/acp-agent.js');
  } catch (error) {
    if (error?.code === 'MODULE_NOT_FOUND') {
      return { changed: false, skipped: true, reason: 'claude-acp-not-installed' };
    }
    throw error;
  }

  const packageJson = JSON.parse(await readFile(packagePath, 'utf8'));
  if (packageJson.version !== SUPPORTED_VERSION) {
    throw new Error(
      `Unsupported @agentclientprotocol/claude-agent-acp version: ${String(packageJson.version)}. Expected ${SUPPORTED_VERSION}.`,
    );
  }

  const source = await readFile(adapterPath, 'utf8');
  if (source.includes(PATCH_MARKER)) {
    return { changed: false, adapterPath, version: packageJson.version };
  }

  const sessionContextWindow = `const contextWindowSize = (await fetchContextWindowSize(q, this.logger)) ??
            inferContextWindowFromModel(models.currentModelId, allowlistedModelInfo?.resolvedModel, allowlistedModelInfo?.displayName, allowlistedModelInfo?.description) ??
            DEFAULT_CONTEXT_WINDOW;`;
  const deferredSessionContextWindow = `// ${PATCH_MARKER}: do not block session/new on gateway context probing.
        const contextWindowSize = process.env.${PATCH_MARKER} === "1"
            ? inferContextWindowFromModel(models.currentModelId, allowlistedModelInfo?.resolvedModel, allowlistedModelInfo?.displayName, allowlistedModelInfo?.description) ??
                DEFAULT_CONTEXT_WINDOW
            : (await fetchContextWindowSize(q, this.logger)) ??
                inferContextWindowFromModel(models.currentModelId, allowlistedModelInfo?.resolvedModel, allowlistedModelInfo?.displayName, allowlistedModelInfo?.description) ??
                DEFAULT_CONTEXT_WINDOW;`;
  const modelContextWindow = `session.contextWindowSize =
                    (await fetchContextWindowSize(session.query, this.logger)) ??
                        inferContextWindowFromModel(value, newModelInfo?.resolvedModel, newModelInfo?.displayName, newModelInfo?.description) ??
                        DEFAULT_CONTEXT_WINDOW;`;
  const deferredModelContextWindow = `// ${PATCH_MARKER}: do not block model switching on gateway context probing.
                session.contextWindowSize = process.env.${PATCH_MARKER} === "1"
                    ? inferContextWindowFromModel(value, newModelInfo?.resolvedModel, newModelInfo?.displayName, newModelInfo?.description) ??
                        DEFAULT_CONTEXT_WINDOW
                    : (await fetchContextWindowSize(session.query, this.logger)) ??
                        inferContextWindowFromModel(value, newModelInfo?.resolvedModel, newModelInfo?.displayName, newModelInfo?.description) ??
                        DEFAULT_CONTEXT_WINDOW;`;

  if (!source.includes(sessionContextWindow)) {
    throw new Error('Claude ACP session context-window code changed; refusing an unsafe patch.');
  }
  if (!source.includes(modelContextWindow)) {
    throw new Error('Claude ACP model-switch context-window code changed; refusing an unsafe patch.');
  }

  const patched = source
    .replace(sessionContextWindow, deferredSessionContextWindow)
    .replace(modelContextWindow, deferredModelContextWindow);
  await writeFile(adapterPath, patched, 'utf8');
  return { changed: true, adapterPath, version: packageJson.version };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await patchClaudeAgentAcp();
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const pnpmCommand = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
const totalDeadline = Date.now() + 90_000

const steps = [
  {
    name: 'behavior',
    timeoutMs: 35_000,
    command: pnpmCommand,
    args: [
      'exec',
      'vitest',
      'run',
      'packages/web/src/pages/__tests__/ProviderSettingsPage.test.tsx',
      'packages/web/src/pages/__tests__/ProviderSettingsPage.browser.test.tsx',
      '--testTimeout=10000',
      '--hookTimeout=10000',
    ],
  },
  {
    name: 'layout',
    timeoutMs: 50_000,
    command: process.execPath,
    args: ['scripts/provider-settings-layout-test.mjs'],
  },
]

function terminate(child, signal) {
  if (!child.pid) return
  try {
    if (process.platform === 'win32') child.kill(signal)
    else process.kill(-child.pid, signal)
  } catch {
    // The process may already have exited between the status check and signal.
  }
}

async function runStep(step) {
  const remainingMs = totalDeadline - Date.now()
  const timeoutMs = Math.min(step.timeoutMs, remainingMs)
  if (timeoutMs <= 0) {
    throw new Error(`[provider-settings] step=${step.name} assertion=total-timeout timeoutMs=90000`)
  }

  console.log(`[provider-settings] step=${step.name} status=start timeoutMs=${timeoutMs}`)
  const child = spawn(step.command, step.args, {
    cwd: repoRoot,
    env: { ...process.env, FORCE_COLOR: '0' },
    stdio: 'inherit',
    detached: process.platform !== 'win32',
  })

  const exitCode = await new Promise((resolve, reject) => {
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      terminate(child, 'SIGTERM')
      setTimeout(() => terminate(child, 'SIGKILL'), 1_000).unref()
    }, timeoutMs)

    child.once('error', error => {
      clearTimeout(timer)
      reject(error)
    })
    child.once('exit', (code, signal) => {
      clearTimeout(timer)
      if (timedOut) {
        reject(new Error(
          `[provider-settings] step=${step.name} assertion=step-timeout timeoutMs=${timeoutMs}`,
        ))
        return
      }
      if (signal) {
        reject(new Error(`[provider-settings] step=${step.name} assertion=unexpected-signal signal=${signal}`))
        return
      }
      resolve(code ?? 1)
    })
  })

  if (exitCode !== 0) {
    throw new Error(`[provider-settings] step=${step.name} assertion=nonzero-exit exitCode=${exitCode}`)
  }
  console.log(`[provider-settings] step=${step.name} status=passed`)
}

try {
  for (const step of steps) await runStep(step)
  console.log('[provider-settings] status=passed behavior=happy-dom layout=headless-chromium')
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
}

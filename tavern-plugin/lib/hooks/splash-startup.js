import { execFile } from 'node:child_process'
import { addAbortListener } from 'node:events'
import { isAbsolute, join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { setTimeout as sleep } from 'node:timers/promises'
import { promisify } from 'node:util'

const run = promisify(execFile)
const baseURL = 'http://127.0.0.1:8000/v1'
const readyURL = 'http://127.0.0.1:8000/ready'
const startupTimeoutMs = 120_000

async function splashReady() {
  try {
    const response = await fetch(readyURL, { signal: AbortSignal.timeout(1500), redirect: 'error' })
    await response.body?.cancel()
    return response.ok && response.headers.get('server') === 'Splash'
  } catch {
    return false
  }
}

async function ensureSplash(projectDir) {
  if (await splashReady()) return
  if (!isAbsolute(projectDir)) throw new Error('splashProjectDir 必须为绝对路径')
  const deadline = performance.now() + startupTimeoutMs
  await run('/bin/sh', [join(projectDir, 'launcher/start.command'),
    '--host', '127.0.0.1', '--offline', '--max-memory', '16G', '--max-context', '16K',
    '--disable-ane', '--language-only', '--default-reasoning-effort', 'none', '--idle-release', '30m',
  ], {
    cwd: projectDir,
    env: { ...process.env, SPLASH_PORT: '8000', TERM_PROGRAM: '' },
    timeout: startupTimeoutMs,
  })
  // A launcher that finds an existing listener can return before that server is ready.
  while (!(await splashReady())) {
    if (performance.now() >= deadline) throw new Error('等待 Splash 就绪超时')
    await sleep(250)
  }
}

async function waitForStartup(startup, signal) {
  if (!signal) return startup
  let listener
  const cancelled = new Promise((_, reject) => {
    listener = addAbortListener(signal, () => reject(signal.reason))
  })
  try {
    await Promise.race([startup, cancelled])
    signal.throwIfAborted()
  } finally {
    listener[Symbol.dispose]()
  }
}

export function registerSplashStartupHook(ctx, projectDir, start = ensureSplash) {
  let startup
  ctx.on('llm/stream', (request, next) => {
    if (request.provider !== 'splash') return next()
    const settings = ctx.get('settings')?.describe().find(row => row.ns === 'llm-pi-ai')
    const endpoint = settings?.value?.providers?.splash?.baseURL
    if (typeof endpoint !== 'string' || endpoint.replace(/\/$/, '') !== baseURL) return next()

    return (async function* () {
      const { signal } = request
      try {
        signal?.throwIfAborted()
        startup ??= start(projectDir).finally(() => { startup = undefined })
        await waitForStartup(startup, signal)
      } catch (error) {
        const failure = signal?.aborted
          ? { kind: 'aborted', failure: { code: 'ABORTED', message: '已取消 Splash 请求' } }
          : { kind: 'error', failure: { code: 'SPLASH_STARTUP_FAILED', message: `Splash 启动失败：${error.message}` } }
        yield { type: 'finish', reason: failure }
        return
      }
      yield* next()
    })()
  }, { global: true })
}

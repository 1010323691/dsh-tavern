import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import { registerSplashStartupHook } from '../tavern-plugin/lib/hooks/splash-startup.js'

const project = '/local/splash'
const local = 'http://127.0.0.1:8000/v1'
const request = { provider: 'splash', model: 'text', messages: [] }
const stop = { type: 'finish', reason: { kind: 'stop' } }
const settings = baseURL => ({ describe: () => [{ ns: 'llm-pi-ai', value: { providers: { splash: { baseURL } } } }] })

test('direct and prepared Splash calls share startup and cancel independently', { skip: !process.env.DSH_BOOT_MODULE }, async t => {
  const anchor = pathToFileURL(process.env.DSH_BOOT_MODULE)
  const { boot } = await import(anchor.href)
  const llm = new URL('../../dsh-llm/lib/index.js', anchor)
  const { LlmAdapter } = await import(llm.href)
  const dir = await mkdtemp(join(tmpdir(), 'tavern-splash-test-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const host = join(dir, 'host.yml')
  await writeFile(host, `- id: llm\n  name: ${llm.href}\n`)
  const ctx = await boot('splash-test', host)
  t.after(() => ctx.fiber.dispose())
  let generationCount = 0
  class FixtureAdapter extends LlmAdapter {
    async resolveModel(provider, id) { return { provider, id, name: id, context: { contextWindow: 16384 } } }
    async *stream() { generationCount++; yield stop }
  }
  ctx.llm.registerAdapter(['splash'], new FixtureAdapter())
  const { promise: ready, resolve: markReady } = Promise.withResolvers()
  let starts = 0
  registerSplashStartupHook({ on: ctx.on.bind(ctx), get: () => settings(local) }, project, async dir => {
    assert.equal(dir, project)
    starts++
    await ready
  })
  const prepared = await ctx.llm.prepareCall(request)
  const controller = new AbortController()
  const cancelled = Array.fromAsync(ctx.llm.stream({ ...request, signal: controller.signal }))
  const waiting = Array.fromAsync(prepared.stream({ ...prepared.config, messages: [] }))
  controller.abort()
  const [aborted] = await cancelled
  assert.equal(aborted.reason.kind, 'aborted')
  assert.equal(generationCount, 0)
  assert.equal(starts, 1)
  markReady()
  assert.deepEqual(await waiting, [stop])
  assert.equal(generationCount, 1)
})

test('a failed startup can be retried and unrelated routes bypass startup', async () => {
  let handler
  let endpoint = 'https://example.test/v1'
  let starts = 0
  registerSplashStartupHook({ on: (_event, hook) => { handler = hook }, get: () => settings(endpoint) }, project, async () => {
    if (++starts === 1) throw new Error('launcher failed')
  })
  const next = async function* () { yield stop }
  assert.deepEqual(await Array.fromAsync(handler(request, next)), [stop])
  endpoint = `${local}/`
  assert.deepEqual(await Array.fromAsync(handler({ ...request, provider: 'other' }, next)), [stop])
  assert.equal(starts, 0)
  const [failed] = await Array.fromAsync(handler(request, next))
  assert.equal(failed.reason.failure.code, 'SPLASH_STARTUP_FAILED')
  assert.match(failed.reason.failure.message, /launcher failed/)
  assert.deepEqual(await Array.fromAsync(handler(request, next)), [stop])
  assert.equal(starts, 2)
})

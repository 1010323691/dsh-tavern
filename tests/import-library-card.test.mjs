import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { importLibraryCard } from '../bin/import-library-card.mjs'

async function fixture(t, name = 'new.json') {
  const dir = await mkdtemp(join(tmpdir(), 'card-importer-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const file = join(dir, name)
  await writeFile(file, '{}')
  return file
}
const json = value => Response.json(value)

test('importer trades the URL token for the auth cookie and imports the file as a new card', async t => {
  const file = await fixture(t), routes = []
  const card = await importLibraryCard({ url: 'http://127.0.0.1:3081/?token=test-only', file, fetchImpl: async (url, options) => {
    routes.push(url.pathname)
    if (url.pathname === '/') {
      assert.equal(url.searchParams.get('token'), 'test-only')
      assert.equal(options.redirect, 'manual')
      return new Response(null, { status: 303, headers: { location: './', 'set-cookie': 'dsh-auth-x=signed; HttpOnly; Path=/' } })
    }
    assert.equal(url.searchParams.has('token'), false)
    assert.match(options.headers.cookie, /dsh-auth-x=signed/)
    if (url.pathname.endsWith('/card-upload')) {
      assert.equal(options.headers['content-length'], '2')
      const parts = []
      for await (const chunk of options.body) parts.push(chunk)
      assert.equal(Buffer.concat(parts).toString(), '{}')
      return json({ uploadId: 'staged', size: 2 })
    }
    const body = JSON.parse(options.body)
    assert.equal(body.uploadId, 'staged')
    if (url.pathname.endsWith('/discardCardUpload')) return json({ removed: true })
    assert.equal(body.name, 'new.json')
    assert.equal(body.replacePath, undefined)
    return json({ card: { path: 'cards/new.json', name: 'new' } })
  } })
  assert.equal(card.path, 'cards/new.json')
  assert.deepEqual(routes, ['/', '/api/dsh-tavern/card-upload', '/api/dsh-tavern/importCardUpload', '/api/dsh-tavern/discardCardUpload'])
})

test('importer rejects unsupported files before contacting the service', async t => {
  const file = await fixture(t, 'card.txt')
  await assert.rejects(importLibraryCard({ url: 'http://127.0.0.1:3081/', file, fetchImpl: () => assert.fail('no request') }), /支持 JSON/)
})

const fs = require('fs/promises')
const path = require('path')
const test = require('brittle')
const health = require('../lib/health')
const { runBlindPeerBin } = require('./helpers')

test('healthcheck passes for fresh ready state', async (t) => {
  const filename = path.join(await t.tmp(), 'health.json')
  await health.writeHealthCheckFile(filename)

  const result = await runBlindPeerBin(t, 'healthcheck', '--health-file', filename)

  t.is(result.exitCode, 0)
  t.alike(JSON.parse(result.stdout), { ok: true })
})

test('healthcheck requires health-file path', async (t) => {
  const result = await runBlindPeerBin(t, 'healthcheck')

  t.is(result.exitCode, 1)
  t.ok(result.stderr.includes('--health-file is required'))
})

test('healthcheck fails for stale state', async (t) => {
  const filename = path.join(await t.tmp(), 'health.json')
  await health.writeHealthCheckFile(filename)
  const state = JSON.parse(await fs.readFile(filename, 'utf8'))
  state.timestamp = Date.now() - 60_000
  await fs.writeFile(filename, JSON.stringify(state))

  const result = await runBlindPeerBin(t, 'healthcheck', '--health-file', filename)

  t.is(result.exitCode, 1)
  t.ok(result.stderr.includes('blind-peer is not ready'))
})

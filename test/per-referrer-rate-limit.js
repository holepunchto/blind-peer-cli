const path = require('path')
const test = require('brittle')
const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const createTestnet = require('hyperdht/testnet')
const Hyperswarm = require('hyperswarm')
const Corestore = require('corestore')
const Client = require('blind-peering')
const { runBlindPeerBin, spawnBlindPeerBin, waitForOutput } = require('./helpers')

const FLAGS_ERROR =
  '--per-referrer-rate-limit-capacity and --per-referrer-rate-limit-interval must be used together'

test('requires both per-referrer rate-limit flags', async (t) => {
  for (const [flag, value] of [
    ['--per-referrer-rate-limit-capacity', '1'],
    ['--per-referrer-rate-limit-interval', '1000']
  ]) {
    const result = await runBlindPeerBin(t, flag, value)

    t.not(result.exitCode, 0, `rejects ${flag} without its matching flag`)
    t.ok(result.stdout.includes(FLAGS_ERROR), 'logs the validation error')
  }
})

test('limits add-cores requests for the same referrer', async (t) => {
  const { bootstrap } = await createTestnet(3, t.teardown)
  const storage = path.join(await t.tmp(), 'blind-peer')

  const proc = spawnBlindPeerBin(
    t,
    '--storage',
    storage,
    '--bootstrap',
    String(bootstrap[0].port),
    '--per-referrer-rate-limit-capacity',
    '1',
    '--per-referrer-rate-limit-interval',
    '60000',
    '--debug'
  )

  const blindPeerKey = JSON.parse(await waitForOutput(proc, 'Listening at'))
    .msg.split(' ')
    .pop()
  const swarm = new Hyperswarm({ bootstrap })
  const store = new Corestore(path.join(await t.tmp(), 'blind-peering'))
  const client = new Client(swarm.dht, store, { keys: [blindPeerKey] })
  t.teardown(async () => {
    await client.close()
    await swarm.destroy()
    await store.close()
  })

  const referrer = crypto.keyPair().publicKey
  const firstHandled = waitForOutput(proc, 'add-cores request handled')
  await client.addCore(store.get({ name: 'first' }), { referrer })
  await firstHandled

  const rateLimited = waitForOutput(proc, 'Per-referrer add-cores rate limit reached')
  await client.addCore(store.get({ name: 'second' }), { referrer })

  const log = JSON.parse(await rateLimited)
  t.is(
    log.msg,
    `Per-referrer add-cores rate limit reached: referrer=${b4a.toString(referrer, 'hex')}`
  )
})

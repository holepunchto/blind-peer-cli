const path = require('path')
const test = require('brittle')
const createTestnet = require('hyperdht/testnet')
const { spawnBlindPeerBin, waitForOutput } = require('./helpers')
const Client = require('blind-peering')
const Hyperswarm = require('hyperswarm')
const Corestore = require('corestore')

test('logs contain handshake of the connection', async (t) => {
  const { bootstrap } = await createTestnet(3, t.teardown)
  const storage = path.join(await t.tmp(), 'blind-peer')

  const proc = spawnBlindPeerBin(
    t,
    '--storage',
    storage,
    '--bootstrap',
    String(bootstrap[0].port),
    '--debug'
  )

  const blindPeerKey = JSON.parse(await waitForOutput(proc, 'Listening at'))
    .msg.split(' ')
    .pop()

  const swarm = new Hyperswarm({ bootstrap })
  const store = new Corestore(path.join(await t.tmp(), 'blind-peering'))
  const core = store.get({ name: 'core' })
  const client = new Client(swarm.dht, store, { keys: [blindPeerKey] })
  client.addCoreBackground(core)

  const addCoreLog = JSON.parse(await waitForOutput(proc, 'add-cores request handled'))
  t.not(addCoreLog.blindPeeringVersion, undefined)

  await client.close()
  await swarm.destroy()
  await store.close()
})

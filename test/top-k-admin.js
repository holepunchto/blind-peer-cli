const path = require('path')
const test = require('brittle')
const crypto = require('hypercore-crypto')
const HyperDHT = require('hyperdht')
const createTestnet = require('hyperdht/testnet')
const IdEnc = require('hypercore-id-encoding')
const ProtomuxRPC = require('protomux-rpc')
const { ADMIN_CHANNEL_ID, AdminQueryTopKEncoding } = require('blind-peer-encodings')
const { spawnBlindPeerBin, waitForOutput } = require('./helpers')

test('trusted peer can query top-k admin RPC through the CLI', async (t) => {
  const { bootstrap } = await createTestnet(3, t.teardown)
  const adminKeyPair = crypto.keyPair()
  const storage = path.join(await t.tmp(), 'blind-peer')

  const proc = spawnBlindPeerBin(
    t,
    '--storage',
    storage,
    '--bootstrap',
    String(bootstrap[0].port),
    '--trusted-peer',
    IdEnc.encode(adminKeyPair.publicKey)
  )

  const listeningLine = await waitForOutput(proc, 'Listening at')
  const rawPublicKey = /"Listening at ([^"]+)"/.exec(listeningLine)[1]
  const serverPublicKey = IdEnc.decode(rawPublicKey)
  const adminClient = await setupAdminClient(t, {
    bootstrap,
    serverPublicKey,
    keyPair: adminKeyPair
  })

  const response = await adminClient.request('query-top-k', null, AdminQueryTopKEncoding)
  t.alike(
    response,
    {
      version: 1,
      ip: [],
      referrer: [],
      peerPublicKey: []
    },
    'trusted peer can query the top-k admin endpoint'
  )
})

async function setupAdminClient(t, { bootstrap, serverPublicKey, keyPair }) {
  const dht = new HyperDHT({ bootstrap, keyPair })
  t.teardown(() => dht.destroy(), { order: 4000 })

  const stream = dht.connect(serverPublicKey)
  const rpc = new ProtomuxRPC(stream, {
    id: ADMIN_CHANNEL_ID,
    valueEncoding: null
  })
  t.teardown(() => rpc.destroy(), { order: 3999 })

  await rpc.fullyOpened()

  return rpc
}

const path = require('path')
const test = require('brittle')
const crypto = require('hypercore-crypto')
const createTestnet = require('hyperdht/testnet')
const IdEnc = require('hypercore-id-encoding')
const { spawnBlindPeerBin, waitForOutput } = require('./helpers')

test('logs multiple IP ban list public keys through the CLI', async (t) => {
  const { bootstrap } = await createTestnet(3, t.teardown)
  const storage = path.join(await t.tmp(), 'blind-peer')

  const firstKey = IdEnc.encode(crypto.keyPair().publicKey)
  const secondKey = IdEnc.encode(crypto.keyPair().publicKey)

  const proc = spawnBlindPeerBin(
    t,
    '--storage',
    storage,
    '--bootstrap',
    String(bootstrap[0].port),
    '--ip-ban-list-key',
    firstKey,
    '--ip-ban-list-key',
    secondKey
  )

  const line = await waitForOutput(proc, 'IP ban list public keys')
  const log = JSON.parse(line)

  // we only test simple logging here, the main logic is already tested in blind-peer
  t.is(
    log.msg,
    `IP ban list public keys:\n  -${firstKey}\n  -${secondKey}`,
    'logs all submitted IP ban list public keys'
  )

  proc.kill()
})

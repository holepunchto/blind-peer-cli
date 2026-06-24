const path = require('path')
const test = require('brittle')
const createTestnet = require('hyperdht/testnet')
const process = require('process')
const { runBlindPeerBin, spawnBlindPeerBin, waitForOutput } = require('./helpers')

test('readiness-probe command passes against control socket', async (t) => {
  if (process.platform === 'win32') {
    t.pass('the readiness probe relies on a Unix domain socket, which is not available on Windows')
    return
  }
  const { bootstrap } = await createTestnet(3, t.teardown)
  const storage = path.join(await t.tmp(), 'blind-peer')
  const socketPath = path.join(await t.tmp(), 'control.sock')

  const failed = await runBlindPeerBin(t, 'readiness-probe', '--control-socket', socketPath)
  t.not(failed.exitCode, 0, 'first health check should fail')

  const proc = spawnBlindPeerBin(
    t,
    '--storage',
    storage,
    '--bootstrap',
    String(bootstrap[0].port),
    '--control-socket',
    socketPath
  )

  // wait for a while for blind-peer to ready
  await waitForOutput(proc, 'Health probe listening at')

  const result = await runBlindPeerBin(t, 'readiness-probe', '--control-socket', socketPath)
  t.is(result.exitCode, 0)
  t.alike(JSON.parse(result.stdout), { ok: true })
})

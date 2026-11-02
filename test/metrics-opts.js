const path = require('path')
const test = require('brittle')
const createTestnet = require('hyperdht/testnet')
const { runBlindPeerBin, spawnBlindPeerBin, waitForOutput } = require('./helpers')

test('constructs correct metricsOpts for the blind-peer', async (t) => {
  const { bootstrap } = await createTestnet(3, t.teardown)
  const storage = path.join(await t.tmp(), 'blind-peer')

  const proc = spawnBlindPeerBin(
    t,
    '--storage',
    storage,
    '--bootstrap',
    String(bootstrap[0].port),
    '--metrics-client-name',
    'app1',
    '--metrics-client-name',
    'app2',
    '--metrics-max-client-versions',
    '3'
  )

  const log = JSON.parse(await waitForOutput(proc, 'Metrics client labels enabled'))
  t.alike(log.metricsOpts, { allowedClientNames: ['app1', 'app2'], maxUniqueClientVersions: 3 })
})

test('skips metricsOpts when flags are not set', async (t) => {
  const { bootstrap } = await createTestnet(3, t.teardown)
  const storage = path.join(await t.tmp(), 'blind-peer')

  const proc = spawnBlindPeerBin(t, '--storage', storage, '--bootstrap', String(bootstrap[0].port))

  let stdout = ''
  proc.stdout.on('data', (data) => {
    stdout += data.toString()
  })
  await waitForOutput(proc, 'Listening')

  t.absent(stdout.includes('Metrics client labels enabled'), 'no metrics client labels log')
})

test('requires --metrics-client-name with --metrics-max-client-versions', async (t) => {
  const result = await runBlindPeerBin(t, '--metrics-max-client-versions', '3')

  t.not(result.exitCode, 0, 'rejects --metrics-max-client-versions without a client name')
  t.ok(
    result.stdout.includes(
      '--metrics-client-name must be set to use --metrics-max-client-versions'
    ),
    'logs the validation error'
  )
})

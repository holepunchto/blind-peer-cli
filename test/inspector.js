const fs = require('fs/promises')
const path = require('path')
const { once } = require('events')
const { spawn } = require('child_process')
const process = require('process')
const test = require('brittle')
const createTestnet = require('hyperdht/testnet')
const IdEnc = require('hypercore-id-encoding')
const { isBare } = require('which-runtime')
const { spawnBlindPeerBin, waitForOutput } = require('./helpers')

const INSPECTOR_EXECUTABLE = require.resolve(
  isBare ? 'hyperdht-inspector-cli/bin-bare.js' : 'hyperdht-inspector-cli/bin.js'
)

test('inspector CLI allows trusted peers and rejects untrusted peers', async (t) => {
  const { bootstrap } = await createTestnet(10, t.teardown)
  const dir = await t.tmp()
  const storage = path.join(dir, 'blind-peer')
  const trustedStorage = path.join(dir, 'trusted-inspector')
  const identity = await runInspectorCli(t, 'identity', '--storage', trustedStorage)

  t.is(identity.exitCode, 0, `inspector CLI prints its identity: ${identity.stderr}`)
  const trustedPublicKey = IdEnc.decode(identity.stdout.trim())

  const proc = spawnBlindPeerBin(
    t,
    '--storage',
    storage,
    '--bootstrap',
    String(bootstrap[0].port),
    '--trusted-peer',
    IdEnc.encode(trustedPublicKey),
    '--dangerously-enable-inspector'
  )

  const listeningLine = await waitForOutput(proc, 'Listening at')
  const rawPublicKey = /"Listening at ([^"]+)"/.exec(listeningLine)[1]
  const serverPublicKey = IdEnc.decode(rawPublicKey)
  const profilePath = path.join(dir, 'profile.cpuprofile')

  const trusted = await runInspectorCli(
    t,
    'cpu-profile',
    IdEnc.encode(serverPublicKey),
    '--out',
    profilePath,
    '--duration',
    '100',
    '--storage',
    trustedStorage,
    '--bootstrap',
    JSON.stringify(bootstrap)
  )
  t.is(trusted.exitCode, 0, `trusted peer can use the inspector CLI: ${trusted.stderr}`)

  const profile = JSON.parse(await fs.readFile(profilePath, 'utf8'))
  t.ok(profile.nodes.length > 0, 'inspector CLI writes a CPU profile')

  const heapdumpPath = path.join(dir, 'profile.heapsnapshot')
  const heapdump = await runInspectorCli(
    t,
    'heapdump',
    IdEnc.encode(serverPublicKey),
    '--out',
    heapdumpPath,
    '--storage',
    trustedStorage,
    '--bootstrap',
    JSON.stringify(bootstrap)
  )
  t.is(heapdump.exitCode, 0, `trusted peer can capture a heapdump: ${heapdump.stderr}`)

  const heapSnapshot = JSON.parse(await fs.readFile(heapdumpPath, 'utf8'))
  t.ok(heapSnapshot.nodes.length > 0, 'inspector CLI writes a heap snapshot')

  const untrusted = await runInspectorCli(
    t,
    'cpu-profile',
    IdEnc.encode(serverPublicKey),
    '--out',
    path.join(dir, 'untrusted.cpuprofile'),
    '--duration',
    '100',
    '--storage',
    path.join(dir, 'untrusted-inspector'),
    '--bootstrap',
    JSON.stringify(bootstrap)
  )
  t.not(untrusted.exitCode, 0, 'untrusted peer cannot use the inspector CLI')
})

async function runInspectorCli(t, ...args) {
  const proc = spawn(process.execPath, [INSPECTOR_EXECUTABLE, ...args])

  t.teardown(async () => {
    if (proc.exitCode === null && proc.signalCode === null) {
      const killed = once(proc, 'exit')
      proc.kill('SIGKILL')
      await killed
    }
  }, 10)

  let stdout = ''
  let stderr = ''

  proc.stdout.on('data', (data) => {
    stdout += data.toString()
  })
  proc.stderr.on('data', (data) => {
    stderr += data.toString()
  })

  const [exitCode] = await once(proc, 'close')

  return { exitCode, stdout, stderr }
}

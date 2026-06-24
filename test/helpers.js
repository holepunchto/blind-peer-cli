const { spawn } = require('child_process')
const path = require('path')
const { once } = require('events')
const process = require('process')
const NewlineDecoder = require('newline-decoder')
const { isBare } = require('which-runtime')

const EXECUTABLE = isBare
  ? path.join(__dirname, '..', 'bare-bin.js')
  : path.join(__dirname, '..', 'bin.js')

exports.spawnBlindPeerBin = (t, ...args) => {
  const proc = spawn(process.execPath, [EXECUTABLE, ...args])

  t.teardown(async () => {
    if (proc.exitCode === null) {
      // const killedP = once(proc, 'exit')
      proc.kill('SIGKILL')
      // await killedP
    }
  }, 10)

  process.once('exit', () => {
    if (proc.exitCode === null) proc.kill('SIGKILL')
  })

  return proc
}

exports.runBlindPeerBin = async (t, ...args) => {
  const proc = exports.spawnBlindPeerBin(t, ...args)

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

exports.waitForOutput = (proc, text, timeout = 30_000) => {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Timeout waiting for "${text}"`))
    }, timeout)

    const stdoutDec = new NewlineDecoder('utf-8')
    proc.stdout.on('data', (data) => {
      for (const line of stdoutDec.push(data)) {
        if (line.includes(text)) {
          clearTimeout(timer)
          resolve(line)
        }
      }
    })
  })
}

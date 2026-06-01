const fs = require('fs/promises')
const path = require('path')
const process = require('process')

const MAX_AGE = 30_000

async function writeHealthCheckFile(filepath) {
  await fs.mkdir(path.dirname(filepath), { recursive: true })
  await fs.writeFile(filepath, JSON.stringify({ timestamp: Date.now(), pid: process.pid }))
}

async function checkHealthCheckFile(filepath) {
  try {
    const state = JSON.parse(await fs.readFile(filepath, 'utf8'))

    // A health file is valid only if the writer process still exists
    // and refreshed the timestamp recently.
    process.kill(state.pid, 0)

    return Date.now() - state.timestamp <= MAX_AGE
  } catch (e) {
    console.error(e.message ?? 'Unknown error')
    return false
  }
}

async function deleteHealthCheckFile(filepath) {
  try {
    await fs.unlink(filepath)
  } catch (e) {
    if (e.code !== 'ENOENT') throw e
  }
}

module.exports = {
  writeHealthCheckFile,
  checkHealthCheckFile,
  deleteHealthCheckFile
}

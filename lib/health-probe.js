const b4a = require('b4a')
const c = require('compact-encoding')
const FramedStream = require('framed-stream')
const ProtomuxRPC = require('protomux-rpc')
const ProtomuxRPCRouter = require('protomux-rpc-router')
const net = require('net')

const RPC_ID = b4a.from('blind-peer-health-probe')

module.exports = class HealthProbe {
  constructor(socketPath) {
    this.socketPath = socketPath
    this.router = new ProtomuxRPCRouter()
    this.server = net.createServer((socket) => {
      this.router.handleConnection(new FramedStream(socket), RPC_ID)
    })
  }

  async ready() {
    this.router.method(
      'readiness-probe',
      {
        requestEncoding: c.none,
        responseEncoding: c.none
      },
      () => null
    )

    await this.router.ready()

    this.server.listen(this.socketPath)

    await new Promise((resolve, reject) => {
      this.server.once('listening', resolve)
      this.server.once('error', reject)
    })
  }

  async close() {
    this.server.close()

    await new Promise((resolve, reject) => {
      this.server.once('close', resolve)
    })

    await this.router.close()
  }

  static async readinessProbe(socketPath) {
    const socket = net.connect(socketPath)

    await new Promise((resolve, reject) => {
      socket.once('connect', resolve)
      socket.once('error', reject)
      setTimeout(() => reject(new Error('Timeout')), 5_000).unref()
    })

    const rpc = new ProtomuxRPC(new FramedStream(socket), {
      id: RPC_ID,
      valueEncoding: null
    })

    try {
      await rpc.fullyOpened()
      await rpc.request('readiness-probe', null, {
        requestEncoding: c.none,
        responseEncoding: c.none
      })
      return true
    } finally {
      rpc.destroy()
      socket.destroy()
    }
  }
}

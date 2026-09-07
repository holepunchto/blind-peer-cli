#!/usr/bin/env node

const { command, flag } = require('paparam')
const goodbye = require('graceful-goodbye')
const idEnc = require('hypercore-id-encoding')
const Instrumentation = require('hyper-instrument')
// const RegisterClient = require('autobase-discovery/client/register')
const byteSize = require('tiny-byte-size')
const pino = require('pino')
const ProtomuxRPCRouter = require('protomux-rpc-router')
const defaultMiddleware = require('protomux-rpc-middleware')
const process = require('process')
const b4a = require('b4a')
const hypCrypto = require('hypercore-crypto')
const BlindPeer = require('blind-peer')
const { version: ownVersion } = require('./package.json')
const HealthProbe = require('./lib/health-probe')

const SERVICE_NAME = 'blind-peer'
const DEFAULT_STORAGE_LIMIT_MB = 100_000
const DEFAULT_TOP_K_PEER_THRESHOLD = 100
const DEFAULT_TOP_K_REFERRER_THRESHOLD = 100
const DEFAULT_TREE_CACHE_SIZE = 100_000
const DEFAULT_PUSH_NOTIF_RATE_LIMIT_INTERVAL = 10
const DEFAULT_PUSH_NOTIF_RATE_LIMIT_CAPACITY = 50

const readinessProbeCommand = command(
  'readiness-probe',
  flag('--control-socket [path]', 'Control Unix domain socket path'),
  async function ({ flags }) {
    const controlSocket = flags.controlSocket
    if (!controlSocket) {
      console.error('--control-socket is required')
      process.exit(1)
      return
    }

    try {
      await HealthProbe.readinessProbe(controlSocket)
      console.log(JSON.stringify({ ok: true }))
    } catch (e) {
      console.error(`blind-peer is not ready: ${e.message ?? 'readiness-probe failed'}`)
      process.exit(1)
    }
  }
)

const cmd = command(
  'blind-peer',
  flag('--storage|-s [path]', 'Storage path, defaults to ./blind-peer'),
  flag(
    '--port|-p [int]',
    'DHT Port to try to bind to. Only relevant when that port is not firewalled. (defaults to a random port)'
  ),
  flag('--bootstrap [port]', 'Bootstrap port (only relevant for tests)'),
  flag(
    '--active-corestore',
    'Use an active corestore (useful for blind peers dedicated to seeding)'
  ),
  flag(
    '--trusted-peer|-t [trusted-peer]',
    'Public key of a trusted peer (allowed to set announce: true). Can be more than 1.'
  ).multiple(),
  flag('--debug|-d', 'Enable debug mode (more logs)'),
  flag(
    '--max-storage|-m [int]',
    `Max storage usage, in Mb (defaults to ${DEFAULT_STORAGE_LIMIT_MB})`
  ),
  flag(
    '--router-key [router-key]',
    'Public key of the blind peer router to use for peer resolution. Can be hex or z32.'
  ),
  flag(
    '--ip-ban-list-key [ip-ban-list-key]',
    'Public key of an IP ban list to subscribe to. Can be hex or z32. Can be more than 1.'
  ).multiple(),
  flag(
    '--push-gateway-key [push-gateway-key]',
    'Public key of a push gateway to forward notifications to. Can be hex or z32. Can be more than 1.'
  ).multiple(),
  flag(
    '--autodiscovery-rpc-key [autodiscovery-rpc-key]',
    'Public key where the autodiscovery service is listening. When set, the autodiscovery-seed must also be set. Can be hex or z32.'
  ),
  flag(
    '--autodiscovery-seed [autodiscovery-seed]',
    '64-byte seed used to authenticate to the autodiscovery service.  Can be hex or z32.'
  ),
  flag(
    '--autodiscovery-service-name [autodiscovery-service-name]',
    `Name under which to register the service (default ${SERVICE_NAME})`
  ),
  flag(
    '--scraper-public-key [scraper-public-key]',
    'Public key of a dht-prometheus scraper.  Can be hex or z32.'
  ),
  flag(
    '--scraper-secret [scraper-secret]',
    'Secret of the dht-prometheus scraper.  Can be hex or z32.'
  ),
  flag('--scraper-alias [scraper-alias]', '(optional) Alias with which to register to the scraper'),
  flag(
    '--tree-cache-size [tree-cache-size]',
    `(Advanced) tree cache size in hypercore storage. Defaults to ${DEFAULT_TREE_CACHE_SIZE}`
  ),
  flag(
    '--log-streams',
    '(Temporary, Advanced): enable debug logs on the UDX streams managed by the dht'
  ),
  flag(
    '--repl [repl]',
    'Expose a repl-swarm at the passed-in seed (32 bytes in hex or z32 notation). Use for debugging only.'
  ),
  flag(
    '--auto-shutdown-minutes [auto-shutdown-minutes]',
    '(Temporary, Advanced) Automatically shut the process down after X minutes, with a variation of 20%'
  ),
  flag(
    '--top-k-peer-threshold [int]',
    `(Advanced) Spike threshold for top-k tracking by peer (defaults to ${DEFAULT_TOP_K_PEER_THRESHOLD})`
  ),
  flag(
    '--top-k-referrer-threshold [int]',
    `(Advanced) Spike threshold for top-k tracking by referrer (defaults to ${DEFAULT_TOP_K_REFERRER_THRESHOLD})`
  ),
  flag(
    '--push-notifications-rate-limit-capacity [int]',
    `(Advanced) capacity for the push notifications rate limit (defaults to ${DEFAULT_PUSH_NOTIF_RATE_LIMIT_CAPACITY})`
  ),
  flag(
    '--push-notifications-rate-limit-interval [int]',
    `(Advanced) interval in ms for the push notifications rate limit (defaults to ${DEFAULT_PUSH_NOTIF_RATE_LIMIT_INTERVAL})`
  ),

  flag('--control-socket [path]', 'Listen for Kubernetes exec-probe control RPCs on this socket'),
  readinessProbeCommand,
  async function ({ flags }) {
    const debug = flags.debug
    const logger = pino({
      level: debug ? 'debug' : 'info',
      name: 'blind-peer'
    })
    logger.info('Starting blind peer')

    const handleFatalError = (err, errType) => {
      logger.fatal(err, errType)
      process.exit(1)
    }
    process.on('uncaughtException', (err) => handleFatalError(err, 'uncaughtException'))
    process.on('unhandledRejection', (err) => handleFatalError(err, 'unhandledRejection'))

    const logStreams = flags.logStreams

    const storage = flags.storage || 'blind-peer'
    const activeCorestore = flags.activeCorestore || false
    const port = flags.port ? parseInt(flags.port) : null
    const bootstrap = flags.bootstrap
      ? [{ host: '127.0.0.1', port: parseInt(flags.bootstrap, 10) }]
      : null

    const maxBytes = 1_000_000 * parseInt(flags.maxStorage || DEFAULT_STORAGE_LIMIT_MB)
    const trustedPubKeys = (flags.trustedPeer || []).map((k) => idEnc.decode(k))
    const routerKey = flags.routerKey ? idEnc.decode(flags.routerKey) : null
    const ipBanListKeys = (flags.ipBanListKey || []).map((k) => idEnc.decode(k))
    const pushGatewayKeys = (flags.pushGatewayKey || []).map((k) => idEnc.decode(k))

    const treeCacheSize = parseInt(flags.treeCacheSize || DEFAULT_TREE_CACHE_SIZE)
    const treeCache = { maxSize: treeCacheSize }

    const peerThreshold = flags.topKPeerThreshold || DEFAULT_TOP_K_PEER_THRESHOLD
    const referrerThreshold = flags.topKReferrerThreshold || DEFAULT_TOP_K_REFERRER_THRESHOLD

    const pushNotifRateLimit = {
      capacity: flags.pushNotificationsRateLimitCapacity || DEFAULT_PUSH_NOTIF_RATE_LIMIT_CAPACITY,
      intervalMs: flags.pushNotificationsRateLimitInterval || DEFAULT_PUSH_NOTIF_RATE_LIMIT_INTERVAL
    }

    const adminRpcRouter = new ProtomuxRPCRouter()
    adminRpcRouter.use(
      defaultMiddleware({
        logger: {
          instance: logger
        }
      })
    )

    const blindPeer = new BlindPeer(storage, {
      bootstrap,
      activeCorestore,
      trustedPubKeys,
      maxBytes,
      port,
      treeCache,
      routerKey,
      adminRouter: adminRpcRouter,
      ipBanListKeys,
      pushGatewayKeys,
      pushGatewayPoolOpts: {
        rateLimit: pushNotifRateLimit
      },
      topK: {
        bucketCount: 6,
        bucketTime: 10_000,
        k: 5,
        peerThreshold,
        referrerThreshold
      }
    })

    blindPeer.on('flush-error', (e) => {
      logger.warn(e, 'Error while flushing the db')
    })
    blindPeer.on('notification-error', async (e, connection, request) => {
      const handshake = getHandshake(connection)
      logger.warn(
        {
          ...handshake,
          discoveryKey: b4a.toString(request.destination.discoveryKey, 'hex'),
          publicKey: idEnc.encode(connection.remotePublicKey),
          err: e
        },
        'Notification error'
      )
      if (flags.debug) {
        try {
          logger.debug(
            {
              ...handshake,
              ip: connection.rawStream.remoteHost,
              publicKey: idEnc.encode(connection.remotePublicKey)
            },
            'Notification error: ip'
          )

          const requestJson = {
            block: {
              ...request.block,
              key: idEnc.encode(request.block.key)
            },
            destination: {
              ...request.destination,
              key: idEnc.encode(request.destination.key),
              discoveryKey: b4a.toString(request.destination.discoveryKey, 'hex')
            }
          }
          logger.debug({ ...handshake, request: requestJson }, 'Notification error: request')

          const core = await blindPeer.store.get(request.block.key)
          await core.ready()

          try {
            const coreInfo = await core.info()
            const coreInfoJson = {
              ...coreInfo,
              key: idEnc.encode(coreInfo.key),
              discoveryKey: idEnc.encode(coreInfo.discoveryKey)
            }
            logger.debug({ ...handshake, coreInfo: coreInfoJson }, 'Notification error: core.info')
            const corePeersJson = core.peers.slice(0, 10).map((peer) => ({
              remotePublicKey: idEnc.encode(peer.remotePublicKey),
              remoteLength: peer.remoteLength,
              remoteContiguousLength: peer.remoteContiguousLength,
              remoteFork: peer.remoteFork,
              remoteCanUpgrade: peer.remoteCanUpgrade
            }))
            logger.debug(
              { ...handshake, peersLength: core.peers.length },
              'Notification error: core.peers.length'
            )
            logger.debug({ ...handshake, peers: corePeersJson }, 'Notification error: core.peers')
          } finally {
            await core.close()
          }
          const record = await blindPeer.db.getCoreRecord(request.block.key)
          if (record) {
            const recordJson = {
              ...record,
              key: idEnc.encode(record.key),
              referrer: record.referrer ? idEnc.encode(record.referrer) : null
            }
            logger.debug({ ...handshake, record: recordJson }, 'Notification error: core record')
          }
        } catch (e) {
          logger.warn(e, 'Notification error: debug failed')
        }
      }
    })
    blindPeer.on('notification-error-snapshot', (snapshot) => {
      logger.warn({ snapshot }, 'Notification error: core snapshot')
    })
    blindPeer.on('warn', (e) => {
      logger.warn(e, 'warn')
    })

    blindPeer.on('notification-rx', (request, stream) => {
      try {
        logger.debug(
          {
            ...getHandshake(stream),
            publicKey: streamToStr(stream),
            blockIndex: request.block.index,
            core: idEnc.normalize(request.block.key),
            discoveryKey: idEnc.normalize(hypCrypto.discoveryKey(request.block.key)),
            roomKey: idEnc.normalize(request.destination.key),
            roomDiscoveryKey: idEnc.normalize(request.destination.discoveryKey)
          },
          'Notification request received'
        )
      } catch (e) {
        logger.warn(e, 'Failed to log notification request')
      }
    })

    blindPeer.on('notification-sent', (request, payload, stream, runtime) => {
      try {
        logger.info(
          {
            ...getHandshake(stream),
            publicKey: streamToStr(stream),
            blockIndex: request.block.index,
            discoveryKey: idEnc.normalize(hypCrypto.discoveryKey(request.block.key)),
            roomDiscoveryKey: idEnc.normalize(request.destination.discoveryKey),
            runtime
          },
          'Notification sent'
        )
      } catch (e) {
        logger.warn(e, 'Failed to log notification sent')
      }
    })

    blindPeer.on('muxer-paired', (stream) => {
      logger.debug(
        { ...getHandshake(stream), publicKey: streamToStr(stream) },
        'Paired muxer with peer'
      )
    })
    blindPeer.on('muxer-error', (e, stream) => {
      logger.info(
        { ...getHandshake(stream), publicKey: streamToStr(stream), err: e },
        'Error while running the muxer protocol'
      )
    })
    blindPeer.on('add-cores-received', (stream, request) => {
      logger.debug(
        {
          ...getHandshake(stream),
          publicKey: streamToStr(stream),
          referrer: request.referrer ? idEnc.encode(request.referrer) : null,
          cores: request.cores.map((core) => idEnc.encode(hypCrypto.discoveryKey(core.key)))
        },
        'add-cores request received'
      )
    })
    blindPeer.on('add-cores-done', (stream) => {
      logger.debug(
        { ...getHandshake(stream), publicKey: streamToStr(stream) },
        'add-cores request handled'
      )
    })
    blindPeer.topKByPeer.on('spike', (key, count) => {
      logger.info({ key, count }, 'top-k by peer spiked')
    })
    blindPeer.topKByReferrer.on('spike', (key, count) => {
      logger.info({ key, count }, 'top-k by referrrer spiked')
    })
    blindPeer.topKByIp.on('spike', (key, count) => {
      logger.debug({ key, count }, 'top-k by ip spiked')
    })

    blindPeer.on('add-new-core', (record, _, stream) => {
      try {
        const log = {
          ...getHandshake(stream),
          publicKey: streamToStr(stream),
          ...recordToLog(record)
        }
        if (record.announce) {
          logger.info(log, 'add-core request received')
        } else {
          logger.debug(log, 'add-core request received')
        }
      } catch (e) {
        logger.info(e, 'Invalid add-core request received')
      }
    })
    blindPeer.on('delete-blocked', (stream, { key }) => {
      logger.info(
        { ...getHandshake(stream), publicKey: streamToStr(stream), key: idEnc.normalize(key) },
        'Blocked delete-core request from untrusted peer'
      )
    })
    blindPeer.on('delete-core', (stream, { key, existing }) => {
      logger.info(
        {
          ...getHandshake(stream),
          publicKey: streamToStr(stream),
          key: idEnc.normalize(key),
          existing
        },
        'Received delete-core request from trusted peer'
      )
    })
    blindPeer.on('delete-core-end', (stream, { key, announced }) => {
      logger.info(
        {
          ...getHandshake(stream),
          publicKey: streamToStr(stream),
          key: idEnc.normalize(key),
          announced
        },
        'Completed delete-core request from trusted peer'
      )
    })

    blindPeer.on('downgrade-announce', ({ record, remotePublicKey }) => {
      try {
        logger.info(
          { publicKey: idEnc.normalize(remotePublicKey), ...recordToLog(record) },
          'Downgraded announce because the peer is not trusted'
        )
      } catch (e) {
        logger.error(e, 'Unexpected error while logging downgrade-announce')
      }
    })
    blindPeer.on('add-cores-downgrade-announce', ({ remotePublicKey }) => {
      try {
        logger.info(
          { publicKey: idEnc.normalize(remotePublicKey) },
          'Downgraded announce because the peer is not trusted'
        )
      } catch (e) {
        logger.error(e, 'Unexpected error while logging add-cores-downgrade-announce')
      }
    })

    blindPeer.on('announce-core', (core) => {
      logger.info(coreToLog(core, true), 'Started announcing core')
    })
    blindPeer.on('announced-initial-cores', () => {
      logger.info('Announced all initial cores')
    })
    blindPeer.on('core-downloaded', (core) => {
      logger.info(coreToLog(core, true), 'Announced core fully downloaded')
    })
    blindPeer.on('core-append', (core) => {
      logger.info(coreToLog(core, true), 'Detected announced-core length update')
    })
    blindPeer.on('core-client-mode-changed', (core, isClient) => {
      logger.info(
        { ...coreToLog(core, true), isClient },
        isClient ? 'Announced-core enabled client mode' : 'Announced-core disabled client mode'
      )
    })

    blindPeer.on('gc-start', ({ bytesToClear }) => {
      logger.info(
        {
          bytesToClear: byteSize(bytesToClear),
          bytesAllocated: byteSize(blindPeer.digest.bytesAllocated),
          maxBytes: byteSize(blindPeer.maxBytes)
        },
        `Starting GC`
      )
    })
    blindPeer.on('gc-done', ({ bytesCleared }) => {
      logger.info(
        {
          bytesCleared: byteSize(bytesCleared),
          bytesAllocated: byteSize(blindPeer.digest.bytesAllocated),
          maxBytes: byteSize(blindPeer.maxBytes)
        },
        `Completed GC`
      )
    })
    if (debug) {
      blindPeer.on('core-activity', (core) => {
        logger.debug(coreToLog(core), 'Core activity')
      })
    }

    blindPeer.on('invalid-request', (core, err, req, from) => {
      logger.warn(
        {
          ...getHandshake(from.stream),
          publicKey: idEnc.normalize(from.stream.remotePublicKey),
          ip: from.stream?.rawStream?.remoteHost,
          port: from.stream?.rawStream?.remotePort,
          key: idEnc.normalize(core.key),
          err
        },
        'Received invalid request'
      )
    })

    logger.info({ storage }, 'Using storage')
    if (trustedPubKeys.length > 0) {
      logger.info(
        { trustedPublicKeys: [...blindPeer.trustedPubKeys].map(idEnc.normalize) },
        'Trusted public keys'
      )
    }
    if (routerKey) logger.info({ routerPublicKey: idEnc.normalize(routerKey) }, 'Router public key')
    if (ipBanListKeys.length > 0) {
      logger.info(
        { ipBanListKeys: blindPeer.ipBanLists.map((list) => idEnc.normalize(list.key)) },
        'IP ban list public keys'
      )
    }
    if (pushGatewayKeys.length > 0) {
      logger.info(
        { pushGatewayKeys: blindPeer.pushGatewayKeys.map(idEnc.normalize) },
        'Push gateway public keys'
      )
    }

    let instrumentation = null
    goodbye(async () => {
      if (instrumentation) {
        logger.info('Closing instrumentation')
        await instrumentation.close()
      }
      logger.info('Shutting down blind peer')
      await blindPeer.close()
      logger.info('Shut down blind peer')
    })

    if (flags.repl) {
      const seed = idEnc.decode(flags.repl)
      logger.warn('Setting up REPL swarm, enabling remote access to this process')
      const replSwarm = require('repl-swarm')
      replSwarm({ seed, logSeed: false, blindPeer, instrumentation })
    }

    await blindPeer.ready() // needed to be able to access the swarm object
    logger.info({ mode: blindPeer.store.active ? 'active' : 'passive' }, 'Corestore mode')
    blindPeer.swarm.on('ban', (peerInfo, err) => {
      logger.warn({ publicKey: b4a.toString(peerInfo.publicKey, 'hex'), err }, 'Banned peer')
    })
    if (debug) {
      blindPeer.swarm.on('connection', (conn, peerInfo) => {
        const publicKey = idEnc.normalize(peerInfo.publicKey)
        logger.debug({ publicKey }, 'Opened connection')
        conn.on('close', () => logger.debug({ publicKey }, 'Closed connection'))
        conn.on('error', (err) => {
          const log = { ...getHandshake(conn), publicKey, err }
          if (err.code === 'ECONNRESET') {
            logger.debug(log, 'Connection error')
            return
          }
          logger.info(log, 'Connection error')
        })
      })
    }

    if (logStreams) {
      logger.warn('Advanced debugging option log-streams enabled')
      setInterval(() => {
        try {
          let nrBigStreams = 0
          for (const stream of blindPeer.swarm.dht.rawStreams) {
            const pendingWrites = stream._wreqs.length - stream._wfree.length
            if (pendingWrites >= 100) {
              nrBigStreams++
              logger.warn(
                {
                  streamId: stream.id,
                  remoteId: stream.remoteId,
                  pendingWrites,
                  stream: stream.toJSON(),
                  socket: stream.socket ? stream.socket.toJSON() : null,
                  streamHandle: b4a.toString(stream._handle, 'hex'),
                  socketHandle: stream.socket ? b4a.toString(stream.socket._handle, 'hex') : null
                },
                'Stream has many pending writes'
              )
            }
          }
          if (nrBigStreams > 0) {
            logger.warn({ nrBigStreams }, 'Total streams with many pending writes')
          }
        } catch (e) {
          // we don't want to crash the process with our debugging
          logger.warn(e, 'logStreams errored unexpectedly')
        }
      }, 30_000)
    }

    await blindPeer.listen()

    const localAddress = blindPeer.swarm.dht.localAddress()
    logger.info({ host: localAddress.host, port: localAddress.port }, 'Blind peer listening')
    logger.info(
      {
        bytesAllocated: byteSize(blindPeer.digest.bytesAllocated),
        maxBytes: byteSize(blindPeer.maxBytes)
      },
      `Bytes allocated`
    )

    if (flags.controlSocket) {
      const healthProbe = new HealthProbe(flags.controlSocket)
      await healthProbe.ready()

      goodbye(async () => {
        logger.info('Closing health probe')
        await healthProbe.close()
      })

      logger.info({ controlSocket: flags.controlSocket }, 'Health probe listening')
    }

    if (flags.autodiscoveryRpcKey) {
      throw new Error('autobase discovery temp not supported')
      /* const autodiscoveryRpcKey = idEnc.decode(flags.autodiscoveryRpcKey)
      const seed = idEnc.decode(flags.autodiscoverySeed)
      const serviceName = flags.autodiscoveryServiceName || SERVICE_NAME
      const registerClient = new RegisterClient(autodiscoveryRpcKey, blindPeer.swarm.dht, seed)

      // No need to block on this, so we run it in the background
      logger.info(
        `Registering own RPC key rpc key ${idEnc.normalize(blindPeer.publicKey)} with service '${serviceName}' at autodiscovery service ${idEnc.normalize(autodiscoveryRpcKey)} (using public key ${idEnc.normalize(registerClient.keyPair.publicKey)})`
      )
      registerClient
        .putService(blindPeer.publicKey, serviceName)
        .then(() => {
          logger.info('Successfully requested to be added to the autodiscovery service')
        })
        .catch((e) => {
          logger.warn(`Failed to register to the autodiscovery service: ${e.stack}`)
        })
        .finally(() => {
          registerClient.close().catch(safetyCatch)
        })
      */
    }

    if (flags.scraperPublicKey) {
      const swarm = blindPeer.swarm
      logger.info('Setting up instrumentation')

      const scraperPublicKey = idEnc.decode(flags.scraperPublicKey)
      const scraperSecret = idEnc.decode(flags.scraperSecret)

      let prometheusAlias = flags.scraperAlias
      if (prometheusAlias && prometheusAlias.length > 99) {
        throw new Error('The Prometheus alias must have length less than 100')
      }
      if (!prometheusAlias) {
        prometheusAlias = `blind-peer-${idEnc.normalize(swarm.keyPair.publicKey)}`.slice(0, 99)
      }

      instrumentation = new Instrumentation({
        swarm,
        corestore: blindPeer.store,
        scraperPublicKey,
        prometheusAlias,
        scraperSecret,
        prometheusServiceName: SERVICE_NAME,
        version: ownVersion
      })

      blindPeer.registerMetrics(instrumentation.promClient)
      instrumentation.registerLogger(logger)
      await instrumentation.ready()
    }

    logger.info({ publicKey: idEnc.normalize(blindPeer.publicKey) }, 'Listening')
    logger.info(
      { encryptionPublicKey: idEnc.normalize(blindPeer.encryptionPublicKey) },
      'Encryption public key'
    )

    if (flags.autoShutdownMinutes) {
      const delayMinutes = flags.autoShutdownMinutes * (1 + Math.random() / 5)
      logger.warn({ delayMinutes }, 'Automatically shutting down the process')
      setTimeout(
        () => {
          logger.warn('Auto-shutdown triggered. Shutting down...')
          goodbye.exit()
        },
        delayMinutes * 60 * 1000
      )
    }
  }
)

function recordToLog(record) {
  return {
    discoveryKey: idEnc.normalize(hypCrypto.discoveryKey(record.key)),
    priority: record.priority,
    announce: record.announce
  }
}

function streamToStr(stream) {
  return idEnc.normalize(stream.remotePublicKey)
}

function coreToLog(core, includePublicKey = false) {
  const log = {
    discoveryKey: idEnc.normalize(hypCrypto.discoveryKey(core.key)),
    contiguousLength: core.contiguousLength,
    length: core.length,
    peerCount: core.peers.length
  }
  if (includePublicKey) log.publicKey = idEnc.normalize(core.key)
  return log
}

function getHandshake(stream) {
  return stream?.userData?.getLastChannel({ protocol: 'blind-peer' })?.handshake
}

cmd.parse()

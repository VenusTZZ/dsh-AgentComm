/**
 * AgentComm network smoke test.
 *
 * Mounts the Host half on a throwaway HTTP server with a stub Cordis context,
 * starts the real relay, and checks both directions of a room:
 *   relay peer -> plugin history, and plugin message -> relay history.
 *
 *   node tests/network-smoke.mjs
 */
import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { apply } from '../index.js'

const root = fileURLToPath(new URL('..', import.meta.url))
const RELAY_PORT = 8799
const RELAY = `http://127.0.0.1:${RELAY_PORT}`
const TOKEN = 'smoke-secret'
const ROOM = 'smoke-room'

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function waitFor(check, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await check()) return true
    await sleep(120)
  }
  return false
}

const dataDir = await mkdtemp(join(tmpdir(), 'agentcomm-smoke-'))
const routes = []
const disposers = []

const ctx = {
  logger: console,
  effect(fn) {
    const dispose = fn()
    disposers.push(dispose)
    return dispose
  },
  get() {
    return undefined
  },
  inject(_deps, callback) {
    callback({
      effect(fn) {
        const dispose = fn()
        disposers.push(dispose)
        return dispose
      },
      webServer: {
        register(route) {
          routes.push(route)
          return () => {}
        },
      },
    })
  },
  tools: { register: () => () => {} },
  systemPrompt: { section: () => () => {} },
  agents: { list: () => [], get: () => undefined },
}

apply(ctx, { dataDir })

const server = createServer((req, res) => {
  const pathname = new URL(req.url ?? '/', 'http://local').pathname
  const route = routes.find(item => item.kind === 'prefix'
    ? pathname.startsWith(item.path)
    : pathname === item.path)
  if (route === undefined) {
    res.writeHead(404)
    res.end()
    return
  }
  route.handler(req, res)
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${server.address().port}`

const relay = spawn(process.execPath, [join(root, 'relay', 'server.mjs')], {
  env: { ...process.env, PORT: String(RELAY_PORT), HOST: '127.0.0.1' },
  stdio: 'ignore',
})

let failed = false
try {
  const healthy = await waitFor(async () => {
    try {
      return (await fetch(`${RELAY}/health`)).ok
    } catch {
      return false
    }
  })
  if (!healthy) throw new Error('relay did not become healthy')

  const api = async (path, body, method = 'POST') => {
    const response = await fetch(`${base}/agentcomm/api${path}`, {
      method,
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const data = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(`${path}: ${data.error ?? response.status}`)
    return data
  }

  const created = await api('/rooms', { name: 'smoke' })
  const roomId = created.room.id
  console.log('room created:', roomId)

  const connected = await api(`/rooms/${roomId}/network`, {
    relayUrl: RELAY,
    roomCode: ROOM,
    token: TOKEN,
  })
  console.log('network connected:', connected.room.network)

  const remotePost = await fetch(`${RELAY}/v1/rooms/${ROOM}/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({
      id: 'remote-1',
      senderId: 'peer-1',
      senderName: '小明的 Agent',
      text: 'hello from the other side',
    }),
  })
  if (!remotePost.ok) throw new Error(`relay post failed: ${remotePost.status}`)
  console.log('remote envelope posted to relay')

  const sawRemote = await waitFor(async () => {
    const data = await api(`/rooms/${roomId}/messages`, undefined, 'GET')
    return data.messages.some(message => message.text.includes('other side'))
  })
  if (!sawRemote) throw new Error('plugin did not ingest the remote message')
  console.log('plugin ingested remote message')

  await api(`/rooms/${roomId}/messages`, { text: 'reply from the local side' })
  const sawLocal = await waitFor(async () => {
    const response = await fetch(`${RELAY}/v1/rooms/${ROOM}/messages?since=0`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    })
    const data = await response.json()
    return data.messages.some(message => message.text.includes('local side'))
  })
  if (!sawLocal) throw new Error('relay did not receive the local message')
  console.log('relay received local message')

  const state = await api('/state', undefined, 'GET')
  if (state.rooms[0].network?.connected !== true) throw new Error('network status is not connected')
  if (typeof state.plugin?.version !== 'string' || state.plugin.version.length === 0) {
    throw new Error('plugin info is missing from state')
  }
  if (typeof state.plugin.repository !== 'string' || !state.plugin.repository.includes('github.com')) {
    throw new Error('plugin repository is missing from state')
  }
  console.log('state reports connected network and plugin info', state.plugin.name, state.plugin.version)

  console.log('SMOKE OK')
} catch (error) {
  failed = true
  console.error('SMOKE FAILED:', error)
} finally {
  for (const dispose of disposers.reverse()) {
    try {
      await dispose?.()
    } catch {
      // Disposal is best effort in this harness.
    }
  }
  await new Promise(resolve => server.close(resolve))
  relay.kill('SIGTERM')
  await sleep(400)
  await rm(dataDir, { recursive: true, force: true })
}

process.exit(failed ? 1 : 0)

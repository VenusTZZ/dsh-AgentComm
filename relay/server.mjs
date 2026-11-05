#!/usr/bin/env node
/**
 * AgentComm relay: a tiny, dependency-free meeting point for networked rooms.
 *
 * It routes opaque message envelopes between AgentComm hosts that share a room
 * code and access token. It does not interpret message text, and it keeps only
 * a bounded in-memory history. Run it on a VPS, behind a reverse proxy, or on a
 * LAN address reachable by every participant.
 *
 *   PORT=8787 HOST=0.0.0.0 node relay/server.mjs
 *
 * HTTP surface (all JSON):
 *   GET  /health
 *   GET  /v1/rooms/:room/messages?since=<seq>&wait=<ms>   long-poll
 *   POST /v1/rooms/:room/messages                         append one envelope
 *
 * Every room request carries `Authorization: Bearer <token>`. The first token
 * seen for a room becomes that room's password; later tokens must match it.
 * Use HTTPS (a reverse proxy) when the relay is reachable over the internet.
 */
import { createHash, timingSafeEqual } from 'node:crypto'
import { createServer } from 'node:http'

const PORT = Number.parseInt(process.env.PORT ?? '8787', 10)
const HOST = process.env.HOST ?? '127.0.0.1'
const MAX_BODY_BYTES = 64 * 1024
const MAX_MESSAGES_PER_ROOM = 1_000
const MAX_ROOMS = 1_000
const MAX_WAIT_MS = 25_000
const MAX_TEXT = 8_000

/** @type {Map<string, { seq: number, tokenHash: Buffer | null, messages: any[], byId: Map<string, any> }>} */
const rooms = new Map()

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function hashToken(token) {
  return createHash('sha256').update(token).digest()
}

function sameToken(left, right) {
  return left.length === right.length && timingSafeEqual(left, right)
}

function json(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(payload),
  })
  res.end(payload)
}

function fail(res, status, error) {
  json(res, status, { error })
}

function openRoom(name, token) {
  if (rooms.size >= MAX_ROOMS) return undefined
  const room = { seq: 0, tokenHash: hashToken(token), messages: [], byId: new Map() }
  rooms.set(name, room)
  return room
}

/**
 * Resolve the room for one request and prove the caller's token.
 * @returns {{ room: any } | { status: number, error: string }}
 */
function authorize(name, req) {
  const header = req.headers.authorization
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) {
    return { status: 401, error: 'missing bearer token' }
  }
  const token = header.slice('Bearer '.length).trim()
  if (token.length === 0 || token.length > 256) return { status: 401, error: 'invalid token' }
  const room = rooms.get(name) ?? openRoom(name, token)
  if (room === undefined) return { status: 503, error: 'relay is full' }
  if (!sameToken(room.tokenHash, hashToken(token))) return { status: 403, error: 'wrong room token' }
  return { room }
}

function roomNameOf(pathname) {
  const match = /^\/v1\/rooms\/([A-Za-z0-9_-]{1,64})\/messages$/.exec(pathname)
  return match === null ? undefined : match[1]
}

async function readBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) throw new Error('body too large')
    chunks.push(chunk)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
}

function snapshot(message) {
  return {
    seq: message.seq,
    id: message.id,
    senderId: message.senderId,
    senderName: message.senderName,
    text: message.text,
    at: message.at,
  }
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', 'http://relay.local')

    if (req.method === 'GET' && url.pathname === '/health') {
      json(res, 200, { ok: true, rooms: rooms.size, now: new Date().toISOString() })
      return
    }

    const roomName = roomNameOf(url.pathname)
    if (roomName === undefined) {
      fail(res, 404, 'not found')
      return
    }

    const admitted = authorize(roomName, req)
    if (admitted.room === undefined) {
      fail(res, admitted.status, admitted.error)
      return
    }
    const { room } = admitted

    if (req.method === 'POST') {
      const body = await readBody(req)
      if (body === null || typeof body !== 'object') {
        fail(res, 400, 'body must be an object')
        return
      }
      const id = typeof body.id === 'string' && body.id.length > 0 && body.id.length <= 128 ? body.id : undefined
      if (id === undefined) {
        fail(res, 400, 'id is required')
        return
      }
      const existing = room.byId.get(id)
      if (existing !== undefined) {
        json(res, 200, { seq: existing.seq, at: existing.at, duplicate: true })
        return
      }
      const text = typeof body.text === 'string' ? body.text.slice(0, MAX_TEXT) : ''
      if (text.trim().length === 0) {
        fail(res, 400, 'text is required')
        return
      }
      const message = {
        seq: (room.seq += 1),
        id,
        senderId: String(body.senderId ?? 'unknown').slice(0, 128),
        senderName: String(body.senderName ?? 'Agent').slice(0, 80),
        text,
        at: typeof body.at === 'string' ? body.at : new Date().toISOString(),
      }
      room.messages.push(message)
      room.byId.set(id, message)
      if (room.messages.length > MAX_MESSAGES_PER_ROOM) {
        const removed = room.messages.shift()
        if (removed !== undefined) room.byId.delete(removed.id)
      }
      json(res, 200, { seq: message.seq, at: message.at })
      return
    }

    if (req.method === 'GET') {
      const since = Number.parseInt(url.searchParams.get('since') ?? '0', 10) || 0
      const wait = Math.min(Math.max(Number.parseInt(url.searchParams.get('wait') ?? '0', 10) || 0, 0), MAX_WAIT_MS)
      const deadline = Date.now() + wait
      while (true) {
        if (since > room.seq) {
          // The relay restarted or expired history; the caller restarts from zero.
          json(res, 200, { messages: [], cursor: room.seq, reset: true })
          return
        }
        const messages = room.messages.filter(message => message.seq > since).map(snapshot)
        if (messages.length > 0 || Date.now() >= deadline) {
          json(res, 200, { messages, cursor: room.seq })
          return
        }
        await delay(200)
      }
    }

    fail(res, 405, 'method not allowed')
  } catch (error) {
    fail(res, 500, error?.message ?? String(error))
  }
})

server.listen(PORT, HOST, () => {
  console.log(`agentcomm relay listening on http://${HOST}:${PORT}`)
})

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    server.close(() => process.exit(0))
    setTimeout(() => process.exit(0), 2_000).unref()
  })
}

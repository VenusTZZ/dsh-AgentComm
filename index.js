/**
 * AgentComm host half: a small, profile-local instant messenger for the user
 * and the agents of this Harness.
 *
 * Rooms, membership, and history live in one JSON store under
 * `$DSH_HOME/agentcomm`. Agents take part through the `agent_im` tool; the Web
 * page reads and writes the same store over a same-origin HTTP surface and
 * follows it over SSE. Incoming room messages reach a member agent as a user
 * message, silently (`inject`) unless the agent was mentioned or the room asks
 * every member to answer (`followup`).
 *
 * Networked rooms reuse the same message stream: a room may point at an
 * AgentComm relay (see relay/server.mjs), and remote envelopes are merged into
 * the local history while local messages are mirrored back to the relay.
 */
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const inject = ['tools', 'agents', 'systemPrompt']

const API_PREFIX = '/agentcomm/api'
const EVENTS_PATH = '/agentcomm/events'
const TOOL_NAME = 'agent_im'
const MAX_TEXT = 8_000
const MAX_MESSAGES_PER_ROOM = 2_000
const MAX_BODY_BYTES = 1_000_000
const DEFAULT_MAX_STREAK = 8
const RELAY_POLL_WAIT_MS = 20_000
const RELAY_TIMEOUT_MS = 30_000
const RELAY_RETRY_MS = 3_000

/** Keep the persisted network shape strict; transport state is rebuilt on activation. */
function normalizeNetwork(input) {
  if (input === null || typeof input !== 'object') return null
  return {
    relayUrl: typeof input.relayUrl === 'string' ? input.relayUrl : '',
    roomCode: typeof input.roomCode === 'string' ? input.roomCode : '',
    token: typeof input.token === 'string' ? input.token : '',
    lastSeq: Number.isSafeInteger(input.lastSeq) && input.lastSeq >= 0 ? input.lastSeq : 0,
    connected: false,
    error: null,
    lastSyncAt: null,
  }
}

/**
 * Register the chat hub, its tool, its prompt section, and its HTTP surface.
 * @param ctx - Host plugin context.
 * @param config - Raw row config: `dataDir` and `maxStreak`.
 */
export function apply(ctx, config = {}) {
  const dataDir = typeof config?.dataDir === 'string' && config.dataDir.trim().length > 0
    ? config.dataDir.trim()
    : join(process.env.DSH_HOME?.trim() || join(homedir(), '.dsh'), 'agentcomm')
  const dataFile = join(dataDir, 'store.json')
  const maxStreak = Number.isSafeInteger(config?.maxStreak) && config.maxStreak > 0
    ? config.maxStreak
    : DEFAULT_MAX_STREAK

  /** @type {null | { version: number, me: { id: string, name: string }, seq: number, rooms: any[], messages: Record<string, any[]> }} */
  let state = null
  /** @type {Set<{ res: import('node:http').ServerResponse }>} */
  const clients = new Set()
  /** @type {Map<string, { controller: AbortController }>} */
  const networks = new Map()
  let saveTimer
  let saveChain = Promise.resolve()
  /** Manifest facts shown by the page's info card; static for one loaded generation. */
  let pluginInfo = { name: 'AgentComm', version: '0.0.0', description: '', repository: '' }

  const ready = Promise.all([loadState(), loadPluginInfo()])

  async function loadPluginInfo() {
    try {
      const manifest = JSON.parse(await readFile(new URL('./package.json', import.meta.url), 'utf8'))
      pluginInfo = {
        name: typeof manifest.name === 'string' ? manifest.name : pluginInfo.name,
        version: typeof manifest.version === 'string' ? manifest.version : pluginInfo.version,
        description: typeof manifest.description === 'string' ? manifest.description : '',
        repository: typeof manifest.repository === 'string'
          ? manifest.repository
          : (typeof manifest.repository?.url === 'string' ? manifest.repository.url : ''),
      }
    } catch (error) {
      ctx.logger?.warn?.(`AgentComm: could not read package.json: ${error?.message ?? error}`)
    }
  }

  async function loadState() {
    await mkdir(dataDir, { recursive: true })
    try {
      const raw = await readFile(dataFile, 'utf8')
      state = normalizeState(JSON.parse(raw))
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        ctx.logger?.warn?.(`AgentComm: could not read ${dataFile}; starting a fresh store (${error?.message ?? error})`)
      }
      state = {
        version: 1,
        me: { id: randomUUID(), name: '我' },
        seq: 0,
        rooms: [],
        messages: {},
      }
    }
  }

  function normalizeState(input) {
    const next = input !== null && typeof input === 'object' ? input : {}
    const me = next.me !== null && typeof next.me === 'object' ? next.me : {}
    const rooms = Array.isArray(next.rooms) ? next.rooms : []
    return {
      version: 1,
      me: {
        id: typeof me.id === 'string' && me.id.length > 0 ? me.id : randomUUID(),
        name: typeof me.name === 'string' && me.name.trim().length > 0 ? me.name.trim() : '我',
      },
      seq: Number.isSafeInteger(next.seq) && next.seq >= 0 ? next.seq : 0,
      rooms: rooms.map(room => ({
        id: typeof room.id === 'string' && room.id.length > 0 ? room.id : randomUUID(),
        name: typeof room.name === 'string' && room.name.trim().length > 0 ? room.name.trim() : '未命名群聊',
        createdAt: typeof room.createdAt === 'string' ? room.createdAt : new Date().toISOString(),
        autoReply: room.autoReply === true,
        streak: Number.isSafeInteger(room.streak) && room.streak > 0 ? room.streak : 0,
        network: normalizeNetwork(room.network),
        members: Array.isArray(room.members)
          ? room.members
              .filter(member => member !== null && typeof member === 'object' && typeof member.id === 'string')
              .map(member => ({
                id: member.id,
                name: typeof member.name === 'string' && member.name.trim().length > 0 ? member.name.trim() : member.id,
                addedAt: typeof member.addedAt === 'string' ? member.addedAt : new Date().toISOString(),
                lastReadSeq: Number.isSafeInteger(member.lastReadSeq) ? member.lastReadSeq : 0,
              }))
          : [],
      })),
      messages: Object.fromEntries(
        Object.entries(next.messages !== null && typeof next.messages === 'object' ? next.messages : {})
          .filter(([, list]) => Array.isArray(list))
          .map(([roomId, list]) => [roomId, list.filter(message => message !== null && typeof message === 'object')]),
      ),
    }
  }

  function scheduleSave() {
    if (saveTimer !== undefined) return
    saveTimer = setTimeout(() => {
      saveTimer = undefined
      void saveNow()
    }, 200)
  }

  function saveNow() {
    const payload = JSON.stringify(state, undefined, 2)
    saveChain = saveChain
      .then(async () => {
        await mkdir(dataDir, { recursive: true })
        const temporary = `${dataFile}.${process.pid}.tmp`
        await writeFile(temporary, payload, 'utf8')
        await rename(temporary, dataFile)
      })
      .catch(error => {
        ctx.logger?.warn?.(`AgentComm: could not save ${dataFile}: ${error?.message ?? error}`)
      })
    return saveChain
  }

  function roomMessages(roomId) {
    if (state.messages[roomId] === undefined) state.messages[roomId] = []
    return state.messages[roomId]
  }

  function findRoom(reference) {
    if (typeof reference !== 'string' || reference.length === 0) return undefined
    const byId = state.rooms.find(room => room.id === reference)
    if (byId !== undefined) return byId
    const wanted = reference.trim().toLowerCase()
    const matches = state.rooms.filter(room => room.name.toLowerCase() === wanted)
    return matches.length === 1 ? matches[0] : undefined
  }

  function liveAgent(sessionId) {
    try {
      return ctx.agents.get(sessionId)
    } catch {
      return undefined
    }
  }

  function agentName(agent) {
    if (agent === undefined) return 'Agent'
    try {
      const title = ctx.get('sessionTitle')?.get(agent.session)?.title
      if (typeof title === 'string' && title.trim().length > 0) return title.trim().slice(0, 40)
    } catch {
      // A session that is not live has no title to read; the id remains a stable label.
    }
    const tail = String(agent.id).replace(/^session-/, '').slice(0, 8)
    return `Agent ${tail}`
  }

  function resolveAgent(reference) {
    const agents = ctx.agents.list()
    const byId = agents.find(agent => String(agent.id) === reference)
    if (byId !== undefined) return byId
    const wanted = String(reference).trim().toLowerCase()
    const matches = agents.filter(agent => agentName(agent).toLowerCase() === wanted)
    return matches.length === 1 ? matches[0] : undefined
  }

  function memberName(member) {
    const agent = liveAgent(member.id)
    return agent === undefined ? member.name : agentName(agent)
  }

  function memberView(member) {
    const agent = liveAgent(member.id)
    return {
      id: member.id,
      name: memberName(member),
      online: agent !== undefined,
    }
  }

  function roomView(room) {
    const messages = roomMessages(room.id)
    const last = messages.length > 0 ? messages[messages.length - 1] : undefined
    return {
      id: room.id,
      name: room.name,
      createdAt: room.createdAt,
      autoReply: room.autoReply === true,
      streak: room.streak,
      network: publicNetwork(room),
      members: room.members.map(memberView),
      lastMessage: last === undefined
        ? null
        : {
            seq: last.seq,
            at: last.at,
            text: last.text.length > 120 ? `${last.text.slice(0, 119)}…` : last.text,
            senderName: last.sender.name,
            senderKind: last.sender.kind,
          },
    }
  }

  function stateSnapshot() {
    return {
      plugin: { ...pluginInfo },
      me: { id: state.me.id, name: state.me.name },
      agents: ctx.agents.list().map(agent => ({
        id: String(agent.id),
        name: agentName(agent),
        status: agent.status ?? 'idle',
      })),
      rooms: [...state.rooms]
        .sort((left, right) => lastAt(right) - lastAt(left))
        .map(roomView),
    }
  }

  function lastAt(room) {
    const messages = roomMessages(room.id)
    return messages.length === 0 ? Date.parse(room.createdAt) || 0 : (Date.parse(messages[messages.length - 1].at) || 0)
  }

  function broadcast(type, payload) {
    const frame = `event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`
    for (const client of clients) {
      try {
        client.res.write(frame)
      } catch {
        clients.delete(client)
      }
    }
  }

  function appendMessage(room, sender, text, mentions, extra) {
    const message = {
      id: randomUUID(),
      seq: (state.seq += 1),
      at: new Date().toISOString(),
      sender,
      text,
      mentions,
      ...(extra ?? {}),
    }
    const messages = roomMessages(room.id)
    messages.push(message)
    if (messages.length > MAX_MESSAGES_PER_ROOM) messages.splice(0, messages.length - MAX_MESSAGES_PER_ROOM)
    room.streak = sender.kind === 'agent' ? room.streak + 1 : 0
    scheduleSave()
    broadcast('message', { roomId: room.id, message })
    broadcast('state', stateSnapshot())
    return message
  }

  function mentionsIn(room, text) {
    const ids = []
    for (const member of room.members) {
      const name = memberName(member)
      if (text.includes(`@${name}`) || text.includes(`@${member.id}`)) ids.push(member.id)
    }
    return ids
  }

  function renderForAgent(room, message, mentioned) {
    const who = message.sender.kind === 'human'
      ? `${message.sender.name}（人类）`
      : message.sender.kind === 'remote'
        ? `${message.sender.name}（远程 Agent）`
        : `${message.sender.name}（Agent）`
    const lines = [
      `[AgentComm] 群聊「${room.name}」`,
      `${who}：${message.text}`,
    ]
    if (mentioned) lines.push('（这条消息 @ 了你，请回复。）')
    lines.push(`回复请调用 ${TOOL_NAME}：{"action":"send","room":"${room.name}","text":"..."}`)
    return lines.join('\n')
  }

  function deliverToMembers(room, message) {
    const mentioned = new Set(message.mentions)
    const delivered = []
    for (const member of room.members) {
      if (member.id === message.sender.id) continue
      const agent = liveAgent(member.id)
      if (agent === undefined) continue
      const directlyAddressed = mentioned.has(member.id)
      const wake = room.streak <= maxStreak && (directlyAddressed || room.autoReply === true)
      const input = {
        id: randomUUID(),
        role: 'user',
        content: [{ type: 'text', text: renderForAgent(room, message, directlyAddressed) }],
        source: { kind: 'user' },
      }
      try {
        if (wake) agent.followup(input)
        else agent.inject(input)
        delivered.push(member.id)
      } catch (error) {
        ctx.logger?.warn?.(`AgentComm: delivery to ${member.id} failed: ${error?.message ?? error}`)
      }
    }
    return delivered
  }

  function post(room, sender, text, mentions) {
    const message = appendMessage(room, sender, text, mentions)
    void mirrorToRelay(room, message)
    const delivered = deliverToMembers(room, message)
    return { message, delivered }
  }

  /** Network status safe for the browser: the room token never leaves the Host. */
  function publicNetwork(room) {
    const network = room.network
    if (network === null) return null
    return {
      relayUrl: network.relayUrl,
      roomCode: network.roomCode,
      connected: network.connected === true,
      lastSeq: network.lastSeq,
      error: network.error,
      lastSyncAt: network.lastSyncAt,
    }
  }

  function cleanRelayUrl(value) {
    if (typeof value !== 'string' || value.trim().length === 0) throw new Error('Relay 地址不能为空')
    let url
    try {
      url = new URL(value.trim())
    } catch {
      throw new Error('Relay 地址不是合法 URL')
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('Relay 地址必须是 http(s)')
    return `${url.origin}${url.pathname}`.replace(/\/+$/, '')
  }

  function cleanRoomCode(value) {
    const code = String(value ?? '').trim()
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(code)) {
      throw new Error('房间号只能包含字母、数字、下划线和连字符（1-64 位）')
    }
    return code
  }

  function cleanToken(value) {
    const token = String(value ?? '').trim()
    if (token.length === 0) throw new Error('访问口令不能为空')
    if (token.length > 256) throw new Error('访问口令过长')
    return token
  }

  function roomEndpoint(room, suffix = '/messages') {
    return `${room.network.relayUrl}/v1/rooms/${encodeURIComponent(room.network.roomCode)}${suffix}`
  }

  async function probeRelay(relayUrl, roomCode, token) {
    const url = new URL(`${relayUrl}/v1/rooms/${encodeURIComponent(roomCode)}/messages`)
    url.searchParams.set('since', '0')
    url.searchParams.set('wait', '0')
    let response
    try {
      response = await fetch(url, {
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(10_000),
      })
    } catch (error) {
      throw new Error(`连不上 Relay：${error?.message ?? error}`)
    }
    if (response.status === 401 || response.status === 403) throw new Error('Relay 拒绝了访问口令')
    if (!response.ok) throw new Error(`Relay 返回 ${response.status}`)
    const data = await response.json().catch(() => ({}))
    return { cursor: Number.isSafeInteger(data?.cursor) ? data.cursor : 0 }
  }

  function stopNetwork(roomId) {
    const entry = networks.get(roomId)
    if (entry === undefined) return
    entry.controller.abort()
    networks.delete(roomId)
  }

  function startNetwork(room, network) {
    stopNetwork(room.id)
    network.error = null
    room.network = network
    const entry = { controller: new AbortController() }
    networks.set(room.id, entry)
    broadcast('state', stateSnapshot())
    void networkLoop(room, entry)
  }

  function sleep(ms, entry) {
    return new Promise(resolve => {
      const timer = setTimeout(resolve, ms)
      entry.controller.signal.addEventListener('abort', () => {
        clearTimeout(timer)
        resolve()
      }, { once: true })
    })
  }

  async function networkLoop(room, entry) {
    while (!entry.controller.signal.aborted) {
      try {
        await pollOnce(room, entry)
        if (entry.controller.signal.aborted) return
        room.network.connected = true
        room.network.error = null
        room.network.lastSyncAt = new Date().toISOString()
        scheduleSave()
        broadcast('state', stateSnapshot())
      } catch (error) {
        if (entry.controller.signal.aborted) return
        room.network.connected = false
        room.network.error = String(error?.message ?? error)
        broadcast('state', stateSnapshot())
        await sleep(RELAY_RETRY_MS, entry)
      }
    }
  }

  async function pollOnce(room, entry) {
    const url = new URL(roomEndpoint(room))
    url.searchParams.set('since', String(room.network.lastSeq))
    url.searchParams.set('wait', String(RELAY_POLL_WAIT_MS))
    const signal = AbortSignal.any([entry.controller.signal, AbortSignal.timeout(RELAY_TIMEOUT_MS)])
    const response = await fetch(url, {
      headers: { authorization: `Bearer ${room.network.token}` },
      signal,
    })
    if (!response.ok) throw new Error(`Relay 返回 ${response.status}`)
    const data = await response.json()
    if (data?.reset === true) {
      room.network.lastSeq = 0
      return
    }
    for (const envelope of Array.isArray(data?.messages) ? data.messages : []) ingestRemote(room, envelope)
    if (Number.isSafeInteger(data?.cursor) && data.cursor > room.network.lastSeq) room.network.lastSeq = data.cursor
  }

  function ingestRemote(room, envelope) {
    if (envelope === null || typeof envelope !== 'object') return
    if (typeof envelope.id !== 'string' || envelope.id.length === 0) return
    if (envelope.senderId === state.me.id) return
    const messages = roomMessages(room.id)
    if (messages.some(message => message.remoteId === envelope.id)) return
    const text = typeof envelope.text === 'string' ? envelope.text.trim().slice(0, MAX_TEXT) : ''
    if (text.length === 0) return
    const sender = {
      id: `remote:${String(envelope.senderId ?? 'unknown').slice(0, 64)}`,
      name: String(envelope.senderName ?? '远程 Agent').slice(0, 40),
      kind: 'remote',
    }
    const message = appendMessage(room, sender, text, mentionsIn(room, text), { remoteId: envelope.id })
    deliverToMembers(room, message)
  }

  async function mirrorToRelay(room, message) {
    const network = room.network
    if (network === null || network.relayUrl.length === 0 || network.token.length === 0) return
    try {
      const response = await fetch(roomEndpoint(room), {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${network.token}`,
        },
        body: JSON.stringify({
          id: message.id,
          senderId: state.me.id,
          senderName: state.me.name,
          text: message.text,
          at: message.at,
        }),
        signal: AbortSignal.timeout(15_000),
      })
      if (!response.ok) throw new Error(`Relay 返回 ${response.status}`)
    } catch (error) {
      if (room.network === network) {
        network.error = `发送失败：${error?.message ?? error}`
        broadcast('state', stateSnapshot())
      }
    }
  }

  function compactMessage(message) {
    return {
      seq: message.seq,
      at: message.at,
      sender: { id: message.sender.id, name: message.sender.name, kind: message.sender.kind },
      text: message.text,
      mentions: message.mentions,
    }
  }

  function requireRoom(reference) {
    const room = findRoom(reference)
    if (room === undefined) {
      const names = state.rooms.map(item => `"${item.name}"`).join(', ')
      throw new Error(names.length === 0
        ? 'There are no AgentComm rooms yet. Ask the user to create one.'
        : `No unique room matches ${JSON.stringify(reference)}. Rooms: ${names}`)
    }
    return room
  }

  function requireMember(room, sessionId) {
    const member = room.members.find(item => item.id === sessionId)
    if (member === undefined) {
      throw new Error(`You are not a member of "${room.name}". Ask the user to add you, or call agent_im with action "join".`)
    }
    return member
  }

  function cleanText(value) {
    if (typeof value !== 'string') throw new Error('text must be a string')
    const text = value.trim()
    if (text.length === 0) throw new Error('text must not be empty')
    if (text.length > MAX_TEXT) throw new Error(`text must be at most ${MAX_TEXT} characters`)
    return text
  }

  function cleanName(value, max = 40) {
    if (typeof value !== 'string') throw new Error('name must be a string')
    const name = value.trim()
    if (name.length === 0) throw new Error('name must not be empty')
    if (name.length > max) throw new Error(`name must be at most ${max} characters`)
    return name
  }

  async function toolExecute(args, exec) {
    await ready
    const agent = exec?.agent
    if (agent === undefined) throw new Error(`${TOOL_NAME} must be called by an Agent`)
    const sessionId = String(agent.id)
    const action = args?.action

    if (action === 'list') {
      const rooms = state.rooms
        .filter(room => room.members.some(member => member.id === sessionId))
        .map(room => {
          const member = room.members.find(item => item.id === sessionId)
          const messages = roomMessages(room.id)
          const unread = messages.filter(message => message.seq > (member?.lastReadSeq ?? 0)).length
          return {
            id: room.id,
            name: room.name,
            members: room.members.map(memberName),
            unread,
            lastMessage: roomView(room).lastMessage,
          }
        })
      return {
        ok: true,
        rooms,
        ...(rooms.length === 0
          ? { hint: 'You are not in any room yet. The user can add you from the AgentComm page, or use action "create".' }
          : {}),
      }
    }

    if (action === 'read') {
      const room = requireRoom(args?.room)
      const member = requireMember(room, sessionId)
      const limit = Number.isSafeInteger(args?.limit) ? Math.min(Math.max(args.limit, 1), 100) : 20
      const messages = roomMessages(room.id)
      const slice = messages.slice(-limit)
      member.lastReadSeq = messages.length > 0 ? messages[messages.length - 1].seq : 0
      scheduleSave()
      return { ok: true, room: room.name, messages: slice.map(compactMessage), truncated: messages.length > slice.length }
    }

    if (action === 'send') {
      const room = requireRoom(args?.room)
      requireMember(room, sessionId)
      const text = cleanText(args?.text)
      const names = Array.isArray(args?.mentions) ? args.mentions.map(String) : []
      const mentions = []
      for (const name of names) {
        const target = room.members.find(member => memberName(member) === name || member.id === name)
        if (target !== undefined && !mentions.includes(target.id)) mentions.push(target.id)
      }
      const sender = { id: sessionId, name: agentName(agent), kind: 'agent' }
      const { message, delivered } = post(room, sender, text, mentions)
      return {
        ok: true,
        room: room.name,
        seq: message.seq,
        deliveredTo: delivered.map(id => memberName(room.members.find(member => member.id === id) ?? { id, name: id })),
        paused: room.streak > maxStreak,
      }
    }

    if (action === 'create') {
      const name = cleanName(args?.name)
      if (state.rooms.some(room => room.name.toLowerCase() === name.toLowerCase())) {
        throw new Error(`A room named "${name}" already exists`)
      }
      const requested = Array.isArray(args?.members) ? args.members.map(String) : []
      const members = [{ id: sessionId, name: agentName(agent), addedAt: new Date().toISOString(), lastReadSeq: 0 }]
      for (const reference of requested) {
        const target = resolveAgent(reference)
        if (target === undefined) {
          const available = ctx.agents.list().map(candidate => agentName(candidate))
          throw new Error(`No live agent matches ${JSON.stringify(reference)}. Available: ${available.join(', ')}`)
        }
        if (!members.some(member => member.id === String(target.id))) {
          members.push({ id: String(target.id), name: agentName(target), addedAt: new Date().toISOString(), lastReadSeq: 0 })
        }
      }
      const room = {
        id: randomUUID(),
        name,
        createdAt: new Date().toISOString(),
        autoReply: false,
        streak: 0,
        network: null,
        members,
      }
      state.rooms.push(room)
      roomMessages(room.id)
      scheduleSave()
      broadcast('state', stateSnapshot())
      return { ok: true, room: { id: room.id, name: room.name, members: members.map(member => member.name) } }
    }

    if (action === 'join') {
      const room = requireRoom(args?.room)
      if (!room.members.some(member => member.id === sessionId)) {
        room.members.push({ id: sessionId, name: agentName(agent), addedAt: new Date().toISOString(), lastReadSeq: 0 })
        scheduleSave()
        broadcast('state', stateSnapshot())
      }
      return { ok: true, room: room.name, members: room.members.map(memberName) }
    }

    if (action === 'leave') {
      const room = requireRoom(args?.room)
      const index = room.members.findIndex(member => member.id === sessionId)
      if (index >= 0) room.members.splice(index, 1)
      scheduleSave()
      broadcast('state', stateSnapshot())
      return { ok: true, room: room.name, left: index >= 0 }
    }

    throw new Error(`Unknown action ${JSON.stringify(action)}; use list, read, send, create, join, or leave`)
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

  function fail(res, status, message) {
    json(res, status, { error: message })
  }

  async function readJsonBody(req) {
    const chunks = []
    let size = 0
    for await (const chunk of req) {
      size += chunk.length
      if (size > MAX_BODY_BYTES) throw new Error('request body is too large')
      chunks.push(chunk)
    }
    if (size === 0) return {}
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    return parsed !== null && typeof parsed === 'object' ? parsed : {}
  }

  function sameOrigin(req) {
    const origin = req.headers.origin
    if (typeof origin !== 'string' || origin.length === 0) return true
    try {
      return new URL(origin).host === req.headers.host
    } catch {
      return false
    }
  }

  async function handleApi(req, res) {
    if (req.method !== 'GET' && req.method !== 'HEAD' && !sameOrigin(req)) {
      fail(res, 403, 'cross-origin request rejected')
      return
    }
    await ready
    const url = new URL(req.url ?? '/', 'http://agentcomm.local')
    const path = url.pathname.startsWith(API_PREFIX) ? url.pathname.slice(API_PREFIX.length) : url.pathname

    if (req.method === 'GET' && (path === '/state' || path === '/state/')) {
      json(res, 200, stateSnapshot())
      return
    }

    if (req.method === 'POST' && path === '/me') {
      const body = await readJsonBody(req)
      state.me.name = cleanName(body.name, 24)
      scheduleSave()
      broadcast('state', stateSnapshot())
      json(res, 200, { ok: true, me: state.me })
      return
    }

    if (req.method === 'POST' && (path === '/rooms' || path === '/rooms/')) {
      const body = await readJsonBody(req)
      const name = cleanName(body.name)
      if (state.rooms.some(room => room.name.toLowerCase() === name.toLowerCase())) {
        fail(res, 409, `名为「${name}」的群聊已存在`)
        return
      }
      const members = []
      const ids = Array.isArray(body.memberIds) ? body.memberIds.map(String) : []
      for (const id of ids) {
        const agent = liveAgent(id)
        if (agent === undefined) continue
        members.push({ id: String(agent.id), name: agentName(agent), addedAt: new Date().toISOString(), lastReadSeq: 0 })
      }
      const room = {
        id: randomUUID(),
        name,
        createdAt: new Date().toISOString(),
        autoReply: body.autoReply === true,
        streak: 0,
        network: null,
        members,
      }
      state.rooms.push(room)
      roomMessages(room.id)
      scheduleSave()
      broadcast('state', stateSnapshot())
      json(res, 200, { ok: true, room: roomView(room) })
      return
    }

    const roomPath = /^\/rooms\/([^/]+)(\/messages|\/members|\/network)?\/?$/.exec(path)
    if (roomPath !== null) {
      const roomId = decodeURIComponent(roomPath[1])
      const room = findRoom(roomId)
      if (room === undefined) {
        fail(res, 404, '群聊不存在')
        return
      }

      if (req.method === 'GET' && roomPath[2] === '/messages') {
        const messages = roomMessages(room.id)
        json(res, 200, { ok: true, room: roomView(room), messages: messages.map(compactMessage) })
        return
      }

      if (req.method === 'POST' && roomPath[2] === '/messages') {
        const body = await readJsonBody(req)
        const text = cleanText(body.text)
        const sender = { id: state.me.id, name: state.me.name, kind: 'human' }
        const { message, delivered } = post(room, sender, text, mentionsIn(room, text))
        json(res, 200, { ok: true, message: compactMessage(message), deliveredTo: delivered })
        return
      }

      if (req.method === 'POST' && roomPath[2] === '/members') {
        const body = await readJsonBody(req)
        const added = []
        for (const id of Array.isArray(body.add) ? body.add.map(String) : []) {
          const agent = liveAgent(id)
          if (agent === undefined || room.members.some(member => member.id === String(agent.id))) continue
          room.members.push({ id: String(agent.id), name: agentName(agent), addedAt: new Date().toISOString(), lastReadSeq: 0 })
          added.push(String(agent.id))
        }
        for (const id of Array.isArray(body.remove) ? body.remove.map(String) : []) {
          const index = room.members.findIndex(member => member.id === id)
          if (index >= 0) room.members.splice(index, 1)
        }
        scheduleSave()
        broadcast('state', stateSnapshot())
        json(res, 200, { ok: true, room: roomView(room), added })
        return
      }

      if (roomPath[2] === '/network') {
        if (req.method === 'POST') {
          const body = await readJsonBody(req)
          const relayUrl = cleanRelayUrl(body.relayUrl)
          const roomCode = cleanRoomCode(body.roomCode)
          const token = cleanToken(body.token)
          const probe = await probeRelay(relayUrl, roomCode, token)
          startNetwork(room, {
            relayUrl,
            roomCode,
            token,
            lastSeq: probe.cursor,
            connected: true,
            error: null,
            lastSyncAt: null,
          })
          scheduleSave()
          json(res, 200, { ok: true, room: roomView(room) })
          return
        }
        if (req.method === 'DELETE') {
          stopNetwork(room.id)
          if (room.network !== null) {
            room.network.connected = false
            room.network.error = null
          }
          scheduleSave()
          broadcast('state', stateSnapshot())
          json(res, 200, { ok: true, room: roomView(room) })
          return
        }
        fail(res, 405, '不支持的请求')
        return
      }

      if (req.method === 'PATCH' || (req.method === 'POST' && roomPath[2] === undefined)) {
        const body = await readJsonBody(req)
        if (body.name !== undefined) {
          const name = cleanName(body.name)
          if (state.rooms.some(item => item.id !== room.id && item.name.toLowerCase() === name.toLowerCase())) {
            fail(res, 409, `名为「${name}」的群聊已存在`)
            return
          }
          room.name = name
        }
        if (body.autoReply !== undefined) room.autoReply = body.autoReply === true
        scheduleSave()
        broadcast('state', stateSnapshot())
        json(res, 200, { ok: true, room: roomView(room) })
        return
      }

      fail(res, 405, '不支持的请求')
      return
    }

    fail(res, 404, '接口不存在')
  }

  function handleEvents(req, res) {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    })
    res.write('retry: 3000\n\n')
    const client = { res }
    clients.add(client)
    const heartbeat = setInterval(() => {
      try {
        res.write(': ping\n\n')
      } catch {
        clients.delete(client)
      }
    }, 25_000)
    const cleanup = () => {
      clearInterval(heartbeat)
      clients.delete(client)
    }
    req.on('close', cleanup)
    res.on('close', cleanup)
    void ready.then(() => {
      if (!clients.has(client)) return
      try {
        res.write(`event: state\ndata: ${JSON.stringify(stateSnapshot())}\n\n`)
      } catch {
        cleanup()
      }
    })
  }

  ctx.effect(() => ctx.tools.register({
    name: TOOL_NAME,
    description: 'Group chat with the user and other agents (AgentComm). action=list shows the rooms you belong to; read fetches recent messages; send posts to a room; create starts a room with other live agents; join and leave manage your membership. Messages from a room arrive as user messages starting with [AgentComm].',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'read', 'send', 'create', 'join', 'leave'],
          description: 'Operation to perform.',
        },
        room: { type: 'string', description: 'Room id or exact room name (used by read, send, join, leave).' },
        text: { type: 'string', description: 'Message text for send.' },
        mentions: {
          type: 'array',
          items: { type: 'string' },
          description: 'Agent names or session ids to wake and address explicitly.',
        },
        name: { type: 'string', description: 'Room name for create.' },
        members: {
          type: 'array',
          items: { type: 'string' },
          description: 'Live agent names or session ids to add while creating a room.',
        },
        limit: { type: 'integer', description: 'Number of recent messages for read (default 20, max 100).' },
      },
      required: ['action'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render(_args, value) {
        return [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, undefined, 2) }]
      },
    },
    presentCall(args) {
      const action = typeof args?.action === 'string' ? args.action : 'chat'
      return { card: 'generic', title: `AgentComm · ${action}`, kind: 'other', rawInput: args }
    },
    execute(args, exec) {
      return toolExecute(args, exec)
    },
  }))

  ctx.effect(() => ctx.systemPrompt.section({
    name: 'agentcomm',
    order: 5900,
    text: [
      '## AgentComm group chat',
      'You can take part in AgentComm rooms shared with the user and other agents.',
      '- Call `agent_im` with action "list" to see your rooms, "read" for recent messages, and "send" to post.',
      '- A room message reaches you as a user message beginning with `[AgentComm]`; answer it by calling `agent_im` with action "send" to the same room rather than with a normal reply.',
      '- Keep messages short and conversational. Post only when addressed, when the message asks for a reply, or when the room is clearly waiting on you.',
    ].join('\n'),
  }))

  ctx.inject(['webServer'], web => {
    web.effect(() => web.webServer.register({
      kind: 'prefix',
      path: API_PREFIX,
      handler: (req, res) => {
        handleApi(req, res).catch(error => {
          try {
            fail(res, 500, error?.message ?? String(error))
          } catch {
            // The response may already be gone; the failure is still logged.
          }
          ctx.logger?.warn?.(`AgentComm: API request failed: ${error?.stack ?? error}`)
        })
      },
    }))
    web.effect(() => web.webServer.register({
      kind: 'exact',
      path: EVENTS_PATH,
      handler: handleEvents,
    }))
  })

  void ready.then(() => {
    for (const room of state.rooms) {
      if (room.network !== null && room.network.relayUrl.length > 0 && room.network.roomCode.length > 0 && room.network.token.length > 0) {
        startNetwork(room, room.network)
      }
    }
  }).catch(error => ctx.logger?.warn?.(`AgentComm: network restore failed: ${error?.message ?? error}`))

  ctx.effect(() => () => {
    for (const roomId of [...networks.keys()]) stopNetwork(roomId)
    if (saveTimer !== undefined) {
      clearTimeout(saveTimer)
      saveTimer = undefined
      void saveNow()
    }
    for (const client of clients) {
      try {
        client.res.end()
      } catch {
        // The socket is already closed.
      }
    }
    clients.clear()
  })
}

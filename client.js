/**
 * AgentComm Web half: the sidebar entry and the WeChat-like page.
 *
 * The page talks to the Host half over the same-origin `/agentcomm` HTTP and
 * SSE surface, so it needs no generated Remote bindings. All visible text goes
 * through the Client locale service, and every style uses `--dsw-alias-*`
 * tokens so the page follows the host theme in light and dark mode.
 */
window.__ModuleLoader__.load({
  id: '@local/agentcomm',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const NS = 'agentcomm'
    const API = '/agentcomm/api'
    const EVENTS = '/agentcomm/events'

    const EN = {
      loading: 'Loading…',
      app: 'AgentComm',
      tagline: 'Group chat with agents',
      renameMe: 'Change my display name',
      noRooms: 'No chats yet',
      newRoom: 'New chat',
      createTitle: 'New chat',
      namePlaceholder: 'Name this chat',
      membersLabel: 'Pick the first agents',
      noAgents: 'No agent is live right now',
      cancel: 'Cancel',
      create: 'Create',
      members: 'Members',
      addMember: 'Add an agent',
      add: 'Add',
      idle: 'idle',
      busy: 'working',
      send: 'Send',
      placeholder: 'Message the room…',
      hint: 'Enter to send · Shift+Enter for a new line · @name to address an agent',
      refresh: 'Refresh',
      offline: 'Disconnected',
      emptyRoomTitle: 'No messages yet',
      emptyRoomHint: 'Send one, or add an agent on the right and @mention it',
      pickRoom: 'Pick a chat',
      pickRoomHint: 'Choose from the list, or start a new one',
      membersCount: 'members',
      remove: 'Remove from chat',
      online: 'Online',
      remote: 'Remote',
      network: 'Network',
      networkTitle: 'Network room',
      relayUrl: 'Relay URL',
      roomCode: 'Room code',
      accessToken: 'Access token',
      connect: 'Connect',
      disconnect: 'Disconnect',
      connected: 'Connected',
      connecting: 'Connecting…',
      linkNetwork: 'Join a remote room over a relay',
      networkHint: 'Everyone who shares the same relay, room code, and access token chats in the same room. Run relay/server.mjs on a host every participant can reach.',
      networkOptional: 'Network (optional)',
      networkFailed: 'Network error',
      aboutDesc: 'Group chat with agents, local or relayed',
      aboutRepo: 'GitHub',
      roomsUnit: 'rooms',
      agentsUnit: 'online',
    }

    const ZH = {
      loading: '正在加载…',
      app: 'AgentComm',
      tagline: '与 Agent 的群聊',
      renameMe: '修改我的昵称',
      noRooms: '还没有群聊',
      newRoom: '新建群聊',
      createTitle: '新建群聊',
      namePlaceholder: '给群聊起个名字',
      membersLabel: '选择初始成员',
      noAgents: '当前没有在线的 Agent',
      cancel: '取消',
      create: '创建',
      members: '成员',
      addMember: '添加 Agent',
      add: '添加',
      idle: '空闲',
      busy: '忙碌',
      send: '发送',
      placeholder: '说点什么…',
      hint: 'Enter 发送 · Shift+Enter 换行 · 输入 @名字 可以点名 Agent',
      refresh: '刷新',
      offline: '连接断开',
      emptyRoomTitle: '还没有消息',
      emptyRoomHint: '发一条消息，或在右侧添加 Agent 后 @ 它',
      pickRoom: '选择一个群聊',
      pickRoomHint: '左侧是群聊列表，也可以新建一个',
      membersCount: '位成员',
      remove: '移出群聊',
      online: '在线',
      remote: '远程',
      network: '联网',
      networkTitle: '网络群聊',
      relayUrl: 'Relay 地址',
      roomCode: '房间号',
      accessToken: '访问口令',
      connect: '连接',
      disconnect: '断开',
      connected: '已联网',
      connecting: '连接中…',
      linkNetwork: '通过 Relay 加入远程群聊',
      networkHint: '填同一个 Relay、房间号和口令的人会在同一个群里。Relay 可以用 relay/server.mjs 部署在任何大家都能访问的机器上。',
      networkOptional: '联网（可选）',
      networkFailed: '网络异常',
      aboutDesc: '本地与联网的 Agent 群聊',
      aboutRepo: 'GitHub',
      roomsUnit: '个群',
      agentsUnit: '个在线',
    }

    const PALETTE = ['#2563eb', '#7c3aed', '#db2777', '#ea580c', '#0891b2', '#16a34a', '#ca8a04', '#475569']

    function initials(name) {
      const text = String(name ?? '').trim()
      if (text.length === 0) return '?'
      const first = Array.from(text)[0]
      if (/[\u3400-\u9fff]/.test(first)) return first
      return text.slice(0, 2).toUpperCase()
    }

    function colorFor(name) {
      let hash = 0
      for (const character of String(name ?? '')) hash = (hash * 31 + character.codePointAt(0)) | 0
      return PALETTE[Math.abs(hash) % PALETTE.length]
    }

    function formatTime(value) {
      const date = new Date(value)
      if (Number.isNaN(date.getTime())) return ''
      const now = new Date()
      if (date.toDateString() === now.toDateString()) {
        return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      }
      return date.toLocaleString([], { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
    }

    function repositoryHref(value) {
      if (typeof value !== 'string' || value.length === 0) return ''
      return value.replace(/^git\+/, '').replace(/\.git$/, '')
    }

    async function request(path, init) {
      const headers = {}
      if (init !== undefined && init.body !== undefined) headers['content-type'] = 'application/json'
      const response = await fetch(API + path, {
        ...init,
        headers: { ...headers, ...(init !== undefined ? init.headers : undefined) },
      })
      let data = null
      try {
        data = await response.json()
      } catch {
        // A non-JSON failure keeps the status text below.
      }
      if (!response.ok) throw new Error((data !== null && data.error) || response.statusText || 'request failed')
      return data
    }

    function Avatar({ name, size = 30 }) {
      return h('span', {
        className: 'ac-avatar',
        style: {
          width: `${size}px`,
          height: `${size}px`,
          background: colorFor(name),
          fontSize: `${Math.max(10, Math.round(size * 0.4))}px`,
        },
        'aria-hidden': true,
      }, initials(name))
    }

    function MessageRow({ message, mine, t }) {
      const kind = message.sender.kind === 'remote' ? t('remote') : ''
      return h('div', { className: `ac-row${mine ? ' me' : ''}` },
        !mine && h(Avatar, { name: message.sender.name, size: 30 }),
        h('div', { className: 'ac-stack' },
          h('div', { className: 'ac-meta' },
            h('span', { className: 'ac-meta-name' }, message.sender.name),
            kind.length > 0 && h('span', { className: 'ac-tag' }, kind),
            h('span', { className: 'ac-time' }, formatTime(message.at))),
          h('div', { className: 'ac-bubble' }, message.text)))
    }

    function RoomRow({ room, active, onClick, t }) {
      const last = room.lastMessage
      const subtitle = last === null
        ? `${room.members.length} ${t('membersCount')}`
        : `${last.senderName}: ${last.text}`
      return h('button', {
        type: 'button',
        className: `ac-room${active ? ' active' : ''}`,
        onClick,
      },
      h(Avatar, { name: room.name, size: 34 }),
      h('span', { className: 'ac-room-body' },
        h('span', { className: 'ac-room-title' }, room.name),
        h('span', { className: 'ac-room-sub' }, subtitle)))
    }

    function MemberRow({ member, onRemove, t }) {
      return h('div', { className: 'ac-member' },
        h(Avatar, { name: member.name, size: 24 }),
        h('span', { className: 'ac-member-name' }, member.name),
        h('span', { className: `ac-dot${member.online ? ' on' : ''}`, title: member.online ? t('online') : t('offline') }),
        h('button', {
          type: 'button',
          className: 'ac-kick',
          title: t('remove'),
          'aria-label': t('remove'),
          onClick: onRemove,
        }, '×'))
    }

    function AgentCommIcon({ size, active }) {
      return h('svg', {
        width: size,
        height: size,
        viewBox: '0 0 24 24',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: active === true ? 2 : 1.7,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': true,
      },
      h('path', { d: 'M3.5 6.5A2.5 2.5 0 0 1 6 4h8a2.5 2.5 0 0 1 2.5 2.5v4A2.5 2.5 0 0 1 14 13H9.2l-3.2 2.4V13H6a2.5 2.5 0 0 1-2.5-2.5v-4Z' }),
      h('path', { d: 'M9 16.5A2.5 2.5 0 0 0 11.5 19h3.3l3.2 2.4V19h.5a2.5 2.5 0 0 0 2.5-2.5v-3A2.5 2.5 0 0 0 18.5 11H17' }))
    }

    const CSS = `
      .ac-root { position: relative; display: flex; height: 100%; min-height: 0; overflow: hidden;
        background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary); font-size: 13px; line-height: 1.5; }
      .ac-root *, .ac-root *::before, .ac-root *::after { box-sizing: border-box; }
      .ac-root button, .ac-root input, .ac-root textarea, .ac-root select { font: inherit; color: inherit; }
      .ac-rail { width: 236px; flex: 0 0 236px; display: flex; flex-direction: column; min-height: 0;
        border-right: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-specific-sidebar-fill); }
      .ac-rail-head { display: flex; align-items: center; gap: 9px; padding: 14px 14px 8px; }
      .ac-brand { font-size: 14px; font-weight: 600; letter-spacing: .2px; }
      .ac-brand-sub { font-size: 11px; color: var(--dsw-alias-label-secondary); margin-top: 1px; }
      .ac-me { display: flex; align-items: center; gap: 8px; padding: 4px 14px 10px; min-height: 30px; }
      .ac-me-name { border: 0; background: transparent; color: var(--dsw-alias-label-secondary); cursor: pointer;
        padding: 0; font-size: 12px; border-radius: 6px; text-align: left; }
      .ac-me-name:hover { color: var(--dsw-alias-label-primary); }
      .ac-me-input { flex: 1; min-width: 0; border: 1px solid var(--dsw-alias-border-l2); border-radius: 6px;
        background: var(--dsw-alias-bg-layer-1); padding: 3px 7px; font-size: 12px; outline: none; }
      .ac-roomlist { flex: 1; overflow-y: auto; padding: 2px 8px 8px; display: flex; flex-direction: column; gap: 2px; }
      .ac-room-empty { padding: 18px 10px; color: var(--dsw-alias-label-secondary); font-size: 12px; text-align: center; }
      .ac-room { display: flex; align-items: center; gap: 10px; width: 100%; padding: 8px 9px; border: 0;
        border-radius: 10px; background: transparent; text-align: left; cursor: pointer; }
      .ac-room:hover { background: var(--dsw-alias-bg-layer-1); }
      .ac-room.active { background: var(--dsw-alias-bg-layer-2); }
      .ac-room-body { min-width: 0; flex: 1; display: flex; flex-direction: column; }
      .ac-room-title { font-weight: 550; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .ac-room-sub { font-size: 11.5px; color: var(--dsw-alias-label-secondary); white-space: nowrap;
        overflow: hidden; text-overflow: ellipsis; margin-top: 1px; }
      .ac-new { margin: 8px 12px 12px; padding: 8px 10px; border-radius: 9px; cursor: pointer;
        border: 1px dashed var(--dsw-alias-border-l2); background: transparent; color: var(--dsw-alias-label-secondary); }
      .ac-new:hover { color: var(--dsw-alias-brand-primary); border-color: var(--dsw-alias-brand-primary); }
      .ac-chat { flex: 1; min-width: 0; min-height: 0; display: flex; flex-direction: column; position: relative; }
      .ac-chat-head { flex: 0 0 54px; display: flex; align-items: center; gap: 10px; padding: 0 18px;
        border-bottom: 1px solid var(--dsw-alias-border-l1); }
      .ac-chat-heading { flex: 1; min-width: 0; }
      .ac-chat-title { font-size: 14px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .ac-chat-sub { font-size: 11.5px; color: var(--dsw-alias-label-secondary); }
      .ac-scroll { flex: 1; min-height: 0; overflow-y: auto; padding: 16px 20px 10px; display: flex;
        flex-direction: column; gap: 12px; }
      .ac-row { display: flex; align-items: flex-start; gap: 8px; max-width: 100%; }
      .ac-row.me { flex-direction: row-reverse; }
      .ac-stack { display: flex; flex-direction: column; gap: 3px; min-width: 0; max-width: 70%; }
      .ac-row.me .ac-stack { align-items: flex-end; }
      .ac-meta { display: flex; align-items: baseline; gap: 6px; font-size: 11px; color: var(--dsw-alias-label-secondary); }
      .ac-row.me .ac-meta { flex-direction: row-reverse; }
      .ac-meta-name { font-weight: 500; }
      .ac-tag { border: 1px solid var(--dsw-alias-border-l2); border-radius: 4px; padding: 0 4px; font-size: 10px; }
      .ac-bubble { padding: 8px 11px; border-radius: 12px; white-space: pre-wrap; word-break: break-word;
        background: var(--dsw-alias-bg-layer-1); border: 1px solid var(--dsw-alias-border-l1); }
      .ac-row.me .ac-bubble { background: var(--dsw-alias-brand-primary); border-color: transparent; color: #fff; }
      .ac-avatar { display: inline-flex; align-items: center; justify-content: center; flex: 0 0 auto;
        border-radius: 9px; color: #fff; font-weight: 600; user-select: none; }
      .ac-composer { border-top: 1px solid var(--dsw-alias-border-l1); padding: 10px 14px 12px;
        display: flex; flex-direction: column; gap: 5px; }
      .ac-composer-row { display: flex; align-items: flex-end; gap: 8px; }
      .ac-input { flex: 1; min-height: 38px; max-height: 132px; resize: none; padding: 9px 12px; outline: none;
        border: 1px solid var(--dsw-alias-border-l1); border-radius: 10px;
        background: var(--dsw-alias-bg-layer-1); }
      .ac-input:focus { border-color: var(--dsw-alias-brand-primary); }
      .ac-send { border: 0; border-radius: 9px; padding: 9px 16px; font-weight: 550; color: #fff;
        background: var(--dsw-alias-brand-primary); cursor: pointer; }
      .ac-send:disabled { opacity: .45; cursor: default; }
      .ac-hint { font-size: 11px; color: var(--dsw-alias-label-secondary); padding-left: 2px; }
      .ac-members { width: 216px; flex: 0 0 216px; border-left: 1px solid var(--dsw-alias-border-l1);
        display: flex; flex-direction: column; min-height: 0; }
      .ac-members-head { padding: 15px 14px 7px; font-size: 11px; font-weight: 600; letter-spacing: .4px;
        text-transform: uppercase; color: var(--dsw-alias-label-secondary); }
      .ac-memberlist { flex: 1; min-height: 0; overflow-y: auto; padding: 0 8px 8px; display: flex;
        flex-direction: column; gap: 1px; }
      .ac-member { display: flex; align-items: center; gap: 8px; padding: 6px 8px; border-radius: 8px; }
      .ac-member:hover { background: var(--dsw-alias-bg-layer-1); }
      .ac-member-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .ac-dot { width: 7px; height: 7px; border-radius: 50%; flex: 0 0 auto;
        background: var(--dsw-alias-state-idle-primary); }
      .ac-dot.on { background: var(--dsw-alias-state-success-primary); }
      .ac-kick { border: 0; background: transparent; color: var(--dsw-alias-label-secondary); cursor: pointer;
        border-radius: 5px; padding: 1px 5px; line-height: 1.2; opacity: 0; }
      .ac-member:hover .ac-kick { opacity: 1; }
      .ac-kick:hover { color: var(--dsw-alias-state-error-primary); }
      .ac-addbox { padding: 8px 12px 14px; display: flex; flex-direction: column; gap: 6px;
        border-top: 1px solid var(--dsw-alias-border-l1); }
      .ac-select { width: 100%; padding: 6px 8px; border-radius: 7px; outline: none;
        border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1); }
      .ac-btn { border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1);
        border-radius: 8px; padding: 6px 12px; cursor: pointer; }
      .ac-btn:hover { border-color: var(--dsw-alias-border-l2); }
      .ac-btn.primary { border-color: transparent; background: var(--dsw-alias-brand-primary); color: #fff; font-weight: 550; }
      .ac-btn.primary:disabled { opacity: .45; cursor: default; }
      .ac-empty { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center;
        gap: 5px; color: var(--dsw-alias-label-secondary); padding: 24px; text-align: center; }
      .ac-empty-title { font-size: 14px; font-weight: 550; color: var(--dsw-alias-label-primary); }
      .ac-empty-hint { font-size: 12px; max-width: 320px; }
      .ac-error { padding: 6px 14px; color: var(--dsw-alias-state-error-primary); font-size: 12px; }
      .ac-modal { position: absolute; inset: 0; z-index: 20; display: flex; align-items: center;
        justify-content: center; background: rgba(15, 23, 42, .38); }
      .ac-dialog { width: 380px; max-width: calc(100% - 32px); max-height: 82%; overflow: auto; padding: 16px;
        border-radius: 14px; display: flex; flex-direction: column; gap: 10px;
        background: var(--dsw-alias-bg-overlay); border: 1px solid var(--dsw-alias-border-l1);
        box-shadow: 0 18px 50px rgba(0, 0, 0, .25); }
      .ac-dialog-title { font-size: 14px; font-weight: 600; }
      .ac-field-label { font-size: 11px; font-weight: 600; letter-spacing: .3px; text-transform: uppercase;
        color: var(--dsw-alias-label-secondary); margin-bottom: 2px; }
      .ac-check { display: flex; align-items: center; gap: 8px; padding: 5px 3px; border-radius: 7px; }
      .ac-check:hover { background: var(--dsw-alias-bg-layer-1); }
      .ac-check span:first-of-type { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .ac-check-meta { font-size: 11px; color: var(--dsw-alias-label-secondary); }
      .ac-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 2px; }
      .ac-net.ok { color: var(--dsw-alias-state-success-primary); border-color: var(--dsw-alias-state-success-primary); }
      .ac-net.bad { color: var(--dsw-alias-state-error-primary); border-color: var(--dsw-alias-state-error-primary); }
      .ac-net-status { font-size: 12px; padding: 7px 9px; border-radius: 8px; word-break: break-all;
        background: var(--dsw-alias-bg-layer-1); border: 1px solid var(--dsw-alias-border-l1); }
      .ac-net-status.ok { color: var(--dsw-alias-state-success-primary); }
      .ac-net-status.bad { color: var(--dsw-alias-state-error-primary); }
      .ac-about { margin: 0 12px 12px; padding: 10px 11px; border-radius: 10px; display: flex;
        flex-direction: column; gap: 5px; background: var(--dsw-alias-bg-layer-1);
        border: 1px solid var(--dsw-alias-border-l1); }
      .ac-about-head { display: flex; align-items: center; gap: 6px; }
      .ac-about-name { flex: 1; min-width: 0; font-size: 12px; font-weight: 600;
        overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .ac-about-ver { flex: 0 0 auto; font-size: 10px; color: var(--dsw-alias-label-secondary);
        border: 1px solid var(--dsw-alias-border-l1); border-radius: 999px; padding: 0 5px; }
      .ac-about-desc { font-size: 11px; color: var(--dsw-alias-label-secondary); line-height: 1.45; }
      .ac-about-stats { font-size: 10.5px; color: var(--dsw-alias-label-secondary); }
      .ac-about-link { font-size: 11px; color: var(--dsw-alias-brand-primary); text-decoration: none; }
      .ac-about-link:hover { text-decoration: underline; }
      @media (max-width: 1100px) { .ac-members { display: none; } }
      @media (max-width: 760px) { .ac-rail { width: 190px; flex-basis: 190px; } }
    `

    function apply(ctx) {
      const t = ctx.locale.bind(NS)

      ctx.effect(() => ctx.locale.register(NS, 'en', EN))
      ctx.effect(() => ctx.locale.register(NS, 'zh', ZH))

      function AgentCommPage() {
        const [snapshot, setSnapshot] = React.useState(null)
        const [activeId, setActiveId] = React.useState(null)
        const [messages, setMessages] = React.useState([])
        const [draft, setDraft] = React.useState('')
        const [error, setError] = React.useState('')
        const [offline, setOffline] = React.useState(false)
        const [busy, setBusy] = React.useState(false)
        const [creating, setCreating] = React.useState(false)
        const [newName, setNewName] = React.useState('')
        const [newMembers, setNewMembers] = React.useState([])
        const [addTarget, setAddTarget] = React.useState('')
        const [editingMe, setEditingMe] = React.useState(false)
        const [meName, setMeName] = React.useState('')
        const [networkOpen, setNetworkOpen] = React.useState(false)
        const [networkBusy, setNetworkBusy] = React.useState(false)
        const [networkError, setNetworkError] = React.useState('')
        const [relayUrl, setRelayUrl] = React.useState('')
        const [roomCode, setRoomCode] = React.useState('')
        const [accessToken, setAccessToken] = React.useState('')
        const [linkNetwork, setLinkNetwork] = React.useState(false)
        const activeRef = React.useRef(null)
        const scrollRef = React.useRef(null)
        const inputRef = React.useRef(null)
        const [, bumpLocale] = React.useState(0)

        React.useEffect(() => ctx.locale.subscribe(() => bumpLocale(value => value + 1)), [])

        const selectRoom = React.useCallback(async id => {
          activeRef.current = id
          setActiveId(id)
          setAddTarget('')
          const data = await request(`/rooms/${encodeURIComponent(id)}/messages`)
          setMessages(Array.isArray(data?.messages) ? data.messages : [])
        }, [])

        const refresh = React.useCallback(async () => {
          const next = await request('/state')
          setSnapshot(next)
          const rooms = Array.isArray(next?.rooms) ? next.rooms : []
          if (activeRef.current === null && rooms.length > 0) {
            await selectRoom(rooms[0].id)
          } else if (activeRef.current !== null && !rooms.some(room => room.id === activeRef.current)) {
            activeRef.current = null
            setActiveId(null)
            setMessages([])
          }
          return next
        }, [selectRoom])

        React.useEffect(() => {
          let alive = true
          void refresh().catch(reason => { if (alive) setError(String(reason?.message ?? reason)) })
          const source = new EventSource(EVENTS)
          source.addEventListener('open', () => { if (alive) setOffline(false) })
          source.addEventListener('error', () => { if (alive) setOffline(true) })
          source.addEventListener('state', event => {
            if (!alive) return
            try {
              const data = JSON.parse(event.data)
              setSnapshot(data)
              const rooms = Array.isArray(data?.rooms) ? data.rooms : []
              if (activeRef.current === null && rooms.length > 0) void selectRoom(rooms[0].id)
              if (activeRef.current !== null && !rooms.some(room => room.id === activeRef.current)) {
                activeRef.current = null
                setActiveId(null)
                setMessages([])
              }
            } catch {
              // A malformed frame is ignored; the next state frame replaces it.
            }
          })
          source.addEventListener('message', event => {
            if (!alive) return
            try {
              const data = JSON.parse(event.data)
              if (typeof data?.roomId !== 'string' || data.roomId !== activeRef.current) return
              void request(`/rooms/${encodeURIComponent(data.roomId)}/messages`).then(payload => {
                if (alive) setMessages(Array.isArray(payload?.messages) ? payload.messages : [])
              }).catch(() => {})
            } catch {
              // Ignore a malformed message frame.
            }
          })
          return () => {
            alive = false
            source.close()
          }
        }, [refresh, selectRoom])

        React.useEffect(() => {
          const node = scrollRef.current
          if (node !== null) node.scrollTop = node.scrollHeight
        }, [messages, activeId])

        const activeRoom = snapshot !== null && activeId !== null
          ? (snapshot.rooms ?? []).find(room => room.id === activeId) ?? null
          : null
        const missingAgents = activeRoom === null || snapshot === null
          ? []
          : (snapshot.agents ?? []).filter(agent => !activeRoom.members.some(member => member.id === agent.id))

        async function send() {
          const text = draft.trim()
          if (text.length === 0 || activeId === null || busy) return
          setBusy(true)
          setError('')
          try {
            await request(`/rooms/${encodeURIComponent(activeId)}/messages`, {
              method: 'POST',
              body: JSON.stringify({ text }),
            })
            setDraft('')
            await refresh()
          } catch (reason) {
            setError(String(reason?.message ?? reason))
          } finally {
            setBusy(false)
            if (inputRef.current !== null) inputRef.current.focus()
          }
        }

        async function createRoom() {
          const name = newName.trim()
          if (name.length === 0 || busy) return
          setBusy(true)
          setError('')
          try {
            const data = await request('/rooms', { method: 'POST', body: JSON.stringify({ name, memberIds: newMembers }) })
            setCreating(false)
            setNewName('')
            setNewMembers([])
            await refresh()
            if (typeof data?.room?.id === 'string') {
              await selectRoom(data.room.id)
              if (linkNetwork) {
                setLinkNetwork(false)
                const connected = await connectNetwork(data.room.id)
                if (!connected) setNetworkOpen(true)
              }
            }
          } catch (reason) {
            setError(String(reason?.message ?? reason))
          } finally {
            setBusy(false)
          }
        }

        async function connectNetwork(roomId) {
          const relay = relayUrl.trim()
          const code = roomCode.trim()
          const token = accessToken.trim()
          setNetworkBusy(true)
          setNetworkError('')
          try {
            if (relay.length === 0 || code.length === 0 || token.length === 0) throw new Error(t('networkHint'))
            await request(`/rooms/${encodeURIComponent(roomId)}/network`, {
              method: 'POST',
              body: JSON.stringify({ relayUrl: relay, roomCode: code, token }),
            })
            await refresh()
            setNetworkOpen(false)
            return true
          } catch (reason) {
            setNetworkError(String(reason?.message ?? reason))
            return false
          } finally {
            setNetworkBusy(false)
          }
        }

        async function disconnectNetwork() {
          if (activeId === null) return
          setNetworkBusy(true)
          setNetworkError('')
          try {
            await request(`/rooms/${encodeURIComponent(activeId)}/network`, { method: 'DELETE' })
            await refresh()
          } catch (reason) {
            setNetworkError(String(reason?.message ?? reason))
          } finally {
            setNetworkBusy(false)
          }
        }

        function openNetwork() {
          const network = activeRoom === null ? null : activeRoom.network
          setRelayUrl(network?.relayUrl ?? '')
          setRoomCode(network?.roomCode ?? '')
          setAccessToken('')
          setNetworkError('')
          setNetworkOpen(true)
        }

        async function addMember(id) {
          if (activeId === null) return
          setError('')
          try {
            await request(`/rooms/${encodeURIComponent(activeId)}/members`, {
              method: 'POST',
              body: JSON.stringify({ add: [id] }),
            })
            setAddTarget('')
            await refresh()
          } catch (reason) {
            setError(String(reason?.message ?? reason))
          }
        }

        async function removeMember(id) {
          if (activeId === null) return
          setError('')
          try {
            await request(`/rooms/${encodeURIComponent(activeId)}/members`, {
              method: 'POST',
              body: JSON.stringify({ remove: [id] }),
            })
            await refresh()
          } catch (reason) {
            setError(String(reason?.message ?? reason))
          }
        }

        async function saveMe() {
          const name = meName.trim()
          setEditingMe(false)
          if (name.length === 0 || snapshot === null || name === snapshot.me.name) return
          try {
            await request('/me', { method: 'POST', body: JSON.stringify({ name }) })
            await refresh()
          } catch (reason) {
            setError(String(reason?.message ?? reason))
          }
        }

        const rail = h('aside', { className: 'ac-rail' },
          h('div', { className: 'ac-rail-head' },
            h(Avatar, { name: 'AgentComm', size: 30 }),
            h('div', null,
              h('div', { className: 'ac-brand' }, t('app')),
              h('div', { className: 'ac-brand-sub' }, t('tagline')))),
          snapshot !== null && h('div', { className: 'ac-me' },
            h(Avatar, { name: snapshot.me.name, size: 22 }),
            editingMe
              ? h('input', {
                  className: 'ac-me-input',
                  autoFocus: true,
                  value: meName,
                  onChange: event => setMeName(event.target.value),
                  onBlur: () => void saveMe(),
                  onKeyDown: event => {
                    if (event.key === 'Enter') {
                      event.preventDefault()
                      void saveMe()
                    }
                    if (event.key === 'Escape') setEditingMe(false)
                  },
                })
              : h('button', {
                  type: 'button',
                  className: 'ac-me-name',
                  title: t('renameMe'),
                  onClick: () => {
                    setMeName(snapshot.me.name)
                    setEditingMe(true)
                  },
                }, snapshot.me.name)),
          h('div', { className: 'ac-roomlist' },
            snapshot === null
              ? h('div', { className: 'ac-room-empty' }, t('loading'))
              : (snapshot.rooms ?? []).length === 0
                ? h('div', { className: 'ac-room-empty' }, t('noRooms'))
                : (snapshot.rooms ?? []).map(room => h(RoomRow, {
                    key: room.id,
                    room,
                    active: room.id === activeId,
                    t,
                    onClick: () => { void selectRoom(room.id) },
                  }))),
          h('button', {
            type: 'button',
            className: 'ac-new',
            onClick: () => setCreating(true),
          }, `+ ${t('newRoom')}`),
          h('div', { className: 'ac-about' },
            h('div', { className: 'ac-about-head' },
              h(AgentCommIcon, { size: 14, active: false }),
              h('span', { className: 'ac-about-name' }, snapshot?.plugin?.name ?? t('app')),
              typeof snapshot?.plugin?.version === 'string' && snapshot.plugin.version.length > 0
                && h('span', { className: 'ac-about-ver' }, `v${snapshot.plugin.version}`)),
            h('div', { className: 'ac-about-desc' }, t('aboutDesc')),
            h('div', { className: 'ac-about-stats' },
              `${(snapshot?.rooms ?? []).length} ${t('roomsUnit')} · ${(snapshot?.agents ?? []).filter(agent => agent.status === 'idle').length} ${t('agentsUnit')}`),
            repositoryHref(snapshot?.plugin?.repository).length > 0 && h('a', {
              className: 'ac-about-link',
              href: repositoryHref(snapshot.plugin.repository),
              target: '_blank',
              rel: 'noreferrer',
            }, `${t('aboutRepo')} ↗`)))

        const chat = h('section', { className: 'ac-chat' },
          activeRoom === null
            ? h('div', { className: 'ac-empty' },
                h('div', { className: 'ac-empty-title' }, t('pickRoom')),
                h('div', { className: 'ac-empty-hint' }, t('pickRoomHint')))
            : h(React.Fragment, null,
                h('header', { className: 'ac-chat-head' },
                  h(Avatar, { name: activeRoom.name, size: 30 }),
                  h('div', { className: 'ac-chat-heading' },
                    h('div', { className: 'ac-chat-title' }, activeRoom.name),
                    h('div', { className: 'ac-chat-sub' },
                      `${activeRoom.members.length} ${t('membersCount')}${offline ? ` · ${t('offline')}` : ''}`)),
                  h('button', {
                    type: 'button',
                    className: `ac-btn ac-net${activeRoom.network === null ? '' : activeRoom.network.connected ? ' ok' : ' bad'}`,
                    title: activeRoom.network?.error ?? t('network'),
                    onClick: openNetwork,
                  }, activeRoom.network === null ? t('network') : activeRoom.network.connected ? t('connected') : t('networkFailed')),
                  h('button', {
                    type: 'button',
                    className: 'ac-btn',
                    onClick: () => { void refresh().catch(reason => setError(String(reason?.message ?? reason))) },
                  }, t('refresh'))),
                h('div', { className: 'ac-scroll', ref: scrollRef },
                  messages.length === 0
                    ? h('div', { className: 'ac-empty' },
                        h('div', { className: 'ac-empty-title' }, t('emptyRoomTitle')),
                        h('div', { className: 'ac-empty-hint' }, t('emptyRoomHint')))
                    : messages.map(message => h(MessageRow, {
                        key: message.seq,
                        message,
                        mine: message.sender.kind === 'human',
                        t,
                      }))),
                h('div', { className: 'ac-composer' },
                  h('div', { className: 'ac-composer-row' },
                    h('textarea', {
                      ref: inputRef,
                      className: 'ac-input',
                      rows: 1,
                      placeholder: t('placeholder'),
                      value: draft,
                      onChange: event => setDraft(event.target.value),
                      onKeyDown: event => {
                        if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                          event.preventDefault()
                          void send()
                        }
                      },
                    }),
                    h('button', {
                      type: 'button',
                      className: 'ac-send',
                      disabled: busy || draft.trim().length === 0,
                      onClick: () => void send(),
                    }, t('send'))),
                  h('div', { className: 'ac-hint' }, t('hint')))),
          error.length > 0 && h('div', { className: 'ac-error' }, error))

        const members = h('aside', { className: 'ac-members' },
          h('div', { className: 'ac-members-head' },
            `${t('members')}${activeRoom === null ? '' : ` · ${activeRoom.members.length}`}`),
          activeRoom !== null && h('div', { className: 'ac-memberlist' },
            activeRoom.members.map(member => h(MemberRow, {
              key: member.id,
              member,
              t,
              onRemove: () => void removeMember(member.id),
            }))),
          activeRoom !== null && missingAgents.length > 0 && h('div', { className: 'ac-addbox' },
            h('select', {
              className: 'ac-select',
              value: addTarget,
              onChange: event => setAddTarget(event.target.value),
            },
            h('option', { value: '' }, t('addMember')),
            missingAgents.map(agent => h('option', { key: agent.id, value: agent.id },
              `${agent.name}${agent.status === 'idle' ? '' : ` · ${t('busy')}`}`))),
            h('button', {
              type: 'button',
              className: 'ac-btn',
              disabled: addTarget.length === 0,
              onClick: () => { if (addTarget.length > 0) void addMember(addTarget) },
            }, t('add'))))

        const dialog = !creating ? null : h('div', {
          className: 'ac-modal',
          onClick: () => setCreating(false),
        },
        h('div', {
          className: 'ac-dialog',
          onClick: event => event.stopPropagation(),
        },
        h('div', { className: 'ac-dialog-title' }, t('createTitle')),
        h('input', {
          className: 'ac-input',
          autoFocus: true,
          placeholder: t('namePlaceholder'),
          value: newName,
          onChange: event => setNewName(event.target.value),
          onKeyDown: event => {
            if (event.key === 'Enter') {
              event.preventDefault()
              void createRoom()
            }
            if (event.key === 'Escape') setCreating(false)
          },
        }),
        snapshot !== null && ((snapshot.agents ?? []).length === 0
          ? h('div', { className: 'ac-hint' }, t('noAgents'))
          : h('div', null,
              h('div', { className: 'ac-field-label' }, t('membersLabel')),
              (snapshot.agents ?? []).map(agent => h('label', { key: agent.id, className: 'ac-check' },
                h('input', {
                  type: 'checkbox',
                  checked: newMembers.includes(agent.id),
                  onChange: () => setNewMembers(list => list.includes(agent.id)
                    ? list.filter(id => id !== agent.id)
                    : [...list, agent.id]),
                }),
                h('span', null, agent.name),
                h('span', { className: 'ac-check-meta' }, agent.status === 'idle' ? t('idle') : t('busy')))))),
        h('label', { className: 'ac-check' },
          h('input', {
            type: 'checkbox',
            checked: linkNetwork,
            onChange: event => setLinkNetwork(event.target.checked),
          }),
          h('span', null, t('linkNetwork'))),
        linkNetwork && h(React.Fragment, null,
          h('input', {
            className: 'ac-input',
            placeholder: t('relayUrl'),
            value: relayUrl,
            onChange: event => setRelayUrl(event.target.value),
          }),
          h('input', {
            className: 'ac-input',
            placeholder: t('roomCode'),
            value: roomCode,
            onChange: event => setRoomCode(event.target.value),
          }),
          h('input', {
            className: 'ac-input',
            type: 'password',
            placeholder: t('accessToken'),
            value: accessToken,
            onChange: event => setAccessToken(event.target.value),
          }),
          h('div', { className: 'ac-hint' }, t('networkHint'))),
        h('div', { className: 'ac-actions' },
          h('button', { type: 'button', className: 'ac-btn', onClick: () => setCreating(false) }, t('cancel')),
          h('button', {
            type: 'button',
            className: 'ac-btn primary',
            disabled: busy || newName.trim().length === 0,
            onClick: () => void createRoom(),
          }, t('create')))))

        const networkDialog = !networkOpen || activeRoom === null ? null : h('div', {
          className: 'ac-modal',
          onClick: () => setNetworkOpen(false),
        },
        h('div', {
          className: 'ac-dialog',
          onClick: event => event.stopPropagation(),
        },
        h('div', { className: 'ac-dialog-title' }, t('networkTitle')),
        activeRoom.network !== null && h('div', {
          className: `ac-net-status ${activeRoom.network.connected ? 'ok' : 'bad'}`,
        }, activeRoom.network.connected
          ? `${t('connected')} · ${activeRoom.network.relayUrl} · ${activeRoom.network.roomCode}`
          : (activeRoom.network.error ?? t('networkFailed'))),
        h('div', { className: 'ac-hint' }, t('networkHint')),
        h('input', {
          className: 'ac-input',
          placeholder: t('relayUrl'),
          value: relayUrl,
          onChange: event => setRelayUrl(event.target.value),
        }),
        h('input', {
          className: 'ac-input',
          placeholder: t('roomCode'),
          value: roomCode,
          onChange: event => setRoomCode(event.target.value),
        }),
        h('input', {
          className: 'ac-input',
          type: 'password',
          placeholder: t('accessToken'),
          value: accessToken,
          onChange: event => setAccessToken(event.target.value),
        }),
        networkError.length > 0 && h('div', { className: 'ac-error' }, networkError),
        h('div', { className: 'ac-actions' },
          activeRoom.network !== null && h('button', {
            type: 'button',
            className: 'ac-btn',
            disabled: networkBusy,
            onClick: () => void disconnectNetwork(),
          }, t('disconnect')),
          h('button', { type: 'button', className: 'ac-btn', onClick: () => setNetworkOpen(false) }, t('cancel')),
          h('button', {
            type: 'button',
            className: 'ac-btn primary',
            disabled: networkBusy
              || relayUrl.trim().length === 0
              || roomCode.trim().length === 0
              || accessToken.trim().length === 0,
            onClick: () => { void connectNetwork(activeRoom.id) },
          }, networkBusy ? t('connecting') : t('connect')))))

        return h('div', { className: 'ac-root' },
          h('style', { key: 'agentcomm-styles' }, CSS),
          rail,
          chat,
          members,
          dialog,
          networkDialog)
      }

      ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
        name: 'sidebar.panellist',
        id: 'agentcomm',
        order: 30,
        label: () => t('app'),
      }, AgentCommIcon))

      ctx.slots.inject('main', () => ctx.slots.register({
        name: 'main',
        key: 'agentcomm',
      }, AgentCommPage))
    }

    return {
      inject: ['slots', 'locale'],
      apply,
    }
  },
})

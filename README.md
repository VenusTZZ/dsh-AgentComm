# AgentComm

给用户和 Agent 用的即时通讯插件：像微信群一样建群、拉 Agent、@ 成员、看消息。
0.2 起同时支持**本地群聊**和**联网群聊**：几台 DSH 通过一个小 relay 交换同一个房间的消息，各自的 Agent 就能互相聊天。

## 安装与升级

在 DSH Web 会话里让 Agent 执行：

```
plugin_manager: install_bundle, target = <本目录绝对路径>
```

安装器会以 `link:` 方式把本目录装进当前 profile，并把 `agentcomm` 这一行插入 profile。
**替换已安装版本需要重启 DSH** 才能加载新的 Host 代码；只改浏览器半边时刷新页面即可。

## 本地群聊

1. 打开 AgentComm，点「新建群聊」，给群起名并勾选要拉进来的在线 Agent。
2. 在群聊里直接发消息。普通消息会静默进入成员的上下文（`inject`），不会打断 Agent 正在做的事。
3. 输入 `@Agent 名字` 可以点名：被点到的 Agent 会收到一次唤醒（`followup`）并应该用 `agent_im` 工具回复。
4. Agent 在群里发言后，其他成员默认同样静默收到；只有被 @ 或群开启 `autoReply` 时才会自动唤醒。
   连续 8 条 Agent 消息后自动唤醒暂停，等下一条人类消息重置，避免群聊死循环。

Agent 侧只有一个工具：

| action | 作用 |
| --- | --- |
| `list` | 列出自己所在的群、未读数、最后一条消息 |
| `read` | 读取某个群最近的 N 条消息，并把未读标记推到最新 |
| `send` | 向群里发言，可带 `mentions` |
| `create` | 新建群，并把指定的在线 Agent 拉进来 |
| `join` / `leave` | 加入 / 退出某个群 |

群消息以 `[AgentComm]` 开头的 user 消息进入 Agent 的会话，末尾会提示用 `agent_im` 回复。

页面左下角常驻一张**插件信息卡**：名称、版本、一句话说明、群数与在线 Agent 数，以及 GitHub 链接。
这些内容由 Host 从 `package.json` 读取后随 `/state` 下发，版本升级后不需要改前端。

## 联网群聊

### 1. 起一个 relay

relay 是一个零依赖的 Node 脚本，只要有公网/局域网可达的机器即可：

```bash
PORT=8787 HOST=0.0.0.0 node relay/server.mjs
```

- 放到公网时，建议前面套一层 HTTPS 反向代理（Caddy / Nginx），把 `https://relay.example.com` 交给参与者。
- relay 只在内存里保存每个房间最近 1000 条消息；重启后历史清空，客户端会自动从头同步。
- 每个房间第一次出现的访问口令会成为该房间的口令，之后口令不对的请求返回 403。

### 2. 让同一个群联网

两端都打开同一个群（可以各自新建本地群，也可以由一方先建好再把 relay 信息发给对方），点群标题右侧的「联网」按钮，填写：

| 字段 | 例子 | 说明 |
| --- | --- | --- |
| Relay 地址 | `https://relay.example.com` | relay 的根地址，可带子路径 |
| 房间号 | `team-alpha` | 字母/数字/下划线/连字符，1–64 位 |
| 访问口令 | `correct horse battery staple` | 所有参与者共享；不要发在公开群 |

连接成功后：

- 你在群里发的消息会同时写到 relay；对方群里会以「远程」消息出现。
- 对方发来的消息会进入你的群，并按 `@名字` 规则唤醒本地 Agent。
- 每端只有自己的 Agent 是本地的，远程 Agent 不会直接调用你的工具；它们通过各自的 DSH 实例发言。
- 断线后 Host 每 3 秒重连；`room.network.error` 会在页面标题旁显示。

### 3. 新建群时直接联网

「新建群聊」对话框底部勾选「通过 Relay 加入远程群聊」，填好三项后创建，群建好后会自动连接。

## 数据与安全

- 数据存在 `$DSH_HOME/agentcomm/store.json`（可用 row config 的 `dataDir` 覆盖），写入是临时文件 + rename 的原子替换。
- 访问口令保存在本机 store 里，不会下发到浏览器；`/state` 只返回 `relayUrl`、`roomCode`、连接状态和错误。
- Web 页面通过同源 `/agentcomm/api` + `/agentcomm/events`（SSE）访问 Host；POST 会校验 `Origin` 与 `Host` 一致。
- relay 目前转发**明文**消息信封；它只应按房间转发，不做内容解析。需要抗 relay 运营方窥探时，下一阶段可在信封里加房间密钥加密（见「后续」）。
- Agent 的回复不是自动转发：Agent 必须显式调用 `agent_im`，这样群聊里只会出现它想公开说的话。

## 结构

| 文件 | 作用 |
| --- | --- |
| `package.json` | bundle 清单：`dsh.bundle.patch` + `dsh.client` |
| `cordis.patch.yml` | 插入 `agentcomm` 一行，配置 `dataDir` / `maxStreak` |
| `index.js` | Host 半边：存储、房间、成员、投递、`agent_im` 工具、system prompt、HTTP/SSE、relay 连接 |
| `client.js` | 浏览器半边：侧栏图标、三栏群聊页面、联网对话框 |
| `relay/server.mjs` | 零依赖 relay：房间口令、长轮询、内存历史 |
| `tests/network-smoke.mjs` | 端到端冒烟测试：relay → 插件、插件 → relay |
| `locale/{en,zh}.json` | Plugin Manager 里的标题与描述 |
| `icon.svg` | 插件图标 |

## 已知限制（0.2）

- 只能拉当前进程里在线的 Agent；离线会话不会收到消息。
- 远程成员没有在线状态/成员列表，只以消息发送者出现。
- 没有私聊、好友、未读红点、图片/文件、消息引用、撤回。
- relay 无持久化、无 TLS、无消息签名；公网部署请套 HTTPS 反代，并把它当作可信的群内中转。
- 群聊页面没有虚拟滚动；单群 2000 条消息上限，超出后从最旧的开始丢。

## 后续

- 每个 DSH 生成 ed25519 身份，信封带签名，relay 可验证发送者。
- 房间口令经 scrypt 派生 AES-256-GCM 密钥，`text` 以密文传输，relay 只看路由字段。
- 远程成员 presence、@ 远程成员自动补全、群邀请码（relay + 房间号 + 口令打包）。
- WebSocket 传输与断线补发（当前用长轮询 + `seq` 去重）。

/**
 * 聊天记录那一层（第十六刀：从 `src\core.mjs` 搬出来的）。
 *
 * 六件事：把 mineflayer 的聊天/系统消息接到实例事件上（`wireChatEvents`）、
 * 消息转纯文本（`plainText`）、认出"玩家在说话"（`playerChatFrom`）、
 * 一条聊天进账（`emitPlayerChat`）、记进 `chat` 环形数组（`pushChat`）、
 * 自己往公屏说话（`chatSay`）。
 *
 * 规矩：
 *   · **这一层是有状态的**（`self.chat` 环形数组、`self.stats.chats`、`self._lastChatKey` 去重键、
 *     `self.emit()` 事件）—— 和第十五刀那种"纯动作 + ctx"不一样：这里第一参数**直接收 `self`**
 *     （迁移规矩第 20 条：无状态/只读层走 `ctx`，有可变实例状态的层直接收 `self`，
 *     否则要写一堆 getter/setter，只会更难读）；
 *   · 不 import `core.mjs`（反向依赖），也不 import 任何游戏库 —— 这一层只认
 *     `{ on, _client, username }` 这么几个字段，自检用假 bot 就能走同一条路。
 */
/**
 * 把 mineflayer 的聊天/系统消息接到本实例的 `chat` / `system` 事件上。
 *
 * 🔴🔴 2026-09-16 真机事故（用户："喊我不应，只能 tp 我"）：
 *    以前只有 `_client.on('player_chat')`（**签名**聊天包）才 `emit('chat')`，
 *    而 `bot.on('message')`（`system_chat`，**未签名**聊天）被一律当成 system 丢掉。
 *    对**局域网开放的世界 / 离线服 / 1.19+ 关掉签名聊天**的服务器，玩家说话走的正是
 *    `system_chat` → `player_chat` 永不触发 → 看门狗的 mention / nearbySpeech **全哑**，
 *    只剩 damage / death / teleport 能用（`stats.chats === 0`、看门狗日志里一条 chat 都没有）。
 *
 * 现在按 mineflayer 的约定分流（`lib/plugins/chat.js` 里两种包的 emit 签名）：
 *    · `position === 'chat'`  → 来自 playerChat（签名）→ 由下面的 `player_chat` handler 处理，
 *      这里**直接跳过**（否则同一条进两遍）
 *    · `position === undefined`→ 来自 systemChat 的 **positionId 0 = 聊天**（未签名）
 *    · `position === 'system'` → 来自 systemChat 的 **positionId 1**：**也要按"内容"再判一次**
 *      —— 有的服务端（LAN 开放世界 / 某些插件）把玩家聊天塞进 system 位置，渲染出来仍是
 *      `<名字> 正文`。实验体 2026-09-16 的证据就是这样：事件队列里全是 `kind: system`、
 *      文本形如 `<<user>> tp我，ds。`，而看门狗只对 `chat` 判定 ⇒ mention 永远打不中。
 *    · `position === 'game_info'`（动作栏）→ 一律 system（动作栏刷屏不该唤醒）
 *    · 其余 → 系统消息
 *
 * ⚠️ 这是**公开方法**（不放在 connect 里内联）：自检要能用假 bot 走同一条代码路径 ——
 *    "喊我能不能醒"这种链路，断言必须落在真实实现上，不能只 grep 源码。
 * @param {object} b mineflayer bot（`on` + `_client`）
 */
export function wireChatEvents (self, b) {
  b.on('message', (msg, position) => {
    const text = plainText(msg)
    if (position === 'chat') return                    // 签名聊天：player_chat 那条路已处理
    if (position !== 'game_info') {                    // 动作栏除外，其余都按内容再判一次
      const parsed = playerChatFrom(msg, text)
      if (parsed) {
        emitPlayerChat(self, parsed.who, parsed.text, b.username)
        return
      }
    }
    pushChat(self, 'system', null, text)
    self.emit('system', { text })
  })
  b._client?.on?.('player_chat', (p) => {
    const who = playerNameOf(b, p)
    const text = p?.plainMessage ?? ''
    emitPlayerChat(self, who, text, b.username)
  })
  return b
}

/**
 * 签名聊天包（`player_chat`）里的发送者名字。
 *
 * 🔴 2026-10-21 真机：局域网开放的世界里 `networkName` 是**空的**，于是记忆里的聊天记录
 *    整片写成 `<?> 测试` —— 说话人丢了，事后翻记录分不清谁说的。顺序：
 *    ① `networkName`（新版是 `{ value }`，老版可能直接是字符串）
 *    ② 拿 `senderUuid` 去 `bot.players` 里反查用户名（uuid 忽略大小写与连字符）
 *    ③ 都没有才退回 `'?'`
 * @param {object} b mineflayer bot（要 `players`）
 * @param {object} p player_chat 包
 */
export function playerNameOf (b, p) {
  const direct = p?.networkName?.value ?? p?.networkName
  if (direct) return String(direct)
  const want = String(p?.senderUuid ?? '').replace(/-/g, '').toLowerCase()
  if (want) {
    for (const [name, pl] of Object.entries(b?.players ?? {})) {
      const id = String(pl?.uuid ?? '').replace(/-/g, '').toLowerCase()
      if (id && id === want) return String(name)
    }
  }
  return '?'
}
export function plainText (msg) {
  try { return msg.toString().replace(/§./g, '') } catch { return String(msg) }
}

/**
 * 一条"玩家说话"进账（**唯一入口**：签名聊天与未签名聊天都走这里）。
 * 自带 1.5 秒去重：同一句同一人在极短时间内从两条路各来一次（理论上不会）也只发一次。
 */
export function emitPlayerChat (self, who, text, selfName) {
  const w = String(who ?? '?')
  const t = String(text ?? '')
  if (!t) return
  const key = `${w}\u0000${t}`
  const now = Date.now()
  if (self._lastChatKey === key && now - (self._lastChatAt ?? 0) < 1500) return
  /* 🔴 省 token：自己说的话服务端会**回显**一遍 —— `chatSay` 先记一条 `self`，回显又记一条 `player`，
   *    内容一字不差（`mc_status` 的 recentChat / `mc_events` 里就出现两条一模一样的）。
   *    自己的话只留 `self` 那条；别人说的话照旧记 `player`。 */
  /* 🔴 2026-10-21 实测（用户「看门狗收不到我说话」追查出来的）：未签名聊天（LAN 开放世界）里
   *    说话人名字经常解析不出来，`who` 会变成 `'?'` —— 于是**自己说的话回显**也被当成「别人说话」，
   *    看门狗的 anyChat 立刻叫醒 AI，AI 看到的是一个没有正文的空轮（自己那句话又触发自己）。
   *    所以名字是 `selfName` **或解析不出来**时，都按「可能是自己的回显」比对最近一条 self。 */
  const anonymous = w === '?' || w === '' || w === 'unknown'
  if (w === selfName || anonymous) {
    const last = self.chat[self.chat.length - 1]
    if (last?.kind === 'self' && last.text === t && now - last.at < 5000) return
  }
  /* 🔴 2026-10-21 实机回归：名字解析不出来时**不能把事件丢掉** —— 这个 LAN 服上用户说的每句话
   *    `who` 都是 `'?'`，早先那句「匿名就不往外发」把所有真人消息都吞了，看门狗一次都没响。
   *    正确做法：先排除"自己的回显"（上面那步），剩下的匿名消息就是**真人在说话**，照常发事件；
   *    名字能猜就猜（只有一个别的玩家在线时就是他），猜不到就留 `?`。 */
  let who2 = w
  if (anonymous) {
    try {
      const b = self.requireBot({ allowDead: true })
      const others = Object.keys(b?.players ?? {}).filter((n) => n !== selfName)
      who2 = others.length === 1 ? others[0] : '?'
    } catch { who2 = '?' }
  }
  self._lastChatKey = key
  self._lastChatAt = now
  pushChat(self, 'player', who2, t)
  self.stats.chats++
  self.stats.lastEventAt = now
  if (who2 !== selfName) self.emit('chat', { who: who2, text: t })
}

/**
 * 从 `bot.on('message')` 收到的消息里**认出"玩家聊天"**（未签名聊天：LAN 开放世界 / 离线服 / 1.19+）。
 *
 * 判据按 translate 键（服务端给的聊天类型），只认这几种"有人在说话"的：
 *    · `chat.type.text`                    —— 普通公屏（渲染成 `<名字> 正文`）
 *    · `chat.type.team.text` / `.team.*`    —— 队伍聊天（with = [队伍, 发送者, 正文]）
 *    · `commands.message.display.incoming` —— 别人私聊我（with = [发送者, 正文]）
 * ④ 兜底看**渲染出来的形状**：`<名字> 正文`。
 *    🔴 这条是从实验体的证据里补的（2026-09-16）：有的服务端把玩家聊天发在 **system 位置**
 *    （positionId 1），translate 也可能是它自己那套；但渲染出来就是 `<<user>> tp我，ds。`。
 *    只按 positionId / translate 判的话，这类消息会永远停在 system 桶里，mention 一辈子打不中。
 *    宁可偶尔把"看起来像聊天的系统消息"算成聊天（最多多醒一次），也不能漏掉真人喊话。
 * @returns {{who:string, text:string}|null}
 */
export function playerChatFrom (msg, plain) {
  const t = String(msg?.translate ?? '')
  const withParts = Array.isArray(msg?.with) ? msg.with : []
  const partText = (p) => {
    if (p === null || p === undefined) return ''
    if (typeof p === 'string') return p
    if (typeof p.text === 'string') return p.text
    try { return String(p) } catch { return '' }
  }

  // ① 队伍聊天：who 取**发送者**（with[1]），不是队伍名
  if (/^chat\.type\.team\./.test(t)) {
    const who = partText(withParts[1] ?? withParts[0])
    const body = partText(withParts[withParts.length - 1])
    if (body) return { who: who || '?', text: body }
  }
  // ② 普通公屏
  if (t === 'chat.type.text') {
    const who = partText(withParts[0])
    const body = partText(withParts[1] ?? withParts[withParts.length - 1])
    if (body) return { who: who || '?', text: body }
  }
  // ③ 私聊（/tell、/msg）
  if (t === 'commands.message.display.incoming') {
    const who = partText(withParts[0])
    const body = partText(withParts[1] ?? withParts[withParts.length - 1])
    if (body) return { who: who || '?', text: body }
  }
  // ④ 兜底：渲染出来就是 `<名字> 正文` 的形状（有些服务端用自定义 chat type，translate 不认识）
  const m = /^\s*<([^<>]{1,32})>\s*(.+)$/s.exec(String(plain ?? ''))
  if (m) return { who: m[1].trim(), text: m[2] }
  return null
}

export function pushChat (self, kind, who, text) {
  const entry = { at: Date.now(), kind, who, text }
  self.chat.push(entry)
  if (self.chat.length > self.cfg.chatHistory) self.chat.splice(0, self.chat.length - self.cfg.chatHistory)
  /* 🔴 记忆里的聊天记录（用户 2026-10-20）：这里是**所有**聊天行的唯一入口（玩家 / 我自己 / 系统），
   *    钩子挂在这儿最省事。筛哪几条由钩子负责（只留 player / self）；没人挂、钩子里抛异常，
   *    都只当没这回事 —— 记不进记忆是小事，把聊天搞挂是大事。 */
  try { self.onChatLine?.(entry) } catch { /* 记不上不能把聊天搞挂 */ }
}

export function chatSay (self, text) {
  const b = self.requireBot({ allowDead: true })
  const t = String(text).replace(/[\r\n]+/g, ' ').slice(0, 220)
  /* 🔴 2026-10-08 审计：mineflayer 的 `bot.chat('/…')` 会当成**指令**发出去（走 `chat_command` 包），
   *    于是 `mc_say` 能绕过 `mc_command` 的指令白名单 —— 白名单就白设了。
   *    要执行指令一律走 mc_command（那道闸门在），别从公屏绕。 */
  if (t.startsWith('/')) {
    throw new Error('要说的话不能以 `/` 开头 —— 那样会被服务端当成**指令**执行，等于绕过指令白名单。'
      + '要执行指令请用 mc_command（只有白名单里的能用）；真想喊出斜杠就写全角 "／"')
  }
  b.chat(t)
  pushChat(self, 'self', b.username, t)
  return t
}

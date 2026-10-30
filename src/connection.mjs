/* ============================================================================
 * 连接层（路线图第 ④ 条第三十一刀从 `core.mjs` 搬出来）
 * ----------------------------------------------------------------------------
 * 这一层负责"进服 / 掉线自动重连 / 下线"三件事：`connect()` / `scheduleReconnect()` /
 * `disconnect()`。它是 `McBot` 里唯一直接 `mineflayer.createBot()` 的地方。
 *
 * **形状**：三个函数第一参数都收 `self`（这一层要读写一大堆实例状态：`bot` / `online` /
 * `connecting` / `autoReconnect` / `reconnecting` / `reconnectPending` / `_connectOpts` /
 * `_connectionProfile` / `_reconnectTries` / `lastError` / `stats` / `tasks` / `cfg` …），
 * 迁到模块里只是把 `this.` 换成 `self.`。
 *
 * **`ctx` 里放三样"模块不该知道"的东西**（迁移规矩第 17 / 24 / 28 条）：
 *   · `ctx.defaults`  —— `core.mjs` 里的 `DEFAULTS` 表（不反向 import core，所以递进来）
 *   · `ctx.reportError` —— 私有 `#reportError`（"统一上报口"，见下面那段注释）
 *   · `ctx.auth.{sessionFlags, friendlyAuthError, takeAuthJoinError}` —— core 里的认证助手
 * `makeSession()` 例外：它第一参数就是 `self`，直接 import 就行（`connection → auth-session` 不成环）。
 *
 * ⚠️ 三个必须守住的老结论（每一条都是真机炸出来的）：
 *   ① `auth()` 回调里 `options.connect(client)` 返回的 promise **必须接住 rejection** ——
 *      皮肤站令牌失效会从那里冒出来，不接住就是"未处理拒绝"→ 宿主 fail-loud `exit(1)`（2026-09-17）。
 *   ② 只有皮肤站才 `haveCredentials=true`（`sessionFlags`）—— 离线账户拿假 token 去 sessionserver
 *      必然 `ForbiddenOperationException`（同一次事故）。
 *   ③ 断线要**主动播报** `offline` 事件（AI 与前端都得马上知道），并且重连要用 `_connectOpts`
 *      里记下的**真参数**、试满 `maxReconnectAttempts` 就放弃（2026-10-08 审计 F1）。
 */

import { ensureDepGuard, isLandmineError, describeDepGuard } from './dep-guard.mjs'
import { sleep } from './async-util.mjs'
import { patchBlockAt } from './vec-arg.mjs'
import { dashUuid } from './accounts.mjs'
import { makeSession } from './auth-session.mjs'

/**
 * 拿 mineflayer 入口 —— **懒加载**，而且第一次失败时先修依赖树再重试一次。
 *
 * 🔴 为什么不能静态 `import mineflayer from 'mineflayer'`（2026-10-20，issue #2）：
 *    `mineflayer → minecraft-protocol → readable-stream@4` 里有一行
 *    `require('string_decoder')`（尾斜杠）。DSH 的 profile 解析器对内置名会
 *    `resolve.paths()` 拿到 null 再 for-of，抛 `TypeError: createRequire.resolve.paths
 *    is not a function or its return value is not iterable`，于是**整个插件 import 失败**、
 *    那一项直接 inactive。静态 import 发生在模块求值期，我们没有任何机会先修；
 *    改成动态 import 之后就能"撞上了 → 就地修 → 重试"。
 *    （详见 `src/dep-guard.mjs` 与踩坑档案 #224。）
 */
let mineflayerCache = null

/**
 * @param {Function|null} log 可选，修依赖时会说一句
 * @returns {Promise<Object>} mineflayer 模块（默认导出，兼容 `module.exports = …` 形状）
 */
export async function ensureMineflayer (log = null) {
  if (mineflayerCache) return mineflayerCache
  const load = async () => {
    const mod = await import('mineflayer')
    return mod?.default ?? mod
  }
  try {
    mineflayerCache = await load()
  } catch (err) {
    if (!isLandmineError(err)) throw err
    const off = String(process.env.DSH_MC_AGENT_DEP_GUARD ?? '').toLowerCase() === 'off'
    const report = ensureDepGuard({ log, patch: !off })
    if (typeof log === 'function') {
      try { log('mineflayer 加载撞上「尾斜杠内置名」：' + describeDepGuard(report)) } catch {}
    }
    if (off || !report.patched) throw err
    mineflayerCache = await load()
  }
  return mineflayerCache
}


/**
 * 连接到 MC 服务器。
 *
 * 🔴 用户 2026-09-16：**凭据不再从这里传**（LLM 不得接触密码/token）。
 *    插件层先把账户解析成一个 `auth` 描述符，再交给这里：
 *      · `{ mode:'offline',   name, uuid? }`                     —— 离线（uuid 空则按名字派生）
 *      · `{ mode:'yggdrasil', authUrl, authUser, authPass?, accessToken?, clientToken? }` —— 皮肤站
 *
 * @param {Object} opts
 * @param {string} [opts.host] / [opts.port] / [opts.subserver]
 * @param {string|false} [opts.version] - 协议版本（默认 false=自动探测）
 * @param {Object} [opts.auth] - 上面的账户描述符（**唯一**的凭据入口）
 */
export async function connect (self, opts = {}, ctx = {}) {
  const defaults = ctx.defaults ?? {}
  /* 🔴 2026-10-08 审计报告 F1：`#scheduleReconnect(sub)` 以前把**子服名字符串**当 opts 传进来，
   *    而下面读的是 `opts.host` / `opts.auth` ⇒ 每次自动重连都必抛"缺少登录账户…"，
   *    再被 catch 无限重试。这里兜一层老写法（`connect('lobby')` = 只指定子服）。 */
  if (typeof opts === 'string') opts = { subserver: opts }
  /* 🔴 报告 H10（2026-10-13）：`self.stopped` 只在 `disconnect()` 里置真、只在 `core.mjs` 的
   *    `McBot` 构造函数里置假 ⇒ 手动下线一次之后 `scheduleReconnect()` 开头的守卫永久拦住
   *    自动重连，连"掉线自动回来"也没了。显式连一次就是"我还想在线"，在这里清零。
   *    （2026-10-15 审计：这里原来写的是死行号 `:297` / `:230`，早就漂了 —— 改成按符号引用。） */
  self.stopped = false
  const host    = opts.host      || self.cfg.host      || defaults.host
  const port    = Number(opts.port ?? self.cfg.port ?? defaults.port)
  const sub     = opts.subserver || self.cfg.subserver || defaults.subserver || ''
  const version = opts.version   ?? false
  const auth    = opts.auth ?? null
  const force   = Boolean(opts.force)

  if (!host) {
    throw new Error('缺少服务器地址：需要 host（通过 mc_connect 的 host 参数或 MC_HOST 环境变量提供）')
  }
  if (!auth?.mode) {
    throw new Error('缺少登录账户：先用 mc_accounts{action:"use", innerID:"..."} 选一个账户，'
      + '或在 mc_connect 里用 account 参数指名（账户在「MC设置」里维护）')
  }

  /* 🔴 2026-10-15 审计（报告 B 第 2 条）：`_connectionProfile` / `_connectOpts` 原来写在**早退之前**
   *    ⇒ 一次"已经连着"的空操作也会把它们改掉，而早退条件只比 host+sub（不比 port/version/账户）
   *    ⇒ 拿同一个 host 换账户（或换端口）再 mc_connect 会**静默什么都不做**，还谎报新账户/新地址。
   *    现在：① 早退条件把 port/version/账户一起比；② 两个记录都挪到确定要连之后。 */
  const authKeyOf = (a) => (a ? String(a.innerID ?? a.id ?? `${a.mode ?? ''}:${a.label ?? a.name ?? ''}`) : '')
  const liveOpts = self._connectOpts
  const sameAsLive = Boolean(
    self.online && self.sub === sub && self._lastHost === host &&
    Number(liveOpts?.port ?? NaN) === port &&
    (liveOpts?.version ?? false) === version &&
    authKeyOf(liveOpts?.auth) === authKeyOf(auth)
  )
  if (!force && sameAsLive) return self.bot
  if (self.connecting) { await self.connecting.catch(() => {}); if (self.online) return self.bot }

  // 记录当前生效的连接参数（给 mc_status 用，**不含任何凭据**）
  self._connectionProfile = {
    host, port, subserver: sub, version,
    authMode: auth.mode,
    account: auth.label ?? auth.name ?? null,
  }
  /* 🔴 审计报告 F1：自动重连要用的**真**参数（含 auth 对象）。只存内存、绝不出现在任何工具返回里
   *    （`_connectionProfile` 才是给外部看的脱敏版）。 */
  self._connectOpts = { host, port, subserver: sub, version, auth }

  /* 🔴 已经连着时 `mc_connect` 是**空操作**（下面那行 return）—— 所以以前"重连一下"
   * 根本不会重连，客户端的区块缓存 / 实体视图还是旧的（实机表现：挖着挖着就说"那里本来就是空气"）。
   * `force:true` 才是真重连：先断开旧连接、让服务端放掉会话，再连一次（世界与实体全部重收）。
   */
  if (force && self.bot) {
    const old = self.bot
    self.log('强制重连：先断开旧连接')
    self.autoReconnect = false          // 别让旧连接的 end 事件又触发一次自动重连
    try { old.quit() } catch { /* 已经断了就算了 */ }
    self.bot = null
    self.reconnecting = false
    self.reconnectPending = false
    await sleep(600)                    // 服务端放掉旧会话要几秒，太急会被"已连接"顶号
  }

  const attemptOnce = async (attempt) => {
    // 账户 → session（离线自己造；皮肤站 token 优先刷新）。凭据只在这一层出现。
    const session = await makeSession(self, auth)
    // 让插件层有机会把新令牌/档案信息回写到凭据库（回调收到的是含密钥的 session，**只给插件层**）
    try { if (typeof opts.onAuth === 'function') opts.onAuth({ mode: auth.mode, profile: session.selectedProfile, session }) } catch (e) { self.log('onAuth 回调出错：' + e.message) }
    const profile = session.selectedProfile
    const uuid = dashUuid(profile.id) ?? profile.id
    const previous = self.bot

    const mineflayer = await ensureMineflayer(typeof self.log === 'function' ? (m) => { try { self.log(m) } catch {} } : null)
    const b = mineflayer.createBot({
      host,
      port,
      username: profile.name,
      fakeHost: sub || undefined,           // Velocity 按 forced-host 路由子服；空串不传
      // 皮肤站才需要 sessionServer；离线自己造 session，不碰认证服
      ...(auth.mode === 'yggdrasil' ? { sessionServer: `${auth.authUrl}/sessionserver` } : {}),
      accessToken: session.accessToken,
      version,                              // false = 自动探测
      /* 重生由 AI 自己决定（2026-10-29，用户：「改成由 ai 选择重生，现在 ai 反应不过来」）。
       * mineflayer 的 `lib/loader.js:75` 默认 `options.respawn = options.respawn ?? true`，即“血一没就自动重生”。
       * 自动重生太快：人还没醒就被送回出生点，之前的目标全作废，只能报“走不动/太远”。
       * 现在死了就停在死亡界面（只能说话/看东西），由模型叫 `mc_act { mode: "respawn" }` 决定什么时候重生。 */
      respawn: false,
      auth: (client, options) => {
        client.session = session
        client.uuid = uuid
        client.username = profile.name
        client.emit('session', session)
        // 🔴 只有**真凭据**（皮肤站 / 微软正版）才 haveCredentials=true；离线账户必须 false，
        //    否则 encrypt.js 会拿假 token 去 sessionserver 做 session join → ForbiddenOperationException
        //    → 悬空拒绝 → 宿主 fail-loud exit(1)（2026-09-17 真炸过，见 .agent-docs）
        const flags = ctx.auth.sessionFlags(auth.mode)
        options.haveCredentials = flags.haveCredentials
        if (flags.useAccessToken) {
          options.accessToken = session.accessToken
          options.session = session
        }
        /* 正版账户在 1.19+ 上要**聊天签名**：`msa.mjs` 顺手把证书捞回来挂在 session 上，
         * 上游的 `microsoftAuth.js` 是 `Object.assign(client, certificates)` —— 同一套做法。
         * 拿不到证书也能连（只是这条会话不能签聊天），所以吞掉任何形状问题。 */
        if (session.certificates) { try { Object.assign(client, session.certificates) } catch { /* 拿不到签名能力而已 */ } }
        // ⚠️ 必须显式调用；而且**必须接住它的 rejection**：
        //    皮肤站的 session join 失败（令牌失效）会从这里冒出来，
        //    不接住就是"未处理的 Promise 拒绝"→ 宿主的 fail-loud 直接 exit(1)（2026-09-17 真炸过）。
        const p = options.connect(client)
        if (p && typeof p.catch === 'function') {
          p.catch((e) => {
            const err = ctx.auth.friendlyAuthError(e)
            self.autoReconnect = false            // 认证失败重连多少次都一样，别刷屏
            // 🔴 走统一上报口：老写法是 `self.emit('error', err)` 包在 try/catch 里 ——
            //    **emit 无监听者时自己就 throw，try/catch 拦不住同一次 emit 抛出的异常**
            //    （2026-09-17 那次"未处理拒绝把 DSH 干掉"是同一族，这里再堵死一遍）。
            ctx.reportError?.(err)
          })
        }
      },
    })
    b._createdAt = Date.now()
    patchBlockAt(b)

    let dupe = false
    b.on('error', (e) => { ctx.reportError?.(e) })
    b.on('kicked', (r) => {
      const text = typeof r === 'string' ? r : JSON.stringify(r)
      self.lastError = `被踢: ${text.slice(0, 300)}`
      // 「已连接」类顶号错误短时间重试（服务器放掉旧会话要几秒）
      if (/already connected|already logged/i.test(text) && Date.now() - b._createdAt < 9000) dupe = true
      else self.autoReconnect = false
      self.log(self.lastError)
    })
    b.on('end', (r) => {
      const why = self.lastError ?? '连接结束'
      // 🔴 2026-09-19：断线必须**主动播报**（AI 与前端都要马上知道），不能等下一次工具调用才发现。
      //    以前这里只写日志：于是"被踢之后 mc_status 还说在线、看门狗还挂着、AI 以为还在游戏里"。
      const willReconnect = Boolean(self.autoReconnect && self.bot === b && !self.stopped)
      // 主动下线时不再打这行：`disconnect()` 会打 `已下线：…`，原来两行成对、纯重复（2026-10-06）
      if (!self.stopped) self.log('连接结束', r ?? '')
      // 「断线期」标记：一直置到**真重连成功**为止。
      // why：`reconnecting` 只在"两次尝试之间的等待窗口"为真，一旦开始尝试连接（最长 45s）它就变 false——
      //      只看它的话，状态条在那 45 秒里会从"重连中…"退回"未上线"，看着像插件放弃了。
      if (willReconnect) self.reconnectPending = true
      /* 路线图第 ⑥ 条：断线时把在跑的任务标成"暂停（断线了）"。
       * 别让它一直是 `running` —— 那会让 AI 以为活儿还在推进；也别标成失败，
       * 因为**服务端不知道客户端断过线**，断线前那一轮的动作可能已经生效。 */
      try {
        const t = self.tasks?.current?.()
        if (t && !['done', 'cancelled', 'paused'].includes(t.status)) {
          self.tasks.pause(t.taskId, willReconnect ? '断线了（等重连）' : '断线了（没在自动重连）')
        }
      } catch { /* 记不上不影响断线处理 */ }
      /* 统一动作调度器（阶段 P0）：连接断了，**上一个连接留下的"谁在占什么"全不作数了**。
       * 不清的话，重连后 `mc_diag` 会显示一堆早就结束的动作还占着 movement / interaction，
       * 等 P1 真的开始拦人时就会变成"重连之后什么都动不了"。 */
      try { self.actionScheduler?.().releaseAll?.('断线了') } catch { /* 清不掉不影响断线处理 */ }
      clearSilenceWatch(self)
      self.emit('offline', { sub, reason: why, willReconnect, at: Date.now() })
      if (willReconnect) scheduleReconnect(self, sub, ctx)
    })
    b.on('death', () => {
      self.stats.deaths++
      /* 死在哪、死了几次要能回溯（掉落物 5 分钟后消失）。 */
      self._life = { at: Date.now(), position: self.position, deaths: self.stats.deaths }
      self.emit('death', { position: self.position })
    })
    b.on('respawn', () => {
      self._life = { ...(self._life ?? {}), respawnAt: Date.now(), respawnPosition: self.position }
    })
    b.on('health', () => {
      if (b.health !== undefined && b.health <= 6) self.emit('damage', { health: b.health, position: self.position })
    })
    self.wireChatEvents(b)

    try {
      await new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error(`连接 ${sub} 超时`)), self.cfg.connectTimeoutMs)
        b.once('spawn', () => { clearTimeout(t); resolve() })
        b.once('kicked', (r) => { clearTimeout(t); reject(new Error(`被踢: ${String(r).slice(0, 200)}`)) })
      })
    } catch (e) {
      try { b.quit() } catch {}
      if (dupe && attempt < 4) {
        self.log(`顶号冲突，3.5s 后重试（第 ${attempt} 次）`)
        await sleep(3500)
        return attemptOnce(attempt + 1)
      }
      if (previous?.entity) { self.bot = previous; self.log('新连接失败，保留原有连接') }
      // 认证/入服失败（令牌失效等）：转成"需要用户处理"的明确错误；
      // 顺便把 yggdrasil 兼容层记下的那个 session-join 失败也捞出来当原因。
      const joinErr = ctx.auth.takeAuthJoinError()
      throw ctx.auth.friendlyAuthError(joinErr ?? e)
    }

    if (previous && previous !== b) { try { previous.quit() } catch {} }
    self.bot = b
    self.sub = sub
    /* 包静默监控（见 PACKET_STALE_MS 的注释）：记"最后一个包什么时候到的"，
     * 并由看门狗在假死时主动断开重连。 */
    b._lastPacketAt = Date.now()
    try { b._client?.on?.('packet', () => { b._lastPacketAt = Date.now() }) } catch {}
    startSilenceWatch(self, b)

    self._lastHost = host          // ⚠️ 必须记：否则上面的"已连着就直接返回"永不生效，
                                   //    重复 mc_connect 会真去重连（先把自己踢下线再登回来）
    self.connectedAt = Date.now()
    self.stats.connects++
    self.autoReconnect = true
    self.reconnectPending = false      // 进来了就算"断线期"结束（手动 mc_connect 也算）
    self.reconnecting = false          // 🔴 审计 B7：手动进服也算"不在重连中"，否则状态条一直说"正在自动重连"
    self._reconnectTries = 0           // F1：连上了就把重试计数清零
    self.reconnectDelay = 5000         // 🔴 审计 B6：手动进服也要把退避延迟复位（以前只在重连成功分支复位）
    self.lastError = null              // 🔴 审计 B4：`lastError` 跨连接残留 ⇒ 下次断线播报的是**上一次**的错误
    self.startObserver()
    // 现成的生态插件（pathfinder / collectBlock / tool / pvp / autoEat）：挂上就能用，缺哪个都不影响其它
    await self.setupPlugins().catch((e) => self.log('现成插件初始化异常：' + e.message))
    self.writeLock()
    self.log(`已进入 ${sub || '主服'} @ (${self.position?.x},${self.position?.y},${self.position?.z}) gamemode=${b.game?.gameMode}`)
    self.emit('spawn', { sub, position: self.position, gamemode: b.game?.gameMode })
    return b
  }

  self.connecting = attemptOnce(1)
  // 🔴 再挂一个 catch：调用方可能被 abort/取消而不再 await 这个 promise，
  //    那样它的 rejection 就成了"未处理拒绝"→ 宿主 fail-loud 直接 exit(1)。
  self.connecting.catch(() => {})
  try { return await self.connecting } finally { self.connecting = null }
}

/* 🔴 2026-10-23 实机（用户："也是完全卡住，我tp也不行，最后重开才好" / "是它重进游戏"）：
 *    这就是**连接假死** —— socket 看着还在，服务端其实已经不回包了：
 *      · `b.dig()` 等 `blockUpdate` 永远等不到（vendor 只在包回来时才 settle）⇒ 动作永挂；
 *      · 位置不再更新 ⇒ 每个动作都"在跑"，实际什么也没发生；
 *      · 连 `tp` 都发不出去 ⇒ 用户看着像插件整个死了，只能重进游戏。
 *    唯一可靠的信号是"多久没收到任何一个包"。正常游戏里服务端每秒都在发包（keep_alive /
 *    time_update / entity…），40 秒全静默必然是死了。 */
export const PACKET_STALE_MS = 40_000
export const SILENCE_CHECK_MS = 5_000

/** 距离"最后一个进来的包"过去多少毫秒；没开始记（旧连接/离线）返回 null。 */
export function packetSilenceMs (b) {
  const t = Number(b?._lastPacketAt)
  if (!Number.isFinite(t) || t <= 0) return null
  return Math.max(0, Date.now() - t)
}

/**
 * 连接是不是已经假死。返回 `null` = 正常（或无从判断）；否则给出"静默多久 + 该怎么办"。
 * 工具调用据此**立刻认输**，不陪着一起卡到预算上限。
 */
export function connectionStale (b, { staleMs = PACKET_STALE_MS } = {}) {
  const silent = packetSilenceMs(b)
  if (silent == null || silent < staleMs) return null
  const sec = Math.round(silent / 1000)
  return {
    silenceSec: sec,
    reason: 'connection-stale',
    hint: '服务端已经 ' + sec + ' 秒没回任何包 —— 连接假死，不是我走不动。先 mc_connect {force:true} 重连，再重试这个动作；别再原样重试（不会成功）。',
  }
}

/** 假死看门狗：静默到点就主动断开重连（假死没有 `end` 事件，autoReconnect 永远不会触发）。 */
export function startSilenceWatch (self, b, { everyMs = SILENCE_CHECK_MS } = {}) {
  clearSilenceWatch(self)
  if (typeof setInterval !== 'function') return
  self._silenceTimer = setInterval(() => {
    if (self.bot !== b || self.stopped) { clearSilenceWatch(self); return }
    const stale = connectionStale(b)
    if (!stale) return
    clearSilenceWatch(self)
    self.log(`🔌 连接假死：${stale.silenceSec} 秒没收到任何包 —— 主动断开，让自动重连接手`)
    self.lastError = `连接假死（${stale.silenceSec} 秒没收到包）`
    self.emit('silence', { silenceSec: stale.silenceSec, at: Date.now() })
    try { b.end?.() } catch { try { b.quit?.() } catch {} }
  }, Math.max(10, Number(everyMs) || SILENCE_CHECK_MS))
  try { self._silenceTimer?.unref?.() } catch {}
}

export function clearSilenceWatch (self) {
  if (self?._silenceTimer) { try { clearInterval(self._silenceTimer) } catch {} self._silenceTimer = null }
}

export function scheduleReconnect (self, sub, ctx = {}) {
  const defaults = ctx.defaults ?? {}
  if (self.reconnecting || self.stopped) return
  /* 🔴 2026-10-08 审计报告 F1 的两处硬伤：
   *   ① 参数错：以前 `await self.connect(sub)` 把子服名当 opts ⇒ 必抛"缺少登录账户"；
   *   ② 没有上限：catch 里 `reconnectDelay` 翻倍到 60s 后**再递归**，永远试下去。
   *    而看门狗会注入"插件正在自动重连，先别再操作角色，等重连结果" ⇒ AI 停手死等。
   *    现在：用真参数重连、记次数、试满就 emit `offline{willReconnect:false}`（看门狗会 disarm
   *    并通知 AI"你已不在 MC 里，用 mc_connect 重新进服"）。 */
  const o = self._connectOpts
  const max = Math.max(1, Number(self.cfg.maxReconnectAttempts ?? defaults.maxReconnectAttempts))
  if (!o?.auth?.mode) {
    self.reconnectPending = false
    self.log('不再自动重连：没有记下可用的登录参数')
    setImmediate(() => self.emit('offline', {
      sub, reason: '自动重连没有可用的登录参数（没记下 account/auth）', willReconnect: false, at: Date.now(),
    }))
    return
  }
  self.reconnecting = true
  const tries = (self._reconnectTries = Number(self._reconnectTries ?? 0) + 1)
  self.log(`断线，${self.reconnectDelay / 1000}s 后重连 ${sub || '主服'}（第 ${tries}/${max} 次）`)
  /* 🔴 2026-10-15 审计（报告 B 第 1 条）：这个定时器以前**没人管** ——
   *    `disconnect()`（手动下线）只置 `self.stopped = true`，既不 clearTimeout，回调开头也没有
   *    `if (self.stopped) return` 守卫；而 `connect()` 第一行就是 `self.stopped = false`
   *    ⇒ 排定的重连会把"用户刚让我下线"复活，机器人 5 秒后自己又回到服务器。
   *    现在：存进 `self._reconnectTimer`，`disconnect()` 里清掉，回调开头再守一道。 */
  self._reconnectTimer = setTimeout(async () => {
    self._reconnectTimer = null
    self.reconnecting = false
    if (self.stopped) { self.reconnectPending = false; return }   // 期间用户让下线了 ⇒ 不重连
    try {
      await connect(self, { ...o, subserver: sub || o.subserver }, ctx)
      self.reconnectDelay = 5000
      self._reconnectTries = 0
      // 真回来了才算"断线期"结束（前端/状态据此从"重连中…"切回"在游戏中"）
      self.reconnectPending = false
      self.emit('reconnect', { sub })
      /* 路线图第 ⑥ 条：重连回来**先复核，别重新规划**。
       * 断线期间那几秒里，上一轮的挖掘/走路可能已经生效了（服务端不知道客户端断过线）。
       * 把话写进任务里 + 记一行日志，让 AI 第一件事就是 `mc_task {action:"resume"}`。 */
      try {
        const t = self.tasks?.current?.()
        if (t && !['done', 'cancelled'].includes(t.status)) {
          self.tasks.note(t.taskId, '断线重连回来了：进度还在，先 mc_task {action:"resume"} 用背包复核一下再接着干（别从头重做）')
          self.log(`重连成功：任务 ${t.taskId} 还在（进度已落盘）—— 先 mc_task {action:"resume"} 复核`)
        }
      } catch { /* 记不上不影响重连本身 */ }
    } catch (e) {
      self.log('重连失败：' + e.message)
      self.reconnectDelay = Math.min(self.reconnectDelay * 2, 60_000)
      if (tries >= max) {
        self.reconnectPending = false
        self.log(`自动重连放弃（连续 ${tries} 次没连上）—— 让 AI 自己 mc_connect`)
        self.emit('offline', {
          sub, reason: `自动重连失败 ${tries} 次（${e.message}）`, willReconnect: false, at: Date.now(),
        })
        return
      }
      scheduleReconnect(self, sub, ctx)
    }
  }, self.reconnectDelay).unref?.()
}

/**
 * 下线。**先优雅退出，真走不掉才强断**（用户 2026-09-16 要求："一定要先尝试退出游戏"）。
 *
 *   ① 先关掉自动重连 / 世界观察器 —— 否则退服事件会把看门狗又吵醒
 *   ② `bot.quit(reason)` 发正常的断开包，给它 graceMs（默认 3s）自己走完
 *   ③ 还没走掉才 `_client.end()` 强断（兜底，不允许吊死）
 *
 * ⚠️ 宽限计时器**故意不 unref**：我们就是"在等"，unref 掉会让"只有它在跑"时进程直接退出。
 * @returns {Promise<{graceful:boolean, forced:boolean, ms:number}>}
 */
export async function disconnect (self, reason = '主动下线', { graceMs = 3000 } = {}) {
  const t0 = Date.now()
  self.stopped = true
  self.autoReconnect = false
  /* 🔴 审计 B1/B7：手动下线必须把**已排定的重连**一起取消，并把"断线期/重连中"两个标记清掉 ——
   *    否则 ① 5 秒后那个定时器把机器人自己拉回服务器（用户看到"我让它下线它又上来了"）；
   *    ② `mc_status` 在"已下线"之后一直说"正在自动重连"。 */
  if (self._reconnectTimer) { try { clearTimeout(self._reconnectTimer) } catch {} self._reconnectTimer = null }
  self.reconnectPending = false
  self.reconnecting = false
  self._reconnectTries = 0
  self.stopObserver()
  clearSilenceWatch(self)

  const b = self.bot
  let graceful = false
  let forced = false

  if (b) {
    // 等它自己走完（end / kicked 任一即算走掉；到点还没走就强断）
    let sawEnd = false
    let timer = null
    const settled = new Promise((resolve) => {
      let done = false
      const finish = (byEvent) => {
        if (done) return
        done = true
        if (byEvent) sawEnd = true
        if (timer) clearTimeout(timer)
        resolve()
      }
      try { b.once('end', () => finish(true)) } catch {}
      try { b.once('kicked', () => finish(true)) } catch {}
      timer = setTimeout(() => finish(false), graceMs)
    })
    try { b.quit(reason) } catch { /* quit 本身失败 → 直接进强断 */ }
    await settled
    graceful = sawEnd || self.bot !== b || !self.online
    if (!graceful) {
      try { b._client?.end?.(reason); forced = true } catch {}
    }
  }

  self.releaseLock()
  self.bot = null
  const ms = Date.now() - t0
  self.log(`已下线：${reason}（${graceful ? '优雅退出' : forced ? '强制断开' : '本来就没连接'}，${ms}ms）`)
  return { graceful, forced, ms }
}

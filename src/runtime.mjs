/**
 * 运行时管线（路线图第 ④ 条第三十三刀，第四十三刀又并进两个"跟 bot 打交道的小工具"）：
 * **超时闸门 / 错误上报口 / 抢占移动 / 停寻路 / 接 abort / 等区块 / 要一个在线 bot**。
 *
 * 这一层是"每次 await 都要过的关口"和"出事了先落到哪儿"——五件事本来就是一套：
 *   ① `reportError` 任何错误先进这里（记 `lastError` + 一行日志 + 只在真有监听者时才 emit，绝不 throw）；
 *   ② `withBudget` 所有直接打给 mineflayer 的 await 都过它（双重保险：本轮 abort signal + 本地 deadline）；
 *   ③ `stopPathing` 真停 pathfinder（`stop()` 只置标志，`setGoal(null)` 才走 resetPath）；
 *   ④ `interruptMove` 抢占"正在走的 / 正在挖着走的"（推进移动号 + 停采集 + 松控制位）；
 *   ⑤ `setAbortSignal` 把"用户点停止"接上 `interruptMove`；
 *   ⑥ `holdControl` / `releaseControls` 自保反射的控制位**租约**（第四十一刀并进来：
 *      "收尾时别把别人正按着的控制位抢松了"与 ③④ 本来就是同一件事）；
 *   ⑦ `waitForChunks` 等区块加载（算进本轮 11 秒，用完立刻返回 `false`）；
 *   ⑧ `requireBot` "给我一个一定在线的 bot，否则抛出带原因的错"（幽灵在线也认得出）。
 *
 * 形状（迁移规矩第 17 · 27 · 28 · 37 条）：这一层**读写全是实例状态** ⇒ 第一参数收 `self`；
 * `#cancelCollect` 是**私有**方法，模块里够不着 ⇒ 由 core 的薄包装包成箭头函数从 `ctx` 递进来。
 * 模块自己只 import `async-util.mjs` 与 `budget.mjs`，
 * 不 import `core.mjs`、不 import 游戏库。
 */
import { withTimeout, raceAbort, abortError, waitUntil } from './async-util.mjs'
import { TIMEOUTS, CALL_MS } from './budget.mjs'

/**
 * 🔴🔴 **唯一的错误上报口**（2026-09-18 P0：连一个不存在的服务器 → 整个 DSH 崩）。
 *
 * 事故现场（用户实测）：
 *   `Error: connect ECONNREFUSED 127.0.0.1:61631`
 *   `Emitted 'error' event on McBot instance at: core.mjs:671`
 *   `node:events:486  throw er; // Unhandled 'error' event`  ⇒ **进程直接死**
 *
 * 根因：`McBot extends EventEmitter`，而 **EventEmitter 的语义是"emit('error') 时若没有监听者就 throw"**。
 *   原来那行 `b.on('error', (e) => this.emit('error', e))` 把 bot 的网络错误转发到 McBot，
 *   而 McBot 通常**没有 'error' 监听者**（工具是 await 抛错返回、不订阅 error）
 *   ⇒ 一个"服务器没开"的普通错误把整个宿主带走。
 *   更早那处（认证阶段）虽然是 `try { this.emit('error', err) } catch {}`，
 *   但 **try/catch 对 emit 自抛无效**（它就是抛出来的那个异常）—— 假保护。
 *
 * 现在的规矩：**任何错误都先进这里**，它保证
 *   ① 记 `lastError`（工具层据此给出人话）；
 *   ② 记一行日志（能被 `mc_diag` / 日志看到）；
 *   ③ **只在真有监听者时才 emit**（数量用 `listenerCount` 判断）—— 没人听就到此为止，绝不 throw；
 *   ④ 自己再兜一层 try/catch（监听者回调里抛错也不该带走进程）。
 * @param {object} self - McBot 实例
 * @param {unknown} e - 原始错误（socket / 认证 / 被踢…）
 * @returns {Error} 归一化后的错误（调用方想用就用）
 */
export function reportError (self, e) {
  const err = e instanceof Error ? e : new Error(String(e?.message ?? e ?? '未知错误'))
  if (err.message) self.lastError = err.message
  try { self.log(`连接/运行错误：${err.message}`) } catch { /* 日志失败不致命 */ }
  try {
    if (self.listenerCount('error') > 0) self.emit('error', err)
  } catch (inner) {
    try { self.log(`error 监听者自身抛错（已吞掉，不影响进程）：${inner?.message ?? inner}`) } catch {}
  }
  return err
}

/**
 * 所有直接打给 mineflayer 的 await 都必须过这里。
 * 双重保险：① 监听本轮 turn 的 abort signal（用户按停止 → 立即结算）
 *          ② 本地 deadline（服务端不回 ack → 到点结算）
 * 任一触发都：记 stats/lastTimeout → 松控制位（防"一直按住"跑飞）→ 抛错让工具正常返回。
 * 这样 execute **必然结算**，turn 就不会永久卡在"生成中"。
 *
 * @param {object} self - McBot 实例
 * @param {Promise} promise - 要等的那个 await
 * @param {string} kind - 超时档位名（`TIMEOUTS[kind]`）
 * @param {string} [label] - 出错文案里的动作名（默认同 kind）
 * @param {{releaseControls?: Function}} [ctx] - 私有件：松控制位
 */
export function withBudget (self, promise, kind, label = kind, ctx = {}) {
  /* 🔴 真 mineflayer 有一批动作是**同步 void** 方法（`activateItem` / `deactivateItem` /
   *    `stopDigging` / `releaseControls`）：**返回 undefined**，没有任何可等的东西。
   *    以前这里直接把传进来的值丢给 `raceAbort` → 它内部 `promise.then(...)` ⇒
   *    `TypeError: Cannot read properties of undefined (reading 'then')`，
   *    而且是在**动作已经发出之后**才炸（2026-10-19 实机射箭踩到：卡在"拉弓"那一步，
   *    弓已经拉起来了、箭没放，整个调用报一句看不懂的错）。
   *    自检里的假 bot 一律写成 `async`（返回 promise）⇒ 73/0 全绿也测不出来。
   *    所以**在这里**统一兜住：不是 thenable 就当"已同步完成"，包成已 resolve 的 promise。
   *    （同步方法**抛错**不会走到这儿 —— 那在调用点就抛了，属于调用方的问题。） */
  const p = promise && typeof promise.then === 'function' ? promise : Promise.resolve(promise)
  const want = Number(self.cfg.timeouts?.[kind] ?? TIMEOUTS[kind] ?? 10_000) || 10_000
  // 🔴 上限两道：① 单次操作自己的超时；② 本轮工具调用的 11 秒 + 剩余时间
  const ms = Math.max(0, Math.min(want, CALL_MS, self.msLeft()))
  if (ms <= 0) {
    self.stats.timeouts++
    self.lastTimeout = { kind, label, at: Date.now(), aborted: false, overCall: true }
    ctx.releaseControls?.()
    return Promise.reject(Object.assign(
      new Error(`${label}：这一轮的 ${Math.round(CALL_MS / 1000)} 秒用完了，先返回`
        + '（剩下的下次再叫一次接着做）'),
      { mcTimeout: true, mcCallOver: true }))
  }
  const raced = raceAbort(p, self.abortSignal, label)
  return withTimeout(raced, ms, label).catch((e) => {
    /* 🔴 2026-10-20 审计：以前**只有**超时/中断才松控制位；其它 rejection（`equip` 报
     *    "No item"、`walkTo` 抛 NoPath、`dig` 抛"流体挖不掉"…）会带着"还按着前进键"的状态
     *    逃出去，下一个动作一进来就是失控的。异常路径上一律松手（成功路径不动）。 */
    ctx.releaseControls?.()
    if (e?.mcTimeout || e?.mcAborted) {
      self.stats.timeouts++
      self.lastTimeout = { kind, label, at: Date.now(), aborted: Boolean(e.mcAborted) }
      // 文案（2026-10-06）：`ms` 是"这一轮还剩多少预算"，不是这个操作自己的超时值 ——
      // 到点打"超时（323ms）"看着像"323ms 就超时了"，其实是这一轮的 11 秒用完了。
      const over = self.msLeft() <= 400
      self.log(`⚠️ ${label} ${e.mcAborted
        ? '被用户中断'
        : over ? `这一轮的时间用完了（还剩 ${ms}ms）` : `超时（${ms}ms）`} → 已松控制位，标记为可能失步`)
    }
    throw e
  })
}

/**
 * 真停 pathfinder。
 *
 * 🔴 `bot.pathfinder.stop()` **只是置一个标志**（vendor `index.js:162-164` `stop = () => { stopPathing = true }`）：
 *    它不清路、不松控制位、也不 `stopDigging()`。而 `monitorMovement` 每 tick 都跑，整个函数里
 *    **唯一**读这个标志的地方是"到达下一节点"分支（`index.js:579-585`）—— 在那之前它照旧
 *    `bot.look()`（`:607`）、`setControlState('forward', true)`（`:608`）；**挖路分支在到达检查之前、
 *    完全不看标志**（`:483-511`）⇒ 我们叫停之后，如果下一个节点要挖方块，插件会在工具**已经返回之后**
 *    才开始挖一整块（最坏 3.5 秒后才被 `:632-635` 的 futility 兜住）。
 *    2026-10-08 审计探针 `probe-stopflag3.cjs`：`stop()` 后空转 40 tick（≈2 秒），标志仍在。
 *
 * `setGoal(null)` 才走 `resetPath` → 真 `stop()`：清 path/stateGoal、emit `path_stop`、并 `stopDigging()`。
 * 之后**再**补一次 `stop()`（有些版本 `setGoal(null)` 早退），最后手动松控制位。
 */
export function stopPathing (b) {
  if (!b?.pathfinder) return
  try { b.pathfinder.setGoal?.(null) } catch {}
  try { b.pathfinder.stop?.() } catch {}
}

/**
 * 抢占：立刻停下"正在走的 / 正在挖着走的"，好让安全反射（旁边有怪，先跑）重新开始移动。
 *
 * 被抢占的那次 `walkTo` 会如实返回 `reason:"preempted"`（hint 里写明是自保打断、不是走不通），
 * 调用方按 hint 再叫一次就能接着走。**谁都不动、物理冻住**那种情况不会再出现。
 *
 * @param {object} self - McBot 实例
 * @param {string} [reason] - 为什么要抢占（会记一行日志）
 * @param {{releaseControls?: Function, cancelCollect?: Function}} [ctx] - 私有件
 */
export async function interruptMove (self, reason = '', ctx = {}) {
  const b = self.bot
  self._moveGen++                                    // 在飞的那次走路从此不许再碰控制位
  try { stopPathing(b) } catch {}
  try { await ctx.cancelCollect?.(b) } catch {}       // 采集任务也按着 forward，一起停掉
  ctx.releaseControls?.()
  if (reason) self.log(`已打断当前移动：${reason}`)
  return true
}

/**
 * 注入本轮 turn 的 abort signal（`exec.signal`）。
 * 由 index.js 的 asTool 在每次 execute 前设置——不用清：同一 turn 内所有工具
 * 共享**同一个** signal 对象，下一 turn 会被新的覆盖。
 *
 * @param {object} self - McBot 实例
 * @param {AbortSignal|null} signal
 */
export function setAbortSignal (self, signal) {
  try { if (self._abortHook) self._abortSignal?.removeEventListener?.('abort', self._abortHook) } catch {}
  self.abortSignal = signal ?? null
  self._abortSignal = signal ?? null
  self._abortHook = null
  /* 🔴 2026-10-08 审计④：把"用户点停止"接上 `interruptMove()` —— 以前它只在各工具自己的
   *    `raceAbort` 上等（最长要等一个 `withTimeout` 走完），而 pathfinder 的 `stop()` 又只置标志。
   *    现在 signal 一 abort 就立刻真停（`setGoal(null)`）+ 松控制位，不用等下一次 await 返回。 */
  if (signal && typeof signal.addEventListener === 'function') {
    const hook = () => { try { Promise.resolve(self.interruptMove('用户中断')).catch(() => {}) } catch {} }
    self._abortHook = hook
    try { signal.addEventListener('abort', hook, { once: true }) } catch {}
  }
}

/* ───────────── 控制位租约（路线图第 ④ 条第四十一刀） ─────────────
 * 自保反射（`mc_auto`）在危险脚下按 `back` / 在岩浆里按 `jump` / 溺水濒死按 `jump`，
 * 而任何一次移动收尾都会松掉七个控制位 —— 实机表现是"脚边就是岩浆，走一步收尾把后退松了，
 * 机器人继续往危险里走"。反射那边没有握手，所以由这边**声明租约**：没到期的键不松。
 * 租约表 `self._ctrlLease` 是实例状态，仍留在 `core.mjs`。
 */
/**
 * 反射层专用：按住一个控制位一小会儿，并声明租约（`releaseControls` 会跳过没过期的键）。
 * @returns {number} 到期时刻（ms epoch）
 */
export function holdControl (self, key, ms = 300) {
  const k = String(key)
  const span = Math.max(0, Number(ms) || 0)
  const until = Date.now() + span
  try { self._ctrlLease.set(k, until) } catch {}
  try { self.bot?.setControlState?.(k, true) } catch {}
  const t = setTimeout(() => {
    try {
      if ((self._ctrlLease.get(k) ?? 0) > Date.now()) return   // 又被续租了
      self._ctrlLease.delete(k)
      self.bot?.setControlState?.(k, false)
    } catch {}
  }, span + 20)
  try { t.unref?.() } catch {}
  return until
}

/** 松掉所有控制位（超时/中断后必做，否则"一直按住前进"会跑飞）—— 但跳过反射的租约 */
export function releaseControls (self) {
  try {
    const now = Date.now()
    for (const k of ['forward', 'back', 'left', 'right', 'jump', 'sneak', 'sprint']) {
      const until = self._ctrlLease.get(k) ?? 0
      if (until > now) continue                 // 自保反射正按着（没到期），别抢
      if (until) self._ctrlLease.delete(k)
      self.bot?.setControlState?.(k, false)
    }
  } catch {}
}

/* ───────────── 等区块 / 要一个在线 bot（路线图第 ④ 条第四十三刀） ─────────────
 * 这两个都是"每次动手前后都要过一遍的小关口"：
 *   · `waitForChunks` 算进本轮 11 秒（`msLeft()` 用完就立刻回 `false`，不白等）；
 *   · `requireBot` 用 `self.online`（= 有身体 **且** 连接没结束），只看 `bot.entity`
 *     会把"被踢后的残留"当在线，于是所有世界工具对着死连接干等（2026-09-19 幽灵在线）。
 */
export async function waitForChunks (self, timeoutMs = 20_000) {
    const b = self.bot
    if (!b?.entity) return false
    // 🔴 等区块也要算进"这一轮 11 秒"里：没区块可读时别把整次调用占满
    // 🔴 不写 `|| CALL_BUDGET_MS`：`msLeft()` 没设截止时刻时本来就返回 `CALL_MS`，
    //    而"这一轮已经用完"时它返回 0 —— `0 || 10000` 会白送 10 秒（本文件自检抓过一次）。
    //    2026-10-08 审计⑦：也不能写 `Math.max(300, …)` —— 用完时外层 max 又白送 300ms。
    const leftMs = self.msLeft()
    const cap = leftMs <= 100 ? 0 : Math.max(0, Math.min(Number(timeoutMs) || 20_000, leftMs))
    const probe = () => {
      try {
        const p = b.entity.position.floored()
        return Boolean(b.blockAt(p.offset(0, -1, 0)) || b.blockAt(p))
      } catch { return false }
    }
    /* 🔴 2026-10-15 审计（报告 B 第 5 条）：`cap === 0`（这一轮的预算已经用完）时原来**一次探测都不做**
     *    就 `return false`，调用方（`index.js` 的 mc_connect）把它当 `chunksReady:false` ⇒
     *    明明区块早就加载好了，却谎报"区块没加载好"。预算用完了也至少看一眼。
     * 2026-10-15 异步方案 ②：手写轮询收口到 `waitUntil` —— `ms <= 0` 时它自己就只"当场看一眼"，
     *    上面那条特殊分支因此不再需要（行为反而更难写错）。 */
    const r = await waitUntil(probe, { ms: cap, pollMs: 300, signal: self.abortSignal, label: '等待区块' })
    if (r.reason === 'aborted') throw abortError('等待区块', self.abortSignal)
    return r.ok
  }

/**
 * 要一个一定能干活的 bot；不行就报带原因的错。
 * @param {object} self
 * @param {{allowDead?: boolean}} [opts] `allowDead:true` —— 只读 / 只动嘴的工具用：
 *   真死了更该能喊人、能看地图、能查状态。要拦的是“动世界”的动作。
 */
/**
 * 死后重生。现在不自动重生（`createBot` 传了 `respawn: false`），由模型叫
 * `mc_act { mode: "respawn" }` 决定什么时候重生；这里只负责发包 + 等世界确认。
 * 回包≠结果：`bot.respawn()` 不报错不代表人回来了，必须看到 `isAlive === true` 且血量 > 0。
 */
export async function respawnNow (self) {
  const b = requireBot(self, { allowDead: true })
  if (b.isAlive === true && Number(b.health) > 0) {
    return { ok: true, alreadyAlive: true, health: Number(b.health), text: '我还活着，不用重生' }
  }
  const died = self._life?.position ?? null
  try { b.respawn() } catch (e) {
    return { ok: false, why: 'respawn-send-failed', error: String(e?.message ?? e), text: `重生包发不出去：${String(e?.message ?? e)}` }
  }
  const r = await waitUntil(() => b.isAlive === true && Number(b.health) > 0, { ms: 3_000, pollMs: 150, label: '等重生' })
  const p = b.entity?.position ?? null
  const at = p ? { x: Math.round(p.x), y: Math.round(p.y), z: Math.round(p.z) } : null
  if (!r.ok) {
    return { ok: false, why: 'no-respawn', sent: true, ...(at ? { at } : {}), text: '重生包发了，但 3 秒内没看到人回来。再叫一次试试，或者先看 mc_status。' }
  }
  return {
    ok: true,
    respawned: true,
    ...(at ? { at } : {}),
    ...(died && ['x', 'y', 'z'].every((k) => Number.isFinite(Number(died[k]))) ? { diedAt: { x: Math.round(died.x), y: Math.round(died.y), z: Math.round(died.z) } } : {}),
    text: `重生了${at ? `（在 ${at.x}, ${at.y}, ${at.z}）` : ''}${died ? `。刚才死在 ${Math.round(died.x)}, ${Math.round(died.y)}, ${Math.round(died.z)}` : ''}`,
  }
}

export function requireBot (self, { allowDead = false } = {}) {
    // ⚠️ 用 `online`（= 有身体 **且** 连接没结束）：只看 `bot.entity` 会把"被踢后的残留"当在线，
    //    于是所有世界工具对着死连接干等（2026-09-19 幽灵在线）。
    if (!self.online) {
      const ghost = self.bot?._client?.ended === true && self.bot?.entity
      throw new Error(`机器人不在线${ghost ? '（连接已结束，bot.entity 是残留，需要 mc_connect 重连）' : ''}${self.lastError ? '：' + self.lastError : ''}`)
    }
    const b = self.bot
    /* 2026-10-29（用户：「为什么现在 ai 死了好像不知道」）：死了没重生时，
     * `bot.entity` 还在、`online` 还是 true，所以以前所有工具照常跑 —— 发出去的动作服务端一律不收，
     * 只能报“走不动 / 没反应 / 时间到”。这里直接拦住，并把“死在哪”说清楚。 */
    if (!allowDead && (b?.isAlive === false || Number(b?.health) <= 0)) {
      const at = self._life?.position
      const where = at && ['x', 'y', 'z'].every((k) => Number.isFinite(Number(at[k])))
        ? `死在 (${Math.round(at.x)}, ${Math.round(at.y)}, ${Math.round(at.z)})`
        : '死在哪没记下来'
      throw new Error(`我已经死了（${where}，累计 ${self.stats?.deaths ?? 1} 次），还没重生 —— 发什么动作服务端都不收。要重生就叫 mc_act { mode: "respawn" }（掉落物 5 分钟后消失，要捻就重生后马上回去）；不想重生也可以先说话/看地图。`)
    }
    return b
  }

// -*- coding: utf-8 -*-
/**
 * dsh-mc-agent / async-util.mjs —— 异步小工具（`sleep` / `withTimeout` / `raceAbort` / `abortError`）
 * ---------------------------------------------------------------------------
 * 从 `src/core.mjs` 搬出来的（路线图第 ④ 条第三刀，2026-10-08）。
 *
 * 挑它的理由：这四个是**叶子** —— 不碰 `this`、不碰 mineflayer、不碰事件、不碰世界，
 * 只是 Promise 与 AbortSignal 的算术；而且 `withTimeout` 被 4 个扩展
 * （`mc_chest` / `mc_craft` / `mc_furnace` / `mc_observe`）从 `../src/core.mjs` 导入，
 * `raceAbort` 被 `selfcheck.mjs` 从 `./src/core.mjs` 导入 ⇒ `core.mjs` 必须
 * **保留同名导出**（re-export），外部 import 一行都不用改。
 *
 * 迁移规矩（见 README「渐进拆分 core.mjs」）：
 *   1. 一次只搬一个模块；
 *   2. `core.mjs` 保留同名导出；
 *   3. 搬完先 `grep` 被搬走的名字 —— 套件里"按文件找代码"的静态断言要跟着改（踩坑档案第 46 条）；
 *   4. **移动和挖掘最后再拆**（共享状态、异步中断、事件监听最密）。
 */

/** 等一会儿（毫秒）。 */
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * 给可能永不 settle 的 promise 套超时。超时抛出的错误带 `mcTimeout: true`。
 */
export function withTimeout (promise, ms, label) {
  let timer
  const guard = new Promise((_, reject) => {
    // ⚠️ 这里**故意不 unref**：守卫定时器代表"有真实工作在等"，unref 掉会让
    //    "只有它在跑"时进程直接退出、超时永不触发（selfcheck 里实测踩到）。
    timer = setTimeout(() => reject(new Error(`__MC_TIMEOUT__${label}`)), ms)
  })
  /* 🔴 2026-10-27 GitHub issue #3（用户 ysjmrx 报「寻路 超时 (200ms) 直接升级成
   *    dsh: fatal load failure，把宿主带崩」）：
   *    `Promise.race` 只保证**赢的那一个**有人接 —— 输的那一个如果后来才 reject，
   *    在 Node 眼里就是"未处理拒绝"，而宿主的 fail-loud 把任何未处理拒绝当致命 ⇒ exit(1)。
   *    这里给被包的 promise 挂一条空 catch：不影响返回值，只是提前把"输家"的
   *    rejection 认领掉。（`raceAbort` 里那条派生 promise 同理，见下。）
   */
  if (promise && typeof promise.catch === 'function') promise.catch(() => {})
  return Promise.race([promise, guard])
    .catch((e) => {
      if (String(e?.message ?? '').startsWith('__MC_TIMEOUT__')) {
        // ⚠️ 这句文案以前写的是"服务端没有回应，机器人可能已失步"——**误导**：
        //    超时的绝大多数原因是**目标够不着 / 寻路失败**（本地算的，跟服务端无关），
        //    模型看到"可能已失步"就会去 mc_connect 重连，白断一次线。
        //    改成如实描述 + 说清"已经做了什么"，让它先换目标而不是先重连。
        const err = new Error(`${label} 超时（${ms}ms）：这一步在限定时间内没做完`
          + '（常见原因：目标够不着、寻路失败，或服务端没回应）。'
          + '控制位已经松开；如果是挖方块/采集，后台任务也已经停掉。'
          + '可以换个近一点/好走的目标点重试，或先用 mc_status / mc_diag 看状态。')
        err.mcTimeout = true
        throw err
      }
      throw e
    })
    .finally(() => { if (timer) clearTimeout(timer) })
}

/**
 * 与 `withTimeout` 同样赛跑，但**不抛错**：超时回 `{ timedOut: true }`，正常回 `{ ok: true, value }`。
 *
 * 🔴 2026-11-02 用户实机（多轮长测）：单次 `mc_move` 实测 13.5 / 24.6 / 36.7 秒，最后一次
 *   直接把连接搞掉（`write ECONNABORTED`）。查日志：12:45:28 已经正常收工，
 *   下一条日志在 12:45:50 —— 22 秒花在**收尾**（`restoreHeldOf` → `b.equip`）上，
 *   而收尾阶段没有任何守护。这类 await 在 socket 半死时会一直不 settle，
 *   `Promise.race` 那套（`guarded` / `walkTo` 的 guardTimer）都管不到它。
 *
 * 用法：`const r = await withTimeoutSoft(work, 1_500); if (r.timedOut) …`
 * 语义上是"最多等这么久，等不到就当中途放弃"——调用方自己决定怎么记账。
 */
export function withTimeoutSoft (promise, ms) {
  const TO = Symbol('soft-timeout')
  let timer
  const guard = new Promise((resolve) => { timer = setTimeout(() => resolve(TO), Math.max(1, Number(ms) || 1)) })
  if (promise && typeof promise.catch === 'function') promise.catch(() => {})
  return Promise.race([Promise.resolve(promise).then((v) => ({ ok: true, value: v }), (e) => ({ ok: false, error: e })), guard])
    .then((r) => (r === TO ? { ok: false, timedOut: true } : r))
    .finally(() => { if (timer) clearTimeout(timer) })
}

/**
 * 与 AbortSignal 赛跑 —— 让"停止按钮"真正有效。
 *
 * 为什么必须单独做：宿主的停止链路（GUI 停止键 → POST /api/session/cancel →
 * `agent.cancel({kind:'user'})` → `phase.abort.abort(cause)`）**只是 abort 一个
 * signal**，它没有能力抛弃同进程里 pending 的 promise（宿主源码原话：
 * `tools/index.ts:219` "it cannot hard-kill same-process code"）。
 * 所以工具必须自己在 await 上监听 signal，否则：
 *   本地超时兜底最长要等 25s（dig），用户按停止后仍然"卡着不动"。
 *
 * 拿到 exec.signal 的路径：`ToolExecutionInput.signal`（`exec.signal`），
 * 由 `executeToolCalls(..., signal)` 传入，就是本轮 turn 的 abort signal。
 */
export function raceAbort (promise, signal, label) {
  /* 同上：先认领这条 promise 的 rejection。
   * 中止先赢（用户按停止 / 会话取消）时，原 promise 后来才 reject ⇒ 谁都没接 ⇒ 未处理拒绝。
   * 这是 2026-10-27 issue #3 那次崩溃最可能的泄出口：外层 `Promise.race([寻路, 卡住监控])`
   * 里"卡住监控"先赢，被抛弃的寻路链再抛 mcTimeout。 */
  const p = Promise.resolve(promise)
  p.catch(() => {})
  if (!signal) return p
  if (signal.aborted) return Promise.reject(abortError(label, signal))
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(abortError(label, signal))
    signal.addEventListener('abort', onAbort, { once: true })
    const settle = (fn) => (v) => { signal.removeEventListener('abort', onAbort); fn(v) }
    p.then(settle(resolve), settle(reject))
  })
}

/** 中断错误（带 `mcAborted: true`，`core.mjs` 靠它判断"是人叫停的"而不是失败）。 */
export function abortError (label, signal) {
  const err = new Error(`${label} 被中断（用户停止 / 会话取消）`)
  err.mcAborted = true
  try { err.reason = signal?.reason } catch {}
  return err
}

/**
 * 「等某个条件成立」——**一个轮询循环只写一遍**（2026-10-15，用户点名的异步方案 ②）。
 *
 * 🔴 为什么要收口：在这之前，仓库里有**六处**各自手写的同款循环
 *   （`dig-guard.mjs` 等落地、`server-break.mjs` 等回包、`runtime.mjs` 等区块、
 *    `world-use.mjs` 等附魔选项 / 等铁砧成品），每一处都要自己记着：
 *   **查中止、算 deadline、别把预算睡穿、抛错时别吞**。
 *   六份实现就有六次记漏的机会 —— 实测踩过的两次：
 *   ① `runtime.mjs` 的 `waitForChunks` 在 `cap === 0` 时**一次探测都不做**就回 `false`，
 *      于是"区块早加载好了"被谎报成"没加载好"；
 *   ② `dig-guard.mjs` 的 `waitGrounded` 只在**明确读到 `onGround === false`** 时才等，
 *      这条"假件不能因为读不到就拦下来"的规矩散落在调用点，没法统一钉住。
 *
 * 语义（严格按这个顺序，改之前先看 `tools/check-async-util.mjs` 的断言）：
 *   ① 已经中止 ⇒ 立刻回 `{ok:false, reason:'aborted'}`（**一次 `cond` 都不跑**）
 *   ② `cond()` 现在就成立 ⇒ `{ok:true, reason:'already', waitedMs:0}`
 *   ③ 循环：查中止 → `sleep(pollMs)` → `onTick?.()` → 再查 `cond()`
 *   ④ 到点 ⇒ `{ok:false, reason:'timeout', waitedMs}`
 *
 * ⚠️ `cond` 抛错**照样往外抛**（不吞）：轮询助手最怕的就是"把真实错误伪装成超时"。
 * ⚠️ `ms <= 0` 时只跑第 ①② 步 —— 预算用完了也**至少看一眼**（就是 ① 那条教训）。
 * ⚠️ 不做 `unref`、不自己 `console`、不碰 mineflayer —— 这个模块是叶子。
 *
 * @param {() => any} cond 判据（返回真值即算成立）
 * @param {object} [o]
 * @param {number} [o.ms]        最多等多少毫秒（<=0 只当场看一眼）
 * @param {number} [o.pollMs]    轮询间隔
 * @param {AbortSignal|null} [o.signal]
 * @param {string} [o.label]     只用于日志/测试可读性，本函数自己不打日志
 * @param {Function} [o.onTick]  每轮轮询后跑一次（采样血量这类副作用放这儿）
 * @param {Function} [o.now] / [o.sleep]  测试注入用
 * @returns {Promise<{ok:boolean, reason:'already'|'met'|'timeout'|'aborted', waitedMs:number, last:any}>}
 */
export async function waitUntil (cond, {
  ms = 0, pollMs = 50, signal = null, label = '等待', onTick = null,
  now = () => Date.now(), sleep: nap = sleep,
} = {}) {
  const t0 = now()
  const deadline = t0 + Math.max(0, Number(ms) || 0)
  if (signal?.aborted) return { ok: false, reason: 'aborted', waitedMs: 0, last: undefined, label }
  const first = cond()
  if (first) return { ok: true, reason: 'already', waitedMs: 0, last: first, label }
  while (now() < deadline) {
    if (signal?.aborted) return { ok: false, reason: 'aborted', waitedMs: now() - t0, last: undefined, label }
    await nap(pollMs)
    if (onTick) onTick()
    const v = cond()
    if (v) return { ok: true, reason: 'met', waitedMs: now() - t0, last: v, label }
  }
  return { ok: false, reason: 'timeout', waitedMs: now() - t0, last: undefined, label }
}

/**
 * 「我这边的世界和服务端对不上」时该怎么劝 —— **绝不劝模型去 `mc_connect {force:true}`**。
 *
 * 🔴 2026-10-15 实机定论（用户原话 m00002："现在看一下为什么ai老是退出游戏"）：
 *   以前 `mining.mjs` / `movement.mjs` / `dig-guard.mjs` / `task-runner.mjs` 里十来处返回文案
 *   都写着"真没挖掉就 `mc_connect {force:true}` 重连刷新区块"，模型**照着念**（10-14 12:55:47 的
 *   reasoning 原文就是 `"The plugin mentioned mc_connect {force:true} to fix s..."`）。
 *   而 `force:true`（`connection.mjs:84-93`）是**先 `quit()` 断开、`sleep(600)` 再重登** ——
 *   服务器会向全服广播"XX 离开了游戏"。日志里 `强制重连：先断开旧连接` 共 **15 次**
 *   （10-13 七次、10-14 五次、10-15 三次：`19:16:08`/`19:17:02`/`19:23:58`），
 *   玩家三次原话问"怎么退游戏了 / 你这么退游戏了"，全都精确落在这 15 个时间点上。
 *
 *   而且**大多数"方块复原"根本不是失步**：pathfinder 的 `allow1by1towers` + `scafoldingBlocks`
 *   （`plugins.mjs:221-223`）会在爬不上去时**拿背包里的方块垫在自己脚下**，原木正是首选垫脚料
 *   （`place-items.mjs` 的 `pickPlaceItem`："手里多的排前面"）。垫的那格恰好就是它刚挖掉的坐标
 *   ⇒ 下一次 `mc_scan` 在那里读到 `spruce_log` ⇒ 模型以为"挖掉的方块又回来了"。
 *   10-15 会话里 `(-12,70,-12)` 被"挖掉" 4 次、`mc_dig {count:16}` 的账对不上（挖 13 根只进 7 根，
 *   差的那几根就是被拿去垫脚了）—— 全是这一条。
 *
 * ⚠️ 所以文案的**第一条**永远是"那格是不是我自己垫上去的"，第二条才是"走远 32 格让区块重发"
 *   （这个不打扰玩家）。`force` 重连只在最后提，而且必须如实说清玩家会看到什么。
 */
export const DESYNC_HINT =
  '先按顺序查：① **那格是不是我自己垫脚/搭高放上去的方块**？寻路器爬不上去时会拿背包里的方块'
  + '垫在自己脚下（`mc_move` 返回值里的 `pillared`），垫的那格常常就是刚挖掉的坐标，'
  + '`mc_scan` 会把它读成"方块复原了"；'
  + '② 真怀疑客户端缓存旧了，就走远 32 格再走回来（区块会重发），这不打扰玩家；'
  + '③ **别顺手用 `mc_connect {force:true}`** —— 它是先断开再重登，服务器会向全服广播"你离开了游戏"，'
  + '**玩家会真的看到你退游戏几秒**。确实非做不可，就先 `mc_say` 跟玩家说一声。'

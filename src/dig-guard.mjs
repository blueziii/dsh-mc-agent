/**
 * 挖方块 / 采集的前后守卫（第十五刀：从 `src\core.mjs` 搬出来的）。
 *
 * 四件小事，都是"动手之前"或"动手之后"必须做的：
 *   · `collectBusy(b)`   —— `mineflayer-collectblock` 现在还有任务在跑吗
 *   · `cancelCollect()`  —— 停掉还在后台跑的采集任务 + 松掉控制位（用户报的「现在机器人走不了了」）
 *   · `waitGrounded()`   —— 站到地上再动手（人在空中挖方块慢 5 倍）
 *   · `withHeld()`       —— 结果里补一行"手上变了"（只在真变了时加，别每次多花 token）
 *
 * 规矩（和其它 `src\*.mjs` 一样）：
 *   · 不 import `core.mjs`（反向依赖）；
 *   · **实例状态不进模块**：`#cancelCollect` 要 `this._moveGen` / `#stopPathing` / `#releaseControls` / `this.log`，
 *     `#waitGrounded` 要 `this.abortSignal` ⇒ 都由调用方在薄包装里打包成参数/`ctx` 传进来
 *     （迁移规矩第 17 条）；
 *   · 收尾类动作一律"能失败"，不抛（挖矿这条路上最怕的就是收尾把主流程带崩）。
 */
import { sleep, abortError, waitUntil } from './async-util.mjs'
import { heldText } from './inventory.mjs'
import { inWaterNow, fallingNow } from './world-observer.mjs'

/** mineflayer-collectblock 现在还有任务在跑吗（`targets` 是它自己的 Targets 实例） */
export function collectBusy (b) {
  try { return Boolean(b?.collectBlock?.targets && !b.collectBlock.targets.empty) } catch { return false }
}

/**
 * 停掉还在后台跑的 mineflayer-collectblock 任务，并松掉控制位。
 *
 * 🔴 为什么必须做（2026-10-06 实机定位，用户原话「现在机器人走不了了」）：
 *   `dig()` 用 `withTimeout` 给 collectBlock 设了 90 秒上限，但 **`withTimeout` 只是让
 *   await 提前 reject，并不会取消底层的 collect 任务**。超时后那个任务继续在后台跑：
 *   它自己按着 `forward`、占着 pathfinder 反复寻路，于是机器人"物理冻住"——
 *   `mc_diag` 里 `controlState.forward === true` 而 `velocity` 全 0、位置一格不动，
 *   之后的 `mc_move` 也全部失败（15 秒只挪 0.03 格），**只有重连才恢复**。
 *
 *   `collectBlock.cancelTask()` 内部就是 `bot.pathfinder.stop()` + 等
 *   `collectBlock_finished` 事件（见 vendor 树 CollectBlock.js:238-252），
 *   正好让 `collectAll` 的 `while (!targets.empty)` 循环停下来。
 *   任务本来就已经跑完时（`targets.empty`）它会立刻返回，所以可以放心常调。
 *
 * @param {object} b mineflayer bot
 * @param {object} [ctx] 实例状态，由 `core.mjs` 的薄包装传进来：
 *        `force`（即使看起来没任务也照样调一遍）、`budgetMs`（这次取消最多能花多少毫秒，默认 1500）、
 *        `bumpGen`（把移动代号往前推，别让旧的走路收尾把它一起停掉）、
 *        `stopPathing(b)` / `releaseControls()` / `log(msg)`
 */
export async function cancelCollect (b, ctx = {}) {
  const { force = false, budgetMs = null, bumpGen = null, stopPathing = null, releaseControls = null, log = null } = ctx
  if (force || collectBusy(b)) {
    try { bumpGen?.('collect') } catch {}     // 采集/挖矿也算"一次移动"
    /* 🔴 这里的等待**必须能被调用方限住**（2026-10-08 实机反馈：
     *    `mc_dig` 报 `Error: tool call timed out after 6000ms`，而方块其实早挖掉了）。
     *    `cancelTask()` 最多等 1.5 秒，这段等待以前**不计入**任何预算 —— 挖 2 个目标就是
     *    2×(单个目标预算 + 1.5s) ⇒ 整轮冲出 DSH 层的工具超时，模型拿到一个没有任何信息的硬错误。
     *    `budgetMs` = 调用方"距离自己该返回还剩多少毫秒"，取消动作只能花这么多。
     */
    // 🔴 `budgetMs == null` 是"没指定"（默认等满 1.5 秒）—— 别写成 `Number(budgetMs)`：
    //    `Number(null) === 0` 且 `Number.isFinite(0) === true` ⇒ 会变成"一秒都不等、直接跳过取消"。
    const cap = budgetMs == null
      ? 1500
      : (Number.isFinite(Number(budgetMs)) ? Math.max(0, Math.min(1500, Number(budgetMs))) : 1500)
    try {
      if (typeof b?.collectBlock?.cancelTask === 'function' && cap > 0) {
        /* cancelTask 会一直等到 collectBlock_finished；万一它自己也卡住，cap 毫秒后放行。
         * 🔴 2026-10-15 审计：`cancelTask()` 内部是 `yield once(bot, 'collectBlock_finished')`
         *    （vendor CollectBlock.js:238-252）—— 超时放行时**它挂的那个监听器永远不摘**，
         *    而 `pickup.mjs:50` 在掉落物循环里反复调它 ⇒ 累到 11 个就触发
         *    `MaxListenersExceededWarning`（Node 默认阈值 10），并让之后每次 emit 都白跑一圈。
         *    这里把"本次调用期间新挂上来的监听器"在超时后摘掉（自己摘，vendor 不会摘）。 */
        const EV = 'collectBlock_finished'
        const before = new Set((() => { try { return b.listeners(EV) } catch { return [] } })())
        const finished = Promise.resolve(b.collectBlock.cancelTask()).then(() => true, () => true)
        const ok = await Promise.race([finished, sleep(cap).then(() => false)])
        if (!ok) {
          let after = []
          try { after = b.listeners(EV) } catch {}
          for (const l of after) { if (!before.has(l)) { try { b.removeListener(EV, l) } catch {} } }
        }
      }
    } catch {}
    try { stopPathing?.(b) } catch {}
    try { releaseControls?.() } catch {}
    /* 🔴 2026-10-08 实机（用户「挖矿还是会」那次会话的日志）：`cancelTask()` 内部是
     *    `await once(bot, 'collectBlock_finished')`，而那个事件只有 `collect()` 的 finally 才 emit。
     *    采集任务卡在 `yield bot.dig(block)` 里时（服务端不回 air 方块更新 ⇒ mineflayer 的
     *    `diggingTask` 永远不 resolve，见 `#watchServerBreak` 的注释）**事件永远不会来**
     *    ⇒ `targets` 一直非空 ⇒ 之后每次走路都只打印"上次的采集任务还在后台跑"、
     *    机器人几分钟走不了路（日志里 02:38–02:43 连打 20 次、整整 5 分钟）。
     *    这里兜底：等不到就把队列里剩下的目标清掉（vendor `Targets.clear()`），僵尸任务挡不了路。 */
    if (collectBusy(b)) {
      let cleared = false
      try { b.collectBlock?.targets?.clear?.(); cleared = !collectBusy(b) } catch { /* 清不掉就如实说 */ }
      try {
        log?.(cleared
          ? '⚠️ 采集任务没停下来（等不到 collectBlock_finished）—— 已清空它队列里剩下的目标，机器人可以继续走路'
          : '⚠️ 采集任务停不下来、队列也清不掉 —— 建议先 mc_scan 复核；**不要**顺手 mc_connect {force:true}（那是真退出再进服，玩家会看到）')
      } catch {}
    }
  }
}

/**
 * 站到地上再动手。
 *
 * 🔴 2026-10-08 实机（熔炼验证，探针定论）：`bot.dig()` 里的 `waitTime = bot.digTime(block)`，
 *    而 `prismarine-block` 的 `digTime` 有 `if (notOnGround) blockBreakingSpeed /= 5.0`
 *    ⇒ **人在空中挖方块慢 5 倍**（徒手原木 3 秒 → 15 秒）。那次机器人掉进一个 7 格深的坑，
 *    在下落途中挖原木：11 秒预算到点方块还在（`finishDigging` 都还没到点），只回一句"超时"，
 *    模型完全看不出"人在空中"。
 *    落地再挖才是正解 —— 这里最多等 `maxMs`（默认 1.2 秒，钳到 2 秒）。
 *    返回 true = 站在地上（或本来就站着），false = 还在空中。
 *
 * @param {object} b mineflayer bot
 * @param {{ maxMs?: number, signal?: AbortSignal|null }} [opts] `signal` 由薄包装从 `this.abortSignal` 传进来
 */
export async function waitGrounded (b, { maxMs = 1_200, signal = null } = {}) {
  const ent = b?.entity
  /* 只有**明确读到 `onGround === false`** 才等：假件（套件里的测试机器人）没有物理字段，
   * 不能因为读不到就把它拦下来。 */
  if (!ent || ent.onGround !== false) return true
  /* 2026-10-22 实机（用户：卡在水面）：在水里 onGround 永远是 false，这里一等就超时返回 false，
     于是 mc_dig / mc_act break / mc_sequence break 全被判"还在空中就挖不了"，人在水里丢掉所有退路。
     水不算空中：泡在水里掉不下去，也没有空中挖慢 5 倍的惩罚动机。 */
  if (inWaterNow(b)) return true
  /* 判据跟 dig-speed.mjs 估时用的对齐：真在下落（fallingNow）才算空中。 */
  if (!fallingNow(b)) return true
  const cap = Math.max(0, Math.min(Number.isFinite(Number(maxMs)) ? Number(maxMs) : 1_200, 2_000))
  /* 2026-10-15 异步方案 ②：手写轮询收口到 `waitUntil`（查中止 / 算 deadline / 别睡穿预算 只有一份实现） */
  const r = await waitUntil(() => ent.onGround !== false, { ms: cap, pollMs: 80, signal, label: '落地' })
  if (r.reason === 'aborted') throw abortError('落地')
  return ent.onGround !== false
}

/** 结果里补一行"手上变了"（只在真变了的时候加，别每次都多花 token） */
export function withHeld (out, b, before) {
  const held = heldText(b)
  if (before != null && held !== before) out.push(`手上：${before} → ${held}`)
  return out
}

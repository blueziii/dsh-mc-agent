#!/usr/bin/env node
/**
 * 实体避让（`mc_move` 用）。
 *
 * 用户 2026-10-30：「move 中加实体避让」。
 *
 * 为什么要单独一层：vendor（mineflayer-pathfinder）只在**规划那一刻**看实体 ——
 * `movements.js` 把实体所在的格加 `entityCost`（默认才 1，等于不绕），
 * 而 `getMoveForward` 里"目标格有实体"是**硬 return**（直接不生成这条边）⇒
 * 常常直接变成 `NoPath`。路径定下来之后实体再走过来，执行层**完全不管**：
 * 人就这么顶着怪/顶着动物走，直到采样器判"卡住"（2.4 秒）再进脱困阶梯。
 *
 * 🔴 2026-11-03 用户定案（原文）：「不要抛错，直接绕过去。敌对和末影龙都不要」。
 *    前一天的做法是"敌对的立刻收工、被动的等 900ms 等不到也收工"，实机表现是
 *    「现在遇到怪就走不动了」「我挡在路上也走不动」—— 人一格不挪地站在原地，
 *    既不绕也不打，还白挨打。**收工不是避让**。现在的规矩：任何活物挡路 ⇒ 重算一条路绕开；
 *    同一条窄道上绕不过去（重算次数用完）⇒ 直接挤过去。只有掉落物/弹射物不管。
 *
 * 这一层管执行期的两件事：
 *   ① **看得见**：前方一小段（默认 2 格）里有谁挡着、是什么、多远（复用 `entityObstacleAhead`）；
 *   ② **说清怎么办**：一律绕（`shouldDodgeEntity`），绕几次由调用方计数（`MOVE_DODGE_MAX`）。
 *
 * 这里只放**纯函数与计时辅助**，不碰 pathfinder —— 接入点在 `src/movement.mjs` 主循环，
 * 这样 `tools/check-*.mjs` 能拿假 bot 直接测敌友判定与等待逻辑（不需要真服务端）。
 */

/** 敌对的实体名（1.21 的 `entity.kind` 不可靠时按名字判；名字是 `bot.entities` 里最稳的字段）。 */
export const HOSTILE_RE = /^(zombie|zombie_villager|husk|drowned|skeleton|stray|wither_skeleton|bogged|spider|cave_spider|creeper|witch|pillager|vindicator|evoker|illusioner|ravager|phantom|slime|magma_cube|blaze|ghast|guardian|elder_guardian|shulker|enderman|endermite|silverfish|vex|zoglin|hoglin|piglin_hunter|piglin_brute|piglin|wither|ender_dragon|warden|breeze|creaking)$/

/** 一看就是"绝对打不过 / 不该用身体去顶"的。 */
export const DANGEROUS_RE = /^(wither|ender_dragon|warden)$/

/** 掉落物/弹射物/装饰实体：不算挡路（与 `entityObstacleAhead` 的 IGNORE 同口径）。 */
export const PASSABLE_RE = /^(item|arrow|spectral_arrow|snowball|egg|potion|experience_orb|fishing_bobber|trident|eye_of_ender|firework_rocket|shulker_bullet|llama_spit|small_fireball|dragon_fireball|fireball|wither_skull|ender_pearl|area_effect_cloud|leash_knot|painting|item_frame|glow_item_frame|armor_stand)$/

/**
 * 这个实体算不算"敌对"？
 * @param {object|string} e 实体对象或名字
 * @returns {boolean}
 */
export function isHostileEntity (e) {
  const nm = String(typeof e === 'string' ? e : (e?.name ?? e?.username ?? e?.type ?? '')).replace(/^minecraft:/, '')
  if (!nm) return false
  if (PASSABLE_RE.test(nm)) return false
  return HOSTILE_RE.test(nm)
}

/**
 * 该为它换一条路吗？（2026-11-03 用户：「不要抛错，直接绕过去。敌对和末影龙都不要」）
 * 除了掉落物/弹射物/装饰实体，**一律绕** —— 动物、村民、玩家、僵尸、末影龙都一样：
 * 不站着等、也不收工，交给 A* 换一条路（重算次数由调用方数，见 `MOVE_DODGE_MAX`）。
 */
export function shouldDodgeEntity (e) {
  const nm = String(typeof e === 'string' ? e : (e?.name ?? e?.username ?? '')).replace(/^minecraft:/, '')
  if (!nm) return false
  return !PASSABLE_RE.test(nm)
}

/** 一次移动里最多为实体重算几次路（再多就是在同一条窄道上打转 ⇒ 直接挤过去）。 */
export const MOVE_ENTITY_DODGE_MAX = 3

/** 该不该等它让开（false ⇒ 立刻收工交给 AI，站着等只会挨打）。 */
export function shouldWaitEntity (e) {
  const nm = String(typeof e === 'string' ? e : (e?.name ?? e?.username ?? '')).replace(/^minecraft:/, '')
  if (DANGEROUS_RE.test(nm)) return false     // 末影龙/凋灵/监守者：连靠近都不该等
  return !isHostileEntity(e)                  // 敌对的别等；被动/中立/玩家可以等
}

/**
 * 挡路时该做什么。
 * @param {{name?:string, dist?:number, player?:string}} blocker
 * @param {{waitedMs?:number, maxWaitMs?:number}} [state]
 * @returns {'wait'|'report'} `wait` = 再等一会儿；`report` = 如实收工（不要原地磨）
 */
export function avoidActionOf (blocker, state = {}) {
  const waitedMs = Number(state.waitedMs ?? 0)
  const maxWaitMs = Number(state.maxWaitMs ?? 900)
  if (!shouldWaitEntity(blocker)) return 'report'
  if (waitedMs >= maxWaitMs) return 'report'
  return 'wait'
}

/** 给结果/hint 用的一句话（"前方 1.2 格是 cow（被动，可以等它走开）"）。 */
export function entityTextOf (blocker) {
  if (!blocker) return ''
  const nm = String(blocker.name ?? '实体')
  const who = blocker.player ? `玩家 ${blocker.player}` : nm
  if (DANGEROUS_RE.test(nm)) return `前方 ${blocker.dist} 格是 ${who} —— **绝对打不过，绕开**`
  /* 🔴 2026-11-03 用户：「不要抛错，直接绕过去。敌对和末影龙都不要」「不要不动和遇到停住」
   *   以前这里劝「先 mc_attack，否则换个方向绕」，但那是**收工交给人**的说法 —— 现在
   *   走路遇到活物一律自己绕（见 shouldDodgeEntity），所以文案也要改成同一口径。 */
  if (isHostileEntity(nm)) return `前方 ${blocker.dist} 格是 ${who}（**敌对**）—— 我绕开`
  return `前方 ${blocker.dist} 格是 ${who}（被动/中立）—— 它会挡路，我绕开`
}

/**
 * 等前方实体走开：每 `probeMs` 重扫一次，最多 `maxWaitMs`。
 * 依赖外部传进来的 `scan()`（一般就是 `entityObstacleAhead` 的闭包），保持本文件不碰 bot。
 *
 * @param {object} p
 * @param {() => object|null} p.scan    重扫：返回挡路的实体（含 name/dist），没有就 null
 * @param {(ms:number) => Promise<void>} p.sleep
 * @param {number} [p.maxWaitMs]
 * @param {number} [p.probeMs]
 * @returns {Promise<{cleared:boolean, blocker:object|null, waitedMs:number, lastBlocker:object|null}>}
 */
export async function waitEntityClear ({ scan, sleep, maxWaitMs = 900, probeMs = 150 } = {}) {
  const t0 = Date.now()
  let lastBlocker = null
  for (;;) {
    const b = scan?.() ?? null
    if (!b) return { cleared: true, blocker: null, waitedMs: Date.now() - t0, lastBlocker }
    lastBlocker = b
    if (!shouldWaitEntity(b)) return { cleared: false, blocker: b, waitedMs: Date.now() - t0, lastBlocker: b }
    if (Date.now() - t0 >= maxWaitMs) return { cleared: false, blocker: b, waitedMs: Date.now() - t0, lastBlocker: b }
    await sleep?.(probeMs)
  }
}

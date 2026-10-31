/* ============================================================================
 * 挖掘 —— 两件事：按坐标破坏一块方块（`mc_act {mode:"break"}`）、挖方块（`mc_dig`）
 *
 * 路线图第 ④ 条第三十八刀从 `src\core.mjs` 搬出来。这一层只做"把一块方块挖掉"，
 * 所有判断都靠已经搬出去的邻居：
 *   · `blockReachOf`（world-observer）：**眼睛→方块中心** ≤ 4.5（生存）/ 5.0（创造）才动手
 *   · `ctx.waitGrounded`（dig-guard）：空中挖慢 5 倍，先等落地
 *   · `ctx.equipFor`（inventory）：动手前换到对的工具；换不上直接拒绝，不硬挖
 *   · `digMsFor`（dig-speed）：这块按手上的东西要几秒；**时间不够就别开始挖**
 *     （到点松手 = 破坏进度清零，白玩一次调用）
 *   · `ctx.watchServerBreak` / `ctx.awaitServerBreak`（server-break）：服务端的判决才是判决 ——
 *     "改成空气"＝挖掉、"改成非空气"＝复原（服务端没认）、其余＝没有证据
 *   · `dropHint`（world-observer）：真挖掉了就点一句"东西还在地上"
 *
 * 参数：`self` = McBot（只读 `callLeft()` / `log()` / `requireBot()`），
 *       `ctx` = 五个私有回调（见 core 的 `#mineCtx()`）。
 * 判据：模块不 import `core.mjs`、不 import 游戏库（只认 `b.blockAt` / `b.dig` / `b.game`）。
 * ========================================================================== */

import vec3pkg from 'vec3'
const Vec3 = vec3pkg.Vec3 ?? vec3pkg

import { sleep, DESYNC_HINT } from './async-util.mjs'
import { isAir, isLiquid, isSolidBlock, isPassable } from './block-names.mjs'
import { heldText, canHarvestNow, canBreakNow, toolKinds, countOf, durWarnText } from './inventory.mjs'
import { digMsFor } from './dig-speed.mjs'
import { blockReachOf, slowDigWhy, stateNameOf, dropHint, dropListOf } from './world-observer.mjs'
import { PICKUP_GRACE_MS, waitForPickup } from './pickup.mjs'
import { classifyRestore, restoreLocalBlock } from './server-break.mjs'
import { callBudget, callSecText, needLeft, insufficientText } from './budget.mjs'
import { dangerNow, dangerText, dangerNotice, healthOf, noticeKey } from './danger.mjs'

/* 「挖到刚好够合成就不挖了」—— 收工时补一句（用户 2026-10-13 报的毛病）。
 *
 * 判据**不是**"手头有几个"，而是**附近还有没有同一种矿**（用户后来改的：
 * 不要定数量，让它把同一条矿脉挖干净）。所以只在"刚挖掉的那一格附近还有同一串矿"
 * 时提醒，并且报出**还剩几块**，让模型自己决定挖到哪：
 *   - 附近一块都不剩（或只剩一块孤零零的）⇒ 不啰嗦，它已经挖干净了；
 *   - 手头已经很多也不管 —— 矿脉就在旁边，顺手挖完永远是对的。
 * `mc_dig` 一轮挖不完时本来就会说"还有 N 个没挖"，所以预算用光那条路不再补这句。
 */
const VEIN_RE = /(_ore$|^ancient_debris$)/
const VEIN_RADIUS = 12
const VEIN_LEFT_MIN = 2
/** 矿 → 挖出来会变成什么（用来报"手头有多少"，只报背包里真有的）。 */
const VEIN_HAVE = {
  diamond_ore: ['diamond'],
  deepslate_diamond_ore: ['diamond'],
  iron_ore: ['raw_iron', 'iron_ingot'],
  deepslate_iron_ore: ['raw_iron', 'iron_ingot'],
  gold_ore: ['raw_gold', 'gold_ingot'],
  deepslate_gold_ore: ['raw_gold', 'gold_ingot'],
  nether_gold_ore: ['raw_gold', 'gold_ingot'],
  coal_ore: ['coal', 'charcoal'],
  deepslate_coal_ore: ['coal', 'charcoal'],
  copper_ore: ['raw_copper', 'copper_ingot'],
  deepslate_copper_ore: ['raw_copper', 'copper_ingot'],
  lapis_ore: ['lapis_lazuli'],
  deepslate_lapis_ore: ['lapis_lazuli'],
  emerald_ore: ['emerald'],
  deepslate_emerald_ore: ['emerald'],
  redstone_ore: ['redstone'],
  deepslate_redstone_ore: ['redstone'],
  ancient_debris: ['ancient_debris'],
}

/** 掉落物的人话坐标（给多块挖矿的"没捡到"那句话用）；一个都没有回空串 */
function dropsWhereText (b, radius = 8) {
  const list = dropListOf(b, { radius, limit: 3 })
  if (!list.length) return ''
  return list.map((d) => {
    const nm = d.name ? d.name + ' ' : ''
    return `${nm}@ (${d.x},${d.y},${d.z}) ${d.dist} 格`
  }).join('、')
}

/**
 * 收工提醒：这次挖的是矿石、而且**附近 12 格内还剩两块以上同一种矿**时，返回一句话；否则 null。
 * 扫的是机器人**当前站位**附近（它刚站在这条矿脉边上）。
 */
export function veinHint (b, minedName) {
  const nm = String(minedName ?? '')
  if (!VEIN_RE.test(nm)) return null
  let left = 0
  try {
    const hits = b?.findBlocks?.({ matching: (blk) => blk?.name === nm, maxDistance: VEIN_RADIUS, count: 64 })
    left = Array.isArray(hits) ? hits.length : 0
  } catch { return null }
  if (left < VEIN_LEFT_MIN) return null
  const got = (VEIN_HAVE[nm] ?? []).map((k) => [k, countOf(b, k) ?? 0]).filter(([, v]) => v > 0)
  const label = got.length ? `（手头 ${got.map(([k, v]) => `${k}×${v}`).join(' + ')}）` : ''
  return `　💡 附近 ${VEIN_RADIUS} 格内还有 **${left} 块 ${nm}**${label} —— 把这条矿脉挖干净再走：`
    + `接着 \`mc_dig {name:"${nm}", count:8, maxDistance:${VEIN_RADIUS}}\`，直到结果里出现"附近找不到 ${nm}"。`
    + '回头补料比多挖几块贵得多。'
}

/**
 * 「挖脚下方块」的安全检查 —— 2026-10-18 审计（P1-5）。
 *
 * 现象：`mc_dig` / `mc_act {mode:"break"}` 挖**自己站着的那一格**（或它脚下）时没有任何检查，
 * 下面若是岩浆 / 悬空 / 水就直接掉下去 —— 实机摔死过（y=68 → 47）。
 *
 * 判据刻意保守，只拦「**这一格就是我的支撑**」这一种：
 *   · 方块在**脚下**（同一列、`pos.y === 脚下方块的 y`），或
 *   · 方块**和我脚同层**（同一列、`pos.y === 脚 y`，挖掉后脚下可能是空的）
 * 并且往下 3 格量一遍：第一格不是实心（悬空）或第一格/第二格是液体 ⇒ 有风险。
 *
 * 返回 `{ bad, why, below }`，`bad=false` 表示照挖。**不检查远处的方块** —— 那是寻路和搭路的事。
 */
/* 跟“往下走”同一把尺（`src/movement.mjs` 的 `MOVE_DROP_MAX`）—— 能安全掉 4 格，
 * 就没理由不许挖脚下那块矿。 */
/* 🔴 2026-10-29：旧的 `UNDERFOOT_DROP_MAX`（4 格）与血少时 3 格那套阈值**不再用来拦** ——
 *   它们把“矿下面就是矿洞”这种最常见的情形整格拦掉（用户：「只会挖脚下方块下面的那格，
 *   不挖脚下的那格」）。现在改按摔落伤害算：伤害 = 落差 − UNDERFOOT_SAFE_DROP（MC 公式）。
 *   常量保留导出（`UNDERFOOT_DROP_MAX` 现在只用于文案分级，套件也还 import 它）。 */
export const UNDERFOOT_DROP_MAX = 4
/* 🔴 2026-11-02 审计（#19）：这里原来还有 `UNDERFOOT_DROP_MAX_LOW_HP = 3` 和
 *   `UNDERFOOT_DROP_MIN_HP = 10` —— **全仓一次都没读过**（血少那套阈值 2026-10-29 就已经
 *   换成"按摔落伤害算"）：留着只会让人以为"血少时上限是 3"。已删。 */
export const UNDERFOOT_SAFE_DROP = 3

export function underfootRiskOf (b, pos) {
  const p = b.entity?.position
  if (!p) return null
  const feet = p.floored()
  const sameColumn = pos.x === feet.x && pos.z === feet.z
  /* 只有“脚底下**垫着**的那一格”才算拆支撑 —— 站的那一格本身（`feet.y`）永远是空气，
   * 挖同层的方块不会让人掉下去（水平相邻的方块另算，那是寻路的事）。 */
  const mineSupport = pos.y === feet.y - 1
  if (!sameColumn || !mineSupport) return null
  /* 🔴 2026-10-29 用户：「mc_dig · coal_ore 不挖脚底下的」。旧判据是“下面不是实心就拦”，
   *   于是“矿就是脚下支撑、矿下面是矿洞”这种最常见的情形一律被拦。
   *   现在跟 `dropThrough` 对齐：**能安全掉下去（≤ dropMax 格、落点实心、没液体）就照挖**。 */
  const hp = Number(b.health ?? 20)
  const below = []
  /* 往下读 24 格：够判断“掉下去会不会死”（MC 摔落伤害 = 落差 − 3，血量满 20）。 */
  for (let dy = 1; dy <= 24; dy++) {
    const c = b.blockAt(new Vec3(pos.x, pos.y - dy, pos.z))
    below.push(c ? c.name : null)
  }
  const liquid = (n) => n != null && isLiquid(n)
  const fmt = () => below.map((n) => n ?? '未加载').join(' / ')
  if (liquid(below[0])) return { bad: true, why: `正下方就是 ${below[0]}`, below }
  /* 数“掉几格才落地”。`null` = 没加载（不知道），按老规矩**不当成空**。 */
  let air = 0
  while (air < below.length && below[air] != null && !isSolidBlock(below[air])) {
    if (liquid(below[air])) return { bad: true, why: `正下方 ${below[air]} 是液体（${fmt()}）`, below }
    air++
  }
  const land = below[air]
  if (air === 0) return { bad: false, why: null, below }
  if (land == null) {
    /* 已经读到“确实是空气”，但往下读不到了 ⇒ 不知道还有多深。
     * 这时候要**保守**（拦）—— “不知道”往深坑那边靠。 */
    return { bad: true, why: `正下方 ${air} 格都是空的，再往下就读不到了（不知道多深）`, below }
  }
  if (liquid(land)) return { bad: true, why: `掉 ${air} 格就掉进 ${land}（${fmt()}）`, below }
  /* 摔落伤害 = 落差 − 3（免伤 3 格）；摔不死就照挖。 */
  const dmg = Math.max(0, air - UNDERFOOT_SAFE_DROP)
  if (dmg >= hp) {
    return { bad: true, why: `落差 ${air} 格、掉下去摔 ${dmg} 点（当前血 ${hp}）—— 会摔死`, below, dropTo: air, fallDamage: dmg }
  }
  return { bad: false, why: null, below, dropTo: air, fallDamage: dmg }
}

export async function breakBlock (self, { x, y, z, allowDangerous = false, noClear = false } = {}, ctx = {}) {
  const b = self.requireBot()
  const pos = new Vec3(Math.floor(x), Math.floor(y), Math.floor(z))
  const blk = b.blockAt(pos)
  if (!blk) throw new Error(`${pos.x},${pos.y},${pos.z} 未加载`)
  if (isAir(blk.name)) {
    return {
      broken: null, at: { x: pos.x, y: pos.y, z: pos.z },
      note: '那里本来就是空气（**我这边**读到的）—— 要么已经挖掉了，要么客户端的区块缓存旧了：'
        + '先 `mc_scan` 看看附近实际有什么。'
        + DESYNC_HINT,
    }
  }
  const name = blk.name
  /* ①′ 挖自己脚下 = 拆自己的支撑（2026-10-18 审计 P1-5）：下面若是岩浆/悬空/水，
   *    挖下去人就跟着掉。**默认拦住**，要拆就说 `allowDangerous:true`。 */
  const risk = allowDangerous ? null : underfootRiskOf(b, pos)
  if (risk?.bad) {
    return {
      broken: false, at: { x: pos.x, y: pos.y, z: pos.z }, now: name,
      dangerous: true,
      note: `挖这一格会把自己脚下的支撑拆掉：${risk.why}`
        + ' —— **我没开始挖**。真要走的话先横着挪一格（`mc_move`），或确实想拆就带上 `allowDangerous:true`。',
    }
  }
  /* 🔴 2026-10-08 第五份审计报告 ② + 实机定论：`breakBlock` 以前**完全没有"够不着"检查**（dig 有）。
   *    上游 `digging.js` 的 `canDigBlock` 要求**眼睛到方块中心** ≤ 5.1，服务端生存 reach 是 4.5；
   *    对够不着的方块动手 = 服务端静默忽略 + 报告 ① 的客户端预测 ⇒ **静默假成功**。
   *    ⚠️ 判据必须是 `#reachOf`（眼→中心）：用"脚→坐标"算的话，正下方 4 格的方块会被判"够得着"。 */
  const dist = blockReachOf(b, blk)
  const reachMax = b.game?.gameMode === 'creative' ? 5.0 : 4.5
  if (dist > reachMax) {
    return {
      broken: false, at: { x: pos.x, y: pos.y, z: pos.z }, now: name,
      held: heldText(b), reach: Math.round(dist * 100) / 100,
      note: `够不着（我在 ${Math.round(dist * 100) / 100} 格外，${b.game?.gameMode === 'creative' ? '创造 5' : '生存 4.5'} 格以内才挖得动）`
        + ' —— **我没开始挖**（服务端会静默忽略，然后报个假的"挖掉了"）。先 `mc_move` 走到它旁边再挖。',
    }
  }
  /* 2026-10-25 用户：「不能隔着方块挖」—— 同上：够得着 ≠ 看得见。
   * 2026-10-27 用户：「dig 矿石满足条件就会不让挖，然后 AI 是一点一点把周围挖掉。改成不满足
   *   条件直接挖到满足条件」⇒ 被挡时**自己先把挡路的挖开**，别把这活退回给 AI（它只能一块
   *   一块试，每次都要一次往返）。清不通才拒，并说清是哪一块、为什么清不了。 */
  let clearedSight = []
  {
    const see = await canSeeBlockOf(b, pos, { reachMax })
    if (see && see.ok === false) {
      const r = await clearSightTo(self, b, pos, { reachMax, ctx, noClear })
      clearedSight = r.cleared ?? []
      const after = r.ok ? await canSeeBlockOf(b, pos, { reachMax }) : see
      const last = after ?? see
      if (!r.ok || (after && after.ok === false)) {
        return {
          broken: false, at: { x: pos.x, y: pos.y, z: pos.z }, now: name, held: heldText(b),
          ...(clearedSight.length ? { cleared: clearedSight } : {}),
          blockedBy: last.blocker, blockedAt: last.at,
          los: last.los === true,
          note: clearFailText({ ...r, blocker: last.blocker, at: last.at }, last, name) + '。',
        }
      }
    }
  }
  // ①′ 空中挖慢 5 倍（`bot.digTime` 的 `notOnGround`）⇒ 先等落地再动手，别把预算喂给一次注定超时的挖掘
  if (!await ctx.waitGrounded(b, Math.min(1_500, Math.max(0, self.callLeft() - 800)))) {
    return {
      broken: false, at: { x: pos.x, y: pos.y, z: pos.z }, now: name,
      held: heldText(b),
      note: '我还在空中（没落地）—— 空中挖方块慢 5 倍（徒手原木 3 秒变 15 秒），'
        + '**我没开始挖**。先站稳（`mc_move {mode:"jump"}` 换个落脚点，或等一下）再叫一次。',
    }
  }
  // ① 先换到对的工具（背包里有的话）—— "手上攥着泥土刨石头"是"一直超时"的头号原因
  const t = await ctx.equipFor(b, blk, `换工具挖 ${name}`)
  // ② 换不上就**别硬挖**：徒手挖石头要 7.5 秒，比一轮预算还长，只会白花时间 + 报个假原因
  /* 🔴 2026-10-24 用户实机（挖雪三坑之一）：「雪块只能锹挖，手上是铁镐/钻石镐都没用」——
   *    这句话只对了一半：**没有锹就没有掉落**，但雪块徒手 0.3 秒就挖开。
   *    以前这里 `!canHarvestNow` 一律抛错，于是"挖开它爬上去"这种正当需求被挡死；
   *    用户当时的处境是竖井顶上就是雪块、退无可退 ⇒ 报错 → 想做锹 → 要木头 → 木头在地表 →
   *    地表被雪盖着 ⇒ 死循环。现在分开判：挖得动就挖（并说明没掉落），挖不动才拦。 */
  const noDrop = !canHarvestNow(b, blk)
  if (noDrop && !canBreakNow(b, blk)) {
    throw new Error(`手上是 ${t.held}，挖 ${name} ${toolKinds(b, blk)} —— 背包里也没有能挖它的东西。`
      + '先 mc_craft 一把（木镐 = 3 木板 + 2 木棍），或先 mc_act{mode:"equip",name:"…"} 换一个。硬挖会一直超时。')
  }
  const digMs = digMsFor(b, blk, b?.heldItem?.type ?? null)
  /* 🔴 时间不够就**别开始挖**（2026-10-08 实机反馈：玩家转来 AI 的话"快挖完的时候会重置"）。
   *    到点松手 = 破坏进度清零、白费一次调用；模型连着叫三次就是"挖到八成又从头来"。
   *    宁可如实说"我没开始挖"，让它专门再叫一次。 */
  const leftMs = self.callLeft()
  if (digMs != null && leftMs < digMs + 900) {
    return {
      broken: false,
      at: { x: pos.x, y: pos.y, z: pos.z },
      now: name,
      held: heldText(b),
      digMs,
      budgetMs: Math.round(leftMs),
      ...(t.changed ? { tool: `${t.heldBefore} → ${t.held}` } : {}),
      note: `这一轮只剩 ${Math.round(leftMs)}ms，这块按手上的东西要 ${(digMs / 1000).toFixed(1)} 秒${slowDigWhy(b)} —— **我没开始挖**`
        + '（挖到一半到点松手，破坏进度会清零，白费一次调用）。再叫一次 `mc_act {mode:"break"}` 专门挖它就行。',
    }
  }
  /* 动手之前就挂上"服务端认没认"的监听（报告 ①）。 */
  const watch = ctx.watchServerBreak(b, pos)
  let timedOut = false
  try {
    await ctx.t(b.dig(blk, true), 'digBlock', `破坏 ${name}`)
  } catch (e) { if (e?.mcTimeout) timedOut = true; else { watch.stop(); throw e } }
  /* 🔴 超时**不代表没挖掉**：`withTimeout` 只是让我们不等了，mineflayer 那边的挖矿循环还在发包，
   *    方块往往过一会儿就真没了（2026-10-08 实机：连着两次 `mc_act{break}` 都回"那里本来就是空气"）。
   *    所以超时时多等一会儿再复查，别急着报"没挖掉"。
   *    ⚠️ 等的是**服务端的包**（`#awaitServerBreak`），不是干睡 —— 客户端那个 air 是预测，不算数。 */
  await ctx.awaitServerBreak(b, watch, { maxMs: timedOut ? 900 : 1_200 })
  // 同样要验证：挖失败（服务端拒绝/失步）不能报"broken: name"
  const now = b.blockAt(pos)?.name ?? null
  const localGone = now !== name
  /* 没挂上监听（假 bot）时**别下结论**：报 `null` 而不是 false（"没收到回包"是结论，不能凭空说）。 */
  /* 🔴 服务端把这个位置改成了**非空气** —— 得先看是不是**同一个方块**（`classifyRestore`）：
   *   同一个 ⇒ 真拒绝（复原）；变成**液体** ⇒ 破坏其实成功了（冰挖掉就是水，海草/海带同理）；别的 ⇒ 客户端区块旧了。 */
  const rest = classifyRestore(watch)
  const confirmed = watch.watching ? (watch.hit() || rest?.kind === 'liquid') : null
  watch.stop()
  const held = heldText(b)
  if (rest?.kind === 'same') {
    await sleep(150)                      // 等客户端把服务端这个包应用上，好报出"复原成什么"
    /* 服务端包里的状态 id 是**权威**的（本地 `blockAt` 可能还没应用上这个包，会读成 air）⇒ 优先用它。 */
    const back = rest.name ?? stateNameOf(b, watch.restored()) ?? b.blockAt(pos)?.name ?? '别的方块'
    self.log(`⚠️ 服务端把 ${name} 复原了（${pos.x},${pos.y},${pos.z}）—— 这次破坏没被认`)
    return {
      broken: false, restored: true, at: { x: pos.x, y: pos.y, z: pos.z }, now: back,
      held, reach: Math.round(blockReachOf(b, blk) * 100) / 100,
      ...(t.changed ? { tool: `${t.heldBefore} → ${t.held}` } : {}),
      ...(digMs != null ? { digMs } : {}),
      note: `服务端把这块**改回了 ${back}**（复原）—— 这次破坏服务端没认（多半是我离得远，或客户端区块旧了）。`
        + '先 `mc_move` 走到它旁边（3 格以内）再叫一次。'
        + slowDigWhy(b)
        + DESYNC_HINT,
    }
  }
  if (rest?.kind === 'other') {
    await sleep(150)
    const back = rest.name ?? '别的方块'
    self.log(`⚠️ 服务端说 ${pos.x},${pos.y},${pos.z} 是 ${back}，和我以为的 ${name} 不一样 —— 客户端区块旧了？`)
    return {
      broken: false, restored: true, desync: true, at: { x: pos.x, y: pos.y, z: pos.z }, now: back,
      held, reach: Math.round(blockReachOf(b, blk) * 100) / 100,
      ...(t.changed ? { tool: `${t.heldBefore} → ${t.held}` } : {}),
      ...(digMs != null ? { digMs } : {}),
      note: `服务端说这一格是 **${back}**，和我这边看到的 **${name}** 不一样（客户端区块旧了）—— 这次破坏没被认。`
        + '先 `mc_scan` 复核一眼，别照着旧方块继续动手。'
        + DESYNC_HINT,
    }
  }
  /* 真挖掉了 ⇒ 掉落物就在脚边。用户 2026-10-08 原话："挖完方块…老是忘记走过去拾取"。
   * 只**点一句**（`mc_act{break}` 这条路从来不自己捡），让模型知道这活还没完。 */
  /* 🔴 2026-10-23：本地已经被 `digging.js` 清成空气、服务端却**一声不响**（既没破坏包也没复原包）⇒
   *    把本地那一格改回去。否则这一格会变成“本地空气 / 服务端实心”的幽灵空位，
   *    寻路和地图都以为那儿通了（实机表现：得换目标或绕一下才走得动）。 */
  const rolledBack = (localGone && confirmed === false) ? restoreLocalBlock(b, pos, Number(blk?.stateId)) : false
  const pickup = localGone ? dropHint(b) : null
  /* 🔴 和 mc_attack 一个口径：只说"地上还有东西"不够，**在哪**才是能不能捡的依据
   *   （2026-10-22 下界连丢两根烈焰棒就是栽在这上面）。捡不捡仍由 AI 决定。 */
  const drops = localGone ? dropListOf(b, { radius: 8, limit: 4 }) : []
  /* 这一下把工具磨掉多少 —— 只在快坏时给（理由见 `dig` 收工段那段注释：
   * 全好时不说，坏的时候必须说，否则"镐子中途爆了"和"挖得好好的"长得一模一样）。 */
  const toolWear = durWarnText(b)
  return {
    broken: rolledBack ? false : (localGone ? name : false),
    ...(rolledBack ? { localRestored: true } : {}),
    ...(clearedSight.length ? { cleared: clearedSight } : {}),
    confirmed,
    at: { x: pos.x, y: pos.y, z: pos.z },
    now,
    held,
    ...(toolWear ? { toolWear } : {}),
    ...(t.changed ? { tool: `${t.heldBefore} → ${t.held}` } : {}),
    ...(digMs != null ? { digMs } : {}),
    ...(noDrop ? {
      note: `挖开了 —— 但**没掉落**（${name} 要 ${toolKinds(b, blk) || '对工具'}才有东西掉）。`
        + '要是只想清路/爬出去，这样就行了；想要掉落得先弄一把对的工具。',
    } : {}),
    ...(pickup ? { pickup } : {}),
    ...(drops.length ? { drops } : {}),
    /* 服务端把这一格发成了**液体**（冰挖掉就是水，海草/海带也是）⇒ 破坏**成功**了，只是液体立刻涌了进来。
     * 单独说一句，免得模型把它当成"服务端复原 / 没挖掉"再挖一次。 */
    ...(rest?.kind === 'liquid' ? {
      note: `这一格现在是 **${rest.name}**（液体立刻涌了进来）—— 这次破坏是**成功**的，不是"服务端复原"。`
        + '挖到的东西按方块的正常掉落算；别当成没挖掉重挖一次。',
    } : {}),
    ...(localGone && confirmed === false ? {
      note: '本地世界已经清掉了，但**没收到服务端的破坏回包** —— 服务端很可能拒了这次破坏'
        + '（领地保护 / 权限 / 反作弊 / 太远），客户端这边却把方块写成空气了。'
        + '用 `mc_scan` 或 `mc_observe` 再确认一下，**别在空气上盖房、别走进你以为挖穿的墙**。'
        + (rolledBack ? '（我已经把本地那一格改回原样，免得寻路把它当成空洞）' : '')
        + DESYNC_HINT,
    } : {}),
    ...(localGone ? {} : {
      /* 🔴 审计 F2：这句必须让"预算用完"能被**文本**认出来（`timeout`/`budget` 规则），
       *    而且**不能**出现"没挖掉"三个字 —— 那三个字会先命中"明确失败"那条正则，
       *    于是真·时间到被记成"这一步失败了"，3 轮之后任务被误判成 blocked。 */
      note: timedOut
        ? `这一轮的时间用完了（挖了 ${callSecText()}，方块还在，手上是 ${held}${digMs != null ? `；这块按手上的东西要 ${(digMs / 1000).toFixed(1)} 秒` : ''}）`
          + '—— **这不是失败**，再叫一次 `mc_dig` 接着挖就行；换个对的工具、或换个更近的点位会更顺。'
        : `方块还在（${now}）—— 服务端可能拒了这次破坏，别当成挖掉了`,
    }),
  }
}

/* ────────────────────────────────────────────────────────────────────────────
 * 挖方块（`mc_dig` 的正文）—— 路线图第 ④ 条第四十刀从 `src\core.mjs` 搬出来。
 *
 * 一条路，没有兜底：**自己走过去 → 换对的工具 → `bot.dig()` → 等服务端的破坏回包 → 捡掉落物**。
 * 为什么把 collectBlock 那条路整个删掉、为什么够不着就如实说，见函数体里那两段长注释
 * （2026-10-08 实机：交给 collectBlock 会出现"挖完又复原 + 之后几分钟走不了路"）。
 *
 * 参数：`self` = McBot（读 `tasks` / `position` / `cfg`，调 `requireBot` / `callLeft` / `walkTo` /
 *       `interruptMove` / `log`），`ctx` = 十个私有回调（见 core 的 `#mineCtx()`）。
 * 判据：模块不 import `core.mjs`、不 import 游戏库（只认 `b.blockAt` / `b.dig` / `b.findBlocks` / `b.game`）。
 * ──────────────────────────────────────────────────────────────────────────── */

/* ── 挖阶梯（`mc_dig {mode:"stair"}`） ────────────────────────────────────────
 * 为什么不靠寻路器：A* 里「挖脚下直下」一层只要 `1 + digCost×digTime ≈ 9.8`，
 * 而斜着下要挖 3 格（≈ 3 倍），所以它永远选竖井。竖井挖完还基本用不了 ——
 * `getLandingBlock` 要求落差 ≤ maxDropDown(3)，深井中间没有落点，第二次就下不去。
 * 阶梯（每下一格横移一格）挖一次永久能上下，还不会摔伤。
 *
 * 几何（关键，少挖一格就卡住）：站在 y 层走过去的那一刻，身体占 fx 的 y 和 y+1，
 * 而目标站位是 y-1 ⇒ **前方必须挖空 3 格**（y-1 / y / y+1）。
 * 只挖 2 格（y-1、y）会让头卡在 y+1 上 —— 这正好是"最容易卡死的形状"。
 */
export const STAIR_MAX_STEPS = 64
/* 🔴 2026-11-02 审计（#19）：`STAIR_STEP_MS = 3000`（"每走一格最多 3 秒"）**全仓没读过** ——
 *   实际每步预算走的是下面的 `STAIR_WALK_MS`（1500ms）。套件还钉着 `=== 3000`，
 *   于是"断言绿着、行为早就不看它了"。已删。 */

/* 🔴 2026-10-27 实机（两个会话 115 次 `mode:"stair"` 调用，57 次报"卡住"= 50%，用户：「一半是失败的」）：
 *   其中 **41 次耗时 ≥9.5 秒** —— 每步平均 1.72 秒，10 秒预算只够 6 步，最后那一步必然越过预算边界：
 *   循环顶部只在**开始前**看预算，而每步的 `walkTo` 又单独给 3 秒，于是"时间到"被写成"卡住"
 *   （`!ok → reason = 'stuck'`）。模型看到"卡住"就去 mc_observe / 换方向，把还能接着挖的活丢掉。
 *   现在：每步走路预算跟着剩余时间走（`STAIR_WALK_MS`），剩余不够一步就直接收工成 `budget`。 */
export const STAIR_WALK_MS = 1_500
export const STAIR_MIN_STEP_MS = 1_200
/* 前方脚下是空的（地下矿洞遍地都是）时允许往下掉几格继续 —— 落差 ≤3 格不摔伤。
 *   以前一律 `reason = 'no-floor'` 整趟放弃（实机 31/115 = 27%，用户只能原地重叫、方向不变又撞同一堵）。 */
export const STAIR_DROP_OK = 3

/** 朝哪挖：给了目标 x/z 用主轴；给了 dir（"x+"/"x-"/"z+"/"z-"）直接用；都没给按当前朝向 */
export function stairDirOf (b, { pos = null, dir = null } = {}) {
  const p = b?.entity?.position
  if (!p) return null
  if (pos && (Number.isFinite(pos.x) || Number.isFinite(pos.z))) {
    const dx = (Number.isFinite(pos.x) ? pos.x : p.x) - p.x
    const dz = (Number.isFinite(pos.z) ? pos.z : p.z) - p.z
    if (Math.abs(dx) < 0.5 && Math.abs(dz) < 0.5) return null
    if (Math.abs(dx) >= Math.abs(dz)) return { x: dx > 0 ? 1 : -1, z: 0, name: dx > 0 ? 'x+' : 'x-' }
    return { x: 0, z: dz > 0 ? 1 : -1, name: dz > 0 ? 'z+' : 'z-' }
  }
  const m = /^([xz])([+-])$/.exec(String(dir ?? ''))
  if (m) {
    return m[1] === 'x'
      ? { x: m[2] === '+' ? 1 : -1, z: 0, name: String(dir) }
      : { x: 0, z: m[2] === '+' ? 1 : -1, name: String(dir) }
  }
  const yaw = Number(b?.entity?.yaw) || 0
  const vx = -Math.sin(yaw); const vz = -Math.cos(yaw)
  if (Math.abs(vx) >= Math.abs(vz)) return { x: vx >= 0 ? 1 : -1, z: 0, name: 'x' + (vx >= 0 ? '+' : '-') }
  return { x: 0, z: vz >= 0 ? 1 : -1, name: 'z' + (vz >= 0 ? '+' : '-') }
}

/** 前方脚下是空的时，往下找"能站的层"（走过去会掉下去，掉 1~3 格不摔伤）。
 *  返回 `{ stand, below }`（`stand` 是能站的那层 y，`below` 是脚下实心方块名）；
 *  底下是液体 `{ liquid: true }`；落差超过 `maxDrop` 或落点被堵 `null`（⇒ 调用方按 no-floor 停）。
 *  `blkAt(x, y, z)` 由调用方给（便于自检注假世界）。 */
export function stairDropOf (blkAt, fx, fy, fz, { maxDrop = STAIR_DROP_OK } = {}) {
  for (let stand = fy - 1; stand >= fy - maxDrop; stand--) {
    const below = blkAt(fx, stand - 1, fz)
    if (!below) return null
    if (isLiquid(below.name)) return { liquid: true }
    if (isAir(below.name)) continue
    /* 落点那格 + 它头顶必须是空的，否则是"掉进一格缝里"，不硬落 */
    const at = blkAt(fx, stand, fz)
    const head = blkAt(fx, stand + 1, fz)
    if (!at || !head) return null
    if (!isAir(at.name) || !isAir(head.name)) return null
    return { stand, below: below.name }
  }
  return null
}

export async function digStair (self, {
  pos = null, dir = null, targetY = null, maxSteps = STAIR_MAX_STEPS, budgetMs = 10_000,
} = {}, ctx = {}) {
  const b = self.requireBot()
  const start = b.entity.position.floored()
  /* 🔴 2026-10-25 实机 bug（Bluezi 报「我给了 y50 也给了 dir z+ 还是这句」）：
   *   说明里写"x/z 可选"，但 index.js 只在 x/y/z **三个都有**时才组 pos ⇒ 只给 y 时
   *   pos 是 null，这里就报"给 y"。改成 ty 独立参数：y 单独就能用，
   *   pos 只剩"朝哪个点挖"这一个用途（可以没有）。 */
  const ty = Number.isFinite(Number(targetY)) ? Math.floor(Number(targetY))
    : (pos && Number.isFinite(pos.y) ? Math.floor(pos.y) : null)
  if (ty == null) {
    throw new Error('挖阶梯要知道挖到哪一层：给 y（目标高度，整数格）。x/z 可选，用来说朝哪个方向挖。')
  }
  /* 往上 / 往下都能挖：目标 y 比现在高就是上升阶梯 */
  const up = start.y < ty
  let d = stairDirOf(b, { pos, dir })
  if (!d) throw new Error('算不出往哪挖：给 x/z（朝那个点挖）或 dir（"x+" / "x-" / "z+" / "z-"）。')
  if (up ? start.y >= ty : start.y <= ty) {
    return [`🪜 我已经在 y=${start.y}，目标 y=${ty} —— 不用挖了（换个目标 y 才有活干）。`]
  }

  const t0 = Date.now()
  const notes = []
  let cur = start.clone()
  let dug = 0; let steps = 0
  let reason = 'budget'
  const MAX = Math.min(Math.max(1, Math.floor(maxSteps)), 128)
  const blkAt = (x, y, z) => b.blockAt(new Vec3(x, y, z))

  /* 🔴 2026-11-05 用户：「dig stair 现在周围有空气就不挖，应该找最近的墙往上挖」。
   *   原来方向是固定的：正前方脚下是空的（矿洞/大洞）就判 `no-floor` 收工 ——
   *   可人明明站在岩体里，左边右边后面都是墙。
   *   现在往前挖不动时，先横着换一面墙继续（只排除“当前方向”和“正后方”，免得来回晃），
   *   换满 3 次还找不到墙才如实报 no-floor。 */
  /* 🔴 2026-11-05 用户：「不要自动换向，我要的是 ai 输入 x+，自动到靠近挖 x+ 的墙开始挖」。
   *   方向由 `dir` 锁死：这个方向前面没台阶面，就**沿这个方向走过去**找墙，
   *   绝不换面、也不绕到别的方向去挖（之前那套换面 + 四邻找墙被撤掉了）。 */
  const WALL_SCAN_AHEAD = 8
  /** 沿 dir 方向、WALL_SCAN_AHEAD 格以内，找一格“站上去、再往前一格就是能挖的墙”的位置。
   *  只沿 dir 扫（用户 2026-11-05：「不要自动换向，自动到靠近挖 x+ 的墙开始挖」）。 */
  /** 这一格能不能站人（脚位空 + 头顶空 + 脚下实心且不是液体）。
   *  ⚠️ 不能直接 import `movement.mjs` 的 `canStandAtWorld` —— 两个模块互相 import 会成环
   *  （2026-11-05 线上就是这样炸的：`Error: canStandAt is not defined`）。
   *  这里用 mining 自己已有的 `blkAt`/`isAir`/`isPassable`/`isSolidBlock` 就地判。 */
  const standOkAt = (x, yy, z) => {
    const feet = blkAt(x, yy, z)
    const head = blkAt(x, yy + 1, z)
    const under = blkAt(x, yy - 1, z)
    if (!feet || !head || !under) return false
    const free = (q) => isAir(q.name) || isPassable(q.name)
    return free(feet) && free(head) && isSolidBlock(under.name) && !isLiquid(under.name)
  }
  const findWallSpotAhead = (from, dir, isUp, maxR = WALL_SCAN_AHEAD) => {
    for (let r = 1; r <= maxR; r++) {
      const x = from.x + dir.x * r
      const z = from.z + dir.z * r
      if (!standOkAt(x, from.y, z)) continue
      const nx = x + dir.x; const nz = z + dir.z
      const footY = isUp ? from.y : from.y - 2
      const f = blkAt(nx, footY, nz)
      if (!f || f.boundingBox !== 'block' || isLiquid(f.name)) continue
      const ys = isUp ? [from.y + 1, from.y + 2, from.y + 3] : [from.y - 1, from.y - 2, from.y - 3]
      const col = ys.map((y) => blkAt(nx, y, nz))
      if (col.some((q) => !q || isLiquid(q.name))) continue
      if (!col.some((q) => !isAir(q.name) && canBreakNow(b, q))) continue
      return { pos: { x, y: from.y, z }, r, dir }
    }
    return null
  }
  /* 🔴 2026-11-05 实机（用户：「stair 还是会后退」+ 上一版我加的「先跳一次」）：
   *   `stepUp` 返回 ok 只代表“离地抬高了”—— 那一刻人还在空中（上升中或正要下落）。
   *   直接 `floor()` 取坐标会把 `cur` 记成空中高度（例如人跳起来瞬间记成 y=46），
   *   人随后落回 y=42 ⇒ 下一步的 `fy = cur.y + 1 = 47` 在头顶 5 格，跳不上去 ⇒ 反复失败；
   *   日志里就是「⬇ 这一步没上去，反而从 y=46 掉到 y=42」和「越挖越往后」。
   *   规矩：**取坐标前先等落地**（y 连续两次不变；最多等 maxMs）。 */
  const settleGround = async (maxMs = 500) => {
    const y0 = Number(b?.entity?.position?.y)
    if (!Number.isFinite(y0)) return b.entity.position.floored()
    const t = Date.now()
    let last = y0
    let still = 0
    while (Date.now() - t < maxMs) {
      await new Promise((r) => setTimeout(r, 50))
      const y = Number(b?.entity?.position?.y)
      if (!Number.isFinite(y)) break
      if (Math.abs(y - last) < 0.02) { still++; if (still >= 2) break } else still = 0
      last = y
    }
    return b.entity.position.floored()
  }

  while (steps < MAX) {
    /* 🔴 2026-11-05 用户：「不要自动换向，我要的是 ai 输入 x+，自动到靠近挖 x+ 的墙开始挖」。
     *   前方没台阶面 / 没落点时：沿当前 dir 走过去找一面墙再继续挖，绝不换面。
     *   找到了（走过去了）返回 true，调用方 `continue` 重来；找不到返回 false。 */
    /* 🔴 2026-11-05：`dirNameOf` 原来定义在被删掉的 `pickStairDirAt` 里（那次删 39 行换向死代码时一起没了），
     *   而 `huntAlongDir` 的日志还在用它 ⇒ 实机直接 `ReferenceError: dirNameOf is not defined`（第 4 次同类事故）。
     *   这类错误 `node --check` 查不出来（它只查语法），只能靠守门断言钉住“用了就得有定义”。 */
    const dirNameOf = (v) => (v.x > 0 ? 'x+' : v.x < 0 ? 'x-' : v.z > 0 ? 'z+' : 'z-')
    const huntAlongDir = async (whyText, isUp) => {
      if (budgetMs - (Date.now() - t0) < 3_000) return false
      const spot = findWallSpotAhead(cur, d, isUp)
      if (!spot) return false
      const restH = budgetMs - (Date.now() - t0) - 1_500
      if (restH < 1_000) return false
      notes.push(`🧭 ${whyText} —— 沿 ${dirNameOf(d)} 走到 ${spot.pos.x},${spot.pos.y},${spot.pos.z}（${spot.r} 格外，那边朝 ${dirNameOf(d)} 有墙）再接着挖`)
      try {
        const w2 = await self.walkTo(
          { x: spot.pos.x, y: spot.pos.y, z: spot.pos.z },
          { allowDig: false, budget: Math.min(3_000, restH), intent: 'stand' },
        )
        if (w2?.arrived !== true) notes.push(`⚠ 没走到那格：${w2?.hint ?? w2?.reason ?? '没给原因'}`)
      } catch (e) { notes.push(`⚠ 走过去抛错：${e?.message ?? e}`) }
      cur = b.entity.position.floored()
      return true
    }
    /* 剩余时间不够走一步 ⇒ 直接收工成 budget（不再让 walkTo 越过预算边界后误判 stuck） */
    if (budgetMs - (Date.now() - t0) < STAIR_MIN_STEP_MS) { reason = 'budget'; break }
    if (up ? cur.y >= ty : cur.y <= ty) { reason = 'done'; break }
    /* 本步起点：跳失败时人会朝后弹开一格，不能拿被弹开的坐标当新起点（否则下一步目标也跟着后退）。 */
    const cur0 = { x: cur.x, y: cur.y, z: cur.z }
    const fx = cur.x + d.x; const fz = cur.z + d.z
    /* 往上 / 往下各一步；脚下 (fy-1) 必须是实心（台阶面），不能踩空 */
    const fy = up ? cur.y + 1 : cur.y - 1
    /* 上下**都是 3 格高**（用户 2026-10-25「stair往上挖也是挖3格」）：
     * 走过去那一刻身体要占 fy / fy+1 两格，头顶再留 1 格 ⇒ 一律挖 fy / fy+1 / fy+2。 */
    const cells = [fy, fy + 1, fy + 2].map((y) => ({ x: fx, y, z: fz }))
    const names = cells.map((c) => blkAt(c.x, c.y, c.z)?.name ?? null)
    if (names.some((n) => n == null)) { reason = 'unloaded'; break }
    if (names.some((n) => isLiquid(n))) { reason = 'liquid'; break }
    const floor = blkAt(fx, fy - 1, fz)
    if (!floor) { reason = 'unloaded'; break }
    if (isLiquid(floor.name)) { reason = 'liquid'; break }
    /* 前方脚下是空的（矿洞）：不当场放弃 —— 挖完前面那几格再量落差，
     * 能下去就下去（`stairDropOf`），落差太大或底下有液体才停。 */
    /* 往下挖时前方脚下是空的：先看能不能安全落下去（stairDropOf），落不了就换一面墙。 */
    if (!up && isAir(floor.name)) {
      const dr0 = stairDropOf(blkAt, fx, fy, fz)
      if (!dr0) {
        if (await huntAlongDir(`前方 ${fx},${fy},${fz} 那边是空的（下去没有落点）`, false)) continue
        reason = 'no-wall'
        notes.push(`⛔ 沿 ${dirNameOf(d)} 往前 ${WALL_SCAN_AHEAD} 格都没有能往下挖的落点 —— 换一个 dir，或先用 mc_move 走到岩壁边上`)
        break
      }
    }
    const hollowAhead = !up && isAir(floor.name)
    /* 往上挖时前方脚下空着是"没台阶面"，不能套用往下掉那套。
     * 但别当场收工 —— 先横着找一面墙继续往上挖（用户 2026-11-05：「应该找最近的墙往上挖」）。 */
    /* 往上挖时前方脚下空着是"没台阶面"，不能套用往下掉那套。
     * 🔴 2026-11-05 用户：「不要自动换向，我要的是 ai 输入 x+，自动到靠近挖 x+ 的墙开始挖」
     *    ⇒ 方向由 `dir` 锁死：前方没台阶面就**沿这个方向走过去**找墙，
     *      不换面、也不绕到别的方向的墙上去（之前那套换面 + 四邻找墙已撤掉）。 */
    if (up && isAir(floor.name)) {
      if (await huntAlongDir(`前方 ${fx},${fy},${fz} 没有台阶面（踩不住）`, true)) continue
      reason = 'no-wall'
      notes.push(`⛔ 沿 ${dirNameOf(d)} 往前 ${WALL_SCAN_AHEAD} 格都没有能往上挖的墙 —— 换一个 dir，或先用 mc_move 走到岩壁边上`)
      break
    }
    /* 🔴 2026-10-26 实机（用户：「dig stair 往上挖还是只挖两格会被卡住」）：
     *   往上挖时只清了**前方**那 3 格，漏了"我自己得跳上去"这件事 —— 跳跃需要
     *   **自己站位上方 2 格净空**（脚从 y 抬到 y+1.25、头顶到 y+3）。从水平隧道往上挖时，
     *   自己头顶往往还是原岩 ⇒ 起跳就被顶回来，pathfinder 报 NoPath，而这一趟是
     *   `allowDig:false`（不许它自己挖）⇒ 一步就判 stuck，用户看到的就是"挖两格就卡住"。
     *   现在往上时先把头顶那 2 格清开；往下不用清（往下是掉/走下去，不跳）。 */
    if (up) {
      for (const hy of [cur.y + 1, cur.y + 2]) {
        const head = blkAt(cur.x, hy, cur.z)
        if (!head || isAir(head.name)) continue
        if (isLiquid(head.name)) { notes.push(`⚠ 头顶 ${cur.x},${hy},${cur.z} 是 ${head.name}，没挖`); continue }
        try {
          const r = await breakBlock(self, { x: cur.x, y: hy, z: cur.z }, ctx)
          if (r?.broken) dug++
        } catch (e) { notes.push(`⚠ 清头顶 ${cur.x},${hy},${cur.z} 没成：${e?.message ?? e}`) }
      }
    }

    for (const c of cells) {
      const blk = blkAt(c.x, c.y, c.z)
      if (!blk || isAir(blk.name)) continue
      try {
        const r = await breakBlock(self, c, ctx)
        if (r?.broken) dug++
      } catch (e) {
        notes.push(`⚠ 挖 ${c.x},${c.y},${c.z} 没成：${e?.message ?? e}`)
      }
    }

    /* 前方原来是空的 ⇒ 量落差，找能站的层（往前走会掉下去，1~3 格不摔伤） */
    let standY = fy
    if (hollowAhead) {
      const dr = stairDropOf(blkAt, fx, fy, fz)
      if (!dr) { reason = 'no-floor'; break }
      if (dr.liquid) { reason = 'liquid'; break }
      standY = dr.stand
      notes.push(`🕳 前方脚下是空的（矿洞），往前走会掉 ${cur.y - standY} 格到 y=${standY}`)
    }
    /* 每步走路预算跟着剩余时间走（以前固定 3 秒，最后一步必然越过总预算 ⇒ 被误判成卡住） */
    /* 🔴 2026-10-29：走下一步的时间不够就收工 —— 以前硬压的 600ms 下限会越过本轮截止时间 */
    const nbStep = needLeft(self, 600, Math.min(STAIR_WALK_MS, budgetMs - (Date.now() - t0)))
    if (!nbStep.ok) {
      reason = 'budget'
      notes.push(`⏱ ${insufficientText(nbStep, '走下一步')}`)
      break
    }
    const stepBudget = nbStep.budgetMs

    /* 🔴 2026-11-05 实机（用户：「stair 还是不去刚挖那格」「还是要跳两下才上去」）：
     *   阶梯的每一步都是“斜上一格”，而 vendor 的 A* 只生成**四方向**的 JumpUp 边
     *   （`getMoveJumpUp` 没有斜向），横向那格又正是刚挖出来的台阶本体 ⇒ A* 一律给 noPath
     *   ⇒ 每步先白花 1.5~3 秒等 walkTo 失败，才轮到 stepUp 兜底；而 stepUp 的返回值当时
     *   没人看（失败也不说为什么），日志里只剩下“一步都没走动”。
     *   现在：先 bit 直接跳（stepUp 约 0.6 秒，比 A* 便宜），成功就走下一步；
     *   不行再让 A* 试，再不行最后再跳两次（用户实测第二下常常就上去了）。 */
    let hopWhy = null
    let hopped = false
    {
      const mv0 = await import('./movement.mjs').catch(() => null)
      if (mv0?.stepUp) {
        try {
          const su0 = await mv0.stepUp(b, new Vec3(fx, standY, fz), { allowDig: false })
          hopped = su0?.ok === true
          if (!hopped) hopWhy = su0?.why ?? null
        } catch (e) { hopWhy = String(e?.message ?? e) }
      }
    }
    if (hopped) {
      /* 刚跳起来时人在空中：必须等落地再取，否则 cur 记成空中高度（见 settleGround 注释） */
      const nowH = await settleGround(b, 700)
      const stoodH = up ? nowH.y >= standY : nowH.y <= standY
      /* 🔴 2026-11-05：高度对了还不够 —— 跳上**旁边**一格也算 `stoodH`，那正是“挖着挖着换位置”的来源
       *   （梯子越挖越歪）。必须真落在目标那一格（水平 ≤0.9 格）才算这一步成了。 */
      const stayedHere = Math.hypot(nowH.x - fx, nowH.z - fz) <= 0.9
      if (stoodH && stayedHere) {
        steps++
        if (up && nowH.y < cur.y) notes.push(`⬇ 这一步没上去，反而从 y=${cur.y} 掉到 y=${nowH.y}`)
        cur = nowH
        continue
      }
      if (stoodH && !stayedHere) {
        notes.push(`↪ 跳上去了但没落到 ${fx},${standY},${fz}（现站在 ${nowH.x},${nowH.y},${nowH.z}）—— 不算这一步`)
      }
    }

    /* 🔴 2026-11-05 实机（用户：「跳不上去，而且还是会后退」）：
     *   每步的目标是“斜上一格”，而 vendor 的 A* 只生成**四方向** JumpUp 边，斜上永远 noPath
     *   ⇒ 它转而算“绕过去”的路，那条路常常先往回走 / 绕圈 —— 用户看到的就是「后退」。
     *   所以：需要抬升的这一步**只跳，不问 A***（同层或往下才走 walkTo）。 */
    const needRise = up && standY > fy
    let w = null
    if (!needRise) try {
      /* 🔴 2026-10-28 参数审计：这里原来写 `budgetMs:` —— `walkTo` 只认 `budget`，
       *    多出来的键被静默丢掉，于是每步走路都用上了 `cfg.moveBudgetMs` 兜底值（40 秒），
       *    一步就把整个 dig 调用的时间吃光，回来只会报"时间到/卡住"。 */
      w = await self.walkTo({ x: fx, y: standY, z: fz }, { allowDig: false, budget: stepBudget, intent: 'stand' })
    } catch (e) {
      notes.push(`⚠ 走过去失败：${e?.message ?? e}`)
    }
    steps++
    let now = await settleGround(b, 400)
    /* 🔴 2026-11-05 实机（用户：「现在完全反着走了」）：原来这里写 `Math.abs(now.y - standY) <= 1`
     *   —— 往上挖时 standY = cur.y + 1，人**没上去、还在 cur.y** 也满足 |差| = 1 ⇒ ok = true
     *   ⇒ 报"推进 1 格"、`cur` 停在原地、下一轮再挖同一格。而且 `w.arrived` 也可能因为
     *   walkTo 自己的 arrive 容差给出同样的假成功。
     *   往上必须真到高度（now.y >= standY），往下必须真降到（now.y <= standY）。 */
    const stoodOk = () => (up ? now.y >= standY : now.y <= standY)
    /* needRise 的那一步没有 w（没问 A*），卡住文案里的“寻路说 …”要跳过 */
    let ok = !needRise && (w?.arrived || (now.x === fx && now.z === fz)) && stoodOk()
    if (!ok && !needRise && budgetMs - (Date.now() - t0) >= STAIR_MIN_STEP_MS) {
      /* 🔴 一次没上去就**再试一次**，别一步就判死。两个原因：
       *   ① movement 的上台阶动作是"先单独起跳、再叠 forward"（STEP_UP_JUMP_MS），
       *      窄井里第一次常常差一点；
       *   ② 刚清开的头顶方块可能还没同步到本地世界，第一次跳当然被顶回来。
       * 以前这里一次失败直接 `stuck` + break —— 用户看到的就是"卡住"。 */
      try {
        const w2 = await self.walkTo({ x: fx, y: standY, z: fz }, { allowDig: false, budget: stepBudget, intent: 'stand' })
        now = await settleGround(b, 400)
        ok = (w2?.arrived || (now.x === fx && now.z === fz)) && stoodOk()
      } catch (e) { notes.push(`⚠ 再走一次也没成：${e?.message ?? e}`) }
    }
    /* 位置轨迹：往上挖却往下掉是实机反馈里最费解的一种（用户 2026-11-05「完全反着走了」），
     * 只在不升反降时记一行，正常推进时不占输出。 */
    if (up && now.y < cur.y) notes.push(`⬇ 这一步没上去，反而从 y=${cur.y} 掉到 y=${now.y}`)
    /* 🔴 2026-11-05（用户：「stair 为什么一直会后退」）：原来是 `cur = now` —— 每一步失败都把进度锚点
     *   改写成“人的真实位置”。锚点一退，下一步的目标格就跟着退 ⇒ 越挖越往回走（正反馈）。
     *   现在：**锚点只前进**（只有真成功才更新），失败一律不动。 */
    if (ok) cur = now
    if (!ok) {
      /* 🔴 2026-11-05 实机（用户：「如果 dig stair 没跳上去会后退」「dig stair 现在挖着挖着会换位置挖」）：
       *   跳失败最常见的副作用是人被顶开一两格。这里试过“先走回原位再试同一格”，但**实机证明这更糟**：
       *   走回去那步本身也会失败（正是同一个跳不上去的原因），而代码不看走没走到就把 `cur` 改回原点
       *   ⇒ 于是“目标格按 A 算、人却站在 2 格外的 B”，之后每次 stepUp 都在跳一个够不着的格子，
       *   日志里就是「↪ 前方脚下是空的 → 换一面墙 → 又换回来」「跳上去三次都没成（no-step / wall）」。
       *   现在的规矩：**`cur` 永远取人的真实位置**；走回原位只是“试着把位置摆正”，成败都无所谓。 */
      const off = Math.hypot(now.x - cur0.x, now.z - cur0.z)
      const restB = budgetMs - (Date.now() - t0)
      if (off >= 0.6 && restB > 2_500) {
        notes.push(`↩ 没跳上去还被顶开了 ${off.toFixed(1)} 格（${now.x},${now.y},${now.z}）—— 试走回 ${cur0.x},${cur0.y},${cur0.z}`)
        let backOk = false
        try {
          const bck = await self.walkTo({ x: cur0.x, y: cur0.y, z: cur0.z }, { allowDig: false, budget: Math.min(2_000, restB - 1_000), intent: 'stand' })
          backOk = bck?.arrived === true
        } catch (e) { notes.push(`⚠ 走回原位那步抛错：${e?.message ?? e}`) }
        const real = await settleGround(b, 300)
        if (backOk) notes.push(`↩ 已经走回 ${real.x},${real.y},${real.z}`)
        else notes.push(`⚠ 没走回原位（现站在 ${real.x},${real.y},${real.z}）—— 下一步仍然按原锚点算，不跟着退`)
        /* 🔴 2026-11-05：这里原来 `cur = real`（以及 else 分支 `cur = b.entity.position.floored()`）——
         *   正是“一直后退”的直接来源。回不去原位时，把锚点改成人的实际位置只会让目标一步步往后挪。
         *   `cur` 保持不动：这一步没成就是没成，下一轮还打同一格。 */
      }
      /* 🔴 时间到被砍断 ≠ 卡住。剩余时间不够再走一步时如实报 budget；
       *   说成"卡住"会让模型去 mc_observe / 换方向，把本来接着叫一次就能挖完的活丢掉。 */
      if (budgetMs - (Date.now() - t0) < STAIR_MIN_STEP_MS) { reason = 'budget'; break }
      /* 🔴 2026-10-29 实机（18,66,2 → 18,67,1：脚位 air、头顶 air、自己头顶 air，挖开了却上不去）：
       *   两次 walkTo 都没成时，别再干等 A* —— 直接照"一格台阶"用 movement 的上台阶原语硬跳一次。
       *   `stepUp` 不走 A*（只做"转向 → 起跳 → 叠 forward"），A* 判定过严时它就是那条活路。
       *   动态 import：避免 mining ↔ movement 的静态循环依赖。 */
      try {
        const mv = await import('./movement.mjs')
        for (let k2 = 0; k2 < 2; k2++) {
          const su = await mv.stepUp(b, new Vec3(fx, standY, fz), { allowDig: false })
          if (su?.ok) break
          hopWhy = su?.why ?? hopWhy
        }
      } catch (e) { hopWhy = String(e?.message ?? e) }
      now = await settleGround(b, 400)
      if (now.x === fx && now.z === fz && stoodOk()) { cur = now; continue }
      /* 已经到目标高度了就别报卡住：`y` 到了就算这一趟干完了（用户 2026-10-29：「它挖到地表了，然后就报了」） */
      if (up ? now.y >= ty : now.y <= ty) { reason = 'done'; break }
      reason = 'stuck'
      /* 真卡住要自带诊断：卡在哪、目标格上下通不通、自己头顶两格、寻路自己怎么说 —— 省掉一趟 mc_observe。
       *   以前只报"脚位/头顶 + 自己头顶一格"，于是出现过「自己头顶是 air」却写「多半是头顶堵着」的自相矛盾。 */
      const atName = blkAt(fx, standY, fz)?.name ?? '未加载'
      const headName = blkAt(fx, standY + 1, fz)?.name ?? '未加载'
      const floorName = blkAt(fx, standY - 1, fz)?.name ?? '未加载'
      const myHead1 = blkAt(cur.x, cur.y + 1, cur.z)?.name ?? '空气'
      const myHead2 = blkAt(cur.x, cur.y + 2, cur.z)?.name ?? '空气'
      const wWhy = w?.reason ?? w?.why ?? null
      notes.push(`⛔ 卡在 ${cur.x},${cur.y},${cur.z}：要去的 ${fx},${standY},${fz} 脚位是 ${atName}、头顶是 ${headName}、脚下是 ${floorName}；自己头顶是 ${myHead1}/${myHead2}${wWhy ? `；寻路说 ${wWhy}` : ''}${hopWhy ? `；跳上去三次都没成（${hopWhy}）` : ''}`)
      break
    }
    /* 平台已去掉：每步都是下降步 */
  }

  const now = b.entity.position.floored()
  const left = up ? ty - now.y : now.y - ty
  /* 🔴 2026-10-27（用户 m02756「这个会话的 dig 和 move 根本不准确」；实测 session-514c21b6）：
   *    以前不管挖没挖都写「挖了 N 步、M 块方块」⇒ 出现过「**挖了 23 步、0 块方块**」这种
   *    自相矛盾的话（真实情况是一路沿着早先挖好的阶梯**走**上去的，一块没挖）。
   *    挖了 0 块就别提"挖"，如实说走了几步。 */
  const body = dug > 0
    ? `挖了 ${steps} 步、${dug} 块方块，从 y=${start.y} 到 y=${now.y}`
    : `走了 ${steps} 步（没挖方块，沿已有通道），从 y=${start.y} 到 y=${now.y}`
  const climbed = now.y - start.y
  const tail = {
    done: '✅ 到目标高度了。',
    budget: `⏱ 这一轮分到的时间用完了（这次 ${Math.round(budgetMs / 1000)} 秒）—— 再叫一次 \`mc_dig {mode:"stair", y:${ty}}\` 接着挖（已经挖好的不会白挖）。`,
    liquid: '🌊 前面是水/岩浆，不往那边挖了 —— 换个方向（`dir:"x-"` 之类）或者先绕开。',
    'no-floor': '🕳 前面脚下是空的，落差超过 3 格（怕摔、也怕下面是深洞或岩浆）—— 换个方向（`dir:"x-"` 之类），或者先看看那边是什么。',
    /* 🔴 2026-10-27：`stuck` 原来写死成"挖开了但没走过去（卡住）"——每轮明明已经推进了
     *    5 格（y 75→70、70→65）也照样这么报，模型以为整轮白干。按"到底有没有推进"分开说。 */
    stuck: climbed !== 0
      ? `⛔ 最后一步没走成，但这一轮已经从 y=${start.y} 走到 y=${now.y}（推进 ${Math.abs(climbed)} 格）—— 再叫一次 \`mc_dig {mode:"stair", y:${ty}}\` 接着挖，挖好的不会白挖。`
      : `⛔ 一步都没走动（还停在 y=${now.y}）—— 下面那行是当时各方块的真实情况（脚位/头顶/脚下/自己头顶两格/寻路的原因），照它决定下一步：缺台阶面就换方向、头顶堵着就先清、别原地重叫。`,
    unloaded: '⏳ 前面的区块还没加载完 —— 等一下再叫。',
  }[reason] ?? ''
  const hint = reason === 'done' ? '' : `
还剩 ${Math.max(0, left)} 格到 y=${ty}。`
  return [`🪜 阶梯：${body}。${hint}`, tail, ...notes].filter(Boolean)
}

export async function dig (self, {
  name = null, pos = null, maxDistance = 6, count = 1, allowDangerous = false, noClear = false,
  /* 2026-10-23 用户实机（「挖矿老是乱挖 / 够得到还搭方块」）：
   *   allowDig：走过去这一路允不允许挖穿挡路的方块。默认 false（只绕路、不挖墙）——
   *     以前是 false，为了够到墙后的矿，pathfinder 会顺手把一路石头泥土全挖了，
   *     在用户眼里就是"乱挖"。确实要挖穿（矿在墙后）就用 `allowDig:true` 再叫一次。
   */
  allowDig = false,
  mode = 'block', dir = null, targetY = null, maxSteps = STAIR_MAX_STEPS, budgetMs = 10_000,
} = {}, ctx = {}) {
  /* 2026-10-25 用户：「下矿时 AI 更倾向直上直下，而不选择挖阶梯」⇒ stair 模式。 */
  if (mode === 'stair') return await digStair(self, { pos, dir, targetY, maxSteps, budgetMs }, ctx)
  const b = self.requireBot()
  const out = []
  const held0 = heldText(b)
  /* 🔴 2026-10-19 实机：**只给 pos 又给 count>1** 时，第二格开始 `want` 取的是
   *    `blockAt(pos).name` —— 而那格刚被挖空，读回来是 `air`，于是 `findBlocks` 抓一堆**空气**
   *    当目标（返回里就成了"（12,-60,28）已经不在了"那样的话）。
   *    指定坐标的语义本来就是"挖这一格"，count 在这里没有意义 ⇒ 直接按 1 处理。 */
  const n = Math.min(Math.max(pos ? 1 : count, 1), 16)
  /* 水/岩浆是**流体**，挖不掉（`mc_dig water` 只会白花一次调用，日志里留一条
   * "破坏 water 这一轮的时间用完了"）。淹死时的正确动作是**上浮换气**，不是挖水。 */
  const fluid = name ?? (pos ? b.blockAt(new Vec3(pos.x, pos.y, pos.z))?.name : null)
  if (fluid && isLiquid(fluid)) {
    throw new Error(`${fluid} 是流体，挖不掉 —— 想从水里出来：直接 mc_move 朝岸边走`
      + '（游泳时会自己按住 jump 浮在水面，不会沉）；不知道岸在哪就先 mc_scan 找最近的干燥方块。')
  }
  // 先把要挖的方块列出来（collectBlock 要一份目标清单，它自己会走过去 + 捡掉落物）
  /* 📋 任务记账（用户 2026-10-08 路线图第 ②③ 条）：**一次要挖 4 个以上 = 一件"活儿"**。
   * 开工时落一条任务到 `<记忆根>/tasks.json`，以后每次 mc_dig 都接到同一个任务上：
   *   - 模型不用自己记"我挖到第几个了"（进度在磁盘上，掉线重连也在）；
   *   - 收工时把失败**分类**（够不着 / 服务端不认 / 没工具 / 时间用完了），
   *     同一个原因连着 3 次就把任务标成"卡住"，别让它原地死磕（用户要的"循环检测"）。
   * 只要 1 个（或只给 pos）就不建任务：那种调用不需要记账，建了只是噪声。 */
  const task = (name && n >= 4) ? self.tasks.auto({ kind: 'dig', item: name, total: n, params: { maxDistance } }) : null
  if (task) self.tasks.checkpoint(task.taskId, { position: self.position, have: ctx.taskHave(name) })
  const targets = []
  for (let i = 0; i < n; i++) {
    if (pos && i === 0) {
      const one = b.blockAt(new Vec3(pos.x, pos.y, pos.z))
      if (!one) throw new Error(`(${pos.x},${pos.y},${pos.z}) 未加载`)
      targets.push(one)
      continue
    }
    /* 走到这里一定是"按 name 找"：只给 pos 的在上面的 `i === 0` 分支就 continue 了，
     * 而给了 pos 时 `n` 已经压成 1，不会有第二格。以前这里会回退去读 pos 那格的方块名，
     * 读到的是**刚挖空的 `air`** —— 于是抓一堆空气当目标（见上面 `n` 那段注释）。 */
    if (!name) throw new Error('需要 name 或 pos')
    const want = name
    const found = typeof b.findBlocks === 'function'
      // ⚠️ mineflayer 4.39 的 findBlocks 返回的是**坐标**（{x,y,z}），不是方块对象
      //    （blocks.js:212 里 findBlock 才是 blockAt(blocks[0])）——所以要自己转回方块
      ? b.findBlocks({ matching: (blk) => blk?.name === want, maxDistance, count: n - targets.length })
        .map((p) => b.blockAt(new Vec3(p.x, p.y, p.z)))
        .filter((blk) => blk && blk.name === want)
      : [b.findBlock({ matching: (blk) => blk?.name === want, maxDistance })].filter(Boolean)
    if (!found.length) { out.push(`附近找不到 ${want}`); break }
    for (const f of found) if (!targets.includes(f)) targets.push(f)
    if (targets.length >= n) break
  }
  if (!targets.length) {
    // 一个目标都没找到：这是**真的**做不成（`no-target`），记一笔 —— 连着三次就说明该换地方了
    if (task) self.tasks.fail(task.taskId, { action: 'dig', reason: out[out.length - 1] ?? `附近找不到 ${name}` })
    return out
  }

  /* 🔴 按距离从近到远排（显式给的那个 pos 仍排第一）：
   * 2026-10-08 用户转来的实机反馈 —— "mc_dig 挑到够不着的目标就超时"。
   * findBlocks 的返回顺序不保证是最近的，第一个够不着就能把整轮 11 秒吃光。
   */
  const distOf = (blk) => { try { return b.entity.position.distanceTo(blk.position) } catch { return Infinity } }
  /* 2026-10-23 用户实机（「挖矿老是乱挖 / 明明够得到还搭方块」）：
   *   原来只按**脚到方块**的距离排 —— 墙后面那格永远"更近"，于是挑中的目标 A* 根本没路
   *   （能站的格子在墙的另一侧），绕死 → 脱困阶梯 → 垫柱搭方块。
   *   现在分三层挑：① 已经够得着（眼睛→方块中心 ≤ 4.5）一步都不用走；
   *                ② 同一层（|dy| ≤ 2）走过去不用爬高爬低；③ 剩下一律按距离。
   *   同一层里仍是"近的先挖"，矿脉一片一片挖的手感不变。 */
  const mineReachLimit = b.game?.gameMode === 'creative' ? 5.0 : 4.5
  const tierOf = (blk) => {
    let reach = Infinity
    try { reach = blockReachOf(b, blk) } catch {}
    if (Number.isFinite(reach) && reach <= mineReachLimit) return 0
    const dy = Math.abs(Number(blk?.position?.y) - Number(b.entity?.position?.y ?? 0))
    return Number.isFinite(dy) && dy <= 2 ? 1 : 2
  }
  if (targets.length > 1) {
    const pinned = pos ? targets[0] : null
    const rest = targets.filter((t) => t !== pinned)
      .sort((a, c) => (tierOf(a) - tierOf(c)) || (distOf(a) - distOf(c)))
    targets.length = 0
    targets.push(...(pinned ? [pinned, ...rest] : rest))
  }

  /* 🔴 手上（背包里）没有能挖它的工具就别动手：
   * ① 硬挖石头/矿石不掉东西，白耗十几秒，还容易被误当成"挖到了"；
   * ② mineflayer-collectblock 挖之前会拿 `{requireHarvest:true, getFromChest:true}` 去问
   *    mineflayer-tool 要工具，而那个插件在 chestLocations 为空时**无限递归** →
   *    JS 堆十几秒涨到几 GB 直接 OOM，而且全在微任务里跑，连 withTimeout 都不会触发。
   *    （vendor 树里已经给 mineflayer-tool 打了补丁，这里再挡一道，别白跑。）
   */
  if (b.game?.gameMode !== 'creative') {
    const inv = b.inventory.items()
    const canHarvest = (blk) => !blk?.harvestTools || inv.some((it) => blk.harvestTools[it.type])
    if (!targets.some(canHarvest)) {
      const blk = targets[0]
      const why = `背包里没有能挖 ${blk.name} 的工具（${toolKinds(b, blk)}）—— 先 mc_craft 一把（木镐 = 3 木板 + 2 木棍），再叫我挖`
      if (task) self.tasks.fail(task.taskId, { action: 'dig', reason: why })
      return [why]
    }
  }

  // ① 有 mineflayer-collectblock 就交给它：走过去 → 挖 → 捡掉落物（换工具它内部用 mineflayer-tool）
  // 🔴 **一次只喂一个目标**：collectBlock 内部是个 for 循环，任何一个目标寻路失败都会把整批带崩
  //    （2026-10-06 实机：挖 4 根原木只拿到 1 根，其余全因 "Took to long to decide path to goal!" 丢掉）。
  //    逐个喂 + 逐个 catch：坏目标跳过，好目标照挖。
  /* 🔴 用 `self.callLeft()` 而不是 `callDeadline()`：本轮已经用掉的时间要算进去
   *    （`mc_sequence` 里"走一段再挖"时，挖只剩 1 秒，不能又给整整 11 秒）。
   * 🔴 再**留 900ms 收尾**（2026-10-08 实机反馈：`mc_dig` 报 `Error: tool call timed out after 6000ms`，
   *    方块其实早挖掉了）。收尾包括：`#cancelCollect` 等 `collectBlock_finished`、
   *    兜底原地挖、拼返回文本、DSH 层序列化 —— 这些以前都排在预算之外，
   *    两个目标就是 2×1.5 秒，整轮直接冲出工具超时，模型只拿到一个没有信息的硬错误。 */
  const callLeftMs = self.callLeft()
  const deadline = Date.now() + Math.max(0, callLeftMs - 900)
  /* 🔴 2026-10-17（实机：「mc_sequence 会假失败：秒回报 stoppedAt:0 / 本轮时间不够，但方块其实已经挖掉了」）：
   *    `callLeft()` 太小 ⇒ `leftOf()` 一上来就 < 900 ⇒ **一个都不挖**。
   *    这是"没做"，不是"没做成" —— 两件事必须分开说（踩坑档案第 107 条），
   *    否则模型会把已经挖掉的再挖一遍、或者以为"这矿挖不动"。 */
  const noBudget = callLeftMs <= 900
  const leftOf = () => deadline - Date.now()
  /* 🔴 2026-10-08 实机（用户「挖矿还是会」）：**`dig()` 不再把方块交给 mineflayer-collectblock**。
   *    collectBlock 走过去用的是 `goals.GoalLookAtBlock`（vendor CollectBlock.js:30）—— 只要**看得见**
   *    就算"到了"，站 6 格开外也算到，然后 `bot.dig()` 从够不着的地方挖：
   *    服务端按"眼睛→方块中心 ≤4.5"拒收，而 mineflayer 的 `finishDigging()`（digging.js:158）
   *    已经把**客户端**那格写成 air ⇒ 画面上就是"挖完又复原"；
   *    更糟的是服务端不回 air 方块更新 ⇒ `diggingTask` 永远不 resolve ⇒ 采集任务永远挂着
   *    （`collectBlock_finished` 不 emit）⇒ 之后几分钟走不了路（实机日志 02:38–02:43 连打 20 次
   *    "上次的采集任务还在后台跑"，机器人整整 5 分钟没挪窝）。
   *    现在统一成一条路：**自己走到方块旁边**（`walkTo` 的 pathfinder 带 canDig，能挖穿挡路的），
   *    再按"眼睛→方块中心"复核，够得着才 `bot.dig()`，而且**认服务端的破坏回包**；
   *    掉落物由 `#grabDrops` 捡（原来靠 collectBlock 顺手捡）。 */
  let okCount = 0   // 这一轮挖到几个（下面那条兜底路径也要用，所以放在块外）
  /* 🔴 2026-10-29（用户给的输出规范：挖掘"将逐项流水改为汇总"）：
   *   成功块不再逐个 push 一行，先收在这里，收工时合并成一行（单块仍按原样写，行为断言不受影响）。
   *   失败行照旧逐条 push —— 失败原因和方块名是模型下一步要用的，不能汇总掉。 */
  const okLog = []
  let budgetCut = false   // 是不是"时间用完了"提前收工的（那条路自己会说"还有 N 个没挖"）
  /* 🔴 2026-10-17（用户报"工具排队执行、延迟很大"）：一次调用是**原子**的。
   *    实机那次：12 个 break 挖竖井 → 骷髅跟下来一路射 → AI 要等 10 秒过完才知道
   *    （日志里 `mc_auto：zombie 贴上来 → 已叫醒 AI` 比这条调用结束早 5 秒）。
   *    挖矿是最容易招怪的场景（挖穿到洞穴、没插火把），所以每个目标之前查一次。 */
  const stopOnDanger = self.cfg?.stopOnDanger === true
  const noticed = new Set()
  const hp0 = healthOf(b)
  {
    /* 🔴 2026-10-08 审计④：`interruptMove()` 以前是**死代码**（定义了没人调），而文档说 mc_dig 靠它抢占。
     *    走路/采集会按着 forward、占着 pathfinder ⇒ 先把还在跑的移动真停掉，再领号。 */
    await self.interruptMove()
    ctx.beginMove('dig')
    let seen = 0
    const reachMax = b.game?.gameMode === 'creative' ? 5.0 : 4.5
    /* 🔴 2026-10-29（用户：「mc_dig coal_ore 挖几块后会开始挖其他地方的矿，但最近的并没有挖完」）：
     *   以前候选是**一次性**扫出来的（`findBlocks(count:n)`），挖掉一块之后**不重扫** ——
     *   于是矿脉被挖开、旁边露出新矿时，它还在按旧名单去挖远处那几块。
     *   现在每挖到一块就**重扫一次**，按“够得着 > 同一层 > 距离”重排，近的永远排前面。 */
    const queue = targets.slice()
    const tried = new Set()
    /* 🔴 2026-10-29（用户：「这个等挖矿结束后最后检查」）：
     *   掉落物吸附**不再逐块等** —— 整轮挖完统一检查一次（见循环后的 `lastDig` 那块）。
     *   这里只记最后一次挖的位置，供那次检查当"该看哪儿"的参照。 */
    let lastDig = null
    const cellKeyOf = (blk) => {
      const q = blk?.position ?? blk ?? {}
      return `${q.x},${q.y},${q.z}`
    }
    /* 🔴 2026-10-29（用户：「挖矿和之前比也加了延迟，挖石头没这个感觉」）：
     *   每挖一块就 `findBlocks` 一次，半径一开就是几十格 ⇒ 每块都多几十毫秒的扫描，
     *   一整片矿挖下来就是明显的"变慢"；挖石头走的是单块/隧道，所以没这感觉。
     *   减负两条：
     *   ① **队首还在脚边（≤3.5 格）就不扫** —— 这正是"先把这一片挖完"要的效果，
     *     连续挖同一片矿脉时一次扫描都不用；
     *   ② 真要扫时只扫**近处**（`DIG_RESCAN_RADIUS`），远处那几块本来也不该插队。 */
    const DIG_RESCAN_RADIUS = 12
    const queueNear = () => {
      const first = queue[0]
      if (!first) return false
      try { return distOf(first) <= 3.5 } catch { return false }
    }
    const rescan = (wantName) => {
      const rest = n - okCount
      if (rest <= 0 || !wantName || typeof b.findBlocks !== 'function') return
      const found = b.findBlocks({
        matching: (blk) => blk?.name === wantName,
        maxDistance: Math.min(maxDistance, DIG_RESCAN_RADIUS),
        count: Math.max(4, rest * 2),
      }).map((q) => b.blockAt(new Vec3(q.x, q.y, q.z)))
        .filter((blk) => blk && blk.name === wantName && !tried.has(cellKeyOf(blk)))
      if (!found.length) return
      found.sort((a, c) => (tierOf(a) - tierOf(c)) || (distOf(a) - distOf(c)))
      queue.length = 0
      queue.push(...found)
    }
    while (queue.length > 0 && okCount < n) {
      if (okCount > 0 && !queueNear()) rescan(name)
      const target = queue.shift()
      if (!target) break
      tried.add(cellKeyOf(target))
      seen++
      /* 挨打了 / 有怪贴脸 ⇒ **立刻**把控制权还回去（这个目标没挖）。放在预算检查**之前**：
       * 还剩 8 秒也不该继续挖 —— 怪已经站到脸上了。 */
      const danger = dangerNow(b, { hp0 })
      if (danger) {
        /* 🔴 2026-10-19 用户：「不要打断只提醒」—— 默认**不再**因为险情收工：
         *    挖竖井那种活一停就得重来一遍（还要重新看脚下是不是 air），
         *    而险情本身由反射层（`mc_auto`）的叫醒去处理。这里只留一句话。
         *    想恢复旧行为（立刻停手）把 config.stopOnDanger 设成 true。 */
        if (stopOnDanger) {
          out.push(`⚠️ ${dangerText(danger)} —— 先别挖了（挖到 ${okCount}/${n}），`
            + '`mc_attack` 打掉它，或者 `mc_move` 躲开；安全了再叫一次 mc_dig')
          break
        }
        const k = noticeKey(danger)
        if (!noticed.has(k)) {
          noticed.add(k)
          out.push(`${dangerNotice(danger)}（挖到 ${okCount}/${n}）`)
        }
      }
      // 🔴 单次调用 ≤11 秒：到点就带着已经挖到的结果返回，剩下的下次再叫
      const left = leftOf()
      if (left < 900) {
        out.push(noBudget && okCount === 0
          ? `—— 这次调用**自己没分到时间**（外层只剩 ${callLeftMs}ms），**一个都没挖**。`
            + '**这不等于那些方块还在**：先 `mc_scan` / `mc_map` 复核一下到底挖掉没有，'
            + '确认真没挖再单独叫一次 mc_dig（**别塞在 mc_task 里** —— 外层时间早被前面的步骤吃掉了）。'
          : `—— 这一轮的 ${callSecText()}用完了（挖到 ${okCount}/${n}），`
            + `还有 ${Math.max(0, n - okCount)} 个没挖：再叫一次 mc_dig 接着挖`)
        budgetCut = true
        break
      }
      // 🔴 别让**一个**够不着的目标吃掉整轮：单个目标最多给"剩余时间的一大半"，
      //    剩下的时间留给后面的目标 + 兜底原地挖（2026-10-08 实机反馈）。
      /* 🔴 2026-10-29：单个目标的最小有效时间是 1 秒（挖一块 + 回读确认），
       *    不够就整轮收工 —— 别用 `Math.max(300, …)` 硬压出预算来。 */
      const nbGo = needLeft(self, 1_000, Math.min(
        callBudget(self.cfg.collectBudgetMs), Math.max(1_000, Math.floor(left * 0.6))))
      if (!nbGo.ok) {
        out.push(insufficientText(nbGo, '走到这个方块旁边'))
        budgetCut = true
        break
      }
      const budget = nbGo.budgetMs
      const p = target.position.clone()
      const nm = target.name
      /* 够不着 → **先自己走过去**（以前这一步交给 collectBlock，而它只要"看得见"就算到）。
       * 🔴 判据必须是 `#reachOf`（**眼睛 → 方块中心**，服务端也是这么判的），不是脚到方块坐标：
       *    用脚算的话，正下方 4 格的石头会被判"够得着"，原地挖一发服务端根本不认。
       * 🔴 走到方块**自己那一格**（x+0.5 / y / z+0.5）再复核：走过去这一路 pathfinder 可能顺手
       *    把它挖穿（`canDig`），所以到地方必须重新读一次方块。 */
      let fresh = b.blockAt(p)
      /* 🔴 2026-10-15 审计：以前这里是一句 `continue` —— 方块读不到（区块卸载）或已经不在时
       *    一个字都不输出，模型只看到结果里少了一项，不知道是"没这块"还是"插件跳过了"。 */
      if (!fresh) {
        out.push(`${nm} @ ${p} 读不到（区块没加载）—— 先 \`mc_move\` 靠近让区块加载，再叫我挖`)
        continue
      }
      if (fresh.name !== nm) {
        out.push(`${nm} @ ${p} 已经不在了（现在 ${fresh.name}）—— 别人挖走了，或刚才已经挖掉`)
        continue
      }
      if (blockReachOf(b, fresh) > reachMax) {
        /* 2026-10-23：落点以前是**矿块自己那一格**（嵌在石头里），由 standPointFor 挪到
         *   "离矿最近的可站格" —— 那个格子可能在墙的**另一侧**，A* 永远没路，于是绕死/垫柱。
         *   改成先自己算：矿块周围能站、且眼睛够得着（≤ reachMax）的格子里挑**离我最近**的，
         *   落点天然在墙的这一侧；一个候选都没有才退回老写法。 */
        const cell = mineApproachCell(b, p, reachMax)
        /* 口径和以前一致：x/z 取**格中心**（+0.5），y 是脚那一格。 */
        const stand = cell
          ? { x: cell.x + 0.5, y: cell.y, z: cell.z + 0.5 }
          : { x: p.x + 0.5, y: p.y, z: p.z + 0.5 }
        /* 🔴 2026-10-31 用户实机：「够不着 diamond_ore（眼睛到方块中心 5.2 格，走过去也没走到）」。
         *   挖东西只要站到 **reach 以内** 就行，不需要贴到 2.2 格 —— 固定 2.2 会让“能走到 3~4 格内”
         *   也判成“没走到”。改成跟着 reach 走（留 1 格余量）。 */
        const arrive = Math.max(1.2, reachMax - 1)
        const w = await self.walkTo(stand, { arrive, budget, allowDig })
        /* 🔴 2026-10-25 用户：「dig 如果没办法到那格应该自动切换成可破坏」——
         *   默认不挖（只绕路）走不过去时，**自动**改成允许挖穿挡路的方块再走一次。
         *   只在真的还够不着时重试，并且只用本轮剩下的时间（不把整轮吃光）。 */
        /* 🔴 2026-11-02 审计：这里以前**偷偷**把 `allowDig` 翻成 true 再走一遍 ——
         *   上层明确关掉的开关被代码自己打开（和刚删掉的「自动垫柱」同型），
         *   第一次"为什么走不过去"被第二遍结果盖掉，还吃掉整轮剩下的预算。
         *   现在不重试：走不过去就照下面那条「够不着」如实报（含"没挖墙 + 要挖就带 digThrough"）。
         */
        fresh = b.blockAt(p)
        /* 🔴 2026-10-15 审计：`b.blockAt(p)` 在**区块卸载**时返回 null，而以前 `!fresh` 和
         *    `fresh.name !== nm` 走同一条路 ⇒ 把"读不到"当成"走过去顺手挖掉了"，`okCount++`
         *    虚增、还把 `?` 当证据写进同一条消息。这两件事必须分开。 */
        if (!fresh) {
          out.push(`${nm} @ ${p} 走过去以后读不到了（区块没加载）—— **这一格没算挖掉**，`
            + '先 `mc_move` 靠近让区块加载再叫我复核')
          continue
        }
        if (fresh.name !== nm) {
          /* 2026-10-23 审计：名字变了不等于「我挖掉了」——可能被别的实体替换/炸掉。
           * 只有变成空气/液体才算这一格真被我挖掉了。 */
          if (!isAir(fresh.name) && !isLiquid(fresh.name)) {
            out.push(`走到 ${nm} @ ${p} 时那里已经是 ${fresh.name}（不是空气）—— **这一格没算挖掉**，`
              + '不是我挖的（被替换 / 炸掉 / 区块更新过了），要它的话指个新目标')
            continue
          }
          okCount++
          lastDig = p
          if (task) self.tasks.progress(task.taskId, { add: 1 })
          okLog.push({ nm, p, how: '顺手', now: fresh.name })
          continue
        }
        if (blockReachOf(b, fresh) > reachMax) {
          const away = blockReachOf(b, fresh)
          /* 🔴 2026-10-31：只说“够不着”没法判断是“它在脚下没选中”还是“真的远”。
           *   补上我站在哪、它相对我哪个方向几格。 */
          const mep = b.entity?.position
          const myY = mep ? Math.floor(mep.y) : null
          const dy = myY == null ? 0 : Math.floor(p.y) - myY
          const horiz = mep ? Math.hypot(p.x - mep.x, p.z - mep.z) : NaN
          const rel = mep
            ? `我站在 ${Math.floor(mep.x)} ${myY} ${Math.floor(mep.z)}，`
              + `它在${dy >= 1 ? `我上方 ${dy} 格` : dy <= -1 ? `我下方 ${-dy} 格` : '同一层'}`
              + `${Number.isFinite(horiz) && horiz >= 1 ? `、水平 ${horiz.toFixed(1)} 格外` : '、就在脚下'}`
            : '位置读不到'
          out.push(`够不着 ${nm} @ ${p}（眼睛到方块中心 ${away.toFixed(1)} 格，`
            + `${w?.arrived ? '走过去也只到这么远' : `走过去也没走到：${w?.reason ?? '没走到'}`}；${rel}）—— `
            + '先 `mc_move` 到它旁边（或换个近一点的目标）再叫我挖：站远了挖服务端不认，方块会"复原"。'
            + (allowDig !== true
              ? '（这趟是"不挖"模式 —— **我没有挖墙**；挡路的方块确实要挖开才过得去，就再叫一次 `mc_dig {digThrough:true}`）'
              : ''))
          continue
        }
      }
      /* 2026-10-25 用户：「不能隔着方块挖」—— 够得着（眼睛→中心 ≤ 4.5）不等于**看得见**。
       * 2026-10-27：被挡就先自己把挡路的挖开（`clearSightTo`），清不通才报。 */
      {
        const see = await canSeeBlockOf(b, p, { reachMax })
        if (see && see.ok === false) {
          const r = await clearSightTo(self, b, p, { reachMax, ctx, noClear })
          const after = r.ok ? await canSeeBlockOf(b, p, { reachMax }) : see
          const last = after ?? see
          if (!r.ok || (after && after.ok === false)) {
            out.push(`${nm} @ ${p}：`
              + clearFailText({ ...r, blocker: last.blocker, at: last.at }, last, nm))
            continue
          }
          if (r.cleared.length) {
            out.push(`🧹 先把挡路的 ${r.cleared.map((c) => `${c.name}（${c.x}, ${c.y}, ${c.z}）`).join('、')} 挖开了`)
          }
        }
      }
      /* 挖自己脚下（2026-10-18 审计 P1-5）：跟 `breakBlock` 同一条判据。 */
      const risk = allowDangerous ? null : underfootRiskOf(b, p)
      if (risk?.bad) {
        out.push(`⚠️ ${nm} @ ${p} 是你脚下的支撑：${risk.why} —— **这一格没挖**。`
          + '先横着挪一格（`mc_move`）再挖，或确实要拆就带 `allowDangerous:true`')
        continue
      }
      {
        const watch = ctx.watchServerBreak(b, p)
        try {
          // 空中挖慢 5 倍 ⇒ 先等落地（否则预算全喂给一次注定超时的挖掘）
          if (!await ctx.waitGrounded(b, Math.min(1_500, Math.max(0, leftOf() - 800)))) {
            out.push(`—— 我还在空中（没落地）就挖不了 ${nm}：空中挖方块慢 5 倍，先落稳（或 \`mc_move {mode:"jump"}\` 换个落脚点）再叫一次 mc_dig`)
            continue
          }
          await ctx.equipFor(b, fresh, `换工具挖 ${nm}`)
          const oneMs = digMsFor(b, fresh, b?.heldItem?.type ?? null)
          if (oneMs != null && leftOf() < oneMs + 500) {
            out.push(`—— 剩下的时间不够挖 ${nm}（这块要 ${(oneMs / 1000).toFixed(1)} 秒${slowDigWhy(b)}），没开始挖：再叫一次 mc_dig 接着挖`)
            break
          }
          await ctx.t(b.dig(fresh, true), 'dig', `挖 ${nm}`)
          /* 等**服务端**的判决（客户端那个 air 是预测，不算数；服务端的包可能晚到约 1 秒） */
          await ctx.awaitServerBreak(b, watch)
          const now = b.blockAt(p)?.name ?? '?'
          /* 🔴 服务端把这一格改成非空气 —— 先看是不是**同一个方块**（见 `classifyRestore`）：
           *   同一个 ⇒ 真拒绝（复原）；变成**液体** ⇒ 破坏其实成功了（冰挖掉就是水）；别的 ⇒ 客户端区块旧了。 */
          const rest = classifyRestore(watch)
          const confirmed = watch.watching ? (watch.hit() || rest?.kind === 'liquid') : null
          if (rest?.kind === 'same') {
            await sleep(150)
            const back = rest.name ?? stateNameOf(b, watch.restored()) ?? b.blockAt(p)?.name ?? '别的方块'
            self.log(`⚠️ 服务端把 ${nm} 复原了（${p}）—— 这次破坏没被认`)
            out.push(`没挖掉 ${nm} @ ${p}：服务端把这块**改回了 ${back}**（复原）`
              + ' —— 多半是我离得远，或客户端区块旧了。先 `mc_move` 走到它旁边（3 格以内）再叫一次 mc_dig。'
              + DESYNC_HINT)
          } else if (rest?.kind === 'other') {
            await sleep(150)
            const back = rest.name ?? '别的方块'
            self.log(`⚠️ 服务端说 ${p} 是 ${back}，和我以为的 ${nm} 不一样 —— 客户端区块旧了？`)
            out.push(`没挖掉 ${nm} @ ${p}：服务端说这一格是 **${back}**，和我这边看到的 **${nm}** 不一样`
              + '（客户端区块旧了）—— 先 `mc_scan` 复核一眼。'
              + DESYNC_HINT)
          } else if (now !== nm) {
            okCount++
            if (task) self.tasks.progress(task.taskId, { add: 1 })
            /* 🔴 审计①：`bot.dig()` 的 resolve 来自**客户端预测**（digging.js:143-159 自己
             *    `_updateBlockState(pos, 0)` 又自己接住）⇒ 服务端拒了也照样"成功"。
             *    只有服务端发的破坏包才算真挖掉。 */
            if (!watch.watching) okLog.push({ nm, p, how: '原地', now })
            else if (confirmed) okLog.push({ nm, p, how: '原地', now, confirmed: true, liquid: rest?.kind === 'liquid' })
            else {
              /* 🔴 2026-10-23 同上（`breakBlock` 那条路）：本地 air 是 `digging.js` 自己写上去的，
               *    服务端静默拒绝时这一格会变成“本地空气 / 服务端实心”的幽灵空位 —— 寻路会往那儿走。 */
              const back = restoreLocalBlock(b, p, Number(fresh?.stateId))
              out.push(`本地读到 ${nm} @ ${p} 已经变成 ${now}，但**没收到服务端的破坏回包**`
                + ' —— 服务端很可能拒了这次破坏（够不着 / 领地保护 / 权限 / 反作弊）：别当成挖掉了，'
                + '先 `mc_scan` 复核。'
                + (back ? '（我已经把本地那一格改回原样，免得寻路把它当成空洞）' : '')
                + DESYNC_HINT)
            }
            /* 掉落物**不在这里捡**（用户 2026-10-29：「这个等挖矿结束后最后检查」）——
             * 原地挖绕过了 collectBlock，东西会掉在刚挖那一格附近；整轮挖完统一收一次，
             * 比每块都等吸附/跑一趟快得多。 */
            lastDig = p
          } else out.push(`没挖成 ${nm} @ ${p}（原地挖完了，但那里**还是 ${now}**）`
            + ' —— 服务端没认这次破坏（失步 / 领地保护 / 工具不对）：先 `mc_scan` 复核。'
            + DESYNC_HINT)
        } catch (e) {
          /* 🔴 被新指令抢占（`interruptMove` / abort）：**这不是失败**，进度留着 —— 用户
           * 2026-10-08 路线图原话"玩家发出新命令可取消或抢占旧任务"。 */
          if (e?.mcAborted) {
            if (task) self.tasks.pause(task.taskId, '被新的指令打断')
            throw e
          }
          out.push(`挖 ${nm} @ ${p} 失败：${String(e?.message ?? e).slice(0, 120)}`)
        } finally {
          watch.stop()
        }
        continue
      }
    }
    /* 以前这里还有一条"够不着就交给 collectBlock"的路 + 一个"② 退回：原地挖"的兜底循环 ——
     * 2026-10-08 全部删掉：那条路正是"挖完又复原 + 之后几分钟走不了路"的来源（见本函数开头的注释）。
     * 够不着就如实说，让模型自己 `mc_move` 过去再挖。 */
    /* 「这条矿脉还没挖干净」—— 收工前补一句（`veinHint` 的判据见本文件开头）。
     * 时间用完那条路自己会说"还有 N 个没挖"，不重复。 */
    /* 成功行渲染：1 块按原样写；多块合并成一行汇总（用户给的输出规范：“将逐项流水改为汇总”）。
     * 放在掉落物处理之前 —— 掉落物那句是“收尾补充”，读起来应该跟在挖掘结果后面。 */
    if (okLog.length === 1) {
      const o = okLog[0]
      out.push(o.how === '顺手'
        ? `走过去的时候顺手挖掉了 ${o.nm} @ ${o.p} → 现在 ${o.now}`
        : `挖掉 ${o.nm} @ ${o.p}（原地，不用走过去）→ 现在 ${o.now}`
          + (o.confirmed ? `（服务端已确认${o.liquid ? '：液体立刻涌了进来，这次破坏是成功的' : ''}）` : ''))
    } else if (okLog.length > 1) {
      const byName = new Map()
      for (const o of okLog) byName.set(o.nm, (byName.get(o.nm) ?? 0) + 1)
      const sum = [...byName].map(([n2, c]) => `${n2}×${c}`).join('、')
      const confN = okLog.filter((o) => o.confirmed).length
      out.push(`⛏ 挖掉 ${okLog.length} 块：${sum}（最后一块 @ ${okLog[okLog.length - 1].p}`
        + `${confN ? `，服务端已确认 ${confN}/${okLog.length}` : ''}）`)
    }
    /* 🔴 2026-10-29（用户：「这个等挖矿结束后最后检查」）：
     *   掉落物统一在**挖完之后**处理一次：先给一次吸附机会（东西就掉在刚挖的位置附近），
     *   没吸到的再捡脚边 2.5 格内的，剩下的如实报"地上还有 N 个"。
     *   时间不够（收尾只剩不到 0.5 秒）就只报不捡 —— 别把返回文本挤掉。 */
    if (okCount > 0) {
      const enough = leftOf() > 500
      const flew = enough
        ? await waitForPickup(self, b, { at: lastDig ?? undefined, graceMs: Math.min(PICKUP_GRACE_MS, 600) }).catch(() => 0)
        : 0
      const got = enough ? await ctx.grabDrops(b, { radius: 2.5 }).catch(() => 0) : 0
      const parts = []
      if (flew > 0) parts.push(`${flew} 个自己飞进背包`)
      if (got > 0) parts.push(`顺手捡回 ${got} 个`)
      if (parts.length) {
        out.push(`　（掉落物：${parts.join('、')}）`)
      } else if (!enough) {
        out.push('　（时间不够了，掉落物还在地上 —— 再叫一次 mc_dig 或 `mc_move` 过去会顺手捡）')
      } else {
        /* 一个都没捡到（够不着 / 卡住 / 背包满）⇒ 点一句"东西还在地上"。
         * why：用户 2026-10-08 原话"挖完方块或者打完动物以后老是忘记走过去拾取" ——
         * 捡东西是**决策**，插件替不了，但结果里必须让它知道这活还没完。 */
        const hint = dropHint(b)
        const where = dropsWhereText(b)
        if (hint) out.push(`　（${hint}${where ? '：' + where : ''}）`)
      }
    }
    if (okCount > 0 && !budgetCut) {
      const h = veinHint(b, targets[0]?.name ?? name)
      if (h) out.push(h)
    }
    /* 工具快坏了就点一句。**只在有警告时**加 —— 这个动作每轮都在跑，
     * 全好时也念"都还好"就是稳定噪声。而缺了它的后果很实：`mc_dig {count:16}`
     * 一次能打掉几十点耐久，镐子在执行**中间**爆掉时，AI 拿到的结果
     * 和"挖得好好的"一模一样，只能靠自己 `mc_inventory` 去查（通常不会查）。 */
    const wear = durWarnText(b)
    if (wear) out.push(`⚠️ 工具：${wear}`)
  ctx.taskSettle(task, out, okCount, n)
  ctx.verdictLine(out, okCount, n)
    return ctx.withHeld(out, b, held0)
  }
}

/**
 * 眼睛能不能**直着**看见这一格方块（中间没有别的实心方块挡着）。
 *
 * 2026-10-25 用户：「现在会隔着方块挖矿，能不能改成不能隔着方块挖」——
 *   以前只判「眼睛→方块中心 ≤ 4.5」，于是站在墙角 / 隔着一层石头也能"挖"到后面的矿：
 *   服务端不查遮挡，客户端就把那格预测成 air，画面上就是"隔着方块挖"（挖完还常常复原）。
 *
 * 返回：
 *   · `{ ok: true }` —— 看得见，可以挖
 *   · `{ ok: false, blocker, at }` —— 被 `blocker` 挡着（`at` 是它那一格的坐标）
 *   · `null` —— 判不了（没有 `world.raycast` / 读不到方块 / 射线报错）⇒ **不拦**，保持老行为
 *
 * 只把**实心方块**当遮挡（水 / 草 / 藤蔓 / 火把都能穿过去），和 `mc_shoot` 的 `blockedAlong` 同口径。
 */
/**
 * 这一格方块能不能挖（会不会是"隔着方块挖"）。
 *
 * 判据（2026-10-25 用户三次收紧/放宽后的定稿）：
 *   ① **贴身 1 格一律放行** —— 脚下那块、头顶那块、水平相邻 8 格、斜下方 1 格。
 *      射线是从自己眼睛出发的，第一块实心方块经常就是自己踩的地板，
 *      于是"站在铁矿上挖不了，被 stone 挡着"（实机踩过）。
 *   ② 其余看**前后左右四格**：只要有一格是空的（空气 / 可通行），就能挖 ——
 *      那一面就是"能看见/能伸进去"的那一面。用户原话：
 *      「改成方块前后左右有一格方块是空的就可以挖」。
 *   ②′ 四面有空之后**还要过视线**（2026-10-27 GitHub issue #3）：四面有空只说明"那一面通着"，
 *      不代表"你和它之间没夹着别的方块"。以前漏了这一条，于是会绕开正前方的金矿去挖后面的钻石。
 *   ③ 四面全被实心包住 ⇒ 才是真正的"隔着方块挖"，拦下并说清是哪面挡着。
 *   ④ 读不到方块 / 够不着（眼→方块中心 > reachMax+1）⇒ `null`，**不拦**（判不了就别拒绝干活）。
 *
 * 返回：
 *   · `{ ok: true }` —— 能挖
 *   · `{ ok: false, blocker, at }` —— 四面全实心（`at` 是其中一面的坐标，可以去挖开）
 *   · `null` —— 判不了 ⇒ 不拦
 *
 * 只把**实心方块**当遮挡（水 / 草 / 藤蔓 / 火把都算"空的"），和 `mc_shoot` 的 `blockedAlong` 同口径。
 */
/** 视线采样线的终点（方块内相对坐标）：中心 + 六个面心各往里 0.03。 */
const LOS_ENDS = Object.freeze([
  [0.5, 0.5, 0.5],
  [0.5, 0.97, 0.5], [0.5, 0.03, 0.5],
  [0.97, 0.5, 0.5], [0.03, 0.5, 0.5],
  [0.5, 0.5, 0.97], [0.5, 0.5, 0.03],
])

/**
 * 「眼睛 → 这一格」这条线上有没有别的实心方块挡着（2026-10-27 GitHub issue #3）。
 *
 * 为什么要单独做：`canSeeBlockOf` 的 ② 只看目标**紧贴的四面** ——
 *   目标旁边只要有矿洞开口就放行，于是"正前方挡着金矿、后面藏着钻石"时，
 *   它会绕开金矿直接挖后面的钻石（用户给了日志：先报"四面都被包着挖不了"，
 *   两分钟后**原地没动**就把那块钻石挖掉了，而当时前方明明还夹着金矿）。
 *
 * 判据：终点取**中心 + 六个面心**共 7 个点 —— Minecraft 挖方块只要求视线够到碰撞箱的
 *   **任意一点**；只取中心会把"站在平地上挖斜下方 2~3 格的矿"误拦
 *   （中心那条线被地板边缘擦到，可上表面明明看得见）。
 *   任意一条采样线**没有**撞到实心方块 ⇒ 看得见，返回 `null`；
 *   7 条全被挡 ⇒ 返回第一条撞到的 `{ blocker, at }`。
 *
 * 跳过：目标自己那格、**眼睛/脚自己站着的那两格**（射线第一格常常就是这两格）。
 *   ⚠️ 只跳这两格，不跳"贴身 3×3×3" —— 那样隔着一格厚的墙也会被当成看得见。
 * 读不到方块（区块没加载）⇒ 这一条不算被挡（判不了就别拒绝干活，与 ④ 同口径）。
 */
export function losBlockerAlong (b, from, gx, gy, gz, near) {
  const at = (x, y, z) => { try { return b.blockAt(new Vec3(x, y, z)) } catch { return null } }
  /* 自己站的两格：眼睛在的那格 + 脚在的那格（都用 eye/feet 自己的坐标算，别信 near 里的分量） */
  const eyeX = Math.floor(from.x), eyeY = Math.floor(from.y), eyeZ = Math.floor(from.z)
  const feetY = Number.isFinite(Number(near?.fy0)) ? Math.floor(Number(near.fy0)) : eyeY - 1
  let first = null
  for (const [ex, ey, ez] of LOS_ENDS) {
    const dx = gx + ex - from.x
    const dy = gy + ey - from.y
    const dz = gz + ez - from.z
    const len = Math.sqrt(dx * dx + dy * dy + dz * dz)
    if (!(len > 0.6)) return null                     // 贴着脸，肯定看得见
    const steps = Math.min(96, Math.max(8, Math.ceil(len / 0.25)))
    let hit = null
    for (let i = 1; i < steps; i++) {
      const t = i / steps
      const bx = Math.floor(from.x + dx * t)
      const by = Math.floor(from.y + dy * t)
      const bz = Math.floor(from.z + dz * t)
      if (bx === gx && by === gy && bz === gz) continue
      /* 🔴 2026-11-02 审计（#6）：这里原来跳过**以眼睛为心的 3×3×3**（`<= 1`）—— 隔着一格厚的墙
       *   （石头贴着玩家、后面就是矿）时，那面墙正落在被跳过的范围里 ⇒ 恒判"看得见"，
       *   于是模型被告知能挖、实际服务端不给。只该跳过**自己站着的那两格**（脚下 + 眼睛所在格）：
       *   射线从眼睛出发，第一格永远是它们自己，不跳会把自己判成挡路。 */
      /* 竖直方向要连带最后一格：眼睛看**正下方**的方块时，射线必然穿过自己脚下那格
       *   （它就是我此刻踩的立足点，2026-10-31 定的是"侧面优先、不许挖脚下"），
       *   把它当挡路会逼我们先挖自己的立足点。水平方向仍然一格都不放过。 */
      if (bx === eyeX && bz === eyeZ && (by === eyeY || by === feetY || by === feetY - 1)) continue
      const blk = at(bx, by, bz)
      if (!blk) continue                              // 读不到 ⇒ 这一条判不了，不算被挡
      if (blk.boundingBox !== 'block') continue
      if (isAir(blk.name) || isPassable(blk.name)) continue
      hit = { blocker: blk.name ?? '方块', at: { x: bx, y: by, z: bz } }
      break
    }
    if (!hit) return null                             // 有一条通 ⇒ 看得见
    if (!first) first = hit
  }
  return first
}

export async function canSeeBlockOf (b, p, { reachMax = 4.5 } = {}) {
  const eye = b?.entity?.position
  if (!eye || !p) return null
  const at = (x, y, z) => { try { return b.blockAt(new Vec3(x, y, z)) } catch { return null } }
  const gx = Math.floor(p.x); const gy = Math.floor(p.y); const gz = Math.floor(p.z)
  const target = at(gx, gy, gz)
  if (!target) return null
  /* 目标本身不是实心（草、火把、藤蔓…）：本来就没有"隔着方块"一说 ⇒ 不拦。 */
  if (target.boundingBox !== 'block') return null
  /* ① 贴身一圈（含脚下 / 头顶 / 斜角）不查遮挡 */
  const fx0 = Math.floor(eye.x); const fy0 = Math.floor(eye.y); const fz0 = Math.floor(eye.z)
  if (Math.max(Math.abs(gx - fx0), Math.abs(gy - fy0), Math.abs(gz - fz0)) <= 1) return { ok: true }
  /* 够不着就别在这儿判"隔着方块"（上层会报"够不到"） */
  const V = eye.constructor
  const from = new V(eye.x, eye.y + 1.62, eye.z)
  const dist = from.distanceTo(new V(gx + 0.5, gy + 0.5, gz + 0.5))
  if (!(dist > 0) || dist > reachMax + 1) return null
  /* ② 上下前后左右（**六面**）只要有一面是空的，就能挖。
   *   🔴 2026-10-29 用户：「现在还是不能往下挖」。以前只看**水平四面** ——
   *   矿在脚下 2 格、脚下 1 格是石头、四周也是石头时，它被判成“埋死”，
   *   而“朝我这一面”又只挑水平邻格 ⇒ 挖了旁边四块还是判埋死，死循环。
   *   把“脚下那层石头”当成一面空（它本来就是“能挖开的一面”），下面的 LOS 会把它报成挡路块。 */
  const sides = [[0, 0, -1], [0, 0, 1], [-1, 0, 0], [1, 0, 0], [0, -1, 0], [0, 1, 0]]
  const around = []
  for (const [dx, dy, dz] of sides) {
    const nb = at(gx + dx, gy + dy, gz + dz)
    if (!nb) return null                       // 有一面读不到 ⇒ 判不了，不拦
    around.push({ dx, dy, dz, nb })
  }
  if (around.some((s) => isAir(s.nb.name) || isPassable(s.nb.name))) {
    /* ②′ 四面有空 **不等于** 看得见 —— 再量一遍"眼睛 → 这一格"的视线（issue #3）。 */
    const los = losBlockerAlong(b, from, gx, gy, gz, { fx0, fy0, fz0 })
    if (los) return { ok: false, blocker: los.blocker, at: los.at, los: true }
    return { ok: true, los: true }
  }
  /* ③ 六面全实心：拦下，报最靠外那面（北）的坐标 */
  const s0 = around[0]
  return {
    ok: false,
    blocker: s0.nb.name ?? '方块',
    at: { x: gx + s0.dx, y: gy + s0.dy, z: gz + s0.dz },
  }
}

/* ----------------------------------------------------------------------------
 * 「先把挡路的挖开」（2026-10-27 用户：「dig 矿石满足条件就会不让挖，然后 AI 是一点一点
 * 把周围挖掉。改一下改成不满足条件直接挖到满足条件」）。
 *
 * 为什么一定清得动：挡路的方块坐在「眼睛 -> 目标」这条连线上，比目标更近
 *   => 它必然在 reach 之内；而且它前面（眼睛这一侧）没有别的实心方块挡着它自己
 *   => 它本身就是那一块"能直接看见、能直接挖"的方块。所以不用先走位。
 *
 * 为什么不设"最多清几块"：目标在 4.5 格以内 => 这条线上最多夹 4 块，天然有界。
 *   `cleared` 里按坐标去重 —— 服务端要是静默拒了某次破坏（方块复原），下一轮会
 *   再报同一块，这时直接停手，不会死循环。
 *
 * 哪些挡路的不碰（碰了更糟）：液体（一挖就灌进来）、基岩类的不可挖、容器（连里面的
 *   东西一起砸）。
 * -------------------------------------------------------------------------- */
const NO_CLEAR_BLOCK = /chest|barrel|furnace|smoker|hopper|dispenser|dropper|shulker_box|brewing_stand|beacon|enchanting_table|anvil|lectern|crafter|decorated_pot|jukebox/
const UNBREAKABLE_BLOCK = /bedrock|barrier|command_block|structure_block|jigsaw|end_portal|light$|moving_piston|reinforced_deepslate/

const SIGHT_DIG_IN_MAX = 6

/**
 * 目标整块嵌在岩层里（前后左右四面都实心）时，挑「朝我最近、又挖得动」的那一面。
 * 为什么按距离挑：挖掉离眼睛最近的那面，开口就在我这一侧，挖开一格往往就露出来了；
 * 挑错面等于从背后拆墙，白挖。
 */
function faceTowardEye (b, p, at, reachMax) {
  const eye = b?.entity?.position
  if (!eye || !p) return null
  const gx = Math.floor(p.x); const gy = Math.floor(p.y); const gz = Math.floor(p.z)
  /* 🔴 2026-10-29：以前只挑**水平四面**。矿在脚下时，“朝我这一面”是**上面那格**，
   *   挑水平面永远挖不到它 ⇒ 现在六面都看，取离眼睛最近的那一面。 */
  const dirs = [[0, -1, 0], [0, 1, 0], [-1, 0, 0], [1, 0, 0], [0, 0, -1], [0, 0, 1]]
  /* 🔴 2026-10-31 用户：「是不是可以挖离自己 1 格的方块，然后挖完以后就缺一格，就可以
   *   挖钻石了」—— 对，这才是正常打法：**从侧面开个缺口**，人站着不掉，从缺口里把矿挖出来。
   *   以前只按“离眼睛最近”挑，矿在脚下时“最近那面”就是**自己踩着的支撑方块** ⇒ 挖它等于
   *   拆自己的立足点（还会先被 `underfootRiskOf` 拦下），矿永远挖不到。
   *   排序改成：水平侧面（0，不掉人）> 上方（1）> 下方（2）> 自己脚下的支撑（3，最后才考虑）。 */
  const fp = (() => { try { return b.entity.position.floored() } catch { return null } })()
  let best = null
  for (const [dx, dy, dz] of dirs) {
    const x = gx + dx; const y = gy + dy; const z = gz + dz
    const blk = at(x, y, z)
    if (!blk) continue
    if (blk.boundingBox !== 'block') continue
    if (isLiquid(blk.name)) continue
    if (UNBREAKABLE_BLOCK.test(blk.name) || blk.hardness === -1 || blk.hardness === Infinity) continue
    if (NO_CLEAR_BLOCK.test(blk.name)) continue
    if (blockReachOf(b, blk) > reachMax) continue
    const isSupport = Boolean(fp) && x === fp.x && y === fp.y - 1 && z === fp.z
    const rank = isSupport ? 3 : (dy === 0 ? 0 : (dy > 0 ? 1 : 2))
    const d = Math.hypot(eye.x - (x + 0.5), eye.y - (y + 0.5), eye.z - (z + 0.5))
    if (!best || rank < best.rank || (rank === best.rank && d < best.d)) best = { x, y, z, d, rank }
  }
  return best
}

export async function clearSightTo (self, b, p, { reachMax = 4.5, ctx = {}, noClear = false } = {}) {
  const cleared = []
  if (noClear) return { ok: false, why: 'noClear', cleared }
  const at = (x, y, z) => { try { return b.blockAt(new Vec3(x, y, z)) } catch { return null } }
  let dugIn = 0
  /* 挖一格（清障 / 挖进去 共用一条：等待落地 → 换工具 → 挖 → 等两 tick） */
  const digCell = async (blk, cell) => {
    if (isLiquid(blk.name)) return { ok: false, why: 'liquid', blocker: blk.name, at: cell }
    if (UNBREAKABLE_BLOCK.test(blk.name) || blk.hardness === -1 || blk.hardness === Infinity) {
      return { ok: false, why: 'hard', blocker: blk.name, at: cell }
    }
    if (NO_CLEAR_BLOCK.test(blk.name)) return { ok: false, why: 'container', blocker: blk.name, at: cell }
    if (blockReachOf(b, blk) > reachMax) return { ok: false, why: 'far', blocker: blk.name, at: cell }
    /* 🔴 2026-11-02 审计（#5）：上面那段注释写「挖自己脚下会先被 `underfootRiskOf` 拦下」，
     *   但那函数全文只接在 `mc_dig` 主流程两处，**清障这条路根本没走它** ——
     *   站在崖边清障时能把自己脚下那格挖掉，直接掉下去（下面要是岩浆就是死）。
     *   这里补上同一道判据：挖完会塌/会掉进危险，就不挖这一格。 */
    {
      const foot = underfootRiskOf(b, cell)
      if (foot && foot.bad === true) {
        return { ok: false, why: foot.why ? `unsafe:${foot.why}` : 'unsafe', blocker: blk.name, at: cell }
      }
    }
    try {
      if (typeof ctx.waitGrounded === 'function') {
        await ctx.waitGrounded(b, Math.min(1_200, Math.max(0, self.callLeft() - 800)))
      }
      if (typeof ctx.equipFor === 'function') await ctx.equipFor(b, blk, `换工具挖开挡路的 ${blk.name}`)
      const job = b.dig(blk, true)
      if (typeof ctx.t === 'function') await ctx.t(job, 'digClear', `挖开挡路的 ${blk.name}`)
      else await job
    } catch {
      return { ok: false, why: 'fail', blocker: blk.name, at: cell }
    }
    cleared.push({ key: `${cell.x},${cell.y},${cell.z}`, name: blk.name, x: cell.x, y: cell.y, z: cell.z })
    try { if (typeof b.waitForTicks === 'function') await b.waitForTicks(2) } catch { /* 假 bot 没有 */ }
    if (typeof self.log === 'function') self.log(`🧹 挖开挡路的 ${blk.name}（${cell.x},${cell.y},${cell.z}）`)
    return { ok: true }
  }
  for (let guard = 0; guard < 20; guard++) {
    const see = await canSeeBlockOf(b, p, { reachMax })
    if (!see || see.ok !== false) return { ok: true, cleared, dugIn }
    /* 四面全被实心包着（`see.los` 没置位）：目标整块嵌在岩层里，不是"连线上夹了一块"。
     * 2026-10-29 用户：「为什么没有直接挖过去」—— 那就从**朝我这一面**开个口挖进去，
     * 挖开后再量。限度 `SIGHT_DIG_IN_MAX`：够得到就挖得动，但不许演变成拆整片岩层。 */
    const buried = see.los !== true
    let cell = see.at
    if (buried) {
      if (dugIn >= SIGHT_DIG_IN_MAX) {
        return { ok: false, why: 'buried', cleared, blocker: see.blocker, at: see.at, dugIn }
      }
      const face = faceTowardEye(b, p, at, reachMax)
      if (!face) return { ok: false, why: 'surrounded', cleared, blocker: see.blocker, at: see.at, dugIn }
      cell = face
    }
    const key = `${cell.x},${cell.y},${cell.z}`
    if (cleared.some((c) => c.key === key)) {
      return { ok: false, why: 'stuck', cleared, blocker: see.blocker, at: cell, dugIn }
    }
    const blk = at(cell.x, cell.y, cell.z)
    if (!blk) return { ok: false, why: 'unloaded', cleared, blocker: see.blocker, at: cell, dugIn }
    const r = await digCell(blk, cell)
    if (!r.ok) return { ...r, cleared, dugIn }
    if (buried) dugIn++
  }
  return { ok: false, why: 'loop', cleared, dugIn }
}

/** 清障没成功时给模型的那句话（按 `why` 分岔，别让 AI 猜）。`see` 是最后一次量到的视线结果。 */
export function clearFailText (r, see, target = '目标') {
  const at = r?.at
  const who = r?.blocker ?? '方块'
  const where = at ? `（${at.x}, ${at.y}, ${at.z}）` : ''
  const done = r?.cleared?.length
    ? `（我已经先挖开了 ${r.cleared.map((c) => `${c.name}（${c.x}, ${c.y}, ${c.z}）`).join('、')}）`
    : ''
  switch (r?.why) {
    case 'noClear':
      return `视线被挡着，这一趟带了 noClear —— 按你说的不动手，${target} 没挖`
    case 'buried':
      return `${target} 整块嵌在岩层里（前后左右四面都是实心，最靠外的是 **${who}**${where}）`
        + `—— 我从朝我这一面挖进去 ${r?.dugIn ?? 0} 格，还是没露出来${done}。`
        + '再叫一次我会接着往里挖；或者 `mc_move` 绕到另一侧'
    case 'surrounded':
      return `前后左右四面都是实心方块（**${who}**${where}），而且那一面我挖不动（液体 / 容器 / 基岩 / 够不着）`
        + `—— ${target} 没挖。换个站位（\`mc_move\`）或从别的角度过去`
    case 'liquid':
      return `挡路的是液体 **${who}**${where} —— 挖开它立刻灌进来会把通道淹了，我没挖${done}`
    case 'hard':
      return `挡路的是 **${who}**${where}，挖不动 —— 换个站位（\`mc_move\`）或从别的角度过去${done}`
    case 'container':
      return `挡路的是容器 **${who}**${where} —— 挖掉会连里面的东西一起砸了，我没动它${done}`
        + '。要么先 `mc_chest` 把它清空，要么换个角度'
    case 'far':
      return `挡路的是 **${who}**${where}，够不着挖 —— 先 \`mc_move\` 挪近一点${done}`
    case 'stuck':
      return `挡路的 **${who}**${where} 我挖了，可量过去它还挡着（服务端大概没认这次破坏）`
        + `—— 先 \`mc_scan\` 看看那儿现在是什么${done}`
    case 'unloaded':
      return `挡路那一格读不到（区块没加载）—— 先 \`mc_move\` 靠近让区块加载${done}`
    case 'loop':
      return `挡路的方块一层接一层，清到第 12 块还没通${done} —— 换个站位再来`
    default:
      return `试着挖开挡路的 ${who}${where}，没成功${done} —— 换个站位再来`
  }
}
/**
 * 挑一个"走到那里就够得着 p 这块矿"的落脚点（2026-10-23，用户「够得到还搭方块」）。
 * 候选 = 矿块周围一圈（含上下）的可站格，过滤条件是眼睛→矿块中心 ≤ reachMax，
 * 最后挑**离自己最近**的那个：离我近 ⇒ 天然在墙的这一侧 ⇒ A* 有路。
 * 返回 {x,y,z}（格坐标，y 是脚那一格）或 null（让调用方退回老写法）。
 */
function mineApproachCell (b, p, reachMax) {
  const me = b?.entity?.position
  if (!me || !p) return null
  const at = (x, y, z) => { try { return b.blockAt(new Vec3(x, y, z)) } catch { return null } }
  const standable = (x, y, z) => {
    const u = at(x, y - 1, z); const a = at(x, y, z); const c = at(x, y + 1, z)
    if (!u || !a || !c) return false
    if (isAir(u.name) || isLiquid(u.name)) return false
    return isPassable(a.name) && isPassable(c.name)
  }
  const px = Math.floor(p.x); const py = Math.floor(p.y); const pz = Math.floor(p.z)
  const center = new Vec3(p.x + 0.5, p.y + 0.5, p.z + 0.5)
  let best = null; let bestD = Infinity
  for (const dy of [0, -1, 1]) {
    for (const dx of [-1, 0, 1]) {
      for (const dz of [-1, 0, 1]) {
        if (!dx && !dz && !dy) continue
        const x = px + dx; const y = py + dy; const z = pz + dz
        if (!standable(x, y, z)) continue
        if (new Vec3(x + 0.5, y + 1.62, z + 0.5).distanceTo(center) > reachMax) continue
        const d = me.distanceTo(new Vec3(x + 0.5, y, z + 0.5))
        if (d < bestD) { bestD = d; best = { x, y, z } }
      }
    }
  }
  return best
}

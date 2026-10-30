/**
 * "打谁 / 怎么打"那一层（路线图第 ④ 条第二十一刀）。
 *
 * 搬走 `McBot.attack({ who, budget })`（原 116 行，`core.mjs` 里第二大的"动作"方法）。
 * 只认一个 bot + 一个 `ctx = { t, callLeft, abortSignal, hasPvp, moveTo, equipTo }`：
 *   · `ctx.t`           —— 预算闸门（只有"没有 pvp 退回挥手"那条路才发包，要过闸门）
 *   · `ctx.callLeft()`  —— 这一轮还剩多少毫秒（决定"等多久"和"挥几下"）
 *   · `ctx.abortSignal` —— 玩家新命令抢占（`mc_stop` / 新一轮工具调用）
 *   · `ctx.hasPvp`      —— 插件实例状态（`this.mcPlugins.pvp`），不是 bot 的
 *   · `ctx.moveTo`      —— 走位用（现成的 `walkTo`，**不是**第二套移动控制器）；撤退不在这里做
 *   · `ctx.equipTo`     —— 换武器用（现成的 `equip`）
 *   后两个**可以没有**：缺了就退化（想走位却没得走时如实说"没给我移动能力"），不报错。
 *
 * 这里踩过的坑（`踩坑档案.md` 第 12 / 26 / 27 条）：
 *   ① `bot.pvp.attack(target)` **立刻** resolve（上游 `mineflayer-pvp\lib\PVP.js:60-76`
 *      只做三件事：设 target、`GoalFollow` 追过去、发 `startedAttacking`），真正挥拳的是
 *      `physicTick` 上的后台循环 ⇒ 旧写法 `await withTimeout(b.pvp.attack(...))` 一毫秒就返回、
 *      紧接着 `finally` 里 `b.pvp.stop()` 又把追过去的 goal 停掉 ⇒ **一下都没打，却回 "attacked: X"**。
 *      所以这里必须自己等：等到目标从 `bot.entities` 消失 / `isValid === false` / 这一轮的时间用完。
 *   ② `pvp.stop()` **不能 await**：它内部 `onceWithTimeout('path_stop', 5000)` 最多等 5 秒，
 *      会把这一轮的预算整段吃光（pathfinder 的 stop 在它第一行就已经做了）。
 *   ③ 名字匹配要看**所有**名字字段（`username` / `name` / `displayName` / `type` / `kind`）
 *      + 中文别名；找不到时**列出半径内实际有谁**，别只丢一句"附近找不到"。
 *   ④ 不带 `who` 时**只追怪**（24 格内的敌对也追），动物/玩家仍只在 4.5 格内 ——
 *      否则"打最近的"会跑过去揍玩家 6 格外的马。
 *
 * ── 2026-10-17 新增：战斗策略层（用户方案）────────────────────────────────
 * 以前这个函数只会做一件事 —— **一直往前顶**：血 4 还在顶、旁边三只怪还在顶、追不上还在顶。
 * 现在把"该进攻还是该撤"交给 `src\combat-strategy.mjs`（纯函数、不碰 bot），
 * 本文件只负责**执行一个阶段 → 重新观察 → 再问一次**。
 *
 * 🔴 三条不能破的规矩（用户原话）：
 *   · **不新建第二套移动控制** —— 走位一律 `ctx.moveTo`（现成 `walkTo`，
 *     带它自己的进度监控与脱困阶梯）。本文件里**没有一处** `setControlState`。
 *   · **不新建第二个任务状态机** —— 只报告结果，要不要继续追击/换目标/恢复原任务，
 *     由 `mc_task` 那一层决定。这里**没有** `tasks.*` 调用。
 *   · **不在 `mc_attack` 内部再调一个新工具**去换武器或吃东西（会嵌套调度、
 *     重复占资源、甚至等自己释放资源而死锁）—— 换武器走 `ctx.equipTo` 这个**能力回调**。
 *
 * 2026-10-18（用户："用attack的时候能不能自动切剑"）：换武器在 `chooseStrategy` 里的位置
 * 提到**最前**（仅次于"目标没了"和"该撤了"），被围 / 被远程射 / 目标是远程**不再拦它**
 * （见 `src\combat-strategy.mjs` 里 `inDanger` 的新口径）。以前那三种局面先返回
 * `defend` / `engage(close-in)`，而这两个分支在下面被降级成"照打"（`hold-line`）⇒
 * 换武器那条分支根本走不到 —— 实机表现就是"被骷髅射着、手里攥着镐，一直拿镐捶"。
 *
 * 🔴 战斗结局叫 **`combat`**，不叫 `outcome` —— `outcome` 是**跨工具**的"三种结局"
 *    （`confirmed`/`failed`/`unknown`/`stale`，见 `src\task-runner.mjs` 的 `outcomeOf()`），
 *    所有工具共用同一个含义。第一版战斗结局直接占了 `outcome`，结果 `withOutcome()`
 *    见到已有 `outcome` 就原样放过（`index.js:1989`）⇒ AI **再也看不到"这事到底成没成"**，
 *    而同一个字段名在不同工具里意思还不一样。现在两个字段各说各的：
 *    `combat` = 战斗结局（打死/打伤/撤了/够不着/被中止/超时），
 *    `outcome` = 统一结局（`outcomeOf()` 会把 `combat` 翻译过去）。
 */
import { sleep } from './async-util.mjs'
import { callBudget } from './budget.mjs'
import { HOSTILE_RE, RANGED_RE, JUNK_RE, NAME_ALIAS, entityNameOf, nameFieldsOf, hostilityOf } from './entity-names.mjs'
/* 会逃的被动动物：跑得比我们走路还快（羊 ≈4.6 格/秒 vs 4.3）⇒ 追的时候要单独判“追不上”。
 * 2026-10-29 实机：`mc_attack {who:"sheep"}` 干等 9.5 秒、距离仍在 9.7 格。 */
const FLEE_RE = /sheep|cow|pig|chicken|rabbit|fox|horse|donkey|mule|llama|panda|turtle|ocelot|cat|wolf|parrot|axolotl|goat|frog|camel|strider|mooshroom|polar_bear/i
import { dropHint, dropListOf, entityHealth } from './world-observer.mjs'
import { swingCooldownMsOf } from './combat-timing.mjs'
import { durabilityOf, EQUIP_SLOTS } from './inventory.mjs'
import {
  assessCombat, chooseStrategy, combatOutcomeOf, combatOutcomeText, combatPlanText,
  approachPointOf, isShield, COMBAT_PHASE_MS, HEALTH_LOW, threatScoreOf, EQUIP_COOLDOWN_MS,
} from './combat-strategy.mjs'
import { Vec3 } from 'vec3'
import { BRIDGE_FATAL } from './bridge.mjs'
import { isLiquid, isPassable, isSolidBlock } from './block-names.mjs'
/* 🔴 2026-10-28（用户：「有高低差呢」）：近战以前只判距离，隔着一层地板/墙照挥 ——
 *    `losBlockerAlong` 已经在 `mining.mjs` 里（眼到目标 7 点采样，只认实心方块），直接复用。 */
import { losBlockerAlong } from './mining.mjs'

/**
 * 挨打记录：`bot → { at, health }` 上一次看到的样子。
 *
 * 为什么要跨调用记：一次 `mc_attack` 里通常只有**一轮**（那一轮就把预算吃光了），
 * 一轮里采不到第二个血量样本 ⇒ "每秒掉多少血"永远是 0 ⇒ "正在挨打"这个判据形同虚设。
 * 拿上一次调用收工时的血量当起点，才比得出这一轮挨了多少。
 * 用 `WeakMap` 是为了不吊住 bot（断开重连会换对象，旧记录自己就没了）。
 */
const LAST_SEEN = new WeakMap()

/** 一轮战斗最多重新评估几次（防止"进攻→够不着→进攻"这种抖动把预算磨光）
 *  真正的抖动防线是 `repositions` / `equips` 各自的次数上限；这个数字只是最后一道保险。 */
const MAX_ROUNDS = 8

/* ── 放风筝（2026-10-18 用户："attack加个放风筝模式用来打近战怪，打一下往安全的地方退一点"）──
 *
 * 效果：打一下 → 往**背离目标**的安全落脚点退一步（约 3 格）→ 下一轮再靠近打。
 * 近战怪的手长是 3 格，退到 3.5 格它就得继续追、这 1~2 秒它打不到你 ⇒ 用它自己的冷却换你的冷却。
 *
 * 🔴 只对**近战**怪：远程怪（骷髅/女巫/恶魂…）退开等于把自己送到它的射程里。
 * 🔴 只退到**验过的落脚点**：脚/头能站、脚下是实心、脚下和身下都不是岩浆/火/仙人掌/水；
 *    周围找不到就**不退**（原地打完这一轮），绝不为了放风筝往危险里走。
 * 🔴 退路仍是 `ctx.moveTo`（现成 walkTo）—— 本文件不碰 `setControlState`，不建第二套移动控制。
 */
const KITE_DISTANCE = 3.4
/** 一次调用最多退几步（再多就是"跑路"了，那是 AI 叫 mc_move 的事） */
const KITE_MAX = 3
/** 目标贴到这么近才值得退（本来就够不着 ⇒ 退什么） */
const KITE_TRIGGER = 4.2
/** 退一步自己的时间预算（毫秒）：只走 3 格，给太多会挤掉下一次挥拳 */
const KITE_STEP_MS = 1_200

/**
 * 算"往哪退"：朝背离目标的方向找一格能站住、且不碰危险的地方。
 *
 * 方向优先正后方，被挡就试斜后方（±31°/±60°）—— 直线退路在树林/洞穴里经常是一堵墙。
 * 竖直方向按「脚下的层 → 上一层 → 下一层 → 下两层」找（应付台阶与矮一格的地面）。
 *
 * @returns {{x:number,y:number,z:number}|null} 站上去的中心坐标；找不到安全的落脚点就是 null
 */
function kiteSpotOf (b, target, { distance = KITE_DISTANCE } = {}) {
  const mp = b.entity?.position
  const tp = target?.position
  if (!mp || !tp) return null
  let ax = Number(mp.x) - Number(tp.x)
  let az = Number(mp.z) - Number(tp.z)
  const len = Math.hypot(ax, az)
  if (!(len > 0.05)) return null /* 重叠 ⇒ 算不出"反方向" */
  ax /= len; az /= len
  const blockAt = (x, y, z) => {
    try { return b.blockAt?.(new Vec3(x, y, z)) ?? null } catch { return null }
  }
  const nameAt = (x, y, z) => blockAt(x, y, z)?.name ?? null
  const risky = (n) => Boolean(n) && (BRIDGE_FATAL.test(n) || isLiquid(n))
  const baseY = Math.floor(mp.y)
  const levels = [baseY, baseY + 1, baseY - 1, baseY - 2]
  for (const a of [0, 0.55, -0.55, 1.05, -1.05]) {
    const ca = Math.cos(a); const sa = Math.sin(a)
    const ux = ax * ca - az * sa
    const uz = ax * sa + az * ca
    for (const d of [distance, 2.6]) {
      const gx = Math.floor(mp.x + ux * d)
      const gz = Math.floor(mp.z + uz * d)
      /* 别在原地或更靠近目标的地方"退"：水平距离得真的拉开 */
      if (Math.hypot(gx + 0.5 - tp.x, gz + 0.5 - tp.z) < Math.max(2.4, distance - 0.4)) continue
      for (const gy of levels) {
        const feet = nameAt(gx, gy, gz)
        const head = nameAt(gx, gy + 1, gz)
        const floor = nameAt(gx, gy - 1, gz)
        const under = nameAt(gx, gy - 2, gz)
        if (feet == null || head == null || floor == null || under == null) continue
        if (!isPassable(feet) || !isPassable(head)) continue          /* 脚/头得能站 */
        if (!isSolidBlock(floor) || risky(floor) || risky(under)) continue /* 脚下得踩实、别踩进岩浆/水 */
        /* 落脚点本身也不许挨着危险方块（退到岩浆边上=换一种死法） */
        if (risky(feet) || risky(head)) continue
        return { x: gx + 0.5, y: gy, z: gz + 0.5 }
      }
    }
  }
  return null
}

/** 玩家脚下往上还有几格能站（1 = 只有脚下这一格；2 = 用户要的"2 格洞"；>=3 = 头顶没封）。
 *  🔴 2026-10-27：`stand` 是给"在头顶搭个小平台、站在 2 格洞里打末影人"用的 ——
 *    末影人 3 格高进不来，所以"头顶到底封没封"才是这套打法成不成立的前提，必须如实报出来。
 *  🔴 `b.blockAt()` 只认真 Vec3：这里必须用 `position.offset()`，喂普通 `{x,y,z}` 会报 `pos.floored is not a function`。 */
/* 自己挥拳的判定距离（格）。**比 vendor 的 3.5 保守**：`distOf` 量的是「脚到脚」的中心距，
 * 服务端判「能不能打到」量的是**眼睛到碰撞箱**、且带 1 格容差 ⇒ 2.9 才稳
 * （参考 mineflayer-pvp/lib/PVP.js:41  this.attackRange = 3.5）。 */
export const ATTACK_REACH = 2.9

export function standHeadroomOf (b) {
  const p = b?.entity?.position
  if (!p || typeof p.offset !== 'function' || typeof b.blockAt !== 'function') return null
  let h = 1
  for (let i = 1; i <= 4; i++) {
    let blk = null
    try { blk = b.blockAt(p.offset(0, i, 0)) } catch { return null }
    if (!blk) return null
    if (blk.boundingBox === 'empty') h++
    else break
  }
  return h
}

export async function attack (b, { who = null, budget = 20_000, kite = false, priority = 'threat', stand = false } = {}, ctx = {}) {
  /* 🔴 2026-10-27（用户 m05940 + m06001）：`stand:true` = **这一步一步都不许挪**。
   *   目的不是"走近打"，是用户自己在头顶搭个 2 格高的小平台钻进去打末影人（末影人 3 格高进不来）。
   *   所以：① 不走 `ctx.moveTo`（reposition / kite 全跳过）；② 不用 pvp 插件（GoalFollow 会拽着人追）；
   *   ③ 出手前自己 `lookAt`（手动分支原来不看方向，站着不动更容易打空）；④ 够不着就原地等它来。 */
  const standMode = stand === true
  const needle = who ? String(who).trim().toLowerCase() : null
  const alias = needle ? NAME_ALIAS[needle] : null
  /* 🔴 站桩不能用 pvp：`bot.pvp.attack()` 内部是 GoalFollow，会把人拽着追过去 —— 一站桩就失效。 */
  const hasPvp = Boolean(ctx.hasPvp) && typeof b.pvp?.attack === 'function' && !standMode
  /* 🔴 位置要**每次现读**（`b.entity.position` 是活的）——
   *    旧写法在函数开头 `const me = b.entity.position` 抓一次，走位之后就过期了。 */
  const distOf = (e) => { try { return e.position.distanceTo(b.entity.position) } catch { return Infinity } }
  /** 眼睛 → 目标之间有没有实心方块挡着（`null` = 看得见）。 */
  const losBlockOf = (e) => {
    try {
      const p = b.entity?.position
      const tp = e?.position
      if (!p || !tp) return null
      const eh = Number(b.entity?.height) > 0 ? Number(b.entity.height) : 1.8
      const from = new Vec3(p.x, p.y + eh * 0.85, p.z)
      return losBlockerAlong(b, from, Math.floor(tp.x), Math.floor(tp.y), Math.floor(tp.z),
        { fx0: Math.floor(p.x), fy0: Math.floor(p.y), fz0: Math.floor(p.z) })
    } catch { return null }
  }
  /* 🔴 2026-10-18：快照改成**可刷新**的（目标跑了要能换下一只 —— 用户转来游戏里 AI 的原话
   *    「目标跑了也不换目标，这一轮就废了」）。原来 `all/list/pick/target` 在开头算一次就再也不变。 */
  const snapshotAll = () => Object.values(b.entities ?? {})
    .filter((e) => e && e !== b.entity && e.position)
    .map((e) => ({ e, d: distOf(e), nm: entityNameOf(e), hp: entityHealth(b, e) }))
    .filter((x) => x.d <= 24)
  let all = snapshotAll()
  /* 🔴 2026-10-17（用户实机："怪物好像不显示中立"）：立场判定统一走 `hostilityOf()`。
   *    原来这里把 `HOSTILE_RE` 命中就算敌对，而那份名单里有 `enderman` / `piglin` ——
   *    于是不带名字的 `mc_act{attack}` 会**主动去揍末影人**（本不会打你、能瞬移、40 血），
   *    而狼 / 蜜蜂 / 铁傀儡（真惹了会打你）被归进"其它"，连"被围"都不算。 */
  const stanceOf = (x) => (x.e.username || x.e.type === 'player')
    ? 'player'
    : hostilityOf(x.nm, x.e.kind)
  const rankOf = (x) => {
    if (JUNK_RE.test(x.nm)) return 4                                  // 掉落物 / 经验球 / 箭
    const st = stanceOf(x)
    if (st === 'hostile') return 0
    if (st === 'player') return 1
    if (st === 'neutral') return 2                                    // 中立：只有点名才打
    return 3                                                          // 动物之类
  }
  const hit = (x) => {
    if (!needle) return true
    const fields = nameFieldsOf(x.e)
    if (fields.some((v) => v.includes(needle))) return true
    return Boolean(alias) && fields.some((v) => v.includes(alias))
  }
  /* 🔴 2026-10-18（用户转来游戏里 AI 的原话：「**不会按威胁排优先级** —— 凋灵骷髅（挂凋零、
   *    10 秒掉 5 血）应该优先于僵尸，但它不会」）：同一档（敌对/玩家/中立/动物）之间，
   *    按 **威胁分 + 距离 + 是否正在打我** 排。分表在 `combat-strategy.mjs` 的 `threatScoreOf`。
   *    `priority` 只决定"同一档里怎么排"：threat（默认，威胁最大）/ nearest（最近）/ weakest（血最少）。 */
  const priorityMode = ['nearest', 'weakest'].includes(String(priority)) ? String(priority) : 'threat'
  const scoreOf = (x) => threatScoreOf(x.nm) + Math.max(0, 12 - x.d) + (x.e?.target === b.entity ? 25 : 0)
  const sortCands = (a, c) => {
    const rank = rankOf(a) - rankOf(c)
    if (rank) return rank
    if (priorityMode === 'nearest') return a.d - c.d
    if (priorityMode === 'weakest') return (a.hp ?? 999) - (c.hp ?? 999) || a.d - c.d
    return scoreOf(c) - scoreOf(a) || a.d - c.d
  }
  const candsOf = (snap) => (needle
    ? snap
    : snap.filter((x) => rankOf(x) === 0 || (x.d <= 4.5 && rankOf(x) === 3)))
    .filter(hit).sort(sortCands)
  // 🔴 不给 who 时**只追怪**（24 格内的敌对也追），动物/玩家仍只在 4.5 格内 ——
  //    否则"打最近的"会跑过去揍玩家 6 格外的马（2026-10-08 探针实测附近就有 horse 6.8 格）。
  /* 🔴 中立怪（末影人 / 猪灵 / 狼 / 蜜蜂 / 铁傀儡…）**不带名字就绝不去打**。
   *    它们本不会主动打你，但惹了会 —— 末影人 40 血 + 能瞬移，是最不该"顺手打一只"的。
   *    动物仍然只在 4.5 格内才算（打猎），玩家也改成必须点名。 */
  /* 🔴 2026-10-23（用户实机原话：「怎么全是item」）：这份"身边实际有什么"原来把掉落物和怪
   *    混在一起按距离取前 6 —— 地上摊着一片掉落物时（几百个 item 是常态），
   *    6 个名额全被 `item` 占满，一个怪名都不剩，模型改一百次名字也改不对。
   *    现在：活体（怪/动物/玩家）按距离取前 6，掉落物只报个数，不占名额。 */
  const nearOf = (snap) => {
    const live = snap.filter((x) => rankOf(x) !== 4).sort((a, c) => a.d - c.d)
    const junk = snap.filter((x) => rankOf(x) === 4)
    const liveText = live.slice(0, 6).map((x) => `${x.nm} ${x.d.toFixed(1)} 格`).join('、')
    if (!junk.length) return liveText
    const junkText = `掉落物/经验球 ×${junk.length}（不打）`
    return liveText ? `${liveText}，另有${junkText}` : junkText
  }
  let near = nearOf(all)
  /* 打完这一只，**附近还有哪些怪** —— 顺手报一句（用户 2026-10-16："用完 mc_attack 后自动调用
   * 获取实体的功能，防止周围有其他怪物"）。
   * 🔴 为什么非报不可：`extensions/mc_auto.mjs:1119` 的反射层在 `s.inFlight > 0` 时
   *    **故意压住**怪物警报（除非正在挨打、或怪已经贴到 URGENT_RADIUS 以内）—— 也就是说
   *    AI 打 A 的那几秒里，旁边的 B/C 一声不吭；这次调用一返回，AI 看到 `killed:true` 就走，
   *    正撞上 B。数据本来就在手（`all` 已经列了 24 格内的全部实体），零额外遍历。
   *    没怪时返回 `{}`（一个键都不加），所以常态零结果 token。 */
  const NEARBY_R = 16
  const foesNear = (exclude) => {
    const foes = Object.values(b.entities ?? {})
      .filter((e) => e && e !== b.entity && e !== exclude && e.position)
      .map((e) => ({ e, d: distOf(e), nm: entityNameOf(e) }))
      .filter((x) => x.d <= NEARBY_R && stanceOf(x) === 'hostile')
      .sort((a, c) => a.d - c.d)
      .slice(0, 5)
      .map((x) => {
        const hp = entityHealth(b, x.e)
        return { name: x.nm, distance: Number(x.d.toFixed(1)), ...(hp == null ? {} : { health: hp }) }
      })
    if (!foes.length) return {}
    return {
      nearby: foes,
      nearbyNote: `⚠️ 附近还有 ${foes.length} 只怪：`
        + foes.map((f) => `${f.name} ${f.distance} 格${f.health == null ? '' : `（血 ${f.health}）`}`).join('、'),
    }
  }
  let pick = candsOf(all)[0]
  // 半径内只剩掉落物（且不在手边）就别动手：打到一个 item 是白费一轮
  /* 🔴 2026-10-15 审计：点名点到掉落物时，旧文案是"附近找不到 X（24 格内实际有：X）"——
   *    同一句话里自相矛盾（找不到却列出来了）。这里单独说清"它是掉落物、而且够不着"。 */
  const dropOutOfReach = Boolean(pick && rankOf(pick) === 4 && pick.d > 4.5)
  let target = pick && !dropOutOfReach ? pick.e : null
  if (!target) {
    if (needle && dropOutOfReach) {
      throw new Error(`"${who}" 是**掉落物**，而且离我 ${pick.d.toFixed(1)} 格（超过 4.5 格）—— 我不打掉落物。`
        + '要捡它就先 `mc_move` 走过去站上去（一两秒就自己飞进背包）。')
    }
    if (needle) {
      /* 🔴 2026-10-17（用户实机：苦力怕贴到 3 格，它报「附近找不到 creeper」，只列出 `item 2.5 格`，
       *    然后换着法子瞎试了十几个调用）：原句只说"找不到"，模型无法区分
       *    ① **名字写错了**（那好办，改个名）② **客户端根本没跟踪到那只怪**
       *    （重生 / 换维度 / 区块卸载之后 `bot.entities` 会被清空或过期 —— 这时改一百次名字都没用）。
       *    所以把"客户端共跟踪几个实体 + 我自己在哪"一并报出来：数字少得离谱本身就是证据。 */
      /* 🔴 2026-10-23（用户：「怎么全是item」+174 个实体）：只报总数会被一堆掉落物骗了 ——
       *    以前那句"这么少基本说明客户端没跟上服务端"在满地的 item 面前永远不触发，
       *    反过来看着像"客户端跟得好好的"。这里把掉落物数单算，活体数才是判据。 */
      const tracked = Object.values(b.entities ?? {}).filter((e) => e && e !== b.entity && e.position)
      const seen = tracked.length
      const junkSeen = tracked.filter((e) => JUNK_RE.test(entityNameOf(e))).length
      const liveSeen = seen - junkSeen
      const countText = junkSeen
        ? `客户端现在共跟踪 ${seen} 个实体（其中 ${junkSeen} 个是掉落物/经验球，真活体 ${liveSeen} 个）`
        : `客户端现在共跟踪 ${seen} 个实体`
      const me = b.entity?.position
      const meText = me && Number.isFinite(me.x)
        ? `(${me.x.toFixed(1)}, ${me.y.toFixed(1)}, ${me.z.toFixed(1)})`
        : '（坐标读不到）'
      throw new Error(`附近找不到 "${who}"（24 格内实际有：${near || '什么都没有'}）`
        + ` —— ${countText}，我自己在 ${meText}。`
        + (liveSeen < 8
          ? '**这么少基本说明客户端没跟上服务端**（刚重生 / 换了维度 / 区块还没加载）—— '
            + '先 `mc_observe` 看一眼身边到底有什么，别反复换名字试。'
          : '')
        + '名字要跟 `mc_observe` "程序检测到"里显示的一致（中文叫法也认）；'
        + '要打远处那只就先 `mc_move` 过去，怪跑远了同样找不到。')
    }
    throw new Error(`4.5 格内没有能打的实体${near ? `（24 格内最近的是 ${near}）` : ''}`
      + ' —— 掉落物 / 经验球不算，动物与玩家要贴到 4.5 格内；'
      + '要打远处的怪就先 `mc_move` 过去（或 `mc_attack {who:"zombie"}`，那个会追 24 格）。')
  }
  let label = entityNameOf(target)
  let d = Number(distOf(target).toFixed(1))
  let hpBefore = entityHealth(b, target)

  /* ── 换目标（P1，用户 2026-10-18「目标跑了也不换目标，这一轮就废了」）───────────────
   * 目标还活着就不换（打到一半换目标 = 这一轮白费，也违背"我说打谁就打谁"）；
   * 只有确认它没了 / 跑出 24 格，才按同一个 `priority` 重新挑下一只。 */
  let retargets = 0
  const alive = () => Boolean(target && b.entities?.[target.id] && target.isValid !== false)
  const trackable = () => { try { return alive() && distOf(target) <= 24 } catch { return false } }
  const accept = (x) => {
    pick = x; target = x.e; label = x.nm
    d = Number(x.d.toFixed(1))
    hpBefore = x.hp == null ? entityHealth(b, x.e) : x.hp
    mem.lastInRange = null
  }
  const select = ({ reselect = false } = {}) => {
    if (!reselect && trackable()) return true
    all = snapshotAll()
    near = nearOf(all)
    const best = candsOf(all)[0]
    const drop = Boolean(best && rankOf(best) === 4 && best.d > 4.5)
    if (!best || drop) { pick = best ?? null; target = null; return false }
    accept(best)
    return true
  }

  /* ═══════════ ① 进攻阶段（原来的实现原样搬进来，只改"谁来叫它"） ═══════════ */

  /** 这次调用还剩多少总预算（每一轮进攻都从这里面扣，不能每轮各拿一份满预算） */
  const budgetLeft = () => Math.max(0, budget - (Date.now() - t00))
  /** 这一个进攻阶段的时间上限 —— **吃满这一轮剩下的**（留 300ms 收尾）。
   *
   *  🔴 2026-10-28（用户：「你刚刚改了什么，attack 现在基本用不了，① mc_attack 每次只给
   *     1.2 秒追击窗口」）：以前非站桩一律压到 `COMBAT_PHASE_MS`(1.2 秒)。可 pvp 那条路
   *     **打完一个相位就 return** —— 一次 `mc_attack` 只有 1.2 秒在打，再加上"先走近"
   *     花掉的几秒，用户看到的就是"1.2 秒追击窗口"。
   *     现在：打满剩余；`COMBAT_PHASE_MS` 只留给放风筝的节奏（打一两下 → 退一步）。
   *     "每 N 秒重新评估"仍然成立 —— 那是策略循环的活，不是拿预算去卡它。
   */
  const phaseMs = () => callBudget(
    Math.min(
      budgetLeft(),
      ctx.callLeft() - 300,
      kite ? Math.min(COMBAT_PHASE_MS, KITE_STEP_MS + 100) : Number.MAX_SAFE_INTEGER
    ),
    4_000
  )

  /** 有 pvp：交给插件追+打，自己等到"目标没了 / 这一轮用完"
   *  `opts.shield`：这一轮值得举盾吗（副手有盾 + 目标近战贴脸 / 远程在射我 / 被围） */
  /* 🔴 审计（2026-10-18）：战斗期间**关掉自动吃**。mineflayer-auto-eat 会在低血时自作主张
   *    换手吃、按右键，战斗那几秒里等于把剑收起来。只在真正开打的这段关，打完立刻还原。 */
  const eatOff = () => {
    const ae = b?.autoEat
    if (!ae || typeof ae.disableAuto !== 'function' || ae.enabled === false) return null
    try { ae.disableAuto() } catch { return null }
    return ae
  }
  const eatBack = (ae) => {
    if (!ae || typeof ae.enableAuto !== 'function') return
    try { ae.enableAuto() } catch { /* 还不了也无害：自主层下一拍会按配置重新开 */ }
  }

  const engagePvp = async (opts = {}) => {
    const ae = eatOff()
    /* 🔴 `bot.pvp.attack(target)` **立刻** resolve（它只做三件事：设 target、`GoalFollow` 追过去、
     *    发 `startedAttacking` 事件），真正挥拳的是 `physicTick` 上的后台循环 ⇒
     *    旧写法 `await withTimeout(b.pvp.attack(...))` 一毫秒就返回，紧接着 `finally` 里
     *    `b.pvp.stop()` 又把追过去的 goal 停掉 ⇒ **一下都没打，却回 "attacked: X"**。
     *    所以这里必须自己等：等到目标没了 / 这一轮的时间用完，再停。 */
    // 2026-10-08 审计⑦：`Math.max(300, …)` 在本轮已经用完时会白送 300ms（见 walkTo 同类注释）。
    const left = ctx.callLeft() - 600
    const bd = left <= 100 ? 0 : Math.max(0, Math.min(phaseMs(), left))
    const t0 = Date.now()
    let note = null
    let pvpErr = null
    /* 🔴 2026-10-15 审计：`killed: gone` 把"怪走出服务端实体追踪距离（destroy 包）/ 区块卸载"
     *    当成"我打死了它" ⇒ 后面还会据此报掉落物。只有**消失前读到过血量下降**才算打死。 */
    let sawDamage = false
    let lastHp = hpBefore
    /* 2026-10-18（用户：「一次 3 秒不能中断，打一半想跑跑不掉」「骷髅边跑边射追不上」）：
     * 这一轮里也盯着三件事 —— 血掉太猛、目标越跑越远、什么时候该举盾。 */
    let shields = 0
    let ticks = 0
    let hardHurt = false
    let chaseGiveUp = false
    let grewSince = 0
    let lastDist = distOf(target)
    const hpStart = Number(b.health)
    /* 🔴 2026-11-01（用户 m14334：「他在 (21,64,90) 我在 (21,64,88) —— 2 格距离！应该能打」
     *    + 「距离 1.9 格 —— 在 3.5 内啊，却不打」）：
     *   以前**出手完全交给 vendor 的后台循环**（`physicTick` 上的 `update()`）——
     *   它挥没挥、挥了几下，我们一个字都读不到 ⇒ 人站在 1.9 格内、一下不挥，
     *   最后还报「还没进到攻击距离（3.5 格）」，跟同一条结果里的 `distance:1.9` 自相矛盾。
     *   现在自己挥：实时距离 + 视线 + 冷却，每轮循环判一次；pvp 只剩「帮我追过去」。 */
    let mySwings = 0
    let pvpSwings = 0
    let lastSwingAt = 0
    let swingCd = swingCooldownMsOf(b).ms
    let losNote = null
    const onAtk = () => { pvpSwings++ }
    /* pvp 只用来追（`GoalFollow`）：`attackRange` 归零 ⇒ 它的 `checkRange` 永远判「不在范围」⇒
     * 它不挥拳，也就不会跟我们抢攻击冷却（两头同时挥，每一刀都落在冷却里，伤害打折）。 */
    let pvpRangeSave = null
    try { pvpRangeSave = b.pvp.attackRange; b.pvp.attackRange = 0 } catch { /* 老版本没这字段就算了 */ }
    try { b.on?.('attackedTarget', onAtk) } catch { /* 事件挂不上不影响出手 */ }
    /* 🔴 2026-11-02（用户 m15348：「打到一下以后，不会追着打」）：
     *   追还是交给 vendor 的 `GoalFollow`（它成熟、不阻塞，天然能边跑边打），但它有三个洞要在外面补：
     *   ① `attack()` 内部 `setMovements(new Movements(...))`（`PVP.js:71`）—— 把我们配的门/垫柱/挖/
     *      实体避让/落差上限整套顶掉，追的时候走的是没打过补丁的那份 ⇒ 这里换回我们自己的（下面那行）。
     *   ② 它停了**不会自己起来**：`entityGone` / `dist > viewDistance` / `NoPath` 走到 `path_stop`
     *      任一个都会清掉 `this.target`，之后没人重设 ⇒ 我们循环只等不追，一直耗到超时。
     *      现在每 500ms 看一眼：target 丢了、或者人 700ms 没挪，就重新发起追击（下面循环里那段）。
     *   ③ 重设次数有上限（`CHASE_MAX`），真的追不上就如实报，不许死循环。 */
    let chaseResets = 0
    let lastChaseAt = 0
    let chaseStallAt = Date.now()
    let chasePos = b.entity?.position ? { x: b.entity.position.x, z: b.entity.position.z } : null
    let chaseGaveUp = false
    let lastWalkAt = 0
    const CHASE_MAX = 30
    const chaseAgain = async () => {
      const now3 = Date.now()
      if (now3 - lastChaseAt < 500) return
      if (chaseResets >= CHASE_MAX) { chaseGaveUp = true; return }
      lastChaseAt = now3
      chaseResets++
      try { b.pvp.forceStop?.() } catch { /* 老版本没有 forceStop：下面 attack 会自己 stop */ }
      try { await b.pvp.attack(target) } catch (e) { pvpErr = String(e?.message ?? e) }
      chaseStallAt = Date.now()
    }
    try {
      /* 🔴 2026-10-28（用户：「有高低差呢」）：pvp 的挥拳只判**距离**，不管中间有没有东西 ——
       *    隔着一层地板/墙时它照样空打到预算耗尽。这里先做视线检查，被挡就不进战斗。 */
      const los0 = losBlockOf(target)
      if (los0) {
        throw Object.assign(new Error(
          `眼睛到「${label}」之间隔着 ${los0.blocker}（${los0.at.x},${los0.at.y},${los0.at.z}）`
          + ' —— 挥了也是空；先挖开那一格，或者绕到能看见它的位置再打'
        ), { mcLos: true })
      }
      /* 让 pvp 用**我们这份** Movements（它默认会 new 一份默认配置，把门/垫柱/挖/避让全顶掉）。 */
      try { if (b.pathfinder?.movements) b.pvp.movements = b.pathfinder.movements } catch { /* 换不过来就用它自己的 */ }
      await b.pvp.attack(target)
      chaseStallAt = Date.now()   /* 刚发起追击，重新起算"多久没挪" */
      while (Date.now() - t0 < bd) {
        if (ctx.abortSignal?.aborted) break
        if (!b.entities?.[target.id] || target.isValid === false) break
        const hp = entityHealth(b, target)
        if (hp != null) {
          if (lastHp != null && hp < lastHp) sawDamage = true
          lastHp = hp
        }
        /* ① 血掉太猛 ⇒ 这一轮提前收手（别等阶段走完） */
        if (Number.isFinite(hpStart) && Number.isFinite(Number(b.health)) && hpStart - Number(b.health) >= 4) {
          hardHurt = true
          break
        }
        /* ② 远程目标越跑越远（持续 2.5 秒距离都在变大、且已经 >6 格）⇒ 别把预算花在追屁股上 */
        /* 🔴 2026-10-29（用户：「attack 卡住了 sheep … 追了 9.5 秒」）：会逃的**被动动物**
         *   （羊 4.6 格/秒 > 我们走路 4.3 格/秒）以前不在放弃名单里 ⇒ 整整 9.5 秒干等。
         *   它们同样“越跑越远就该收手”，给 2 秒 / 7 格的宽限（动物被打一下会先跑一段，
         *   给太短会打不死）。 */
        const fleer = FLEE_RE.test(label)
        const dd = distOf(target)
        if (dd <= lastDist - 0.15) grewSince = 0
        else if (dd >= lastDist + 0.15 && !grewSince) grewSince = Date.now()
        lastDist = dd
        if (grewSince && Date.now() - grewSince >= (fleer ? 2_000 : 900)
          && dd > (fleer ? 7 : 6) && (RANGED_RE.test(label) || fleer)) {
          chaseGiveUp = true
          break
        }
        /* ③ 够不着 ⇒ 确认 vendor 还在追（它掉线是本函数最隐蔽的坑，见上面 `chaseAgain` 的注释）。
         *   判据只用两件事：它自己还认不认这个 target、以及我这一拍有没有真的挪动。 */
        if (dd > ATTACK_REACH + 0.4) {
          const now3 = Date.now()
          const p3 = b.entity?.position
          const stalled = Boolean(chasePos && p3
            && Math.hypot(p3.x - chasePos.x, p3.z - chasePos.z) < 0.25)
          if (stalled) { /* 原地不动就一直算停着 */ } else chaseStallAt = now3
          const lost = !b.pvp?.target
          if (lost || now3 - chaseStallAt >= 700) await chaseAgain()
          if (chaseGaveUp) break
          /* 🔴 2026-11-02（用户 m15465：「不能前半段用我们的 move、后半段用 pvp 吗」）：
           *   现在正是这么分的 —— 策略层 `d0 > 3.5` 先用自己的 `walkTo`（会绕、会挖、会跳、会避让）
           *   走到 3.2 格内，再交给 pvp 贴身追、我们挥拳。
           *   缺的是**交接处的回退**：pvp 只会在平地上蹭，途中一个坑/台阶/水面它就走不动，
           *   而我们已经进了 engage ⇒ 没人再走路。所以连续重设 3 次追击、距离还是 > 4 格时，
           *   切回 `ctx.moveTo` 自己走一段（走完把计数清零，下一拍再交给 pvp）。 */
          /* 预算口径：先留 800ms 给挥拳，剩下的才拿来走路；不够 500ms 就这一拍不走
           * （全仓禁止 Math.max(固定值, …剩余…) 那种写法 —— 见 check-call-budget）。 */
          const restMs = ctx.callLeft() - 800
          if (chaseResets >= 3 && dd > 4.0 && typeof ctx.moveTo === 'function'
            && now3 - lastWalkAt >= 800 && restMs > 500) {
            lastWalkAt = now3
            const tp2 = target.position
            const mp2 = b.entity?.position
            if (mp2 && tp2) {
              const pt = approachPointOf({ x: mp2.x, y: mp2.y, z: mp2.z }, { x: tp2.x, y: tp2.y, z: tp2.z },
                Math.max(1.5, dd - 2.0))
              const slot = Math.min(1_500, restMs)
              try {
                const mv2 = await ctx.moveTo(pt, { arrive: 1.0, budget: slot, reason: `战斗追击：走到「${label}」旁边` })
                if (mv2 && mv2.arrived !== true) {
                  moveErr = String(mv2.hint ?? mv2.reason ?? '追到一半停了，没给原因').slice(0, 140)
                }
              } catch (e) {
                moveErr = String(e?.message ?? e).slice(0, 140)
              }
              chaseResets = 0
              chaseStallAt = Date.now()
              continue
            }
          }
          if (p3) chasePos = { x: p3.x, z: p3.z }
        } else {
          chaseStallAt = Date.now()
          if (b.entity?.position) chasePos = { x: b.entity.position.x, z: b.entity.position.z }
        }
        /* ③ 自己挥拳。够得着就按手里那把的冷却挥（剑 700ms / 斧 1250ms / 空手 250ms）。 */
        if (dd <= ATTACK_REACH) {
          const now2 = Date.now()
          if (now2 - lastSwingAt >= swingCd) {
            const losM = losBlockOf(target)
            if (losM) { losNote = losM; break }   /* 隔着方块就别挥（挥了也是空，还看不出原因） */
            lastSwingAt = now2
            try {
              const eh = Number(target.height) > 0 ? Number(target.height) : 1.8
              await b.lookAt(target.position.offset(0, Math.min(1.3, eh * 0.5), 0))
            } catch { /* 看不过去也照打，别因为转头失败就不出手 */ }
            /* 走 `ctx.t` 的预算闸门（与 `engageSwing` 同一个口径）：发包要记账，预算见底时它会抛。 */
            try {
              await ctx.t(Promise.resolve(b.attack(target)), 'attack', `攻击 ${label}`)
              mySwings++
            } catch { /* 预算用尽 / 服务端没接 ⇒ 下一轮再试 */ }
            swingCd = swingCooldownMsOf(b).ms
            await sleep(60)
            continue
          }
        }
        /* ③ 举盾：只在"等它打过来"的窗口举 0.3 秒，挡完立刻放（举着不能攻击，会拖慢输出） */
        if (opts.shield && (++ticks % 8) === 0) {
          try { b.activateItem(true); shields++ } catch { /* 没有副手盾 / 插件不支持就跳过 */ }
          await sleep(320)
          try { b.deactivateItem() } catch { /* 放不下也不影响下一轮 */ }
        }
        await sleep(120)
      }
    } catch (e) {
      if (e?.mcAborted) throw e
      pvpErr = String(e?.message ?? e)
    } finally {
      /* 🔴 这里**不能 await**：`pvp.stop()` 里 `onceWithTimeout('path_stop', 5000)` 最多等 5 秒，
       *    会把这一轮的预算整段吃光（而且 pathfinder 的 stop 在它第一行就已经做了）。 */
      try { Promise.resolve(b.pvp.stop()).catch(() => {}) } catch { /* 停不掉也不影响 */ }
      try { if (pvpRangeSave != null) b.pvp.attackRange = pvpRangeSave } catch { /* 恢复不了也没事 */ }
      try { b.removeListener?.('attackedTarget', onAtk) } catch { /* 忽略 */ }
      eatBack(ae)
    }
    const gone = !b.entities?.[target.id] || target.isValid === false
    const killed = gone && sawDamage
    /* 🔴 2026-10-19 实机：`b.pvp.wasInRange` 在多数版本里**根本不存在**（读出来永远 undefined）
     *    ⇒ "够不够得着"永远判成 false。实测 slime 从 16 血被打到 6.9 血（确实贴着打到了），
     *    结果却报"追了 1.2 秒还没进到攻击距离"+ 整轮 `outcome: failed` / `combat: unreachable`。
     *    目标**掉过血**就是"进过攻击距离"的铁证（它不会隔空掉血），拿它兜底。 */
    /* 🔴 2026-11-01：`wasInRange` 只在 vendor 的 `checkRange()` 里更新，而它开头
     *   `if (this.timeToNextAttack < 0) return` —— 提前 return 就不更新；`sawDamage` 又要读到目标掉血
     *   （打**玩家**时血量根本看不到）。两个都落空 ⇒ `inRange:false` ⇒ 站在 1.9 格也报「没进攻击距离」。
     *   现在以**实时距离**为准，再并上「我自己挥过 / vendor 挥过 / 它掉过血」。 */
    const inRange = Boolean(b.pvp?.wasInRange) || sawDamage || mySwings > 0 || pvpSwings > 0
      || Number(distOf(target).toFixed(1)) <= ATTACK_REACH
    const hpAfter = gone ? (killed ? 0 : null) : entityHealth(b, target)
    const waitedMs = Date.now() - t0
    if (gone && !killed && !pvpErr) {
      note = `目标不见了，但**没读到过它掉血** —— 说不清是我打死的还是它走远/区块卸载了（别当成打死了）`
    }
    if (hardHurt) {
      note = `这一轮挨了 ${(hpStart - Number(b.health)).toFixed(0)} 点伤害 —— 血掉太快，提前收手（先撤或找掩体，别硬顶）`
    }
    if (chaseGiveUp) {
      note = FLEE_RE.test(label)
        ? `「${label}」一直在逃（现在 ${distOf(target).toFixed(1)} 格）—— 它跑得比我们走路快（4.6 vs 4.3 格/秒），`
          + '硬追只是烧时间：用 `mc_shoot` 打，或者先用方块把它围住/逼进角落'
        : `目标越跑越远（现在 ${distOf(target).toFixed(1)} 格）—— 远程怪边跑边射，追不上；先找掩体/绕侧，或换目标`
    }
    /* 打死了 ⇒ 掉落物就掉在原地。用户 2026-10-08 原话："打完动物以后老是忘记走过去拾取" ——
     * 只**点一句**，不替它走过去（先捡哪个、走多远是决策，而且这一轮的预算基本已经花完了）。 */
    const pickup = killed ? dropHint(b) : null
    /* 🔴 2026-10-22（下界连丢两根烈焰棒）：只给一句"地上还有 N 个"不够 ——
     *   **东西在哪**才是 AI 决策的依据（值不值得下那个崖 / 隔了几格）。
     *   这里只报事实，不替 AI 走过去。 */
    const drops = killed ? dropListOf(b, { radius: 10, limit: 4 }) : []
    /* 已经给出更具体的原因（血掉太猛 / 追不上）就别用"没打死"把它盖掉 */
    if (!gone && !pvpErr && !hardHurt && !chaseGiveUp) {
      note = inRange
        ? `打了 ${(waitedMs / 1000).toFixed(1)} 秒还没打死（这一轮的时间到了）—— 再叫一次 mc_attack 接着打`
        /* 🔴 2026-10-27：以前这里只能三选一瞎猜（"走不过去 / 被方块挡住 / 目标跑太快"）——
         *   现在追击是自己走过去的，走不动的原因能直接带出来（NoPath / 卡住 / 目标在飞）。 */
        : `追了 ${(waitedMs / 1000).toFixed(1)} 秒还没进到攻击距离（3.5 格）—— `
          + (moveErr ? `走近时失败：${moveErr}` : '走不过去 / 被方块挡住 / 目标跑太快')
          /* 🔴 2026-10-29：会跑的动物（羊 4.6 格/秒）比我们走路 4.3 格/秒还快 —— 以前只说"目标跑太快"，
           *   模型就反复再叫一次攻击。把「我挪了几格 / 它时速多少」摆出来，它才知道该换手段。 */
          + (mem.approachMoved != null || mem.targetSpeed
            ? `（这段我挪了 ${mem.approachMoved ?? 0} 格，它约 ${mem.targetSpeed ?? '?'} 格/秒；我走路只有 4.3 格/秒）`
              + (Number(mem.targetSpeed ?? 0) > 4 ? '—— **比我快，追不上**：用 mc_shoot 打，或先把它逼进角落/用方块围住' : '')
            : '')
          + '；也可以先 mc_move 到它旁边，或换个不跑的目标'
    }
    if (chaseGaveUp && !note) {
      note = `追了 ${(waitedMs / 1000).toFixed(1)} 秒没靠近（重设了 ${chaseResets} 次追击，人一直在原地）`
        + ' —— 它多半在高处 / 水里 / 被方块隔着；先 mc_move 到它旁边，或者换 mc_shoot'
    }
    return {
      attacked: label, distance: Number(distOf(target).toFixed(1)), killed, gone, health: b.health, via: 'pvp', waitedMs,
      ...(chaseResets ? { chaseResets } : {}),
      /* 追上了却没伤到人时，这两条是唯一的分辨依据：`swings:0` = 压根没出手，
       * `swings>0` 而 `killed:false` = 出手了没打死（伤害不够/它跑得快）。 */
      swings: mySwings, pvpSwings,
      ...(losNote ? { losBlocked: { x: losNote.at.x, y: losNote.at.y, z: losNote.at.z, name: losNote.blocker } } : {}),
      ...(mem.approachMoved != null ? { approachMoved: mem.approachMoved } : {}),
      ...(mem.targetSpeed ? { targetSpeed: mem.targetSpeed } : {}),
      ...(hpBefore != null && hpAfter != null && hpBefore !== hpAfter ? { targetHealth: `${hpBefore} → ${hpAfter}` } : {}),
      ...(note ? { note } : {}),
      ...(pickup ? { pickup } : {}),
      ...(drops.length ? { drops } : {}),
      ...(pvpErr ? { error: pvpErr } : {}),
      ...(shields ? { shieldBlocks: shields } : {}),
      /* 内部字段（下划线开头，不进最终返回值）：给策略层判断用 */
      _sawDamage: sawDamage, _inRange: inRange, _gone: gone, _killed: killed,
      _shields: shields, _hardHurt: hardHurt, _chaseGiveUp: chaseGiveUp,
    }
  }

  /** 没有 pvp 插件：退化成原地挥（上游原版就是一次 `b.attack`，这里按预算多挥几下） */
  const engageSwing = async () => {
    const ae = eatOff()
    const hpStart = Number(b.health)
    const t0 = Date.now()
    const leftMs2 = ctx.callLeft() - 400
    const bd = leftMs2 <= 100 ? 0 : Math.max(0, Math.min(phaseMs(), leftMs2))
    let swings = 0
    let losBlocked = null
    let sawDamage2 = false
    let hardHurt = false
    let lastHp2 = hpBefore
    const sample = () => {
      const hp = entityHealth(b, target)
      if (hp == null) return
      if (lastHp2 != null && hp < lastHp2) sawDamage2 = true
      lastHp2 = hp
    }
    /* 挥砍节奏按**手里那把**算（剑 700ms / 斧 1250ms / 镐 850ms / 空手 250ms，含 1 tick 余量，见 src/combat-timing.mjs）。
     * 旧版写死 620ms：拿斧或铲时每次都在冷却没满时挥 —— 那一刀是**打折伤害**。 */
    let swing = swingCooldownMsOf(b)
    /* 站桩：不追，等目标自己走进**攻击距离**（末影人会自己凑过来；追过去就掉出那个 2 格洞了）。
     * 🔴 2026-11-02 审计（#3）：这里原来是 4.5（搜索范围）。4.5 格挥手服务端不认 ——
     *   2026-10-30 实机「距离 1.9 格却不打」同根：一处算 4.5 一处算 3.5，谁都不服谁。 */
    const waitFrom = Date.now()
    if (standMode) {
      while (Date.now() - t0 < bd && distOf(target) > ATTACK_REACH) {
        if (ctx.abortSignal?.aborted) break
        if (!b.entities?.[target.id] || target.isValid === false) break
        await sleep(150)
        sample()
      }
    }
    const waitedMs = standMode ? Date.now() - waitFrom : 0
    while (Date.now() - t0 < bd) {
      if (ctx.abortSignal?.aborted) break
      if (!b.entities?.[target.id] || target.isValid === false) break
      if (distOf(target) > ATTACK_REACH) break
      /* 隔着方块就不挥（挥了也是空，而且看不出原因） */
      const losM = losBlockOf(target)
      if (losM) { losBlocked = losM; break }
      /* 🔴 手动分支原来直接 `b.attack()`，不看方向 —— 目标在头顶上方时就是空挥。站桩尤其要抬头。 */
      if (standMode && typeof b.lookAt === 'function' && target.position) {
        try {
          const eh = Number(target.height) > 0 ? Number(target.height) : 1.8
          await b.lookAt(target.position.offset(0, Math.min(1.3, eh * 0.5), 0))
        } catch { /* 看不过去也照打，别因为转头失败就不出手 */ }
      }
      await ctx.t(Promise.resolve(b.attack(target)), 'attack', `攻击 ${label}`)
      swings++
      swing = swingCooldownMsOf(b)
      await sleep(swing.ms)
      sample()
      if (Number.isFinite(hpStart) && Number.isFinite(Number(b.health)) && hpStart - Number(b.health) >= 4) {
        hardHurt = true
        break
      }
    }
    // 没有 pvp 时至少挥一下（bd=0 说明这一轮已经用完了，那就别再拖）
    if (swings === 0 && b.entities?.[target.id] && target.isValid !== false && distOf(target) <= ATTACK_REACH && !ctx.abortSignal?.aborted) {
      try { await ctx.t(Promise.resolve(b.attack(target)), 'attack', `攻击 ${label}`); swings = 1 } catch {}
      await sleep(200)
      sample()
    }
    const gone = !b.entities?.[target.id] || target.isValid === false
    /* 🔴 同 pvp 分支：`gone` ≠ `killed`（怪可能只是走远/区块卸载）。 */
    const killed = gone && sawDamage2
    const pickup = killed ? dropHint(b) : null
    /* 🔴 2026-10-22（下界连丢两根烈焰棒）：只给一句"地上还有 N 个"不够 ——
     *   **东西在哪**才是 AI 决策的依据（值不值得下那个崖 / 隔了几格）。
     *   这里只报事实，不替 AI 走过去。 */
    const drops = killed ? dropListOf(b, { radius: 10, limit: 4 }) : []
    const inRange = distOf(target) <= ATTACK_REACH
    eatBack(ae)
    /* 🔴 2026-10-20 审计（真 bug）：下面原来两次 spread `note`，后一个会把前一个**整个盖掉**
     *    —— `gone && !killed` 那句"别当成打死了"在挨打时永远看不到。合成一条。 */
    const notes = []
    if (gone && !killed) notes.push('目标不见了，但**没读到过它掉血** —— 说不清是我打死的还是它走远/区块卸载了（别当成打死了）')
    if (losBlocked) notes.push(`眼睛到「${label}」之间隔着 **${losBlocked.blocker}**（${losBlocked.at.x},${losBlocked.at.y},${losBlocked.at.z}）—— 这一轮一下都没挥（挥了也是空）；先挖开它，或者换个能看见目标的身位`)
    if (hardHurt) notes.push(`这一轮挨了 ${(hpStart - Number(b.health)).toFixed(0)} 点伤害 —— 血掉太快，提前收手`)
    const nowDist = distOf(target)
    return {
      attacked: label, distance: Number(nowDist.toFixed(1)), swings, killed, gone, health: b.health,
      ...(losBlocked ? { losBlocked: { x: losBlocked.at.x, y: losBlocked.at.y, z: losBlocked.at.z, name: losBlocked.blocker } } : {}),
      ...(notes.length ? { note: notes.join('；') } : {}),
      ...(standMode
        ? {
            stood: true,
            standAt: b.entity?.position
              ? { x: Math.floor(b.entity.position.x), y: Math.floor(b.entity.position.y), z: Math.floor(b.entity.position.z) }
              : null,
            ...(standHeadroomOf(b) != null ? { headroom: standHeadroomOf(b) } : {}),
            ...(waitedMs ? { waitedMs } : {}),
            ...(swings === 0
              ? {
                  outOfReach: {
                    distance: Number(nowDist.toFixed(1)),
                    targetY: Math.floor(target.position.y),
                    myY: Math.floor(b.entity?.position?.y ?? 0),
                  },
                }
              : {}),
          }
        : {}),
      ...(pickup ? { pickup } : {}),
      ...(drops.length ? { drops } : {}),
      _sawDamage: sawDamage2, _inRange: inRange, _gone: gone, _killed: killed, _hardHurt: hardHurt,
    }
  }

  /* ═══════════ ② 观察 → 决策 → 执行一个阶段 → 再看一遍 ═══════════ */

  const canMove = typeof ctx.moveTo === 'function'
  const canEquip = typeof ctx.equipTo === 'function'
  const t00 = Date.now()
  const mem = { repositions: 0, equips: 0, lastEquipAt: 0, lastInRange: null, kites: 0, kiteBlocked: 0, kiteWhy: null }
  const actions = []
  const hurt = []
  /** 开打时手里是什么（收工结果里对比着说，AI 才知道"手被换过"） */
  const heldAtStart = b.heldItem?.name ?? null
  /** 这一轮真的换上去的武器（回读确认过的，不是"我调过 equip"） */
  const equippedTo = []
  /** 换不上去的原因（有就写进结果的 `weaponWarn`，别让 AI 以为"它自己会换"） */
  let equipFail = null
  /** 有更好的武器但这轮没换的原因（用户 2026-10-21："攻击自动切也不生效" ——
   *  先分清是"没建议换"还是"被次数/冷却挡住"，别让人只能猜） */
  let equipNote = null
  let sawDamageAny = false
  let shieldsAny = 0
  let last = null
  /* 🔴 2026-10-17（用户："自动战斗的优先级不应该比 AI 高"）：策略层想撤 / 想拉开距离时，
   *    这里只记**建议**，不执行 —— 见下面 `chooseStrategy` 的解构。 */
  const advice = []
  let unreachable = false
  let aborted = false
  let timedOut = false
  let lastStep = null
  let lastSnap = null
  let moveErr = null

  /** 视野里的敌对（`all` 已经是 24 格内、带名字和距离的快照） */
  const foesOf = (radius = NEARBY_R) => all
    .filter((x) => x.d <= radius && stanceOf(x) === 'hostile')
    .map((x) => ({
      /* 🔴 带 `id` 是为了把"正在打的那只"从威胁里**按身份**剔掉 ——
       *    第一版按**名字**剔（`f.name !== label`），于是三只僵尸会被一起剔光，
       *    "被围"永远数不出来。名字是用来给人看的，身份只能用 id。 */
      id: x.e.id ?? null,
      name: x.nm, distance: Number(x.d.toFixed(1)), hostile: true,
      ranged: RANGED_RE.test(x.nm),
      /* mineflayer 没有"谁在打我"的现成字段；有些怪会暴露 `target`。
       * 拿不到就退化成"贴到 3 格内就算在打我"—— 这比"一律不算"更接近事实。 */
      attackingMe: x.e.target === b.entity || x.d <= 3,
    }))

  for (let round = 0; round < MAX_ROUNDS; round++) {
    if (ctx.abortSignal?.aborted) { aborted = true; break }
    /* 🔴 **两道**闸门，缺一不可：
     *   ① `budget`（这次调用自己的总预算）—— 没有它，一个"目标没死、callLeft 还很宽裕"的
     *      循环会一轮轮各吃满 `min(budget, 4000)`，把总时间翻好几倍
     *      （`check-core-attack` 的"stop 挂住也按时返回"当场逮到：400ms 的预算跑了 1994ms）。
     *   ② `callLeft()`（这一轮**工具调用**还剩多少）—— 预算没超但宿主的时间快到了，也得收手。 */
    if (Date.now() - t00 >= budget - 100) { timedOut = true; break }
    if (ctx.callLeft() <= 500) { timedOut = true; break }

    /* ── 目标没了 / 跑出 24 格 ⇒ 换下一只（用户 2026-10-18：「目标跑了也不换目标，这一轮就废了」）──
     *    只换"同一批候选"里（点名就只在同名候选里挑），不擅自改成另一类目标。 */
    if (!trackable()) {
      const lost = label
      if (!select({ reselect: true })) {
        unreachable = true
        moveErr = `「${lost}」不见了，24 格内也没有能接手的${needle ? `「${who}」` : '怪'}（附近：${near || '什么都没有'}）`
        break
      }
      retargets++
      actions.push('retarget')
    }
    /* 每轮刷新视野（威胁分要按当前局面算，不能拿几秒前的快照） */
    all = snapshotAll()

    const now = Date.now()
    if (Number.isFinite(Number(b.health))) hurt.push({ at: now, health: Number(b.health) })
    const prev = LAST_SEEN.get(b)
    if (prev && Number.isFinite(Number(prev.health)) && now - prev.at <= 30_000) {
      hurt.unshift({ at: prev.at, health: Number(prev.health) })
    }

    const stillThere = Boolean(b.entities?.[target.id]) && target.isValid !== false
    const foes = foesOf()
    const heldItem = b.heldItem ?? null
    const held = heldItem?.name ?? null
    let bagItems = []
    try { bagItems = b.inventory?.items?.() ?? [] } catch { bagItems = [] }
    const items = bagItems.map((i) => i?.name).filter(Boolean)
    /* 🔴 2026-10-17（用户实机：副手一直挂着 `shield 103/336`，它却报「没有盾牌，只能拉开距离」）：
     *    `b.inventory.items()` 只覆盖**背包 9..44 格**（主背包 + 快捷栏）—— 副手是 **45 格**、
     *    盔甲是 **5..8 格**，都不在里面 ⇒ 盾挂在副手 = 对这里完全不可见。
     *    槽位表直接用 `src/inventory.mjs` 的 `EQUIP_SLOTS`（`mc_inventory` / 耐久功能一直在用，
     *    别再手写一份槽号）。读不到就当没穿，绝不因此抛错。 */
    const equipped = []
    try {
      const slots = b.inventory?.slots
      if (Array.isArray(slots)) {
        for (const [slotIdx] of EQUIP_SLOTS) {
          const it = slots[slotIdx]
          if (it?.name) equipped.push(it.name)
        }
      }
    } catch { /* 读不到装备栏就当没穿 */ }
    /* 武器耐久：同一个名字可能有好几把，取**最好的一把**（换上一把快坏的没意义） */
    const pctOfItem = (it) => {
      try { const d = durabilityOf(it); return d && Number.isFinite(d.pct) ? d.pct : null } catch { return null }
    }
    const bagPct = new Map()
    for (const it of bagItems) {
      const n = it?.name
      if (!n) continue
      const p = pctOfItem(it)
      if (p == null) continue
      if (!bagPct.has(n) || p > bagPct.get(n)) bagPct.set(n, p)
    }

    const snap = assessCombat({
      health: b.health, food: b.food, air: Number.isFinite(b.oxygenLevel) ? Math.max(0, Math.round(Number(b.oxygenLevel))) : null, submerged: b.entity?.isInWater === true,
      target: {
        name: label,
        distance: stillThere ? distOf(target) : null,
        health: stillThere ? entityHealth(b, target) : null,
        hostile: hostilityOf(label, target.kind) === 'hostile',
        ranged: RANGED_RE.test(label),
        attackingMe: stillThere && (target.target === b.entity || distOf(target) <= 3),
        canReach: mem.lastInRange === null ? undefined : mem.lastInRange,
      },
      /* `isTarget` 标出正在打的那只（按 **id** 标，不按名字 —— 三只僵尸同名，
       * 按名字标会把另外两只一起标上，于是"被围"永远数不出来）。 */
      foes: foes.map((f) => ({ ...f, isTarget: f.id === target.id })),
      held, items,
      heldPct: pctOfItem(heldItem),
      pctOf: (n) => (bagPct.has(n) ? bagPct.get(n) : null),
      hasShield: items.some((n) => isShield(n)) || equipped.some((n) => isShield(n)) || isShield(held),
      hurt, now, hasPvp,
      autoEat: b.autoEat?.enabled !== false,
      targetGone: !stillThere,
      sawDamage: sawDamageAny,
      wasInRange: mem.lastInRange,
    })
    const wanted = chooseStrategy(snap, mem)
    /* 🔴 2026-10-17（用户："自动战斗的优先级不应该比 AI 高" ⇒ 回的是"一律不停"）：
     *
     *   `mc_act{attack}` 是 **AI 自己叫的**，那就是命令 —— 内建策略层**没有否决权**。
     *   被围、有远程在射我、血少了，策略想说"退"都只记成**建议**，手不停：
     *   真要撤是 AI 自己叫 `mc_move`（它才知道撤离方向对不对、后面还要不要回来）。
     *
     *   以前这里是把 `defend` / `retreat` **直接执行**：往反方向退 8 格然后 break，
     *   于是 AI 说"打这只骷髅"，战斗层自己掉头走了 —— 命令被策略改掉了。
     *   现在只留 `attack.mjs` 里的**机械动作**（换武器、走位靠近），决策权还给 AI。 */
    const advisory = wanted.action === 'retreat' || wanted.action === 'defend'
    const step = advisory
      ? {
          ...wanted,
          action: 'engage',
          /* 这一轮**实际执行**的是进攻 ⇒ state 也得跟着改，否则结果里 `strategy:"defend"`
           * 和 `actions:["engage"]` 自相矛盾（AI 会以为我们真的退了）。 */
          state: 'engage',
          reason: 'hold-line',
          why: `策略层建议${wanted.action === 'defend' ? '拉开距离' : '撤退'}（${wanted.why}），但这一轮是你叫的打 —— 我不改道`,
          advice: wanted.action,
        }
      : wanted
    if (advisory) advice.push({ action: wanted.action, reason: wanted.reason, why: wanted.why })
    lastStep = step
    lastSnap = snap
    if (!equipNote && snap.weapon?.name && step.action !== 'equip') {
      /* 2026-10-23 审计：mem.equips 换武器失败时会被写成哨兵 99，直接读出来就变成
       * 「这一场已经换过 99 次」（排查时误以为策略在疯狂横跳）。这里只报真正的原因。 */
      equipNote = mem.equips >= 2
        ? (equipFail
          ? `背包里有更好的 ${snap.weapon.name}，但这一场换不上（${equipFail}），不再换`
          : `背包里有更好的 ${snap.weapon.name}，但这一场已经换过 2 次（上限 2），不再换`)
        : `背包里有更好的 ${snap.weapon.name}，换装冷却中（${EQUIP_COOLDOWN_MS}ms）`
    }
    actions.push(step.action)

    /* ── 收工 ── */
    if (step.action === 'complete') break

    /* ── 够不着，试够了 ── */
    if (step.action === 'stop') {
      /* 站桩：策略层说"够不着"不算这一轮失败 —— 这一轮本来就是要站在洞里等它来。 */
      if (!standMode) { unreachable = true; break }
      actions.push('hold')
    }

    /* ── 换武器 ── */
    if (step.action === 'equip') {
      if (!canEquip) { mem.equips = 99 /* 没能力就别再问了 */ } else {
        const want = step.name
        try {
          await ctx.equipTo(want)
          /* 🔴 只认**手上真的是那件**，不认"我调过 equip"（用户 2026-10-19：
           *    "武器也自动切换我也没看到生效" —— 换装静默失败时，结果里必须说出来）。 */
          const nowHeld = b.heldItem?.name ?? null
          if (nowHeld === want) equippedTo.push(want)
          else { mem.equips = 99; equipFail = `要换 ${want}，换完手里却是 ${nowHeld ?? '空手'} —— 没换上去` }
        } catch (e) {
          mem.equips = 99
          equipFail = `换武器失败：${String(e?.message ?? e).slice(0, 80)}`
        }
        mem.equips++
        mem.lastEquipAt = Date.now()
      }
      continue
    }

    /* ── 重新找位 ── */
    if (step.action === 'reposition') {
      /* 🔴 站桩：一步都不挪 —— 直接落到下面的"进攻"，由进攻段原地等目标走近。
       *   挪一下就走出了那个 2 格洞，防护立刻失效（用户 m06001 的用法就是这样）。 */
      if (standMode) {
        actions.push('hold')
      } else {
        if (!canMove) { unreachable = true; moveErr = '够不着，但这次调用没给我移动能力（ctx.moveTo 不在）'; break }
        const mp = b.entity?.position
        const tp = target.position
        const pt = mp && tp ? approachPointOf({ x: mp.x, y: mp.y, z: mp.z }, { x: tp.x, y: tp.y, z: tp.z }, 3) : null
        if (!pt) { unreachable = true; moveErr = '算不出往哪挪（我和目标位置重合）'; break }
        try { await ctx.moveTo(pt, { reason: `战斗走位：${step.why}` }) } catch (e) { moveErr = String(e?.message ?? e) }
        mem.repositions++
        mem.lastInRange = null
        continue
      }
    }

    /* ── 先追过去（这一步**有寻路**） ──
     * 🔴 2026-10-27 实机（用户：「attack 好像没有寻路，老是被卡住」）：session-514c21b6 最近
     *   2 小时的 8 次 `mc_attack` 里 5 次是「追了 1.2 秒还没进到攻击距离」→ `unreachable`
     *   + `outcome:failed`，目标距离 4.1 / 6.7 / 7.2 / 11.6 格。
     *   原因不是"没寻路"，而是当时"追"只交给 pvp 的 `GoalFollow`（裸跟：撞墙、遇水、遇沟、
     *   遇高低差就干等），而会绕路/会挖/会搭/会跳的 `walkTo` 全程没参与 —— 目标在 7~11 格
     *   时，每段 1.2 秒根本走不到位，8 轮全废。
     *   ⇒ 3.6 格外先自己走过去（`ctx.moveTo` 就是现成 walkTo），到了再交给 pvp 挥拳。 */
    if (!standMode && canMove && step.action !== 'equip') {
      const d0 = distOf(target)
      /* 🔴 2026-10-28（用户：「attack 现在基本用不了」）：门槛 5.5 → **8 格**，
       *    而且只肯花 2 秒、并且**先给战斗留 2 秒**（`budgetLeft() - 2_000`）。
       *    以前 5.5 格就先走近、最多吃 3 秒 —— 一次调用只有 10 秒，走近吃掉 3 秒、
       *    战斗相位再被 1.2 秒封顶，等于"走过去站一下回来"。
       *    6~8 格交给 pvp 的 GoalFollow 自己挪（它一秒能挪 3~4 格），真走不动再降级走近。 */
      /* 🔴 2026-10-28（用户：「有高低差呢」）：pvp 的 `GoalFollow` 遇到高低差只会往上蹭/
       *    往下等 —— 垂直方向它基本不自己解决。所以只要还没进攻击距离，差 2 格以上也先走上去
       *    （我们的 walkTo 会跳、会挖、会垫）。 */
      const dy0 = Math.abs(Number(target?.position?.y ?? 0) - Number(b.entity?.position?.y ?? 0))
        /* 🔴 2026-10-29 实机（用户：「为什么越改越差啊……走过去 打。为什么现在连打怪都不行了」）：
         *   门槛 8 格是**错的**：3.5~8 格这段最该自己走过去，却被交给 pvp 的 `GoalFollow` 裸跟 ——
         *   实机 `distance:4.7`、`actions:["engage"]`、6.1 秒后判「一直在逃」放弃；`distance:6.7`
         *   更是干等 10.1 秒一点没动。**只要不在攻击距离内，就自己走**（`walkTo` 会挖、会跳、会绕）。 */
        if (d0 > 3.5) {
        const mp = b.entity?.position
        const tp = target.position
        /* 🔴 2026-10-29 实机（用户：「ai 走到了之前羊的位置，调用了 attack，之后就没动了」）：
         *   ① `approachPointOf` 算的是「目标**当时**的位置 + 2.2 格」—— 羊 4.6 格/秒，走到那儿它早没了，
         *      等于每轮都在朝一个空点跑；② `pickMs` 封顶 2 秒 —— 10 秒的调用里走近只占 2 秒。
         *   改成朝**预测拦截点**走：按目标当前速度前瞻「追到它要几秒」，把点前移那么多。
         *   （MC 的 `entity.velocity` 单位是 格/tick ⇒ ×20 得格/秒。） */
        const tvx = Number(target?.velocity?.x ?? 0) * 20
        const tvz = Number(target?.velocity?.z ?? 0) * 20
        const tSpeed = Math.hypot(tvx, tvz)
        mem.targetSpeed = Math.round(tSpeed * 10) / 10
        const lead = Math.max(0, Math.min(1.5, d0 / 5.6))
        const pred = tp ? { x: tp.x + tvx * lead, y: tp.y, z: tp.z + tvz * lead } : null
        /* 🔴 2026-10-29（用户：「它现在是没有动」「不是追不上」）：`approachPointOf(me, target, 2.2)`
         *   生成的是**我朝目标方向 2.2 格**的那个点（不是“离目标 2.2 格”）——再配 `arrive: 2.0`，
         *   等于“只要挪 0.2 格就算到了” ⇒ 每次 approach 只前蹭 0.2 格，人看着压根没动，
         *   9.7 格始终是 9.7 格，10 秒预算烧完报“追不上”。**这才是真根因**，跟预测无关。
         *   现在按“走到离目标 3.2 格（攻击距离 3.5 以内）”算步长，`arrive` 收到 1.2。 */
        const stepLen = Math.max(1.5, d0 - 3.2)
        const pt = mp && pred ? approachPointOf({ x: mp.x, y: mp.y, z: mp.z }, pred, stepLen) : null
        /* 给足 4 秒：追上 9 格外的目标本来就要 2~3 秒，2 秒只够挪一半。 */
        const pickMs = Math.min(budgetLeft() - 1_500, 4_000)
        if (pt && pickMs >= 600) {
          const p0 = mp ? { x: mp.x, y: mp.y, z: mp.z } : null
          try {
            /* 🔴 2026-11-01：`walkTo` 是**返回结果对象**（`{ arrived:false, hint, reason }`）、
             *   不抛异常 —— 旧写法只在 catch 里记 `moveErr` ⇒ 静默失败永远显示「原因不明」。
             *   现在把 `hint` 原样带出来（「前方 10,53,81 的脚下是 stone（没有两格高）」这种）。 */
            const mv1 = await ctx.moveTo(pt, { arrive: 1.2, budget: pickMs, reason: `战斗接近：先走到「${label}」旁边` })
            if (mv1 && mv1.arrived !== true) {
              moveErr = String(mv1.hint ?? mv1.reason ?? '走到一半停了，没给原因').slice(0, 160)
            }
          } catch (e) {
            moveErr = String(e?.message ?? e).slice(0, 140)
          }
          /* 这一轮实际挪了多少格：追不上时模型靠这个判断「它比我快」而不是「我卡住了」 */
          let dm = 0
          try {
            const p1 = b.entity?.position
            if (p0 && p1) dm = Math.hypot(p1.x - p0.x, p1.z - p0.z)
          } catch { /* 忽略 */ }
          /* 🔴 2026-10-29（用户：「它现在是没有动」）：`moveTo` 回来说“到了”**不代表真挪了** ——
           * 目标点算错时它挪 0.2 格就判到达，人被记成“接近成功”，然后原地等到预算烧完。
           * 挪不到 0.6 格一律记一次失败，不许把“原地踏步”算成一次成功的接近。 */
          mem.approachFails = dm < 0.6 ? (mem.approachFails ?? 0) + 1 : 0
          mem.approachMoved = Math.round(((mem.approachMoved ?? 0) + dm) * 10) / 10
          mem.repositions++
          mem.lastInRange = null
          actions.push('approach')
          if ((mem.approachFails ?? 0) >= 3) {
            unreachable = true
            moveErr = `连续 3 次都走不到「${label}」旁边：${moveErr ?? '每次都没挪动（没给出原因）'}`
            break
          }
          if (ctx.callLeft() <= 800) { timedOut = true; break }
          continue
        }
      }
    }

    /* ── 进攻（一个阶段） ──
     * 举盾只在"确实有东西要挡"时：目标自己是远程 / 它正在打我 / 被围 / 有别的远程在射我。 */
    const shieldWanted = Boolean(snap.hasShield
      && (snap.target?.ranged || snap.target?.attackingMe || snap.surrounded || snap.rangedThreat))
    last = hasPvp ? await engagePvp({ shield: shieldWanted }) : await engageSwing()
    sawDamageAny = sawDamageAny || last._sawDamage === true
    shieldsAny += Number(last._shields) || 0
    mem.lastInRange = last._inRange === true
    if (last._killed === true) break
    /* 血掉太猛 -> 这一轮就收（不再试下一个阶段） */
    if (last._hardHurt === true) break
    if (last._chaseGiveUp === true) { unreachable = true; moveErr = String(last.note ?? '远程怪在后退，追不上'); break }
    if (last._gone === true) {
      const lost = label
      if (select({ reselect: true })) { retargets++; actions.push('retarget'); continue }
      unreachable = true
      moveErr = `「${lost}」不见了，24 格内也没有能接手的${needle ? `「${who}」` : '怪'}（附近：${near || '什么都没有'}）`
      break
    }
    if (last.error) break
    if (ctx.callLeft() <= 500) { timedOut = true; break }

    /* ── 放风筝：打一下，往安全的地方退一步（用户 2026-10-18，只给近战怪）──
     * 条件里每一条都是"退这一步确实有意义/不会帮倒忙"：
     *   · 没被围（多只怪各自有手长，退一步躲不开第二只，反而脱出战圈吃背刺）
     *   · 目标是近战（远程怪退开 = 送给它射）
     *   · 真打到/够得着（本来够不着还退 = 越追越远）
     *   · 策略层没在建议撤/拉开距离（那说明该拉开 8 格，不是退 3 格，决策权在 AI）
     *   · 血还够（`HEALTH_LOW` 以下别再浪）
     *   · 这一步的预算够（不够就先打，别"退到一半时间没了"） */
    if (kite && !standMode && canMove && mem.kites < KITE_MAX &&
        !RANGED_RE.test(label) &&
        !(Number(b.health) <= HEALTH_LOW) &&
        foes.filter((f) => f.id !== target.id).length === 0 &&
        !advisory &&
        (last._inRange === true || last._sawDamage === true || distOf(target) <= 3) &&
        (stillThere ? distOf(target) <= KITE_TRIGGER : false) &&
        Math.min(budgetLeft(), ctx.callLeft()) > KITE_STEP_MS + 500) {
      const spot = kiteSpotOf(b, target)
      if (!spot) {
        mem.kiteBlocked++
        mem.kiteWhy = '周围没有安全的落脚点（岩浆 / 火 / 悬空）'
      } else {
        try {
          await ctx.moveTo(spot, { arrive: 0.7, budget: KITE_STEP_MS })
          mem.kites++
          actions.push('kite')
          mem.lastInRange = null /* 换位了：下一轮重新靠近，别让策略层以为还贴着 */
        } catch (e) {
          mem.kiteBlocked++
          mem.kiteWhy = `退的路上被挡住了（${String(e?.message ?? e).slice(0, 60)}）`
        }
      }
    }
    /* 目标还在、时间还有 ⇒ 再评估一轮（MAX_ROUNDS 兜底，防止抖动磨光预算） */
  }

  if (Number.isFinite(Number(b.health))) LAST_SEEN.set(b, { at: Date.now(), health: Number(b.health) })

  /* ═══════════ ③ 组装结果 ═══════════ */

  const standAt = standMode && b.entity?.position
    ? { x: Math.floor(b.entity.position.x), y: Math.floor(b.entity.position.y), z: Math.floor(b.entity.position.z) }
    : null
  const headroom = standMode ? standHeadroomOf(b) : null
  const killed = last?._killed === true
  const gone = last?._gone === true
  const combat = combatOutcomeOf({
    killed,
    gone: gone && !killed,
    sawDamage: sawDamageAny || (last?._sawDamage === true),
    /* 🔴 不再有 `retreated`：策略层没有否决权，这一轮不会"自己撤"（用户 2026-10-17）。 */
    unreachable, aborted, timedOut,
  })
  /* 够不着/超时时没有"进攻结果"可继承 ⇒ 自己拼一份，字段名与旧的一致 */
  const base = last ?? {
    attacked: label, distance: Number(distOf(target).toFixed(1)), killed: false, gone: false, health: b.health,
  }
  const { _sawDamage, _inRange, _gone, _killed, _shields, _hardHurt, _chaseGiveUp, ...clean } = base
  /* 够不着/超时/被中止时，旧 `note` 那句"再叫一次接着打"是误导 ⇒ 换成策略层的话 */
  const strategyNote = (unreachable || aborted || timedOut) && !last?.note
    ? `${combatPlanText(lastStep)}${moveErr ? `（${moveErr}）` : ''}`
    : null

  return {
    ...clean,
    combat,
    combatText: combatOutcomeText(combat),
    strategy: lastStep?.state ?? null,
    /* 机器可读的"为什么"（`low-health` / `unreachable` / `surrounded` / `gone-no-damage`…）。
     * 和 `note`/`adviceText` 那种给人看的中文分开：一个给下游判分支，一个给 AI 读。 */
    reason: lastStep?.reason ?? null,
    actions,
    /* 放风筝的账（用户要"打一下退一点"，就得说清退了几次 / 为什么没退） */
    ...(kite
      ? {
          kite: {
            retreats: mem.kites,
            ...(mem.kiteBlocked ? { blocked: mem.kiteBlocked } : {}),
            ...(mem.kiteWhy ? { why: mem.kiteWhy } : {}),
          },
          kiteText: mem.kites
            ? `放风筝：打了 ${mem.kites} 下、退了 ${mem.kites} 步（往安全落脚点退，约 3 格）`
            : `放风筝：这一轮没退${mem.kiteWhy ? `（${mem.kiteWhy}）` : '（没被打到 / 不是近战怪 / 被围 / 血太少 / 时间不够）'}`,
        }
      : {}),
    /* 这次用的是哪种目标优先权（threat / nearest / weakest）+ 换过几次目标（用户 2026-10-18 的抱怨 ①③） */
    priority: priorityMode,
    ...(retargets ? { retargets } : {}),
    ...(shieldsAny ? { shieldBlocks: shieldsAny } : {}),
    ...(strategyNote ? { note: strategyNote } : {}),
    /* 策略层的建议（没有执行）：AI 要撤 / 要拉开距离，自己叫 `mc_move`。
     * 单独给一个字段，别混进 `note`（那样会和"这一轮的攻击结果"抢同一句话）。 */
    ...(advice.length
      ? {
          advice,
          adviceText: `策略层建议（我没自己动，因为这一轮是你叫的打）：${advice
            .map((a) => `${a.action === 'defend' ? '拉开距离' : '撤退'} —— ${a.why}`)
            .join('；')}。真要撤就自己叫 \`mc_move\`。`,
        }
      : {}),
    ...(unreachable ? { unreachable: true } : {}),
    /* 站桩这一轮的账（用户 m05940/m06001：站在自己搭的 2 格洞里打末影人） */
    ...(standMode
      ? {
          stood: true,
          standAt,
          ...(headroom != null ? { headroom } : {}),
          ...(standAt && headroom != null && headroom < 2
            ? { standWarn: `你站的地方只有 ${headroom} 格高 —— 自己都快站不下，先挖开头顶或换个位置` }
            : headroom != null && headroom > 2
              ? { standWarn: `你头顶还有 ${headroom - 1} 格空隙没封（能站高度 ${headroom} 格）—— 末影人 3 格高，进得来也够得到你。先封顶再来` }
              : { standText: '站桩：头顶封到 2 格，末影人进不来；这一轮一步没挪' }),
        }
      : {}),
    ...(moveErr ? { strategyError: moveErr } : {}),
    /* 手里现在到底是什么 + 这一轮换过什么（用户 2026-10-19 要的"看得见"） */
    held: b.heldItem ? `${b.heldItem.name}x${b.heldItem.count ?? 1}` : '空手',
    ...(heldAtStart && heldAtStart !== (b.heldItem?.name ?? null) ? { heldBefore: `${heldAtStart}x1` } : {}),
    ...(equippedTo.length ? { equipped: equippedTo } : {}),
    ...(equipFail || lastSnap?.weaponWarn ? { weaponWarn: equipFail ?? lastSnap.weaponWarn } : {}),
    ...(equipNote && !equippedTo.length ? { equipNote } : {}),
    /* 有没有盾（含**副手 45 格**与盔甲槽 5..8）。如实给出来：AI 需要它判断"能不能进依赖盾牌的策略"，
     * 而这正是 2026-10-17 用户实机逮到的那个 bug 的现场（副手有盾却被判成没盾）。 */
    ...(typeof lastSnap?.hasShield === 'boolean' ? { shield: lastSnap.hasShield } : {}),
    ...foesNear(target),
  }
}

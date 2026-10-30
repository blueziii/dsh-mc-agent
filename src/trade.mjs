/**
 * 村民交易（用户 2026-10-23：「1档和2档做一下」—— 一档第一条，抄 mindcraft 的
 * `tradeWithVillager` / `showVillagerTrades`，`src/agent/library/skills.js:1748-1904`）。
 *
 * 在此之前插件**没有任何交易能力**：`villager` 只在 `entity-names.mjs`（中文别名）和
 * `combat-strategy.mjs`（别打它）里出现过。附魔书、钻石工具、食物这些中期最划算的东西
 * 全靠自己挖，AI 够不着。
 *
 * 原语（`mineflayer/lib/plugins/villager.js`）：
 *   · `bot.openVillager(entity)`（:72）—— **只认村民**，第一行就 `assert.strictEqual(entityType, villager.id)`，
 *     流浪商人会直接抛；窗口里 `trades` 由服务端 `trader_list` 包填（:101-102），
 *     包没来就一直没有 ⇒ 它内部 `await once(villager, 'ready')` 会一直等（我们靠 11 秒闸门兜住）。
 *   · `bot.trade(window, index, count)`（:127）—— 0 基下标；`count` 传假值会被当成
 *     "把剩余次数全换掉"（:131 `count = count || maximumNbTradeUses - nbTradeUses`），**必须显式给数**。
 *   · 价格用 `trade.realPrice`（含需求/声望浮动，:112 算出来的），不是 `inputItem1.count`。
 *
 * 三条约定同其它叶子模块：不 import mineflayer、不反向 import `core.mjs`、插件实例状态走 `ctx`。
 */
import { entityNameOf } from './entity-names.mjs'
import { callBudget } from './budget.mjs'

const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms)))

/** 交互够不着的门槛（跟 `world-use.mjs` 的 useBlock 同一套口径：4.5 格，留 1 格余量）。 */
export const TRADE_REACH = 3.5

/** 能交易的实体。村民的中文 displayName 是「村民」，职业名不在实体名里（在元数据里），
 *  所以这里只认「村民/villager」本身；`wandering_trader` 留着是为了给出**准确**的拒绝理由。 */
export const VILLAGER_RE = /villager|村民|wandering_trader|流浪商人/

/** 职业表：`villager_data` 元数据 0~7 位是外观类型、8~15 位职业、16~23 位等级（原版 `VillagerData`）。 */
export const PROFESSIONS = [
  'none', 'armorer', 'butcher', 'cartographer', 'cleric', 'farmer', 'fisherman', 'fletcher',
  'leatherworker', 'librarian', 'stone_mason', 'nitwit', 'shepherd', 'toolsmith', 'weaponsmith',
]

export const PROFESSION_CN = {
  none: '无业', armorer: '盔甲匠', butcher: '屠夫', cartographer: '制图师', cleric: '牧师',
  farmer: '农民', fisherman: '渔夫', fletcher: '制箭师', leatherworker: '皮匠', librarian: '图书管理员',
  stone_mason: '石匠', nitwit: '傻子', shepherd: '牧羊人', toolsmith: '工具匠', weaponsmith: '武器匠',
}

/** 元数据里那一格可能是裸数字，也可能是 `{ type, value }` —— 两种都兜住。 */
const metaValueOf = (raw) => (raw && typeof raw === 'object' && 'value' in raw ? raw.value : raw)

/**
 * 读出村民的职业与等级（读不到就 null，不影响交易本身）。
 * 元数据键名从 `registry.entitiesByName.villager.metadataKeys` 里查 —— 别写死下标，
 * 1.20 之后 `villager_data` 的位置改过一次。
 */
export function villagerDataOf (b, e) {
  const keys = b?.registry?.entitiesByName?.villager?.metadataKeys
  const idx = Array.isArray(keys) ? keys.indexOf('villager_data') : -1
  if (idx < 0) return null
  const val = metaValueOf(e?.metadata?.[idx])
  if (val == null) return null
  if (typeof val === 'object') {
    const prof = PROFESSIONS[Number(val.profession)] ?? null
    return { profession: prof, level: Number.isFinite(val.level) ? val.level : null }
  }
  const n = Number(val)
  if (!Number.isFinite(n)) return null
  return { profession: PROFESSIONS[(n >> 8) & 0xff] ?? null, level: (n >> 16) & 0xff }
}

/** 一个村民该怎么称呼（职业 + 等级 + 距离），报错和结果里都用这一句。 */
export function labelOf (b, e, d = null) {
  const data = villagerDataOf(b, e)
  const prof = data?.profession && data.profession !== 'none' ? (PROFESSION_CN[data.profession] ?? data.profession) : null
  const lvl = data?.level ? ` Lv${data.level}` : ''
  const base = prof ? `${prof}${lvl}` : entityNameOf(e)
  const dist = Number.isFinite(d) ? ` ${d.toFixed(1)} 格` : ''
  return `${base}${dist}`
}

/** 附近能交易的实体：`[{ e, d }]`，按距离排好。 */
export function villagersNear (b, radius = 32) {
  const me = b?.entity?.position
  const out = []
  for (const e of Object.values(b?.entities ?? {})) {
    if (!e || e === b.entity) continue
    const name = `${entityNameOf(e)} ${e.name ?? ''} ${e.type ?? ''}`
    if (!VILLAGER_RE.test(name.toLowerCase())) continue
    let d = Infinity
    try { d = e.position.distanceTo(me) } catch { /* 假 bot 没有 position */ }
    if (Number.isFinite(d) && d > radius) continue
    out.push({ e, d })
  }
  return out.sort((a, z) => a.d - z.d)
}

/**
 * 按 `who` 挑一个村民：**英文名 / 中文「村民」/ 职业名（中英文）** 都认。
 *
 * 🔴 不能直接 `pickEntity`：它只认实体名字段，而"图书管理员"是**职业**，藏在 `villager_data`
 *    元数据里 —— 拿它去匹配永远落空（实机/自检第一次跑就撞上）。所以这里自己配一套字段。
 *    匹配不中时把"最近的有谁（带职业和距离）"报回去，AI 才知道附近到底站着几个什么村民。
 */
export function pickVillager (b, pool, who) {
  const needle = String(who ?? '').trim().toLowerCase()
  const fieldsOf = ({ e }) => {
    const d = villagerDataOf(b, e)
    const prof = d?.profession ?? null
    return [
      entityNameOf(e), e?.name, e?.type, e?.kind,
      prof, prof ? PROFESSION_CN[prof] : null,
    ].filter((v) => typeof v === 'string' && v).map((v) => v.toLowerCase())
  }
  const hit = pool.find((x) => fieldsOf(x).some((f) => f.includes(needle))) ?? null
  const near = pool.slice(0, 6).map((x) => labelOf(b, x.e, x.d))
  return { hit, near, needle }
}

/**
 * 这条交易还能不能用。
 *
 * 🔴 服务端包里的字段叫 `tradeDisabled`，mineflayer 的 `gotTrades` **没有**把它映射成 `disabled`
 *    （`lib/plugins/villager.js:101-116` 只映射了价格/次数），所以 `trade.disabled` 很可能是 undefined；
 *    另外"已换次数到上限"和"被锁"在客户端看来是一回事（都换不了），一起判。
 */
export const tradeDisabledOf = (trade) => {
  if (trade?.disabled === true || trade?.tradeDisabled === true) return true
  const max = Number(trade?.maximumNbTradeUses)
  const used = Number(trade?.nbTradeUses ?? 0)
  return Number.isFinite(max) && used >= max
}

/** 背包里某种物品一共有几个（按 `type` 算，跟服务端扣料的口径一致）。 */
export function countOf (b, type) {
  if (!type) return 0
  let n = 0
  for (const it of b?.inventory?.items?.() ?? []) if (it?.type === type) n += it.count
  return n
}

/** 一次交易要付什么、换什么，压成一句人话（附魔/命名/药水都带上）。 */
export function tradeTextOf (bot, trade) {
  const side = (item) => {
    if (!item || !item.type) return '无'
    let s = `${item.count} ${item.displayName ?? item.name ?? item.type}`
    const v = item.nbt?.value
    if (v?.Potion) s += `（${String(v.Potion.value).replace(/_/g, ' ')}）`
    const ench = v?.ench?.value?.value ?? v?.StoredEnchantments?.value?.value
    if (Array.isArray(ench) && ench.length) {
      const names = ench.map((x) => {
        const id = metaValueOf(x.id)
        const lvl = metaValueOf(x.lvl)
        return `${bot?.registry?.enchantments?.[id]?.displayName ?? id} ${lvl}`
      })
      s += `（${names.join(' + ')}）`
    }
    return s
  }
  const cost = [side(trade.inputItem1), trade.inputItem2?.type ? side(trade.inputItem2) : null]
    .filter(Boolean).join(' + ')
  return { cost, give: side(trade.outputItem) }
}

/** 一条交易的可读行：`1. 3 绿宝石 + 1 书 » 附魔书（1/12 次）` */
export function tradeLineOf (b, trade, i) {
  const { cost, give } = tradeTextOf(b, trade)
  const arrow = tradeDisabledOf(trade) ? ' ⛔ ' : ' » '
  const used = `${trade.nbTradeUses ?? 0}/${trade.maximumNbTradeUses ?? '?'}`
  return `${i + 1}. ${cost}${arrow}${give}（已换 ${used}）`
}

/**
 * 一次交易的"我买得起几次"：按 `realPrice`（含涨价）算 `inputItem1`，第二料按原数算。
 * `trade.hasItem2` 为假时不算第二料（`Item.fromNotch({})` 的空壳也算有 type，别被它骗）。
 */
export function affordableCountOf (b, trade) {
  const need1 = Number(trade?.realPrice ?? trade?.inputItem1?.count ?? 0)
  const need2 = trade?.hasItem2 ? Number(trade?.inputItem2?.count ?? 0) : 0
  const have1 = countOf(b, trade?.inputItem1?.type)
  const have2 = need2 > 0 ? countOf(b, trade?.inputItem2?.type) : Infinity
  const byFirst = need1 > 0 ? Math.floor(have1 / need1) : Infinity
  const bySecond = need2 > 0 ? Math.floor(have2 / need2) : Infinity
  const byUses = Math.max(0, Number(trade?.maximumNbTradeUses ?? 0) - Number(trade?.nbTradeUses ?? 0))
  const n = Math.min(byFirst, bySecond, byUses)
  return Number.isFinite(n) ? n : byUses
}

/** 关掉当前那个窗口（开新的之前必须关，否则 `openEntity` 会挂住）。 */
async function closePrevWindow (b, t) {
  const cur = b.currentWindow
  if (!cur || cur === b.inventory) return false
  try { await t(Promise.resolve(b.closeWindow(cur)), 'act', '关掉上一个窗口'); return true } catch { return false }
}

/**
 * 村民交易。
 *
 * @param {object} args
 *   · `action:"list"`（默认）/ `"buy"`
 *   · `who`    指定哪个村民（中文职业名/英文名都认，不给就是最近的）
 *   · `index`  buy：第几条（**从 1 开始**，就是 list 里显示的那个号）
 *   · `count`  buy：换几次（默认 1；超过剩余次数/材料会自己收窄并说明）
 *   · `radius` 找村民的范围（默认 32）
 *   · `budgetMs` 走过去的时间（默认整轮 10 秒）
 */
export async function tradeVillager (self, args = {}, ctx = {}) {
  const b = self.requireBot()
  const t = ctx.t ?? ((p) => p)
  const action = String(args.action ?? 'list').toLowerCase()
  if (!['list', 'buy'].includes(action)) {
    throw new Error(`action 只能是 list（看它卖什么）/ buy（买第几条），给的是 "${args.action}"`)
  }
  if (typeof b.openVillager !== 'function') {
    throw new Error('这个 mineflayer 没有 openVillager —— 交易用不了')
  }

  // ① 找人（先按名字挑，再按距离；找不到要把"附近实际有谁"报出去）
  const radius = Math.max(4, Math.min(64, Number(args.radius) || 32))
  const pool = villagersNear(b, radius)
  if (!pool.length) {
    return {
      ok: false, action, reason: 'no-villager',
      hint: `附近 ${radius} 格内没有村民。先用 \`mc_scan {name:"villager", radius:48}\` 或 \`mc_observe\` 找村子/村民，`
        + '再 \`mc_move {x, z}\` 走过去（村民会自己走动，到了再叫一次）。流浪商人也能交易但 mineflayer 的 openVillager 不认它，得用原版界面手动点。',
    }
  }
  let target = pool[0]
  if (args.who != null && String(args.who).trim() !== '') {
    const { hit, near } = pickVillager(b, pool, args.who)
    if (!hit) {
      throw new Error(`附近找不到 "${args.who}"（最近的有：${near.join('、') || '什么都没有'}）`
        + ' —— 职业名（图书管理员/盔甲匠…）和"村民"都认，名字要跟 `mc_observe` 显示的一致')
    }
    target = hit
  }
  const ent = target.e
  const label = labelOf(b, ent, target.d)
  if (/wandering_trader|流浪商人/.test(`${ent.name ?? ''} ${entityNameOf(ent)}`)) {
    return { ok: false, action, villager: label, reason: 'not-a-villager', hint: '这是流浪商人：mineflayer 的 `openVillager` 只认村民实体（内部 assert 了 entityType），跟它交易得手动开界面。' }
  }

  // ② 太远就先走过去（村民会动，远处那一步只当"接近"，到了再叫一次最稳）
  let walked = null
  if (Number.isFinite(target.d) && target.d > TRADE_REACH) {
    const p = ent.position
    walked = await self.walkTo(
      { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) },
      { arrive: 2, intent: 'interact', allowDig: false, noTower: true, budget: callBudget(args.budgetMs) },
    )
    if (!walked?.arrived) {
      return {
        ok: false, action, villager: label, walked,
        reason: 'too-far',
        hint: `还没走到它旁边（现在 ${walked?.remaining ?? '?'} 格）—— 它可能在屋里/栅栏后面。直接再叫一次这条路会接着走；`
          + '实在过不去就换一个村民（`mc_trade {action:"list", who:"图书管理员"}` 之类）。',
      }
    }
    await sleep(150)
  }

  // ③ 开交易界面（开之前先关掉上一个窗口，否则 openEntity 会挂到超时）
  const closedPrev = await closePrevWindow(b, t)
  let win = null
  try {
    win = await t(b.openVillager(ent), 'act', `打开 ${label} 的交易界面`)
  } catch (e) {
    return {
      ok: false, action, villager: label, closedPrev, reason: 'open-failed',
      hint: `交易界面没打开（${e?.message ?? e}）。常见原因：它睡着了（晚上/下雨）、是宝宝、没职业（傻子/无业）、`
        + '离得太远（要 4 格内）或者被方块挡住。白天的村民才理人；`mc_act {mode:"use", who:"villager"}` 能看到它到底有没有反应。',
    }
  }

  const trades = Array.isArray(win?.trades) ? win.trades : []
  const closeWin = async () => {
    try { await t(Promise.resolve(b.closeWindow(win)), 'act', '关掉交易界面'); return true } catch { return false }
  }
  if (!trades.length) {
    const closed = await closeWin()
    return {
      ok: false, action, villager: label, closedPrev, closed, reason: 'no-trades',
      hint: '界面开了但**一条交易都没有**：它是无业村民（傻子/失业）、宝宝，或者还没找到工作台。给它工作台（讲台→图书管理员、高炉→盔甲匠…）它才会卖东西。',
    }
  }

  // ④ list：把它卖什么列出来（含"我买得起几次"）
  if (action === 'list') {
    const rows = trades.map((tr, i) => {
      const { cost, give } = tradeTextOf(b, tr)
      return {
        index: i + 1,
        cost, give,
        uses: `${tr.nbTradeUses ?? 0}/${tr.maximumNbTradeUses ?? '?'}`,
        disabled: tradeDisabledOf(tr),
        affordable: affordableCountOf(b, tr),
      }
    })
    const text = rows.map((r, i) => {
      const tr = trades[i]
      const line = tradeLineOf(b, tr, i)
      if (r.disabled) return `${line} —— 已售罄`
      return `${line} —— 材料够换 ${r.affordable} 次`
    }).join('\n')
    const closed = await closeWin()
    return {
      ok: true, action, villager: label, closedPrev, closed,
      count: rows.length, trades: rows, text,
      hint: `要买就说 \`mc_trade {action:"buy", index:N, count:1}\`（index 就是上面的序号）。`
        + '附魔书/钻石工具这类要挑：附魔不对就换一个村民（或拆了工作台重放，刷新交易）。',
    }
  }

  // ⑤ buy：买第 index 条 count 次
  const index = Number(args.index)
  if (!Number.isInteger(index) || index < 1) {
    await closeWin()
    throw new Error(`buy 要 index（第几条，从 1 开始，就是 list 里那个序号），给的是 ${args.index}`)
  }
  const i0 = index - 1
  const tr = trades[i0]
  if (!tr) {
    const closed = await closeWin()
    return {
      ok: false, action, villager: label, closed, reason: 'no-such-trade',
      count: trades.length,
      hint: `它只有 ${trades.length} 条交易，没有第 ${index} 条。先 \`mc_trade {action:"list"}\` 看一遍序号。`,
    }
  }
  if (tradeDisabledOf(tr)) {
    await closeWin()
    return { ok: false, action, villager: label, index, reason: 'disabled', hint: `第 ${index} 条现在被锁住了（你已经把它换到上限了）—— 换别的，或者等它"补货"（村民睡觉/用工作台会重置一部分）。` }
  }
  const want = Math.max(1, Math.floor(Number(args.count) || 1))
  const can = affordableCountOf(b, tr)
  const n = Math.min(want, can)
  if (n <= 0) {
    const { cost } = tradeTextOf(b, tr)
    const closed = await closeWin()
    return {
      ok: false, action, villager: label, index, reason: 'no-materials', need: cost, closed,
      hint: `材料不够（这条要 ${cost}）。要么先弄材料，要么换一条便宜的交易。`,
    }
  }

  const { cost, give } = tradeTextOf(b, tr)
  const before = { uses: Number(tr.nbTradeUses ?? 0), items: new Map() }
  for (const it of b.inventory?.items?.() ?? []) before.items.set(it.type, (before.items.get(it.type) ?? 0) + it.count)
  let err = null
  try {
    // 🔴 count 必须显式给：`bot.trade` 里 `count = count || 剩余次数` —— 传 0/undefined 会一口气全换掉。
    await t(Promise.resolve(b.trade(win, i0, n)), 'trade', `换 ${n} 次（${cost} » ${give}）`)
  } catch (e) {
    err = e
  }
  const afterUses = Number(tr.nbTradeUses ?? 0)
  /* 复核口径：① 它自己的"已换次数"涨了几次（最硬的证据）② 背包里少了什么、多了什么。
   * ② 只是给人看的旁证 —— 换来的东西可能被别的手顺手收走，但次数骗不了人。 */
  const gain = {}
  const spent = {}
  const afterCounts = new Map()
  const nameOfType = new Map()
  for (const it of b.inventory?.items?.() ?? []) {
    afterCounts.set(it.type, (afterCounts.get(it.type) ?? 0) + it.count)
    nameOfType.set(it.type, it.name ?? it.type)
  }
  for (const [type, now] of afterCounts) {
    const delta = now - (before.items.get(type) ?? 0)
    if (delta > 0) gain[nameOfType.get(type) ?? type] = delta
  }
  for (const [type, was] of before.items) {
    const now = afterCounts.get(type) ?? 0
    if (was > now) spent[type] = was - now
  }
  const closed = await closeWin()
  const done = afterUses - before.uses
  if (err) {
    return {
      ok: false, action, villager: label, index, cost, give, closed, reason: 'trade-error',
      used: done, gain, spent,
      hint: `换到一半出错（${err?.message ?? err}）。已经换成的 ${done} 次不会退 —— 先 \`mc_inventory\` 看看，然后再叫一次。`,
    }
  }
  if (done <= 0) {
    return {
      ok: false, action, villager: label, index, cost, give, closed, reason: 'not-confirmed',
      gain, spent,
      hint: '交易包发出去了，但它的"已换次数"没动 —— 大概率是材料被别的窗口/手滑挪走了。先 `mc_inventory` 看一眼再叫一次。',
    }
  }
  return {
    ok: true, action, villager: label, index, cost, give, closed,
    used: done, ...(Object.keys(gain).length ? { gain } : {}), ...(Object.keys(spent).length ? { spent } : {}),
    ...(done < want ? { note: `你要 ${want} 次，只能换 ${n} 次（材料/剩余次数不够）` } : {}),
    hint: `换了 ${done} 次：${cost} » ${give}。`,
  }
}

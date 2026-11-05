/**
 * mc_craft 扩展的自检：用**假 bot / 假配方表 / 假世界**跑真实扩展文件，覆盖
 *   ① 工具注册形状（且确认它**不在** mc_observe 的看图门禁名单里）
 *   ② 基础查询（物品名/坐标方块/找工作台/找放桌子的空位）
 *   ③ 名字解析（简称、大小写、歧义时按背包自动选）
 *   ④ 递归规划（原木→木板→木棍→木镐、虚拟背包记账、缺料、需要工作台、深度上限、次数上限）
 *   ⑤ 计划/缺料文案
 *   ⑥ 端到端 execute（真合成、自动用附近工作台、自动放工作台、缺料、list、dryRun、报错）
 * 不连 MC、不需要 DSH。
 * 跑法：node dsh-mc-agent/tools/check-mc-craft.mjs
 */
import { readFileSync } from 'node:fs'

const EXT = new URL('../extensions/mc_craft.mjs', import.meta.url).href

let pass = 0
let fail = 0
const ok = (cond, label, extra = '') => {
  if (cond) { pass++; console.log('  ok   ' + label) } else { fail++; console.log('  FAIL ' + label + (extra ? '  <<< ' + extra : '')) }
}
const throws = (label, fn, match = null) => {
  try { fn(); fail++; console.log('  FAIL ' + label + '  <<< 没有抛错') } catch (e) {
    if (match && !match.test(e.message)) { fail++; console.log('  FAIL ' + label + '  <<< 错误信息不对：' + e.message) } else { pass++; console.log('  ok   ' + label) }
  }
}

const mod = await import(EXT + '?v=' + Date.now())
const {
  itemNameOf, itemIdOf, canPlaceInto, blockAtXYZ, findTableBlock, findPlaceSpot,
  ingredientsOf, resolveItem, planCraft, describePlan, describeMissing,
  listRecipesFor, listCraftable,
} = mod

/* ─────────────────────── 假注册表 / 假配方 / 假背包 / 假世界 ─────────────────────── */

/** 假注册表里"方块 id"的偏移：故意和物品 id 错开，用来抓"拿物品 id 去 findBlock"的 bug */
const BLOCK_ID_BASE = 1000

const NAMES = [
  'air', 'oak_log', 'birch_log', 'oak_planks', 'birch_planks', 'stick', 'crafting_table',
  'wooden_pickaxe', 'stone_pickaxe', 'furnace', 'cobblestone', 'coal', 'torch', 'chest',
  'diamond', 'diamond_pickaxe', 'chain_a', 'chain_b', 'chain_c', 'chain_d', 'chain_e',
  // 🔴 实机 2026-10-07：合成窗口失步时服务端把"格子里剩 1 块木板"做成了按钮 —— 拿来当"做出了别的东西"的证物
  'oak_button',
]
const itemsByName = {}
const items = {}
NAMES.forEach((n, i) => { const it = { id: i, name: n }; itemsByName[n] = it; items[i] = it })
const idOf = (n) => itemsByName[n].id
const nameOf = (id) => items[id]?.name ?? ('#' + id)

/** 造一条配方：delta 里负数是原料、正数是产物（和 mineflayer/prismarine-recipe 一致） */
function recipe (out, outCount, requiresTable, ing) {
  return {
    result: { id: idOf(out), count: outCount },
    requiresTable,
    delta: [
      ...ing.map(([n, c]) => ({ id: idOf(n), metadata: null, count: -c })),
      { id: idOf(out), metadata: null, count: outCount },
    ],
    ingredients: ing.map(([n]) => idOf(n)),
  }
}

const RECIPES = [
  recipe('oak_planks', 4, false, [['oak_log', 1]]),
  recipe('birch_planks', 4, false, [['birch_log', 1]]),
  recipe('stick', 4, false, [['oak_planks', 2]]),
  recipe('crafting_table', 1, false, [['oak_planks', 4]]),
  recipe('wooden_pickaxe', 1, true, [['oak_planks', 3], ['stick', 2]]),
  recipe('stone_pickaxe', 1, true, [['cobblestone', 3], ['stick', 2]]),
  recipe('furnace', 1, true, [['cobblestone', 8]]),
  recipe('chest', 1, true, [['oak_planks', 8]]),
  recipe('torch', 4, false, [['stick', 1], ['coal', 1]]),
  recipe('diamond_pickaxe', 1, true, [['diamond', 3], ['stick', 2]]),
  // 纯链条，用来测"层次太深"
  recipe('chain_a', 1, false, [['chain_b', 1]]),
  recipe('chain_b', 1, false, [['chain_c', 1]]),
  recipe('chain_c', 1, false, [['chain_d', 1]]),
  recipe('chain_d', 1, false, [['chain_e', 1]]),
]
const recipesForOut = (id) => RECIPES.filter((r) => r.result.id === id)

/** 假世界：Map<'x,y,z', 方块名>；y=0 一层草方块（实心），其余空气 */
function mkWorld (blocks = {}) {
  const map = new Map()
  const key = (x, y, z) => `${x},${y},${z}`
  const set = (x, y, z, name) => { if (name === 'air') map.delete(key(x, y, z)); else map.set(key(x, y, z), name) }
  const get = (x, y, z) => map.get(key(x, y, z)) ?? null
  for (const [k, v] of Object.entries(blocks)) { const [x, y, z] = k.split(',').map(Number); set(x, y, z, v) }
  return { map, set, get, key }
}

function mkBot (inv = {}, opts = {}) {
  const reg = opts.registry ?? {
    items,
    itemsByName,
    // 🔴 故意让方块 id ≠ 物品 id（真 1.21.10 就是这样：crafting_table 物品 332 / 方块 205）——
    // 谁要是拿物品 id 去 findBlock，这里就会红。
    blocksByName: Object.fromEntries(Object.entries(itemsByName).map(([n, it]) => [n, { id: BLOCK_ID_BASE + it.id, name: n }])),
  }
  const idIn = (n) => reg.itemsByName[n]?.id
  const nm = (id) => reg.items[id]?.name ?? ('#' + id)
  const blockIdIn = (n) => reg.blocksByName?.[n]?.id ?? idIn(n)
  const counts = new Map()
  for (const [n, c] of Object.entries(inv)) counts.set(idIn(n), c)
  let missingThrown = false
  let noopDone = false
  let wrongDone = false
  let craftDone = 0
  const world = opts.world ?? mkWorld()
  const calls = []
  const pos = opts.pos ?? { x: 0.5, y: 1, z: 0.5 }
  /* 🔴 `dropsNear()` 用的是 `position.distanceTo(...)`（真 bot 是 vec3）—— 假 bot 的 pos 是普通
   *    对象，不补这一下，"脚边有几个掉落物"那段永远走 catch 分支、测不到。 */
  if (typeof pos.distanceTo !== 'function') {
    pos.distanceTo = (o) => Math.hypot(pos.x - (o?.x ?? 0), pos.y - (o?.y ?? 0), pos.z - (o?.z ?? 0))
  }
  /* 记录"关窗口 / 合成"的先后顺序，用来断言"动手前先把残留窗口关掉" */
  const trace = opts.trace ?? []
  const bot = {
    registry: reg,
    entity: { position: pos, yaw: 0, pitch: 0 },
    currentWindow: opts.window ?? null,
    async closeWindow (w) {
      trace.push('close')
      if (opts.closeWindowThrows) throw new Error('假 closeWindow 故障')
      bot.currentWindow = null
      return true
    },
    ...(opts.canSeeBlock === false ? { canSeeBlock: () => false } : {}),
    inventory: {
      count: (id, metadata = null) => (id == null ? 0 : (counts.get(id) ?? 0)),
      items: () => [...counts.entries()].filter(([, c]) => c > 0).map(([id, c]) => ({ type: id, name: nm(id), count: c })),
      /* 🔴 实机 2026-10-17：「合成的时候背包满了，造出来的东西会掉地上，机器人不知道」——
       *    空位数是那段对账的输入之一。 */
      emptySlotCount: () => (opts.emptySlots ?? 36),
    },
    entities: opts.entities ?? {},
    recipesAll (id, metadata, table) {
      if (opts.recipesAllThrows) throw new Error('假 recipesAll 故障')
      if (opts.recipes) return opts.recipes(id, metadata, table)
      return recipesForOut(id).filter((r) => !r.requiresTable || table)
    },
    recipesFor (id, metadata, minCount, table) {
      return bot.recipesAll(id, metadata, table).filter((r) => {
        const craftCount = Math.ceil((minCount || 1) / (r.result.count || 1))
        return r.delta.every((d) => (counts.get(d.id) ?? 0) + d.count * craftCount >= 0)
      })
    },
    async craft (rec, count, table) {
      trace.push('craft')
      if (rec.requiresTable && !table) throw new Error('Recipe requires craftingTable, but one was not supplied: ' + JSON.stringify(rec))
      // 模拟"服务端很慢/挂住"：craft 迟迟不返回（实机里就是到点被我们掐断、内部还在跑）
      if (opts.craftDelayMs) {
        calls.push({ out: nm(rec.result.id), count, table: table ? 'table' : null, delayed: true })
        await new Promise((r) => setTimeout(r, opts.craftDelayMs))
      }
      if (opts.craftThrows) throw new Error('假服务器：合成被拒（领地保护）')
      // 模拟"服务端其实做出了**别的东西**"：合成格模型串了（1 块木板 → 按钮）
      if (opts.craftWrongOnce && !wrongDone) {
        wrongDone = true
        const wId = idIn(opts.craftWrongOnce)
        counts.set(wId, (counts.get(wId) ?? 0) + 1)
        calls.push({ out: nm(rec.result.id), count, table: table ? 'table' : null, wrong: nm(wId) })
        throw new Error('Event updateSlot:0 did not fire within timeout of 20000ms')
      }
      // 模拟 mineflayer 偶尔的误报：第一次抛 missing ingredient，再来一次就好
      if (opts.craftMissingOnce && !missingThrown) {
        missingThrown = true
        throw new Error('missing ingredient')
      }
      // 模拟"craft 正常返回但背包没变"（点格子没生效 / 卡在窗口上）：第一次空转
      if (opts.craftNoopOnce && !noopDone) {
        noopDone = true
        calls.push({ out: nm(rec.result.id), count, table: table ? 'table' : null, noop: true })
        return
      }
      // 模拟"东西已经做出来了、只是窗口事件丢了"（mineflayer 经典误报）：先扣料加货，再抛 updateSlot
      if (opts.craftSpurious) {
        for (let i = 0; i < count; i++) {
          for (const d of rec.delta) if (d.count < 0) counts.set(d.id, (counts.get(d.id) ?? 0) + d.count)
          counts.set(rec.result.id, (counts.get(rec.result.id) ?? 0) + rec.result.count)
        }
        calls.push({ out: nm(rec.result.id), count, table: table ? 'table' : null, spurious: true })
        throw new Error('Event updateSlot:0 did not fire within timeout of 20000ms')
      }
      for (const d of rec.delta) {
        if (d.count < 0 && (counts.get(d.id) ?? 0) + d.count * count < 0) {
          throw new Error(`假服务器：原料不够做 ${nm(rec.result.id)}（${nm(d.id)} 差 ${-((counts.get(d.id) ?? 0) + d.count * count)}）`)
        }
      }
      // 模拟"一次 craft 只做出一批"（实机：要 8 块木板只出了 4 块 ⇒ 下一步就撞 `原料对不上`）
      if (opts.craftOneBatch) count = Math.min(count, 1)
      /* 🔴 实机 2026-10-17：「合成的时候背包满了，造出来的东西会掉地上，机器人不知道」——
       *    背包满时服务端把产物 `spawn_entity` 掉在脚边，而 `bot.craft()` 照常 resolve。
       *    这里模拟：料照扣、产物**不进背包**、地上多一个掉落物实体。 */
      if (opts.craftToGround) {
        for (let i = 0; i < count; i++) {
          for (const d of rec.delta) if (d.count < 0) counts.set(d.id, (counts.get(d.id) ?? 0) + d.count)
        }
        craftDone += count
        bot.entities['drop-1'] = {
          name: 'item', displayName: 'Item', type: 'object',
          position: { x: 1.5, y: 1, z: 0.5 }, count,
        }
        calls.push({ out: nm(rec.result.id), count, table: table ? 'table' : null, toGround: true })
        return
      }
      // 模拟"补做也补不动了"（第 N 批之后再怎么 craft 都没产出）
      if (opts.craftStopAfter != null && craftDone >= opts.craftStopAfter) count = 0
      for (let i = 0; i < count; i++) {
        for (const d of rec.delta) if (d.count < 0) counts.set(d.id, (counts.get(d.id) ?? 0) + d.count)
        counts.set(rec.result.id, (counts.get(rec.result.id) ?? 0) + rec.result.count)
      }
      craftDone += count
      calls.push({ out: nm(rec.result.id), count, table: table ? 'table' : null })
    },
    blockAt (p) {
      const { x, y, z } = p.floored()
      if (y < 0) return { name: 'stone', boundingBox: 'block', position: { x, y, z } }
      if (y === 0 && world.get(x, 0, z) == null) return { name: 'grass_block', boundingBox: 'block', position: { x, y, z } }
      const n = world.get(x, y, z)
      if (!n) return { name: 'air', boundingBox: 'empty', position: { x, y, z } }
      return { name: n, boundingBox: opts.emptyBlocks?.includes(n) ? 'empty' : 'block', position: { x, y, z } }
    },
    findBlock ({ matching, maxDistance = 4 }) {
      if (opts.findBlockThrows) throw new Error('假 findBlock 故障')
      let best = null
      let bestD = Infinity
      for (const [k, n] of world.map) {
        if (!matching.includes(blockIdIn(n))) continue
        const [x, y, z] = k.split(',').map(Number)
        const d = Math.hypot(x - pos.x, y - pos.y, z - pos.z)
        if (d > maxDistance) continue
        if (d < bestD) { bestD = d; best = { name: n, boundingBox: 'block', position: { x, y, z } } }
      }
      return best
    },
  }
  return { bot, counts, calls, world, pos, trace }
}

/** 假 McBot（core.mjs 的 McBot 的替身） */
function mkMc (fake, opts = {}) {
  const placeCalls = []
  return {
    online: opts.online !== false,
    bot: fake.bot,
    requireBot () { if (opts.online === false) throw new Error('机器人不在线（假会话）'); return fake.bot },
    waitForChunks: async () => {},
    inventory: () => ({ held: null, items: fake.bot.inventory.items().map((i) => ({ name: i.name, count: i.count })) }),
    placeBlock: async ({ x, y, z, name }) => {
      placeCalls.push({ x, y, z, name })
      if (opts.placeFails) return { placed: false, requested: name, at: { x, y, z }, now: 'air', note: '假服务器拒了放置' }
      fake.world.set(x, y, z, name)
      return { placed: name, requested: name, at: { x, y, z }, now: name, held: name }
    },
    placeCalls,
  }
}

/* ─────────────────────── 假宿主 ctx / api ─────────────────────── */

const registered = new Map()
const logs = []
const sessions = new Map()
const ctx = {
  tools: { register: (def) => { registered.set(def.name, def) }, guard: () => {}, get: () => undefined },
  on: () => () => {},
  get: () => undefined,
  logger: { info: (m) => logs.push('info ' + m), warn: (m) => logs.push('warn ' + m) },
}
const api = {
  ctx,
  config: {},
  registry: { peek: (id) => sessions.get(String(id)), listSessions: () => [...sessions.values()] },
  asTool: (spec) => spec,
  getSession: (exec) => {
    const id = exec?.agent?.id
    if (!id) throw new Error('拿不到当前会话（exec.agent 不可用）')
    return sessions.get(String(id))
  },
  memory: {},
  memoryFor: () => ({}),
  workspaceOf: () => null,
  logLine: (l) => logs.push('logLine ' + l),
  Watchdog: class {},
  ensureWatchdog: () => {},
}

await mod.apply(api)
const spec = registered.get('mc_craft')
const EXEC = { agent: { id: 'A1' } }
/** 跑一次工具：返回文字（把假会话装好） */
async function run (args, { mc, id = 'A1' } = {}) {
  sessions.set(id, { agentId: id, bot: mc })
  const v = await spec.execute(args, { agent: { id } })
  return { text: String(v?.text ?? ''), value: v }
}

/* ─────────────────────── ① 工具注册 ─────────────────────── */
console.log('— ① 工具注册 —')
{
  ok(typeof mod.apply === 'function', '扩展导出 apply(api)')
  ok(mod.name === 'mc_craft', '扩展 name = mc_craft', mod.name)
  ok(Boolean(spec), '注册了 mc_craft')
  ok(typeof spec.execute === 'function', '有 execute')
  ok(spec.timeoutMs > 0 && spec.timeoutMs <= 300_000, 'timeoutMs 是合理正数', String(spec.timeoutMs))
  ok(spec.parameters && spec.parameters.name && spec.parameters.name.type === 'string', 'parameters.name 是 string')
  ok(spec.parameters.count && spec.parameters.count.type === 'number', 'parameters.count 是 number')
  ok(spec.parameters.table && spec.parameters.table.type === 'boolean', 'parameters.table 是 boolean')
    ok(spec.parameters.list && spec.parameters.list.type === 'boolean', 'parameters.list 是 boolean')
  ok(spec.parameters.dryRun && spec.parameters.dryRun.type === 'boolean', 'parameters.dryRun 是 boolean')
  ok(spec.output && spec.output.schema && spec.output.schema.additionalProperties === true, 'output.schema 带 additionalProperties')
  const blocks = spec.output.render({}, { text: 'hi' })
  ok(Array.isArray(blocks) && blocks.length === 1 && blocks[0].type === 'text' && blocks[0].text === 'hi', 'render 推一个文字块')
  ok(spec.description.includes('合成'), '描述里说明是合成')
  ok(spec.description.includes('自动补齐中间产物') && spec.description.includes('工作台'), '描述里说明递归补齐 + 工作台')
  ok(spec.description.includes('缺什么') && spec.description.includes('mc_dig'), '描述里说明缺料报告')
  ok(spec.description.includes('不受 mc_observe 门禁'), '描述里说明不受看图门禁限制')
  ok(logs.some((l) => l.includes('mc_craft 已加载')), 'apply 打了加载日志', JSON.stringify(logs))
  // 门禁名单：合成只动背包，**不该**进门禁；熔炉（会动世界）该进
  const viewSrc = readFileSync(new URL('../extensions/mc_observe.mjs', import.meta.url), 'utf8')
  const gatedBlock = viewSrc.slice(viewSrc.indexOf('const DEFAULT_GATED'), viewSrc.indexOf(']', viewSrc.indexOf('const DEFAULT_GATED')))
  ok(!gatedBlock.includes('mc_craft'), 'mc_craft 不在 mc_observe 门禁名单里（只动背包，不用先看图）')
  ok(gatedBlock.includes('mc_furnace'), 'mc_furnace 在 mc_observe 门禁名单里（会动世界里的熔炉）', gatedBlock.replace(/\s+/g, ' '))
  ok(gatedBlock.includes('mc_chest'), 'mc_chest 在 mc_observe 门禁名单里（会开世界里的箱子）', gatedBlock.replace(/\s+/g, ' '))
}

/* ─────────────────────── ② 基础查询 ─────────────────────── */
console.log('— ② 基础查询 —')
{
  const { bot, world } = mkBot({})
  ok(itemIdOf(bot, 'oak_log') === idOf('oak_log'), 'itemIdOf 拿到 id')
  ok(itemIdOf(bot, 'nope') === null, 'itemIdOf 未知物品 → null')
  ok(itemNameOf(bot, idOf('oak_log')) === 'oak_log', 'itemNameOf 拿到名字')
  ok(itemNameOf(bot, 9999) === '#9999', 'itemNameOf 未知 id → #id')
  ok(canPlaceInto({ boundingBox: 'empty' }) === true, 'canPlaceInto：empty 能放')
  ok(canPlaceInto({ boundingBox: 'block' }) === false, 'canPlaceInto：实心不能放')
  ok(canPlaceInto(null) === false, 'canPlaceInto：null → false')
  world.set(1, 2, 3, 'crafting_table')
  ok(blockAtXYZ(bot, 1.9, 2.4, 3.1)?.name === 'crafting_table', 'blockAtXYZ 会向下取整并查到方块')
  ok(blockAtXYZ(bot, 5, 2, 3) === null || blockAtXYZ(bot, 5, 2, 3).name === 'air', 'blockAtXYZ 空位 → 空气（或 null）')
  ok(findTableBlock(bot, { x: 1, y: 2, z: 3 })?.name === 'crafting_table', 'findTableBlock 按坐标找到工作台')
  ok(findTableBlock(bot, { x: 1, y: 2, z: 4 }) === null, 'findTableBlock 坐标不是工作台 → null')
  ok(findTableBlock(bot, { radius: 4 })?.position.x === 1, 'findTableBlock 半径内找最近的')
  const far = mkBot({}, { world: mkWorld({ '9,1,0': 'crafting_table' }) })
  ok(findTableBlock(far.bot, { radius: 4 }) === null, 'findTableBlock 太远 → null')
  ok(findTableBlock(far.bot, { radius: 99 }) === null, 'findTableBlock 半径被夹到 8（8.5 格外的找不到）')
  ok(findTableBlock(mkBot({}).bot, { radius: 4 }) === null, 'findTableBlock 世界里没有 → null')
  // 真 1.21.10 实机踩到的坑：物品 id ≠ 方块 id，findBlock 比的是 block.type
  ok(mod.blockIdOf(bot, 'crafting_table') === BLOCK_ID_BASE + idOf('crafting_table'), 'blockIdOf 用 blocksByName 的方块 id（不是物品 id）')
  ok(mod.blockIdOf(bot, 'crafting_table') !== idOf('crafting_table'), 'blockIdOf ≠ itemIdOf（假注册表里故意错开 1000）')
  ok(findTableBlock(bot, { radius: 4 })?.name === 'crafting_table', '拿方块 id 找得到工作台（拿物品 id 会 null）')
  const spot = findPlaceSpot(bot)
  ok(spot && spot.y === 1 && (Math.abs(spot.x) + Math.abs(spot.z)) === 1, 'findPlaceSpot 找脚边一格（下面是草方块）', JSON.stringify(spot))
  const ring1 = { '1,1,0': 'stone', '-1,1,0': 'stone', '0,1,1': 'stone', '0,1,-1': 'stone' }
  const noOrtho = mkBot({}, { world: mkWorld(ring1) })
  const spot2 = findPlaceSpot(noOrtho.bot)
  ok(spot2 && Math.max(Math.abs(spot2.x), Math.abs(spot2.z)) === 1, '四边占住 → 换斜角（不再白跑）', JSON.stringify(spot2))
  const ringAll = { ...ring1 }
  for (const k of ['1,1,1', '1,1,-1', '-1,1,1', '-1,1,-1', '2,1,0', '-2,1,0', '0,1,2', '0,1,-2',
    '2,1,1', '2,1,-1', '-2,1,1', '-2,1,-1', '1,1,2', '1,1,-2', '-1,1,2', '-1,1,-2', '2,1,2', '2,1,-2', '-2,1,2', '-2,1,-2']) ringAll[k] = 'stone'
  const noSpot = mkBot({}, { world: mkWorld(ringAll) })
  ok(findPlaceSpot(noSpot.bot) === null, '半径 2 内全占住 → null')
}

/* ─────────────────────── ③ 名字解析 ─────────────────────── */
console.log('— ③ 名字解析 —')
{
  const { bot } = mkBot({ oak_log: 2 })
  ok(resolveItem(bot, 'oak_planks').item.name === 'oak_planks', '精确名')
  ok(resolveItem(bot, 'minecraft:oak_planks').item.name === 'oak_planks', '带 minecraft: 前缀')
  ok(resolveItem(bot, 'Oak_Planks').item.name === 'oak_planks', '大小写不敏感')
  ok(resolveItem(bot, 'oak planks').item.name === 'oak_planks', '空格 → 下划线')
  const amb = resolveItem(bot, 'planks')
  ok(amb.item.name === 'oak_planks' && amb.note && amb.note.includes('自动选了'), 'planks 有歧义 → 按可合成性选 oak_planks 并给说明', JSON.stringify(amb.note))
  const ambLog = resolveItem(bot, 'log')
  ok(ambLog.item.name === 'oak_log', 'log 有歧义 → 选背包里有的 oak_log')
  const birchOnly = mkBot({ birch_log: 2 })
  ok(resolveItem(birchOnly.bot, 'planks').item.name === 'birch_planks', '只有桦木原木时 planks → birch_planks（不是按字母猜）')
  /* 🔴 2026-10-19 实机：背包有 oak_planks×5（**但 oak_log 为 0，做不出来**）和 birch_log×4（能做 12 块），
   * `{name:"planks", count:12}` 却按"背包里有"选了 oak_planks ⇒ 直接报"原料不够：oak_log 需要 2、有 0"。
   * 判据改成"**够用 或 做得出**"优先。 */
  {
    const mix = mkBot({ oak_planks: 5, birch_log: 4 })
    const t12 = resolveItem(mix.bot, 'planks', null, 12)
    ok(t12.item.name === 'birch_planks', '要 12 块时选"做得出"的桦木，不是"有 5 块但缺料"的橡木', t12.item.name)
    const t1 = resolveItem(mix.bot, 'planks', null, 1)
    ok(t1.item.name === 'oak_planks', '只要 1 块时仍选背包里已有的（够用就行）', t1.item.name)
  }
  throws('未知物品 → 抛错并提示写英文 id', () => resolveItem(mkBot({}).bot, 'xyzzy'), /没有叫/)
  throws('空名字 → 抛错', () => resolveItem(mkBot({}).bot, '  '), /要合成什么/)
  const nothing = mkBot({})
  throws('歧义且都做不出来 → 抛错并列出候选', () => resolveItem(nothing.bot, 'pickaxe'), /能对应|写全名/)
}

/* ─────────────────────── ④ 递归规划 ─────────────────────── */
console.log('— ④ 递归规划 —')
{
  const T = { name: 'crafting_table', position: { x: 1, y: 1, z: 0 } }
  const twoLogs = mkBot({ oak_log: 2 })
  const p1 = planCraft(twoLogs.bot, idOf('oak_planks'), 8, null)
  ok(p1.ok && p1.steps.length === 1 && p1.steps[0].times === 2, '8 木板 = 1 步 ×2 次合成', JSON.stringify(p1.steps.map((s) => [s.name, s.times])))
  ok(p1.steps[0].from[0].name === 'oak_log' && p1.steps[0].from[0].count === 2, '计划里写明消耗 oak_log ×2')

  const oneLog = mkBot({ oak_log: 1 })
  const p2 = planCraft(oneLog.bot, idOf('wooden_pickaxe'), 1, T)
  ok(!p2.ok && p2.missing.some((m) => m.name === 'oak_log'), '只有 1 个原木 → 木镐做不了（要 2 个原木），缺料里点名 oak_log', JSON.stringify(p2.missing))

  const threeLogs = mkBot({ oak_log: 3 })
  const p3 = planCraft(threeLogs.bot, idOf('wooden_pickaxe'), 1, T)
  const names = p3.steps.map((s) => s.name)
  ok(p3.ok, '3 个原木 → 木镐可规划', JSON.stringify(p3.missing))
  ok(names.indexOf('oak_planks') < names.indexOf('stick') && names.indexOf('stick') < names.indexOf('wooden_pickaxe'), '顺序：木板 → 木棍 → 木镐', names.join('→'))
  ok(p3.steps.find((s) => s.name === 'wooden_pickaxe').table === true, '木镐那步标记"用工作台"')
  ok(p3.steps.filter((s) => s.name === 'oak_planks').length === 1, '木板只排了一步（虚拟背包记账，不重复合成）', JSON.stringify(p3.steps.map((s) => [s.name, s.times])))
  ok(p3.steps.find((s) => s.name === 'oak_planks').times === 2, '木板那步合并成 2 次合成（共 8 块）')

  const noTable = mkBot({ oak_planks: 3, stick: 2 })
  const p4 = planCraft(noTable.bot, idOf('wooden_pickaxe'), 1, null)
  ok(!p4.ok && p4.missing.some((m) => m.name === 'crafting_table' && m.why.includes('需要工作台')), '没工作台 → 缺料报告点名工作台', JSON.stringify(p4.missing))

  const haveAll = mkBot({ oak_planks: 3, stick: 2 })
  ok(planCraft(haveAll.bot, idOf('wooden_pickaxe'), 1, T).ok, '原料齐 + 有工作台 → 可规划')
  ok(planCraft(haveAll.bot, idOf('wooden_pickaxe'), 1, T).steps.length === 1, '原料齐时只有 1 步（不用补中间产物）')

  const noRecipe = mkBot({})
  const p5 = planCraft(noRecipe.bot, idOf('diamond'), 1, T)
  ok(!p5.ok && p5.missing.some((m) => m.why.includes('没有配方')), '不可合成的物品 → "没有配方"', JSON.stringify(p5.missing))

  const deep = mkBot({ chain_e: 1 })
  const p6 = planCraft(deep.bot, idOf('chain_a'), 1, null, { maxDepth: 2 })
  ok(!p6.ok && p6.missing.some((m) => m.why.includes('层次太深')), '链条超过深度上限 → "层次太深"', JSON.stringify(p6.missing))
  ok(planCraft(deep.bot, idOf('chain_a'), 1, null, { maxDepth: 6 }).ok, '深度够时链条能规划出来')

  const manyLogs = mkBot({ oak_log: 300 })
  const p7 = planCraft(manyLogs.bot, idOf('oak_planks'), 1000, null)
  ok(p7.ok && p7.steps[0].times === 64 && p7.note, '次数被夹到 64 并给出提示', JSON.stringify(p7.note))

  const withTable = mkBot({ cobblestone: 8 })
  ok(planCraft(withTable.bot, idOf('furnace'), 1, T).ok, '圆石 ×8 + 工作台 → 熔炉可规划')
  ok(!planCraft(withTable.bot, idOf('furnace'), 1, null).ok, '同样材料但没工作台 → 熔炉做不了')

  const ing = ingredientsOf(RECIPES[0])
  ok(ing.length === 1 && ing[0].id === idOf('oak_log') && ing[0].count === 1, 'ingredientsOf 只取负数项（原料）')
  ok(ingredientsOf(null).length === 0, 'ingredientsOf(null) → 空')
}

/* ─────────────────────── ⑤ 文案 ─────────────────────── */
console.log('— ⑤ 计划/缺料文案 —')
{
  const T = { name: 'crafting_table', position: { x: 1, y: 1, z: 0 } }
  const { bot } = mkBot({ oak_log: 3 })
  const plan = planCraft(bot, idOf('wooden_pickaxe'), 1, T)
  const txt = describePlan(plan, 'wooden_pickaxe', 1)
  ok(txt.includes('合成计划') && txt.includes('wooden_pickaxe ×1'), '计划文案有标题')
  ok(txt.includes('oak_planks') && txt.includes('←') && txt.includes('oak_log'), '计划文案列出原料')
  ok(txt.includes('用工作台'), '计划文案标出哪一步用工作台')
  const lack = describeMissing(planCraft(mkBot({ oak_log: 1 }).bot, idOf('wooden_pickaxe'), 1, T))
  ok(lack.includes('原料不够') && lack.includes('oak_log') && lack.includes('需要') && lack.includes('背包里有'), '缺料文案写清需要/现有')
  ok(lack.includes('mc_dig'), '缺料文案给出下一步工具')
  const lackTable = describeMissing(planCraft(mkBot({ oak_planks: 3, stick: 2 }).bot, idOf('wooden_pickaxe'), 1, null))
  ok(lackTable.includes('工作台'), '缺工作台的文案提到工作台')
  // 🔴 实机教训（2026-10-07）：只有 2 块木板、做工作台要 4 块 —— 报告必须说清"卡在木板"。
  //    旧版只报最底下的叶子（「oak_log：需要 1，背包里有 0」），模型当场理解成
  //    "工作台要用原木做"，还以为 mc_craft 数错了背包，跑去找树了。
  {
    const lackPlanks = describeMissing(planCraft(mkBot({ oak_planks: 2 }).bot, idOf('crafting_table'), 1, null))
    ok(lackPlanks.includes('卡在') && lackPlanks.includes('oak_planks') && /要 4/.test(lackPlanks) && /只有 2/.test(lackPlanks),
      '缺料报告说清"卡在木板：要 4、只有 2"', lackPlanks)
    ok(lackPlanks.includes('链条：') && lackPlanks.includes('crafting_table') && lackPlanks.includes('oak_log'),
      '缺料报告给出整条链（目标 → 中间物 → 叶子）', lackPlanks)
    ok(lackPlanks.includes('同一种木头'), '缺料报告提醒"木板要同一种木头"', lackPlanks)
    const lackDeep = describeMissing(planCraft(mkBot({ oak_planks: 2 }).bot, idOf('crafting_table'), 1, null, { maxDepth: 1 }))
    ok(lackDeep.includes('层次太深') && !lackDeep.includes('链条：'), '深度截断时不硬编链条（照旧报层次太深）', lackDeep)
  }
  const info = listRecipesFor(mkBot({ oak_log: 1 }).bot, idOf('oak_planks'), null)
  ok(info.name === 'oak_planks' && info.recipes.length === 1 && info.recipes[0].from[0].have === 1, 'listRecipesFor 给出原料与现有量', JSON.stringify(info))
  const needT = listRecipesFor(mkBot({}).bot, idOf('wooden_pickaxe'), null)
  ok(needT.recipes.length === 0 && needT.needTable === true, '没工作台时 listRecipesFor 报 needTable', JSON.stringify(needT))
  const can = listCraftable(mkBot({ oak_log: 2 }).bot, null)
  ok(can.some((c) => c.name === 'oak_planks'), 'listCraftable 列出当前能做的（木板）', JSON.stringify(can))
  ok(!can.some((c) => c.name === 'wooden_pickaxe'), 'listCraftable 不列需要工作台/缺料的')
}

/* ─────────────────────── ⑥ 端到端 execute ─────────────────────── */
console.log('— ⑥ 端到端 execute —')
{
  // dryRun：只出计划不动手（也不该真去放工作台）
  {
    const f = mkBot({ oak_log: 3, crafting_table: 1 })
    const mc = mkMc(f)
    const r = await run({ name: 'wooden_pickaxe', dryRun: true }, { mc })
    ok(r.text.includes('合成计划') || r.text.includes('需要工作台'), 'dryRun：能排计划就出计划、缺工作台就如实报（不偷放）', r.text)
    ok(f.calls.length === 0, 'dryRun 没有真的合成')
    ok(f.counts.get(idOf('oak_log')) === 3, 'dryRun 没动物品')
    ok(mc.placeCalls.length === 0, 'dryRun 不真放工作台', JSON.stringify(mc.placeCalls))
  }
  // 真合成：3 原木 → 8 木板
  {
    const f = mkBot({ oak_log: 3 })
    const mc = mkMc(f)
    const r = await run({ name: 'oak_planks', count: 8 }, { mc })
    ok(f.counts.get(idOf('oak_planks')) === 8, '合成出 8 块木板', String(f.counts.get(idOf('oak_planks'))))
    ok(f.calls.length === 2 && f.calls.every((c) => c.count === 1),
      '一批一批来（2 次 craft、每次 1 批 —— 别指望一次 bot.craft 就做够）', JSON.stringify(f.calls))
    ok(r.text.includes('✅ 合成完成') && r.text.includes('oak_planks ×8'), '结果文案写明合成完成与数量', r.text)
    ok(f.counts.get(idOf('oak_log')) === 1, '消耗了 2 个原木')
  }
  // 自动用附近的工作台
  {
    const f = mkBot({ oak_planks: 3, stick: 2 }, { world: mkWorld({ '1,1,0': 'crafting_table' }) })
    const mc = mkMc(f)
    const r = await run({ name: 'wooden_pickaxe' }, { mc })
    ok(f.counts.get(idOf('wooden_pickaxe')) === 1, '用附近工作台合出了木镐')
    ok(f.calls.some((c) => c.out === 'wooden_pickaxe' && c.table === 'table'), 'craft 时传了工作台', JSON.stringify(f.calls))
    ok(r.text.includes('工作台：(1,1,0)'), '结果里写了用的哪个工作台', r.text)
    ok(mc.placeCalls.length === 0, '附近已有工作台 → 不再放')
  }
  // 默认**不**自动放工作台（用户 2026-10-19：「不要自动放工作台」「尽量让 ai 控制」）
  {
    const f = mkBot({ oak_log: 3, crafting_table: 1 })
    const mc = mkMc(f)
    const r0 = await run({ name: 'wooden_pickaxe' }, { mc })
    ok(mc.placeCalls.length === 0, '🔴 默认不放工作台（用户 2026-10-19：「把自动放的功能去掉」）', JSON.stringify(mc.placeCalls))
    ok(r0.text.includes('需要工作台'), '默认不放时如实说"缺工作台"，不偷偷放', r0.text)
  }
  // 附近没有 + 背包里有 → 也不放（用户 2026-10-19：「把自动放的功能去掉」）
  {
    const f = mkBot({ oak_planks: 3, stick: 2, crafting_table: 1 })
    const mc = mkMc(f)
    const r = await run({ name: 'wooden_pickaxe' }, { mc })
    ok(mc.placeCalls.length === 0, '🔴 永远不放工作台（用户 2026-10-19）')
    ok(r.text.includes('需要工作台'), '报"需要工作台"', r.text)
  }
  // 缺料：给出下一步
  {
    const f = mkBot({})
    const mc = mkMc(f)
    const r = await run({ name: 'wooden_pickaxe' }, { mc })
    ok(r.text.includes('原料不够') && r.text.includes('oak_log'), '缺料报告点名 oak_log', r.text)
    ok(r.text.includes('mc_dig'), '缺料报告给出 mc_dig 建议')
    ok(f.calls.length === 0, '缺料时不合成')
  }
  // 需要镐子才能挖的石头：缺料提示 mc_dig stone
  {
    const f = mkBot({ cobblestone: 2 })
    const mc = mkMc(f)
    const r = await run({ name: 'furnace' }, { mc })
    ok(r.text.includes('cobblestone'), '熔炉缺圆石时点名 cobblestone', r.text)
  }
  // list：没给 name → 当前能做
  {
    const f = mkBot({ oak_log: 2 })
    const mc = mkMc(f)
    const r = await run({ list: true }, { mc })
    ok(r.text.includes('立刻能合成') && r.text.includes('oak_planks'), 'list 无 name → 列当前能做的', r.text)
    ok(f.calls.length === 0, 'list 不合成')
  }
  // list：给了 name → 配方 + 够不够
  {
    const f = mkBot({ oak_log: 1 })
    const mc = mkMc(f)
    const r = await run({ list: true, name: 'oak_planks' }, { mc })
    ok(r.text.includes('配方') && r.text.includes('oak_log') && r.text.includes('有 1'), 'list 有 name → 列配方与现有量', r.text)
    const r2 = await run({ list: true, name: 'wooden_pickaxe' }, { mc })
    ok(r2.text.includes('需要工作台'), 'list 木镐（没工作台）→ 提示需要工作台', r2.text)
  }
  // 未知物品
  {
    const f = mkBot({})
    const mc = mkMc(f)
    const r = await run({ name: 'xyzzy' }, { mc })
    ok(r.text.startsWith('❌') && r.text.includes('没有叫'), '未知物品 → ❌ 提示', r.text)
  }
  // 歧义自动选，并在结果里说明
  {
    const f = mkBot({ birch_log: 2 })
    const mc = mkMc(f)
    const r = await run({ name: 'planks', count: 4 }, { mc })
    ok(f.counts.get(idOf('birch_planks')) === 4, 'planks 自动选了 birch_planks 并合出 4 块', String(f.counts.get(idOf('birch_planks'))))
    ok(r.text.includes('自动选了'), '结果里说明自动选了哪个', r.text)
  }
  // 合成中途被服务器拒 → 报中断，不谎报成功
  {
    const f = mkBot({ oak_log: 2 }, { craftThrows: true })
    const mc = mkMc(f)
    const r = await run({ name: 'oak_planks', count: 4 }, { mc })
    ok(r.text.includes('合成中断') && r.text.includes('领地保护'), '合成失败 → 报中断原因', r.text)
    ok(!r.text.includes('✅'), '失败时不写成功')
  }
  // 东西其实做出来了、只是窗口事件丢了（`updateSlot:0 did not fire`）→ 不许谎报失败，也不许再要一次材料
  {
    const f = mkBot({ oak_log: 1 }, { craftSpurious: true })
    const mc = mkMc(f)
    const r = await run({ name: 'oak_planks', count: 4 }, { mc })
    ok(f.counts.get(idOf('oak_planks')) === 4, '窗口事件丢了但东西真到手了（4 块木板）', String(f.counts.get(idOf('oak_planks'))))
    ok(f.calls.length === 1, 'craft 只叫了一次（没拿着刚做好的东西再要一次材料）', `calls=${f.calls.length}`)
    ok(r.text.includes('到手') && r.text.includes('✅'), '如实报"东西已经到手"，仍然算成功', r.text)
    ok(!r.text.includes('❌'), '不谎报失败', r.text)
  }
  // 名字解析失败也要有工作台信息？不：先报错
  {
    const f = mkBot({})
    const mc = mkMc(f)
    const r = await run({ name: '' }, { mc })
    ok(r.text.startsWith('❌'), '空名字 → ❌', r.text)
  }
  // 离线
  {
    const f = mkBot({})
    const mc = mkMc(f, { online: false })
    let threw = null
    try { await run({ name: 'oak_planks' }, { mc }) } catch (e) { threw = e }
    ok(threw && /不在线/.test(threw.message), '离线时 execute 抛错（宿主会把它变成工具错误）', threw && threw.message)
  }
  // 假 recipesAll 故障也不崩（会走"没有配方"分支）
  {
    const f = mkBot({ oak_log: 1 }, { recipesAllThrows: true })
    const mc = mkMc(f)
    const r = await run({ name: 'oak_planks' }, { mc })
    ok(r.text.includes('没有配方'), 'recipesAll 抛错 → 当成没有配方（不崩）', r.text)
  }
}

/* ─────────────────────── ⑦ 真配方数据（1.21.10）选料 ─────────────────────── */
console.log('— ⑦ 真配方数据（1.21.10）选料 —')
// 真数据里同一样东西**每个木种各一条**（crafting_table 12 条、wooden_pickaxe 12 条、stick 13 条、
// furnace 3 条），而 Recipe.find 的返回顺序是任意的（cherry 排最前）。这一节直接用真的
// prismarine-recipe + minecraft-data 复现"手里有橡木原木却让你去找樱桃木"的 bug，防止它再回来。
{
  const { createRequire } = await import('node:module')
  const req = createRequire(new URL('../index.js', import.meta.url))
  let mcData = null
  let Recipe = null
  try {
    mcData = req('minecraft-data')('1.21.10')
    Recipe = req('prismarine-recipe')(mcData).Recipe
  } catch (e) { console.log('  (跳过：拿不到真配方数据 —— ' + e.message + ')') }

  if (mcData && Recipe) {
    const realReg = { items: mcData.items, itemsByName: mcData.itemsByName }
    const realRecipes = (id, metadata, table) => (Recipe.find(id, metadata) ?? []).filter((r) => !r.requiresTable || table)
    const rid = (n) => mcData.itemsByName[n].id
    const mkReal = (inv, world, opts = {}) => mkBot(inv, { registry: realReg, recipes: realRecipes, world, ...opts })

    const nTable = Recipe.find(rid('crafting_table'), null).length
    const nPick = Recipe.find(rid('wooden_pickaxe'), null).length
    ok(nTable >= 10, `真数据里 crafting_table 有 ${nTable} 条配方（每种木板一条）`)
    ok(nPick >= 10, `真数据里 wooden_pickaxe 有 ${nPick} 条配方`)

    // ① 手里有橡木原木 → 必须选 oak_planks 那条，不能选 cherry
    {
      const f = mkReal({ oak_log: 1 })
      const r = await run({ name: 'crafting_table', dryRun: true }, { mc: mkMc(f), id: 'R1' })
      ok(/oak_planks/.test(r.text) && !/cherry/.test(r.text), '有橡木原木时选 oak_planks（不再选 cherry）', r.text.split('\n')[0])
      ok(f.calls.length === 0, 'dryRun 没有真合成')
    }
    // ② 木镐（要工作台）：附近有工作台时，木板也必须是橡木系列
    {
      const f = mkReal({ oak_log: 2 }, mkWorld({ '1,1,0': 'crafting_table' }))
      const r = await run({ name: 'wooden_pickaxe', dryRun: true }, { mc: mkMc(f), id: 'R2' })
      ok(!/cherry|birch|spruce|jungle|acacia|dark_oak/.test(r.text), '木镐计划只用橡木系列', r.text.split('\n')[0])
      ok(/wooden_pickaxe/.test(r.text), '木镐计划里有木镐')
    }
    // ③ 空背包：报缺料也不该点名 cherry（兜底选 id 最小、最老的木材）
    {
      const f = mkReal({})
      const r = await run({ name: 'crafting_table', dryRun: true }, { mc: mkMc(f), id: 'R3' })
      ok(/oak/.test(r.text) && !/cherry/.test(r.text), '空背包时报缺料也不点 cherry', r.text.split('\n')[0])
    }
    // ④ 真数据 + 真 craft：1 个原木真做出 1 个工作台
    {
      const f = mkReal({ oak_log: 1 })
      const r = await run({ name: 'crafting_table' }, { mc: mkMc(f), id: 'R4' })
      ok(f.calls.some((c) => c.out === 'crafting_table'), '真数据下真合成工作台', r.text.slice(0, 100).replace(/\n/g, ' '))
      ok((f.counts.get(rid('crafting_table')) ?? 0) >= 1, '背包里出现了工作台')
    }
    // ⑤ 🔴 背包里混着别的木种（真服最常见的坑）：计划选了橡木，执行期必须**照着计划走**。
    //    旧代码执行期用 recipesReady(...)[0] ?? recipesAllOf(...)[0] 重挑：Recipe.find 里 birch 排在 oak 前面，
    //    第一步做橡木木板（因为只有橡木原木够 2 次），第二步却挑走背包里剩的 2 个桦木木板做木棍，
    //    第三步就既没有 3 个橡木木板、也没有 2 根桦木木棍 → 兜底成 cherry → mineflayer 抛 missing ingredient。
    //    （实机日志：第一次调用失败、4 秒后重试成功 —— AI 自己都学会"重试一次"了。）
    {
      const f = mkReal({ oak_log: 2, oak_planks: 1, birch_planks: 2 }, mkWorld({ '1,1,0': 'crafting_table' }))
      const r = await run({ name: 'wooden_pickaxe' }, { mc: mkMc(f), id: 'R5' })
      ok(/完成/.test(r.text) && !/missing ingredient|原料对不上|原料不够/.test(r.text),
        '混着桦木木板时木镐一次做成功（不再靠重试）', r.text.split('\n').slice(0, 3).join(' ').slice(0, 160))
      ok((f.counts.get(rid('wooden_pickaxe')) ?? 0) === 1, '背包里真的出现了木镐')
      ok((f.counts.get(rid('birch_planks')) ?? 0) === 2, '桦木木板没被动（计划选的是橡木，就得一路橡木）')
      ok((f.counts.get(rid('oak_log')) ?? 0) === 1, '只用了 1 根橡木原木')
      ok((f.counts.get(rid('oak_planks')) ?? 0) === 0, '橡木木板刚好用光（4 做木棍 + 3 做木镐）')
      ok(f.calls.filter((c) => c.out === 'wooden_pickaxe').length === 1, '木镐只合成了一次')
      // 🔴 `mc.inventory()` 回的是 `{ held, items }`：旧代码用 `Array.isArray(inv)` 判断，
      //    永远为假 ⇒ 这行"背包：…"从来没打印过（假件以前返回数组，把这个 bug 藏住了）。
      ok(r.text.includes('背包：'), '成功报告里带上背包一览（不再是永不打印的死代码）', r.text.split('\n').slice(-2).join(' '))
    }
    // ⑥ 执行期原料真的对不上时：报"缺什么"，不是 mineflayer 那句 missing ingredient
    {
      const f = mkReal({ oak_planks: 1, stick: 1 }, mkWorld({ '1,1,0': 'crafting_table' }))
      const r = await run({ name: 'wooden_sword' }, { mc: mkMc(f), id: 'R6' })
      ok(/原料不够|缺料/.test(r.text), '缺料时照旧报缺料（不硬跑）', r.text.split('\n').slice(0, 3).join(' '))
    }
    // ⑧ 🔴 只有**生原木**、一个木板都没有时，必须挑"能用背包里那棵树"的那条配方。
    //    旧代码：12 条 crafting_table 配方的 full/part 全是 0，只能按"原料 id 最小"兜底 → 挑 oak_planks，
    //    而背包里是 jungle_log → 报"缺 oak_log"，明明是同一棵树上的木头。
    //    （2026-10-06 实机日志：mc_craft {name:"crafting_table"} → ❌ 缺料（oak_log），背包里 jungle_log×1）
    {
      const f = mkReal({ jungle_log: 1 })
      const r = await run({ name: 'crafting_table', dryRun: true }, { mc: mkMc(f), id: 'R8' })
      ok(/jungle_planks/.test(r.text) && !/oak/.test(r.text), '只有丛林原木时选 jungle_planks（不再挑 oak）', r.text.split('\n')[0])
      const r2 = await run({ name: 'crafting_table' }, { mc: mkMc(f), id: 'R8b' })
      ok(/完成/.test(r2.text) && !/缺料|原料不够/.test(r2.text), '只有丛林原木时能真做出工作台', r2.text.split('\n').slice(0, 2).join(' '))
      ok((f.counts.get(rid('crafting_table')) ?? 0) >= 1, '背包里真的出现了工作台')
    }
    // ⑨ 同一条思路：只有丛林原木 + 工作台时，木镐也必须是丛林系列
    {
      const f = mkReal({ jungle_log: 3 }, mkWorld({ '1,1,0': 'crafting_table' }))
      const r = await run({ name: 'wooden_pickaxe', dryRun: true }, { mc: mkMc(f), id: 'R9' })
      ok(/jungle/.test(r.text) && !/oak|birch|cherry|spruce|acacia|dark_oak/.test(r.text),
        '只有丛林原木时木镐计划只用丛林系列', r.text.split('\n')[0])
      const r2 = await run({ name: 'wooden_pickaxe' }, { mc: mkMc(f), id: 'R9b' })
      ok(/完成/.test(r2.text) && !/缺料|原料对不上/.test(r2.text), '只有丛林原木时能真做出木镐',
        r2.text.split('\n').slice(0, 3).join(' ').slice(0, 160))
      ok((f.counts.get(rid('wooden_pickaxe')) ?? 0) === 1, '背包里真的出现了木镐')
    }
    // ⑦ mineflayer 偶尔误报 missing ingredient：自动重试，不再需要 AI 自己重试
    {
      const f = mkReal({ oak_log: 1 }, mkWorld(), { craftMissingOnce: true })
      const r = await run({ name: 'oak_planks' }, { mc: mkMc(f), id: 'R7' })
      ok(/完成/.test(r.text), '第一次被误报 missing ingredient 时自动重试成功', r.text.split('\n').slice(0, 3).join(' '))
      ok(f.calls.length === 1 && (f.counts.get(rid('oak_planks')) ?? 0) === 4, '重试后真的合成了 4 个木板')
    }
    // ⑩ 🔴 空背包时 furnace 有三条配方（8 圆石 / 8 深板岩圆石 / 8 黑石），full/part/reach 全平。
    //    旧代码按"原料 id 最小"兜底 → 挑出生僻的 cobbled_deepslate，AI 看了完全不知道该去挖什么。
    //    （2026-10-06 实机日志：mc_craft {name:"furnace"} → ❌ 缺料（cobbled_deepslate））
    {
      const f = mkReal({})
      const r = await run({ name: 'furnace', dryRun: true }, { mc: mkMc(f), id: 'R10' })
      ok(/cobblestone/.test(r.text), '空背包做熔炉时报 cobblestone（不再是 cobbled_deepslate）', r.text.split('\n')[0])
      ok(!/deepslate|blackstone/.test(r.text), '空背包做熔炉时不点 deepslate/blackstone', r.text.split('\n')[0])
    }
    // ⑪ craft 正常返回但背包没变（点格子没生效）→ 也自动重试，而不是把失败丢给 AI
    {
      const f = mkReal({ oak_log: 1 }, mkWorld(), { craftNoopOnce: true })
      const r = await run({ name: 'oak_planks' }, { mc: mkMc(f), id: 'R11' })
      ok(/完成/.test(r.text) && !/没有产出/.test(r.text), 'craft 空转一次后自动重试成功', r.text.split('\n').slice(0, 3).join(' '))
      ok(f.calls.length === 2 && f.calls[0].noop === true, '第一次空转、第二次真合成', JSON.stringify(f.calls))
      ok((f.counts.get(rid('oak_planks')) ?? 0) === 4, '重试后真的合成了 4 个木板')
    }
  }
}

/* ─────────────────────── ⑧ 合成窗口失步 ─────────────────────── */
console.log('— ⑧ 合成窗口失步（实机 2026-10-07：10 根橡木没了、多了个橡木按钮） —')
{
  // ① 上一条 craft 还挂着时**绝不开第二条链**：先关窗口、等一小会儿，等不到就如实拒绝
  {
    const trace = []
    const f = mkBot({ oak_log: 2 }, { craftDelayMs: 2500, craftThrows: true, trace })
    const mc = mkMc(f)
    const p1 = run({ name: 'oak_planks' }, { mc, id: 'S1' }) // 不 await：这条会挂 2.5 秒
    await new Promise((r) => setTimeout(r, 150))
    const t0 = Date.now()
    const r2 = await run({ name: 'oak_planks' }, { mc, id: 'S1' })
    const ms = Date.now() - t0
    ok(/上一次合成还在跑/.test(r2.text) && /mc_scan/.test(r2.text) && !/mc_connect/.test(r2.text),
      '上一条还在跑时如实拒绝，并教它 mc_scan 复核现场（**不再**劝它 mc_connect 重连）', r2.text.split('\n').slice(0, 2).join(' ').slice(0, 170))
    ok(f.calls.filter((c) => c.delayed).length === 1, '拒绝时不并行开第二条合成链', JSON.stringify(f.calls))
    ok(ms < 2200, `拒绝是"等一小会儿再拒绝"，不是干等（${ms}ms）`)
    const r1 = await p1
    ok(/中断|失败|被拒/.test(r1.text), '第一条如实报失败', r1.text.split('\n').slice(0, 2).join(' ').slice(0, 170))
  }
  // ② 动手前先关掉残留的容器窗口（关窗口 = 服务端把合成格里的东西退回背包）
  {
    const trace = []
    const f = mkBot({ oak_log: 1 }, { window: { type: 'minecraft:crafting', slots: [] }, trace })
    const r = await run({ name: 'oak_planks' }, { mc: mkMc(f), id: 'S2' })
    ok(/完成/.test(r.text), '有残留窗口时照样能合成', r.text.split('\n')[0].slice(0, 140))
    ok(trace[0] === 'close', '动手前先关窗口（把合成格里的东西退回背包）', trace.join(','))
    ok(trace.indexOf('close') < trace.indexOf('craft'), '关完窗口才真的合成', trace.join(','))
  }
  // ③ 服务端"做出了别的东西"（合成格模型串了）→ 如实报出来，别让它悄悄躺在背包里让 AI 困惑
  {
    const f = mkBot({ oak_log: 1 }, { craftWrongOnce: 'oak_button' })
    const r = await run({ name: 'oak_planks' }, { mc: mkMc(f), id: 'S3' })
    ok(/服务端其实做出了别的东西/.test(r.text) && /oak_button/.test(r.text),
      '抓出"服务端做出了别的东西（按钮）"并说清是合成格对不上', r.text.split('\n').slice(0, 3).join(' ').slice(0, 230))
    ok((f.counts.get(idOf('oak_button')) ?? 0) === 1, '那个按钮真的进了背包（如实报，不吞掉）')
    ok(/完成/.test(r.text), '重试之后照旧把木板做出来', (r.text.split('\n').find((l) => /完成/.test(l)) ?? '').slice(0, 120))
  }
  // ④ 够不着的工作台不当工作台用（旧代码会挂到预算到点：实机日志里 4123~5000ms 的超时）
  //    🔴 找表按"方块角"算距离（radius 4），能不能用按"方块中心"算（≤4）—— (4,1,0) 正好落在这条缝里：
  //    findTableBlock 找得到（3.54 格），tableUsable 说够不着（4.03 格）。这就是要防的那条缝。
  {
    const f = mkBot({ oak_log: 2 }, { world: mkWorld({ '4,1,0': 'crafting_table' }) })
    const r = await run({ name: 'wooden_pickaxe' }, { mc: mkMc(f), id: 'S4' })
    ok(/工作台用不了：离我/.test(r.text), '够不着的工作台不用它，并说清"离我几格"', r.text.split('\n').slice(0, 2).join(' ').slice(0, 170))
    ok(/工作台/.test(r.text) && !/完成/.test(r.text), '如实报"需要工作台"，不去挂那一整轮', r.text.split('\n').slice(0, 3).join(' ').slice(0, 210))
  }
  // ⑤ 反过来：3 格内的工作台照旧用（别误伤正常路径）
  {
    const f = mkBot({ oak_log: 2 }, { world: mkWorld({ '1,1,0': 'crafting_table' }) })
    const r = await run({ name: 'wooden_pickaxe' }, { mc: mkMc(f), id: 'S5' })
    ok(/完成/.test(r.text), '3 格内的工作台照旧用（没被误伤）', r.text.split('\n')[0].slice(0, 140))
    ok(f.calls.some((c) => c.table === 'table'), '合成时真的传了工作台', JSON.stringify(f.calls))
  }
  // ⑥ 看得见才算数：canSeeBlock 为假（中间挡着）也不用它
  {
    const f = mkBot({ oak_log: 2 }, { world: mkWorld({ '1,1,0': 'crafting_table' }), canSeeBlock: false })
    const r = await run({ name: 'wooden_pickaxe' }, { mc: mkMc(f), id: 'S6' })
    ok(/工作台用不了：视线被挡/.test(r.text), '看不见的工作台也不用它，并说清"视线被挡"', r.text.split('\n').slice(0, 2).join(' ').slice(0, 170))
  }
  // ⑥b 工作台正上方被实心方块挡着 ⇒ 人站不到它旁边，右键永远没回包（用户 2026-10-24）
  {
    const f = mkBot({ oak_log: 2 }, { world: mkWorld({ '1,1,0': 'crafting_table', '1,2,0': 'stone' }) })
    const r = await run({ name: 'wooden_pickaxe' }, { mc: mkMc(f), id: 'S6b' })
    ok(/正上方被 stone 挡着/.test(r.text), '正上方被挡时点名说是哪块方块', r.text.split('\n').slice(0, 2).join(' ').slice(0, 170))
    ok(/工作台/.test(r.text) && !/完成/.test(r.text), '如实报"需要工作台"，不当成能用', r.text.split('\n').slice(0, 3).join(' ').slice(0, 200))
  }
  // ⑦ 一次 craft 只做出一批（实机：要 8 块木板只出了 4 块）⇒ 自己把剩下的补上
  {
    const f = mkBot({ oak_log: 2 }, { craftOneBatch: true })
    const r = await run({ name: 'oak_planks', count: 8 }, { mc: mkMc(f), id: 'S7' })
    ok(/完成/.test(r.text), '只做出一批时自己补做，最后照旧报"完成"', r.text.split('\n').slice(0, 2).join(' ').slice(0, 170))
    ok((f.counts.get(idOf('oak_planks')) ?? 0) === 8, '真的凑够 8 块木板（不是只做 4 块就往下走）', `木板 ${f.counts.get(idOf('oak_planks')) ?? 0}`)
    ok(!/只做出来/.test(r.text), '凑够了就不该再说"只做出来 N 个"', r.text.split('\n').slice(0, 3).join(' ').slice(0, 200))
    ok(f.calls.filter((c) => c.out === 'oak_planks').length >= 2, '补做是再发一次 craft（不是假装成功）', JSON.stringify(f.calls))
  }
  // ⑧ 补也补不动（材料真不够 / 服务端就是不再给）⇒ 如实说，不假装数量够了
  {
    const f = mkBot({ oak_log: 2 }, { craftOneBatch: true, craftStopAfter: 1 })
    const r = await run({ name: 'oak_planks', count: 8 }, { mc: mkMc(f), id: 'S8' })
    ok(/只做出来 4 个/.test(r.text), '补不动时如实报"只做出来 4 个"', r.text.split('\n').slice(0, 3).join(' ').slice(0, 200))
    ok((f.counts.get(idOf('oak_planks')) ?? 0) === 4, '没有凭空变出木板', `木板 ${f.counts.get(idOf('oak_planks')) ?? 0}`)
  }
  // ⑨ 审计 M1：合成**还在跑**时绝不点合成格（点走它刚放进去的原料 ⇒ 它下一轮抛 missing ingredient）
  {
    const trace = []
    const f = mkBot({ oak_log: 4 }, { craftDelayMs: 2500, craftThrows: true, trace })
    // 让假背包里有"合成格里还剩东西"的样子，并记录 moveSlotItem
    f.bot.inventory.slots = { 1: { name: 'oak_planks', count: 1 } }
    f.bot.inventory.firstEmptyInventorySlot = () => 20
    f.bot.moveSlotItem = async (from, to) => { trace.push('move:' + from + '->' + to); return true }
    const mc = mkMc(f)
    const p1 = run({ name: 'oak_planks' }, { mc, id: 'S9' })   // 挂着 2.5 秒
    await new Promise((r) => setTimeout(r, 150))
    const movesBefore = trace.filter((t) => String(t).startsWith('move:')).length
    const r2 = await run({ name: 'oak_planks' }, { mc, id: 'S9' })
    const movesAfter = trace.filter((t) => String(t).startsWith('move:')).length
    ok(movesAfter === movesBefore, '合成还在跑 ⇒ 第二次调用**一个合成格都没点**（审计 M1）', trace.join(','))
    ok(/没有\*\*开第二条链|我\*\*没有\*\*开第二条链/.test(r2.text), '如实说"我没有开第二条链"', r2.text.split('\n').slice(0, 2).join(' ').slice(0, 200))
    ok(f.calls.filter((c) => c.delayed).length === 1, '确实没开第二条链', JSON.stringify(f.calls))
    await p1
  }
  // ⑩ 审计 M2：25 秒后**不删守卫**（旧代码删了 ⇒ 下一次再发 activateBlock ⇒ 两条链抢同一个窗口）
  {
    const trace = []
    const f = mkBot({ oak_log: 4 }, { craftDelayMs: 60_000, trace })
    const mc = mkMc(f)
    const p1 = run({ name: 'oak_planks' }, { mc, id: 'S10' })  // 挂住
    await new Promise((r) => setTimeout(r, 120))
    const realNow = Date.now
    let shift = 0
    Date.now = () => realNow() + shift
    shift = 40_000                                            // 假装已经挂了 40 秒（> CRAFT_STUCK_MS）
    let r2 = null
    try { r2 = await run({ name: 'oak_planks' }, { mc, id: 'S10' }) } finally { Date.now = realNow }
    ok(/挂了太久/.test(r2.text), '挂太久时说明"它挂了太久"', r2.text.split('\n').slice(0, 3).join(' ').slice(0, 200))
    ok(/上一次合成(还在跑|挂了太久)/.test(r2.text), '挂太久也**照样拒绝**（不因为超时就以为它死了）', r2.text.split('\n').slice(0, 2).join(' ').slice(0, 200))
    ok(f.calls.filter((c) => c.delayed).length === 1, '超时后仍不开第二条链（审计 M2 的核心）', JSON.stringify(f.calls))
    f.craftDelayMs = 0                                        // 放它走，别把进程挂住
    await p1.catch(() => {})
  }
  // ⑪ 反过来：上一条**确实收尾了**才关窗口 + 清合成格（别把 M1 修成"永远不清"）
  {
    const trace = []
    const f = mkBot({ oak_log: 1 }, { craftDelayMs: 80, trace })
    f.bot.inventory.slots = { 1: { name: 'oak_planks', count: 1 } }
    f.bot.inventory.firstEmptyInventorySlot = () => 20
    f.bot.moveSlotItem = async (from, to) => { trace.push('move:' + from + '->' + to); return true }
    const mc = mkMc(f)
    const p1 = run({ name: 'oak_planks' }, { mc, id: 'S11' })
    await new Promise((r) => setTimeout(r, 300))              // 第一条早就收尾了
    const r2 = await run({ name: 'oak_planks' }, { mc, id: 'S11' })
    ok(trace.some((t) => String(t).startsWith('move:')), '上一条收尾之后才点合成格（清回背包）', trace.join(','))
    ok(/完成/.test(r2.text) || /合成格里还剩/.test(r2.text), '清完照旧能合成', r2.text.split('\n').slice(0, 3).join(' ').slice(0, 200))
    await p1.catch(() => {})
  }
}

/* ─────────── ⑫ 背包满了：产物掉地上，必须点名（用户 2026-10-17 实机反馈） ─────────── */
console.log('— ⑫ 背包满了 ⇒ 产物掉地上，必须点名 —')
{
  /* 用户原话：「合成的时候背包满了，造出来的东西会掉地上，机器人不知道」。
   * 实机现场：第二把钻石镐就是这么掉在地上的（AI 看到的是「✅ 合成完成」）。 */
  /* 🔴 2026-10-27：这里必须给 `oak_log: 1`（不是 3）—— 现在动手前会先算"放得下吗"，
   *    空位 0 时只有"这叠料会被吃光、腾出一个槽位"才会放行；要测的正是"放行之后仍然掉地"这条兜底路径。 */
  const f = mkBot({ oak_log: 1 }, { craftToGround: true, emptySlots: 0 })
  const mc = mkMc(f)
  const r = await run({ name: 'oak_planks', count: 4 }, { mc })
  ok(!f.counts.get(idOf('oak_planks')), '产物没进背包（模拟的就是这个）', String(f.counts.get(idOf('oak_planks'))))
  ok(/产物没进背包/.test(r.text), '报的是"产物没进背包"，**不是**"合成中断/白做了"', r.text.split('\n').slice(0, 3).join(' '))
  ok(!/❌ 合成中断/.test(r.text), '不报成"合成中断"（料已经变成产物了，只是没进背包）', r.text)
  ok(/背包一个空位都没有/.test(r.text), '点名根因是"背包一个空位都没有"', r.text)
  ok(/脚边就有/.test(r.text) && /掉落物/.test(r.text), '扫到脚边的掉落物并报个数与距离', r.text)
  ok(/mc_move/.test(r.text) && /几分钟就消失/.test(r.text), '给出可执行的下一步（走过去捡 + 说明会消失）', r.text)
  ok(/先腾空位|mc_chest/.test(r.text), '告诉它下次合成前先腾空位', r.text)
  ok(r.value?.dropped === true && r.value?.onGround === 1, '返回里带机器可读的 dropped / onGround', JSON.stringify({ dropped: r.value?.dropped, onGround: r.value?.onGround }))
}
{
  // 空位还剩 1 个、这次没丢东西 ⇒ 也要预警（下次就来不及了）
  const f = mkBot({ oak_log: 3 }, { emptySlots: 1 })
  const mc = mkMc(f)
  const r = await run({ name: 'oak_planks', count: 4 }, { mc })
  ok(f.counts.get(idOf('oak_planks')) === 4, '空位够 ⇒ 照常合出来', String(f.counts.get(idOf('oak_planks'))))
  ok(/只剩 1 个空位/.test(r.text) && /mc_chest/.test(r.text), '空位只剩 1 ⇒ 预警并给出对策', r.text)
  ok(r.value?.lost == null, '没丢东西 ⇒ **不**带 lost（别虚报）', JSON.stringify({ lost: r.value?.lost }))
}
{
  // 空位充足、也没丢东西 ⇒ 一个字都不许多说（噪音）
  const f = mkBot({ oak_log: 3 }, { emptySlots: 20 })
  const mc = mkMc(f)
  const r = await run({ name: 'oak_planks', count: 4 }, { mc })
  ok(!/空位/.test(r.text) && !/掉在脚边|产物没进背包/.test(r.text), '空位充足 ⇒ 不提空位、不提掉地上（不加噪音）', r.text.split('\n').slice(0, 4).join(' '))
}
{
  // 扫不到脚边（假 bot 没有 distanceTo）⇒ 也得把"料被扣走了、产物没进背包"说出来
  const f = mkBot({ oak_log: 1 }, { craftToGround: true, emptySlots: 0 })
  delete f.bot.entity.position.distanceTo
  const mc = mkMc(f)
  const r = await run({ name: 'oak_planks', count: 4 }, { mc })
  ok(/产物没进背包/.test(r.text), '扫不了脚边也照样把"产物没进背包"说出来', r.text.split('\n').slice(0, 3).join(' '))
  ok(/脚边没扫到/.test(r.text) && /合成格里/.test(r.text), '扫不到就如实说扫不到（不编坐标），并提"可能卡在合成格里"', r.text)
}

/* ─────── ⑬ 背包放不下 ⇒ 动手前就拒绝，一粒料都不扣（用户 2026-10-27：「造东西背包满了就会，一直造」） ─────── */
console.log('— ⑬ 背包放不下 ⇒ 动手前拒绝 —')
{
  /* 实机现场（02:15–02:17）：`mc_craft {name:"diamond_chestplate", count:1}` 连着跑，
   * 每次都「产物没进背包（脚边 3 个掉落物）」—— 料一直被扣，模型看到"还差 1 个"就再来一次。 */
  const f = mkBot({ oak_log: 3 }, { emptySlots: 0 })
  const mc = mkMc(f)
  const r = await run({ name: 'oak_planks', count: 4 }, { mc })
  ok(/背包放不下，没开工/.test(r.text), '空位 0 且产物无处可放 ⇒ 动手前就拒绝', r.text.split('\n').slice(0, 3).join(' '))
  ok(/一粒料都没扣/.test(r.text), '明说"一粒料都没扣"（不然模型以为料已经没了）', r.text)
  ok(f.counts.get(idOf('oak_log')) === 3, '拒绝时**料一个都没动**', String(f.counts.get(idOf('oak_log'))))
  ok(/还要再做 4 个/.test(r.text) && /现在有 0 个/.test(r.text), '说清"还要再做几个 / 现在有几个"', r.text)
  ok(/mc_chest/.test(r.text) && /toss|丢掉/.test(r.text), '给出可执行对策（存箱子 / 丢掉 / 捡掉落物）', r.text)
  ok(r.value?.refused === true && r.value?.why === 'inventory-full', '返回里带机器可读的 refused / why', JSON.stringify({ refused: r.value?.refused, why: r.value?.why }))
  ok(!/✅/.test(r.text), '拒绝时不许出现 ✅（不然模型以为做成了）', r.text)
}
{
  // 同一样东西刚掉过地 ⇒ 再叫也拒绝，并点名"别再试"
  const f = mkBot({ oak_log: 3 }, { emptySlots: 0 })
  f.bot._craftDrop = { key: idOf('oak_planks'), n: 1 }
  const mc = mkMc(f)
  const r = await run({ name: 'oak_planks', count: 4 }, { mc })
  ok(/已经掉过 \*\*1 次\*\*地/.test(r.text), '点名"刚才已经掉过 1 次地"', r.text)
  ok(/别再叫同样的 mc_craft/.test(r.text), '明确叫停：别再叫同样的 mc_craft', r.text)
  ok(r.value?.droppedBefore === 1, '返回里带 droppedBefore', JSON.stringify({ droppedBefore: r.value?.droppedBefore }))
}
{
  // 腾出空位之后 ⇒ 旧账自动失效（否则会永久卡死）
  const f = mkBot({ oak_log: 3 }, { emptySlots: 20 })
  f.bot._craftDrop = { key: idOf('oak_planks'), n: 2 }
  const mc = mkMc(f)
  const r = await run({ name: 'oak_planks', count: 4 }, { mc })
  ok(f.counts.get(idOf('oak_planks')) === 4, '空位够了 ⇒ 旧账不再拦，照常合出来', String(f.counts.get(idOf('oak_planks'))))
  ok(f.bot._craftDrop == null, '成功就清账（不然腾出空位也永远拒）', JSON.stringify(f.bot._craftDrop))
}
{
  // 背包"满了"但产物能叠进手里那叠 ⇒ 绝不能拦（最容易误伤的一种）
  const f = mkBot({ oak_log: 3, oak_planks: 60 }, { emptySlots: 0 })
  const mc = mkMc(f)
  const r = await run({ name: 'oak_planks', count: 64 }, { mc })
  ok(!/背包放不下/.test(r.text), '产物能叠进已有那叠 ⇒ 不拦', r.text.split('\n').slice(0, 3).join(' '))
  ok(f.counts.get(idOf('oak_planks')) === 64, '该叠的照常叠到 64', String(f.counts.get(idOf('oak_planks'))))
}
{
  // 料会被吃光（那叠消失 = 腾出槽位）⇒ 空位 0 也要放行，别一上来就拒
  const f = mkBot({ oak_log: 1 }, { emptySlots: 0 })
  const mc = mkMc(f)
  const r = await run({ name: 'oak_planks', count: 4 }, { mc })
  ok(!/背包放不下/.test(r.text), '料被吃光能腾出槽位 ⇒ 放行（不许一刀切拒绝）', r.text.split('\n').slice(0, 3).join(' '))
}

{
  /* 🔴 2026-10-19 实机（生存流程第一次做熔炉）：缺的就是"工作台"这一步时旧代码直接放弃，
   * 回「❌ 原料不够：crafting_table：需要 1，背包里有 0」。可 4 块木板徒手就能做一张。
   * 现在：只在"因为缺工作台而失败"时补一张再做，别的时候不多做桌子。 */
  const src = readFileSync(new URL('../extensions/mc_craft.mjs', import.meta.url), 'utf8')
  ok(!/placeTable/.test(src), '源码里已经没有 placeTable（用户 2026-10-19：「把自动放的功能去掉」）')
  ok(/plan = planCraft\(bot, target\.item\.id, want, table\)/.test(src),
    '补完重新规划（否则计划里还是"缺工作台"）')
  ok(/成功也要清合成格/.test(src) && /if \(got > 0\)/.test(src),
    '🔴 成功也要清合成格（2026-10-19 实机：18 根原木"凭空没了"，其实卡在自己背包的 2×2 合成格里）')
  ok(/if \(now2 > before2\) \{ made = now2 - before; continue \}/.test(src),
    '补做抛错时先对账：真涨了就接着补，别把整步停在第一批（要 24 块只做 4 块就不动了）')
}

/* ─────────────── ⑦ 依赖树（tree:true）：合成 + 烧 + 挖三层串起来 ───────────────
 * 来源：2026-10-23 用户「1档和2档做一下」里的一档②（mindcraft 的 ItemNode 思路）。
 * 这里用一套**带掉落表和工具要求**的假注册表，专门测"铁锭到底哪来的"这种跨层问题。
 */
console.log('— ⑦ 依赖树 tree —')
{
  const { goalTree, describeGoalTree, sourceOf } = mod
  const N2 = ['air', 'oak_log', 'oak_planks', 'stick', 'crafting_table',
    'wooden_pickaxe', 'stone_pickaxe', 'iron_pickaxe', 'raw_iron', 'iron_ingot', 'iron_ore',
    'cobblestone', 'stone', 'diamond', 'unobtainium']
  const items2 = {}
  const itemsByName2 = {}
  N2.forEach((n, i) => { const it = { id: i, name: n }; items2[i] = it; itemsByName2[n] = it })
  const iid = (n) => itemsByName2[n].id
  /* 掉落表：铁矿石掉 raw_iron（名字和方块不一样）、石头掉圆石、原木掉自己 */
  const blocksByName2 = {
    oak_log: { id: 2000, name: 'oak_log', drops: [iid('oak_log')] },
    iron_ore: { id: 2001, name: 'iron_ore', drops: [iid('raw_iron')], harvestTools: { [iid('stone_pickaxe')]: true, [iid('iron_pickaxe')]: true } },
    stone: { id: 2002, name: 'stone', drops: [iid('cobblestone')], harvestTools: { [iid('wooden_pickaxe')]: true } },
  }
  const r2 = (out, outCount, requiresTable, ing) => ({
    result: { id: iid(out), count: outCount },
    requiresTable,
    delta: [...ing.map(([n, c]) => ({ id: iid(n), metadata: null, count: -c })), { id: iid(out), metadata: null, count: outCount }],
    ingredients: ing.map(([n]) => iid(n)),
  })
  const R2 = [
    r2('oak_planks', 4, false, [['oak_log', 1]]),
    r2('stick', 4, false, [['oak_planks', 2]]),
    r2('crafting_table', 1, false, [['oak_planks', 4]]),
    r2('wooden_pickaxe', 1, true, [['oak_planks', 3], ['stick', 2]]),
    r2('stone_pickaxe', 1, true, [['cobblestone', 3], ['stick', 2]]),
    r2('iron_pickaxe', 1, true, [['iron_ingot', 3], ['stick', 2]]),
  ]
  const mk2 = (inv = {}) => mkBot(inv, {
    registry: { items: items2, itemsByName: itemsByName2, blocksByName: blocksByName2 },
    recipes: (id, md, table) => R2.filter((r) => r.result.id === id && (!r.requiresTable || table)),
  })

  /* sourceOf：三种来源各认一遍 */
  ok(sourceOf(mk2().bot, 'iron_ingot').kind === 'smelt', 'sourceOf：铁锭 → 烧出来')
  ok(sourceOf(mk2().bot, 'iron_ingot').input === 'raw_iron', 'sourceOf：优先挑 raw_iron（不是矿石方块）')
  ok(sourceOf(mk2().bot, 'raw_iron').kind === 'mine' && sourceOf(mk2().bot, 'raw_iron').block === 'iron_ore',
    'sourceOf：raw_iron 反查掉落表 ⇒ 挖 iron_ore（不靠名字猜）')
  ok(sourceOf(mk2().bot, 'unobtainium').kind === 'other', 'sourceOf：查不到就如实说 other，不编来源')

  /* 整棵树：铁镐 ← 铁锭 ← 烧 raw_iron ← 挖 iron_ore ← 石镐 */
  const t1 = goalTree(mk2().bot, 'iron_pickaxe', 1, { table: true })
  const findNode = (n, nm) => {
    if (!n) return null
    if (n.name === nm) return n
    for (const c of n.children ?? []) { const r = findNode(c, nm); if (r) return r }
    return null
  }
  ok(t1.target === 'iron_pickaxe' && t1.ok === false, 'goalTree：铁镐没材料 ⇒ ok=false')
  ok(t1.tree.kind === 'craft' && t1.tree.times === 1, '根节点是"合成 1 次"')
  const ing = findNode(t1.tree, 'iron_ingot')
  ok(!!ing && ing.kind === 'smelt', '树上铁锭这一枝是"烧"', JSON.stringify(t1.leaves.map((l) => [l.name, l.kind])))
  const raw = ing?.children?.[0]
  ok(raw?.name === 'raw_iron' && raw.kind === 'mine' && raw.block === 'iron_ore', '再往下一层：raw_iron ⇒ 挖 iron_ore')
  ok(raw?.canMine === false, '身上没有石镐 ⇒ 标"挖不动"')
  ok(raw?.children?.[0]?.name === 'stone_pickaxe' && raw?.children?.[0]?.kind === 'craft',
    '挖不动 ⇒ 把"先做一把石镐"排进来（不是一句"查不到来源"）')
  ok(raw?.children?.[0]?.children?.length > 0, '石镐自己也拆到"圆石 + 木棍"这一层')
  const logLeaf = findNode(t1.tree, 'oak_log')
  ok(logLeaf?.kind === 'mine' && logLeaf.canMine === true && !logLeaf.children,
    '原木：能徒手挖 ⇒ 不再往下拆')

  const txt = describeGoalTree(t1)
  ok(/挖 \*\*iron_ore\*\*/.test(txt), '文字版点了名：挖 iron_ore', txt)
  ok(/烧 \*\*raw_iron\*\*/.test(txt) && /mc_furnace/.test(txt), '文字版说清"烧 raw_iron + 用 mc_furnace"')
  ok(/挖得动得先有 .*pickaxe/.test(txt), '文字版标出"挖得动得先有镐子"')
  ok(/合成 \d+ 次/.test(txt), '文字版把"合成几次 ← 什么料"写出来')
  ok(/动手顺序/.test(txt), '文字版给动手顺序（挖 → 烧 → 合成）')

  /* 有石镐 ⇒ 不再往下拆工具 */
  const t2 = goalTree(mk2({ stone_pickaxe: 1 }).bot, 'iron_pickaxe', 1, { table: true })
  const raw2 = findNode(t2.tree, 'raw_iron')
  ok(raw2?.kind === 'mine' && raw2.canMine === true && !raw2.children, '有石镐 ⇒ "挖不动"和"先做镐"都消失')

  /* 材料齐了 ⇒ 直说"直接 mc_craft" */
  const rich = mk2({ iron_ingot: 3, stick: 2, crafting_table: 1 })
  ok(goalTree(rich.bot, 'iron_pickaxe', 1, { table: true }).ok === true, '材料齐 ⇒ ok=true（只剩合成）')
  ok(/材料齐了/.test(describeGoalTree(goalTree(rich.bot, 'iron_pickaxe', 1, { table: true }))), '材料齐 ⇒ 文字版直接给下一步')

  /* 深度上限：不许无限往下钻 */
  const shallow = goalTree(mk2().bot, 'iron_pickaxe', 1, { table: true, maxDepth: 1 })
  ok(shallow.tree.children.length === 2 && shallow.tree.children.every((c) => c.cut === true),
    'maxDepth:1 ⇒ 根下面就只有一层，且都标 cut')
  ok(!findNode(shallow.tree, 'oak_log'), 'maxDepth:1 ⇒ 不往下钻到原木')

  /* execute 里接上了 + 一个合成都不点 */
  const f = mk2()
  const mc = mkMc(f)
  const rt = await run({ tree: true, name: 'iron_pickaxe', count: 2 }, { mc })
  ok(/要拿到 \*\*iron_pickaxe ×2\*\*/.test(rt.text) && /iron_ore/.test(rt.text), 'tree:true 走通、直接给树', rt.text.slice(0, 120))
  ok(Array.isArray(rt.value.leaves) && rt.value.leaves.length > 0, '结果里带结构化 leaves')
  ok(f.calls.length === 0, 'tree:true 一个合成都没点（只出计划）')
  const rtNo = await run({ tree: true }, { mc })
  ok(/得给 `name`/.test(rtNo.text), 'tree:true 缺 name ⇒ 说清楚要什么')

  const src = readFileSync(new URL('../extensions/mc_craft.mjs', import.meta.url), 'utf8')
  ok(/tree: \{ type: 'boolean'/.test(src), '参数表里有 tree')
  ok(/goalTree\(bot, args\.name, args\.count, \{ table: allowTable \}\)/.test(src), 'execute 里接上了 goalTree')
  ok(/from '\.\/mc_furnace\.mjs'/.test(src), '烧炼表复用 mc_furnace（没抄第二份）')
}/* 🔴 2026-11-05 issue #6 ③④：
 *   ③ 需要工作台的合成"一律报缺料" —— 多半是桌子在 5~32 格外（findTableBlock 只看 4 格）；
 *   ④ 做完只报"完成"，数量不够时看不出是缺料还是没做够。 */
{
  const src = readFileSync(new URL('../extensions/mc_craft.mjs', import.meta.url), 'utf8')
  ok(/listTablesNearby\(bot, Math\.max\(8, probeR\), 1\)/.test(src), '需要工作台而身边没有时，先按更大半径找最近的桌子')
  ok(/const mv2 = await mc\.walkTo\(at, \{ arrive: 2\.2/.test(src), '找到了就替模型走过去（和 mc_chest / mc_furnace 同一口径）')
  ok(/plan = planCraft\(bot, target\.item\.id, want, table\)/.test(src), '走到桌子旁边后用这张桌子重新规划（不是只改一行文案）')
  ok(!/placeBlock\(/.test(src), '仍然**不替你放**工作台（用户 2026-10-19 定）')
  ok(/还差 \$\{left\} 个/.test(src), '做出来不够时把差额摊开说：还差几个 + 为什么（缺哪种料 / 还是料够只要再叫一次）')
  ok(/hint = p2\.ok \? '料是够的：再叫一次 mc_craft 接着做/.test(src), '料够而没做够时明确说「再叫一次就行，别改 count」（治 count 不生效的误解）')
}


console.log('')
console.log(`check-mc-craft：pass=${pass} fail=${fail}`)
process.exit(fail ? 1 : 0)

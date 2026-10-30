#!/usr/bin/env node
/**
 * check-core-evidence.mjs —— "报了成功，到底有没有证据"的回归检查（2026-10-08 全工具审计）
 *
 * 用户 2026-10-08 原话：「你全部工具都查一遍，怎么这么多bug」。
 * 这一轮把"工具说成功了、其实什么也没发生"这类**静默错误**逐个挖出来。根因分两类：
 *
 *   A. **底层 API 只是"把包发出去"，服务端不回执**
 *      `mineflayer\lib\plugins\inventory.js:195-258` 的 `activateBlock` / `activateEntity`
 *      内部只有 `await bot.lookAt(...)` + 写一个包 + `swingArm()` —— 包发出去就 resolve。
 *      旧 `useBlock()` 拿到这个 promise 就直接 `return { usedBlock }`，等于"我瞄了一下"报成
 *      "我用成功了"（开门、开箱子、按钮全都没发生也报成功）。
 *   B. **对账时拿"计划"当"结果"**
 *      `build()` 无条件 `ok.push()`（`placeBlock` 回 `placed:false` 也算进去了）；
 *      `equip()` 的 `held` 是装备**前**那个 item 对象；`giveItem()` 的文案不跟 `now` 走；
 *      `dig()` 兜底分支没复核就说"挖掉"；`tossItem()` 直接把"想丢几个"当丢掉了；
 *      `mc_chest` 把 `deposit()`/`withdraw()` resolve 当"搬进去了"。
 *
 * 这个脚本把这些证据要求钉死，防止坑回来。用法：node tools/check-core-evidence.mjs
 */
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'

let pass = 0, fail = 0
const ok = (cond, label, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${label}${extra ? ' — ' + extra : ''}`) } else { fail++; console.log(`  ✗ ${label}${extra ? ' — ' + extra : ''}`) }
}
const section = (t) => console.log(`\n${t}`)

const DSH_HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const PROFILE = join(DSH_HOME, 'profiles', 'desktop')
const req = (() => {
  const bases = [
    new URL('../index.js', import.meta.url).href,
    join(PROFILE, 'node_modules', 'dsh-mc-agent', 'index.js'),
    join(PROFILE, 'index.js'),
  ]
  for (const base of bases) {
    try { const r = createRequire(base); r('mineflayer'); return r } catch {}
  }
  return null
})()
if (!req) {
  console.log('✗ 拿不到 mineflayer —— 请从包目录（<profile>/node_modules/dsh-mc-agent）跑。')
  process.exit(2)
}
const Vec3 = req('vec3')
const { McBot } = await import(new URL('../src/core.mjs', import.meta.url))

const TMP_DIRS = []
const mkMc = (bot) => {
  const dir = mkdtempSync(join(tmpdir(), 'wc-evidence-'))
  TMP_DIRS.push(dir)
  const mc = new McBot({ logFile: join(dir, 'check.log') })
  mc.bot = bot
  mc.mcPlugins = {}
  return mc
}

/** 假方块：名字 + 可变状态（`getProperties()` 要能看到变化） */
const mkBlock = (name, props = {}) => {
  const state = { ...props }
  return {
    name, type: 100, boundingBox: 'block',
    position: new Vec3(1, 64, 0),
    getProperties: () => ({ ...state }),
    _set: (k, v) => { state[k] = v },
  }
}

/** 最小假 bot：`useBlock` / `lookAt` / `chatSay` / `tossItem` 会碰到的字段 */
const mkBot = (o = {}) => {
  const calls = { chat: [], activate: [], activateEntity: [], equip: [], toss: [], control: [] }
  const blocks = new Map()                       // "x,y,z" -> block
  const put = (x, y, z, blk) => { blk.position = new Vec3(x, y, z); blocks.set(`${x},${y},${z}`, blk) }
  for (const [key, blk] of Object.entries(o.blocks ?? {})) {
    const [x, y, z] = key.split(',').map(Number)
    put(x, y, z, blk)
  }
  let inv = { ...(o.inv ?? {}) }                 // 名字 -> 数量
  const invItems = () => Object.entries(inv).filter(([, n]) => n > 0).map(([name, count]) => ({ name, type: 1, count, metadata: null }))
  const bot = {
    username: 'tester',
    entity: { position: new Vec3(0, 64, 0), yaw: 0, pitch: 0, eyeHeight: 1.62 },
    game: { gameMode: 'survival' },
    entities: o.entities ?? {},
    players: o.players ?? {},
    inventory: {
      items: invItems,
      slots: [],
      firstEmptyInventorySlot: () => 10,
    },
    blockAt: (p) => (p && blocks.get(`${p.x},${p.y},${p.z}`)) ?? null,
    findBlocks: () => [],
    on: () => bot,
    removeListener: () => {},
    setControlState: (k, v) => calls.control.push([k, v]),
    chat: (t) => calls.chat.push(t),
    /* 🔴 故意**不提供** `lookAt`：`#aimAt` 就是为了绕开它（真 mineflayer 的 lookAt 在
     *    "站着不动/骑乘/刚死"时会永远挂着 —— physics.js:331-357）。谁回头用了 lookAt，这里当场红。 */
    activateBlock: async (blk) => {
      calls.activate.push(blk.name)
      if (o.onActivateBlock) o.onActivateBlock(bot, blk)
    },
    activateEntity: async (e) => { calls.activateEntity.push(e.name ?? e.id) },
  }
  Object.defineProperty(bot, 'heldItem', { get: () => (o.held ? { name: o.held, type: 1, count: inv[o.held] ?? 1 } : null) })
  /* 公开的 `lookAt()` 走的是 `bot.lookAt(target, true)`（**force=true** ⇒ 立刻返回，不会挂）；
   * 会挂的是 `activateBlock/activateEntity` 内部那次**不带 force** 的 `lookAt`。
   * 所以这里只在 `withLookAt` 时给，好让 ⑥ 那节证明 `#aimAt` 没用它。 */
  if (o.withLookAt) bot.lookAt = async (p) => { calls.lookAt = (calls.lookAt ?? 0) + 1; return p }
  bot.equip = async (item) => { calls.equip.push(item.name); if (o.onEquip) o.onEquip(bot, item); return true }
  bot.toss = async (type, md, n) => { calls.toss.push(n); if (o.onToss) o.onToss(bot, n) }
  /* 背包数字跟着动：`#invSnap` 就是读 `inventory.items()` */
  bot._inv = {
    add: (name, n) => { inv[name] = (inv[name] ?? 0) + n },
    remove: (name, n) => { inv[name] = Math.max(0, (inv[name] ?? 0) - n) },
    get: (name) => inv[name] ?? 0,
  }
  bot._put = put
  bot._calls = calls
  bot.currentWindow = o.window ?? null
  bot._inventoryObj = bot.inventory
  return bot
}

/* ─────────── ① chatSay：不许从公屏绕过指令白名单 ─────────── */
section('① chatSay —— `/` 开头是指令（会绕过 mc_command 的白名单）')
{
  const bot = mkBot()
  const mc = mkMc(bot)
  let threw = null
  try { mc.chatSay('/give @s diamond 64') } catch (e) { threw = e }
  ok(Boolean(threw), '`/…` 直接抛错', String(threw?.message ?? '').slice(0, 60))
  ok(/指令/.test(String(threw?.message ?? '')) && /mc_command/.test(String(threw?.message ?? '')),
    '报错里说清"这是指令、要走 mc_command"')
  ok(bot._calls.chat.length === 0, '一个包都没发出去', `chat=${bot._calls.chat.length}`)
  const sent = mc.chatSay('大家好')
  ok(sent === '大家好' && bot._calls.chat[0] === '大家好', '普通话照旧能说')
  const multi = mc.chatSay('第一行\n第二行')
  ok(multi === '第一行 第二行' && !/\n/.test(multi), '换行会被压成一行（不然服务端会当成多条）')
  ok(mc.chatSay('斜杠在中间 / 不算指令') === '斜杠在中间 / 不算指令', '只有**开头**是 `/` 才算指令')
}

/* ─────────── ② tossItem：按背包数量差对账 ─────────── */
section('② tossItem —— 丢没丢出去按背包数量差说')
{
  const bot = mkBot({ inv: { dirt: 5 }, held: 'dirt', onToss: (b, n) => b._inv.remove('dirt', n) })
  const mc = mkMc(bot)
  const r = await mc.tossItem({ name: 'dirt', count: 2 })
  ok(r.tossed === 'dirtx2', '真丢掉时报 `dirtx2`', JSON.stringify(r))
  ok(!r.note, '真丢掉时**没有** note', JSON.stringify(r))

  const bot2 = mkBot({ inv: { dirt: 5 }, held: 'dirt' })      // toss 不真扣
  const mc2 = mkMc(bot2)
  const r2 = await mc2.tossItem({ name: 'dirt', count: 2 })
  ok(/只少了 0 个/.test(String(r2.note ?? '')), '没真丢出去时如实说"只少了 0 个"', String(r2.note ?? '').slice(0, 60))
}

/* ─────────── ③ useBlock（方块）：容器看窗口、门看状态 ─────────── */
section('③ useBlock（方块）—— 容器看窗口开没开、门看状态翻没翻')
{
  // 容器：窗口真弹出来
  const chest = mkBlock('chest')
  const bot = mkBot({ blocks: { '1,64,0': chest }, onActivateBlock: (b) => { b.currentWindow = { type: 'minecraft:chest', containerItems: () => [1, 2, 3] } } })
  const mc = mkMc(bot)
  const r = await mc.useBlock({ x: 1, y: 64, z: 0 })
  ok(r.opened === 'minecraft:chest' && r.slots === 3, '窗口开了 ⇒ 报 opened + 槽位数', JSON.stringify(r))
  ok(!r.note || !/没法确认|不确定|可能没|未确认/.test(r.note), '成功时不该带"没法确认"的 note', r.note)

  // 容器：窗口没弹（服务端没认）
  const chest2 = mkBlock('chest')
  const bot2 = mkBot({ blocks: { '1,64,0': chest2 } })
  const mc2 = mkMc(bot2)
  const t0 = Date.now()
  const r2 = await mc2.useBlock({ x: 1, y: 64, z: 0 })
  const ms = Date.now() - t0
  ok(r2.opened === false, '窗口没开 ⇒ opened:false', JSON.stringify(r2))
  ok(/没有打开/.test(String(r2.note ?? '')) && /别当成开成功了/.test(String(r2.note ?? '')),
    '如实说"没打开、别当成成功"', String(r2.note ?? '').slice(0, 50))
  ok(ms < 2500, '等待有上限（不是一直挂着）', `${ms}ms`)

  // 门：状态真翻转
  const door = mkBlock('oak_door', { open: false })
  const bot3 = mkBot({ blocks: { '1,64,0': door }, onActivateBlock: (b, blk) => blk._set('open', true) })
  const mc3 = mkMc(bot3)
  const r3 = await mc3.useBlock({ x: 1, y: 64, z: 0 })
  ok(r3.toggled === true && String(r3.changed?.[0] ?? '').includes('open: false → true'),
    '门真开了 ⇒ toggled + 变化明细', JSON.stringify(r3.changed))

  // 门：一点没变
  const door2 = mkBlock('oak_door', { open: false })
  const bot4 = mkBot({ blocks: { '1,64,0': door2 } })
  const mc4 = mkMc(bot4)
  const r4 = await mc4.useBlock({ x: 1, y: 64, z: 0 })
  ok(r4.toggled === false && /一点没变/.test(String(r4.note ?? '')),
    '门没动 ⇒ toggled:false + 如实说', String(r4.note ?? '').slice(0, 40))

  // 其它方块（床/蛋糕…）：只能如实说"包发出去了"
  const cake = mkBlock('cake')
  const bot5 = mkBot({ blocks: { '1,64,0': cake } })
  const mc5 = mkMc(bot5)
  const r5 = await mc5.useBlock({ x: 1, y: 64, z: 0 })
  ok(/不会回执/.test(String(r5.note ?? '')) && /没法确认/.test(String(r5.note ?? '')),
    '其它方块：说清"服务端不会回执、没法确认"', String(r5.note ?? '').slice(0, 40))
}

/* ─────────── ④ useBlock（实体）：中文别名 + 太远如实拒 ─────────── */
section('④ useBlock（实体）—— 中文别名能匹配、太远如实拒')
{
  const near = { id: 7, name: 'zombie', type: 'mob', position: new Vec3(2, 64, 0) }
  const far = { id: 8, name: 'cow', type: 'mob', position: new Vec3(12, 64, 0) }
  const bot = mkBot({ entities: { 7: near, 8: far } })
  const mc = mkMc(bot)
  const r = await mc.useBlock({ who: '僵尸' })
  ok(r.usedEntity === 'zombie', '中文"僵尸"匹配到 zombie', JSON.stringify(r))
  ok(/不会回执/.test(String(r.note ?? '')), '实体交互没有回执 ⇒ 如实说', String(r.note ?? '').slice(0, 40))
  const r2 = await mc.useBlock({ who: 'cow' })
  ok(r2.reached === false && /太远了/.test(String(r2.note ?? '')), '12 格外 ⇒ reached:false', JSON.stringify(r2))
  let threw = null
  try { await mc.useBlock({ who: 'enderman-没有这个' }) } catch (e) { threw = e }
  ok(/附近实际有/.test(String(threw?.message ?? '')), '找不到时列出附近实际有谁', String(threw?.message ?? '').slice(0, 60))
}

/* ─────────── ⑤ lookAt：中文别名（旧版只认 username/name） ─────────── */
section('⑤ lookAt —— 中文别名/displayName 也要认')
{
  const z = { id: 7, name: 'zombie', type: 'mob', position: new Vec3(3, 64, 0) }
  const bot = mkBot({ entities: { 7: z }, withLookAt: true })
  const mc = mkMc(bot)
  const r = await mc.lookAt({ who: '僵尸' })
  ok(r && (r.looked ?? true), '中文"僵尸"能瞄到（旧版会抛"附近找不到"）', JSON.stringify(r).slice(0, 70))
  let threw = null
  try { await mc.lookAt({ who: 'creeper-没有这个' }) } catch (e) { threw = e }
  ok(/附近实际有/.test(String(threw?.message ?? '')), '找不到时列出附近实际有谁')
}

/* ─────────── ⑥ #aimAt：自己写 yaw/pitch，不碰 bot.lookAt ─────────── */
section('⑥ #aimAt —— 自己写 yaw/pitch（真 mineflayer 的 lookAt 会挂住）')
{
  const chest = mkBlock('chest')
  const bot = mkBot({ blocks: { '1,64,0': chest } })
  const mc = mkMc(bot)
  ok(typeof bot.lookAt !== 'function', '假 bot 根本没有 lookAt（用了就当场炸）')
  await mc.useBlock({ x: 1, y: 64, z: 0 })
  ok(bot.entity.yaw !== 0 || bot.entity.pitch !== 0, 'yaw/pitch 被写过了',
    `yaw=${bot.entity.yaw.toFixed(3)} pitch=${bot.entity.pitch.toFixed(3)}`)
  // 站在 (0,64,0) 看 (1.5,64.5,0.5)：dx=1.5 dz=0.5 ⇒ yaw = atan2(-1.5,-0.5) ≈ -1.893
  ok(Math.abs(bot.entity.yaw - (-1.893)) < 0.01, 'yaw 算法和相机基向量一致', bot.entity.yaw.toFixed(3))
}

/* ─────────── ⑦ 静态接线（剥注释后匹配） ─────────── */
section('⑦ 静态接线 —— 这些写法不许回退')
{
  const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  const coreSrc = strip(readFileSync(new URL('../src/core.mjs', import.meta.url), 'utf8'))
  const chestSrc = strip(readFileSync(new URL('../extensions/mc_chest.mjs', import.meta.url), 'utf8'))
  const craftSrc = strip(readFileSync(new URL('../extensions/mc_craft.mjs', import.meta.url), 'utf8'))
// 路线图第 ④ 条第七刀：背包那一层搬到 `src/inventory.mjs`（heldText/invSnap/…）
const invSrc = strip(readFileSync(new URL('../src/inventory.mjs', import.meta.url), 'utf8'))

  // 🔴 2026-10-08 第四刀：matchNameOf / pickEntity 已搬到 src/entity-names.mjs ⇒ 断言改读新文件
  const namesSrc = strip(readFileSync(new URL('../src/entity-names.mjs', import.meta.url), 'utf8'))
  ok(/const matchNameOf = \(e, needle, alias = null\)/.test(namesSrc), '有 matchNameOf()（多字段 + 别名）')
  ok(/const pickEntity = \(list, who\)/.test(namesSrc), '有 pickEntity()')
  ok(/from '\.\/entity-names\.mjs'/.test(coreSrc), 'core.mjs 确实从 entity-names.mjs 导入（别只搬不接）')
  // 🔴 2026-10-08 第八刀：CONTAINER_RE / TOGGLE_RE / canPlaceInto 已搬进 src/block-names.mjs ⇒ 断言改读新文件
  const blockNamesSrc = strip(readFileSync(new URL('../src/block-names.mjs', import.meta.url), 'utf8'))
  ok(/export const CONTAINER_RE = /.test(blockNamesSrc) && /export const TOGGLE_RE = /.test(blockNamesSrc), '有 CONTAINER_RE / TOGGLE_RE（在 block-names.mjs 里）')
  ok(/export const canPlaceInto = \(blk\) =>/.test(blockNamesSrc), '有 canPlaceInto()（在 block-names.mjs 里）')
  ok(/from '\.\/block-names\.mjs'/.test(coreSrc) && /CONTAINER_RE/.test(coreSrc.split('\n').find((l) => l.includes("from './block-names.mjs'")) ?? ''), 'core.mjs 确实从 block-names.mjs 导入这三个名字（别只搬不接）')
  // 🔴 2026-10-08 第十七刀：lookAnglesTo / aimAt / lookAt 搬到 src/camera.mjs ⇒ 断言改读新文件
  const camSrc = strip(readFileSync(new URL('../src/camera.mjs', import.meta.url), 'utf8'))
const chatSrc = strip(readFileSync(new URL('../src/chat.mjs', import.meta.url), 'utf8'))
const useSrc = strip(readFileSync(new URL('../src/world-use.mjs', import.meta.url), 'utf8'))
  ok(/export function aimAt \(b, point\)/.test(camSrc) && /b\.entity\.yaw = yaw/.test(camSrc),
    'aimAt 直接写 yaw/pitch（在 camera.mjs 里）')
  ok(/#aimAt \(b, point\) \{ return aimAt\(b, point\) \}/.test(coreSrc) && /from '\.\/camera\.mjs'/.test(coreSrc),
    'core 有 #aimAt 薄包装、并且确实从 camera.mjs 导入（别只搬不接）')
  /* `bot.lookAt(point, force)`：**force=true** 时 mineflayer 立刻 return（physics.js:352-356）；
   * 不带 force 才会 `await lookingTask.promise` —— 那个 promise 只在物理循环发出 look 包时 finish，
   * 站着不动/骑乘/刚死时物理循环 early return（physics.js:158-162）⇒ 永远挂着。 */
  /* 🔴 2026-10-15 审计：这些 `b.lookAt(...)` 的调用点早就搬到 `src\movement.mjs` /
   *    `src\place.mjs` 了（`core.mjs` 里一处都没有 ⇒ 旧断言 `lookLines.length > 0` 一直红着）。 */
  const lookLines = ['../src/movement.mjs', '../src/place.mjs', '../src/camera.mjs', '../src/world-use.mjs']
    .flatMap((f) => strip(readFileSync(new URL(f, import.meta.url), 'utf8')).split('\n'))
    /* 🔴 2026-10-20 审计：原来没排掉注释行 —— `camera.mjs` 里那句
     *    「不用 `b.lookAt(...)`」的**注释**也被当成调用点，于是这条断言永远红着。
     *    注释里提到函数名是正常的，不该算调用。 */
    .filter((l) => /b\.lookAt\(/.test(l) && !/^\s*(\*|\/\/|\/\*)/.test(l))
  ok(lookLines.length > 0 && lookLines.every((l) => /, true\)/.test(l)),
    'b.lookAt(...) 一律带 force=true（不带会在"站着不动/骑乘/刚死"时挂住）',
    lookLines.map((l) => l.trim().slice(0, 34)).join(' | '))
  /* 路线图第 ④ 条第二十六刀：`chatSay` 已搬进 `src/chat.mjs`（core 只剩薄包装）。 */
  ok(/if \(t\.startsWith\('\/'\)\) \{/.test(chatSrc) && /export function chatSay \(self, text\)/.test(chatSrc),
    'chatSay 拒绝 `/` 开头（实现已搬到 src\\chat.mjs）')
  ok(/chatSay \(text\) \{ return chatSayImpl\(this, text\) \}/.test(coreSrc) && /chatSay as chatSayImpl \} from '\.\/chat\.mjs'/.test(coreSrc),
    'core 有 chatSay 薄包装、并且确实从 chat.mjs 导入（import 取别名）')
  /* 路线图第 ④ 条第十九刀：`tossItem` 已搬进 `src/inventory.mjs`（上面 `invSrc` 就是那个文件）。 */
  ok(/const lost = \(snap\.get\(item\.name\) \?\? 0\) - \(invSnap\(b\)\.get\(item\.name\) \?\? 0\)/.test(invSrc),
    'tossItem 按背包数量差对账（实现已搬到 src\\inventory.mjs）')
  /* 路线图第 ④ 条第三十四刀：`build` 已搬进 `src\build.mjs`（core 只剩薄包装）。 */
  const buildSrc = strip(readFileSync(new URL('../src/build.mjs', import.meta.url), 'utf8'))
  ok(/if \(r\?\.placed\) \{ if \(!used\) used = r\.placed; ok\.push\(at\) \}/.test(buildSrc)
    && /import \{ build as buildImpl \} from '\.\/build\.mjs'/.test(coreSrc)
    && /async build \(opts = \{\}\) \{ return await buildImpl\(this, opts\) \}/.test(coreSrc),
    'build 只算复核过的 placed（实现已搬到 src\\build.mjs，core 有薄包装且确实导入）')
  ok(/if \(!want && cur && !isAir\(cur\)\)/.test(buildSrc), 'build 不给 name 时跳过已占用的格子')
  /* 🔴 2026-10-16（用户 m11195 采纳的 F3）：`mc_build` 缺料时以前会**教 AI 原样重发** ——
   *    hint 写着"再叫一次 mc_build（同一个范围就行）"，AI 照做，一遍遍重发、
   *    每轮撞 5 个失败然后 break，刷一堆调用全白费。光看 failures（"现在那里是 未加载"）读不出是没材料。 */
  ok(/import \{ heldText, countOf \} from '\.\/inventory\.mjs'/.test(buildSrc), 'build 用 countOf 量材料')
  ok(/const bagLeft = want \? countOf\(b, want\) : null/.test(buildSrc), '🔴 build 报 bagLeft（countOf 读不到回 null，正好区分"不知道"和"真没了"）')
  ok(/const outOfMat = Boolean\(want\) && bagLeft === 0 && blockedEmpty > 0/.test(buildSrc), '缺料判据 = 指定了方块 + 背包里 0 个 + 有"空位上放不下去"的失败')
  ok(/outOfMaterial: want, hint:/.test(buildSrc), '🔴 缺料时 hint 换成"别原样重发"（不再是"再叫一次 mc_build"）')
  /* 路线图第 ④ 条第四十刀：`dig` 已搬进 `src\mining.mjs`（core 只剩薄包装）。 */
  const mineSrc = strip(readFileSync(new URL('../src/mining.mjs', import.meta.url), 'utf8'))
  ok(/没挖成/.test(mineSrc)
    && /async dig \(opts = \{\}\) \{ return await digImpl\(this, opts, this\.#mineCtx\(\)\) \}/.test(coreSrc)
    && /from '\.\/mining\.mjs'/.test(coreSrc),
    'dig 兜底分支如实说"没挖成"（实现已搬到 src\\mining.mjs，core 有薄包装且确实导入）')
  /* 路线图第 ④ 条第二十七刀：`equip` 已搬进 `src\world-use.mjs`（core 只剩薄包装）。 */
  /* 🔴 2026-10-15 审计（报告 C 第 1 条）：`equip()` 以前只返回 `held`，"换没换上"看不出来
   *    （`stepOk` 只能拿"字段存在"当成功）⇒ 现在**真的复核**，并如实返回 `equipped`。 */
  ok(/export function heldText \(b\)/.test(invSrc) && /heldText\(b\)/.test(mineSrc)
    && /const got = isHand \? b\.heldItem\?\.name === item\.name : now\?\.name === item\.name/.test(useSrc)
    && /equipped: got,/.test(useSrc),
    'equip 的 held 读回来，并且如实返回 equipped（heldText 在 inventory.mjs，equip 实现在 world-use.mjs）')
  // 路线图第 ④ 条第三十六/三十七刀：`walkTo` / `#walkPathfinder` 已搬进 `src\movement.mjs`。
  const movSrc = strip(readFileSync(new URL('../src/movement.mjs', import.meta.url), 'utf8'))
  ok(/const noProgress = [^\n]*vRose < 0\.75[^\n]*moved < 0\.6/.test(movSrc) && /是真没走通/.test(movSrc)
    && /from '\.\/movement\.mjs'/.test(coreSrc), 'walkTo 一格没挪时如实说（实现已搬到 src\\movement.mjs）')

  ok(/export function chestSnap \(win\)/.test(chestSrc) && /真放进去了/.test(chestSrc),
    'mc_chest 按箱子数量对账（不再拿计划当结果）')
  ok(/_syncWindow\(win\)/.test(craftSrc) && /同步合成窗口/.test(craftSrc),
    'mc_craft 超时后先 _syncWindow 再对账')
}

for (const d of TMP_DIRS) { try { rmSync(d, { recursive: true, force: true }) } catch {} }
console.log(`\n${fail === 0 ? '✓ 全部通过' : '✗ 有失败'}：pass=${pass} fail=${fail}`)
process.exit(fail === 0 ? 0 : 1)

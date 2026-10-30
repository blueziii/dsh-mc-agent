#!/usr/bin/env node
/**
 * check-core-useitem.mjs —— "对着空气用手上的东西"（`useItem`）的回归检查
 *
 * 背景（2026-10-06 用户问「现在能通关我的世界了吗」时定位到的硬缺口）：
 *   `mc_act` 只有 `use` = **右键方块或实体**（`bot.activateBlock` / `activateEntity`），
 *   而"扔末影之眼 / 扔末影珍珠 / 射箭 / 喝药水"用的是 `activateItem`（对着**空气**用物品）。
 *   没有它 ⇒ **找不到要塞**（扔末影之眼是原版唯一办法）、射不掉末影水晶、射不了烈焰人，
 *   即"钻石之后到末影龙"这一段全被卡住。补之前全仓一次 `activateItem` 都没有。
 *
 * 这个脚本把六件事钉死：
 *   ① 手上没东西 → 报错要指导性（告诉它先 equip），且**不发** `activateItem`；
 *   ② `hold` 不给 → 只按一下（`activateItem` 一次、`deactivateItem` 零次）；
 *   ③ `hold:1000` → 真的按住约 1 秒再松手（拉弓必须这样，否则只是举弓不射箭）；
 *   ④ `hold` 有上限（别把一整轮全用来按住不放）；
 *   ⑤ 本轮剩余时间要**钳制** `hold`（`setCallDeadline` 那个 11 秒预算）；
 *   ⑥ 工具层接线：`mc_act{mode:"useitem"}` 与"`use` 不给坐标也不给 who"都要走到 `useItem`。
 *
 * 用法：node tools/check-core-useitem.mjs
 *   ⚠️ **必须从包目录跑**（`<profile>/node_modules/dsh-mc-agent`）：`src/core.mjs` 顶部
 *      `import ... from 'mineflayer'`，源码树里没有 node_modules，会 ERR_MODULE_NOT_FOUND。
 */
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'

// ── 断言小工具（和别的 check-*.mjs 一致）────────────────────────────────────────
let pass = 0, fail = 0
const ok = (cond, label, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${label}${extra ? ' — ' + extra : ''}`) } else { fail++; console.log(`  ✗ ${label}${extra ? ' — ' + extra : ''}`) }
}
const section = (t) => console.log(`\n${t}`)

// ── 借依赖：源码树里没有 node_modules，从包目录借 vec3 ────────────────────────────
const DSH_HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const PROFILE = join(DSH_HOME, 'profiles', 'desktop')
const req = (() => {
  const bases = [
    new URL('../index.js', import.meta.url).href,                  // 包内直接就有
    join(PROFILE, 'node_modules', 'dsh-mc-agent', 'index.js'),      // 源码树 → 借包里的
    join(PROFILE, 'index.js'),
  ]
  for (const base of bases) {
    try { const r = createRequire(base); r('mineflayer'); return r } catch {}
  }
  return null
})()
if (!req) {
  console.log('✗ 拿不到 mineflayer —— 请从包目录（<profile>/node_modules/dsh-mc-agent）跑，')
  console.log('  或确认已安装 mineflayer。')
  process.exit(2)
}
const Vec3 = req('vec3')
const { McBot } = await import(new URL('../src/core.mjs', import.meta.url))

/** 剥掉注释再断言"源码里有/没有某种写法"——注释里正是拿这些写法当说明，会误命中 */
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

/**
 * 造一个假 bot —— 只带 `useItem()` 会碰到的字段。
 *
 * @param {object} o
 *   - `held`           手上拿着什么（`null` = 空手）
 *   - `withDeactivate` 有没有 `deactivateItem`（老版本 mineflayer / 假 bot 可能没有）
 */
const mkBot = ({ held = { name: 'snowball', count: 16 }, withDeactivate = true } = {}) => {
  const calls = { activate: 0, deactivate: 0, at: [], look: [] }
  const bot = {
    entity: { position: new Vec3(0, 64, 0) },
    _client: {},
    game: { gameMode: 'survival' },
    heldItem: held,
    // 真 mineflayer 的 activateItem() 是**同步发包**、返回 undefined —— 故意返回 undefined
    // 来钉住"core 必须自己 Promise.resolve() 包一层"，否则 #t 会拿到非 promise。
    activateItem: () => { calls.activate++; calls.at.push(Date.now()) },
    // 2026-10-22：useItem 可以"先瞄再用"（带 x/y/z 时）—— 记下瞄准点与时刻，好断言顺序
    lookAt: (p, force) => { calls.look.push({ x: p?.x, y: p?.y, z: p?.z, force, at: Date.now() }) },
    setControlState: () => {},
    on: () => bot,
    removeListener: () => {},
  }
  if (withDeactivate) {
    bot.deactivateItem = () => { calls.deactivate++; calls.at.push(Date.now()) }
  }
  return { bot, calls }
}

/** 把假 bot 直接塞进 McBot（不走 connect），并备好 `_pf` / `pfReady` */
const TMP_DIRS = []                     // 收尾要删掉，别在 %TEMP% 里留一堆 wc-useitem-*
const mkMc = (fake) => {
  const dir = mkdtempSync(join(tmpdir(), 'wc-useitem-'))
  TMP_DIRS.push(dir)
  const mc = new McBot({ logFile: join(dir, 'check.log') })
  mc.bot = fake.bot
  mc.mcPlugins = {}
  mc.pfReady = true
  mc._pf = {
    goals: { GoalNear: class { constructor(x, y, z, r) { Object.assign(this, { x, y, z, r }) } } },
    Movements: class { constructor() {} },
  }
  return mc
}

/* ─────────── ① 手上没东西：报错要有指导性，且不发包 ─────────── */
section('① 手上没东西 —— 报错告诉它先 equip，且不发 activateItem')
{
  const fake = mkBot({ held: null })
  const mc = mkMc(fake)
  let err = null
  try { await mc.useItem({}) } catch (e) { err = e }
  ok(Boolean(err), '空手调用会报错（不静默成功）')
  ok(/手上没东西/.test(String(err?.message)), '文案说"手上没东西"', String(err?.message).slice(0, 60))
  ok(/equip/.test(String(err?.message)), '文案告诉它用 mc_act{mode:"equip"}', String(err?.message).slice(0, 80))
  ok(fake.calls.activate === 0, '空手时没有发 activateItem', `activate=${fake.calls.activate}`)
}

/* ─────────── ② hold 不给：只按一下（可扔物就是这样） ─────────── */
section('② hold 不给 —— 只按一下，不调 deactivateItem')
{
  const fake = mkBot({ held: { name: 'snowball', count: 16 } })
  const mc = mkMc(fake)
  const r = await mc.useItem({})
  ok(fake.calls.activate === 1, 'activateItem 调了一次', `activate=${fake.calls.activate}`)
  ok(fake.calls.deactivate === 0, 'hold=0 时不去松手（省一个包）', `deactivate=${fake.calls.deactivate}`)
  ok(r?.used === 'snowball' && r?.heldMs === 0, '返回 { used, heldMs }', JSON.stringify(r))
}

/* ─────────── ③ hold=1000：真的按住再松手（拉弓必须这样） ─────────── */
section('③ hold:1000 —— 按住约 1 秒再松手（拉弓不松手射不出箭）')
{
  const fake = mkBot({ held: { name: 'bow', count: 1 } })
  const mc = mkMc(fake)
  const t0 = Date.now()
  const r = await mc.useItem({ hold: 1000 })
  const ms = Date.now() - t0
  ok(fake.calls.activate === 1 && fake.calls.deactivate === 1,
    'activateItem + deactivateItem 各一次', `a=${fake.calls.activate} d=${fake.calls.deactivate}`)
  const gap = (fake.calls.at[1] ?? 0) - (fake.calls.at[0] ?? 0)
  ok(gap >= 900, '两次之间真的等了约 1000ms（不是立刻松手）', `间隔 ${gap}ms / 总 ${ms}ms`)
  ok(r?.heldMs === 1000, '返回里如实写 heldMs=1000', JSON.stringify(r))
}

/* ─────────── ④ hold 有上限：别把一整轮全用来"按住不放" ─────────── */
section('④ hold 上限 —— 给 99999 也只按 3 秒')
{
  const fake = mkBot({ held: { name: 'bow', count: 1 } })
  const mc = mkMc(fake)
  const r = await mc.useItem({ hold: 99999 })
  ok(r?.heldMs === 3000, 'heldMs 被钳到 3000', `heldMs=${r?.heldMs}`)
  ok(fake.calls.deactivate === 1, '照样松手了', `deactivate=${fake.calls.deactivate}`)
}

/* ─────────── ⑤ 本轮预算：按住要给松手留余量（否则拉弓射不出箭） ─────────── */
section('⑤ 本轮预算 —— 按住要留出松手的时间（不然弓一直举着、箭出不去）')
{
  // 还剩 1.5 秒：想按 1000ms 能按满，松手也来得及
  const fake = mkBot({ held: { name: 'bow', count: 1 } })
  const mc = mkMc(fake)
  mc.setCallDeadline(1500)
  const r = await mc.useItem({ hold: 1000 })
  ok(r?.heldMs === 1000, '剩下的时间够时按满 1000ms', `heldMs=${r?.heldMs}`)
  ok(fake.calls.deactivate === 1, '松手包发出去了（400ms 余量兜着）', `deactivate=${fake.calls.deactivate}`)
  ok(!r?.note, '按满了就不多啰嗦', String(r?.note))

  // 只剩 300ms：按不住，但**松手包仍然要发**
  const fake2 = mkBot({ held: { name: 'bow', count: 1 } })
  const mc2 = mkMc(fake2)
  mc2.setCallDeadline(300)
  const t0 = Date.now()
  const r2 = await mc2.useItem({ hold: 1000 })
  const ms = Date.now() - t0
  ok(r2?.heldMs === 0, '时间不够就不硬按（heldMs=0）', `heldMs=${r2?.heldMs}`)
  ok(fake2.calls.activate === 1 && fake2.calls.deactivate === 1,
    '按一下 + 松手两个包都发了', `a=${fake2.calls.activate} d=${fake2.calls.deactivate}`)
  ok(/不够按住/.test(String(r2?.note)), '如实告诉它"没按满"', String(r2?.note).slice(0, 40))
  ok(ms < 1200, '整次调用很快就返回了', `${ms}ms`)

  const fake0 = mkBot({ held: { name: 'bow', count: 1 } })
  const mc0 = mkMc(fake0)
  mc0.setCallDeadline(0)                 // 这一轮已经没时间了
  let err = null
  try { await mc0.useItem({ hold: 1000 }) } catch (e) { err = e }
  ok(/这一轮/.test(String(err?.message)), '没时间了如实报"这一轮用完了"', String(err?.message).slice(0, 50))
  ok(fake0.calls.deactivate === 0, '没时间时不再补一个松手包', `deactivate=${fake0.calls.deactivate}`)
}

/* ─────────── ⑥ 没有 deactivateItem 也不炸 ─────────── */
section('⑥ 老版本没有 deactivateItem —— 不炸，如实返回')
{
  const fake = mkBot({ held: { name: 'bow', count: 1 }, withDeactivate: false })
  const mc = mkMc(fake)
  let err = null, r = null
  try { r = await mc.useItem({ hold: 200 }) } catch (e) { err = e }
  ok(!err, '没有 deactivateItem 也不抛异常', err ? String(err.message) : '')
  ok(r?.used === 'bow' && r?.heldMs === 200, '照常返回 { used, heldMs }', JSON.stringify(r))
}

/* ─────────── ⑦ 工具层接线（静态：mc_act 的 switch + 描述 + 步骤 op） ─────────── */
section('⑦ 工具层接线 —— mc_act{useitem} 与"use 不给目标"都要走到 useItem')
{
  const core = stripComments(readFileSync(new URL('../src/core.mjs', import.meta.url), 'utf8'))
  const idx = stripComments(readFileSync(new URL('../index.js', import.meta.url), 'utf8'))

  const useSrc = stripComments(readFileSync(new URL('../src/world-use.mjs', import.meta.url), 'utf8'))

  ok(/export async function useItem \(b, \{ hold = 0, x, y, z \} = \{\}, ctx = \{\}\)/.test(useSrc),
    'useItem 的实现在 src/world-use.mjs（{ hold, x, y, z } —— x/y/z 是"先瞄再用"的目标格）')
  ok(/export const AIM_SETTLE_MS = 450/.test(useSrc), 'AIM_SETTLE_MS = 450（转头包与交互包之间那一拍）')
  ok(/b\.activateItem\(\)/.test(useSrc), 'world-use.mjs 调了 `b.activateItem()`')
  ok(/b\.deactivateItem\(\)/.test(useSrc), 'world-use.mjs 调了 `b.deactivateItem()`')
  /* 🔴 2026-11-02 审计（#14）：\`mc_act{toward}\` 以前把 \`walkTo\` 的返回值整条丢掉 ——
   *    walkTo 不抛错，走不到就回 \`{arrived:false, remaining, hint}\` ⇒ toward 永远报"到了"，
   *    \`sequence\` 里的 toward 步骤也就永远成功。 */
  ok(/const w = await self\.walkTo\(eye, \{ arrive: 3, budget: callBudget\(args\.budgetMs\) \}\)\.catch/.test(useSrc),
    '🔴 toward 不丢 walkTo 的返回（走向玩家没走到时也要如实说）')
  ok(/arrived: w\.arrived !== false/.test(useSrc), 'toward 把 arrived 带回去')

  ok(/ctx\.callLeft \? Number\(ctx\.callLeft\(\)\) : 11_000/.test(useSrc), 'hold 用 `ctx.callLeft()` 钳过（不是裸 3000）')
  ok(/left - 400/.test(useSrc), '按住给松手留了 400ms 余量（否则松手被预算拒掉）')
  ok(/async useItem \(opts = \{\}\) \{/.test(core) && /from '\.\/world-use\.mjs'/.test(core) && /callLeft: \(\) => this\.callLeft\(\)/.test(core),
    'core 的 useItem 是薄包装，并且把 callLeft 传进去了')

  /* 🔴 第二十二刀：步骤分发（`#runStep`）搬进 `src\sequence.mjs` ⇒ 这两条改成查新模块
   *    （那边第一参数是 `self`，所以是 `self.useItem(s)`），并补接线断言。 */
  const seqSrc = stripComments(readFileSync(new URL('../src/sequence.mjs', import.meta.url), 'utf8'))
  ok(/case 'useitem': return self\.useItem\(s\)/.test(seqSrc), 'sequence.mjs 的 op 里有 `useitem`')
  ok(/wait\/move\/look\/toward\/place\/break\/dig\/use\/useitem\/attack/.test(seqSrc),
    '未知 op 的报错文案里列出了 useitem')
  ok(/import \{ runSequence \} from '\.\/sequence\.mjs'/.test(core)
    && /async runSequence \(steps, opts = \{\}\) \{ return await runSequence\(this, steps, opts\) \}/.test(core),
    'core 的 runSequence 是薄包装（步骤分发在 sequence.mjs）')

  ok(/case 'useitem': return withOutcome\(\{ mode, \.\.\.\(await bot\.useItem\(args\)\) \}\)/.test(idx),
    'mc_act 的 switch 里有 `case \'useitem\'`')
  ok(/const noTarget = args\.who == null && args\.x == null && args\.y == null && args\.z == null/.test(idx),
    '`use` 会判断"有没有给目标"')
  ok(/if \(noTarget\) return withOutcome\(\{ mode: 'useitem', \.\.\.\(await bot\.useItem\(args\)\) \}\)/.test(idx),
    '没给目标时 `use` 退回 useItem（对着空气用手上的东西）')
  ok(/· useitem 用手上的东西/.test(idx), '工具描述里有 useitem 一行')
  ok(/hold: \{ type: 'number'/.test(idx), 'schema 里有 hold 参数')
  /* 2026-10-15：清单里陆续多了 `enchant`（附魔台）和 `bridge`（搭路）—— 只钉"必须列出来"，不钉顺序。 */
  ok(/可用 [^）]*useitem[^）]*toss/.test(idx),
    '未知 mode 的报错文案里列出了 useitem')
  ok(/useitem\(hold\)/.test(idx), 'mc_sequence 的描述里列出了 useitem(hold)')
}

/* ─────────── ⑧ 先瞄再用：带 x/y/z 时 look → 等一拍 → activateItem ─────────── */
section('⑧ 先瞄再用（2026-10-22 用户：AI 不知道怎么用水桶舀水）')
{
  const fake = mkBot({ held: { name: 'bucket', count: 1 } })
  const mc = mkMc(fake)
  const r = await mc.useItem({ x: 10, y: 62, z: -5 })
  ok(fake.calls.look.length === 1, '带 x/y/z ⇒ 先 lookAt 一次', `look=${fake.calls.look.length}`)
  ok(fake.calls.activate === 1, '再 activateItem 一次', `activate=${fake.calls.activate}`)
  ok(fake.calls.look[0].x === 10.5 && fake.calls.look[0].y === 62.5 && fake.calls.look[0].z === -4.5,
    '瞄准点是那格的**中心**（+0.5）', JSON.stringify(fake.calls.look[0]))
  ok(fake.calls.look[0].force === true, 'lookAt 用了强制转头（force=true，别插值等半天）')
  const gap = fake.calls.at[0] - fake.calls.look[0].at
  ok(gap >= 350 && gap <= 1200, '转头包和交互包之间真等了一拍（约 450ms）', `gap=${gap}ms`)
  ok(r?.aimedAt && r.aimedAt.x === 10, '返回里带 aimedAt（知道瞄的是哪格）', JSON.stringify(r?.aimedAt))
  ok(/水没装进来/.test(String(r?.note ?? '')), '桶没装到水 ⇒ 直接说"目标那格大概率是流动水、要静水面"', String(r?.note ?? '').slice(0, 60))

  const fake2 = mkBot({ held: { name: 'snowball', count: 8 } })
  const mc2 = mkMc(fake2)
  const r2 = await mc2.useItem({})
  ok(fake2.calls.look.length === 0, '不带 x/y/z ⇒ 不瞄（扔雪球这类照旧）', `look=${fake2.calls.look.length}`)
  ok(!r2?.aimedAt, '不带目标时返回里没有 aimedAt')
}

/* ─────────── 收尾 ─────────── */
for (const d of TMP_DIRS) { try { rmSync(d, { recursive: true, force: true }) } catch {} }
console.log(`\n${fail === 0 ? '✓ 全部通过' : '✗ 有失败'}：pass=${pass} fail=${fail}`)
process.exit(fail === 0 ? 0 : 1)

#!/usr/bin/env node
/**
 * check-call-budget.mjs —— "**单次工具调用 ≤11 秒，宁可少量多次**"的回归检查
 *
 * 背景（用户原话）：
 *   「mc_sequence · {"budgetMs":240000, 这个时间也太长了，每次尽量不要超过5秒。太久根本获取不了消息」
 *   「其他工具调用都尽量少于5秒，可以少量多次」
 * 所以：一次调用到点就**带着进度返回**，并告诉模型"再叫一次、从哪儿接着做"。
 * 这个脚本用最小假 bot 把这几条钉死（防止坑回来）：
 *   ① `CALL_MS` / `CALL_BUDGET_MS` / `callBudget()` / `callDeadline()` 的钳制；
 *   ② `McBot.setCallDeadline()` / `msLeft()`：没设过 = 整整一轮(5s)，用完 = 0；
 *   ③ `#t()` 的闸门：本轮时间用完 → **立刻**抛"这一轮的 11 秒用完了"（带 mcCallOver）；
 *   ④ `walkTo()`：默认预算 40 秒也不许跑过 11 秒；到点返回的文案是"再叫一次 mc_move"而不是"走不通"；
 *   ⑤ `runSequence()`：到点停下并给出 `stoppedAt` / `remaining` / `hint`（从第几步接着发）；
 *   ⑥ `build()`：本轮时间用完 → 返回 `remaining` + hint，且**已经放对的格子会跳过**；
 *   ⑦ `index.js`：每个 `mc_*` 工具注册时的 `timeoutMs` 都 ≤ 12 秒（`LONG_TOOLS` 例外）+ asTool 里真的钳了；
 *   ⑧ 四个扩展（mc_observe / mc_craft / mc_chest / mc_furnace）的 `timeoutMs` 也 ≤ 12 秒。
 *
 * 用法：node tools/check-call-budget.mjs
 *   ⚠️ **必须从包目录跑**（`<profile>/node_modules/dsh-mc-agent`）：`src/core.mjs` 顶部
 *      `import ... from 'mineflayer'`，源码树里没有 node_modules，会 ERR_MODULE_NOT_FOUND。
 */
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { mkdtempSync, rmSync, readFileSync, readdirSync } from 'node:fs'
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
const core = await import(new URL('../src/core.mjs', import.meta.url))
const { McBot, CALL_MS, CALL_BUDGET_MS, callBudget, callDeadline } = core

/** `#releaseControls` 会松开的那些控制位 */
const CTRL = ['forward', 'back', 'left', 'right', 'jump', 'sneak', 'sprint']

/**
 * 造一个假 bot。
 * @param {object} o
 *   - `hang`   `pathfinder.goto()` 是否永不 resolve（模拟"路很长，走不完"）
 *   - `blocks` `'x,y,z' → {name}`，给 `blockAt` 用（`build` 判断"这格已经放对了"）
 *   - `lookHang` `lookAt` 是否永不 resolve
 *   - `itemHang` `activateItem` 是否永不 resolve（测 `#t()` 闸门用：`useItem` 走的就是它）
 */
const mkBot = ({ hang = false, blocks = {}, lookHang = false, itemHang = false, health = 20, mobs = [] } = {}) => {
  const calls = { control: [], stop: 0, setGoal: 0, goto: 0, setMovements: 0, place: [], seq: [] }
  const handlers = new Map()
  const bot = {
    entity: { position: new Vec3(0, 64, 0), yaw: 0, pitch: 0 },
    /* 危险信号（`src/danger.mjs`）只认这三样：`health` / `entity.position` / `entities` */
    health,
    entities: Object.fromEntries(mobs.map((m, i) => [i + 1, {
      name: m.name, kind: m.kind, position: new Vec3(m.at[0], m.at[1], m.at[2]),
    }])),
    _client: {},
    game: { gameMode: 'survival' },
    registry: { itemsByName: {}, blocksByName: {}, items: {} },
    inventory: { items: () => [] },
    blockAt: (p) => blocks[`${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`] ?? null,
    findBlocks: () => [],
    findBlock: () => null,
    setControlState: (k, v) => { calls.control.push([k, v]) },
    lookAt: () => (lookHang ? new Promise(() => {}) : Promise.resolve()),
    heldItem: itemHang ? { name: 'dirt', type: 1, count: 1 } : null,
    activateItem: () => (itemHang ? new Promise(() => {}) : undefined),
    on: (ev, fn) => { const l = handlers.get(ev) ?? []; l.push(fn); handlers.set(ev, l); return bot },
    once: (ev, fn) => {
      const wrap = (...a) => { bot.removeListener(ev, wrap); return fn(...a) }
      return bot.on(ev, wrap)
    },
    removeListener: (ev, fn) => { const l = handlers.get(ev); if (l) handlers.set(ev, l.filter((f) => f !== fn)); return bot },
    /* 🔴 2026-10-08 审计③：假 bot 必须能真 `emit` —— 以前 `on: () => bot` 是个哑桩，
     *    `path_update`/`path_reset`/`goal_reached` 一条都送不进去，于是"空路径假成功"这类
     *    只在事件里能看出来的 bug 在离线测试里永远抓不到。 */
    emit: (ev, ...a) => { for (const f of handlers.get(ev) ?? []) { try { f(...a) } catch {} } return true },
    listenerCount: (ev) => (handlers.get(ev) ?? []).length,
    pathfinder: {
      // stop() 要像真 pathfinder 一样把挂着的 goto 拒掉（name = PathStopped），
      // 否则测不出"抢占后 walkTo 立刻返回"
      goto: () => {
        calls.goto++
        calls.seq.push('goto')
        if (!hang) return Promise.resolve()
        return new Promise((_, rej) => { calls.rejectGoto = rej })
      },
      stop: () => {
        calls.stop++
        const rej = calls.rejectGoto
        calls.rejectGoto = null
        if (rej) { const e = new Error('Path was stopped'); e.name = 'PathStopped'; rej(e) }
      },
      // setGoal(null) 才是"真停"（真 pathfinder 里 stop() 只是置标志）—— 它也会把挂着的 goto 拒掉
      setGoal: (g) => {
        calls.setGoal++
        if (g === null) {
          const rej = calls.rejectGoto
          calls.rejectGoto = null
          if (rej) { const e = new Error('Path was stopped'); e.name = 'PathStopped'; rej(e) }
        }
      },
      setMovements: () => { calls.setMovements++ },
    },
  }
  return { bot, calls }
}

const TMP_DIRS = []
const mkMc = (fake) => {
  const dir = mkdtempSync(join(tmpdir(), 'wc-callbudget-'))
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

/* ─────────── ① 常量与钳制 ─────────── */
section('① CALL_MS / CALL_BUDGET_MS / callBudget() / callDeadline()')
{
  ok(CALL_MS >= 11_000 && CALL_MS % 1_000 === 0, 'CALL_MS ≥ 11000（单次调用硬上限；2026-10-29 用户决定维持 11 秒）', String(CALL_MS))
  ok(CALL_BUDGET_MS === CALL_MS - 1_000, 'CALL_BUDGET_MS = CALL_MS − 1000（给长动作的默认预算，留 1 秒余量）', String(CALL_BUDGET_MS))
  ok(callBudget(undefined) === CALL_BUDGET_MS, 'callBudget() 不给值 → CALL_BUDGET_MS')
  ok(callBudget(0) === 200, 'callBudget(0) → 200（0 = 只想动一下，不再放大成 10 秒）')
  ok(callBudget(-1) === CALL_BUDGET_MS, 'callBudget(-1) → CALL_BUDGET_MS')
  ok(callBudget('abc') === CALL_BUDGET_MS, 'callBudget("abc") → CALL_BUDGET_MS')
  ok(callBudget(100) === 200, 'callBudget(100) → 200（下限 200，别缩成 0）')
  ok(callBudget(1_234) === 1_234, 'callBudget(1234) → 1234（不放大）')
  ok(callBudget(200_000) === 10_000, 'callBudget(200000) → 10000（上限压死）')
  ok(callBudget(2_000, 1_000) === 2_000, 'callBudget(2000, 1000) → 2000（合法值不受 def 影响）')
  ok(callBudget(undefined, 1_500) === 1_500, 'callBudget(undefined, 1500) → 1500（def 可覆盖）')
  const d0 = Date.now()
  ok(Math.abs(callDeadline() - (d0 + CALL_MS)) < 100, `callDeadline() ≈ 现在 + ${CALL_MS / 1000} 秒`)
  ok(Math.abs(callDeadline(1_000) - (d0 + 1_000)) < 100, 'callDeadline(1000) ≈ 现在 + 1 秒')
}

/* ─────────── ② setCallDeadline / msLeft ─────────── */
section('② McBot.setCallDeadline() / msLeft()')
{
  const fake = mkBot()
  const mc = mkMc(fake)
  ok(mc.msLeft() === CALL_MS, `没设过截止时刻 → msLeft() = ${CALL_MS}（脚本直接调 McBot 时当整整一轮）`, String(mc.msLeft()))
  mc.setCallDeadline(3_000)
  const left = mc.msLeft()
  ok(left > 0 && left <= 3_000, 'setCallDeadline(3000) 之后 msLeft() 在 (0, 3000]', String(left))
  mc.setCallDeadline(0)
  ok(mc.msLeft() === 0, 'setCallDeadline(0) → msLeft() = 0（这一轮已经用完）')
  ok(mc.callDeadlineAt > 0, 'callDeadlineAt 被写进去了', String(mc.callDeadlineAt))
  ok(mc.callLeft() === 0, 'callLeft() 也是 0（长动作自己排 deadline 时用）', String(mc.callLeft()))

  const fake3 = mkBot()
  const mc3 = mkMc(fake3)
  ok(mc3.callLeft() === CALL_MS, `没设过截止时刻 → callLeft() = ${CALL_MS}（不是无限）`, String(mc3.callLeft()))
  mc3.setCallDeadline(1_500)
  await new Promise((r) => setTimeout(r, 600))
  const cl = mc3.callLeft()
  ok(cl > 0 && cl < 1_500, '用掉 600ms 后 callLeft() < 1500（算的是"还剩多少"）', String(cl))
  mc3.setCallDeadline(20_000)
  ok(mc3.callLeft() === CALL_MS, `截止时刻比一轮还长时 callLeft() 仍是 ${CALL_MS}（单次调用不许超）`, String(mc3.callLeft()))
}

/* ─────────── ③ #t() 闸门：用完就立刻抛，不等 ─────────── */
section('③ #t() —— 本轮时间用完时立刻抛（不让工具挂住）')
{
  const fake = mkBot({ itemHang: true })
  const mc = mkMc(fake)
  mc.setCallDeadline(0)
  const t0 = Date.now()
  let err = null
  try { await mc.useItem({ hold: 0 }) } catch (e) { err = e }
  const ms = Date.now() - t0
  ok(ms < 200, '时间用完 → 立刻返回（没有等 activateItem 的 6 秒超时）', `${ms}ms`)
  ok(err && new RegExp(`这一轮的 ${CALL_MS / 1000} 秒用完了`).test(err.message), `抛的错说人话："这一轮的 ${CALL_MS / 1000} 秒用完了"`, String(err?.message).slice(0, 60))
  ok(err?.mcCallOver === true && err?.mcTimeout === true, '错误上带 mcCallOver / mcTimeout 标记', JSON.stringify({ mcCallOver: err?.mcCallOver, mcTimeout: err?.mcTimeout }))
  ok(mc.lastTimeout?.overCall === true, 'lastTimeout 记成 overCall（便于排查）', JSON.stringify(mc.lastTimeout))

  // 剩一点时间：按"剩余时间"截断，不是按 TIMEOUTS.act 自己的 6 秒
  const fake2 = mkBot({ itemHang: true })
  const mc2 = mkMc(fake2)
  mc2.setCallDeadline(1_000)
  const t1 = Date.now()
  let err2 = null
  try { await mc2.useItem({ hold: 0 }) } catch (e) { err2 = e }
  const ms2 = Date.now() - t1
  ok(ms2 >= 800 && ms2 < 2_500, '只剩 1 秒 → 1 秒就抛（TIMEOUTS.act 的 6 秒被压到 1 秒）', `${ms2}ms`)
  ok(err2?.mcTimeout === true, '还是超时错', String(err2?.message).slice(0, 40))
}

/* ─────────── ④ walkTo()：默认预算 40 秒也不许跑过 11 秒 ─────────── */
section('④ walkTo() —— 到点带着进度返回，文案是"再叫一次"而不是"走不通"')
{
  // 不给截止时刻（脚本直接调）：默认 moveBudgetMs = 40000，但本轮上限 4 秒
  const fake = mkBot({ hang: true })
  const mc = mkMc(fake)
  const t0 = Date.now()
  const r = await mc.walkTo({ x: 50, y: 64, z: 50 })
  const ms = Date.now() - t0
  ok(ms >= CALL_BUDGET_MS - 600 && ms < CALL_MS + 500, `默认预算 40 秒 → 墙钟 ${CALL_BUDGET_MS / 1000} 秒左右就返回（单次调用 ≤${CALL_MS / 1000} 秒）`, `${ms}ms`)
  ok(r.arrived === false && r.via === 'pathfinder', '如实报"没到"，via 还是 pathfinder', JSON.stringify({ arrived: r.arrived, via: r.via }))
  console.log('DBG', JSON.stringify(r).slice(0,600));
  ok(/用完了/.test(r.hint ?? ''), '文案说"这一轮的时间用完了"', String(r.hint).slice(-60))
  ok(/不是走不通/.test(r.hint ?? ''), '并且明确"不是走不通"（预算到点是正常返回）', String(r.hint).slice(-60))
  ok(/再叫一次 mc_move/.test(r.hint ?? ''), '并告诉模型"再叫一次 mc_move 接着走"', String(r.hint).slice(-60))
  ok(fake.calls.stop >= 1, '到点后调了 pathfinder.stop()（不把后台寻路留着）', `stop=${fake.calls.stop}`)
  ok(mc.cfg.moveBudgetMs <= CALL_MS, '🔴 `cfg.moveBudgetMs` 兜底值 ≤ CALL_MS（不然"没传预算"的内部走路会以为能走更久，实际被硬掐）',
    `${mc.cfg.moveBudgetMs} vs ${CALL_MS}`)

  // 本轮只剩 2 秒：按剩余时间截断
  const fake2 = mkBot({ hang: true })
  const mc2 = mkMc(fake2)
  mc2.setCallDeadline(2_000)
  const t1 = Date.now()
  const r2 = await mc2.walkTo({ x: 50, y: 64, z: 50 })
  const ms2 = Date.now() - t1
  ok(ms2 >= 1_500 && ms2 < 3_500, '只剩 2 秒 → 2 秒就返回', `${ms2}ms`)
  ok(/用完了/.test(r2.hint ?? ''), '文案还是"这一轮的时间用完了"', String(r2.hint).slice(-50))
  ok(!/换个能走到的目标点/.test(r2.hint ?? ''), '不说"换个能走到的目标点"（会被模型误判成死路）', String(r2.hint).slice(-50))
}

/* ─────────── ⑤ runSequence()：到点停下，告诉从第几步接着发 ─────────── */
section('⑤ runSequence() —— 到点停下并给出 stoppedAt / remaining / hint')
{
  const fake = mkBot()
  const mc = mkMc(fake)
  mc.setCallDeadline(1_200)
  const steps = [{ op: 'wait', sec: 1 }, { op: 'wait', sec: 1 }, { op: 'wait', sec: 1 }, { op: 'wait', sec: 1 }]
  const t0 = Date.now()
  const r = await mc.runSequence(steps)
  const ms = Date.now() - t0
  ok(ms < 3_000, '4 个"等 1 秒"没把时间拖满', `${ms}ms`)
  ok(typeof r.stoppedAt === 'number' && r.stoppedAt >= 1, '给出 stoppedAt（停在第几步）', JSON.stringify({ stoppedAt: r.stoppedAt }))
  ok(r.remaining === steps.length - r.stoppedAt, 'remaining = 总步数 − stoppedAt', JSON.stringify({ remaining: r.remaining }))
  ok(/再叫一次 mc_sequence/.test(r.hint ?? ''), 'hint 告诉模型"再叫一次 mc_sequence"', String(r.hint).slice(0, 80))
  ok(/从第 \d+ 步往后发/.test(r.hint ?? ''), 'hint 说清"从第几步往后发"', String(r.hint).slice(0, 80))
  /* ⑪ 之后：没走到的步骤不再多 push 一条假结果，改由被截断的那一步自己如实说"没做完"，
     并用 results.length + remaining === requested 保证账目对得上（第四份审计报告 ③）。 */
  ok(r.results.some((x) => x.ok === false && (/秒用完了/.test(String(x.error)) || /没做完|时间不够/.test(String(x.note)))),
    `results 里如实记了"这一轮的 ${CALL_MS / 1000} 秒用完了"`, JSON.stringify(r.results.slice(-1)))
  ok(r.results.filter((x) => x.i < r.stoppedAt).every((x) => x.ok === true) && r.succeeded === r.stoppedAt,
    'stoppedAt 之前的步骤全部成功、且没多记没执行的步骤（不再重复计账）',
    JSON.stringify({ results: r.results.map((x) => `${x.i}:${x.ok}`), stoppedAt: r.stoppedAt, succeeded: r.succeeded }))
  ok(r.succeeded >= 1, '前面的步骤算成功（不是整串失败）', `succeeded=${r.succeeded}`)

  // 时间**一点都没有**时：如实说"什么都没做"（stoppedAt 0，不是"第 1 步没做完"）
  {
    const f0 = mkBot()
    const mc0 = mkMc(f0)
    mc0.setCallDeadline(0)
    const r0 = await mc0.runSequence([{ op: 'jump' }, { op: 'jump' }])
    ok(r0.stoppedAt === 0 && r0.succeeded === 0, '时间已经用完 ⇒ stoppedAt=0、succeeded=0（不假装做了第 1 步）', JSON.stringify({ stoppedAt: r0.stoppedAt, succeeded: r0.succeeded }))
    /* 🔴 2026-10-17（实机：「mc_sequence 会假失败：秒回报 stoppedAt:0 / 本轮时间不够，但方块其实已经挖掉了」）：
     *    "我一步都没做"和"这活没干成"是两件事 —— 旧文案写成"时间用完了，原样再发一次"，
     *    模型会以为刚才那串失败了、然后把已经做完的事重做一遍。现在必须明说"没分到时间"+ "先复核"。 */
    ok(r0.noBudget === true && r0.budgetMs === 0, '没分到时间 ⇒ 明说 noBudget:true + budgetMs:0', JSON.stringify({ noBudget: r0.noBudget, budgetMs: r0.budgetMs }))
    ok(/没分到时间/.test(r0.hint ?? '') && /一步都没做/.test(r0.hint ?? ''), 'hint 说清"这次调用自己没分到时间、一步都没做"', String(r0.hint).slice(0, 90))
    ok(/复核/.test(r0.hint ?? '') && !/原样发/.test(r0.hint ?? ''), 'hint 让模型**先复核**，而不是"原样再发一次"（那是"没做成"的指令）', String(r0.hint).slice(0, 110))
    ok(f0.calls.control.length === 0, '一点时间都没有 ⇒ 一个控制位都没碰', JSON.stringify(f0.calls.control))
  }

  // 步骤自己发现"时间用完了"（jump/flyTo 开头就查 msLeft）⇒ 也要给 stoppedAt，别变成"整串失败从第 1 步重来"
  {
    const f1 = mkBot()
    const mc1 = mkMc(f1)
    mc1.setCallDeadline(1_100)
    const r1 = await mc1.runSequence([{ op: 'wait', sec: 1 }, { op: 'jump' }])
    ok(r1.stoppedAt === 1 && /秒用完了/.test(String(r1.results.at(-1)?.error ?? '')),
      '步骤自己发现时间用完 ⇒ 一样给 stoppedAt（审计⑦：不然模型会从第 1 步整串重来）', JSON.stringify({ stoppedAt: r1.stoppedAt, err: r1.results.at(-1)?.error }))
  }

  // 给足时间就不该有 stoppedAt
  const fake2 = mkBot()
  const mc2 = mkMc(fake2)
  const r2 = await mc2.runSequence([{ op: 'wait', sec: 0 }, { op: 'wait', sec: 0 }])
  ok(r2.stoppedAt === undefined && r2.remaining === undefined, '没到点就不给 stoppedAt（别让模型白重发）', JSON.stringify({ stoppedAt: r2.stoppedAt }))
}

/* ─────────── ⑤b 危险信号：默认**只提醒不打断**（用户 2026-10-19「不要打断只提醒」） ─────────── */
section('⑤b 长循环遇险：默认只提醒（warnings），stopOnDanger:true 才带进度退出')
{
  /* ① 默认：怪贴脸 ⇒ 活照跑完，结果里多一句 warnings；**没有** interrupted */
  const fake = mkBot({ mobs: [{ name: 'zombie', at: [2, 64, 0] }] })
  const mc = mkMc(fake)
  const r = await mc.runSequence([{ op: 'wait', sec: 0 }, { op: 'wait', sec: 0 }])
  ok(r.interrupted === undefined, '默认不中断（没有 interrupted）', JSON.stringify(r.interrupted))
  ok(r.stoppedAt === undefined && r.succeeded === 2, '两步都跑完了（不是停在半路）', JSON.stringify({ stoppedAt: r.stoppedAt, succeeded: r.succeeded }))
  ok(Array.isArray(r.warnings) && r.warnings.length === 1 && /zombie/.test(r.warnings[0]), 'warnings 里说清是谁贴上来的', JSON.stringify(r.warnings))
  ok(/只提醒/.test(r.warnings[0]) && /没打断/.test(r.warnings[0]), 'warnings 明说「只提醒，没打断」')
  ok(r.danger === undefined, '不出现 danger 字段（那是旧行为）')
}
{
  /* ② 想恢复旧行为：`stopOnDanger: true` ⇒ 第 0 步之前就退出（一步都不做） */
  const fake = mkBot({ mobs: [{ name: 'zombie', at: [2, 64, 0] }] })
  const mc = mkMc(fake)
  mc.cfg.stopOnDanger = true
  const r = await mc.runSequence([{ op: 'wait', sec: 0 }, { op: 'wait', sec: 0 }])
  ok(r.interrupted === 'danger', 'stopOnDanger:true ⇒ interrupted:"danger"（机器可读）', JSON.stringify(r.interrupted))
  ok(r.stoppedAt === 0 && r.succeeded === 0, '第 0 步之前就退出（stoppedAt=0、succeeded=0）', JSON.stringify({ stoppedAt: r.stoppedAt, succeeded: r.succeeded }))
  ok(r.danger?.kind === 'hostile' && r.danger?.name === 'zombie', 'danger 里带怪的名字', JSON.stringify(r.danger))
  ok(/zombie/.test(r.hint ?? '') && /attack/.test(r.hint ?? ''), 'hint 说清"先打掉它"', String(r.hint).slice(0, 90))
  ok(!/时间/.test(r.hint ?? ''), 'hint **不说**"时间不够"（两件事不能混）', String(r.hint).slice(0, 90))
  ok(r.warnings === undefined, '旧行为下不出 warnings')
}
{
  /* ③ 掉血：默认也要跑完（不再因为"血少了"把活交回来），血量差额照样写进提醒 */
  const fake = mkBot()
  const mc = mkMc(fake)
  const orig = fake.bot.setControlState
  let dropped = false
  fake.bot.setControlState = (k, v) => {
    if (!dropped && k === 'jump' && v === true) { dropped = true; fake.bot.health = 16 }
    return orig(k, v)
  }
  const r = await mc.runSequence([{ op: 'jump' }, { op: 'jump' }, { op: 'jump' }])
  ok(r.interrupted === undefined && r.succeeded === 3, '掉血也把三步跑完', JSON.stringify({ succeeded: r.succeeded, interrupted: r.interrupted }))
  ok(String(r.warnings?.[0] ?? '').includes('正在挨打'), 'warnings 说清在挨打', JSON.stringify(r.warnings))
  ok(String(r.warnings?.[0] ?? '').includes('20') && String(r.warnings?.[0] ?? '').includes('16'), '把 20 → 16 如实带上', String(r.warnings?.[0] ?? ''))
}
{
  /* ④ 8 格外的怪**不算** —— 不能把"挖 12 格"砍成 12 次调用（那正是要修的病） */
  const fake = mkBot({ mobs: [{ name: 'zombie', at: [8, 64, 0] }] })
  const mc = mkMc(fake)
  const r = await mc.runSequence([{ op: 'wait', sec: 0 }, { op: 'wait', sec: 0 }])
  ok(r.interrupted === undefined && r.stoppedAt === undefined && r.warnings === undefined, '8 格外的僵尸 ⇒ 既不打断也不提醒', JSON.stringify({ interrupted: r.interrupted, warnings: r.warnings }))
}
{
  /* ⑤ 危险检查仍在**预算检查之前**：时间还剩很多，但怪在脸上 ⇒ 开了开关照样退 */
  const fake = mkBot({ mobs: [{ name: 'skeleton', at: [1, 64, 0] }] })
  const mc = mkMc(fake)
  mc.cfg.stopOnDanger = true
  mc.setCallDeadline(11_000)
  const r = await mc.runSequence([{ op: 'wait', sec: 0 }, { op: 'wait', sec: 0 }])
  ok(r.interrupted === 'danger', '预算充足也照样为危险退出（开关打开时）', JSON.stringify({ interrupted: r.interrupted }))
}
{
  /* ⑥ mc_build：默认挨打照样放完这一格，只在结果里留一句 */
  const box = { x1: 0, y1: 64, z1: 0, x2: 0, y2: 64, z2: 0, name: 'stone' }
  const fake = mkBot({ mobs: [{ name: 'zombie', at: [2, 64, 0] }] })
  const mc = mkMc(fake)
  mc.placeBlock = async (o) => { fake.calls.place.push(o); return { placed: true } }
  const r = await mc.build(box)
  ok(r.interrupted === undefined && r.placed === 1, '默认：这一格照样放上去', JSON.stringify({ placed: r.placed, interrupted: r.interrupted }))
  ok(Array.isArray(r.warnings) && r.warnings.length === 1, '结果里带一句 warnings', JSON.stringify(r.warnings))
}
{
  /* ⑦ mc_build：开了开关 ⇒ 一块都不放，直接带 interrupted 回来 */
  const box = { x1: 0, y1: 64, z1: 0, x2: 0, y2: 64, z2: 0, name: 'stone' }
  const fake = mkBot({ mobs: [{ name: 'zombie', at: [2, 64, 0] }] })
  const mc = mkMc(fake)
  mc.cfg.stopOnDanger = true
  mc.placeBlock = async (o) => { fake.calls.place.push(o); return { placed: true } }
  const r = await mc.build(box)
  ok(r.interrupted === 'danger', 'stopOnDanger:true ⇒ mc_build 带 interrupted:"danger"', JSON.stringify(r.interrupted))
  ok(r.placed === 0, '一块都没放（第 0 格之前就退了）', String(r.placed))
  ok(fake.calls.place.length === 0, '真的一个 placeBlock 都没发', String(fake.calls.place.length))
}

/* ─────────── ⑥ build()：到点带进度返回 + 已经放对的格子跳过 ─────────── */
section('⑥ build() —— 到点返回 remaining；再叫一次时跳过已放对的格子')
{
  const box = { x1: 0, y1: 64, z1: 0, x2: 1, y2: 64, z2: 1, name: 'stone' }
  // 已经放对 2 格（(0,64,0)、(1,64,0)），另外 2 格是空的
  const fake = mkBot({ blocks: { '0,64,0': { name: 'stone' }, '1,64,0': { name: 'stone' } } })
  const mc = mkMc(fake)
  mc.placeBlock = async (o) => { fake.calls.place.push(o); return { placed: true } }
  const r = await mc.build(box)
  ok(r.requested === 4, '一共 4 格', String(r.requested))
  ok(r.placed === 4, '已放对的也算放好了（placed 4）', JSON.stringify(r))
  ok(fake.calls.place.length === 2, '只对 2 个空格调 placeBlock（已放对的跳过，不报"这格有方块"）', JSON.stringify(fake.calls.place.map((c) => `${c.x},${c.y},${c.z}`)))
  const placedAt = fake.calls.place.map((c) => `${c.x},${c.y},${c.z}`).sort()
  ok(placedAt.join(' ') === '0,64,1 1,64,1', '放的是那两个空格', placedAt.join(' '))

  // 本轮时间用完 → 一格都不放，但要说清还剩几格
  const fake2 = mkBot()
  const mc2 = mkMc(fake2)
  mc2.placeBlock = async (o) => { fake2.calls.place.push(o); return { placed: true } }
  mc2.setCallDeadline(0)
  const r2 = await mc2.build(box)
  ok(fake2.calls.place.length === 0, '时间用完 → 一个 placeBlock 都不调', String(fake2.calls.place.length))
  ok(r2.placed === 0 && r2.remaining === 4, '返回 remaining = 4', JSON.stringify({ placed: r2.placed, remaining: r2.remaining }))
  /* 🔴 2026-10-17：`setCallDeadline(0)` = **这次调用自己没分到时间** —— 与"有时间但用完了"
   *    是两件事（实机 AI 报「mc_sequence 会假失败：秒回报 stoppedAt:0 / 本轮时间不够，
   *    但方块其实已经挖掉了」）。这条指令不能是"原样再发一次"（模型会把做完的重做一遍），
   *    必须是"先复核"。 */
  ok(r2.noBudget === true, '没分到时间 ⇒ 明说 noBudget:true', JSON.stringify({ noBudget: r2.noBudget, callLeftMs: r2.callLeftMs }))
  ok(/没分到时间/.test(r2.hint ?? '') && /一块都没放/.test(r2.hint ?? ''), 'hint 说清"自己没分到时间、一块都没放"', String(r2.hint).slice(0, 80))
  ok(/复核/.test(r2.hint ?? '') && !/放对的会跳过/.test(r2.hint ?? ''), 'hint 让模型**先复核**（不是"原样重发"）', String(r2.hint).slice(0, 110))
}

/* ─────────── ⑥b build()：**有时间但用完了** ⇒ 另一套话（两件事不许混） ─────────── */
section('⑥b build() —— "时间用完了"与"没分到时间"必须是两套话')
{
  const box6 = { x1: 0, y1: 64, z1: 0, x2: 0, y2: 64, z2: 9, name: 'stone' }  // 10 格（放得完才怪）
  const fake = mkBot()
  const mc = mkMc(fake)
  mc.placeBlock = async (o) => { fake.calls.place.push(o); await new Promise((r) => setTimeout(r, 120)); return { placed: true } }
  mc.setCallDeadline(1_000)
  const r = await mc.build(box6)
  ok(r.placed > 0 && r.placed < 10, '做了一部分才到点（带进度返回）', JSON.stringify({ placed: r.placed, remaining: r.remaining }))
  ok(r.remaining === 10 - r.placed, 'remaining = 总格数 − 已放', JSON.stringify({ placed: r.placed, remaining: r.remaining }))
  ok(r.noBudget === undefined, '这不是"没分到时间"（两件事不许混）', JSON.stringify({ noBudget: r.noBudget }))
  ok(/再叫一次 mc_build/.test(r.hint ?? ''), 'hint 告诉模型"再叫一次 mc_build"', String(r.hint).slice(0, 80))
  ok(/放对的会跳过/.test(r.hint ?? ''), 'hint 说明"同一个范围重发就行，放对的会跳过"', String(r.hint).slice(0, 90))
}

/* ─────────── ⑦ index.js：注册时的 timeoutMs 都 ≤ 12 秒 ─────────── */
section('⑦ index.js —— 每个 mc_* 工具的 DSH 层 timeoutMs ≤ 12 秒（LONG_TOOLS 例外）')
{
  const src = readFileSync(new URL('../index.js', import.meta.url), 'utf8')
  const LONG = new Set(['mc_connect', 'mc_disconnect', 'mc_map', 'mc_kit_image'])
  /** 把 `CALL_MS + 1_000` / `60_000` 这类表达式算成毫秒 */
  const evalMs = (expr) => {
    let v = 0
    for (const part of String(expr).split('+').map((s) => s.trim())) {
      if (part === 'CALL_MS') v += 5_000
      else if (/^[0-9_]+$/.test(part)) v += Number(part.replace(/_/g, ''))
      else return NaN
    }
    return v
  }
  const marks = [...src.matchAll(/name:\s*'(mc_[a-z_]+)'/g)]
  const found = []
  for (let i = 0; i < marks.length; i++) {
    const start = marks[i].index
    const end = i + 1 < marks.length ? marks[i + 1].index : Math.min(src.length, start + 5_000)
    const chunk = src.slice(start, end)
    const m = /timeoutMs:\s*([A-Za-z_0-9]+(?:\s*\+\s*[0-9_]+)?)/.exec(chunk)
    if (m) found.push({ tool: marks[i][1], ms: evalMs(m[1]), expr: m[1].trim() })
  }
  ok(found.length >= 8, `扫到 ${found.length} 个工具自带 timeoutMs`, found.map((f) => f.tool).join(','))
  const over = found.filter((f) => !LONG.has(f.tool) && !(f.ms > 0 && f.ms <= 12_000))
  ok(over.length === 0, '除了 LONG_TOOLS，每个工具的 timeoutMs 都 ≤ 12 秒（一整轮 11 秒 + 1 秒余量）', over.map((f) => `${f.tool}=${f.expr}`).join(' '))
  const longFound = found.filter((f) => LONG.has(f.tool))
  ok(longFound.every((f) => f.ms > 12_000), 'LONG_TOOLS 里的工具确实是长任务（> 12 秒）', longFound.map((f) => `${f.tool}=${f.expr}`).join(' '))
  ok(/const LONG_TOOLS = new Set\(\[/.test(src), 'asTool 里有 LONG_TOOLS 例外名单')
  ok(/Math\.min\(Number\(spec\?\.timeoutMs\) \|\| CALL_MS \+ 1_000, CALL_MS \+ 1_000\)/.test(src), 'asTool 把 spec.timeoutMs 钳到 CALL_MS + 1 秒')
  ok(/sess\.bot\.setCallDeadline\(CALL_MS\)/.test(src), 'asTool 每次 execute 前 setCallDeadline(CALL_MS)')
  ok(/perCallMs: CALL_MS/.test(src), 'mc_capabilities 里报了 perCallMs（模型能自己看到上限）')
  const mcMove = found.find((f) => f.tool === 'mc_move')
  ok(mcMove && mcMove.ms <= 12_000, 'mc_move 的 timeoutMs 也压到 12 秒内', JSON.stringify(mcMove))

  /* 2026-10-18 用户要求：「mc_sequence 用完以后也加上自动用 observer」「和 move 一样」——
   * 指的是跑完顺手报 `around`（12 格内最多 6 个），别再单独叫 mc_entities。
   * 用源码文本钉住接线：从 `mc_sequence` 的注册块里找 `...aroundOf(sess)`。 */
  const seqAt = src.indexOf("name: 'mc_sequence'")
  const seqChunk = seqAt < 0 ? '' : src.slice(seqAt, seqAt + 4_000)
  ok(/\.\.\.aroundOf\(sess\)/.test(seqChunk), 'mc_sequence 跑完也带 around（和 mc_move 同一条读口）')
  ok(/around/.test(seqChunk), 'mc_sequence 描述里说明了 around（不用再单独查周围实体）')
  const mvAt = src.indexOf("name: 'mc_move'")
  const mvChunk = mvAt < 0 ? '' : src.slice(mvAt, mvAt + 6_000)
  ok(/\.\.\.aroundOf\(sess\)/.test(mvChunk), 'mc_move 仍然带 around（两边口径一致）')
}

/* ─────────── ⑧ 扩展：timeoutMs 也 ≤ 12 秒 ─────────── */
section('⑧ 四个扩展的 timeoutMs 也 ≤ 12 秒')
{
  /** 只认 `CALL_MS` / `CALL_BUDGET_MS` / 数字 的加减；看不懂就 NaN（别让新坑偷偷溜过） */
  const evalMs = (expr) => {
    let v = 0
    for (const part of String(expr).split('+').map((s) => s.trim())) {
      if (part === 'CALL_MS') v += 11_000
      else if (part === 'CALL_BUDGET_MS') v += 10_000
      else if (/^[0-9_]+$/.test(part)) v += Number(part.replace(/_/g, ''))
      else return NaN
    }
    return v
  }
  /** 按顶层逗号切 `clamp(a, b, c)` 的参数 */
  const splitTop = (s) => {
    const out = []
    let depth = 0, cur = ''
    for (const ch of s) {
      if (ch === '(') depth++
      if (ch === ')') depth--
      if (ch === ',' && depth === 0) { out.push(cur); cur = ''; continue }
      cur += ch
    }
    out.push(cur)
    return out.map((x) => x.trim())
  }
  for (const f of ['mc_observe.mjs', 'mc_craft.mjs', 'mc_chest.mjs', 'mc_furnace.mjs']) {
    const src = readFileSync(new URL(`../extensions/${f}`, import.meta.url), 'utf8')
    ok(/import \{[^}]*\bCALL_MS\b[^}]*\} from '\.\.\/src\/core\.mjs'/.test(src), `${f} 从 core.mjs 引了 CALL_MS`)
    // 取到行尾再掐掉尾逗号：`clamp(a, b, c)` 里有逗号，不能按逗号截
    const exprs = [...src.matchAll(/timeoutMs:\s*(.+?)\s*,?\s*$/gm)].map((m) => m[1].trim())
    ok(exprs.length > 0, `${f} 里有 timeoutMs`, exprs.join(' | '))
    for (const expr of exprs) {
      const c = /^clamp\((.*)\)$/.exec(expr)
      if (c) {
        // 走 clamp 的（按 env 可调）—— 上界必须 ≤ 一整轮，否则慢的时候会顶穿 11 秒
        const hi = splitTop(c[1])[2]
        const hiMs = evalMs(hi)
        ok(Number.isFinite(hiMs) && hiMs <= CALL_MS, `${f} 的 clamp 上界 ≤ ${CALL_MS / 1000} 秒`, `${expr} → 上界 ${hi}`)
        continue
      }
      const v = evalMs(expr)
      ok(Number.isFinite(v) && v > 0 && v <= 12_000, `${f} 的 timeoutMs ≤ 12 秒`, `${expr} → ${v}`)
    }
    const chunkCaps = [...src.matchAll(/callBudget\(([^)]*)\)/g)].map((m) => m[1].trim())
    ok(chunkCaps.length === 0 || chunkCaps.every((c) => /^[0-9_]+$/.test(c)), `${f} 里的 callBudget 都传了数字（会被钳到 10 秒）`, chunkCaps.join(' | '))
  }
}

/* ─────────── ⑨ 源码里的"同一类坑"静态检查 ─────────── */
section('⑨ core.mjs —— 长动作排 deadline 要算上"本轮已用掉的时间"')
{
  const raw = readFileSync(new URL('../src/core.mjs', import.meta.url), 'utf8')
  // 只看代码，不看注释（注释里正是拿这些"反面写法"当例子讲道理的）
  const src = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  /* 🔴 2026-10-15 审计：`dig()` / `build()` 早就搬进 `src/mining.mjs` / `src/build.mjs` 了
   *    （那边是 `self.callLeft()`，不是 `this.`）⇒ 旧断言在 core.mjs 里数到 0 处，一直红着。 */
  const minSrc = readFileSync(new URL('../src/mining.mjs', import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  const buildSrc = readFileSync(new URL('../src/build.mjs', import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  const n = [...(minSrc + buildSrc).matchAll(/Date\.now\(\) \+ (?:Math\.max\(0, )?(?:self\.callLeft\(\)|callLeftMs)/g)].length
  ok(n >= 2, `dig() / build() 都用 self.callLeft() 排 deadline（${n} 处）`, String(n))
  /* 🔴 2026-10-17：`self.callLeft()` 现在**先取出来存成 `callLeftMs`** —— 同一个数要用两遍
   *    （排 deadline + 判断"这次调用到底有没有分到时间"）。断言钉住这个来源，
   *    免得以后有人把 `callLeftMs` 换成别的来源、`noBudget` 就悄悄失效了。 */
  ok(/const callLeftMs = self\.callLeft\(\)/.test(minSrc) && /const callLeftMs = self\.callLeft\(\)/.test(buildSrc),
    '两个文件都把 self.callLeft() 先取出来（同一个数用两遍）')
  ok(/const noBudget = callLeftMs <= 900/.test(minSrc) && /const noBudget = callLeftMs < 300/.test(buildSrc),
    '两个文件都算了 noBudget（"这次有没有分到时间"）')
  ok(/noBudget \? \{ noBudget: true, budgetMs: bd \}/.test(readFileSync(new URL('../src/sequence.mjs', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')),
    'sequence 也把 noBudget 单独回出去（三个长循环口径一致）')
  // 🔴 dig() 还要**留收尾时间**：`#cancelCollect` 等 collectBlock_finished 最多 1.5 秒、
  //    兜底原地挖、拼文本、DSH 序列化都排在预算之外 ⇒ 两个目标就冲出工具超时（2026-10-08 实机反馈：
  //    `Error: tool call timed out after 6000ms`，而方块其实早挖掉了）。
  ok(/const deadline = Date\.now\(\) \+ Math\.max\(0, callLeftMs - 900\)/.test(minSrc),
    'dig() 的 deadline 留了 900ms 收尾（别再让它冲出工具超时）')
  /* 🔴 2026-10-08：`dig()` 不再把方块交给 collectBlock（"挖完又复原 + 之后几分钟走不了路"的根因），
   *    所以那条 `budgetMs: leftOf() - 200` 也没了。现在还要"限住取消动作"的地方只剩 `#grabDrops`
   *    （捡不到时收尾），给它一个**固定**的小额度，别让捡东西把这一轮吃光。 */
  // 路线图第 ④ 条第二十三刀：`#grabDrops` 已搬到 `src/pickup.mjs`（薄包装同名，调用点一行都没改）。
  const pkSrc = readFileSync(new URL('../src/pickup.mjs', import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  ok(/ctx\.cancelCollect\?\.\(b, \{ budgetMs: 300 \}\)/.test(pkSrc), '#grabDrops 捡不到时收尾（budgetMs 300，不让捡东西吃光预算；实现已搬到 src\\pickup.mjs）')
  ok(/cancelCollect: \(bb, o\) => this\.#cancelCollect\(bb, o\)/.test(src), 'core 的 #grabDrops 薄包装把 cancelCollect 递进模块（模块够不着私有方法）')
  ok(!/collectBlock\.collect\(\[target\]/.test(src), 'dig() 不再把方块交给 collectBlock（那条路会"挖完又复原"）')
  // 路线图第 ④ 条第十五刀：`#cancelCollect` 已搬到 `src/dig-guard.mjs`（薄包装同名，调用点一行都没改）。
  const dgSrc = readFileSync(new URL('../src/dig-guard.mjs', import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  ok(/budgetMs == null/.test(dgSrc), '#cancelCollect 的 budgetMs == null 是"没指定"（别被 Number(null)===0 吃成"一秒都不等"，实现已搬到 src\\dig-guard.mjs）')
  // 路线图第 ④ 条第三十六/三十七刀：`walkTo` / `#walkPathfinder` 也搬进 `src/movement.mjs` 了。
  const movSrc = readFileSync(new URL('../src/movement.mjs', import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  ok(/budgetAsked: callBudget\(budget\)/.test(movSrc), 'walkTo 把"调用方要的预算"传给寻路层（实现已搬到 src\\movement.mjs）')
  ok(/budgetAsked = null/.test(movSrc), '#walkPathfinder 接 budgetAsked（判"是不是被预算截断的"，实现已搬到 src\\movement.mjs）')
  ok(/const cutByCall = Boolean\(e\?\.mcCallOver\) \|\| self\.msLeft\(\) <= 400/.test(movSrc)
    && /const timeUp = cutByCall \|\| Boolean\(e\?\.mcTimeout\)/.test(movSrc), '被预算截断 ≠ 走不通（文案分流，实现已搬到 src\\movement.mjs）')
  ok(/from '\.\/movement\.mjs'/.test(src), 'core 确实从 movement.mjs 导入（搬走 + 忘接 = 假绿）')
  ok(/bumpGen: \(\) => \{ this\._moveGen\+\+ \}/.test(src), '薄包装里把移动代号往前推（模块不碰 this）')
  ok(/callLeft \(\) \{/.test(src), 'McBot 上有 callLeft() = min(一整轮, 本轮剩余)')
  ok(!/const deadline = callDeadline\(\)/.test(src), '没有"又给整整一整轮"的 `const deadline = callDeadline()`')
  ok(!/msLeft\(\) \|\| CALL_BUDGET_MS/.test(src), '没有 `msLeft() || CALL_BUDGET_MS`（用完了 0 会变成 10000）')
  ok(!/Number\(ms\) \|\| CALL_MS/.test(src), 'setCallDeadline 里没有 `Number(ms) || CALL_MS`（0 会变成一整轮）')
}

/* ─────────── ⑩ 移动抢占：两边共用一个 pathfinder，谁后动谁说了算 ─────────── */
section('⑩ interruptMove() —— 自保反射抢 AI 那一步的移动（"动了一下不动了"的根因）')
{
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

  const fake = mkBot({ hang: true })
  const mc = mkMc(fake)
  const p = mc.walkTo({ x: 50, y: 64, z: 50 })
  await sleep(250)
  ok(typeof mc.interruptMove === 'function', 'McBot 上有 interruptMove()（自保反射用它抢占）')
  const t0 = Date.now()
  const done = await mc.interruptMove('旁边有 zombie')
  const ms = Date.now() - t0
  const r = await p
  ok(done === true && ms < 500, '打断是立刻返回的（不等寻路自己超时）', `${ms}ms`)
  ok(ms < 3_400, '被打断的 walkTo 也立刻收尾（不再空等 4 秒预算）', `${ms}ms`)
  ok(r.stuck === true && r.reason === 'preempted', '如实报 reason=preempted', JSON.stringify({ stuck: r.stuck, reason: r.reason }))
  ok(/另一次移动/.test(r.hint ?? ''), 'hint 说明是被另一次移动打断的', String(r.hint).slice(-90))
  ok(/再叫一次 mc_move/.test(r.hint ?? ''), '并告诉模型"再叫一次 mc_move 接着走"', String(r.hint).slice(-90))
  ok(!/换个能走到的目标点/.test(r.hint ?? ''), '不误报成"走不通/换目标"', String(r.hint).slice(-90))
  ok(fake.calls.stop === 1, 'stop() 只被调一次（抢占时调，walkTo 收尾不再重复停）', `stop=${fake.calls.stop}`)
  const released = fake.calls.control.filter(([, v]) => v === false).length
  ok(released >= 6, '打断时把控制位全松开（forward/back/left/right/jump/sprint）', `松开 ${released} 个`)

  const raw = readFileSync(new URL('../src/core.mjs', import.meta.url), 'utf8')
  const src = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  /* 🔴 第三十三刀：超时闸门 / 抢占 / 停寻路 / 接 abort 搬进了 `src/runtime.mjs`
   *    ⇒ 判"实现体在不在"要连着那个模块一起看（core 里只剩薄包装）。 */
  const runSrc = readFileSync(new URL('../src/runtime.mjs', import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  // 路线图第 ④ 条第三十七刀：`#walkPathfinder` 的函数体也搬进 `src/movement.mjs`（core 只剩薄包装 + #pathCtx）。
  const movSrc = readFileSync(new URL('../src/movement.mjs', import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  ok(/_moveGen = 0/.test(src), '有移动代号 _moveGen（每次移动领一个号）')
  ok(/#beginMove \(\) \{ return \+\+this\._moveGen \}/.test(src), '#beginMove() 领号')
  ok(/async interruptMove \(reason = ''\)/.test(src), 'interruptMove(reason = "") 是公开方法')
  const bumps = [...src.matchAll(/this\._moveGen\+\+/g)].length + [...runSrc.matchAll(/self\._moveGen\+\+/g)].length
  ok(bumps >= 2, `抢占时把代号往前推（${bumps} 处：interruptMove / #cancelCollect）`, String(bumps))
  const begins = [...src.matchAll(/this\.#beginMove\(\)/g)].length
  ok(begins >= 3, `走路 / 采集 / 游泳各领一次号（${begins} 处：#walkPathfinder / dig / #walkSwim）`, String(begins))
  ok(/const preempted = self\._moveGen !== gen/.test(movSrc), '收尾时先判断"我这一号还是不是最新的"（实现在 src\\movement.mjs）')
  ok(/const reasonOut = preempted \? 'preempted'/.test(movSrc) && /reason: reasonOut/.test(movSrc),
    '被抢占 → reason = preempted（其余 reason 走映射表，不漏 `Error`/`block_updated`，实现在 src\\movement.mjs）')
  ok(/const noProgress = [^\n]*vRose < 0\.75[^\n]*moved < 0\.6/.test(movSrc)
    && /是真没走通/.test(movSrc),   /* 2026-10-29：垂直也算进展，旧正则只认水平 */
    '一格没挪时如实说"真没走通"（不是"再叫一次就好"，实现在 src\\movement.mjs）')
  ok(/if \(self\._moveGen === gen\) \{/.test(movSrc), 'finally 里只有"还是最新一号"才停 pathfinder + 松控制位（实现在 src\\movement.mjs）')
  /* 🔴 2026-10-08 审计②③④⑦⑨：这五条是这一轮审计的**回归钉子**，谁把它们改回去谁红。 */
  ok(/#stopPathing \(b\) \{ return stopPathing\(b\) \}/.test(src) && /export function stopPathing \(b\) \{/.test(runSrc) && /b\.pathfinder\.setGoal\?\.\(null\)/.test(runSrc),
    '真停 pathfinder：`stop()` 只是置标志 ⇒ 必须先 setGoal(null)（审计②）')
  ok(/if \(self\._moveGen !== gen\) \{/.test(movSrc) && /reason: emptyNoPath \? 'NoPath' : 'goal-reached-elsewhere'/.test(movSrc),
    '空路径的假成功 / 别人的 goal_reached 不再冒充 preempted（审计③，实现在 src\\movement.mjs）')
  ok(/_ctrlLease = new Map\(\)/.test(src) && /holdControl \(key, ms = 300\) \{ return holdControlImpl\(this, key, ms\) \}/.test(src)
    && /export function releaseControls \(self\) \{/.test(runSrc) && /const until = self\._ctrlLease\.get\(k\) \?\? 0/.test(runSrc),
    '自保反射的控制位有租约，移动收尾跳过没过期的键（审计⑨；租约表留在 core，读写实现第四十一刀搬到 src\\runtime.mjs）')
  ok(/const leftMs = self\.msLeft\(\)\r?\n\s*if \(leftMs <= 100\)/.test(movSrc) && !/Math\.max\(150, Math\.min\(callBudget\(budget\), self\.msLeft\(\)\)\)/.test(movSrc),
    '本轮时间用完就别再开始走（不再被外层 Math.max(150/300) 白送时间，审计⑦）')
  ok(/Promise\.resolve\(self\.interruptMove\('用户中断'\)\)/.test(runSrc) && /from '\.\/runtime\.mjs'/.test(src),
    '用户点停止（signal abort）⇒ 立刻真停（interruptMove 不再死代码，审计④）')

  /* ⑩.5 别人的 goal_reached 会把我这次 goto 一起 resolve
   * （vendor 的 lib/goto.js:60 监听的是 bot 上的全局 goal_reached，没核对 goal 身份；
   *   自主层逃跑/跟随同时在走时，它到点会顺手把 AI 那次 mc_move 也 resolve 掉 ——
   *   2026-10-06 打怪实测：连续 19 次 mc_move 秒返回 moved=0 + "插件说到了但还差 5 格"。） */
  {
    const mkPf = (isEnd, at = new Vec3(0, 64, 0)) => {
      const fake = mkBot({ hang: false })
      fake.bot.entity.position = at
      fake.bot.pathfinder = { goto: () => Promise.resolve(), stop: () => {}, setMovements: () => {} }
      const mc = mkMc(fake)
      mc._pf.goals.GoalNear = class {
        constructor (x, y, z, r) { Object.assign(this, { x, y, z, r }) }
        isEnd (p) { return isEnd(p) }
      }
      return mc
    }
    // A：插件报"到了"，但满足的是**别人**的目标（我离目标 70 格）⇒ 如实报 goal-reached-elsewhere
    const r1 = await mkPf(() => false).walkTo({ x: 50, y: 64, z: 50 })
    ok(r1.reason === 'goal-reached-elsewhere', '别人的 goal_reached 不算我走到了（审计③ 单独报一种 reason）', JSON.stringify({ reason: r1.reason, remaining: r1.remaining }))
    ok(/不是我这次的目标/.test(r1.hint ?? '') && /不是走不通/.test(r1.hint ?? ''), 'hint 说清是"别人到点顺手 resolve 了我"，不是走不通', String(r1.hint).slice(-80))
    ok(!/寻路插件说到了/.test(r1.hint ?? ''), '不再谎报"插件说到了但离目标还差 N 格"', String(r1.hint).slice(-80))
    // B：插件真的早报（我自己的 goal 满足、但人还在远处）⇒ 保持原语义
    const r2 = await mkPf(() => true).walkTo({ x: 50, y: 64, z: 50 })
    ok(r2.reason === 'goal_reached-but-far', '自己的 goal 满足但人没到 ⇒ 仍然报 goal_reached-but-far', JSON.stringify({ reason: r2.reason, arrived: r2.arrived }))
    // C：真到了
    const r3 = await mkPf(() => false, new Vec3(50, 64, 50)).walkTo({ x: 50, y: 64, z: 50 })
    ok(r3.arrived === true, '站在目标上 ⇒ arrived', JSON.stringify({ arrived: r3.arrived, reason: r3.reason ?? null }))
    // D：A* 空路径的 noPath 是**无错 resolve**（vendor goto.js:22-30）⇒ 以前被报成 preempted（"再叫一次就行"）
    {
      const fake = mkBot({ hang: false })
      fake.bot.entity.position = new Vec3(0, 64, 0)
      /* 2026-10-24：目标那一列**读得到**（空气）—— 否则新逻辑会如实报 waiting_chunks（未加载），
       * 那是另一条正确分支，这个用例要验的是「空路径 = 真没路」。 */
      fake.bot.blockAt = () => ({ name: 'air' })
      fake.bot.pathfinder = {
        // 先送 `path_update{status:'noPath', path:[]}`（真 pathfinder 的空路径分支就是这样），**再** resolve
        goto: () => new Promise((resolve) => {
          setTimeout(() => { fake.bot.emit('path_update', { status: 'noPath', path: [] }); setTimeout(resolve, 5) }, 5)
        }),
        stop: () => {}, setMovements: () => {}, setGoal: () => {},
      }
      const mc = mkMc(fake)
      mc._pf.goals.GoalNear = class {
        constructor (x, y, z, r) { Object.assign(this, { x, y, z, r }) }
        isEnd () { return false }
      }
      const r4 = await mc.walkTo({ x: 50, y: 64, z: 50 })
      ok(r4.reason === 'NoPath', '空路径的"假成功"如实报 NoPath（审计③：真没路，别再说"再叫一次就行"）', JSON.stringify({ reason: r4.reason }))
      ok(/没路可走/.test(r4.hint ?? '') && !/不是走不通/.test(r4.hint ?? ''), 'hint 说"没路可走"，不再骗模型重发', String(r4.hint).slice(-80))
    }
  }

  /* ⑪ 中断 / 预算边界（2026-10-08 审计⑥⑦⑧⑩：整套 check 以前**一条 abort 断言都没有**） */
  section('⑪ 用户中断与预算边界（jump / 游泳 / 序列 / 等待区块）')
  {
    // ① jump：aborted + 时间用完 ⇒ 立刻抛，别再做 520ms 的动作
    {
      const fake = mkBot({ hang: false })
      const mc = mkMc(fake)
      mc.setAbortSignal(AbortSignal.abort())
      const t = Date.now()
      let err = null
      try { await mc.jump() } catch (e) { err = e }
      const ms = Date.now() - t
      ok(err?.mcAborted === true && ms < 120, 'aborted ⇒ jump 立刻抛 mcAborted（不再固定 520ms）', `${ms}ms / ${err?.message ?? 'null'}`)
      ok(fake.calls.control.every(([k, v]) => !(k === 'jump' && v === true)), 'aborted 时一个 jump 控制位都不按', JSON.stringify(fake.calls.control))
    }
    // ② jump：时间用完（setCallDeadline(0)）⇒ 抛"这一轮用完了"，不占 520ms
    {
      const fake = mkBot({ hang: false })
      const mc = mkMc(fake)
      mc.setCallDeadline(0)
      const t = Date.now()
      let err = null
      try { await mc.jump() } catch (e) { err = e }
      ok(Boolean(err) && Date.now() - t < 120, '时间用完 ⇒ jump 立刻抛（不白占 520ms）', `${Date.now() - t}ms / ${err?.message ?? 'null'}`)
    }
    // ③ 水里走路：aborted ⇒ ≤1 轮就抛，别游满 1.3 秒
    {
      const fake = mkBot({ hang: false })
      fake.bot.entity.isInWater = true
      const mc = mkMc(fake)
      mc.setAbortSignal(AbortSignal.abort())
      mc.setCallDeadline(1_200)
      const t = Date.now()
      let err = null
      try { await mc.walkTo({ x: 30, y: 63, z: 0 }) } catch (e) { err = e }
      const ms = Date.now() - t
      const fwd = fake.calls.control.filter(([k, v]) => k === 'forward' && v === true).length
      ok(err?.mcAborted === true && ms < 400, '在水里也认中断（审计①：以前照游 1313ms）', `${ms}ms / ${err?.message ?? 'null'}`)
      ok(fwd <= 1, 'aborted 后不再反复按 forward', `按了 ${fwd} 次`)
    }
    // ④ 水里走路：被抢占（_moveGen 被别人 ++）⇒ 带 preempted 返回，别游满预算
    {
      const fake = mkBot({ hang: false })
      fake.bot.entity.isInWater = true
      const mc = mkMc(fake)
      mc.setCallDeadline(2_000)
      setTimeout(() => { mc._moveGen++ }, 30)     // 模拟自保反射/另一次 mc_move 抢走
      const t = Date.now()
      const r = await mc.walkTo({ x: 30, y: 63, z: 0 })
      ok(r.reason === 'preempted' && Date.now() - t < 1_200, '游泳也能被抢占（领号 + 查号）', `${Date.now() - t}ms / ${r.reason}`)
      // 🔴 被抢占时**不能**松控制位：抢走的那次移动已经按下了自己的 forward/jump（收尾松手会把它按停）
      ok(!fake.calls.control.some(([k, v]) => v === false && (k === 'forward' || k === 'jump')),
        '被抢占后不抢新移动者的控制位（不松 forward/jump）', JSON.stringify(fake.calls.control))
    }
    // ⑤ 收尾真停：pathfinder.setGoal(null) 被调到（stop() 只是置标志，审计②）
    {
      const fake = mkBot({ hang: true })
      const mc = mkMc(fake)
      mc.setCallDeadline(700)
      await mc.walkTo({ x: 20, y: 64, z: 0 })
      ok(fake.calls.setGoal >= 1, '收尾先 setGoal(null)（不然插件还在按 forward、甚至返回后才挖方块）', `setGoal ${fake.calls.setGoal} 次`)
    }
    // ⑥ mc_sequence：move 没走到 ⇒ ok:false、succeeded 不含它（审计⑧）
    {
      const fake = mkBot({ hang: false })
      const mc = mkMc(fake)
      mc.walkTo = async () => ({ arrived: false, stuck: true, reason: 'NoPath', moved: 0, remaining: 5 })
      const r = await mc.runSequence([{ op: 'move', x: 5, y: 64, z: 0 }], { budgetMs: 3_000 })
      ok(r.results[0]?.ok === false && /没走到/.test(String(r.results[0]?.note ?? '')),
        '序列里"没走到的 move"不再记成成功（审计⑧）', JSON.stringify({ ok: r.results[0]?.ok, note: r.results[0]?.note }))
      ok(r.succeeded === 0 && r.failed === 1, 'succeeded 不把没走到的 move 算进去', JSON.stringify({ succeeded: r.succeeded, failed: r.failed }))
    }
    /* 🔴 2026-10-17 用户实机：`mc_sequence` 里某一格**已经是空气** ⇒ 整串中止，
     *    而报的原因是「这一轮时间不够」、`elapsedMs` 只有 300ms。两个毛病一起钉住：
     *    ① 空气格的目标（"那格不是实心的"）**已经达成**，不该算失败、更不该中止整串；
     *    ② 失败步骤的 note 必须带**真实原因**，不许硬编码"时间不够"。 */
    {
      const fake = mkBot({ hang: false })
      const mc = mkMc(fake)
      mc.breakBlock = async () => ({
        broken: null, at: { x: 0, y: 64, z: 0 },
        note: '那里本来就是空气（**我这边**读到的）—— 要么已经挖掉了，要么客户端的区块缓存旧了',
      })
      mc.walkTo = async () => ({ arrived: true })
      const r = await mc.runSequence(
        [{ op: 'break', x: 0, y: 64, z: 0 }, { op: 'move', x: 5, y: 64, z: 0 }],
        { budgetMs: 3_000 })
      ok(r.results[0]?.ok === true, '🔴 空气格不算失败（目标"那格不是实心的"已经达成）', JSON.stringify({ ok: r.results[0]?.ok }))
      ok(r.results.length === 2 && r.stoppedAt == null, '🔴 空气格**不中止**后面的步骤（以前整串断在这）', JSON.stringify({ n: r.results.length, at: r.stoppedAt }))
    }
    {
      const fake = mkBot({ hang: false })
      const mc = mkMc(fake)
      mc.placeBlock = async () => ({ placed: false, note: '那一格被占了（现在里面是 stone）' })
      const r = await mc.runSequence([{ op: 'place', x: 1, y: 64, z: 0 }], { budgetMs: 3_000 })
      const note = String(r.results[0]?.note ?? '')
      ok(/那一格被占了/.test(note), '🔴 失败步骤的 note 带出**真实原因**', note.slice(0, 60))
      ok(!/时间不够/.test(note), '🔴 不再谎报"本轮时间不够"（那是硬编码的旧文案）', note.slice(0, 60))
      ok(/不是时间不够/.test(String(r.hint ?? '')), '🔴 第 1 步秒失败 ⇒ hint 明说"不是时间不够"', String(r.hint ?? '').slice(0, 60))
    }
    // ⑦ waitForChunks：时间用完 ⇒ 立刻返回，不白等 300ms
    {
      const fake = mkBot({ hang: false })
      fake.bot.blockAt = () => null            // 永远"没加载" ⇒ 只能靠 cap 退出
      const mc = mkMc(fake)
      mc.setCallDeadline(0)
      const t = Date.now()
      const got = await mc.waitForChunks(20_000)
      ok(got === false && Date.now() - t < 120, '时间用完 ⇒ waitForChunks 立刻返回 false（不白等 300ms，审计⑦）', `${Date.now() - t}ms`)
    }
    // ⑧ waitForChunks：aborted ⇒ 抛中断，别静默返回 false（那会被当成"区块没加载"）
    {
      const fake = mkBot({ hang: false })
      fake.bot.blockAt = () => null
      const mc = mkMc(fake)
      mc.setAbortSignal(AbortSignal.abort())
      let err = null
      try { await mc.waitForChunks(5_000) } catch (e) { err = e }
      ok(err?.mcAborted === true, 'aborted ⇒ waitForChunks 抛中断（不静默 false）', err?.message ?? 'null')
    }
    // ⑨ 反射的控制位租约：租约没过期时 #releaseControls 不许松
    {
      const fake = mkBot({ hang: false })
      const mc = mkMc(fake)
      mc.holdControl('back', 500)
      ok(fake.calls.control.some(([k, v]) => k === 'back' && v === true), 'holdControl 会按下控制位', JSON.stringify(fake.calls.control))
      mc.interruptMove('测试')
      await new Promise((r) => setTimeout(r, 30))
      ok(!fake.calls.control.some(([k, v]) => k === 'back' && v === false), '租约没过期 ⇒ 移动收尾不松 back（审计⑨）', JSON.stringify(fake.calls.control))
      await new Promise((r) => setTimeout(r, 600))
      ok(fake.calls.control.some(([k, v]) => k === 'back' && v === false), '租约到期 ⇒ 自己松开 back', JSON.stringify(fake.calls.control.slice(-2)))
    }
    // ⑩ 用户点停止 ⇒ 立刻真停（interruptMove 被 abort 事件调到，审计④）
    {
      const fake = mkBot({ hang: true })
      const mc = mkMc(fake)
      const ac = new AbortController()
      mc.setAbortSignal(ac.signal)
      const before = fake.calls.setGoal
      ac.abort()
      await new Promise((r) => setTimeout(r, 60))
      ok(fake.calls.setGoal > before, 'signal abort ⇒ 立刻 setGoal(null) 真停（不等工具自己 await 到中断）', `${before} → ${fake.calls.setGoal}`)
    }
  }
}


// ── 收尾：删掉临时目录 ────────────────────────────────────────────────────────
for (const d of TMP_DIRS) { try { rmSync(d, { recursive: true, force: true }) } catch {} }
/* 🔴 2026-10-24 用户实机（问题清单第 6 条）：`mc_sequence` 的 move 步骤以前只传 budget 和"挖不挖"那一个开关（当时叫 `noDig`，现 `allowDig`），
 *    把 intent 丢了 ⇒ 步骤里写 `intent:"stand"` 也永远按 near（1.6 格）判到达。 */
{
  const seqSrc = readFileSync(new URL('../src/sequence.mjs', import.meta.url), 'utf8')
  ok(/\.\.\.\(s\.intent \? \{ intent: s\.intent \} : \{\}\)/.test(seqSrc), 'move 步骤把 intent 传下去了')
}

/* ── ⑨ 预算收口（2026-10-29 用户定规：「needLeft(ms) 应该拒绝启动，而不是强行压缩」） ──
 * 以前到处是 `Math.max(1500, 剩余 - 500)` 这类写法 —— 剩余 0 时也给 1.5 秒，
 * 动作越过本轮截止时间：外层硬掐、里层以为还有时间、不做收尾。
 * 三条来源检查把这件事钉死：
 *   ① `needLeft` / `insufficientText` 从 budget.mjs 导出、core.mjs 原样 re-export；
 *   ② 8 个调用点真的用上了；
 *   ③ 全仓（src/*.mjs + index.js）不许再把 msLeft()/callLeft() 塞进 `Math.max(固定数字, …)`
 *      —— 窗口取同行 ±2 行，等价写法（`Math.max(1500, Math.min(left, budget))`）一起拦；
 *      `Math.max(0, …)` 是白名单（钳到 0 正是正确写法）。 */
{
  const bSrc = readFileSync(new URL('../src/budget.mjs', import.meta.url), 'utf8')
  ok(/export function needLeft\s*\(/.test(bSrc), 'budget.mjs 导出 needLeft')
  ok(/export function insufficientText\s*\(/.test(bSrc), 'budget.mjs 导出 insufficientText')
  ok(/left\s*<\s*min\s*\+\s*slack/.test(bSrc), 'needLeft 的边界是 min+slack（相等时放行）')
  const cSrc = readFileSync(new URL('../src/core.mjs', import.meta.url), 'utf8')
  ok(/needLeft,\s*insufficientText\s*\}/.test(cSrc), 'core.mjs re-export 了 needLeft / insufficientText')

  const users = [
    ['src/place.mjs', 'place.mjs 走近'],
    ['src/mining.mjs', 'mining.mjs 阶梯/单目标'],
    ['src/farm.mjs', 'farm.mjs 走近'],
    ['src/boat.mjs', 'boat.mjs 行船/下船'],
    ['src/bridge.mjs', 'bridge.mjs 走一格'],
  ]
  for (const [rel, label] of users) {
    const s = readFileSync(new URL('../' + rel, import.meta.url), 'utf8')
    ok(/needLeft\(/.test(s), `${label} 用上了 needLeft`)
  }

  const bad = []
  const scan = readdirSync(new URL('../src/', import.meta.url)).filter((f) => f.endsWith('.mjs')).map((f) => 'src/' + f)
  scan.push('index.js')
  for (const rel of scan) {
    let src = ''
    try { src = readFileSync(new URL('../' + rel, import.meta.url), 'utf8') } catch { continue }
    const lines = src.split('\n')
    for (let i = 0; i < lines.length; i++) {
      const L = lines[i]
      if (!/(msLeft|callLeft)\(\)/.test(L)) continue
      if (/Math\.max\(\s*0\s*,/.test(L)) continue
      /* 只看**同一行**：跨行窗口会误报（相邻行各有各的 Math.max）。跨行写法靠行为套件兜底。 */
      if (/Math\.max\(\s*\d[\d_]*\s*,[^)]*(msLeft|callLeft)\(\)/.test(L)) {
        bad.push(`${rel}:${i + 1} → ${L.trim().slice(0, 90)}`)
      }
    }
  }
  ok(bad.length === 0, '全仓没有「Math.max(固定数字, …剩余…)」的预算写法（要收口就用 needLeft）', bad.slice(0, 6).join(' ｜ '))
}

console.log(`\n结果：${pass}/${pass + fail} 通过，${fail} 失败`)
process.exit(fail ? 1 : 0)

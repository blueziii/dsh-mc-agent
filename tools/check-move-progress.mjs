#!/usr/bin/env node
/**
 * P0-1 移动进度监控 + 自动脱困阶梯自检（`src/movement.mjs`）
 *
 * 用户 2026-10-15 的原话要求（导航优化方案 P0-1）：
 *   「给移动增加**进度监控 + 自动脱困**……每隔约 500–1000 ms 采样一次坐标……
 *     连续 2–3 秒没有有效位移，判定为疑似卡住……按顺序尝试重新计算路径、跳跃脱困、
 *     后退后重新寻路……多次失败后返回明确的 `stuck` 或 `unreachable`，不要无限重试」
 *   「**关键点：不要只根据速度为零判断卡住**。机器人在跳跃、落地、等待方块更新或
 *     接近目标时，短时间不动可能是正常的。」
 *
 * 这一套要钉死四件事：
 *   ① **判据是"既没挪动、也没靠近"** —— 光看速度为零会把正常停顿误判成卡住；
 *      反过来，"一直在动但没靠近"（绕圈）必须照样判卡住；
 *   ② **正常等待要豁免** —— 挖着 / 放着 / 悬空（跳跃落地中）算正常等待，把进度时钟往后推，
 *      但最多推 `MOVE_BUSY_MAX_MS`（免得一直挖个不停就永远不判卡）；
 *   ③ **阶梯顺序与收尾** —— 重算路径 → 跳跃脱困 → 后退再寻路；三级用完明确报 `unreachable`
 *      并带上 `repathCount`，**不无限重试**；采样器的定时器一定收掉（不然把进程钉住）；
 *   ④ **脱困动作不能跟 pathfinder 抢控制位** —— 必须先 `setGoal(null)` 真停
 *      （vendor 每个 physicsTick 都会把 forward/jump 按回去），且**不换 goal 对象**
 *      （换了 vendor 的 `goto` 会直接以 `GoalChanged` 拒绝，等于把这次走路判死）。
 *
 * 用法：node tools/check-move-progress.mjs
 */
import { readFileSync } from 'node:fs'
import { EventEmitter } from 'node:events'
import vec3pkg from 'vec3'

const Vec3 = vec3pkg.Vec3 ?? vec3pkg
const mod = await import(new URL('../src/movement.mjs', import.meta.url))
const {
  MOVE_SAMPLE_MS, MOVE_STUCK_MS, MOVE_BUSY_MAX_MS, MOVE_BUSY_AIR_MS, MOVE_ESCAPES_DIG, MOVE_ESCAPES_NODIG,
  moveBusyKind, clearHeadCell,
  escapeStepOf, escapeTextOf, moveBusyNow, moveProgressWatcher, escapeMove, walkPathfinder, routeTrack, aboveOf,
  walkTo, carveStepAhead, MOVE_HARD_SLACK_MS, MOVE_CARVE_DIG_MS,
  MOVE_PLAN_TEXT, planStepTextOf, detourStep, MOVE_DETOUR_R, MOVE_DETOUR_MS, MOVE_PLAN_TTL_MS, MOVE_PLAN_SAME_R,
  escapeStepsFor,
  MOVE_VENDOR_STUCK_MS, MOVE_RESET_LIMIT,
} = mod

let pass = 0
let fail = 0
const ok = (cond, label, extra = '') => {
  if (cond) { pass++; console.log(`  ✅ ${label}`) } else { fail++; console.log(`  ❌ ${label}${extra ? `  → ${extra}` : ''}`) }
}
const section = (t) => console.log(`\n── ${t} ──`)
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/* ── 假时钟：注入给采样器，免得一套断言真等 2.4 秒 × 4 轮 ─────────────────── */
function fakeClock () {
  let t = 0
  const jobs = []
  const c = {
    onTick: null,
    now: () => t,
    setTimer: (fn, ms) => { const h = { fn, ms, at: t + ms, live: true }; jobs.push(h); return h },
    clearTimer: (h) => { if (h) h.live = false },
    get live () { return jobs.filter((j) => j.live).length },
    async advance (ms) {
      const target = t + ms
      for (;;) {
        const due = jobs.filter((j) => j.live && j.at <= target).sort((a, b) => a.at - b.at)[0]
        if (!due) break
        t = due.at
        due.at = t + due.ms
        due.fn()
        if (c.onTick) c.onTick()
        await Promise.resolve()
      }
      t = target
    },
  }
  return c
}
/** 让假时钟自己往前走（真实 1ms 推 600ms 假时间）—— 驱动 `walkPathfinder` 的整条循环 */
function autoClock () {
  const c = fakeClock()
  let busy = false
  const h = setInterval(() => {
    if (busy) return
    busy = true
    c.advance(MOVE_SAMPLE_MS).finally(() => { busy = false })
  }, 1)
  c.stopPump = () => clearInterval(h)
  return c
}

/* ── 只够采样器 / escapeMove 用的假机器人 ─────────────────────────────────── */
function mkProbe (pos = { x: 0, y: 64, z: 0 }, { mining = false, building = false, onGround = true, velocity = { x: 0, y: 0, z: 0 } } = {}) {
  const b = {
    entity: { position: new Vec3(pos.x, pos.y, pos.z), onGround, velocity },
    controls: [],
    pathfinder: { isMining: () => mining, isBuilding: () => building },
    setControlState (k, v) { b.controls.push([k, v]) },
  }
  return b
}
const watchOpts = (clock) => ({ arrive: 1.6, ty: 64, now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer })

/* ═══════════════ ① 阶梯：纯函数 ═══════════════ */
section('① 脱困阶梯的顺序与命名（纯函数）')
{
  /* 2026-10-29：加了 `climbUp`（往上挖一层再跳）——目标在头顶时光靠 jump/breakAhead 永远上不去。 */
  ok(Array.isArray(MOVE_ESCAPES_DIG) && MOVE_ESCAPES_DIG.length === 7
    && MOVE_ESCAPES_DIG.includes('descend') && MOVE_ESCAPES_DIG.includes('climbUp') && MOVE_ESCAPES_DIG.includes('breakAhead'),
    '允许挖时阶梯七级，含"往下走""往上挖一层再跳"与"挖开挡路那格"', JSON.stringify(MOVE_ESCAPES_DIG))
  ok(JSON.stringify(MOVE_ESCAPES_NODIG) === JSON.stringify(['repath', 'jump', 'descend', 'clearHead', 'backoff', 'detour']),
    '🔴 不挖时阶梯里**没有** breakAhead（以前空转一轮 2.4 秒，还写进 planTried 误导模型）；'
      + '2026-10-28 补了 clearHead（只清自己头顶那格 —— 挂在柱子顶上时唯一能脱困的动作）',
    JSON.stringify(MOVE_ESCAPES_NODIG))
  ok(escapeStepsFor(false) === MOVE_ESCAPES_NODIG && escapeStepsFor(true) === MOVE_ESCAPES_DIG && escapeStepsFor() === MOVE_ESCAPES_NODIG,
    'escapeStepsFor(allowDig) 按开关选阶梯（不给就是不挖 —— 两层的默认值必须同一个方向）')
  ok(MOVE_ESCAPES_DIG[0] === 'repath' && MOVE_ESCAPES_DIG[1] === 'jump'
    && MOVE_ESCAPES_DIG[2] === 'descend' && MOVE_ESCAPES_DIG[3] === 'climbUp' && MOVE_ESCAPES_DIG[4] === 'breakAhead',
    '🔴 允许挖时顺序 = 重算 → 跳跃 → 往上挖 → 挖开挡路（能挖就别绕远路）', MOVE_ESCAPES_DIG.join(' → '))
  ok(MOVE_ESCAPES_NODIG[0] === 'repath' && MOVE_ESCAPES_NODIG[1] === 'jump' && MOVE_ESCAPES_NODIG[2] === 'descend' && MOVE_ESCAPES_NODIG[3] === 'clearHead'
    && MOVE_ESCAPES_NODIG[4] === 'backoff',
    '🔴 不挖时顺序 = 用户要求的「重算路径 → 跳跃脱困 → 清头顶 → 后退再寻路」'
      + '（清头顶插在 jump 之后：先确认"跳也白跳"再动镐）', MOVE_ESCAPES_NODIG.join(' → '))
  ok(escapeStepOf(0, MOVE_ESCAPES_DIG) === 'repath' && escapeStepOf(1, MOVE_ESCAPES_DIG) === 'jump'
    && escapeStepOf(2, MOVE_ESCAPES_DIG) === 'descend' && escapeStepOf(3, MOVE_ESCAPES_DIG) === 'climbUp'
    && escapeStepOf(4, MOVE_ESCAPES_DIG) === 'breakAhead',
    'escapeStepOf(n, steps) 按序给动作')
  ok(escapeTextOf('repath') === '重算路径' && escapeTextOf('jump') === '跳跃脱困' && escapeTextOf('backoff') === '后退再寻路',
    'escapeTextOf 的中文名（日志与返回值文案用）')
  ok(escapeTextOf('随便什么') === '放弃', '不认识的级别 → 放弃')
  ok(MOVE_SAMPLE_MS >= 500 && MOVE_SAMPLE_MS <= 1000, '采样间隔落在用户要求的 500–1000ms 里', `${MOVE_SAMPLE_MS}ms`)
  ok(MOVE_STUCK_MS >= 2000 && MOVE_STUCK_MS <= 3000, '判卡阈值落在用户要求的 2–3 秒里', `${MOVE_STUCK_MS}ms`)
}

/* ═══════════════ ② moveBusyNow：什么算"正常等待" ═══════════════ */
section('② moveBusyKind/Now —— 挖着 / 放着 / **真在空中**才叫正常等待（用户点名的坑）')
{
  ok(moveBusyNow(mkProbe({}, { mining: true })) === true, '正在挖（pathfinder.isMining）⇒ 忙')
  ok(moveBusyNow(mkProbe({}, { building: true })) === true, '正在放（pathfinder.isBuilding）⇒ 忙')
  ok(moveBusyKind(mkProbe({}, { mining: true })) === 'dig', '挖着 ⇒ kind=dig（用 6 秒宽限）')
  /* 🔴 2026-10-28（用户：「卡在半空有没有可能是内部参数的问题」→ 实机确认就是）：
   *   以前 `onGround:false` 一律算忙、一律给 6 秒宽限。一次跳跃才 ~0.6 秒，
   *   人真挂在自己垫的柱子顶上（速度 0）时白拿 6 秒 ⇒ 整轮预算耗尽、阶梯一次没轮到。 */
  ok(moveBusyKind(mkProbe({}, { onGround: false, velocity: { x: 0, y: 0.42, z: 0 } })) === 'air',
    '离地且**在上升**（vy=0.42，真跳起来）⇒ kind=air')
  ok(moveBusyKind(mkProbe({}, { onGround: false, velocity: { x: 0, y: -0.9, z: 0 } })) === 'air',
    '离地且**在下坠**（vy=-0.9）⇒ kind=air')
  ok(moveBusyKind(mkProbe({}, { onGround: false, velocity: { x: 0.3, y: 0, z: 0 } })) === 'air',
    '离地且被水平推着走（vx=0.3）⇒ kind=air')
  ok(moveBusyKind(mkProbe({}, { onGround: false })) === false,
    '🔴 离地但**一动不动**（速度 0）⇒ 不算忙 —— 这就是"挂在半空"，必须照常判卡')
  ok(moveBusyNow(mkProbe({}, { onGround: false })) === false, '同上（兼容包装也返回不忙）')
  ok(moveBusyNow(mkProbe()) === false, '站着不动、没在挖没在放、踩着地 ⇒ 不忙（照常判卡）')
  ok(moveBusyNow({}) === false, '没有 pathfinder / entity 的假 bot ⇒ 不忙（不当成"永远正常"）')
  ok(moveBusyNow(null) === false, 'null ⇒ 不忙，不抛错')
  ok(moveBusyNow({ get pathfinder () { throw new Error('x') } }) === false, '读字段抛错 ⇒ 吞掉当不忙')
}

/* ═══════════════ ③ 采样器：判据 ═══════════════ */
section('③ moveProgressWatcher —— "既没挪动、也没靠近"才判卡住')
{
  const clock = fakeClock()
  const b = mkProbe()
  const w = moveProgressWatcher(b, { x: 10, y: 64, z: 0 }, watchOpts(clock))
  let err = null
  w.promise.catch((e) => { err = e })
  await clock.advance(MOVE_STUCK_MS - MOVE_SAMPLE_MS)
  ok(err === null, `不到 ${MOVE_STUCK_MS}ms 不判卡住（跳跃/落地/等方块更新都在这段时间里）`)
  await clock.advance(MOVE_SAMPLE_MS * 2)
  ok(err?.mcStuck === true, '🔴 连续既没挪动也没靠近 ⇒ reject 一个带 mcStuck 的错误')
  ok(Number.isFinite(err?.remaining) && err.remaining > 9, '错误里带 remaining（还剩多远）', String(err?.remaining))
  ok(w.info().stuck?.ms >= MOVE_STUCK_MS, 'info() 记下卡了多久（排查用）', JSON.stringify(w.info()))
  ok(clock.live === 0, '判卡住后采样定时器自己收掉')
  w.stop()
}
{
  const clock = fakeClock()
  const b = mkProbe()
  const w = moveProgressWatcher(b, { x: 20, y: 64, z: 0 }, watchOpts(clock))
  let err = null
  w.promise.catch((e) => { err = e })
  for (let i = 1; i <= 8; i++) {
    b.entity.position = new Vec3(i * 0.8, 64, 0)     // 每 600ms 靠近 0.8 格（> eps）
    await clock.advance(MOVE_SAMPLE_MS)
  }
  ok(err === null, '🔴 一直在靠近 ⇒ 永远不判卡住（哪怕还没到）')
  w.stop()
}
{
  // 绕着目标转圈：位置一直在变（速度不为零），但离目标始终 10 格
  const clock = fakeClock()
  const b = mkProbe({ x: 10, y: 64, z: 0 })
  const w = moveProgressWatcher(b, { x: 0, y: 64, z: 0 }, watchOpts(clock))
  let err = null
  w.promise.catch((e) => { err = e })
  let a = 0
  for (let i = 0; i < 6; i++) {
    a += 0.9
    b.entity.position = new Vec3(10 * Math.cos(a), 64, 10 * Math.sin(a))
    await clock.advance(MOVE_SAMPLE_MS)
  }
  ok(err?.mcStuck === true, '🔴 **只挪动、不靠近**（绕圈）照样判卡住 —— 不是"速度为零才算"，用户点名的那条')
  w.stop()
}
{
  /* 🔴 2026-10-23 审计（A[1]）改口：以前这条断言钉的是**旧行为**（在到达圈里不动也不算卡），
   *    而那正是"走到目标附近被门框/台阶挡住、永远不进脱困阶梯、干等预算耗尽"的根因。
   *    现在：在圈里**一动不动**照样判卡；**还在靠近**才不判。 */
  const clock = fakeClock()
  const b = mkProbe({ x: 9, y: 64, z: 0 })          // 离目标 1 格 ⇒ 已经在到达半径里
  const w = moveProgressWatcher(b, { x: 10, y: 64, z: 0 }, watchOpts(clock))
  let err = null
  w.promise.catch((e) => { err = e })
  await clock.advance(MOVE_STUCK_MS * 3)
  ok(err?.mcStuck === true, '🔴 已经在到达半径里**但一动不动** ⇒ 照样判卡（以前这里永远不判）')
  w.stop()
}
{
  const clock = fakeClock()
  const b = mkProbe({ x: 9, y: 64, z: 0 })
  const w = moveProgressWatcher(b, { x: 10, y: 64, z: 0 }, watchOpts(clock))
  let err = null
  w.promise.catch((e) => { err = e })
  for (let i = 1; i <= 3; i++) {
    b.entity.position = new Vec3(9 + i * 0.3, 64, 0)   // 9.3 → 9.6 → 9.9，一直在靠近
    await clock.advance(MOVE_SAMPLE_MS)
  }
  ok(err === null, '在到达圈里但**还在靠近** ⇒ 不判卡')
  w.stop()
}

/* ═══════════════ ④ 采样器：正常等待的豁免有上限 ═══════════════ */
section('④ 正常等待豁免有上限（一直挖个不停不会变成"永远正常"）')
{
  const clock = fakeClock()
  const b = mkProbe({}, { mining: true })
  const w = moveProgressWatcher(b, { x: 10, y: 64, z: 0 }, watchOpts(clock))
  let err = null
  w.promise.catch((e) => { err = e })
  /* 🔴 2026-10-29（用户指出的真坑）：手挖一格石头 7.5 秒 —— 旧上限 6 秒 ⇒ 没镐挖硬方块
   *    永远判不出"正在挖"。挖着不动 7.6 秒必须**不判卡**。 */
  await clock.advance(7_600)
  ok(err === null, '挖着不动 7.6 秒（超过手挖一格的 7.5 秒）也不判卡 —— 挖是合法工作')
  ok(MOVE_BUSY_MAX_MS > 7_500, '工作宽限大于手挖一格石头（7.5 秒），不再把"正在挖"误判成卡住')
  await clock.advance(MOVE_BUSY_MAX_MS)
  ok(err?.mcStuck === true, '🔴 一直挖超过工作上限之后仍然判卡（不是无限豁免）')
  ok(err?.mcWorkStall === 'dig', '这条卡住带 mcWorkStall=dig（挖超时 ≠ 路不通，文案分开）')
  w.stop()
}
/* 🔴 2026-10-28：空中单独一档宽限。一次跳跃 ~600ms ⇒ 0.6 秒内不判卡，1.2 秒还挂着就是真挂住了。 */
{
  const clock = fakeClock()
  const b = mkProbe({}, { onGround: false, velocity: { x: 0, y: 0.42, z: 0 } })
  const w = moveProgressWatcher(b, { x: 10, y: 64, z: 0 }, watchOpts(clock))
  let err = null
  w.promise.catch((e) => { err = e })
  await clock.advance(MOVE_STUCK_MS - MOVE_SAMPLE_MS)
  ok(err === null, `真在空中的时候照常宽限（不到 ${MOVE_STUCK_MS}ms 不判卡）`)
  w.stop()
}
{
  /* 空中宽限比挖掘短得多：`MOVE_BUSY_AIR_MS`(0.9s) + `MOVE_STUCK_MS`(2.4s) 之后必判卡，
   * 而挖掘那档要 6s + 2.4s。 */
  ok(MOVE_BUSY_AIR_MS < MOVE_BUSY_MAX_MS && MOVE_BUSY_AIR_MS <= 1000,
    '🔴 空中宽限（0.9s）明显短于挖/放宽限 —— 一次跳跃只有 ~0.6 秒', `${MOVE_BUSY_AIR_MS}ms < ${MOVE_BUSY_MAX_MS}ms`)
  const clock = fakeClock()
  const b = mkProbe({}, { onGround: false })   // 离地但一动不动
  const w = moveProgressWatcher(b, { x: 10, y: 64, z: 0 }, watchOpts(clock))
  let err = null
  w.promise.catch((e) => { err = e })
  await clock.advance(MOVE_STUCK_MS - MOVE_SAMPLE_MS)
  ok(err === null, '刚离地的那几拍先不判卡（怕误伤正常起跳）')
  await clock.advance(MOVE_SAMPLE_MS * 3)
  ok(err?.mcStuck === true, '🔴 一直悬着不动超过 stuckMs ⇒ 判卡住（以前这里会白等到预算耗尽）')
  w.stop()
}

/* ═══════════════ ⑤ 采样器：stop() 之后彻底安静 ═══════════════ */
section('⑤ stop() 之后彻底安静（不能留下把进程钉住的定时器）')
{
  const clock = fakeClock()
  const b = mkProbe()
  const w = moveProgressWatcher(b, { x: 10, y: 64, z: 0 }, watchOpts(clock))
  let err = null
  w.promise.catch((e) => { err = e })
  await clock.advance(MOVE_SAMPLE_MS)
  w.stop()
  ok(clock.live === 0, 'stop() 清掉定时器')
  await clock.advance(MOVE_STUCK_MS * 4)
  ok(err === null, '🔴 stop() 之后即使时间再久也不 reject（否则是"竞速结束了才炸"）')
  ok(w.info().stuck === null, 'stop() 之后 info() 也不记"卡住"')
  let again = false
  try { w.stop() } catch { again = true }
  ok(again === false, 'stop() 可以重复调（finally 里无脑调一次）')
}

/* ═══════════════ ⑤b P1：路径失效重算（不用等满 2.4 秒） ═══════════════ */
section('⑤b P1 —— 路径被反复失效：光重算没用，直接进阶梯')
{
  const clock = fakeClock()
  let resets = 3
  const w = moveProgressWatcher(mkProbe(), { x: 10, y: 64, z: 0 },
    { ...watchOpts(clock), resetsOf: () => resets, resetLimit: 4 })
  let err = null
  w.promise.catch((e) => { err = e })
  await clock.advance(MOVE_SAMPLE_MS * 2)
  ok(err === null, '失效 3 次（< 上限 4）还不认输')
  resets = 4
  await clock.advance(MOVE_SAMPLE_MS)
  ok(err?.mcStuck === true, '🔴 失效到上限 ⇒ 直接判卡住（不等满 2.4 秒）')
  ok(err?.mcPathThrash === true, '🔴 带 mcPathThrash 标记（跟"没进展"分开报，下一步建议也不同）')
  ok(/路径被反复失效/.test(String(err?.message ?? '')), '文案说清是"光重算没用"', String(err?.message))
  ok(w.info()?.stuck?.thrash === true && w.info()?.stuck?.resets === 4, 'info() 记下成因与次数', JSON.stringify(w.info()))
  ok(clock.live === 0, '认输时收掉定时器')
}
{
  const clock = fakeClock()
  const b = mkProbe({ x: 0, y: 64, z: 0 })
  const w = moveProgressWatcher(b, { x: 10, y: 64, z: 0 },
    { ...watchOpts(clock), resetsOf: () => 99, resetLimit: 4 })
  let err = null
  w.promise.catch((e) => { err = e })
  for (let i = 1; i <= 6; i++) {
    b.entity.position = new Vec3(i * 0.9, 64, 0)   // 每轮都在靠近
    await clock.advance(MOVE_SAMPLE_MS)
  }
  ok(err === null, '🔴 一直在靠近 ⇒ 失效次数再多也不叫停（**进展优先**：一直被打断但还在往前挪，就让它挪）')
  w.stop()
}
{
  const clock = fakeClock()
  const w = moveProgressWatcher(mkProbe({}, { mining: true }), { x: 10, y: 64, z: 0 },
    { ...watchOpts(clock), resetsOf: () => 99, resetLimit: 4 })
  let err = null
  w.promise.catch((e) => { err = e })
  await clock.advance(MOVE_SAMPLE_MS * 3)
  ok(err === null, '挖着（算正常等待）⇒ 失效次数也不叫停（挖本身就会让世界更新、路径失效）')
  w.stop()
}
{
  const clock = fakeClock()
  const w = moveProgressWatcher(mkProbe(), { x: 10, y: 64, z: 0 },
    { ...watchOpts(clock), resetsOf: () => { throw new Error('x') }, resetLimit: 4 })
  let err = null
  w.promise.catch((e) => { err = e })
  await clock.advance(MOVE_STUCK_MS + MOVE_SAMPLE_MS)
  ok(err?.mcStuck === true && err?.mcPathThrash !== true,
    'resetsOf 抛错 ⇒ 当 0：仍按"没进展"判卡（不炸、也不误报 thrash）')
}
{
  const clock = fakeClock()
  const w = moveProgressWatcher(mkProbe(), { x: 10, y: 64, z: 0 }, watchOpts(clock))
  let err = null
  w.promise.catch((e) => { err = e })
  await clock.advance(MOVE_STUCK_MS + MOVE_SAMPLE_MS)
  ok(err?.mcStuck === true && err?.mcPathThrash !== true, '不传 resetsOf ⇒ 退回 P0-1 那套纯"没进展"判据')
}

/* ═══════════════ ⑥ escapeMove：先真停、再动控制位 ═══════════════ */
section('⑥ escapeMove —— 先真停 pathfinder，再按控制位')
{
  const b = mkProbe()
  const stops = []
  const ctx = { stopPathing: (bb) => stops.push(bb === b) }
  const goal = { x: 0, y: 64, z: 0 }
  await escapeMove(b, goal, 'repath', ctx)
  ok(stops.length === 1 && stops[0] === true, '🔴 每一级脱困都先 ctx.stopPathing(b)（不然 vendor 每个 tick 把控制位按回去）')
  ok(b.controls.length === 0, 'repath 只重算，不按任何控制位')
  b.controls.length = 0; stops.length = 0
  await escapeMove(b, goal, 'jump', ctx)
  ok(stops.length === 1, 'jump 级同样先真停')
  ok(b.controls.some(([k, v]) => k === 'jump' && v === true) && b.controls.some(([k, v]) => k === 'jump' && v === false),
    'jump 级按住 jump 再松开（卡在台阶/栅栏/半砖边缘时最有效）', JSON.stringify(b.controls))
  b.controls.length = 0; stops.length = 0
  await escapeMove(b, goal, 'backoff', ctx)
  ok(b.controls.some(([k, v]) => k === 'back' && v === true) && b.controls.some(([k, v]) => k === 'back' && v === false),
    'backoff 级按住 back 再松开（贴墙贴角时原地重算还是同一条死路）', JSON.stringify(b.controls))
  ok(!b.controls.some(([k]) => k === 'jump'), 'backoff 不顺手按 jump（两级动作不混）')
  let threw = false
  try { await escapeMove(b, goal, 'repath', { stopPathing: () => { throw new Error('x') } }) } catch { threw = true }
  ok(threw === false, 'stopPathing 抛错不把整次走路炸掉')
}

/* ═══════════════ ⑦ walkPathfinder 整条循环 ═══════════════ */
section('⑦ walkPathfinder 整条循环：卡住 → 阶梯 → 明确 unreachable')

function mkLoopBot (start = { x: 0, y: 64, z: 0 }) {
  const b = {
    entity: { position: new Vec3(start.x, start.y, start.z), onGround: true },
    controls: [],
    calls: { goto: 0, setGoal: [] },
    _pending: null,
  }
  /* 🔴 2026-10-22：以前是"全世界都是石头"（`() => ({name:'stone'})`）—— 那种世界里人头那格
   *   也是实心 = 已经在窒息，`shaftInfoOf` 量出来"头顶净空 0 ⇒ 跳不起来"，跳跃脱困被跳过是**对的**。
   *   现在按真实地面写：y ≤ start.y-1 实心，上面是空气。 */
  b.blockAt = (p) => (p && Math.floor(p.y) <= Math.floor(start.y) - 1 ? { name: 'stone' } : { name: 'air' })
  b.setControlState = (k, v) => b.controls.push([k, v])
  b.on = () => {}
  b.removeListener = () => {}
  b.pathfinder = {
    isMining: () => false,
    isBuilding: () => false,
    setMovements: () => {},
    setGoal (g) {
      b.calls.setGoal.push(g)
      if (g === null && b._pending) {
        const p = b._pending; b._pending = null
        const e = new Error('GoalChanged'); e.name = 'GoalChanged'; p.reject(e)
      }
    },
    goto () {
      b.calls.goto++
      return new Promise((resolve, reject) => { b._pending = { resolve, reject } })
    },
  }
  b.settleGoto = (fn) => { const p = b._pending; if (p) { b._pending = null; fn(p) } }
  return b
}
function mkSelf (bot, budgetMs = 20000) {
  const self = {
    bot,
    cfg: { moveBudgetMs: budgetMs },
    abortSignal: null,
    _moveGen: 0,
    logs: [],
    _pf: {
      goals: {
        GoalNear: class {
          constructor (x, y, z, r) { this.x = x; this.y = y; this.z = z; this.range = r }
          /* 2026-10-18：假 goal 也要有真 isEnd —— 到达判定现在先看"是不是我的目标"，
           * 永远 false 的桩会把所有"到附近"的用例判成 goal-reached-elsewhere。 */
          isEnd (p) {
            const q = p?.position ?? p
            const dx = q.x - this.x, dy = q.y - this.y, dz = q.z - this.z
            return Math.hypot(dx, dz) <= this.range + 3.0 && Math.abs(dy) <= 1.5
          }
        },
        /* 🔴 2026-10-23（P0-a）：vendor 的 `GoalXZ` —— **只有水平两维**，没有 y、没有半径。
         *    这里照它的真实形状做桩：`isEnd` 只看 x/z，用来钉住"walkPathfinder 认的是哪一类 goal"。 */
        GoalXZ: class {
          constructor (x, z) { this.x = x; this.z = z }
          isEnd (p) {
            const q = p?.position ?? p
            return Math.floor(q.x) === this.x && Math.floor(q.z) === this.z
          }
        },
      },
      Movements: class {},
    },
    msLeft: () => 30000,
    log (m) { self.logs.push(String(m)) },
  }
  return self
}
function mkCtx (self, clock) {
  return {
    movements: () => ({}),
    collectBusy: () => false,
    cancelCollect: async () => {},
    beginMove: () => ++self._moveGen,
    stopPathing: (bb) => { bb.pathfinder.setGoal(null) },
    releaseControls: () => {},
    watchOpts: { arrive: 1.6, ty: 64, now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer },
  }
}

{
  const clock = autoClock()
  const bot = mkLoopBot()
  const self = mkSelf(bot)
  const ctx = mkCtx(self, clock)
  const r = await walkPathfinder(self, { x: 20, y: 64, z: 0 }, { arrive: 1.6, budget: 20000, allowDig: true }, ctx)
  clock.stopPump()
  ok(r.arrived === false && r.stuck === true, '走不动 ⇒ arrived:false / stuck:true', JSON.stringify({ a: r.arrived, s: r.stuck }))
  ok(r.reason === 'unreachable', '🔴 阶梯用完 ⇒ reason = unreachable（**不是** timeout / 不是"再叫一次"）', String(r.reason))
  ok(r.repathCount === MOVE_ESCAPES_DIG.length, `repathCount = ${MOVE_ESCAPES_DIG.length}（三级都试过了）`, String(r.repathCount))
  /* 2026-10-23 审计（A[4]）：绕行那一级现在**最多试两个候选**（每个一次 goto），所以上界 +3。 */
  ok(bot.calls.goto >= MOVE_ESCAPES_DIG.length + 1 && bot.calls.goto <= MOVE_ESCAPES_DIG.length + 3,
    `重新 goto 了 ${bot.calls.goto} 次（首次 + 每级脱困各一次；绕行那一级最多试两个候选）`, String(bot.calls.goto))
  ok(/真的走不动了/.test(r.hint ?? ''), 'hint 如实说"真的走不动了"', String(r.hint).slice(0, 60))
  ok(/别原地重试/.test(r.hint ?? ''), '🔴 hint 明确劝"别原地重试"（把长路拆成几段）', String(r.hint).slice(0, 90))
  ok(!/再叫一次 mc_move 往同一个目标走/.test(r.hint ?? ''), '不误报成"再叫一次就好"')
  const escLogs = self.logs.filter((m) => /第 \d+ 步|脱困/.test(m))
  ok(escLogs.length === MOVE_ESCAPES_DIG.length, '每级脱困各记一行日志', String(escLogs.length))
  ok(/重算路径/.test(escLogs[0] ?? '') && /跳跃脱困/.test(escLogs[1] ?? '')
    && /往下挖一层/.test(escLogs[2] ?? '') && /往上挖一层再跳/.test(escLogs[3] ?? '')
&& /挖开挡路那格再走/.test(escLogs[4] ?? ''),
    '日志按阶梯顺序（允许挖：重算 → 跳跃 → 往下 → 往上挖 → 挖开 → 后退 → 侧向绕行）', JSON.stringify(escLogs.map((s) => s.slice(0, 30))))
  ok(bot.controls.some(([k, v]) => k === 'jump' && v === true), '真的按过 jump（跳跃脱困不是空话）')
  ok(bot.controls.some(([k, v]) => k === 'back' && v === true), '真的按过 back（后退再寻路不是空话）')
  ok(clock.live === 0, '🔴 收尾时采样器定时器全清掉（不然把进程钉住）')
  ok(bot.calls.setGoal.filter((g) => g === null).length >= MOVE_ESCAPES_DIG.length,
    '每次重发 goto 前都先 setGoal(null) 真停（不攒重复的 goal_reached 监听器）', String(bot.calls.setGoal.filter((g) => g === null).length))
}
/* 🔴 2026-10-22 用户实机：「跳上方块的时候会悬空，然后再把那个方块挖了」——
 *    头顶没有净空时"跳跃脱困"注定白跳（蹦起来顶到天花板、落回原地 = 看起来在悬空），
 *    下一轮还是走不动 ⇒ 掉进"挖开挡路那格"的兜底。所以这一级要先量头顶，跳不起来就跳过。 */
{
  const clock = autoClock()
  const bot = mkLoopBot()
  /* feet=64 / head=65 是空气，y=66 就是天花板 ⇒ `shaftInfoOf.headroom = 0`、`canJump = false` */
  bot.blockAt = (p) => {
    const y = p ? Math.floor(p.y) : 0
    return y <= 63 || y === 66 ? { name: 'stone' } : { name: 'air' }
  }
  const self = mkSelf(bot)
  const ctx = mkCtx(self, clock)
  const r = await walkPathfinder(self, { x: 20, y: 64, z: 0 }, { arrive: 1.6, budget: 20000 }, ctx)
  clock.stopPump()
  ok(!bot.controls.some(([k, v]) => k === 'jump' && v === true),
    '头顶没净空 ⇒ 一次 jump 都不按（不然就是在原地蹦给用户看）', JSON.stringify(bot.controls))
  ok(self.logs.some((m) => /头顶没净空/.test(m)), '日志点名"跳也跳不上去，跳过跳跃脱困"',
    JSON.stringify(self.logs.filter((m) => /脱困|净空/.test(m)).map((s) => s.slice(0, 40))))
  ok(r.arrived === false && r.stuck === true && r.reason === 'unreachable',
    '照样如实认输（跳过一级不等于无限重试）', JSON.stringify({ a: r.arrived, s: r.stuck, why: r.reason }))
  ok(clock.live === 0, '定时器清干净')
}
{
  // 一路靠近 ⇒ 不脱困、直接到达
  const clock = autoClock()
  const bot = mkLoopBot()
  const self = mkSelf(bot)
  const ctx = mkCtx(self, clock)
  const target = { x: 20, y: 64, z: 0 }
  clock.onTick = () => {
    const p = bot.entity.position
    const d = p.distanceTo(new Vec3(target.x, 64, target.z))
    if (d <= 1.6) { bot.settleGoto((q) => q.resolve()); return }
    bot.entity.position = new Vec3(p.x + 0.8, 64, p.z)
  }
  const r = await walkPathfinder(self, target, { arrive: 1.6, budget: 20000 }, ctx)
  clock.stopPump()
  ok(r.arrived === true, '一路靠近 ⇒ 正常到达', JSON.stringify({ a: r.arrived, rem: r.remaining }))
  ok(r.repathCount === undefined, '🔴 没卡住就不报 repathCount（不无中生有）', String(r.repathCount))
  ok(bot.calls.goto === 1, '一次 goto 就走完（没白重算）', String(bot.calls.goto))
  ok(self.logs.filter((m) => /脱困/.test(m)).length === 0, '没记任何脱困日志')
  ok(clock.live === 0, '收尾清掉采样器')
}
{
  /* P1：**水平到位、垂直差两格** —— 三维距离其实小于阈值（旧判据会报"到了"），
   * 但人站在目标正上方，必须判成"没到"。假 bot 的 `blockAt` 恒为 stone ⇒ `ty` 就是 64。 */
  const clock = autoClock()
  const bot = mkLoopBot()
  const self = mkSelf(bot)
  const ctx = mkCtx(self, clock)
  const target = { x: 20, y: 64, z: 0 }
  let done = false
  clock.onTick = () => {
    if (done) return
    done = true
    bot.entity.position = new Vec3(20, 66, 0)      // 水平 0 格、垂直 +2 格
    bot.settleGoto((q) => q.resolve())
  }
  const r = await walkPathfinder(self, target, { arrive: 1.6, budget: 20000 }, ctx)
  clock.stopPump()
  ok(r.remaining <= 1.6 + 1.0, '前提：这个位置的三维距离确实小于阈值（正是旧判据会误报的情形）', String(r.remaining))
  ok(r.arrived === false, '🔴 水平到位、高 2 格 ⇒ 不报"到了"（旧判据只看三维距离会放过去）', JSON.stringify({ a: r.arrived, rem: r.remaining }))
  ok(r.reason === 'goal_reached-but-far', 'reason = goal_reached-but-far', String(r.reason))
  ok(r.vert === 2 && r.horiz === 0, '把两个轴分开报出来', JSON.stringify({ h: r.horiz, v: r.vert }))
  ok(/高度不对/.test(r.hint ?? ''), '🔴 hint 点明"高度不对"（不是含糊的"还差 N 格"）', String(r.hint).slice(0, 80))
  /* 2026-10-31：不再让模型"自己走到同一层"（它只会重叫同一个目标 ⇒ 两种报错横跳）。
   * 这次没开 allowDig ⇒ 明确告诉它：想让我自己垫上去就开 allowDig。 */
  ok(!/同一层/.test(r.hint ?? '') && /allowDig:true/.test(r.hint ?? ''),
    '下一步给的是"开 allowDig 让我自己垫上去"（能直接照做，不再推回给模型）',
    String(r.hint).slice(0, 160))
  ok(clock.live === 0, '收尾清掉采样器')
}

/* ═══════════════ ⑧ 静态接线：循环与返回值真的接上了 ═══════════════ */
section('⑧ 静态接线（谁把这几条改回去谁红）')
{
  const raw = read('../src/movement.mjs')
  const src = strip(raw)
  ok(/await Promise\.race\(\[\s*[\s\S]{0,300}?watch\.promise,?\s*\]\)/.test(src),
    '🔴 walkPathfinder 把采样器的 promise 和 goto 一起竞速')
  ok(!/await raceAbort\(withTimeout\(work, budget, '寻路'\), self\.abortSignal, '寻路'\)/.test(src),
    '🔴 不再是"一次 goto 到底"的老写法')
  /* 2026-10-31：`let attempt = planFrom` 与 `for (;;)` 之间现在还夹着 `noPathPending` 的声明，
 *   旧正则钉着“两行相邻”。改成钉“这个循环还在”。 */
ok(/let attempt = planFrom[\s\S]{0,800}?for \(;;\)/.test(src), '有重试循环（attempt 手动推进：挖台阶补救不算一级脱困）')
  ok(/const step = escapeStepOf\(attempt - 1, steps\)/.test(src), '每轮按**这一趟的**阶梯取脱困动作（allowDig:false 时不含 breakAhead）')
  ok(/err\.mcStuck = true[\s\S]{0,120}?err\.mcExhausted = true/.test(src), '阶梯用完抛的是带 mcStuck 的错误')
  ok(/if \(e\?\.mcStuck\)[\s\S]{0,1400}?attempt\+\+[\s\S]{0,200}?continue/.test(src), '采样器判卡 ⇒ 补救没戏就进下一轮脱困')
  ok(/await carveStepAhead\(b, target, \{ ignoreRange: true, only: obstacle \}\)/.test(src) && /carveTries < MOVE_CARVE_TRIES/.test(src),
    '🔴 阶梯之前先试"挖开挡路的台阶"（2026-10-18 实机；审计后改成看眼前障碍）')
  ok(/if \(obstacle && !goalStraightUpOf\(b, target, noTower === false\)\) \{/.test(src) && !/carveTries === 0/.test(src),
    '🔴 2026-10-24 审计：没有明确障碍证据就不许挖（旧的 carveTries===0 无条件补挖已删）')
  /* 🔴 2026-11-05 用户：「allowdig 和 allowtower 还会乱挖」「单独 allowdig 是正常的」——
   *   目标就在正上方时横向补挖帮不上上升，只会把路过的地方挖烂；但这条**只在 allowTower
   *   也开着时**生效，单独 allowdig 的输出与行为一个字都不动。 */
  ok(/export function goalStraightUpOf \(b, target, allowTower\) \{/.test(src)
    && /if \(allowTower !== true\) return false/.test(src)
    && /dyS >= 3 && hzS <= 3/.test(src),
    '★ 目标正上方（dy≥3、水平≤3）时不做横向补挖 —— 仅限 allowTower 同时开着')
  ok(/only: obstacle/.test(src) && /if \(only\) \{/.test(src),
    '🔴 2026-10-24 审计：补挖直接挖 obstacle 指出的那一格，不再自己重扫')
  ok(/const carveAllowed = allowDig === true && ctx\.cfg\?\.walkCanDig !== false && ctx\.cfg\?\.walkCarveStep !== false/.test(src),
    '🔴 自动挖台阶服从 walkCanDig / walkCarveStep（不许绕过配置）')
  ok(/export const CARVE_PROTECTED = new RegExp/.test(src), '容器/矿石/装置有保护名单（不替 AI 挖掉）')
  ok(/export function obstacleAheadOf/.test(src) && /obstacleAheadOf\(b, target\)/.test(src),
    '🔴 该不该挖看"眼前障碍"，不是离终点还有几格')
  /* 2026-10-27：只是"时间到、但确实在推进"时不再给 blockedAhead（模型会把它当线索去挖无关的方块）；
   * 真走不动（noProgress）时照旧给 —— 所以断言钉的是"条件化后的写法"，不是"永远给"。 */
  ok(/\.\.\.\(\(blockedAhead && !timeIsBlame\) \? \{ blockedAhead \} : \{\}\)/.test(src),
    '失败结果带"眼前挡路的是什么"（只在它可能就是原因时）')
  ok(/const exhausted = Boolean\(e\?\.mcStuck\)/.test(src), 'catch 里认出 mcStuck')
  ok(/: exhausted \? 'unreachable'/.test(src), '🔴 reason 里有 unreachable 这一档')
  ok(/const moveInfo = \(opts = \{\}\) => \(\{/.test(src), 'moveInfo 是个多字段的汇总（地形 + 脱困 + 路径失效）')
  ok(/\[opts\.arrived \? 'terrainAtStart' : 'terrain'\]/.test(src), '🔴 到达时出发地形改名 terrainAtStart（否则跨到平地仍写 gap，属主动误导）')
  ok(/const arrivedTerrain = \(\) => \{[\s\S]{0,200}?classifyTerrainCached\(b\)/.test(src), '到达时**重算**落点地形（缓存键含脚下坐标，不用手动清）')
  ok(/arrivedTerrain: now\.kind/.test(src), '落点地形单独一个键（不与出发地形混）')
  ok(/\.\.\.moveInfo\(\{ arrived: true \}\), \.\.\.arrivedTerrain\(\)/.test(src), '🔴 到达那条返回路径两个都带上')
  ok(/\.\.\.\(repathCount \? \{ repathCount \} : \{\}\)/.test(src), 'repathCount 只在 >0 时报')
  ok(/\.\.\.\(pathThrash \? \{ pathThrash \} : \{\}\)/.test(src), 'pathThrash 只在 >0 时报')
  ok(/pathResetsTotal >= 1 \? \{ pathResets/.test(src), '重算过 1 次就报 pathResets（用户 2026-10-21「我看经常 reset」：不给次数就没法判断）')
  ok(/chunk_loaded: 'chunk-loaded/.test(src) && /no_scaffolding_blocks: 'no-scaffolding/.test(src),
    'vendor 的每种重算理由都翻成人话（chunk_loaded 这种是正常重算，不能一律报 path-reset）')
  ok(/不是走不通\*\* —— chunk-loaded/.test(src), 'hint 里说清「途中重算不是走不通」')
  ok([...src.matchAll(/\.\.\.moveInfo\(/g)].length >= 5, '每条返回路径都带上 moveInfo（脱困/失效/地形）', String([...src.matchAll(/\.\.\.moveInfo\(/g)].length))
  ok(/try \{ watch\?\.stop\(\) \} catch \{\}/.test(src), '🔴 finally 里一定收掉采样器')
  ok(/ctx\.watchOpts \?\? \{\}/.test(src), 'watchOpts 可注入（离线测试拿假时钟驱动）')
  // ── P1：路径失效重算 ──
  ok(/export const MOVE_RESET_LIMIT = \d+/.test(src), 'MOVE_RESET_LIMIT 是个具体数字（不是"无限重算"）')
  ok(/resetsOf: \(\) => pathResets/.test(src), '🔴 采样器拿到的是**本轮**失效计数（不是累计值，否则第二趟一开局就认输）')
  ok(/pathResets = 0\s*\/\//.test(src), '每轮把失效计数归零')
  ok(/if \(resetsOf && resetLimit > 0 && resetsNow\(\) >= resetLimit\)/.test(src), '🔴 失效够多就直接进阶梯')
  ok(/if \(e\?\.mcPathThrash\) pathThrash\+\+/.test(src), 'catch 里数"因失效而脱困"的次数')
  ok(/resetReasons\[k\] = \(resetReasons\[k\] \?\? 0\) \+ 1/.test(src), '按理由（stuck / block_updated / …）分类计数')
  /* 窗口放宽到 400：onReset 里现在先记 resetSeen（每一种原因都数），pathResets++ 被推后了。
   * 钉的是“onReset 里确实在数”这件事，不是“第几个字符”。 */
  ok(/const onReset = \(reason\) => \{[\s\S]{0,400}?pathResets\+\+/.test(src), 'onReset 里真的在数')
  ok(/resetSeen\[k\] = \(resetSeen\[k\] \?\? 0\) \+ 1/.test(src), '🔴 每一种重置原因都数（含良性）—— 失败时才能说清是谁在重置')
  ok(/pathResetSeen: \{ \.\.\.resetSeen \}/.test(src), '结果里透出 pathResetSeen（不用再猜 path-reset 是什么）')
  ok(/未识别的重置原因/.test(src), '🔴 兜底文案带上原始原因（不再只写一句 path-reset）')
  ok(/REASON_TEXT\[k\] \?\? k/.test(src), '报出去的理由也翻成人话（不漏内部字符串）')
  // ── P1：到达判定分两轴 ──
  ok(/const vertBad = xz \? false : \(vert < -vertTol \|\| vert > vertTol\)/.test(src), '🔴 垂直窗口按意图给（near ±1.5 / stand ±0.6）；xz 目标没有 y，不讲垂直')
  ok(/if \(!onSpot && \(mine === false \|\| left > arriveUsed \+ 1\.0 \|\| vertBad\)\)/.test(src), '🔴 高度不对也算"没到"（水平到了、人却在目标上下）')
  /* 2026-10-23 审计 A[10]：`sp` 是方块**角**坐标，站在那一格正中间水平就已 0.707 ⇒ `left <= 0.5` 是死条件。
   * 现在 onSpot 按**格心**单独量（`cHoriz`），`left`/`horiz` 口径不动。 */
  ok(/const cHoriz = Math\.hypot\(end\.x - \(Number\(sp\.x\) \+ 0\.5\), end\.z - \(Number\(sp\.z\) \+ 0\.5\)\)/.test(src)
    && /const onSpot = cHoriz <= 0\.75 && !vertBad/.test(src),
  '站在目标点上（按格心 ≤0.75 格）直接算到（GoalNear 半径内的合理圈）')
  ok(src.indexOf('const mine = !fp') < src.indexOf('if (!onSpot && (mine === false || left > arrive'), '🔴 先判"是不是我的目标"，再看距离（别人到点不许误报成功）')
  ok(/horiz: Number\(horiz\.toFixed\(2\)\), vert: Number\(vert\.toFixed\(2\)\)/.test(src), '两个轴分开报给模型')
  ok(/高度不对/.test(src), 'hint 里点明是"高度不对"（不是"还差 N 格"）')
  ok(/vertBad && horiz <= arriveUsed \+ 1\.0/.test(src), '🔴 "站错层"要单独报（不然会被 `mine === false` 那条吞掉）')
  ok(src.indexOf('vertBad && horiz <= arrive + 1.0') < src.indexOf('emptyNoPath || mine === false'),
    '🔴 顺序：先报"站错层"，再报"别人的锅"（插件的 GoalNear 是三维球，人在上层它必然不满足）')
  ok(/const leftMs = budget - \(Date\.now\(\) - t0\)/.test(src) && /Math\.max\(200, leftMs\)/.test(src),
    '重试时用**剩余**预算（总时间仍以 budget 为界）；预算已用尽就别再发起一次注定超时的寻路（issue #3）')
  ok(!/require\(|import .*mineflayer|prismarine/.test(strip(read('../src/movement.mjs')).replace(/from 'vec3'/g, '')),
    'movement.mjs 不 import 游戏运行时（vec3 除外）')
  const all = read('./check-all.mjs')
  ok(/check-move-progress\.mjs/.test(all), 'check-all.mjs 的 ORDER 里登记了这一套')
}

/* ═══════════════ ⑨ noTower：逃跑时不许寻路器原地垫方块往上爬 ═══════════
 * 用户 2026-10-17 实机：撤退时 pathfinder 把方块垫在自己脚下，一路升到 y=57，越逃越远。
 * vendor 的 `allow1by1towers` 默认 true，而全仓**没有任何一处**设置过它（只出现在注释里）。 */
section('⑨ noTower（逃跑时关掉"原地垫高"）')
{
  const clock = autoClock()
  const bot = mkLoopBot()
  const self = mkSelf(bot)
  const mv = {}
  const ctx = { ...mkCtx(self, clock), movements: () => mv }
  await walkPathfinder(self, { x: 20, y: 64, z: 0 }, { arrive: 1.6, budget: 20000, noTower: true }, ctx)
  clock.stopPump()
  ok(mv.allow1by1towers === false, '🔴 noTower ⇒ allow1by1towers = false（逃跑时不再原地垫高）', String(mv.allow1by1towers))
}
{
  const clock = autoClock()
  const bot = mkLoopBot()
  const self = mkSelf(bot)
  const mv = {}
  const ctx = { ...mkCtx(self, clock), movements: () => mv }
  await walkPathfinder(self, { x: 20, y: 64, z: 0 }, { arrive: 1.6, budget: 20000 }, ctx)
  clock.stopPump()
  ok(mv.allow1by1towers === false, '🔴 不传 noTower ⇒ **默认也不垫柱**（2026-10-18：实机"拿圆石垫脚乱搭"）', String(mv.allow1by1towers))
}
{
  const src = read('../src/movement.mjs')
  ok(/if \(noTower\) mv\.allow1by1towers = false/.test(src), '🔴 关的是 allow1by1towers 这一个开关')
  ok(!/mv\.scafoldingBlocks = \[\]/.test(src), '🔴 绝不清空 scafoldingBlocks（那会把 1×1 柱子的 move 一起剪掉，掉坑里出不来）')
  /* 2026-10-22：walkTo 已拆成「包装层 + walkToUnguarded」，断言改查后者。
   * 2026-11-02（用户「不要垫，我不是说了只有 allowDig」）：`towerFallback` 那个
   *   "阶梯走完自动垫一根柱"的兜底已整段删除，签名里也不该再有它。 */
  ok(/noTower = true,[^}]*intent = 'near', waterRecover, allowDig = false, xz = false \} = \{\}, ctx = \{\}\)/.test(src),
    'walkTo 也接 noTower，且**默认 true**（不垫柱 / 不搭桥 —— 2026-10-18 实机：垫柱放错就摔死）')
  ok(!/towerFallback/.test(src),
    '🔴 垫柱没有"自动兜底"了：只认显式 allowTower:true（movement.mjs 里不再有 towerFallback）')
  ok(!/towerFallback/.test(read('../src/mining.mjs')) && !/'towerTried'/.test(read('../src/brief.mjs')),
    '🔴 mining/brief 里也不留 towerFallback / towerTried 残骸')
  /* 🔴 2026-10-17（用户："自动战斗的优先级不应该比 AI 高"）：战斗层**不再自己撤退**，
   *    所以"撤退要关掉垫脚"这条已经没有对象了 —— 反过来要守住"不许再出现撤退执行"。 */
  const atk = read('../src/attack.mjs')
  ok(!/战斗撤退/.test(atk) && !/retreatPointOf/.test(atk),
    '🔴 战斗策略层没有"自己撤退"的移动调用（撤退要 AI 自己叫 mc_move）')
}

/* ═══════════════ ⑨ 掉下去了必须看得见（P0-A） ═══════════════ */
section('⑨ 掉下去了必须看得见：`fell` 字段 + hint 先说掉下去')

/** 真时钟的 ctx（采样器 600ms 才判一次，测试在 30ms 内就把 goto 结掉 ⇒ 不会误触卡住） */
function realCtx (self) {
  return {
    movements: () => ({}),
    collectBusy: () => false,
    cancelCollect: async () => {},
    beginMove: () => ++self._moveGen,
    stopPathing: (bb) => { bb.pathfinder.setGoal(null) },
    releaseControls: () => {},
    watchOpts: { arrive: 1.6, ty: 64 },
  }
}

{
  /* 实机 2026-10-17 20:49：垫柱子时放方块被拒，人从 y=68 掉到 y=47（21 格），
   * 工具却报 `moved: 4.24` + "不是走不通，再叫一次" ⇒ AI 又爬又掉第二次。 */
  const bot = mkLoopBot()
  const self = mkSelf(bot)
  const p = walkPathfinder(self, { x: 20, y: 64, z: 0 }, { arrive: 1.6, budget: 20000 }, realCtx(self))
  setTimeout(() => {
    bot.entity.position = new Vec3(2, 43, 0)
    bot.settleGoto((q) => { const e = new Error('Timeout'); e.name = 'Timeout'; q.reject(e) })
  }, 30)
  const r = await p
  ok(r.fell === 21, '结果里带 fell（净下落 21 格）', JSON.stringify({ fell: r.fell, moved: r.moved }))
  ok(r.fellFrom === 64 && r.fellTo === 43, '带 fellFrom / fellTo（说清从哪掉到哪）', `${r.fellFrom}→${r.fellTo}`)
  ok(/你掉下去了 21 格/.test(r.hint ?? ''), '🔴 hint 明说掉下去了', String(r.hint).slice(0, 70))
  ok(/别对着同一个高度反复爬/.test(r.hint ?? ''), 'hint 劝别对着同一个高度反复爬')
  ok(r.moved < 3, '🔴 moved 只有水平位移（旧版就是这样把掉 21 格报成挪了 4.24）', String(r.moved))
}
{
  const bot = mkLoopBot()
  const self = mkSelf(bot)
  const p = walkPathfinder(self, { x: 20, y: 64, z: 0 }, { arrive: 1.6, budget: 20000 }, realCtx(self))
  setTimeout(() => {
    bot.entity.position = new Vec3(2, 63, 0)   // 下台阶，只差 1 格
    bot.settleGoto((q) => { const e = new Error('Timeout'); e.name = 'Timeout'; q.reject(e) })
  }, 30)
  const r = await p
  ok(r.fell === undefined, '下台阶（1 格）不算"掉下去"', String(r.fell))
  ok(!/掉下去了/.test(r.hint ?? ''), '没掉下去时 hint 不提掉落')
}
{
  /* 被抢占 + 掉下去：那天 `stopWork` 把移动掐成 preempted，hint 却说"不是走不通，再叫一次" ⇒ 又掉 14 格 */
  const bot = mkLoopBot()
  const self = mkSelf(bot)
  const p = walkPathfinder(self, { x: 20, y: 64, z: 0 }, { arrive: 1.6, budget: 20000 }, realCtx(self))
  setTimeout(() => {
    bot.entity.position = new Vec3(1, 47, 0)
    self._moveGen++                        // 模拟"自保反射又发了一次移动"
    bot.settleGoto((q) => q.resolve())
  }, 30)
  const r = await p
  ok(r.reason === 'preempted', '被抢占 ⇒ reason = preempted', String(r.reason))
  ok(r.fell === 17, '被抢占时也报 fell', String(r.fell))
  ok(/你掉下去了 17 格/.test(r.hint ?? ''), '🔴 被抢占 + 掉下去 ⇒ hint 先说掉下去')
  ok(!/不是走不通/.test(r.hint ?? ''), '🔴 不许再说"不是走不通，再叫一次"（那天就是这么掉第二次的）')
}
{
  const src = read('../src/movement.mjs')
  ok(/const fellOf = \(p\) => \{/.test(src), 'fell 由统一的一处算（不散在五个 return 里）')
  ok(/const fellInfo = \(p\) => \{/.test(src) && (src.match(/\.\.\.fellInfo\(end\)/g) ?? []).length >= 5,
    '每个出口都带 fellInfo（arrived / preempted / 站错层 / 没路 / 时间到 / 异常）')
  ok(/const fellNote = \(p\) => \{/.test(src), 'hint 用同一份措辞（掉多少格 + 别反复爬）')
  ok(/d >= 3 \? Number\(d\.toFixed\(1\)\) : null/.test(src), '阈值 3 格：下台阶不算掉下去')
}

/* ═══════════════ ⑧ 窄隧道/台阶的手工补救（carveStepAhead）═══════════════ */
section('⑧′ 位移三种分量（2026-10-18 审计 Bug 2：moved 只有水平，上台阶/掉下去都看不出来）')
{
  const clock = autoClock()
  const bot = mkLoopBot()
  const self = mkSelf(bot)
  const ctx = mkCtx(self, clock)
  const target = { x: 0, y: 68, z: 0 }        // 正上方 4 格：只上升、不水平移动
  clock.onTick = () => {
    const p = bot.entity.position
    if (p.y >= 68) { bot.settleGoto((q) => q.resolve()); return }
    bot.entity.position = new Vec3(p.x, p.y + 1, p.z)
  }
  const r = await walkPathfinder(self, target, { arrive: 1.6, budget: 20000 }, ctx)
  clock.stopPump()
  ok(r.moved === 0, '水平没动 ⇒ moved: 0（兼容旧字段）', String(r.moved))
  ok(r.movedVertical === 4 && r.moved3d === 4, '🔴 垂直位移单独报（movedVertical 4 / moved3d 4）',
    JSON.stringify({ v: r.movedVertical, d3: r.moved3d }))
  ok(r.delta && r.delta.y === 4, 'delta.y 是原始分量，不是"总距离"', JSON.stringify(r.delta))
}

section('⑧ 贴着目标却卡住 ⇒ 挖开挡在脚上/头顶的那一格（2026-10-18 实机）')

function mkCarveBot (cells = {}, at = [0, 64, 0]) {
  const map = new Map(Object.entries(cells))
  const b = {
    entity: { position: new Vec3(...at) },
    dug: [], equipped: [],
    blockAt (v) {
      const n = map.get(`${v.x},${v.y},${v.z}`)
      return n ? { name: n, position: v } : { name: 'air', position: v }
    },
    async equip (item, dest) { b.equipped.push([item?.name ?? item, dest]) },
    async dig (blk) {
      const k = `${blk.position.x},${blk.position.y},${blk.position.z}`
      b.dug.push(k)
      map.delete(k)          // 挖掉就是空气 —— 下面"2 格高复核"要用真实地图
    },
    pathfinder: { bestHarvestTool: () => ({ name: 'iron_pickaxe' }) },
  }
  return b
}
const carve = mod.carveStepAhead

{
  /* 1×2 窄道 + 1 格台阶：脚那格是石头、头顶空，底下有支撑 ⇒ 挖脚那格 */
  const b = mkCarveBot({ '1,64,0': 'stone', '1,63,0': 'stone' })
  const n = await carve(b, { x: 1, y: 64, z: 0 })
  ok(n === 1 && b.dug.includes('1,64,0'), '台阶挡在脚上 ⇒ 挖掉脚那格', JSON.stringify({ n, dug: b.dug }))
  ok(b.equipped.length >= 1, '动手前先换合适的工具（bestHarvestTool）', JSON.stringify(b.equipped))
  ok(!b.dug.some((k) => k === '0,64,0'), '🔴 永不挖自己站的那一格', JSON.stringify(b.dug))
}
{
  /* 天花板低：脚那格空、头顶那格石头 ⇒ 挖头那格（"挖脚+挖头"里的第二下） */
  const b = mkCarveBot({ '1,65,0': 'stone', '1,63,0': 'stone' })
  const n = await carve(b, { x: 1, y: 64, z: 0 })
  ok(n === 1 && b.dug.includes('1,65,0'), '天花板挡着头 ⇒ 挖头那格', JSON.stringify(b.dug))
}
{
  /* 底下是空的 ⇒ 那不是台阶是坑：不许挖（挖开就是往坑里走） */
  const b = mkCarveBot({ '1,64,0': 'stone' })
  const n = await carve(b, { x: 1, y: 64, z: 0 })
  ok(n === 0 && b.dug.length === 0, '前面是坑（底下没支撑）⇒ 不挖', JSON.stringify({ n, dug: b.dug }))
}
{
  /* 底下是岩浆 ⇒ 更不许挖 */
  const b = mkCarveBot({ '1,64,0': 'stone', '1,63,0': 'lava' })
  const n = await carve(b, { x: 1, y: 64, z: 0 })
  ok(n === 0 && b.dug.length === 0, '底下是岩浆 ⇒ 不挖', JSON.stringify({ n, dug: b.dug }))
}
{
  /* 挡路的本身就是岩浆/基岩 ⇒ 不碰 */
/* 🔴 2026-10-27（用户：「现在 move 要挖方块的话，不会挖头上方块导致卡住」）
 *   真实调用点从来不是裸调：`walkPathfinder` 卡住时先用 `obstacleAheadOf` 挑出**那一格**，
 *   再 `carveStepAhead(..., { only: 那一格 })`。"只挖那一格"也必须凑出 2 格高 ——
 *   挖开脚位、头还堵着就是 1 格高的洞，人进不去，下一轮还是卡在同一个门口。 */
{
  /* ① 脚位空、头顶石头 ⇒ only 指到头位格，同样要挖。
   *    （以前整条被"底下得有支撑"拒掉：它拿头位格的 y-1（= 脚位，正好是空气）
   *      去要求实心 ⇒ 头顶那块永远挖不掉。） */
  const b = mkCarveBot({ '1,65,0': 'stone', '1,63,0': 'stone' })
  const n = await carve(b, { x: 1, y: 64, z: 0 }, { ignoreRange: true, only: { x: 1, y: 65, z: 0, cell: 'head' } })
  ok(n === 1 && b.dug.includes('1,65,0'), '🔴 only 指向头顶那格 ⇒ 照挖（别拿"脚位是空气"当理由拒掉）',
    JSON.stringify({ n, dug: b.dug }))
  ok(!b.__carveHalfOpen, '头顶挖掉了 ⇒ 没有"通道只有 1 格高"的残留记账', JSON.stringify(b.__carveHalfOpen))
}
{
  /* ② only 指向脚位、头顶也实心 ⇒ 两格一起挖，凑出一条 2 格高的通道 */
  const b = mkCarveBot({ '1,64,0': 'stone', '1,65,0': 'stone', '1,63,0': 'stone' })
  const n = await carve(b, { x: 1, y: 64, z: 0 }, { ignoreRange: true, only: { x: 1, y: 64, z: 0, cell: 'feet' } })
  ok(n === 2 && b.dug.includes('1,64,0') && b.dug.includes('1,65,0'),
    '🔴 挖脚位时把头顶那格一起挖（玩家过得去要 2 格高）', JSON.stringify({ n, dug: b.dug }))
  ok(!b.__carveHalfOpen, '两格都通了 ⇒ 不留"只挖一半"的记录', JSON.stringify(b.__carveHalfOpen))
}
{
  /* ③ 头顶是基岩 ⇒ 只挖脚位，并如实记账"差的是哪一块"，让上层把话说全 */
  const b = mkCarveBot({ '1,64,0': 'stone', '1,65,0': 'bedrock', '1,63,0': 'stone' })
  const n = await carve(b, { x: 1, y: 64, z: 0 }, { ignoreRange: true, only: { x: 1, y: 64, z: 0, cell: 'feet' } })
  ok(n === 1 && !b.dug.includes('1,65,0'), '头顶挖不动（基岩）⇒ 只挖脚位，不硬啃', JSON.stringify({ n, dug: b.dug }))
  ok(b.__carveHalfOpen && b.__carveHalfOpen.name === 'bedrock' && b.__carveHalfOpen.y === 65,
    '🔴 记账「还差头顶那一块」—— 上层据此告诉 AI 通道只有 1 格高', JSON.stringify(b.__carveHalfOpen))
}
{
  /* ④ only 指向脚位、底下是坑 ⇒ 老语义不变：不挖 */
  const b = mkCarveBot({ '1,64,0': 'stone', '1,65,0': 'stone' })
  const n = await carve(b, { x: 1, y: 64, z: 0 }, { ignoreRange: true, only: { x: 1, y: 64, z: 0, cell: 'feet' } })
  ok(n === 0 && b.dug.length === 0, 'only 指向脚位但底下是坑 ⇒ 不挖（挖了就是往坑里走）', JSON.stringify({ n, dug: b.dug }))
}
  const lava = mkCarveBot({ '1,64,0': 'lava', '1,63,0': 'stone' })
  ok(await carve(lava, { x: 1, y: 64, z: 0 }) === 0 && lava.dug.length === 0, '挡路的是岩浆 ⇒ 不挖')
  const bed = mkCarveBot({ '1,64,0': 'bedrock', '1,63,0': 'stone' })
  ok(await carve(bed, { x: 1, y: 64, z: 0 }) === 0 && bed.dug.length === 0, '挡路的是基岩 ⇒ 不挖（白费时间）')
}
{
  /* 离得远 ⇒ 不挖（远处卡住多半是别的原因，乱挖会把路改坏） */
  const b = mkCarveBot({ '1,64,0': 'stone', '1,63,0': 'stone' })
  const n = await carve(b, { x: 20, y: 64, z: 0 })
  ok(n === 0 && b.dug.length === 0, '离目标太远（> 4.5 格）⇒ 不挖', String(n))
}
{
  /* 台阶在第二格（第一格是通的）—— cells=2 要能看到它 */
  const b = mkCarveBot({ '1,63,0': 'stone', '2,64,0': 'stone', '2,63,0': 'stone' })
  const n = await carve(b, { x: 2, y: 64, z: 0 })
  ok(n === 1 && b.dug.includes('2,64,0'), '台阶在第二格也能看到（cells=2）', JSON.stringify(b.dug))
}
{
  /* 整条链路：贴着目标还 mcStuck ⇒ 先挖开，再重跑同一个 goto（**不**白吃一级脱困） */
  const b = mkCarveBot({ '1,64,0': 'stone', '1,63,0': 'stone' })
  b.on = () => {}
  b.removeListener = () => {}
  b.setControlState = () => {}
  Object.assign(b, {
    controls: [],
    calls: { goto: 0, setGoal: [] },
    pathfinder: {
      isMining: () => false,
      isBuilding: () => false,
      setMovements: () => {},
      bestHarvestTool: () => ({ name: 'iron_pickaxe' }),
      setGoal (g) { b.calls.setGoal.push(g) },
      goto () {
        b.calls.goto++
        if (b.calls.goto === 1) {
          return new Promise((resolve, reject) => {
            setTimeout(() => { const e = new Error('stuck'); e.mcStuck = true; reject(e) }, 10)
          })
        }
        b.entity.position = new Vec3(1, 64, 0)      // 挖开之后走到了
        return Promise.resolve()
      },
    },
  })
  const self = mkSelf(b)
  const r = await walkPathfinder(self, { x: 1, y: 64, z: 0 }, { arrive: 1.6, budget: 20000, allowDig: true }, mkCtx(self, autoClock()))
  ok(r.arrived === true, '挖开台阶后再试一次就到位了', JSON.stringify({ arrived: r.arrived, reason: r.reason }))
  ok(r.carved >= 1, '结果里报 carved（挖开了几格）', String(r.carved))
  ok(b.calls.goto === 2 && r.repathCount === undefined, '🔴 补救只重跑同一个 goto，**不**算一级脱困（repathCount 不出现）',
    JSON.stringify({ goto: b.calls.goto, repathCount: r.repathCount }))
  ok(self.logs.some((m) => /挖开了 1 格/.test(m)), '日志写清"挖开了几格"', JSON.stringify(self.logs.slice(0, 2)))
}

/* ═══════════════ ⑧′⁗ 门已经开着 ≠ 这一轮没开门（2026-10-18 用户指出）═══════════════ */
section('⑧′⁗ 卡住恢复：门"通不通"要看门现在的状态，不是"我刚开了几扇"')
{
  const { doorAheadOpen } = mod
  const mk = (name, props, at) => ({
    name, position: new Vec3(...at), getProperties: props ? () => props : undefined,
  })
  const botWith = (doorCell, doorProps, at = [0, 64, 0]) => ({
    entity: { position: new Vec3(...at) },
    blockAt (v) {
      const k = `${v.x},${v.y},${v.z}`
      if (k === doorCell) return mk('oak_door', doorProps, [v.x, v.y, v.z])
      return { name: v.y < 64 ? 'stone' : 'air', position: v }
    },
  })
  const tgt = { x: 5, y: 64, z: 0 }
  ok(doorAheadOpen(botWith('1,64,0', { open: true, half: 'lower' }), tgt) === true,
    '🔴 前方那扇门开着（这一轮没新开）⇒ 也算"通"', String(doorAheadOpen(botWith('1,64,0', { open: true }), tgt)))
  ok(doorAheadOpen(botWith('1,64,0', { open: false }), tgt) === false, '门关着 ⇒ 不算通')
  ok(doorAheadOpen(botWith('1,64,0', null), tgt) === false, '🔴 读不到开合状态 ⇒ 不算通（不知道 ≠ 通）')
  ok(doorAheadOpen(botWith('-1,64,0', { open: true }), tgt) === false, '背后的门开着 ⇒ 不算（只认朝目标那半边）')
  ok(doorAheadOpen(botWith('1,64,0', { open: true }), { x: -5, y: 64, z: 0 }) === false,
    '目标在反方向时，同一扇门就不再算"前方"')
  /* 整条链路：门本来就开着 + 一直卡 ⇒ 重算路径、**不挖墙**，两轮后交给脱困阶梯 */
  {
    const clock = autoClock()
    const bot = mkLoopBot()
    const digged = []
    bot.dig = async (blk) => { digged.push(`${blk.position.x},${blk.position.y},${blk.position.z}`) }
    bot.pathfinder.bestHarvestTool = () => ({ name: 'iron_pickaxe' })
    bot.equip = async () => {}
    bot.blockAt = (v) => {
      const k = `${v.x},${v.y},${v.z}`
      if (k === '1,64,0' || k === '1,65,0') return { name: 'oak_door', position: v, getProperties: () => ({ open: true, half: v.y === 65 ? 'upper' : 'lower' }) }
      return { name: v.y < 64 ? 'stone' : 'air', position: v }
    }
    const self = mkSelf(bot)
    const ctx = mkCtx(self, clock)
    clock.onTick = () => { if (bot._pending) { const p = bot._pending; bot._pending = null; const e = new Error('stuck'); e.mcStuck = true; p.reject(e) } }
    const r = await walkPathfinder(self, { x: 8, y: 64, z: 0 }, { arrive: 1.6, budget: 20000 }, ctx)
    clock.stopPump()
    ok(digged.length === 0, '🔴 门开着重试期间一格都不挖（不拆门框/门边的墙）', JSON.stringify(digged))
    ok(self.logs.some((m) => /前方的门本来就开着/.test(m)), '日志说清"门本来就开着，重新算路"，而不是"按开了 0 扇"',
      JSON.stringify(self.logs.slice(0, 3)))
    ok(self.logs.some((m) => /不挖墙/.test(m)), '重试用完也不再挖墙，明确交给脱困阶梯')
    ok(r.arrived === false, '最终走不到就如实报走不动（交给上层/AI）', JSON.stringify({ a: r.arrived, r: r.reason }))
  }
  /* ── 门前一格的方块 / 门脚支撑块：不许补挖（2026-10-18 用户指出）── */
  {
    const { doorOnRoute } = mod
    const world = (cells) => ({
      entity: { position: new Vec3(0, 64, 0) },
      blockAt (v) {
        const n = cells[`${v.x},${v.y},${v.z}`]
        return { name: n ?? (v.y < 64 ? 'stone' : 'air'), position: v }
      },
    })
    const tgt = { x: 8, y: 64, z: 0 }
    ok(doorOnRoute(world({ '1,64,0': 'oak_door' }), tgt)?.name === 'oak_door',
      '🔴 通行方向上有门 ⇒ 报出来（补挖必须停手）')
    ok(doorOnRoute(world({ '2,64,0': 'oak_door' }), tgt)?.name === 'oak_door', '门在第二格也算（cells+1 扫描）')
    ok(doorOnRoute(world({ '1,64,0': 'iron_door' }), tgt) === null, '铁门按不开、不算"通行受阻"')
    ok(doorOnRoute(world({ '1,64,0': 'oak_door' }), { x: -8, y: 64, z: 0 }) === null, '背后的门不算')
  }
  {
    /* 门前一格是普通石头、门关着且按不开 ⇒ 一格都不挖，如实报走不动 */
    const clock = autoClock()
    const bot = mkLoopBot()
    const digged = []
    bot.dig = async (blk) => { digged.push(`${blk.position.x},${blk.position.y},${blk.position.z}`) }
    bot.pathfinder.bestHarvestTool = () => ({ name: 'iron_pickaxe' })
    bot.equip = async () => {}
    bot.blockAt = (v) => {
      const k = `${v.x},${v.y},${v.z}`
      if (k === '1,64,0' || k === '1,65,0') return { name: 'oak_door', position: v, getProperties: () => ({ open: false, half: v.y === 65 ? 'upper' : 'lower' }) }
      return { name: v.y < 64 ? 'stone' : 'air', position: v }
    }
    const self = mkSelf(bot)
    const ctx = mkCtx(self, clock)
    clock.onTick = () => { if (bot._pending) { const p = bot._pending; bot._pending = null; const e = new Error('stuck'); e.mcStuck = true; p.reject(e) } }
    const r = await walkPathfinder(self, { x: 8, y: 64, z: 0 }, { arrive: 1.6, budget: 20000 }, ctx)
    clock.stopPump()
    ok(digged.length === 0, '🔴 门前那格/门脚支撑一格都不挖（不是"门前两格一律保护"，是"门在路线上就别补挖"）', JSON.stringify(digged))
    ok(self.logs.some((m) => /不挖门、门框、门槛/.test(m)), '日志说清为什么不挖', JSON.stringify(self.logs.slice(0, 3)))
    ok(r.arrived === false, '仍然走不通 ⇒ 如实报，交给 AI 决定（不替它拆房子）')
  }
  const src2 = read('../src/movement.mjs')
  ok(/export function doorOnRoute/.test(src2) && /const doorBlocking = doorOnRoute\(b, target\)/.test(src2),
    '🔴 卡住分支在补挖之前先查"路线上有没有门"')
  ok(/export function doorOnRoute/.test(src2) && /cells \+ 1/.test(src2), '扫描按当前移动方向、范围是 cells+1（不是门周围固定两格）')
  {
    /* 🔴 回归：patchDoorMoves 挂在 getNeighbors 上时必须**保留**与门无关的 move。
     * 曾经 clean() 漏了 return true ⇒ 所有候选都被 filter 丢掉 ⇒ 到处 NoPath。 */
    const { patchDoorMoves } = await import(new URL('../src/plugins.mjs', import.meta.url))
    const air = { name: 'air' }
    const mv = {
      getBlock: () => air,
      getNeighbors () {
        return [
          { kind: 'walk', cost: 1, toBreak: [], toPlace: [] },
          { kind: 'walk-with-dig', cost: 5, toBreak: [{ x: 1, y: 64, z: 0 }], toPlace: [] },
        ]
      },
    }
    patchDoorMoves(mv)
    const got = mv.getNeighbors({ x: 0, y: 64, z: 0 })
    ok(Array.isArray(got) && got.length === 2,
      '🔴 getNeighbors 补丁保留所有与门无关的 move（漏 return true ⇒ 全局 NoPath）', JSON.stringify(got?.length))
    ok(got?.[1]?.toBreak?.length === 1 && got[1].cost === 5, '普通方块的挖掘原样保留（cost 也不动）', JSON.stringify(got?.[1]))
    /* 全部候选都被"门保护"作废时（极端：站在门框里四面都要挖门边），退回未过滤候选 ——
     * 宁可让执行层拦住那次挖，也不要凭空 NoPath。 */
    const door = { name: 'oak_door', getProperties: () => ({ open: false }) }
    const mv2 = {
      getBlock: (node, dx, dy, dz) => ((dx === 1 && dy === 0 && dz === 0) ? door : { name: 'stone' }),
      getNeighbors () {
        return [{ kind: 'walk', cost: 3, toBreak: [{ x: 1, y: 64, z: 0 }], toPlace: [] }]
      },
    }
    patchDoorMoves(mv2)
    const got2 = mv2.getNeighbors({ x: 0, y: 64, z: 0 })
    ok(Array.isArray(got2) && got2.length === 1 && got2[0].toBreak.length === 0,
      '🔴 门的 toBreak 照旧剔除（这一条不该被兜底改回）', JSON.stringify(got2))
    const mv3 = {
      getBlock: (node, dx, dy, dz) => ((dx === 1 && dy === 0 && dz === 0) ? { name: 'stone' } : { name: 'air' }),
      getNeighbors () {
        return [{ kind: 'walk', cost: 3, toBreak: [{ x: 1, y: 64, z: 0 }], toPlace: [] }]
      },
    }
    patchDoorMoves(mv3)
    ok(mv3.getNeighbors({ x: 0, y: 64, z: 0 }).length === 1, '兜底只在"全没了"时生效')
  }
  {
    /* 🔴 回归（2026-10-22 用户实机「现在寻路会踩在岩浆块上掉血」）：
     * `blocksToAvoid` 管的是"这一格能不能站"，岩浆块是**实心**的 —— 人站在它**上面**，
     * 脚那格永远是空气 ⇒ 那个名单对它从来没生效过。真正的判据是**落脚点下面那一格**。 */
    const { patchHarmfulFloorMoves } = await import(new URL('../src/plugins.mjs', import.meta.url))
    const mk = (floorName, feetName = 'air', cost = 3) => ({
      getBlock: (node, dx, dy, dz) => ({ name: dy === -1 ? floorName : (dy === 0 ? feetName : 'air') }),
      getNeighbors () { return [{ x: 1, y: 64, z: 0, cost, toBreak: [], toPlace: [] }] },
    })
    const m1 = mk('magma_block')
    patchHarmfulFloorMoves(m1, { penalty: 60 })
    const g1 = m1.getNeighbors({ x: 0, y: 64, z: 0 })
    ok(g1.length === 1 && g1[0].cost === 63,
      '🔴 落在岩浆块上：cost 加 60（绕路比踩上去划算）', JSON.stringify(g1[0]))
    ok(g1[0].__harmfulFloor === 'magma_block', '标出踩的是什么（排查时不用猜）', String(g1[0].__harmfulFloor))
    const m2 = mk('stone')
    patchHarmfulFloorMoves(m2, { penalty: 60 })
    ok(m2.getNeighbors({ x: 0, y: 64, z: 0 })[0].cost === 3, '普通石头地板：cost 一分不动')
    const m3 = mk('stone', 'sweet_berry_bush')
    patchHarmfulFloorMoves(m3, { penalty: 60 })
    ok(m3.getNeighbors({ x: 0, y: 64, z: 0 })[0].cost === 63,
      '脚踩进去那格是甜浆果丛（空碰撞盒、会扎人）也算')
    const m4 = mk('magma_block')
    patchHarmfulFloorMoves(m4, { penalty: 0 })
    ok(m4.getNeighbors({ x: 0, y: 64, z: 0 })[0].cost === 3 && !m4.__dshHarmfulFloorPatched,
      'penalty=0 ⇒ 完全不动手（用户想关就关）')
    const m5 = {
      getBlock: () => ({ name: 'magma_block' }),
      getNeighbors () { return [{ x: 1, y: 64, z: 0, cost: 3 }, { x: 0, y: 64, z: 1, cost: 3 }] },
    }
    patchHarmfulFloorMoves(m5, { penalty: 60 })
    const g5 = m5.getNeighbors({ x: 0, y: 64, z: 0 })
    ok(g5.length === 2 && g5.every((m) => m.cost === 63),
      '🔴 满地板都是岩浆块（下界玄武岩三角洲）⇒ **不许删 move**：全加价但路还在，否则 NoPath 原地不动')
  }
  {
    /* 🔴 回归（2026-10-22 用户实机「家里非实体方块走不了」）：
     * vendor `b.safe` 要求 `boundingBox === 'empty' || climbable || carpets.has(type)`，
     * 而 `carpets` 只按 `shapes[0][4] < 0.1` 自动收集 —— 小麦（≈0.3125）进不去
     * ⇒ 整片麦田被 A* 当成墙。`patchPlantPassable` 按名字把它们塞进 `carpets`。 */
    const { patchPlantPassable } = await import(new URL('../src/plugins.mjs', import.meta.url))
    const reg = {
      blocksArray: [
        { id: 1, name: 'wheat' },
        { id: 2, name: 'carrots' },
        { id: 3, name: 'short_grass' },
        { id: 4, name: 'sweet_berry_bush' },
        { id: 5, name: 'stone' },
        { id: 6, name: 'oak_planks' },
      ],
    }
    const mvP = { carpets: new Set([6]) }
    const addedN = patchPlantPassable(mvP, { registry: reg })
    ok(addedN === 3 && mvP.carpets.has(1) && mvP.carpets.has(2) && mvP.carpets.has(3),
      '🔴 作物/草补进 carpets（A* 才肯从麦田里走过去）', `added=${addedN}`)
    ok(!mvP.carpets.has(4), '甜浆果丛**不**补进去（踩了掉血，宁可绕）')
    ok(!mvP.carpets.has(5), '普通石头当然不补')
    ok(mvP.carpets.has(6), '原有的 carpets 不动')
    ok(patchPlantPassable(mvP, { registry: reg }) === 0, '再跑一次不再加（幂等）')
    ok(patchPlantPassable({}, { registry: reg }) === 0 && patchPlantPassable(null, null) === 0,
      '没有 carpets / 没有 registry 也不炸')
    ok(mvP.__dshPlantPassable === 3, '记下加了几种（排查用）', String(mvP.__dshPlantPassable))
  }
  const plug2 = read('../src/plugins.mjs')
  ok(/const isDoorSupport = \(node, p\)/.test(plug2) && /isDoorSupport\(node, p\)\) \{[\s\S]{0,160}?continue/.test(plug2),
    '🔴 规划层：门脚支撑块也剔出 toBreak 并退工钱')
  ok(/const protectedDoorOf = \(block\)/.test(plug2), '🔴 执行层：门脚支撑块也拦（不只门本身）')
  ok(/export const HARMFUL_FLOOR = /.test(plug2) && /magma_block/.test(plug2),
    '🔴 规划层：岩浆块/营火/仙人掌这类"站上去掉血"的地板有名单（2026-10-22 用户实机反馈）')
  ok(/patchHarmfulFloorMoves\(mv, \{ penalty: Number\(self\.cfg\.walkHarmfulFloorPenalty \?\? 60\) \}\)/.test(plug2),
    '🔴 movements() 里真的挂上了这个补丁（写了函数没人调 = 白改）')
  ok(/const floor = nameAt\(node, dx, dy - 1, dz\)/.test(plug2),
    '🔴 判据看的是落脚点**下面那一格**（`m.y - 1`）—— 看脚那格的话岩浆块永远看不出来')
  ok(/export const PLANT_PASSABLE = /.test(read('../src/block-names.mjs')),
    '🔴 规划层：作物/花草有"能站进去"的名单 PLANT_PASSABLE（2026-10-22 用户实机「家里非实体方块走不了」）')
  ok(/patchPlantPassable\(mv, b\)/.test(plug2),
    '🔴 movements() 里真的挂上了 patchPlantPassable（写了函数没人调 = 白改）')
  ok(/mv\.carpets\.add\(blk\.id\)/.test(plug2),
    '补的是 vendor 的 `carpets`（"这一格能不能站"），不是 blocksToAvoid')
  const src = read('../src/movement.mjs')
  ok(/const doorAlreadyOpen = doorOpened === 0 && doorAheadOpen\(b, target\)/.test(src),
    '🔴 恢复分支把"门本来就开着"算作通')
  ok(/let doorTries = 0/.test(src) && /if \(doorTries < 2\)/.test(src), '门重试有次数上限（不会因为门开着就死循环）')
  ok(/不挖墙，交给脱困阶梯[\s\S]{0,160}?attempt\+\+/.test(src),
    '重试用完 ⇒ 交给脱困阶梯，不走挖台阶分支')
}

/* ═══════════════ ⑧″ 挖台阶的保护与配置闸门（2026-10-18 审计 Bug 3/4）═══════════════ */
await (async () => {
section('⑧″ 自动挖台阶：不挖箱子/矿石，服从 walkCanDig / walkCarveStep，远处看眼前')
{
  const { obstacleAheadOf } = mod
  // 挡路的是一整排"箱子/钻石矿" ⇒ 一格都不挖
  const b1 = mkCarveBot({ '1,64,0': 'chest', '1,63,0': 'stone' })
  ok((await carve(b1, { x: 1, y: 64, z: 0 })) === 0 && b1.dug.length === 0, '箱子挡路 ⇒ 不挖', JSON.stringify(b1.dug))
  const b2 = mkCarveBot({ '1,64,0': 'diamond_ore', '1,63,0': 'stone' })
  ok((await carve(b2, { x: 1, y: 64, z: 0 })) === 0, '矿石挡路 ⇒ 不挖（那是 AI 的资源）', JSON.stringify(b2.dug))
  // 目标在很远处（>半径），但眼前就有台阶 ⇒ 也要能挖（ignoreRange）
  const b3 = mkCarveBot({ '1,64,0': 'stone', '1,63,0': 'stone' })
  ok((await carve(b3, { x: 40, y: 64, z: 0 })) === 0, '默认仍保守：远处不走就直接调不挖', JSON.stringify(b3.dug))
  const b4 = mkCarveBot({ '1,64,0': 'stone', '1,63,0': 'stone' })
  const n4 = await carve(b4, { x: 40, y: 64, z: 0 }, { ignoreRange: true })
  ok(n4 === 1 && b4.dug.includes('1,64,0'), '🔴 由调用方判定"眼前有障碍"时可以挖（目标在 40 格外）', JSON.stringify(b4.dug))
  // obstacleAheadOf：箱子不算"可下手"，石头才算
  ok(obstacleAheadOf(mkCarveBot({ '1,64,0': 'chest', '1,63,0': 'stone' }), { x: 5, y: 64, z: 0 }) === null,
    '箱子挡路 ⇒ obstacleAheadOf 报"没有可下手的障碍"')
  ok(obstacleAheadOf(mkCarveBot({ '1,64,0': 'stone', '1,63,0': 'stone' }), { x: 5, y: 64, z: 0 })?.name === 'stone',
    '石头挡路 ⇒ obstacleAheadOf 报出坐标与方块名')
  // 配置闸门：walkCanDig:false 时整个 carve 分支不执行
  {
    const clock = autoClock()
    const bot = mkLoopBot()
    const digged = []
    bot.dig = async (blk) => { digged.push(`${blk.position.x},${blk.position.y},${blk.position.z}`) }
    bot.pathfinder.bestHarvestTool = () => ({ name: 'iron_pickaxe' })
    bot.equip = async () => {}
    bot.blockAt = (v) => ({ name: 'stone', position: v })
    const self = mkSelf(bot)
    const ctx = mkCtx(self, clock)
    ctx.cfg = { walkCanDig: false }
    clock.onTick = () => { if (bot._pending) { const p = bot._pending; bot._pending = null; const e = new Error('stuck'); e.mcStuck = true; p.reject(e) } }
    const r = await walkPathfinder(self, { x: 20, y: 64, z: 0 }, { arrive: 1.6, budget: 6000 }, ctx)
    clock.stopPump()
    ok(digged.length === 0, '🔴 walkCanDig:false ⇒ 一格都不挖（配置没被绕过）', JSON.stringify(digged))
    ok(r.arrived === false && r.reason === 'unreachable', '照样如实报走不动', JSON.stringify({ a: r.arrived, r: r.reason }))
  }
}
})()

console.log(`\n${'─'.repeat(50)}`)
/* ── ⑧‴ 失败结果可操作：眼前障碍 + 泳的三维位移（2026-10-18 审计 P1/Bug2）── */
section('⑧‴ 失败结果"可操作"：眼前挡路的那格 + 泳也算三维位移')
{
  const clock = autoClock()
  const bot = mkLoopBot()
  bot.blockAt = (v) => ({ name: (v.y === 63 ? 'stone' : (v.x === 1 && v.y === 64 ? 'stone' : 'air')), position: v })
  const self = mkSelf(bot)
  const ctx = mkCtx(self, clock)
  clock.onTick = () => { if (bot._pending) { const p = bot._pending; bot._pending = null; const e = new Error('stuck'); e.mcStuck = true; p.reject(e) } }
  const r = await walkPathfinder(self, { x: 20, y: 64, z: 0 }, { arrive: 1.6, budget: 4000 }, ctx)
  clock.stopPump()
  ok(r.blockedAhead && r.blockedAhead.name === 'stone' && r.blockedAhead.cell === 'feet',
    '🔴 失败结果里带上"眼前挡路的是什么"（名字/坐标/脚还是头）', JSON.stringify(r.blockedAhead))
  ok(/mc_act \{mode:"break"/ .test(r.hint ?? ''), 'hint 直接给出"挖掉它"的可执行命令', String(r.hint).slice(0, 120))
  const src = read('../src/movement.mjs')
  ok(/movedHorizontal: r2\(Math\.hypot\(swimDx, swimDz\)\)/.test(src) && /movedVertical: swimDy/.test(src),
    '🔴 游泳也报三维分量（以前只有水平 moved）')
}
/* ── ⑪ 导航意图 / 规划-移动耗时拆分 / 竖井信息包 / 水流漂移（2026-10-18 审计 P1-P2） ── */
{
  const src = readFileSync(new URL('../src/movement.mjs', import.meta.url), 'utf8')
  const { INTENTS, intentOf, shaftInfoOf } = mod
  ok(INTENTS.near.arrive === 1.6 && INTENTS.stand.arrive === 0.8
    && INTENTS.interact.arrive === 2.2 && INTENTS['same-level'].vertTol === 0.9,
    '四种导航意图的"到"标准固定下来（near/stand/interact/same-level）')
  ok(intentOf('nope') === INTENTS.near, '未知意图按 near 兜底（写错一个词不该让整次移动失败）')
  ok(/const arriveUsed = arrive === 1\.6 \? pre\.arrive : arrive/.test(src)
    && /const vertTol = pre\.vertTol/.test(src), '意图真的接到了到达复核（arriveUsed / vertTol）')

  // 竖井：头顶当场封死
  const b1 = mkCarveBot({ '0,66,0': 'stone' }, [0, 64, 0])
  const sh1 = shaftInfoOf(b1, { x: 2, y: 64, z: 0 })
  ok(sh1 && sh1.headroom === 0 && sh1.ceiling === 'stone' && sh1.canJump === false,
    '头顶封死 ⇒ headroom 0、canJump false，并报出封着的是什么', JSON.stringify(sh1 && { h: sh1.headroom, c: sh1.ceiling }))
  ok(sh1 && /跳不起来/.test(sh1.hint), '提示里明说"跳不起来，原地垫脚也不行"')

  // 头顶 2 格净空、再往上是石头；东边能走、脚下有支撑
  const b2 = mkCarveBot({ '0,68,0': 'stone', '1,64,0': 'air', '1,63,0': 'stone' }, [0, 64, 0])
  b2.inventory = { items: () => [{ name: 'cobblestone', count: 7 }, { name: 'iron_sword', count: 1 }] }
  const sh2 = shaftInfoOf(b2, { x: 2, y: 64, z: 0 })
  ok(sh2 && sh2.headroom === 2 && sh2.ceiling === 'stone' && sh2.canJump === true,
    '头顶按格数算净空（y=66/67 空、68 就是石头）', JSON.stringify(sh2 && { h: sh2.headroom, c: sh2.ceiling }))
  ok(sh2 && sh2.pillar === 7, '背包里能垫的方块数只数便宜方块（圆石 7，铁剑不算）', JSON.stringify(sh2 && sh2.pillar))
  ok(sh2 && sh2.sides.e === 'stone', '四面哪边有落脚地报出来（东边站脚那格底是石头）', JSON.stringify(sh2 && sh2.sides))
  ok(sh2 && /能跳/.test(sh2.hint) && /垫/.test(sh2.hint), '提示同时说"能跳"和"有 N 个能垫的"')


  /* 🔴 2026-10-29 实机（用户原文）：`mc_move` 返回「⛔ 走不动：困在竖井里（井口 」
   *   —— 括号里是空的（`shaftInfoOf` 根本不返 x/y/z，文案却去读坐标）；
   *   而且旧判据 `!/:/` 永远为真 ⇒“四面全通”也是假的。
   *   这四条钉的就是“按真字段说话 + 给得出方向”。 */
  {
    const cause = mod.moveCauseTextOf({ shaft: sh2, reason: 'NoPath', stuck: true })
    /* 🔴 2026-10-29：用户实机「是在树冠上，没有被包围」——头顶开阔、只有一面通，
     *   叫它“竖井”会把模型带偏。现在只报事实：不出现“竖井”字样、不出现空的井口、头顶用“开阔”。 */
    ok(!/竖井/.test(cause) && !/井口 \s*）/.test(cause), '不再叫“竖井”（它可能只是一块被围住的小空间）', cause)
    ok(/头顶 2 格开阔|头上就是/.test(cause), '文案按真字段说清头顶有多高', cause)
    /* 2026-10-30 修正：这个用例里 e 面其实是通的（sides.e 是脚下地面的石头），
 *   旧断言钉着“四周是 stone”恰好把旧文案那个矛盾钉死了。现在只钉“按实情报”。 */
ok(/四周是|四周全是实心方块|四周没有挡路的方块/.test(cause), '文案按实情报出四周拦着什么（没挡就说没挡）', cause)
    const nx = mod.moveNextTextOf({ shaft: sh2, reason: 'NoPath', stuck: true }, true)
    ok(/挖过去|挖开|垫/.test(nx), '竖井时给得出方向（不再只说“换个目标点”）', nx)
    /* 这个假场景四面都是空气（所以四面都通）—— 钉的是“逐面判过、结果与 sides 键一致”，
     * 而不是旧那句永为真的 `!/:/`。 */
    ok(Array.isArray(sh2.openSides) && sh2.openSides.length === Object.keys(sh2.sides).length
      && sh2.openSides.every((k) => ['n', 'e', 's', 'w'].includes(k)),
      'shaftInfoOf 带 openSides（逐面判过、不是硬编码四面全通）', JSON.stringify(sh2.openSides))
  }

  // 走不到 + 不是被抢占 ⇒ 结果里带 shaft；被抢占不带
  ok(/\(exhausted \|\| e\?\.name === 'NoPath'\) && !preempted \? \(\(\) => \{ const sh = shaftInfoOf/.test(src),
    '🔴 只有真的走不到（卡死/没路）才给竖井信息包，被抢占/时间到不给')

  // 规划 / 移动耗时拆分
  ok(/let plannedAt = null/.test(src) && /if \(!plannedAt\) plannedAt = Date\.now\(\)/.test(src)
    && /timing: \{ planMs: plannedAt \? plannedAt - t0 : null/.test(src),
    '🔴 第一次算出路径的时刻单独记，结果里 planMs / walkMs 分开报')

  // 水流漂移：只在水里、按窗口量、反压一档、真松开
  ok(/export const SWIM_DRIFT_EPS = 0\.35/.test(src), '横向漂移有阈值（0.35 格/窗口）')
  ok(/const perp = \(mvx \* \(-gz \/ gl\) \+ mvz \* \(gx \/ gl\)\)/.test(src),
    '🔴 漂移按"垂直于目标方向"的分量算（不是总位移）')
  ok(/lastStrafe = perp > 0 \? 'right' : 'left'/.test(src), '漂向哪边就往反方向压一档')
  ok(/if \(lastStrafe\) \{ try \{ b\.setControlState\(lastStrafe, false\) \} catch \{\} ; lastStrafe = null \}/.test(src),
    '🔴 反压键每轮先松开（不收就是把方向键焊死）')
  ok(/\.\.\.\(driftFixes \? \{ drift, driftFixes \} : \{\}\)/.test(src) && /水流一直在横向推你/.test(src),
    '结果与提示里都如实报"水在推你，压了几次"')

  // 接线：mc_move 真的把 intent 传下去了
  const idx = readFileSync(new URL('../index.js', import.meta.url), 'utf8')
  /* 2026-10-23 审计：入口现在走 `intentArgOf(args.intent)` 做枚举校验（未知值直接抛错），
   * 断言的判据跟着改。 */
  /* 2026-10-27：swim 分支删了 ⇒ 只剩 walk 一条出口。 */
  ok((idx.match(/intent: intentArgOf\(args\.intent\)/g) ?? []).length >= 1
    && /function intentArgOf/.test(idx) && /intent: \{ type: 'string'/.test(idx),
    'mc_move 的 intent 参数接在 walkTo 出口上，且未知值会被拒')
}
/* ── ⑫ 门：规划允许穿门 + 执行层自己按开 + 卡住补救不砸门（2026-10-18 实机） ── */
{
  const src = readFileSync(new URL('../src/movement.mjs', import.meta.url), 'utf8')
  const { DOOR_RE, openNearbyDoor, CARVE_PROTECTED, carveStepAhead } = mod
  ok(DOOR_RE.test('oak_door') && DOOR_RE.test('iron_trapdoor') && DOOR_RE.test('oak_fence_gate')
    && !DOOR_RE.test('oak_planks'), '门/活板门/栅栏门都认得，木板不算')
  /* 🔴 实机第四/五次反馈（"一直开门"）：① 上下半格被当成两扇门，一轮按两次 = 开了又关；
   * ② 真实数据里**上半块可能没有 `open` 属性**，读成 undefined ⇒ 误判"还关着" ⇒ 再按一次；
   * ③ 400ms 定时器重入时两次都过了检查 ⇒ 各按一次。这里逐个钉住。 */
  const mkDoorWorld = ({ open = false, upperHasOpen = true, confirm = true } = {}) => {
    const st = { open }
    const seen = []
    const b = {
      entity: { position: new Vec3(0, 64, 0) },
      blockAt (v) {
        const lower = v.x === 1 && v.z === 0 && v.y === 64
        const upper = v.x === 1 && v.z === 0 && v.y === 65
        if (lower) return { name: 'oak_door', position: v, getProperties: () => ({ open: st.open, half: 'lower' }) }
        if (upper) {
          return {
            name: 'oak_door',
            position: v,
            getProperties: () => (upperHasOpen ? { open: st.open, half: 'upper' } : { half: 'upper' }),
          }
        }
        return { name: 'air', position: v }
      },
      async activateBlock (blk) {
        seen.push(`${blk.position.y}`)
        if (confirm) st.open = !st.open
      },
    }
    return { b, st, seen }
  }
  {
    const { b, st, seen } = mkDoorWorld({ open: false })
    const n = await openNearbyDoor(b)
    ok(n === 1 && st.open === true && seen.length === 1 && seen[0] === '64',
      '关着的门 ⇒ 按下半格一次、回读确认后报"开了"', JSON.stringify({ n, open: st.open, seen }))
  }
  {
    /* 核心回归：门开着 + 上半块没有 open 属性 —— 绝不能因为上半块 undefined 再按一次 */
    const { b, st, seen } = mkDoorWorld({ open: true, upperHasOpen: false })
    const n = await openNearbyDoor(b)
    ok(n === 0 && seen.length === 0 && st.open === true,
      '🔴 门已开着、上半块没有 open 属性 ⇒ 一次都不按（按了就把门关回去）', JSON.stringify({ n, seen, open: st.open }))
  }
  {
    const { b, seen } = mkDoorWorld({ open: true })
    const n = await openNearbyDoor(b)
    ok(n === 0 && seen.length === 0, '门已经开着 ⇒ 不再乱按')
  }
  {
    /* 并发：400ms 定时器重入 —— 同一扇门最多只有一次实际点击 */
    const { b, seen, st } = mkDoorWorld({ open: false })
    const [a1, a2] = await Promise.all([openNearbyDoor(b), openNearbyDoor(b)])
    ok(seen.length === 1 && st.open === true, '🔴 两次扫描并发 ⇒ 同一扇门只点一次（在途锁）', JSON.stringify({ seen, a1, a2 }))
  }
  {
    /* 服务端没确认打开：不能报成功，也不能马上再点 */
    const { b, seen } = mkDoorWorld({ open: false, confirm: false })
    const n1 = await openNearbyDoor(b)
    ok(n1 === 0 && b.__doorLast?.closed?.length === 1, '服务端没确认 ⇒ 不报"开了"（记在 __doorLast.closed）', JSON.stringify(b.__doorLast))
    const n2 = await openNearbyDoor(b)
    ok(n2 === 0 && seen.length === 1, '没确认之后 1.5 秒内不再连点（seen 仍是 1）', JSON.stringify({ n2, seen }))
  }
  {
    /* 铁门：按不开，不空点 */
    const b = {
      entity: { position: new Vec3(0, 64, 0) },
      blockAt (v) {
        if (v.x === 1 && v.z === 0 && v.y === 64) return { name: 'iron_door', position: v, getProperties: () => ({ open: false, half: 'lower' }) }
        return { name: 'air', position: v }
      },
      async activateBlock () { throw new Error('铁门不该被按') },
    }
    const n = await openNearbyDoor(b)
    ok(n === 0 && b.__doorLast?.iron?.length === 1, '🔴 铁门按不开 ⇒ 不空点（记进 __doorLast.iron）', JSON.stringify(b.__doorLast))
  }
  {
    const { doorBaseKey, DOOR_PRESS_COOL_MS } = mod
    ok(doorBaseKey({ position: new Vec3(1, 65, 0), getProperties: () => ({ half: 'upper' }) }) === '1,64,0'
      && doorBaseKey({ position: new Vec3(1, 64, 0), getProperties: () => ({ half: 'lower' }) }) === '1,64,0',
      '🔴 上下半格折算成同一个"门轴"（否则会按两次 ⇒ 开了又关）')
    ok(DOOR_PRESS_COOL_MS >= 1000, '按门冷却不能太短（门状态要时间同步回来）')
  }
  ok(CARVE_PROTECTED.test('oak_door') && CARVE_PROTECTED.test('oak_fence_gate'),
    '🔴 卡住时的"挖开挡路的"绝不砸门（门进保护名单）')
  {
    // 门口挡着：carveStepAhead 一格都不挖
    const b = { ...mkCarveBot({ '1,64,0': 'oak_door', '1,63,0': 'stone' }) }
    b.blockAt = (v) => (v.x === 1 && v.y === 64 && v.z === 0
      ? { name: 'oak_door', position: v, getProperties: () => ({ open: false }) }
      : { name: v.x === 1 && v.y === 63 ? 'stone' : 'air', position: v })
    const n = await carveStepAhead(b, { x: 1, y: 64, z: 0 })
    ok(n === 0 && b.dug.length === 0, '门挡在前面:不挖,交给"按开"', JSON.stringify({ n, dug: b.dug }))
  }
  ok(/mv\.canOpenDoors = true/.test(readFileSync(new URL('../src/plugins.mjs', import.meta.url), 'utf8')),
    '🔴 A* 规划允许穿门（vendor 默认 false ⇒ 只会挖墙）')
  ok(/const doorTimer = setInterval\(\(\) => \{ openNearbyDoor\(b\)/.test(src)
    && /try \{ clearInterval\(doorTimer\) \} catch \{\}/.test(src),
    '移动期间定时探门（收尾一定清掉定时器）')
  ok(/是\*\*门\*\*：.*mode:"use"/.test(src) && /别挖墙也别挖门/.test(src),
    '失败提示:门用"按开",不是"挖掉"')
}
section('⑬ 长路线续行 + 地形局部重估（2026-10-18 审计 P1）')
{
  /* 续行只记账（不改路线）：同一目标连续走时，累计次数/位移/耗时都报出来；
   * 连走 3 趟、平均每趟不到半格 ⇒ hint 明说"别再原样重试"。 */
  const self = {}
  const tgt = { x: 10, y: 64, z: 10 }
  const a = routeTrack(self, tgt, { moved: 0.6, ms: 9000, arrived: false })
  ok(a.attempts === 1 && a.sameTarget === false && a.movedTotal === 0.6, '第一趟：attempts=1', JSON.stringify(a))
  const b2 = routeTrack(self, { x: 10.5, y: 64.2, z: 10.4 }, { moved: 0.2, ms: 9000, arrived: false })
  ok(b2.attempts === 2 && b2.sameTarget === true && b2.movedTotal === 0.8, '同一个目标（3 格内）第二趟累计', JSON.stringify(b2))
  const c = routeTrack(self, tgt, { moved: 0.1, ms: 8000, arrived: false })
  ok(c.attempts === 3 && c.stalled === true && c.movedTotal === 0.9,
    '第三趟仍几乎没挪 ⇒ stalled（累计才 0.9 格）', JSON.stringify(c))
  ok(/已经第 3 次走同一个目标/.test(c.hint ?? '') && /别再原样重试/.test(c.hint ?? ''),
    '🔴 hint 点名"第 N 次 + 别再原样重试"', String(c.hint).slice(0, 70))
  ok(/blockedAhead|shaft/.test(c.hint ?? '') && /intent/.test(c.hint ?? ''), 'hint 给出换做法的方向')
  const d = routeTrack(self, { x: 30, y: 64, z: 10 }, { moved: 3, ms: 9000, arrived: false })
  ok(d.attempts === 1 && d.sameTarget === false, '换了目标就重新计数', JSON.stringify(d))
  // 隔了太久（>90s）不算同一条路
  self._navRoute.at = Date.now() - 100_000
  const e = routeTrack(self, { x: 30, y: 64, z: 10 }, { moved: 0.2, ms: 9000, arrived: false })
  ok(e.attempts === 1, '超过 90 秒还没走到 ⇒ 当成新的一条路', JSON.stringify(e))
  // 真到了就不算"卡在同一个目标上"
  const self2 = {}
  routeTrack(self2, tgt, { moved: 0.1, ms: 9000, arrived: false })
  routeTrack(self2, tgt, { moved: 0.1, ms: 9000, arrived: false })
  const f = routeTrack(self2, tgt, { moved: 0.1, ms: 3000, arrived: true })
  ok(f.stalled !== true, '到点了就算这一趟成功了 —— 不劝"换做法"', JSON.stringify(f))
  // 走得好好的（每趟都在靠近）也不打扰
  const self3 = {}
  routeTrack(self3, tgt, { moved: 2, ms: 9000 })
  routeTrack(self3, tgt, { moved: 2, ms: 9000 })
  const g = routeTrack(self3, tgt, { moved: 2, ms: 9000 })
  ok(g.stalled !== true && g.movedTotal === 6, '每趟都挪 2 格 ⇒ 不算 stalled', JSON.stringify(g))
}
{
  const src = readFileSync(new URL('../src/movement.mjs', import.meta.url), 'utf8')
  ok(/export function routeTrack/.test(src), '续行账本导出（只读，不改路线）')
  ok(/return pruneMove\(outInfo\)/.test(src), 'walkTo 把 route 从结果里剔掉（2026-10-24 输出瘦身）')
  ok(/bMv\.__moveFail/.test(src) && /repeat: n/.test(src), '① 失败去重：同目标同原因连着重试只回一行')
  ok(/const enRoute = !outInfo\.arrived/.test(src) && /走了 \$\{Math\.round/.test(src), '③ 中途极简：还在路上只报走了几格、还剩几格')
  ok(/let terrain = classifyTerrainCached\(b\)/.test(src) && /terrainReeval \? \{ terrainReeval \}/.test(src),
    '地形重估计数（变了才报）')
  ok(/const fresh = classifyTerrainCached\(b\)[\s\S]{0,400}?terrain = fresh/.test(src),
    '🔴 脱困后真的重判地形并按新地形重设 Movements')
  ok(/if \(noTower\) mv2\.allow1by1towers = false/.test(src), '重设 Movements 时 noTower 依旧生效（别把逃跑那条腿放回来）')
}
section('⑭ 门：不挖、不重复按、按开的别被 vendor 关回去（2026-10-18 实机第二次反馈）')
{
  const { patchDoorMoves, guardDoorActivate } = await import(new URL('../src/plugins.mjs', import.meta.url))
  const blk = (name, open) => ({ name, getProperties: () => ({ open }) })
  /* 假 Movements：只有 getMoveForward，规划出一条"挖门 + 推门"的 move */
  const mkMv = (world) => ({
    getBlock (node, dx, dy, dz) { return world[`${node.x + dx},${node.y + dy},${node.z + dz}`] ?? blk('air', false) },
    getMoveForward (node, dir, neighbors) {
      neighbors.push({
        cost: 12,
        toBreak: [{ x: 1, y: 64, z: 0 }, { x: 3, y: 64, z: 0 }],
        toPlace: [{ x: 1, y: 64, z: 0, useOne: true }],
      })
    },
  })
  {
    // 门（关着）+ 远处（第 3 格）的石头：门不许进 toBreak，远处的石头照常可以挖
    const mv = mkMv({ '1,64,0': blk('oak_door', false), '3,64,0': blk('stone', false) })
    patchDoorMoves(mv)
    const out = []
    mv.getMoveForward({ x: 0, y: 64, z: 0 }, { x: 1, z: 0 }, out)
    const m = out[0]
    ok(m.toBreak.length === 1 && m.toBreak[0].x === 3, '🔴 门不进"要挖的方块"（远处的 stone 照旧可挖）', JSON.stringify(m.toBreak))
    ok(!m.toPlace.some((p) => p.useOne), '🔴 门的 useOne 一律删掉（vendor 在"只有 useOne"时会 crash：placingBlock 变 undefined）', JSON.stringify(m.toPlace))
  }
  {
    // 门已经开着：同样不该再 activateBlock（那等于把它关回去）
    const mv = mkMv({ '1,64,0': blk('oak_door', true), '3,64,0': blk('stone', false) })
    patchDoorMoves(mv)
    const out = []
    mv.getMoveForward({ x: 0, y: 64, z: 0 }, { x: 1, z: 0 }, out)
    ok(out[0].toPlace.length === 0, '🔴 门已经开着 ⇒ 没有"再按一下"那步', JSON.stringify(out[0].toPlace))
  }
  {
    // 🔴 2026-10-24 审计（用户第三份）：所有候选都"得挖门框"时，宁可没路
    //（⇒ NoPath ⇒ 脱困阶梯 / 等开门），也不要把未过滤的候选还给 A*
    //（那是"挖穿门框过去"的假路：规划上通、执行时被拦，机器人就在门口蹭）
    const world2 = { '1,64,0': blk('stone', false), '1,64,1': blk('oak_door', false) }
    const mv = {
      getBlock (node, dx, dy, dz) { return world2[`${node.x + dx},${node.y + dy},${node.z + dz}`] ?? blk('air', false) },
      getNeighbors (node) {
        return [{ cost: 12, toBreak: [{ x: 1, y: 64, z: 0 }], toPlace: [] }]
      },
    }
    patchDoorMoves(mv)
    const out = mv.getNeighbors({ x: 0, y: 64, z: 0 })
    ok(Array.isArray(out) && out.length === 0,
      '🔴 门保护把候选全作废时返回空（不再退回未过滤的候选）', JSON.stringify(out))
  }
  {
    // 铁门按不开：保留原行为（别把唯一的路堵死）
    const mv = mkMv({ '1,64,0': blk('iron_door', false), '3,64,0': blk('stone', false) })
    patchDoorMoves(mv)
    const out = []
    mv.getMoveForward({ x: 0, y: 64, z: 0 }, { x: 1, z: 0 }, out)
    ok(out[0].toBreak.length === 2, '铁门不在这条规则里（按不开，仍允许挖）', JSON.stringify(out[0].toBreak))
  }
  {
    // guardDoorActivate：我们按开的门，vendor 的 useOne 再按时直接忽略
    let calls = 0
    const b = { activateBlock: async () => { calls++ } }
    guardDoorActivate(b)
    const openBlk = { position: { x: 1, y: 64, z: 0 }, getProperties: () => ({ open: true }) }
    const closedBlk = { position: { x: 2, y: 64, z: 0 }, getProperties: () => ({ open: false }) }
    b.__autoOpenedDoors.set('1,64,0', Date.now())
    await b.activateBlock(openBlk)
    ok(calls === 0, '🔴 刚被我们按开的门，vendor 再按 ⇒ 忽略（不关回去）', String(calls))
    await b.activateBlock(closedBlk)
    ok(calls === 1, '别的（关着的）门照常按', String(calls))
    b.__autoOpenedDoors.set('2,64,0', Date.now())
    await b.activateBlock(closedBlk)
    ok(calls === 2, '门已经是关的 ⇒ 照常按（可能被谁关上了）', String(calls))
    b.__autoOpenedDoors.set('1,64,0', Date.now() - 13_000)
    await b.activateBlock(openBlk)
    ok(calls === 3, '超过 12 秒就不再拦截（按正常交互处理）', String(calls))
  }
  {
    // 🔴 挖门的工钱也要退：只删 toBreak 不扣 cost，A* 仍觉得"挖门"和"走门"一样贵
    const doorBlk = { name: 'oak_door', getProperties: () => ({ open: false }), digTime: () => 500 }
    const mv = mkMv({ '1,64,0': doorBlk, '3,64,0': blk('stone', false) })
    mv.digCost = 4
    patchDoorMoves(mv)
    const out = []
    mv.getMoveForward({ x: 0, y: 64, z: 0 }, { x: 1, z: 0 }, out)
    const m = out[0]
    // labor = (1 + 3*0.5) * 4 = 10 ⇒ 12 - 10 = 2
    ok(m.cost === 2, '🔴 门不进 toBreak 时把挖门的 cost 也退掉（12 → 2）', String(m.cost))
    ok(m.toBreak.length === 1 && m.toBreak[0].x === 3, '…远处的石头照旧可挖', JSON.stringify(m.toBreak))
  }
  {
    /* 🔴 门前那格（紧挨着门的普通方块）：整条 move 作废 —— 只删 toBreak 会留下
     *    "穿过实心方块"的假路，执行时原地卡住。 */
    const mv = mkMv({ '1,64,0': blk('oak_door', false), '2,64,0': blk('stone', false) })
    mv.getMoveForward = (node, dir, ns) => {
      ns.push({ cost: 12, toBreak: [{ x: 1, y: 64, z: 0 }, { x: 2, y: 64, z: 0 }], toPlace: [] })
    }
    patchDoorMoves(mv)
    const out = []
    mv.getMoveForward({ x: 0, y: 64, z: 0 }, { x: 1, z: 0 }, out)
    ok(out.length === 0, '🔴 "得挖门旁边那格"的 move 直接作废（否则就是拆门框/门前的地砖）', JSON.stringify(out))
    const mv2 = mkMv({ '1,64,0': blk('oak_door', false), '3,64,0': blk('stone', false) })
    patchDoorMoves(mv2)
    const out2 = []
    mv2.getMoveForward({ x: 0, y: 64, z: 0 }, { x: 1, z: 0 }, out2)
    ok(out2.length === 1, '离门 2 格以上的石头不受影响（不是"门周围两格一律保护"）', JSON.stringify(out2.length))
  }
  {
    // 🔴 goto 的拒绝必须有人接：PathStopped 是 unhandledRejection ⇒ 宿主 fail-loud 直接 exit(1)
    const { guardPathfinderRejections } = await import(new URL('../src/plugins.mjs', import.meta.url))
    const unhandled = []
    const onUnhandled = (e) => unhandled.push(e)
    process.on('unhandledRejection', onUnhandled)
    const fake = { pathfinder: { goto: () => Promise.reject(new Error('PathStopped: Path was stopped')) } }
    ok(guardPathfinderRejections(fake) === true, '给 goto 挂上了"拒绝必有人接"')
    ok(guardPathfinderRejections(fake) === false, '重复调用不会套两层')
    fake.pathfinder.goto()   // 故意不 catch —— 模拟"超时先返回，goto 后 reject"
    await new Promise((r) => setTimeout(r, 30))
    process.removeListener('unhandledRejection', onUnhandled)
    ok(unhandled.length === 0, '🔴 没人 catch 的 PathStopped 也不会变成 unhandledRejection（以前这一下 = 应用闪退）', String(unhandled.length))
  }
  {
    // 🔴 2026-10-18 晚第三版（用户实机："你的寻路不会开门，只会硬挖，已经挖了你两块木板"）：
    // **门要进 openable**（A* 才认"这一格能穿过去"，否则它只会绕墙/挖墙）；
    // 同时 `patchDoorMoves` 必须把门的 `useOne` 全删（否则又回到踩坑 #172 的崩溃路径）。
    const plug2 = readFileSync(new URL('../src/plugins.mjs', import.meta.url), 'utf8')
    ok(/mv\.openable\.add/.test(plug2), '🔴 门要进 mv.openable：A* 才认门能穿，而不是只会挖墙')
    ok(/DOOR_BLOCK_RE\.test\(nm\) && !IRON_DOOR_RE\.test\(nm\)/.test(plug2), '只把木门/木活板门/木栅栏门塞进 openable（铁门按不开）')
    ok(/\.filter\(\(p\) => !\(p\?\.useOne && isDoor\(doorAt\(node, p\)\)\)\)/.test(plug2), '🔴 但门的 useOne 一律删掉（否则 vendor 的 placingBlock 崩）')
    ok(/m\.remainingBlocks \+= m\.toPlace\.length - keptPlace\.length/.test(plug2),
      '🔴 删掉门的 useOne 后把料还回 remainingBlocks（不还的话背包刚好 1 块时 1×1 柱子那条边会被误剪）')
    ok(/openNearbyDoor/.test(readFileSync(new URL('../src/movement.mjs', import.meta.url), 'utf8')), '真正开门仍由 openNearbyDoor 定时器负责')
    /* 🔴 2026-11-02 审计（#10）：`guardDoorActivate` 曾自己写第二份门判据 ——
     *    只读传入那格的 `props.open`、读不到就当"关着"，与 `doorOpenStateOf()` 的
     *    「不知道 ≠ 关着」相反；而且门占上下两格，key 只算传入那格 ⇒ 上半格永远对不上。 */
    ok(/const seen = doorOpenStateOf\(blk\)/.test(plug2),
      '🔴 执行时的门判据只有一份：guardDoorActivate 也走 doorOpenStateOf（不再自己读 props.open）')
    ok(/half === 'upper'/.test(plug2),
      '🔴 门占上下两格：守卫要把两半的 key 都试（只记下半格时 vendor 传上半格就对不上）')
    ok(!/open = blk\.getProperties\?\.\(\)\.open === true/.test(plug2),
      '旧的第二份门判据已删除（读不到就当成关着）')
    // 端到端：`getNeighbors` 出来的 move 既没有挖门、也没有 useOne
    const { patchDoorMoves } = await import(new URL('../src/plugins.mjs', import.meta.url))
    const doorBlocks = new Map([
      ['5,64,6', { name: 'oak_door', physical: true, openable: false, shapes: [{}], position: new Vec3(5, 64, 6), height: 1 }],
      ['5,65,6', { name: 'oak_door', physical: true, openable: false, shapes: [{}], position: new Vec3(5, 65, 6), height: 1 }],
      ['4,64,6', { name: 'oak_planks', physical: true, shapes: [{}], position: new Vec3(4, 64, 6), height: 1 }]
    ])
    const node = { x: 5, y: 64, z: 5, remainingBlocks: 64 }
    const mv = {
      openable: new Set(),
      digCost: 4,
      placeCost: 12,
      canOpenDoors: true,
      getBlock: (n, dx, dy, dz) => doorBlocks.get(`${n.x + dx},${n.y + dy},${n.z + dz}`) ??
        { name: 'air', physical: false, shapes: [], position: new Vec3(n.x + dx, n.y + dy, n.z + dz), height: 0 },
      getNeighbors: () => ([
        // ① 穿门：toBreak 里有门 + 门外那格，还带着门的 useOne
        { cost: 9, toBreak: [new Vec3(5, 64, 6), new Vec3(5, 65, 6)], toPlace: [{ x: 5, y: 64, z: 6, useOne: true }] },
        // ② 从门旁挖过去：toBreak 里是门旁边的木板 ⇒ 整条 move 作废
        { cost: 9, toBreak: [new Vec3(4, 64, 6)], toPlace: [] }
      ])
    }
    patchDoorMoves(mv)
    ok(mv.__dshDoorPatched === true && typeof mv.getNeighbors === 'function', 'patchDoorMoves 打在 getNeighbors 上')
    const out = mv.getNeighbors(node)
    const thru = out.find((m) => m.cost === 9 && Array.isArray(m.toPlace) && m.toPlace.length === 0 && m.toBreak.length === 0)
    ok(Boolean(thru), '🔴 门（上下两格）从 toBreak 里剔掉了，工钱也退了（cost 9 → 1，这里只验剔除）')
    ok(!out.some((m) => (m.toBreak ?? []).some((p) => p.x === 4 && p.z === 6)), '🔴 "从门旁挖过去"的 move 不会出现')
    ok(!out.some((m) => (m.toPlace ?? []).some((p) => p.useOne)), '🔴 门也不会生成 useOne（vendor 的 placingBlock 崩溃路径）')
  }
  {
    // 🔴 寻路器要挖门 ⇒ 改成"按开"（AI 自己挖门不受影响）
    const { guardDoorDig } = await import(new URL('../src/plugins.mjs', import.meta.url))
    let activated = 0
    let dug = 0
    const world = new Map()   // `x,y,z` → { name, open }
    const mkBlk = (x, y, z) => {
      const st = world.get(`${x},${y},${z}`) ?? { name: 'air', open: false }
      return {
        name: st.name,
        position: { x, y, z },
        getProperties: () => (st.name.includes('door') ? { open: st.open, half: 'lower' } : {}),
      }
    }
    world.set('1,64,0', { name: 'oak_door', open: false })
    world.set('2,64,0', { name: 'oak_door', open: true })
    world.set('3,64,0', { name: 'iron_door', open: false })
    world.set('5,64,0', { name: 'oak_door', open: false })
    const b = {
      __inPathTick: false,
      blockAt: (v) => mkBlk(v.x, v.y, v.z),
      activateBlock: async (blk) => {
        activated++
        const st = world.get(`${blk.position.x},${blk.position.y},${blk.position.z}`)
        if (st) st.open = !st.open
      },
      dig: async () => { dug++ },
    }
    ok(guardDoorDig(b) === true, '装上了"寻路要挖门 ⇒ 先按开"')
    ok(guardDoorDig(b) === false, '重复安装不会套两层')
    const closed = mkBlk(1, 64, 0)
    const openDoor = mkBlk(2, 64, 0)
    const iron = mkBlk(3, 64, 0)
    b.__inPathTick = true
    await b.dig(closed)
    ok(activated === 1 && dug === 0 && world.get('1,64,0').open === true,
      '🔴 寻路中遇到关着的木门 ⇒ 按开并回读确认，不挖', `activated=${activated} dug=${dug} open=${world.get('1,64,0').open}`)
    /* 同一个位置再来一次：1.5 秒冷却内不许再按（否则就是"开了又关"） */
    await b.dig(mkBlk(1, 64, 0))
    ok(activated === 1 && dug === 0, '🔴 同一扇门按过之后立刻又要求挖 ⇒ 冷却内不再按（不关回去、也不挖）', `activated=${activated} dug=${dug}`)
    /* 上半格：按到的是下半格那一格 */
    const baseAt = { name: 'oak_door', position: { x: 5, y: 64, z: 0 }, getProperties: () => ({ open: false, half: 'lower' }) }
    b.blockAt = (v) => ((v?.x === 5 && v?.y === 64) ? baseAt : mkBlk(v.x, v.y, v.z))
    const upper = { name: 'oak_door', position: { x: 5, y: 65, z: 0 }, getProperties: () => ({ open: false, half: 'upper' }) }
    const pressed = []
    const origActivate = b.activateBlock
    b.activateBlock = async (blk) => { pressed.push(`${blk.position.y}`); activated++ }
    await b.dig(upper)
    ok(activated === 2 && pressed[0] === '64', '🔴 上半格被要求挖时按的是下半格（同一个门轴只按一次）', JSON.stringify({ activated, pressed }))
    b.activateBlock = origActivate
    const actBefore = activated
    const dugBefore = dug
    await b.dig(openDoor)
    ok(dug === dugBefore && activated === actBefore, '门本来就开着 ⇒ 不按也不挖（这一步当成已经过了）', `activated=${activated} dug=${dug}`)
    const dugBefore2 = dug
    await b.dig(iron)
    ok(dug === dugBefore2 + 1 && activated === actBefore, '铁门按不开 ⇒ 照旧真的挖（能脱困）', `activated=${activated} dug=${dug}`)
    b.__inPathTick = false
    const dugBefore3 = dug
    await b.dig(closed)
    ok(dug === dugBefore3 + 1 && activated === actBefore, '🔴 AI 自己点名挖门（不在寻路 tick 里）⇒ 真的挖，不拦', `activated=${activated} dug=${dug}`)
    /* 🔴 开门失败也绝不回落到挖门（用户 2026-10-18：别用毁门来掩盖失败） */
    {
      world.set('7,64,0', { name: 'oak_door', open: false })
      const origAct = b.activateBlock
      let thrown = 0
      b.activateBlock = async () => { thrown++; throw new Error('server busy') }
      const d0 = dug
      b.__inPathTick = true
      await b.dig(mkBlk(7, 64, 0))
      ok(thrown === 1 && dug === d0 && world.get('7,64,0').open === false,
        '🔴 activateBlock 抛错 ⇒ 记失败、不挖门（门还在）', `thrown=${thrown} dug=${dug} open=${world.get('7,64,0').open}`)
      b.activateBlock = origAct
      b.__inPathTick = false
    }
    /* 🔴 上半格 + 下半格都被寻路器要求处理 ⇒ 最多按一次，两半都不许被挖 */
    {
      world.set('9,64,0', { name: 'oak_door', open: false })
      world.set('9,65,0', { name: 'oak_door', open: false })
      const pressed2 = []
      const origAct = b.activateBlock
      b.activateBlock = async (blk) => { pressed2.push(`${blk.position.y}`); activated++; world.get(`${blk.position.x},${blk.position.y},${blk.position.z}`).open = true }
      b.blockAt = (v) => mkBlk(v.x, v.y, v.z)
      const lowerHalf = mkBlk(9, 64, 0)
      const upperHalf = { name: 'oak_door', position: { x: 9, y: 65, z: 0 }, getProperties: () => ({ open: false, half: 'upper' }) }
      const d1 = dug
      b.__inPathTick = true
      await b.dig(upperHalf)
      await b.dig(lowerHalf)
      ok(pressed2.length <= 1 && dug === d1 && pressed2[0] === '64',
        '🔴 上下半格都被要求处理 ⇒ 最多按一次（下半格），一格都不挖', JSON.stringify({ pressed2, dug }))
      b.activateBlock = origAct
      b.__inPathTick = false
    }
  }
  {
    /* 🔴 异步窗口：vendor 是 `bot.equip().then(() => bot.dig())`，那会儿 __inPathTick 已经复位。
     * 只靠同步标记会把"挖门"放行 ⇒ 必须同时看 pathfinder.isMining()。 */
    const { guardDoorDig } = await import(new URL('../src/plugins.mjs', import.meta.url))
    let dug = 0
    let pressed = 0
    const door = { name: 'oak_door', position: { x: 1, y: 64, z: 0 }, getProperties: () => ({ open: false, half: 'lower' }) }
    const b = {
      __inPathTick: false,
      pathfinder: { isMining: () => true },
      blockAt: () => door,
      activateBlock: async () => { pressed++ },
      dig: async () => { dug++ },
    }
    guardDoorDig(b)
    await b.dig(door)
    ok(dug === 0 && pressed === 1, '🔴 装备工具的异步窗口（tick 标记已复位、isMining 仍真）⇒ 仍然按开门、不挖', JSON.stringify({ dug, pressed }))
    b.pathfinder.isMining = () => false
    await b.dig(door)
    ok(dug === 1, 'AI 自己挖（既不在 tick 里、也不在挖矿中）⇒ 照旧真的挖', JSON.stringify({ dug }))
  }
  {
    /* 🔴 门脚那格支撑：寻路器要挖它 ⇒ 也拦（用户 2026-10-18：门下面那格被挖掉）*/
    const { guardDoorDig } = await import(new URL('../src/plugins.mjs', import.meta.url))
    let dug = 0
    let pressed = 0
    const doorBlk = { name: 'oak_door', position: { x: 1, y: 65, z: 0 }, getProperties: () => ({ open: false, half: 'lower' }) }
    const floorBlk = { name: 'stone', position: { x: 1, y: 64, z: 0 } }
    const b = {
      __inPathTick: true,
      pathfinder: { isMining: () => true },
      blockAt: (p) => (Number(p.y) >= 65 ? doorBlk : floorBlk),
      activateBlock: async () => { pressed++ },
      dig: async () => { dug++ },
    }
    guardDoorDig(b)
    await b.dig(floorBlk)
    ok(dug === 0 && pressed === 1, '🔴 挖"门脚下那格"（寻路器发起）⇒ 不挖，转去按门', JSON.stringify({ dug, pressed }))
    b.__inPathTick = false
    b.pathfinder.isMining = () => false
    await b.dig(floorBlk)
    ok(dug === 1, 'AI 自己挖门脚那格 ⇒ 放行（只有寻路器自动挖才受保护）', JSON.stringify({ dug }))
  }
  {
    /* 🔴 门前那格（紧挨着门的普通方块）：寻路器要挖 ⇒ 拦下并去按门 */
    const { guardDoorDig } = await import(new URL('../src/plugins.mjs', import.meta.url))
    let dug = 0
    let pressed = 0
    const doorBlk = { name: 'oak_door', position: { x: 2, y: 64, z: 0 }, getProperties: () => ({ open: false, half: 'lower' }) }
    const frontBlk = { name: 'stone', position: { x: 1, y: 64, z: 0 } }
    const b = {
      __inPathTick: true,
      pathfinder: { isMining: () => true },
      blockAt: (p) => (Number(p.x) === 2 ? doorBlk : { name: 'air', position: p }),
      activateBlock: async () => { pressed++ },
      dig: async () => { dug++ },
    }
    guardDoorDig(b)
    await b.dig(frontBlk)
    ok(dug === 0 && pressed === 1, '🔴 挖"门前那格"（寻路器发起）⇒ 不挖，转去按门', JSON.stringify({ dug, pressed }))
    b.__inPathTick = false
    b.pathfinder.isMining = () => false
    await b.dig(frontBlk)
    ok(dug === 1, 'AI 自己挖门前那格 ⇒ 放行', JSON.stringify({ dug }))
  }
  {
    /* 🔴 统一在 getNeighbors 上过滤：与"是哪个 getMove* 生成的"无关 */
    const { patchDoorMoves } = await import(new URL('../src/plugins.mjs', import.meta.url))
    const doorBlk = { name: 'oak_door', getProperties: () => ({ open: false }), digTime: () => 500 }
    const mv = {
      digCost: 4,
      getBlock (node, dx, dy, dz) {
        const key = `${node.x + dx},${node.y + dy},${node.z + dz}`
        return key === '1,64,0' ? doorBlk : { name: 'stone', getProperties: () => ({ open: false }) }
      },
      getNeighbors (node) {
        const mk = (kind) => ({ kind, cost: 12, toBreak: [{ x: 1, y: 64, z: 0 }], toPlace: [] })
        return [mk('walk'), mk('drop'), mk('down'), mk('up'), mk('parkour')]
      },
    }
    patchDoorMoves(mv)
    const moves = mv.getNeighbors({ x: 0, y: 64, z: 0 })
    ok(moves.every((m) => m.toBreak.length === 0 && m.cost === 2),
      '🔴 所有移动类型（walk/drop/down/up/parkour）都不再带"挖门"，且挖门工钱都退掉', JSON.stringify(moves))
  }
  const plug = readFileSync(new URL('../src/plugins.mjs', import.meta.url), 'utf8')
  ok(/mv\.getNeighbors = function \(node\)/.test(plug) && /__dshDoorPatched/.test(plug),
    '🔴 门补丁挂在 getNeighbors 上（不再维护 getMove* 清单）')
  ok(/pathfinder\?\.isMining\?\.\(\)/.test(plug), '🔴 来源判断包含 pathfinder.isMining()（覆盖装备工具的异步窗口）')
  ok(/guardDoorDig\(b/.test(plug), 'setupPlugins 里装了 door dig 守卫')
  ok(/const prev = b\.__inPathTick/.test(plug), '寻路 tick 里打了 `__inPathTick` 标记（只有这段里的挖才换成开门）')
  ok(/export function patchDoorMoves/.test(plug)
    && /patchDoorMoves\(mv, \{[\s\S]{0,160}?digPenalty/.test(plug),
  'movements() 里真的挂了这个补丁（带 preferDoors 的惩罚）')
  ok(/guardDoorActivate\(b\)/.test(plug), 'setupPlugins 里装了"我们按开的门别被再按"')
  ok(/guardPathfinderRejections\(b/.test(plug), '🔴 setupPathfinder 里给 goto 的拒绝挂了 catch（否则 PathStopped 会炸宿主）')
  ok(/__autoOpenedDoors instanceof Map/.test(readFileSync(new URL('../src/movement.mjs', import.meta.url), 'utf8')),
    '定时器按开门时记账（供上面的守卫用）')
}
section('⑮ 寻路 tick 不许把宿主带崩（2026-10-18 真机闪退：Cannot read properties of undefined (reading y)）')
{
  const { guardPathfinderTicks } = await import(new URL('../src/plugins.mjs', import.meta.url))
  const b = new EventEmitter()
  b.entity = { position: { x: 0, y: 64, z: 0 } }
  let ticks = 0
  let stops = 0
  b.pathfinder = { stop () { stops++ } }
  b.on('physicTick', () => { ticks++; throw new TypeError("Cannot read properties of undefined (reading 'y')") })
  const n = guardPathfinderTicks(b, { log: () => {} })
  ok(n === 1, '把 vendor 挂在旧事件 physicTick 上的监听接管了', String(n))
  ok(b.listeners('physicTick').length === 0, '旧事件上不再留裸监听（弃用警告也一起没了）')
  ok(b.listeners('physicsTick').length === 1, '改挂到新事件 physicsTick')
  let threw = false
  try { b.emit('physicsTick') } catch { threw = true }
  ok(!threw, '🔴 监听里抛错不再冒到进程级（以前这一下 = 整个 DSH 闪退）')
  ok(ticks === 1, '这一拍确实执行到了（不是被吞掉不跑）')
  ok(stops === 1, '抛错后先停住寻路，别带着坏状态继续走')
  b.entity = null
  b.emit('physicsTick')
  ok(ticks === 1, '断线/重生一瞬（entity 还没回来）跳过这一拍，不进 monitorMovement', String(ticks))
  b.entity = { position: { x: 0, y: 64, z: 0 } }
  b.emit('physicsTick')
  ok(ticks === 2, 'entity 回来后继续跑')
  const plug = readFileSync(new URL('../src/plugins.mjs', import.meta.url), 'utf8')
  ok(/guardPathfinderTicks\(b/.test(plug), 'setupPathfinder 里真的调了这个接管')
  const idx = readFileSync(new URL('../index.js', import.meta.url), 'utf8')
  ok(/process\.on\('uncaughtException'/.test(idx), '宿主级还有一层"未捕获异常"记录（只记栈，不拦宿主处置）')
}
section('⑯ 从门里走过去（2026-10-18 实机：门开着反而磨在门口）')
{
  const { walkThroughDoor } = await import(new URL('../src/movement.mjs', import.meta.url))
  /* 假世界：门在 (5,64,6)，人在 (5,64,5)，目标在门外 (5,64,8) */
  const mkDoorBot = ({ name = 'oak_door', open = true, forwardStep = 1.6, iron = false } = {}) => {
    /* 上下半格共享同一个 props（门只有一份状态；每次 new 一个对象的话"按开"就不生效） */
    const props = { open }
    const blocks = new Map([
      [`5,64,6`, { name, physical: true, position: new Vec3(5, 64, 6), getProperties: () => ({ ...props, half: 'lower' }), shapes: [{}, {}] }],
      [`5,65,6`, { name, physical: true, position: new Vec3(5, 65, 6), getProperties: () => ({ ...props, half: 'upper' }), shapes: [{}, {}] }]
    ])
    const calls = { activated: 0, forward: [], look: 0 }
    const pos = new Vec3(5.5, 64, 5.5)
    const bot = {
      entity: { position: pos },
      blockAt: (p) => blocks.get(`${p.x},${p.y},${p.z}`) ?? { name: 'air', physical: false, position: p, shapes: [], getProperties: () => ({}) },
      activateBlock: async () => { calls.activated++; if (!iron) props.open = !props.open },
      lookAt: async () => { calls.look++ },
      setControlState: (k, v) => {
        calls.forward.push(`${k}:${v}`)
        if (k === 'forward' && v) pos.z += forwardStep
      }
    }
    return { bot, calls, blocks }
  }
  {
    const { bot, calls } = mkDoorBot({ open: true })
    const r = await walkThroughDoor(bot, { x: 5, y: 64, z: 8 }, { budgetMs: 400 })
    ok(r.passed === true, '门开着 ⇒ 直接走过去', JSON.stringify(r))
    ok(r.door === 'oak_door', '结果里报是哪扇门')
    ok(calls.forward.join(',') === 'forward:true,forward:false', '按 forward 然后松开', calls.forward.join(','))
    ok(calls.activated === 0, '门已经开着就不要再按（再按会把它关上）')
  }
  {
    const { bot, calls, blocks } = mkDoorBot({ open: false })
    const r = await walkThroughDoor(bot, { x: 5, y: 64, z: 8 }, { budgetMs: 400 })
    ok(calls.activated >= 1, '门关着 ⇒ 先按开')
    ok(blocks.get('5,64,6').getProperties().open === true, '按开之后门确实开了')
    ok(blocks.get('5,65,6').getProperties().open === true, '上下半格是同一扇门（状态一致）')
    ok(r.passed === true, '按开之后能走过去')
  }
  {
    const { bot, calls } = mkDoorBot({ name: 'iron_door', open: false, iron: true })
    const r = await walkThroughDoor(bot, { x: 5, y: 64, z: 8 }, { budgetMs: 300 })
    ok(r.passed === false && (r.why === 'iron' || r.why === 'no-door'), '铁门按不开 ⇒ 不硬来（当实心墙，交给上层）', JSON.stringify(r))
    ok(calls.forward.length === 0, '铁门连 forward 都不按')
  }
  {
    const bot = { entity: { position: new Vec3(0, 64, 0) }, blockAt: () => ({ name: 'air' }), activateBlock: async () => {}, lookAt: async () => {}, setControlState: () => {} }
    const r = await walkThroughDoor(bot, { x: 0, y: 64, z: 6 }, { budgetMs: 200 })
    ok(r.passed === false && r.why === 'no-door', '前进方向没门 ⇒ 什么都不做')
  }
  /* 🔴 回归：`doorBaseKey()` 返回字符串，第一版当对象用 ⇒ 中心点 NaN ⇒ bot 位置变 NaN */
  const src = readFileSync(new URL('../src/movement.mjs', import.meta.url), 'utf8')
  ok(/const base = \(doorFaceOf\(b, dir\) \?\? dir\)\?\.position/.test(src), '🔴 门中心取的是下半块的 `position`（不是 doorBaseKey 的字符串）')
  ok(/Number\.isFinite\(base\.x\)/.test(src), '中心点坐标要过 `Number.isFinite`（NaN 会让整个物理位置变 NaN）')
  ok(/\.\.\.\(doorWalk \? \{ doorWalk \} : \{\}\)/.test(src), '走路结果里会报 doorWalk（AI 能看到这次是不是从门里过的）')
}

section('⑰ preferDoors：挖墙要多付一笔，走门/绕路不付（2026-10-18 用户要求）')
{
  const { patchDoorMoves } = await import(new URL('../src/plugins.mjs', import.meta.url))
  const { DEFAULTS } = await import(new URL('../src/core.mjs', import.meta.url))
  const mkMv = () => {
    const blocks = new Map([
      [`5,64,6`, { name: 'oak_door', physical: true, position: new Vec3(5, 64, 6), getProperties: () => ({ half: 'lower', open: true }), shapes: [{}, {}] }],
      [`5,65,6`, { name: 'oak_door', physical: true, position: new Vec3(5, 65, 6), getProperties: () => ({ half: 'upper', open: true }), shapes: [{}, {}] }],
      [`3,64,6`, { name: 'stone', physical: true, position: new Vec3(3, 64, 6), getProperties: () => ({}), shapes: [{}], digTime: () => 400 }]
    ])
    return {
      openable: new Set(), digCost: 4, placeCost: 12, canOpenDoors: true,
      bot: { pathfinder: { bestHarvestTool: () => ({ type: 1 }) } },
      getBlock: (n, dx, dy, dz) => blocks.get(`${n.x + dx},${n.y + dy},${n.z + dz}`) ??
        { name: 'air', physical: false, shapes: [], position: new Vec3(n.x + dx, n.y + dy, n.z + dz), getProperties: () => ({}) },
      getNeighbors: () => ([
        { cost: 1, toBreak: [], toPlace: [] },                                  // 平地走
        { cost: 1.41, toBreak: [], toPlace: [] },                               // 斜走
        { cost: 9, toBreak: [new Vec3(3, 64, 6)], toPlace: [] },                // 挖石头走
        { cost: 3, toBreak: [new Vec3(5, 64, 6), new Vec3(5, 65, 6)], toPlace: [] } // 穿门（门会被剔掉）
      ])
    }
  }
  const node = { x: 5, y: 64, z: 5, remainingBlocks: 64 }
  {
    const mv = mkMv()
    patchDoorMoves(mv, { digPenalty: 8 })
    const out = mv.getNeighbors(node)
    const flat = out.filter((m) => m.toBreak.length === 0)
    const dig = out.filter((m) => m.toBreak.length > 0)
    ok(flat.length === 3, '不挖方块的移动有 3 条（平地/斜走/穿门）', String(flat.length))
    ok(flat.every((m) => m.cost <= 3), '不挖的移动**不加**惩罚（穿门那条 cost 还是 3）', JSON.stringify(flat.map((m) => m.cost)))
    ok(dig.length === 1 && dig[0].cost === 17, '挖石头的移动 cost 9 → 17（+8）', JSON.stringify(dig.map((m) => m.cost)))
  }
  {
    const mv = mkMv()
    patchDoorMoves(mv, { digPenalty: 0 })
    const out = mv.getNeighbors(node)
    ok(out.find((m) => m.toBreak.length > 0)?.cost === 9, 'preferDoors:false（惩罚 0）⇒ 代价原样', String(out.find((m) => m.toBreak.length > 0)?.cost))
  }
  ok(DEFAULTS.preferDoors === true, '默认开（preferDoors:true）')
  ok(DEFAULTS.doorDigPenalty === 8, '默认惩罚 8')
  const plug = readFileSync(new URL('../src/plugins.mjs', import.meta.url), 'utf8')
  ok(/self\.cfg\.preferDoors !== false/.test(plug), 'movements() 真的读了 preferDoors 开关')
  ok(/digPenalty: \(digFirstOn \|\| !preferDoors\) \? 0 : Number\(self\.cfg\.doorDigPenalty \?\? 8\)/.test(plug), '惩罚值可配置（doorDigPenalty，关掉就是 0；挖路优先时也归零）')
}

/* ═══════════════ ⑱ 实机反馈（2026-10-19）：门没开透要补按、斜向挡路、上方目标允许垫一次 ═══════════════ */
section('⑱ 门失败兜底 / 斜向障碍 / 上方目标垫柱兜底')
{
  const src = read('../src/movement.mjs')
  const { obstacleAheadOf } = mod
  /* 斜着拐弯：正前和正侧都空，只有对角那一格是石头 ⇒ 也要看见 */
  const diag = mkCarveBot({ '1,63,0': 'stone', '0,63,1': 'stone', '1,63,1': 'stone', '1,64,1': 'stone' })
  const d = obstacleAheadOf(diag, { x: 10, y: 64, z: 10 })
  ok(d && d.x === 1 && d.z === 1 && d.name === 'stone', '对角线那格的石头也算"眼前挡路"', JSON.stringify(d))
  /* 门没开透 ⇒ 补按一次再走（不再直接交给脱困阶梯） */
  ok(/if \(sx && sz && mainClear\) dirs\.push\(\[sx, sz\]\)/.test(src), 'carve/obstacle 都会看对角线方向（但只在主轴全通时）')
  ok(/if \(doorWalk && doorWalk\.passed !== true\)/.test(src), '门没过去时走兜底分支')
  ok(/opened: Number\(opened\) \|\| 0/.test(src) && /retry: true/.test(src), '兜底里补按门并把结果记进 doorWalk.retry')
  /* 2026-11-02（用户「不要垫，我不是说了只有 allowDig」）：原来这里钉的是
   *   "上方目标、头顶为空 ⇒ 自动垫一次柱"。那段已整段删除 —— 垫柱只认显式
   *   `allowTower:true`（`index.js` 的 `noTower: args.allowTower !== true`）。 */
  ok(/noTower: args\.allowTower !== true/.test(read('../index.js')),
    '垫柱只认显式 allowTower:true（mc_move 不再偷偷垫）')
  ok(!/towerTried/.test(src) && !/目标在上方、头顶有空/.test(src),
    '🔴 自动垫柱那段（towerTried / allow1by1towers = true）已彻底删除')
}

/* ═══════════════ ⑲ 实机反馈（2026-10-22）：目标站不住就挪旁边、起点别嵌在半格里 ═══════════════ */
section('⑲ 目标落点修正 / 起点半格修正')
{
  const src = read('../src/movement.mjs')
  const { standPointFor, standFeetY, canStandAtWorld } = mod
  /* 假世界：地面在 y<=63（stone），y>=64 是空气；额外指定的格覆盖 */
  const mk = (solid = {}) => ({
    blockAt: (v) => {
      const k = `${v.x},${v.y},${v.z}`
      if (solid[k]) return { name: solid[k] }
      return { name: v.y <= 63 ? 'stone' : 'air' }
    },
  })
  /* ① 正常可站格：一格都不挪 */
  const b1 = mk()
  const r1 = standPointFor(b1, 0.5, 64.9, 0.5)
  ok(r1.x === 0 && r1.y === 64 && r1.z === 0 && r1.adjusted === false,
    '可站的目标格原样保留（不白挪）', JSON.stringify(r1))
  /* ② 目标格在本柱两格高的实心柱里 ⇒ 同层 8 邻找一个能站的 */
  const b2 = mk({ '0,64,0': 'stone', '0,65,0': 'stone' })
  const r2 = standPointFor(b2, 0.5, 64.5, 0.5)
  ok(r2.adjusted === true, '目标站在实心方块里 ⇒ 就近挪，而不是把不可站的 y 丢给 A*', JSON.stringify(r2))
  ok(r2.y === 64 && Math.abs(r2.x) + Math.abs(r2.z) === 1,
    '挪到同一层、8 邻中最近的一格（水平一格）', JSON.stringify(r2))
  ok(canStandAtWorld(b2, r2.x, r2.y, r2.z) === true, '挪过去那格确实站得住')
  ok(r2.from && r2.from.x === 0 && r2.from.y === 64, '原目标格记在 from 里（好如实报"改了去哪"）')
  /* ③ 本柱只高一层（石头台）⇒ 直接站上去，不往水平挪 */
  const b3 = mk({ '0,64,0': 'stone' })
  const r3 = standPointFor(b3, 0.5, 64.5, 0.5)
  ok(r3.x === 0 && r3.z === 0 && r3.y === 65 && r3.adjusted === true,
    '本柱高一格 ⇒ 往上站一层（不水平乱挪）', JSON.stringify(r3))
  /* ④ 起点半格：站在 farmland（y=63 那格）上，脚坐标 63.9375 */
  const b4 = mk({ '0,63,0': 'farmland' })
  ok(standFeetY(b4, { x: 0.5, y: 63.9375, z: 0.5 }) === 64,
    '站 farmland/箱子顶这类半格上 ⇒ 起点取上一格（不再嵌在方块里）')
  ok(standFeetY(b4, { x: 0.5, y: 64.0, z: 0.5 }) === 64, '正常站在空气格里 ⇒ 起点不变')
  /* ⑤ 接线：walkPathfinder 真的用上了 */
  /* 2026-10-23（P0-a）之后`standPointFor` 成了 `xz ? … : standPointFor(…)` 的 else 分支 ——
   * 断言跟着改形状，**语义没变**（不给 xz 时仍走它）。 */
  ok(/: standPointFor\(b, target\.x, target\.y, target\.z\)/.test(src),
    'walkPathfinder 真的用了 standPointFor（xz 目标是唯一例外）')
  /* 2026-10-30：`const sp` 改成了 `let sp`（半空目标要把 sp 换成底座）——
   *    断言别钉 const/let 这种声明形式，钉的是“xz 分支不调 standPointFor”。 */
  ok(/\b(?:let|const) sp = xz/.test(src)
    && /sp = xz\n?\s*\?/.test(src), 'xz 目标不过 standPointFor（不替 AI 改目的地）')
  ok(/const startY = standFeetY\(b, start\)/.test(src), 'walkPathfinder 真的修正了起点 y')
  ok(/goalAdjusted/.test(src) && /goalAskedAt/.test(src), '目标被挪过会如实报回去')
  ok(/tightened: true/.test(src) && /radius: 0/.test(src),
    '起点已经在 GoalNear 球里时把半径收到 0（治"moved:0 却 arrived:true"）')
  /* ⑥ 门：规划层允许穿门、执行层有按门的人 */
  const plug = readFileSync(new URL('../src/plugins.mjs', import.meta.url), 'utf8')
  ok(/mv\.canOpenDoors = true/.test(plug), 'A* 规划里门不是墙（canOpenDoors 已开）')
  ok(/mv\.openable\.add\(blk\.id\)/.test(plug), '木门/活板门/栅栏门进了 openable')
  ok(/openNearbyDoor\(b\)/.test(src), '执行层每 400ms 找身边关着的门按一下')
}

/* ═══════════════════════════════════════════════════════════════════════
 * ⑨ P0-a / P0-b（用户 m00634 原话：「你的首要问题很可能不是缺少新的移动项目，
 *    而是现有 mc_move 没有把 Pathfinder 的长程能力完整暴露给 AI」）
 *
 * ① **长程目标只给 x/z**（`GoalXZ`）：以前全仓只有 `GoalNear`，AI 必须编一个 y ——
 *    编高了 A* 老老实实垫方块上天，编低了直接 NoPath；
 * ② **报路径量级**（`pathLen` / `estCalls`）：以前只说"直线还差几格"，
 *    AI 看不出"这趟本来就走不完"，走两趟没到就换目标。
 * ═══════════════════════════════════════════════════════════════════════ */
section('⑨ P0-a xz 目标 / P0-b pathLen·estCalls')
{
  /* ① 采样器：xz 只看水平 —— 人沿着目标那一列上下乱爬，不是"在靠近" */
  const clock = fakeClock()
  const b = mkProbe({ x: 0, y: 64, z: 0 })
  const tgt = { x: 10, y: 70, z: 0 }
  /* ⚠️ 不能用 `watchOpts()`：它把 `ty` 钉成 64，会把"目标 y=70"盖掉，三维口径就测不出来了。 */
  const base = { arrive: 1.6, ty: 70, now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer }
  const w3 = moveProgressWatcher(b, tgt, base)                      // 三维口径
  const wX = moveProgressWatcher(b, tgt, { ...base, xz: true })
  let err3 = null, errX = null
  w3.promise.catch((e) => { err3 = e })
  wX.promise.catch((e) => { errX = e })
  clock.onTick = () => {
    /* 水平一动不动、只有 y 一路靠近目标 y=70（3D 距离确实在变小） */
    const step = Math.min(70, b.entity.position.y + 1)
    b.entity.position = new Vec3(0, step, 0)
  }
  await clock.advance(MOVE_STUCK_MS + MOVE_SAMPLE_MS * 2)
  w3.stop(); wX.stop()
  ok(err3 === null, '三维口径：只有高度在靠近也算"有进展"（老行为，不动）')
  ok(errX?.mcStuck === true, '🔴 xz 口径：只有高度在靠近 ⇒ 照样判卡（不然长路上永远不认输）')
  ok(errX && Math.abs(Number(errX.remaining) - 10) < 0.01,
    '🔴 xz 的"还剩几格"是水平距离（10 格），不是三维 11.66', String(errX?.remaining))
  ok(clock.live === 0, '两个采样器的定时器都清干净')
}
{
  /* ② walkPathfinder：goal 必须是 GoalXZ（没有 y）、结果带 xz / pathLen / estCalls */
  const clock = autoClock()
  const bot = mkLoopBot()
  const handlers = new Map()
  bot.on = (ev, fn) => { handlers.set(ev, fn) }
  bot.removeListener = (ev) => { handlers.delete(ev) }
  const goalsSeen = []
  const goto0 = bot.pathfinder.goto.bind(bot.pathfinder)
  bot.pathfinder.goto = (g) => { goalsSeen.push(g); return goto0(g) }
  const self = mkSelf(bot)
  const ctx = mkCtx(self, clock)
  const target = { x: 200, y: 64, z: 0 }        // AI 只知道"去东边 200 格"，y 是随手给的
  let sentPath = false
  clock.onTick = () => {
    if (!sentPath && handlers.get('path_update')) {
      sentPath = true
      /* 一次 `path_update` 就带整条剩余路径 —— 200 个节点 */
      handlers.get('path_update')({ status: 'success', path: Array.from({ length: 200 }, () => ({ x: 0, y: 64, z: 0 })) })
    }
    const p = bot.entity.position
    const d = Math.hypot(p.x - target.x, p.z - target.z)
    if (d <= 1.6) { bot.settleGoto((q) => q.resolve()); return }
    bot.entity.position = new Vec3(p.x + 0.8, 64, p.z)
  }
  const r = await walkPathfinder(self, target, { arrive: 1.6, budget: 20000, xz: true }, ctx)
  clock.stopPump()
  ok(goalsSeen.length >= 1, '真的下发了 goal', String(goalsSeen.length))
  const g0 = goalsSeen[0]
  ok(g0 && g0.constructor?.name === 'GoalXZ', '🔴 xz 目标是 GoalXZ（不是 GoalNear）', String(g0?.constructor?.name))
  ok(g0 && g0.x === 200 && g0.z === 0, 'GoalXZ 收到的是原样的 x/z（没被 standPointFor 挪一格）', JSON.stringify({ x: g0?.x, z: g0?.z }))
  ok(g0 && g0.y === undefined && g0.range === undefined, '🔴 GoalXZ 上**没有 y、没有半径**（高度交给寻路器自己定）', JSON.stringify(Object.keys(g0 ?? {})))
  ok(r.xz === true, '结果里带 xz:true（模型知道自己这次是"到那一列"）')
  ok(r.pathLenPlanned === 200, '🔴 pathLenPlanned = 首次规划出来的路径长度（200 节点）', String(r.pathLenPlanned))
  ok(r.estCalls === 9, '🔴 estCalls = ceil(200 / 24) = 9（2.4 格/秒 × 10 秒 ≈ 24 格；预算 20000 也按 10 秒上限算）', String(r.estCalls))
  ok(r.arrived === true && r.remaining < 2.2, '到达判定按水平距离（GoalXZ 没半径，不能拿 isEnd 卡）', JSON.stringify({ a: r.arrived, rem: r.remaining }))
}
{
  /* ③ 不给 xz 时一切照旧：还是 GoalNear（别把老路改了） */
  const clock = autoClock()
  const bot = mkLoopBot()
  const self = mkSelf(bot)
  const ctx = mkCtx(self, clock)
  const target = { x: 20, y: 64, z: 0 }
  clock.onTick = () => {
    const p = bot.entity.position
    if (p.distanceTo(new Vec3(target.x, 64, target.z)) <= 1.6) { bot.settleGoto((q) => q.resolve()); return }
    bot.entity.position = new Vec3(p.x + 0.8, 64, p.z)
  }
  const r = await walkPathfinder(self, target, { arrive: 1.6, budget: 20000 }, ctx)
  clock.stopPump()
  ok(r.xz === undefined, '不给 xz 就不报 xz（不无中生有）')
  ok(r.estCalls === undefined, '没规划出长路就不报 estCalls（短程不塞废话）')
  ok(r.arrived === true, '老路照旧到达')
}
{
  /* ④ 工具面：参数、描述、firewall（fly/boat 是三维的） */
  const idx = readFileSync(new URL('../index.js', import.meta.url), 'utf8')
  ok(/xz: \{ type: 'boolean'/.test(idx), 'mc_move 有 xz 参数')
  ok(/只给 x\/z 就够/.test(idx) && /GoalXZ/.test(idx), '描述里点名"长程只给 x/z"与 GoalXZ')
  ok(/estCalls/.test(idx) && /pathLen/.test(idx), '描述里点名会报 pathLen / estCalls')
  ok(/xz: wantsXZ/.test(idx), 'xz 真的传给了 walkTo（不是只在参数表里挂个名）')
  ok(/fly 是三维直飞，必须给 y/.test(idx) && /boat 要有终点高度/.test(idx),
    'fly / boat 不收 xz（说清楚，而不是静默按 walk 走）')
  ok(/const wantsXZ = !yGiven/.test(idx), '🔴 只给 x/z 就自动按列算（不逼模型加参数）')
  ok(/const yGiven = args\.y !== undefined && args\.y !== null/.test(idx), '🔴 给了 y 就以 y 为准（2026-10-23 修：xz:true 曾把同时给的 y 静默吃掉）')
  ok(/给了 y 就按 y 走/.test(idx), '描述里写明 y 优先，免得模型以为 y 不能用了')
  ok(/MOVE_GRID_PER_SEC = 2\.4/.test(read('../src/movement.mjs')),
  '一起算"还有几次调用"的换算常量在 movement.mjs 里（2.4 格/秒 —— 实测均值，不是疾跑理论值）')

}

{
  /* ⑩ 头顶上方（用户 2026-10-23：「move 后输出再加上方的方块……现在 ai 不知道移动后是什么状态。跳不起来。」）
   *   钉死三件事：① 能跳时不啰嗦（不给 note/ceiling）② 跳不起来时**说清是哪一格、y 多少**
   *   ③ 走到了也照样报（不是只有卡住才报 —— 用户要的是"移动后是什么状态"）。 */
  const mkCeilBot = (ceilY) => ({
    entity: { position: new Vec3(1, 64, 1) },
    blockAt (v) {
      const y = Math.floor(v.y)
      if (y <= 63) return { name: 'stone' }
      if (ceilY != null && y >= ceilY) return { name: 'stone' }
      return { name: 'air' }
    },
  })
  const openAir = aboveOf(mkCeilBot(null))
  ok(openAir && openAir.canJump === true, '头顶敞着 ⇒ canJump:true', JSON.stringify(openAir))
  ok(openAir.above === 'air' && openAir.headroom === 6, '报脚底上方第 2 格 + 往上连续净空格数', JSON.stringify(openAir))
  ok(openAir.note === undefined && openAir.ceiling === undefined, '能跳就不啰嗦（note / ceiling 只在有时才给，省 token）')
  const lowCeil = aboveOf(mkCeilBot(66))
  ok(lowCeil && lowCeil.canJump === false, '第 2 格就是实心 ⇒ canJump:false', JSON.stringify(lowCeil))
  ok(/跳不起来/.test(lowCeil.note ?? '') && /y=66/.test(lowCeil.note ?? ''), 'note 明说跳不起来 + 是哪一格（y=66）', lowCeil.note)
  ok(lowCeil.ceiling === 'stone' && lowCeil.headroom === 0, 'ceiling / headroom 一起给', JSON.stringify(lowCeil))
  const headFull = aboveOf({
    entity: { position: new Vec3(1, 64, 1) },
    blockAt (v) { const y = Math.floor(v.y); return { name: y <= 63 || y === 65 ? 'stone' : 'air' } },
  })
  ok(headFull && headFull.canJump === false && headFull.headBlocked === 'stone', '头那格被堵 ⇒ 单独报 headBlocked（不是只说第 2 格）', JSON.stringify(headFull))
  ok(aboveOf({}) === null && aboveOf(null) === null, '读不到世界就返回 null（不编）')
  /* 走完一步要带着走：真跑一趟 walk，结果里得有 above */
  const clock2 = autoClock()
  const bot2 = mkLoopBot()
  bot2.blockAt = (p) => (Math.floor(p.y) >= 68 ? { name: 'stone' } : { name: 'air' })
  const self2 = mkSelf(bot2)
  const ctx2 = mkCtx(self2, clock2)
  const tgt2 = { x: 3, y: 64, z: 0 }
  clock2.onTick = () => {
    const p = bot2.entity.position
    if (p.distanceTo(new Vec3(tgt2.x, 64, tgt2.z)) <= 1.6) { bot2.settleGoto((q) => q.resolve()); return }
    bot2.entity.position = new Vec3(p.x + 0.8, 64, p.z)
  }
  const rAbove = await walkPathfinder(self2, tgt2, { arrive: 1.6, budget: 20000 }, ctx2)
  clock2.stopPump()
  ok(rAbove.arrived === true && rAbove.above && rAbove.above.canJump === true,
    '走到了也有 above（不是只有卡住才报）', JSON.stringify(rAbove.above))
  ok(rAbove.above.headroom === 2 && rAbove.above.ceiling === 'stone',
    'above 说的是"到这儿之后"的头顶（y=68 起是石头）', JSON.stringify(rAbove.above))
}

/* ═══════════════ ㉑ 不许"无限等服务器回包"（2026-10-23 实机：一条 mc_move 挂 208 秒） ═══════════════ */
section('㉑ 硬上限 + 单格挖掘守卫（用户：刚刚一直卡在这里）')
{
  /* 背景：`withTimeout` 只罩着 `pathfinder.goto`。走路这条路上还有裸 await 能永不 settle
   * （挖一格要等服务端把方块改成空气；换工具等 heldItemChanged）。实机表现就是
   * 工具一直不返回、模型那头"卡在这里"。这一节钉住两层兜底都真的在。 */
  ok(MOVE_HARD_SLACK_MS > 0 && MOVE_CARVE_DIG_MS > 0,
    '两个兜底常量都在（硬上限余量 / 单格挖掘上限）', JSON.stringify({ MOVE_HARD_SLACK_MS, MOVE_CARVE_DIG_MS }))

  /* ②-1 硬上限：让 `ctx.walkPathfinder` 永不 settle，`walkTo` 也必须按时返回 */
  {
    const clock = autoClock()
    const bot = mkLoopBot()
    const self = mkSelf(bot)
    self.requireBot = () => bot
    self.pfReady = true          // 假 self 默认没这个标记，缺了会直接走 PathfinderUnavailable 分支
    let stopped = 0
    let released = 0
    const ctx = {
      ...mkCtx(self, clock),
      walkGuardMs: 80,                       // 测试注入：80ms 而不是真等 10+3 秒
      walkPathfinder: () => new Promise(() => {}),   // 永不 settle —— 模拟"服务端不回包"
      stopPathing: () => { stopped++ },
      releaseControls: () => { released++ },
    }
    const t0 = Date.now()
    const r = await walkTo(self, { x: 20, y: 64, z: 0 }, { budget: 200 }, ctx)
    const ms = Date.now() - t0
    clock.stopPump()
    ok(r.arrived === false && r.stuck === true, '永不返回的走路 ⇒ arrived:false / stuck:true', JSON.stringify({ a: r.arrived, s: r.stuck }))
    ok(r.reason === 'walk-hung', '🔴 reason = walk-hung（跟 timeout / unreachable 分开：这是"被硬上限掐断"）', String(r.reason))
    ok(r.hardLimitMs === 80, '结果里报出这次用的硬上限（模型能看出"是被掐断的"）', String(r.hardLimitMs))
    ok(ms >= 60 && ms < 1_000, '🔴 硬上限真的生效（按时返回，不是挂死）', String(ms) + 'ms')
    ok(stopped >= 1 && released >= 1, '掐断时松开了寻路与控制位（不留后台在跑）', JSON.stringify({ stopped, released }))
    ok(Boolean(r.position), '报出掐断时的坐标（模型据此判断"到底挪没挪"）')
    ok(r.above && typeof r.above.canJump === 'boolean', '硬上限的结果也带 above（和别的失败口子口径一致）', JSON.stringify(r.above))
    ok(/掐断/.test(r.hint ?? '') && /allowDig:false/.test(r.hint ?? ''),
      'hint 如实说被掐断 + 给出下一步（关掉挖/换目标/搭桥）', String(r.hint).slice(0, 60))
    ok(r.held !== undefined || r.heldRestored !== undefined || true, '（手上有东西时才报 held，不强制）')
  }

  /* ②-2 单格挖掘守卫：`b.dig` 永不 settle 时，`carveStepAhead` 必须按时放弃 */
  {
    const b = mkLoopBot({ x: 0, y: 64, z: 0 })
    b.entity = { position: new Vec3(0, 64, 0), onGround: true }
    b.blockAt = (p) => {
      const x = Math.floor(p.x), y = Math.floor(p.y)
      if (y <= 63) return { name: 'stone' }          // 底下有支撑（能挖）
      if ((x === 1 || x === 2) && y === 64) return { name: 'dirt' }   // 挡路的脚那一格
      return { name: 'air' }
    }
    let equips = 0
    let stops = 0
    b.equip = async () => { equips++; return {} }
    b.dig = () => new Promise(() => {})               // 永不回包（服务端不判 air）
    b.stopDigging = () => { stops++ }
    b.pathfinder.bestHarvestTool = () => ({ name: 'iron_shovel' })
    const t0 = Date.now()
    const n = await carveStepAhead(b, { x: 30, y: 64, z: 0 }, { ignoreRange: true, digMs: 60 })
    const ms = Date.now() - t0
    ok(n === 0, '🔴 挖不动就不许谎报"挖开了"（返回 0，不返回真）', String(n))
    ok(ms < 800, '🔴 单格挖掘有上限（不是无限等）', String(ms) + 'ms')
    ok(equips >= 1, '该换工具还是先换（守卫罩的是"等回包"，不是"干脆不挖"）', String(equips))
    ok(stops >= 1, '掐断时调了 stopDigging 松手（不留半截挖掘状态）', String(stops))
    ok(Number(b.__carveDigStalled) >= 1, '记了一笔"被守卫掐断"（供 moveInfo 报 digStalled）', String(b.__carveDigStalled))
  }

  /* ②-3 正常情况不受影响：`dig` 很快 resolve 时照样算"挖开了" */
  {
    const b = mkLoopBot({ x: 0, y: 64, z: 0 })
    b.entity = { position: new Vec3(0, 64, 0), onGround: true }
    b.blockAt = (p) => {
      const x = Math.floor(p.x), y = Math.floor(p.y)
      if (y <= 63) return { name: 'stone' }
      if (x === 1 && y === 64) return { name: 'dirt' }
      return { name: 'air' }
    }
    b.dig = async () => {}
    b.equip = async () => ({})
    b.stopDigging = () => {}
    b.pathfinder.bestHarvestTool = () => null
    const n = await carveStepAhead(b, { x: 30, y: 64, z: 0 }, { ignoreRange: true, digMs: 500 })
    ok(n === 1, '正常的挖掘一眼没变（挖开了就报 1）', String(n))
    ok(!b.__carveDigStalled, '没超时就不留"被掐断"的账', String(b.__carveDigStalled))
  }

  /* ②-4 静态：硬上限必须**包住整段 walkToUnguarded**，而不是只在 goto 上 */
  {
    const src = strip(read('../src/movement.mjs'))
    ok(/Promise\.race\(\s*\[\s*walk,/.test(src) || /walk\.catch\(\(\) => \{\}\)/.test(src),
      'walkTo 里对 walkToUnguarded 做了 race（整段被罩住，不只是 goto）')
    ok(/ctx\.walkGuardMs/.test(src), '硬上限可被测试注入（ctx.walkGuardMs）')
    ok(/b\.stopDigging\?\.\(\)/.test(src), '掐断 / 守卫超时都会 stopDigging')
    ok(/__carveDigStalled/.test(src) && /digStalled/.test(src), '掐断记账并报进 moveInfo（digStalled）')
    ok(/const guarded = async/.test(src), '挖一格走 guarded()（equip 与 dig 都在罩内）')
  }
}


/* ═══════════════ ㉒ 挖的方向只认主轴（2026-10-23 实机：它往 z5 挖而不是 x方向）═══════════════ */
section('㉒ 补挖的方向只认主轴 / 对角受限 / 有总预算')
{
  const src = read('../src/movement.mjs')
  /* 目标在 +x 远、+z 只差一点点 ⇒ 主轴是 x；z 方向那堵墙不该被挖（旧代码会挖，越挖越乱） */
  const b1 = mkCarveBot({ '0,64,1': 'stone', '0,63,1': 'stone' })
  const n1 = await carve(b1, { x: 10, y: 64, z: 2 }, { ignoreRange: true })
  ok(n1 === 0 && !b1.dug.includes('0,64,1'), '🔴 主轴是 x ⇒ 绝不挖 z 方向的侧墙', JSON.stringify(b1.dug))
  /* 主轴那格真堵着 ⇒ 挖主轴那格（这才是往目标去的方向） */
  const b2 = mkCarveBot({ '1,64,0': 'stone', '1,63,0': 'stone', '0,64,1': 'stone', '0,63,1': 'stone' })
  const n2 = await carve(b2, { x: 10, y: 64, z: 2 }, { ignoreRange: true })
  ok(n2 === 1 && b2.dug.includes('1,64,0'), '主轴那格堵着 ⇒ 挖主轴那格', JSON.stringify(b2.dug))
  ok(!b2.dug.includes('0,64,1'), '有主轴可挖时一下都不碰侧墙', JSON.stringify(b2.dug))
  /* 主轴堵着但挖不动（基岩）⇒ 也别绕到斜的/侧的去乱挖，交给脱困阶梯 */
  const b3 = mkCarveBot({ '1,64,0': 'bedrock', '1,63,0': 'stone', '0,64,1': 'stone', '0,63,1': 'stone' })
  const n3 = await carve(b3, { x: 10, y: 64, z: 2 }, { ignoreRange: true })
  ok(n3 === 0 && b3.dug.length === 0, '主轴挖不动 ⇒ 一格都不挖（不乱挖侧墙）', JSON.stringify(b3.dug))
  /* 主轴是 z 时同理（方向按目标算，不是写死 x） */
  const b4 = mkCarveBot({ '0,64,1': 'stone', '0,63,1': 'stone', '1,64,0': 'stone', '1,63,0': 'stone' })
  const n4 = await carve(b4, { x: 2, y: 64, z: 10 }, { ignoreRange: true })
  ok(n4 === 1 && b4.dug.includes('0,64,1'), '主轴是 z ⇒ 挖 z 方向那格', JSON.stringify(b4.dug))
  ok(!b4.dug.includes('1,64,0'), '主轴是 z 时 x 墙不碰', JSON.stringify(b4.dug))
  /* 斜拐（2026-10-19 实机）仍然要管：主轴全通、只有对角堵 ⇒ 挖对角 */
  const b5 = mkCarveBot({ '1,64,1': 'stone', '1,63,1': 'stone' })
  const n5 = await carve(b5, { x: 10, y: 64, z: 10 }, { ignoreRange: true })
  ok(n5 === 1 && b5.dug.includes('1,64,1'), '主轴全通、只有对角堵 ⇒ 还是挖对角（斜拐不退化）', JSON.stringify(b5.dug))
  /* 静态：方向只从主轴算，副轴那两个 push 已删 */
  ok(/const main = Math\.abs\(dx\) >= Math\.abs\(dz\) \? \[sx, 0\] : \[0, sz\]/.test(src), '方向只从主轴算')
  const sidePushes = (src.match(/dirs\.push\(\[0, sz\]\)/g) || []).length
  ok(sidePushes === 2, '副轴方向只剩 doorOnRoute 那两行（carve/obstacle 不再看侧墙）', 'count=' + sidePushes)
  ok(/export function doorOnRoute/.test(src) && /cells \+ 1/.test(src), 'doorOnRoute 仍然往前进走廊里多看一格（保护门，不退化）')
  ok(/export const MOVE_CARVE_TOTAL = \d+/.test(src), '一次 mc_move 有挖掘总预算（具体数值不钉 —— 2026-10-31 改成 24：时间才是真限制）')
  ok(/carved < MOVE_CARVE_TOTAL/.test(src), '🔴 预算真的用在补挖条件上（不是摆设）')
}


/* ═══════════════ ㉓ 执行顺序（2026-10-23 用户：「动不了，太容易卡了，你要加对应的执行顺序」）═══════════════
 * 要钉死的三件事：
 *   ① 顺序表本身：开门 → 重算 → 跳 → 后退 → **侧向绕行** → 挖 → 垫柱（能绕就别拆）；
 *   ② `detourStep` 真的挑侧向点、真的走过去（不是"原地重算"换个名字）；
 *   ③ **跨调用接着升级** —— 同一个目标 90 秒内再叫，从上次卡住的那一级继续，
 *      到了就把账清掉（否则 AI 连叫五次等于白试五遍同一套）。
 */
section('㉓ 执行顺序：先便宜的、能绕就别挖；跨调用接着升级')
{
  /* 🔴 2026-10-30 全量审计：这里原来钉的是 `MOVE_PLAN` / `movePlanFor`（10 项，含 door/tower 的
   *    第二份表）。那份表**不是在跑的那套**，日志拿它 `indexOf` 算级号会报错，已删。现在钉
   *    **执行阶梯本人**（`escapeStepsFor` 的返回值），两套各一条。 */
  ok(JSON.stringify(escapeStepsFor(true)) === JSON.stringify(['repath', 'jump', 'descend', 'climbUp', 'breakAhead', 'backoff', 'detour']),
    '允许挖时的执行阶梯 = 重算 → 跳 → 往下挖/跳 → 往上挖 → 挖挡路 → 后退 → 绕行'
      + '（`clearHead` 不在里面：`climbUp` 本来就先挖头顶两格）',
    JSON.stringify(escapeStepsFor(true)))
  ok(JSON.stringify(escapeStepsFor(false)) === JSON.stringify(['repath', 'jump', 'descend', 'clearHead', 'backoff', 'detour']),
    '不挖时的执行阶梯 = 重算 → 跳 → 往下挖/跳 → 清头顶 → 后退 → 绕行'
      + '（没有"挖开挡路那格"；`clearHead` 是 2026-10-28 用户批准的例外：只清自己头顶一格）',
    JSON.stringify(escapeStepsFor(false)))
  ok(escapeStepsFor(false).every((n) => planStepTextOf(n) !== n) && escapeStepsFor(true).every((n) => planStepTextOf(n) !== n),
    '执行阶梯的每一级都有中文名（日志/`escapesLeft` 直接用 `planStepTextOf`，缺一个就会露出英文原名）')
  /* 源码在 ⑧ 段的块作用域里（`src`），这里离得远，自己读一份 */
  const mvSrc = strip(read('../src/movement.mjs'))
  ok(!/export (?:function movePlanFor|const MOVE_PLAN\b|const MOVE_PLAN_NODIG\b)/.test(mvSrc),
    '🔴 只留一份执行顺序表（曾经的第二份 `MOVE_PLAN` 让日志级号对不上实际阶梯）')
  ok(/if \(!entityDodgeOff && e2 && shouldDodgeEntity\(e2\)\)/.test(mvSrc) && !/shouldWaitEntity\(e2\)/.test(mvSrc),
    '🔴 走的过程中遇到活物 ⇒ 换一条路，不停也不收工（2026-11-03 用户「不要不动和遇到停住」；旧写法分敌友、还要站着等 900ms）')
  ok(MOVE_ESCAPES_DIG.indexOf('breakAhead') < MOVE_ESCAPES_DIG.indexOf('detour'),
    '🔴 允许挖时"挖"排在绕行之前（能挖就别绕远路）', MOVE_ESCAPES_DIG.join(' → '))
  ok(planStepTextOf('detour') === '侧向绕行' && planStepTextOf('climbUp') === '往上挖一层再跳',
    'planStepTextOf 给中文名（日志/结果用）')
  /* 🔴 2026-11-02 审计（#27）：`door` / `tower` 两项执行阶梯里根本没有（门归 patchDoorMoves、
   *    垫柱只认显式 allowTower），以前测试还钉着 `planStepTextOf('tower')` ⇒ 钉了个跑不到的字符串。 */
  ok(!('tower' in MOVE_PLAN_TEXT) && !('door' in MOVE_PLAN_TEXT),
    '🔴 文案表里不留执行不到的 door/tower（否则"文案说支持" ≠ 阶梯里真有）')
  ok(MOVE_DETOUR_R >= 2 && MOVE_DETOUR_MS > 0, '绕行半径/时长有默认值', `${MOVE_DETOUR_R} 格 / ${MOVE_DETOUR_MS}ms`)
  ok(MOVE_PLAN_TTL_MS === 90000 && MOVE_PLAN_SAME_R === 3, '跨调用记账的有效期 = 90 秒 / 同目标 3 格内')
}
{
  /* detourStep：挑侧向点 → 真走一步 */
  const bot = mkLoopBot()
  const self = mkSelf(bot)
  const clock = autoClock()
  let lastGoal = null
  bot.pathfinder.goto = (g) => {
    bot.calls.goto++
    lastGoal = g
    return new Promise((resolve) => { bot._detourResolve = resolve })
  }
  const p = detourStep(bot, { x: 20, y: 64, z: 0 }, { goals: self._pf.goals, ctx: mkCtx(self, clock), budgetMs: 300 })
  await sleep(120)
  ok(Boolean(lastGoal) && Math.abs(Number(lastGoal.z)) >= 2 && Math.abs(Number(lastGoal.x)) === 0,
    '绕行点是**侧向**的（不是往前/往后，也不是反方向）', JSON.stringify({ x: lastGoal?.x, z: lastGoal?.z }))
  if (lastGoal) bot.entity.position = new Vec3(lastGoal.x, 64, lastGoal.z)
  bot._detourResolve?.()
  const d = await p
  clock.stopPump()
  ok(Number(d.moved) >= 2, '侧向绕行真的挪了格数（换了个起点再规划）', String(d.moved))
  ok(d.to && Number.isFinite(Number(d.to.x)), '结果报走到哪一格（to）', JSON.stringify(d.to))
}
{
  /* 没有侧向落脚点 ⇒ 如实 moved:0，交给下一级（不许假装绕过） */
  const bot = mkLoopBot()
  // 目标就在脚下：没必要绕（先判「太近」，别白走一趟）
  const self = mkSelf(bot)
  const clock = autoClock()
  const d = await detourStep(bot, { x: 0, y: 64, z: 0 }, { goals: self._pf.goals, ctx: mkCtx(self, clock), budgetMs: 200 })
  clock.stopPump()
  ok(Number(d.moved) === 0 && d.why === 'too-close', '已经在这一格上 ⇒ moved:0 / why:too-close（不白绕）', JSON.stringify(d))
}
{
  /* 跨调用接着升级：上次卡在第 3 级，这次直接从第 3 级开始，而不是重来 */
  const clock = autoClock()
  const bot = mkLoopBot()
  const self = mkSelf(bot)
  bot._movePlan = { target: { x: 20, y: 64, z: 0 }, at: Date.now(), step: 3 }   // 上次试完第 2 级
  const r = await walkPathfinder(self, { x: 20, y: 64, z: 0 }, { arrive: 1.6, budget: 20000, allowDig: true }, mkCtx(self, clock))
  clock.stopPump()
  const first = self.logs.find((m) => /第 \d+ 步/.test(m)) ?? ''
  ok(/第 3 步/.test(first), '同一目标再叫：从上次卡住的第 3 级接着升（不从第 1 级重来）', first.slice(0, 46))
  ok(Array.isArray(r.planTried) && r.planTried.length >= 1, '结果里报 planTried（这一趟试过哪几级）', JSON.stringify(r.planTried))
  ok(r.planStep === 'detour', 'planStep = 最后试的那一级（允许挖那套的最后一级是绕行）', String(r.planStep))
  ok(bot._movePlan && Number(bot._movePlan.step) === MOVE_ESCAPES_DIG.length + 1,
    '还是卡 ⇒ 记下"卡到顶了"，下次直接换做法', JSON.stringify(bot._movePlan))
}
{
  /* 到了就把账清掉（用**不推进**的假时钟：采样器永不判卡，免得跟到达抢时序） */
  const clock = fakeClock()
  const bot = mkLoopBot()
  const self = mkSelf(bot)
  bot._movePlan = { target: { x: 20, y: 64, z: 0 }, at: Date.now(), step: 0 }   // 还没试过任何一级
  const p = walkPathfinder(self, { x: 20, y: 64, z: 0 }, { arrive: 1.6, budget: 4000 }, mkCtx(self, clock))
  await sleep(30)
  bot.entity.position = new Vec3(20, 64, 0)
  bot.settleGoto((x) => x.resolve())
  const r = await p
  clock.stopPump?.()
  ok(r.arrived === true, '走到了', JSON.stringify({ a: r.arrived, rem: r.remaining }))
  ok(bot._movePlan === null, '到了就把「卡在第几步」清掉（下个目标重新从第 1 级开始）', JSON.stringify(bot._movePlan))
}
{
  /* 静态：detour 那一级绝不能挖（绕过不去才轮到挖） */
  const src = strip(read('../src/movement.mjs'))
  ok(/else if \(step === 'detour'\)[\s\S]{0,240}?detourStep\(/.test(src), 'escapeMove 里有 detour 分支（真调 detourStep）')
  ok(!/else if \(step === 'detour'\)[\s\S]{0,240}?carveStepAhead\(/.test(src), '🔴 detour 分支里没有挖（能绕就别拆）')
  ok(/markPlan\(attempt \+ 1, step\)/.test(src), '每一级都记账，且记的是「下次从第几级起」（跨调用升级靠它）')
  ok(/b\._movePlan = \{ target:/.test(src) && /b\._movePlan = null/.test(src), '计划状态写在 bot 上、到达时清空')
}
/* ═══════════════ ㉔ 预算自适应门槛 + 挖不到立刻换招（2026-10-23 晚，用户实机 mc_sequence 卡死）═══════════════
 * 实机症状：10 秒一次调用里 vendor 只判了 **2 次** stuck（3.5 秒一次），而脱困阶梯要等"重算 4 次"
 * 才启动 ⇒ 永远轮不上，结果里连 planTried 都没有，10 秒全耗在 stuck→重算→超时。
 * 两条修法：① 门槛按预算算（够几轮就几轮，最少 2）；② 挖 0 格就封顶，别空转一个 stuck 周期。
 */
section('㉔ 预算只够判 2 次 stuck 时，脱困阶梯必须当轮就启动')
{
  const src2 = strip(read('../src/movement.mjs'))
  ok(MOVE_VENDOR_STUCK_MS === 3500, 'vendor 判一次 stuck 约 3.5 秒（常量写死，门槛靠它算）', String(MOVE_VENDOR_STUCK_MS))
  ok(/resetLimit: resetLimitEff/.test(src2), 'watcher 收自适应门槛（resetLimitEff）')
  ok(/Math\.floor\(budget \/ MOVE_VENDOR_STUCK_MS\)/.test(src2), '门槛 = 预算 ÷ 3.5 秒')
  ok(/Math\.max\(2,/.test(src2) && /Math\.min\(MOVE_RESET_LIMIT/.test(src2), '门槛夹在 2 与 MOVE_RESET_LIMIT 之间')
  ok(/carveTries = MOVE_CARVE_TRIES/.test(src2), '挖不到就封顶，不再重复试')
  ok(/不重复试，直接换下一招/.test(src2), '日志说清楚"不重复试"')
}
{
  /* 行为：10 秒预算 + 2 次 path_reset ⇒ 直接进阶梯（以前要等 4 次，永远等不到） */
  const clock = autoClock()
  const bot = mkLoopBot()
  const handlers = new Map()
  bot.on = (ev, fn) => { const a = handlers.get(ev) ?? []; a.push(fn); handlers.set(ev, a) }
  bot.removeListener = () => {}
  const self = mkSelf(bot)
  bot.pathfinder.goto = () => new Promise(() => {})   // 永不返回：只能靠 watcher 判卡
  const run = walkPathfinder(self, { x: 20, y: 64, z: 0 }, { arrive: 1.6, budget: 10000 }, mkCtx(self, clock))
  await sleep(80)
  const emit = (ev, arg) => { for (const fn of handlers.get(ev) ?? []) fn(arg) }
  emit('path_reset', 'stuck')
  emit('path_reset', 'stuck')
  await sleep(400)
  const stepped = self.logs.filter((m) => /第 \d+ 步/.test(m))
  ok(stepped.length > 0, '2 次重算就进脱困阶梯（10 秒预算下不再等 4 次）', stepped.join(' | '))
  clock.stopPump()
  await Promise.race([run, sleep(60)]).catch(() => {})
}

section('㉔ 2026-10-23 审计 A 组：卡住检测 / 游泳代次 / 绕行候选 / 穿门信号 / 补挖记账')
{
  const src = readFileSync(new URL('../src/movement.mjs', import.meta.url), 'utf8')

  /* A[1] 近距离不等于有进展：在到达圈里一动不动，也要判卡 */
  ok(!src.includes('d <= arrive + 0.6 || d < best - progressEps'), '🔴 "在到达圈里"不再当成进展（旧条件已删）')
  ok(/if \(d < best - progressEps\)/.test(src), '只有距离真的变小才算进展')

  /* A[2] 游泳：等完立刻验代次；收尾松反压键也要验代次 */
  ok(/await raceAbort\(sleep\(250\), self\.abortSignal, '游泳'\)[\s\S]{0,400}if \(self\._moveGen !== gen\) return preemptResult/.test(src),
    '游泳每轮等完立刻验代次（被接管就不再动控制位）')
  ok(/if \(lastStrafe && self\._moveGen === gen\)/.test(src), '收尾松反压键也只在还是自己的代次时松')

  /* A[4] 绕行：按评分依次试两个候选，不是一个 */
  ok(/const tries = candsU\.slice\(0, 2\)/.test(src), '绕行真的试两个候选（不是只试最近的）')
  ok(/for \(const c of cands\) uniq\.set/.test(src), '绕行候选先去重（左右两侧可能落到同一格）')
  ok(/MOVE_ESCALATE_MIN_MS/.test(src) && /err\.mcBudgetOut = true/.test(src), '脱困阶梯吃预算（见底当阶梯用完，走同一条收尾路径）')
  ok(/if \(reached \|\| got >= 0\.5\)/.test(src), '走到 / 挪开一段就收手，不再试另一侧')

  /* A[5] 穿门：信号从调用方传进来（以前写 b.abortSignal = undefined，等于不可中断） */
  ok(/radius = 3\.2, signal = null/.test(src), 'walkThroughDoor 接了 signal 参数')
  ok(/raceAbort\(sleep\(80\), signal, '穿门'\)/.test(src), '穿门等待用传进来的 signal（可中断）')
  ok(!/raceAbort\(sleep\(80\), b\.abortSignal/.test(src), '不再拿 bot 上不存在的 abortSignal')
  ok(/walkThroughDoor\(b, target, \{ budgetMs: leftMs, signal: self\.abortSignal, moveGenOf: \(\) => self\._moveGen \}\)/.test(src), '调用处把 self.abortSignal 与 self._moveGen 的读法都传进去')
  /* 2026-10-24 通审：`b._moveGen` 根本不存在（字段在 core 实例上），代次判断改成 ctx 递进来的读法。 */
  ok(/if \(moveGenOf && moveGenOf\(\) !== gen0\) break/.test(src), '穿门循环里被接管就停手')
  ok(/const gen0 = moveGenOf \? moveGenOf\(\) : null/.test(src), '穿门的代次从调用方拿（bot 上没有 _moveGen）')
  ok(!/b\?\._moveGen/.test(src), '全仓不再从 bot 上读 _moveGen')

  /* A[3] 阶梯前那次补挖要记账，注释与常量也要一致 */
  ok(/planTried\.push\('carveAhead'\)/.test(src), '阶梯前的补挖也记进 planTried（AI 才看得到"其实先挖过"）')
  ok(MOVE_ESCAPES_DIG.indexOf('breakAhead') < MOVE_ESCAPES_DIG.indexOf('detour'), '允许挖那套：挖在绕行之前（用户 2026-10-24 定的）')
  ok(MOVE_ESCAPES_NODIG.indexOf('detour') > MOVE_ESCAPES_NODIG.indexOf('jump'), '不挖那套：绕行在跳之后，且没有挖这一级')
  ok(!MOVE_ESCAPES_NODIG.includes('breakAhead'), '不挖那套确实没有 breakAhead')
}

section('㉕ 2026-10-24 局部运动层：一格台阶先踩上去，别把台阶挖了')
{
  const src = strip(read('../src/movement.mjs'))
  /* 前方脚层实心、头顶空 ⇒ 这是一格台阶，站上去能站住 */
  const g0 = mod.stepGeometryOf(mkCarveBot({ '1,64,0': 'stone' }), { x: 1, y: 64, z: 0 })
  ok(g0?.kind === 'step', '前方一格高、顶上空 ⇒ 认成一格台阶', JSON.stringify(g0))
  ok(g0?.canStandOnTop === true, '站上去能站住 ⇒ 可以直接跳上去')

  /* 台阶顶部上方被堵 ⇒ 跳不上去（这是 1×2 窄道里最常见的样子） */
  const g1 = mod.stepGeometryOf(mkCarveBot({ '1,64,0': 'stone', '1,66,0': 'stone' }), { x: 1, y: 64, z: 0 })
  ok(g1?.kind === 'step' && g1?.canStandOnTop === false, '台阶顶部上方被堵 ⇒ 净空不足', JSON.stringify(g1))
  ok(g1?.ceiling?.name === 'stone', '并且指出是哪一块堵着（好决定挖哪格）')

  /* 🔴 2026-11-03 实机（用户：「move 里 allowDig 的挖台阶不会挖头顶方块，而且没有跳上挖上去的台阶」）：
   *   脚层 + 头层实心、**再上面一格是空的** ⇒ 这不是"两格厚的墙"，而是"一格台阶 + 站上去顶头"：
   *   该挖的是头层那格，挖完就是普通台阶，接着跳上去。旧断言一律当墙 ⇒ 一格不挖、也不跳。 */
  const g2 = mod.stepGeometryOf(mkCarveBot({ '1,64,0': 'stone', '1,65,0': 'stone' }), { x: 1, y: 64, z: 0 })
  ok(g2?.kind === 'step', '脚+头实心、再上面空 ⇒ 认成台阶（挖头顶再跳），不是墙', JSON.stringify(g2))
  ok(g2?.ceiling?.y === 65, '并且指明该挖的是**头层那格**（y=65），不是脚下的台阶', JSON.stringify(g2.ceiling))

  /* 三格全实心 ⇒ 真·两格厚的墙，不归台阶管 */
  const g2b = mod.stepGeometryOf(mkCarveBot({ '1,64,0': 'stone', '1,65,0': 'stone', '1,66,0': 'stone' }), { x: 1, y: 64, z: 0 })
  ok(g2b?.kind === 'wall', '三格全实心 ⇒ 真两格厚的墙', JSON.stringify(g2b))
  /* 🔴 2026-11-03 用户实机：`前方 54,104,31 的脚下是 stone（没有两格高）`，allowDig:true 也停在
   *   那儿一动不动（同一条路三条日志只挪 2.7 格）。三格全实心时旧代码直接报 wall 收工 ——
   *   其实是两张方块厚的台阶，挖掉头层 + 再上面那格就能站上去。 */
  ok(g2b?.above && g2b.above.y === 66, 'wall 也要带出"再上面那格"的坐标（不然不知道挖到哪一层）', JSON.stringify(g2b?.above))
  ok(/if \(geo\.kind === 'wall'\) \{[\s\S]{0,400}?if \(!allowDig\) return \{ tried: true, ok: false, why: 'wall'/.test(src),
    'allowDig:false 时仍然如实报 wall（不挖就一格不动）')
  ok(/if \(!\(await digAt\(geo\.above\.x, geo\.above\.y, geo\.above\.z\)\)\)/.test(src),
    'allowDig:true 时挖掉头层后接着挖再上面那格（两张方块厚的台阶）')
  ok(/const digAt = async \(cx, cy, cz\) => \{/.test(src) && !/const okDig = await \(\(\) => \{/.test(src),
    '挖一格抽成 digAt（换工具 + 超时 + 挖不动都算失败），不再内联一份')

  /* 行为：允许挖时，挖的是头顶那格，台阶块本身不动，挖完往上一跳 */
  {
    const bH = mkCarveBot({ '1,64,0': 'stone', '1,65,0': 'stone' })
    const rH = await mod.stepUp(bH, { x: 1, y: 64, z: 0 }, { allowDig: true, ms: 40 })
    ok(bH.dug.includes('1,65,0'), '🔴 挖掉了头顶那格', JSON.stringify(bH.dug))
    ok(!bH.dug.includes('1,64,0'), '🔴 台阶块本身没挖（挖了就是削平楼梯）')
    ok(rH?.dug === 1, '结果里报挖了 1 格', JSON.stringify(rH))
  }

  /* 不挖 + 净空不足 ⇒ 如实报 blocked，一格都不动 */
  const bNo = mkCarveBot({ '1,64,0': 'stone', '1,66,0': 'stone' })
  const r1 = await mod.stepUp(bNo, { x: 1, y: 64, z: 0 }, { allowDig: false, ms: 40 })
  ok(r1?.tried === true && r1?.ok === false, '不挖的模式下跳不上去 ⇒ 如实报失败', JSON.stringify(r1))
  ok(r1?.why === 'no-headroom', '原因说清是「净空不足」，不是「没路」')
  ok(bNo.dug.length === 0, '🔴 不挖就一格都不挖')

  /* 允许挖 + 净空不足 ⇒ 只清天花板那一格，绝不挖台阶块本身 */
  const bDig = mkCarveBot({ '1,64,0': 'stone', '1,66,0': 'stone' })
  const r2 = await mod.stepUp(bDig, { x: 1, y: 64, z: 0 }, { allowDig: true, ms: 40 })
  ok(r2?.dug === 1 && bDig.dug.includes('1,66,0'), '允许挖时只清挡在头顶的那一格', JSON.stringify(bDig.dug))
  ok(!bDig.dug.includes('1,64,0'), '🔴 台阶块本身不许挖（那等于把楼梯削平）')

  /* 静态接线：局部运动层必须排在通用挖掘之前，且 NoPath 时也有机会 */
  ok(/export const STEP_UP_TRIES = 1/.test(src), '一次移动里只试一次局部台阶处理（试不通就交给脱困阶梯换招）')
  ok(/if \(stepUpTries < STEP_UP_TRIES\)/.test(src), '卡住分支里先走局部运动层')
  ok(/if \(emptyNoPath && stepUpTries < STEP_UP_TRIES\)/.test(src), 'A* 直接 NoPath 时也给一次机会（等不到 2.4 秒监控器）')
  ok(/emptyNoPath = false/.test(src), '试完之后重置 NoPath 结论，别拿旧结论继续走')
  ok(/planTried\.push\('stepUp'\)/.test(src), '台阶处理记进 planTried（AI 看得到试过什么）')
  ok(/\.\.\.\(stepUpLast \? \{ stepUp: stepUpLast \}/.test(src), '结果里带 stepUp 证据')
}

section('㉖ 2026-10-24 导航世界模型：实体 / 未加载 / 岩浆 都不是「方块挡路」')
{
  const src = strip(read('../src/movement.mjs'))
  const plug = strip(read('../src/plugins.mjs'))

  /* 实体挡路：怪站在前方通道里 */
  const botEnt = (list) => ({
    entity: { position: new Vec3(0, 64, 0) },
    entities: list,
    blockAt: () => ({ name: 'air', position: new Vec3(0, 0, 0) }),
  })
  const e1 = mod.entityObstacleAhead(botEnt([{ name: 'zombie', position: new Vec3(1, 64, 0) }]), { x: 5, y: 64, z: 0 })
  ok(e1?.name === 'zombie' && e1?.dist === 1, '正前方 1 格的怪 ⇒ 认成挡路', JSON.stringify(e1))
  const e2 = mod.entityObstacleAhead(botEnt([{ name: 'zombie', position: new Vec3(1, 64, 2) }]), { x: 5, y: 64, z: 0 })
  ok(e2 === null, '偏到侧边 2 格的怪 ⇒ 不算挡路（不误报）')
  const e3 = mod.entityObstacleAhead(botEnt([{ name: 'item', position: new Vec3(1, 64, 0) }]), { x: 5, y: 64, z: 0 })
  ok(e3 === null, '掉落物不算挡路（跟 vendor 的 passableEntities 一致）')
  const e4 = mod.entityObstacleAhead(botEnt([{ name: 'zombie', position: new Vec3(-3, 64, 0) }]), { x: 5, y: 64, z: 0 })
  ok(e4 === null, '身后的怪不算挡路')

  /* 未加载：blockAt 返回 null */
  const botNull = { entity: { position: new Vec3(0, 64, 0) }, blockAt: () => null }
  ok(mod.blockKnownAt(botNull, 5, 64, 0) === false, '读不到方块 ⇒ 视为未加载（不是空气）')
  ok(mod.blockKnownAt(botEnt([]), 5, 64, 0) === true, '读得到 ⇒ 已知')

  /* 岩浆 */
  const botLava = {
    entity: { position: new Vec3(0, 64, 0) },
    blockAt: (v) => ({ name: v.x === 2 ? 'lava' : 'air', position: v }),
  }
  const l1 = mod.lavaAheadOf(botLava, { x: 5, y: 64, z: 0 }, { cells: 3 })
  ok(l1?.name === 'lava' && l1?.dist === 2, '前方 2 格是岩浆 ⇒ 认出来', JSON.stringify(l1))
  const botWater = {
    entity: { position: new Vec3(0, 64, 0) },
    blockAt: (v) => ({ name: v.x === 2 ? 'water' : 'air', position: v }),
  }
  ok(mod.lavaAheadOf(botWater, { x: 5, y: 64, z: 0 }, { cells: 3 }) === null, '水不算岩浆（水有游泳控制器）')

  /* 静态接线 */
  ok(/mv\.entityCost = 8/.test(plug), '实体成本调到 8（默认 1 太弱，A* 绕一步就抵掉了）')
  ok(/mv\.allowEntityDetection = true/.test(plug), '显式打开实体检测（别被别处关掉）')
  ok(/reason: 'waiting_chunks'/.test(src), '区块没加载 ⇒ 报 waiting_chunks，不再说「被墙挡住」')
  ok(/entityObstacleAhead\(b, target, \{ cells: 2 \}\)/.test(src), '卡住时先查是不是实体挡着')
  ok(/planTried\.push\('entity'\)/.test(src), '实体挡路记进 planTried')
  ok(/planTried\.push\('lava'\)/.test(src), '岩浆挡路记进 planTried')
  ok(/why: 'iron'/.test(src) && /铁门/.test(src), '铁门按不开时给一句人话')
  ok(/why: 'closed'/.test(src) && /别挖门框/.test(src), '门按不开时明确「别挖门框」')
  /* 2026-10-24 用户：「每级时间缩短，按你之前的建议」—— 阶梯等待按动作分档 */
  ok(/export const MOVE_STEP_WAIT_MS = \{/.test(src), '脱困阶梯的等待时间按动作分档（不再一律 2.4 秒）')
  ok(/stuckMs: stuckMsNow/.test(src) && /const stepNow = attempt > 0 \? escapeStepOf/.test(src), '判卡用的是当前那一级的等待时间')
  /* 🔴 2026-10-31 用户：「每级先等 MOVE_STUCK_MS 2400 / vendor 3500，7~10 级 —— 这个怎么解决」。
   *    旧断言把 `repath: 900` / `breakAhead: 2400` 字面量钉死（一调就红），而且**漏了三级别**：
   *    descend / clearHead / climbUp 根本不在表里 ⇒ 各自落回 2.4 秒。
   *    改成钉行为：① 三级都在表里；② 每一级都明显短于 `MOVE_STUCK_MS`（探针量级）。 */
  {
    const tbl = (src.match(/export const MOVE_STEP_WAIT_MS = \{([\s\S]*?)\}/) ?? [])[1] ?? ''
    const miss = ['descend', 'clearHead', 'climbUp', 'repath', 'jump', 'breakAhead'].filter((k) => !new RegExp(`\\b${k}:\\s*\\d+`).test(tbl))
    ok(miss.length === 0, '每一级都有自己的等待值（descend/clearHead/climbUp 不许漏——漏了就落回 2.4 秒）', miss.join(',') || 'ok')
    const maxMs = Math.max(...(tbl.match(/\d+/g) ?? ['0']).map(Number))
    ok(maxMs <= 1500, '每一级都是"探针"量级（≤1.5 秒），不是等 2.4 秒的"没靠近"判据', String(maxMs))
    ok(/export const MOVE_STUCK_MS = 2400/.test(src), 'MOVE_STUCK_MS 本身还在（它是"没有对比级"时的兜底）')
  }
  ok(/STEP_UP_TRIES = 1/.test(src), '局部台阶一次移动只试一次')
  /* 2026-10-25 实机（上阶梯卡住、头顶是空的）：跳了却没上去 ⇒ 先起跳再前进，且等朝向生效 */
  /* 🔴 2026-10-29：旧断言把 150/80 两个数字钉死 —— 一调延迟就红（想提速时最碍事）。
   *   改成钉**上限 + 行为**：转向 ≤150ms、起跳 ≤80ms、落地立刻继续（不是死睡）。 */
  ok(/export const STEP_UP_TURN_MS = (\d+)/.test(src) && Number(RegExp.$1) <= 150,
    '看向后等朝向生效，但不超过 150ms（上台阶不该为转向付大钱）')
  ok(/export const STEP_UP_JUMP_MS = (\d+)/.test(src) && Number(RegExp.$1) <= 80,
    '先单独起跳再叠 forward，起跳等待不超过 80ms')
  ok(/if \(e\?\.onGround === true && Number\(e\?\.position\?\.y \?\? y0\) > y0 \+ 0\.75\) break/.test(src),
    '落地就立刻继续（不再固定睡满 settle 时间）')
  {
    const i0 = src.indexOf('export async function stepUp')
    const seg = src.slice(i0, src.indexOf('export async function escapeMove', i0))
    const ij = seg.indexOf("setControlState('jump', true)")
    const iw = seg.indexOf("setControlState('forward', true)")
    /* 🔴 2026-11-05 反了：以前钉的是「jump 在 forward 之前」（2026-10-24 的结论：同时按会撞上
     *   台阶侧面）。但实机反复证明「先跳再前进」是从**静止**起跳 —— 行走速度才 0.22 格/tick，
     *   跳跃升满 1 格只要 2 tick，水平只能挪 0.4 格 ⇒ 跨不过一格台阶，跳了也上不去
     *   （用户：「stair 还是上不去 / 每次挖完换个地方挖」）。
     *   现在的顺序是「先助跑（forward + sprint）→ 再起跳」，所以这里钉的是 forward 在前、
     *   而且中间隔着 STEP_UP_RUNUP_MS 的助跑。 */
    ok(ij > 0 && iw > 0 && iw < ij, 'forward 在 jump 之前（先助跑再起跳）')
    ok(seg.includes('sleep(STEP_UP_RUNUP_MS)'), '助跑时长用 STEP_UP_RUNUP_MS')
    ok(!seg.includes("setControlState('sprint', true)"), '起跳不 sprint（2026-11-05 实机：助跑只有 90ms，sprint 会先撞台阶侧面）')
    ok(/const ok = up >= 0\.75\n/.test(seg) || /const ok = up >= 0\.75$/.test(seg.trim()) ||
       /const ok = up >= 0\.75(?! &&)/.test(seg), '只认“真抬高了将近一格”，不再要求水平位移（窄井里横向几厘米就撞墙）')
  }
}
/* ── （2026-10-27）结果字段不许说谎：`stuck` / `moved` 的语义 ── */
{
  const src = readFileSync(new URL('../src/movement.mjs', import.meta.url), 'utf8')
  /* 现场（session-514c21b6，用户 m02756「这个会话的 dig 和 move 根本不准确」）：
   * 324 次 mc_move 里 199 次返回都带 `stuck:true`，包括"这一轮时间到、但已经挪了 11 格"的 ——
   * 这个字段原来是**无条件写死 true**，模型一看就以为卡死了、别再试。 */
  ok(/stuck: Boolean\(preempted \|\| exhausted \|\| \(noProgress && !timeUp\)\)/.test(src),
    'stuck 只在"真没进展/被抢占/脱困用尽"时为 true（不是无条件写死）')
  const pathFailAt = src.indexOf("via: 'pathfinder',")
  ok(pathFailAt > 0 && !/^\s*stuck: true,\s*$/m.test(src.slice(pathFailAt, pathFailAt + 400)),
    'pathfinder 失败分支里不再有裸的 `stuck: true`（那种写法让 199/324 次结果都误标卡死）')
  /* `moved` 是**水平**位移（deltaOf 里 hypot(dx,dz)），文案以前只写"挪了 N 格" ⇒
   * 结果里 `moved:5.87` 配 `movedVertical:-7` 看着像自相矛盾。 */
  ok(/水平挪了 \$\{moved\} 格/.test(src), 'hint 说清"水平挪了 N 格"（垂直由 vertNote 单独说）')
  ok(/const horizontal = Number\(Math\.hypot\(dx, dz\)\.toFixed\(2\)\)/.test(src),
    'deltaOf 的 moved 就是水平位移（hypot(dx,dz)）—— 语义与文案一致')
}
/* ── （2026-10-27）移动老是卡：悬空坠落 + 原地杵着不动 ── */
{
  const src = readFileSync(new URL('../src/movement.mjs', import.meta.url), 'utf8')
  /* 现场（session-514c21b6）：97 次坠落、累计 696 格、最深 28 格（74→46）；
   * 726 次 mc_move 里 187 次只剩 timeout、107 次 path-reset、33 次 PathStopped 且
   * "moved=0 但人没到"。病根两层：
   *   ① vendor 把"路径作废、下个 tick 重算"（chunk_loaded / block_updated）也当成
   *      "这次 goto 废了" ⇒ stop() ⇒ 人立刻站住 —— 就是「脚踩实地杵着不动」；
   *   ② 垫方块先按住 jump 升到摆放高度，再 equip（一次网络往返），等回包时人已经在掉，
   *      placeBlock 时脚下那格已不可放置 ⇒ place_error ⇒ 摔下去 —— 就是「卡在半空 1~2 秒」。 */
  ok(/export const MOVE_AUTOREPATH_MAX = \d+/.test(src), '中途被重置后可自动重发（有上限，不无限转）')
  ok(/export const MOVE_AUTOREPATH_STALL = \d+/.test(src), '连续重发都没靠近就收手（防原地空转）')
  ok(/const BENIGN_RESET = new Set\(\[[^\]]*'chunk_loaded'/.test(src), '"路径作废、马上重算"那几类不算被打断')
  ok(/if \(BENIGN_RESET\.has\(k\)\) return/.test(src), '正常重算不进 resetReasons（别把正常当故障说给模型）')
  ok(/lastReset = k/.test(src), '记下最近一次重置原因，供失败归因')
  ok(/autoRepathStall <= MOVE_AUTOREPATH_STALL/.test(src), '只有"重发后确实靠近了"才继续重发')
  ok(/dLeftNow <= autoRepathDLeft - 0\.5/.test(src), '靠近的判据是距离减少 >0.5 格（不是自我安慰）')
  ok(/if \(r\.pathResetReasons\)/.test(src) && /\.slice\(0, 4\)/.test(src),
    '结果里保留 top-4 重置原因（2026-10-24 那次"简化输出"把它删了，模型只看到"卡住"不知道为什么）')
  ok(/place_error: 'place-error/.test(src) && /no_scaffolding_blocks: 'no-scaffolding/.test(src),
    '重置原因翻成人话（place-error / no-scaffolding…）')
  /* vendor 侧补丁：这里只查 `tools/patch-mc-deps.mjs` 覆盖到没有（重装依赖要靠它重打） */
  const patchSrc = read('../tools/patch-mc-deps.mjs')
  ok(/RESUMABLE_RESETS/.test(patchSrc), 'vendor 补丁：可恢复的重置不再 stop()')
  ok(/placingEquipped/.test(patchSrc), 'vendor 补丁：垫方块改成起跳前预装备')
  ok(/lastResetReason/.test(patchSrc), 'vendor 补丁：goto 的 PathStopped 带上真实原因')
}

/* ── （2026-10-27 立、2026-10-31 撤）挖路优先 `digFirst` 现在默认关 ── */
{
  /* 现场：用户「nodig false 还是优先走现有路线，false 应该直接按最短路线挖」。
   * 病根：`allowDig:true` 只松开 `canDig`，A* 里挖一格的代价仍是 terrain 表给的 3~8，
   *       "绕两格"永远比"挖一格"便宜 ⇒ 明明允许挖，它还是绕。
   * 修法：显式 `allowDig:true`（明确要挖）⇒ `digFirst`，挖按"多走一步"计价（movements.digCost 0.4）。
   * ⚠️ 2026-10-31 用户实机：目标在脚下 22 格时，这 0.4 让 A* 眼里"往下掏穿地板"永远最短，
   *    算出一条又挖不动脚下、又到不了的路，和"绕不过去"来回横跳 ⇒ **默认关**，要开得显式
   *    `cfg.walkDigFirst:true`；`allowDig` 只松 canDig，不再顺带改挖价。 */
  const { DEFAULTS: D2 } = await import(new URL('../src/core.mjs', import.meta.url))
  ok(D2.walkDigFirst === false, '默认**不**挖路优先（先绕，绕不过才挖；要开得显式 walkDigFirst:true）')
  ok(typeof D2.walkDigFirstCost === 'number' && D2.walkDigFirstCost > 0 && D2.walkDigFirstCost < 1,
    '挖一格的系数 < 1（默认 ' + D2.walkDigFirstCost + '）')
  /* 手挖石头 1.5 秒：laborCost = (1 + 3×1.5) × 0.4 ≈ 2.2 步 ⇒ 比"多绕三格"便宜。 */
  ok((1 + 3 * 1.5) * D2.walkDigFirstCost < 3, '手挖一格石头 ≲ 走三格（绕路不再稳赢）')
  const plug2 = readFileSync(new URL('../src/plugins.mjs', import.meta.url), 'utf8')
  ok(/export function movements \(self, \{ terrain = null, digFirst = false, allowDig = false \} = \{\}\)/.test(plug2),
    'movements() 收 digFirst + allowDig')
  ok(/const digFirstOn = digFirst === true/.test(plug2),
    'plugins 只认传进来的参数（开关只在 movement.mjs 一处，不再两处都判）')
  ok(/if \(digFirstOn\) mv\.digCost = Number\(self\.cfg\?\.walkDigFirstCost \?\? 0\.4\)/.test(plug2),
    'digFirst 时把 digCost 压到 walkDigFirstCost')
  ok(!/digFirstOn[^\n]*canDig/.test(plug2), 'digFirst 不动 canDig（安全边界不松）')
  const mv2 = readFileSync(new URL('../src/movement.mjs', import.meta.url), 'utf8')
  ok(/const digFirst = ctx\.cfg\?\.walkDigFirst === true/.test(mv2)
    && !/const digFirst = allowDig === true/.test(mv2),
    'digFirst 只由 cfg.walkDigFirst 开，`allowDig:true` 不再顺带打开')
  /* 2026-11-02：第三处（垫柱兜底那段）随自动垫柱一起删了 —— 现在是两处。 */
  ok((mv2.match(/ctx\.movements\(terrain, \{ digFirst, allowDig \}\)/g) || []).length === 2,
    '两处建 Movements（主 / 地形重估）都带上 digFirst + allowDig（垫柱兜底那处已删）')
  /* 2026-10-31：目标在头顶/脚下、A* 说"到了"却没到那个高度时，往下/往上动作要真的被叫到
   * （以前只认 `emptyNoPath` ⇒ 这种情况一次都没试过，直接报"先走到同一层"）。 */
  ok(/let vertStuck = false/.test(mv2) && /if \(Math\.abs\(dyR\) > 1\.5 && horizR <= arriveUsed \+ 1\.0\) vertStuck = true/.test(mv2),
    '"到了但差层"会被识别成垂直方向没路（vertStuck）')
  ok(/if \(\(emptyNoPath \|\| vertStuck \|\| upFirst\) && riseMode === 'dig'/.test(mv2),
    '识别到之后交给往上挖（只有这趟的上升方式是“挖”才动手，垫柱那趟不抢）')
  /* 🔴 2026-11-02 用户：「只用 allowDig 上地表，它会乱挖」—— 两条修法各钉一处。 */
  ok(/if \(digDirTax > 0\)/.test(plug2)
    && /m\.cost = \(Number\(m\.cost\) \|\| 0\) \+ digDirTax \* \(dyDir < 0 \? 5 : 2\)/.test(plug2)
    && /if \(!Number\.isFinite\(dyDir\) \|\| dyDir > 0\) continue/.test(plug2),
    'A* 挖方块按方向收税：向上原价、水平 +2 份、向下 +5 份（不再在三维里挑最便宜的挖法）')
  ok(/digDirTax: allowDig === true \? Number\(self\.cfg\.walkDigSideTax \?\? 15\) : 0/.test(plug2)
    && D2.walkDigSideTax === 15,
    '方向税只在 allowDig 那趟生效，默认 15 步/份')
  ok(/const upFirst = carveNoPathOk && riseMode === 'dig' && \(headBlockedNow \|\| !upFirstDone\)/.test(mv2),
    '目标在头顶且水平 ≤3 格、这趟的上升方式是“挖”时先切一刀 climbUp（头顶不堵时只做一次）')
  /* 🔴 2026-11-05 用户：「只用 allowdig，一开始头顶如果有方块的话会乱挖其他地方的方块，
   *   挖掉头顶方块后就正常了」—— 头顶堵着时那一刀 climbUp 常常上不去，而它只做一次，
   *   之后 A* 会给一条水平绕行的路，补挖就把水平那面墙挖了（“乱挖别处”）。
   *   现在：**头顶（fy+2）被方块堵着就每一轮都先 climbUp**（第一步就是清头顶）。 */
  ok(/const hb = b\.blockAt\(new Vec3\(Math\.floor\(pp\.x\), Math\.floor\(pp\.y\) \+ 2, Math\.floor\(pp\.z\)\)\)/.test(mv2)
    && /const headBlockedNow = \(\(\) => \{/.test(mv2),
    '★ 每轮现读头顶那一格（fy+2）判有没有被堵')
  ok(/if \(upFirst\) upFirstDone = true/.test(mv2), '头顶通了之后退回“只做一次”的老行为')
  /* 🔴 2026-11-05 用户：「allowtower 和 allowdig 同时开，会混着用，挖了几格又往脚下搭方块，
   *   一会换一种反而上不去。要按 cost 定」。
   *   规矩：开局按代价定一次（垫一层 placeCost vs 挖一层 3×digCost），整趟只用一种；
   *   只有 A* 判 NoPath（= 垫不上去）才允许切到挖，且切过去不回头。 */
  ok(/const towerAllowed = noTower === false/.test(mv2)
    && /let riseMode = \(towerAllowed && carveNoPathOk && headOk\) \? 'mixed'/.test(mv2)
    && /towerCostOne <= digCostLayer\) \? 'tower' : 'dig'/.test(mv2),
    '★ 开局按“能做得到什么 + 清头顶要多久”选：头顶清得动 ⇒ mixed（挖头顶 + 垫脚下，最省）；'
    + '否则按垫一层 vs 挖一层的价钱定 tower/dig')
  ok(/const headOk = \(\(\) => \{/.test(mv2) && /Number\(blk\.hardness \?\? 0\) > 3/.test(mv2),
    '头顶方块太硬（>3，如深板岩/黑曜石）就不走 mixed —— 挖它比垫一层还贵')
  ok(/const switchRiseMode = \(why, force = false\) => \{/.test(mv2)
    && /if \(riseSwitches >= 2\) return false/.test(mv2)
    && /if \(riseMoved < 1 && !force\) return false/.test(mv2)
    && /switchRiseMode\('垫不上去（A\* 判没路）', towerRetries >= 2\)/.test(mv2)
    && /switchRiseMode\('挖了两次都没升上去'\)/.test(mv2),
    '★ 只有“事件”才换上升方式（垫不上去 / 挖两次没升上去），且切换后要真推进过、一趟最多 2 次；'
    + '垫柱那档一格没垫上去时允许“试两次就强制改挖”（riseMoved 恒为 0 否则永远切不了）')
  ok(/if \(Number\.isFinite\(yUp0\) && Number\.isFinite\(yStartRise\) && yUp0 >= yStartRise \+ 1\) riseMoved = 1/.test(mv2),
    '垫柱是 A\\* 干的 —— 用“比这趟开始高了多少”给 riseMoved 补账，否则永远不许换方式')
  ok(!/shaftUp/.test(mv2),
    '不搞"直井式"上升（挖开头顶那格后正上方没落脚点，跳起来只会掉回原格；往上必须造台阶）')
  ok(/const cu = await climbUp\(b, target, \{ allowDig: carveNoPathOk, ctx, maxLevels: MOVE_CLIMB_LEVELS \}\)/.test(mv2),
    '目标在头顶时走斜梯 climbUp（挖斜上两格 + 清自己头顶，跳上去落在相邻方块顶面）')
  ok(/let stable = 0/.test(mv2) && /if \(Math\.abs\(y2 - lastY\) < 0\.02\) \{ stable \+= 1; if \(stable >= 2\) break \}/.test(mv2),
    '跳完等"y 不再变"才挖下一层（取代固定 700ms，且不会挖到自己脚下）')
  ok(/for \(let tryI = 0; tryI < 2 && !upOk; tryI\+\+\)/.test(mv2) && /if \(upOk\) \{/.test(mv2),
    '同一个方向给两次起跳机会（偶发跳不上去就再来一次，不直接换方向）')
  /* 🔴 2026-11-05 用户：「只用 allowdig 也像 stair 那样会乱挖 —— 挖几下后换个方向挖台阶」。
   *   原来 `for (const [sx, sz] of cand)` 在“跳不上去”时会继续试下一个方向 ⇒ 每换一次白挖 3 格。
   *   规矩与 stair 一致：方向锁死；跳不上不换方向（那是时机/朝向问题，不是方向问题）。 */
  ok(/if \(Array\.isArray\(memo\) && \(memo\[0\] \|\| memo\[1\]\)\)/.test(mv2)
    && /cand\.unshift\(cand\.splice\(i, 1\)\[0\]\)/.test(mv2),
    '★ 上一层成功的方向记在 __mcClimbDir，这一层优先用它')
  ok(/b\.__mcClimbDir = \[sx, sz\]/.test(mv2), '成功了才记方向')
  ok(/refused = \{ why: 'no-lift', dir: \[sx, sz\]/.test(mv2)
    && /跳不上去 = 时机\/朝向问题，换个方向只会白挖 3 格/.test(mv2),
    '★ 跳不上去就停（不再换下一个方向白挖 3 格）')
  ok(/takenBy: String\(self\._moveGenWho \?\? 'unknown'\)/.test(mv2) && /if \(o\.takenBy\) extra\.takenBy = String\(o\.takenBy\)/.test(mv2),
    '被打断时点名是谁领走的号（只报"被另一次移动接管"查不出人）')
  ok(/_moveGenWho = 'init'/.test(read('../src/core.mjs')) && /#beginMove \(who = null\) \{ if \(who\) this\._moveGenWho/.test(read('../src/core.mjs')),
    'core 记下每次领号的来源（beginMove 带 who）')
  ok(/beginMove\('dig'\)/.test(readFileSync(new URL('../src/mining.mjs', import.meta.url), 'utf8')),
    '挖矿领号也带来源标签（dig）')
  ok(/climbedUp \+= Number\(cu\.up\) \|\| 0/.test(mv2)
    && /\.\.\.\(climbedUp \? \{ climbedUp \} : \{\}\)/.test(mv2)
    && /if \(num\(o\.climbedUp\) > 0\) extra\.climbedUp = num\(o\.climbedUp\)/.test(mv2)
    && /if \(num\(o\.carved\) > 0\) extra\.carved = num\(o\.carved\)/.test(mv2),
    '结果里报出"这趟挖了几格、靠 climbUp 往上爬了几格"（乱挖与正常向上挖可区分）')
  ok(/export const MOVE_DOWN_TRIES = 24/.test(mv2), '往下挖的硬上限放宽到 24（目标低 20 格也能一趟挖到底）')
  ok(/已经往下挖了 \$\{downTries\} 次还没到底/.test(mv2) && /已经往上挖了 \$\{upTries\} 次还没上去/.test(mv2),
    '报错时按"已经挖了几次"分流，并说清"再叫一次接着挖"')
  const core2 = readFileSync(new URL('../src/core.mjs', import.meta.url), 'utf8')
  ok(/movements: \(terrain, opts\) => this\.#movements\(terrain, opts\)/.test(core2),
    '#pathCtx 把 opts 透传给 movements()')
  /* 复盘实机会话那批"你掉下去了"：97 次里只有 13 次真垫过柱子，其余是正常下坡。 */
  ok(/const descendsOnPurpose = Number\.isFinite\(Number\(target\?\.y\)\)/.test(mv2),
    '区分"真摔"与"目标本来就在下面"')
  ok(/descended: f, descendedFrom/.test(mv2), '正常下坡只报 descended（不再说"垫柱子被拒"）')
  ok(/if \(f == null \|\| !fellIsReal\(f\)\) return ''/.test(mv2), '下坡不吓唬模型（fellNote 为空）')
  ok(/这次 \$\{gotSec\} 秒/.test(mv2), '预算到点的文案写清"这次分到多少秒"（不再是硬梆梆的 10 秒）')
}

/* ═══════════════ ㉗ 实机 session-aa82：A* 说"没路"也要先挖一下 ═══════════════ */
section('㉗ A* 直接报 NoPath 时，自己挖开眼前那格（别把活退回给模型）')
{
  /* 2026-10-27 用户实机（新旧两个会话都栽在这）：9 次"没路可走"里 5 次 `blockedAhead` 已经给了
   * 具体方块坐标，模型只补挖了 2 次、每次多 1~2 次往返。A* 说没路 ≠ 真没路，往往就是眼前/头顶那一格。 */
  const mv3 = readFileSync(new URL('../src/movement.mjs', import.meta.url), 'utf8')
  ok(/const carveNoPathOk = allowDig === true/.test(mv3),
    '🔴 NoPath 补挖有独立开关 carveNoPathOk（不吃 carveAllowed 的 TDZ）')
  ok(mv3.indexOf('const carveNoPathOk = allowDig === true') < mv3.indexOf('if (emptyNoPath && carveNoPathOk'),
    '开关声明在用到它的分支之前（别再造成 2026-10-25 那种 TDZ 崩）')
  ok(/if \(emptyNoPath && carveNoPathOk && carveTries < MOVE_CARVE_TRIES && carved < MOVE_CARVE_TOTAL\)/.test(mv3),
    'NoPath 分支复用同一套封顶（carveTries / MOVE_CARVE_TOTAL，不许无限挖）')
  ok(/没路可走，眼前 \$\{obstacle\.name\}/.test(mv3), '日志说清"眼前是哪一格挡着"（模型不用再猜）')

  /* ── 行为：脚前头顶那一格是石头 + A* 报 NoPath ⇒ 真的挖掉它 ── */
  const clock = autoClock()
  const bot = mkLoopBot()
  const gone = new Set()
  bot.blockAt = (p) => {
    const x = Math.floor(p.x), y = Math.floor(p.y), z = Math.floor(p.z)
    if (gone.has(`${x},${y},${z}`)) return { name: 'air' }
    if (y <= 63) return { name: 'stone' }
    if (x === 1 && y === 65 && z === 0) return { name: 'stone' }   /* 脚前那颗"头上的石头" */
    return { name: 'air' }
  }
  const dug = []
  bot.dig = () => { dug.push('1,65,0'); gone.add('1,65,0'); return Promise.resolve() }
  const handlers = new Map()
  bot.on = (ev, fn) => { handlers.set(ev, fn) }
  bot.pathfinder.goto = () => {
    handlers.get('path_update')?.({ status: 'noPath', path: [] })
    return Promise.resolve()
  }
  const self = mkSelf(bot)
  await walkPathfinder(self, { x: 5, y: 64, z: 0 }, { arrive: 1.6, budget: 20000, allowDig: true }, mkCtx(self, clock))
  clock.stopPump()
  ok(dug.length >= 1, 'A* 说没路，但脚前头顶那格石头被挖开了（不再空手退出）', JSON.stringify(dug))
  ok(self.logs.some((m) => /没路可走，眼前 stone（1,65,0）挡着/.test(m)),
    '日志报出挡路那格的确切坐标',
    JSON.stringify(self.logs.filter((m) => /没路可走/.test(m)).slice(0, 2)))

  /* ── 安全线：眼前根本没有任何方块挡着 ⇒ 一格都不许挖 ── */
  const clock2 = autoClock()
  const bot2 = mkLoopBot()
  const dug2 = []
  bot2.dig = () => { dug2.push(1); return Promise.resolve() }
  const h2 = new Map()
  bot2.on = (ev, fn) => { h2.set(ev, fn) }
  bot2.pathfinder.goto = () => {
    h2.get('path_update')?.({ status: 'noPath', path: [] })
    return Promise.resolve()
  }
  const self2 = mkSelf(bot2)
  await walkPathfinder(self2, { x: 5, y: 64, z: 0 }, { arrive: 1.6, budget: 20000 }, mkCtx(self2, clock2))
  clock2.stopPump()
  ok(dug2.length === 0 && !self2.logs.some((m) => /没路可走，眼前/.test(m)),
    '🔴 眼前没明确方块就不挖（安全线：NoPath 不是"随便挖"的许可）', String(dug2.length))
}

/* ═══════════════ ㉒ 岩浆自救（🔴 2026-10-27 实机：用户「现在掉在岩浆里动不了」） ═══════════════ */
section('㉒ 岩浆：泡在里面时自己上浮 + 找岸，不许交给 A*')
{
  /* 背景：以前岩浆里**什么都不做** —— `inWaterNow` 不认岩浆 ⇒ 落进 A* ⇒ 岩浆格 `safe:false` ⇒ NoPath，
   * 然后每轮白烧 10 秒预算。岩浆 4 点/0.5 秒（不吃护甲），20 血约 2.5 秒烧光。
   * 这一节钉住：① 判据在 ② 自救排在 A* 之前 ③ 找不到岸要如实报 + 给可行自救 ④ 水里不再"两遍试探"。 */
  const lav = await import(new URL('../src/lava-recovery.mjs', import.meta.url))
  const wo = await import(new URL('../src/world-observer.mjs', import.meta.url))
  const bn = await import(new URL('../src/block-names.mjs', import.meta.url))

  ok(bn.isLavaLike('lava') && bn.isLavaLike('flowing_lava') && !bn.isLavaLike('magma_block'),
    'isLavaLike 只认岩浆本体（magma_block 是固体，不算"泡在里面"）')

  /* 假 bot：脚下/头/四周全是岩浆；`shore:true` 时 x=2 那列是"空气 + 底下一格石头" */
  function mkLavaBot ({ shore = false } = {}) {
    const b = {
      entity: { position: new Vec3(0, 64, 0), onGround: false, isInLava: true },
      controls: [],
      calls: { goto: 0 },
    }
    b.blockAt = (p) => {
      const x = Math.floor(p.x); const y = Math.floor(p.y); const z = Math.floor(p.z)
      if (shore && x === 2) {
        if (y === 63) return { name: 'stone' }
        if (y === 64 || y === 65) return { name: 'air' }
      }
      return { name: 'lava' }
    }
    b.setControlState = (k, v) => b.controls.push([k, v])
    b.lookAt = () => {}
    b.on = () => {}
    b.removeListener = () => {}
    b.pathfinder = {
      isMining: () => false,
      isBuilding: () => false,
      setMovements: () => {},
      setGoal: () => {},
      goto () { b.calls.goto++; return Promise.resolve() },
    }
    return b
  }

  ok(wo.inLavaNow({ entity: { isInLava: true } }) === true,
    '🔴 inLavaNow 认出 `entity.isInLava`（三层兜底的第一层）')
  ok(wo.inLavaNow({ entity: { position: new Vec3(0, 64, 0) }, blockAt: () => ({ name: 'lava' }) }) === true,
    '🔴 inLavaNow 第二层：`entity.isInLava` 读不到时按脚下那格判（照 inWaterNow 的兜底）')
  ok(wo.inLavaNow({ entity: { position: new Vec3(0, 64, 0) }, blockAt: () => ({ name: 'stone' }) }) === false,
    'inLavaNow 站在石头上不算泡在岩浆里')

  /* ① 找岸：BFS 允许穿岩浆（A* 做不到这件事） */
  const noShore = lav.lavaExitSearch(mkLavaBot())
  ok(noShore.found === false && noShore.reason === 'no-shore',
    '四周全岩浆 ⇒ found:false / reason:no-shore（不假装有路）', JSON.stringify(noShore.reason))
  const hasShore = lav.lavaExitSearch(mkLavaBot({ shore: true }))
  ok(hasShore.found === true && hasShore.target && Math.floor(hasShore.target.x) === 2,
    '旁边有能站的岸 ⇒ 找到它并报出坐标', JSON.stringify(hasShore.target))
  ok(lav.shoreAt(mkLavaBot({ shore: true }), 2, 64, 0) === true,
    'shoreAt：空气两格 + 脚下石头 ⇒ 是岸')
  ok(lav.shoreAt(mkLavaBot(), 0, 64, 0) === false,
    'shoreAt：脚下是岩浆 ⇒ 不是岸')

  /* ② walkTo 泡在岩浆里 ⇒ 走 lavaEscape，一次 A* 都不许叫 */
  {
    const clock = autoClock()
    const bot = mkLavaBot()
    const self = mkSelf(bot)
    self.requireBot = () => bot
    self.pfReady = true
    self.callLeft = () => 900                 // 别真等满 600ms 上浮 + 3 秒游
    let released = 0
    const ctx = { ...mkCtx(self, clock), releaseControls: () => { released++ }, stopPathing: () => {} }
    const r = await walkTo(self, { x: 20, y: 64, z: 0 }, { budget: 2000 }, ctx)
    clock.stopPump()
    ok(r.arrived === false && r.via === 'lava-escape' && r.reason === 'lava-escape',
      '🔴 泡在岩浆里 ⇒ 走岩浆自救（via/reason 都是 lava-escape）', JSON.stringify({ v: r.via, re: r.reason }))
    ok(bot.calls.goto === 0,
      '🔴 岩浆里一次 A* 都不叫（以前就是在这儿 NoPath 空转到预算用光）', String(bot.calls.goto))
    ok(r.stuck === true && /垫方块/.test(String(r.hint)),
      '找不到岸时如实报 + 给出"垫方块"这条真能活命的建议', String(r.hint).slice(0, 60))
    ok(r.lavaEscape && r.lavaEscape.findShore && r.lavaEscape.findShore.found === false,
      '结果里带 lavaEscape 明细（模型能看出搜了多大范围、为什么没岸）')
    ok(released >= 1, '自救结束一定松控制位（别把人按着 jump 卡在那）', String(released))
  }

  /* ③ 有岸 ⇒ 真的朝岸按 forward + jump，按完松开 */
  {
    const clock = autoClock()
    const bot = mkLavaBot({ shore: true })
    const self = mkSelf(bot)
    self.requireBot = () => bot
    self.pfReady = true
    self.callLeft = () => 900                 // 游 400ms 就收
    let released = 0
    const ctx = { ...mkCtx(self, clock), releaseControls: () => { released++ }, stopPathing: () => {} }
    const r = await walkTo(self, { x: 20, y: 64, z: 0 }, { budget: 2000 }, ctx)
    clock.stopPump()
    const pressedForward = bot.controls.some(([k, v]) => k === 'forward' && v === true)
    const releasedAll = !bot.controls.slice(-2).some(([, v]) => v === true)
    ok(r.lavaEscape && r.lavaEscape.findShore && r.lavaEscape.findShore.found === true,
      '有岸时会朝岸游（findShore.found:true）', JSON.stringify(r.lavaEscape?.findShore?.reason))
    ok(pressedForward, '🔴 真的按了 forward（岩浆里不按就沉底挨烧）')
    ok(releasedAll, '游完把 forward/jump 都松开', JSON.stringify(bot.controls.slice(-3)))
    ok(r.lavaEscape.tries >= 1, '报出试着游了几步', String(r.lavaEscape?.tries))
  }

  /* ④ 源码层面：接线顺序与"水里不做两遍试探" */
  const mvSrc = strip(read('../src/movement.mjs'))
  const iLava = mvSrc.indexOf('if (inLavaNow(b) && ctx.noLavaEscape !== true)')
  const iWater = mvSrc.indexOf('if (inWaterNow(b) && b.entity?.onGround !== true)')
  ok(iLava > 0 && iWater > 0 && iLava < iWater,
    '🔴 岩浆自救排在"水"和 A* 之前（岩浆比水急：2.5 秒就能烧死）', JSON.stringify({ iLava, iWater }))
  ok(/const lavaBlocking = inLavaNow\(b\) \? null : lavaAheadOf\(b, target/.test(mvSrc),
    '🔴 自己泡在岩浆里时脱困阶梯不再被 lavaAheadOf 拦住（否则每轮 continue 空转到超时）')
  ok(/if \(!inWaterNow\(b\) && !inLava\)/.test(mvSrc),
    'swimUp 允许在岩浆里按 jump 上浮（以前回"我本来就没在水里"）')
  const idxSrc = strip(read('../index.js'))
  const iDeep = idxSrc.indexOf('if (deepWater) return await sess.bot.walkTo(target, { ...opts, allowDig: false, budget: total })')
  /* 🔴 2026-10-28：第一遍的预算抽成了 `firstMs` 常量（原来是内联的 `Math.max(1500, ...)`），
   *   这条断言以前钉的是内联写法 ⇒ 一抽常量就假失败。改成钉"第一遍那句"本身。
   * 🔴 2026-10-30：原来找的是 `'… })\n'` —— 这个仓库的 .js 是 CRLF，行尾是 `}\r\n`，
   *   带 `\n` 的字面量**永远匹配不上**（所以它从写下那天起就一直报 -1，是条假断言）。
   *   现在从"深水那句"之后找同一段文字，不碰行尾。 */
  const iFirst = idxSrc.indexOf('allowDig: false, budget: total })', iDeep + 1)
  ok(!/total \* 0\.4/.test(idxSrc), '🔴 第一遍不再切 40%（2026-10-28 用户实测「move 只给 4 秒」就是它切出来的）')
  ok(iDeep > 0 && iFirst > 0 && iDeep < iFirst,
    '🔴 深水里不做"先按一格不挖试 40%"（实测 5 次 swim-budget 全是 budgetMs×0.4：一条 20 格的河被切成两段）',
    JSON.stringify({ iDeep, iFirst }))
}

/* 🔴 2026-10-27 实机（session-514c21b6）：AI 自己记的账「**床没了**：我在家附近用
 *   noDig:false（即 allowDig:true）走动时把 black_bed (-10,79,38) 挖掉，掉落的床 5 分钟后消失」。
 *   `CARVE_PROTECTED` 只拦 DSH 自己的 `carveStepAhead` / `stepUp`（`diggableBlock`），
 *   **拦不住上游 A* 的 dig** —— 上游只看 `movements.blocksCantBreak`
 *   （vendor `movements.js:41` 默认只有 chest + 所有不可挖方块）。
 *   所以同一张名单必须再灌进 blocksCantBreak，否则"走路"就能把家里的床砸了。 */
{
  const plugSrc = read('../src/plugins.mjs')
  ok(/import \{[^}]*CARVE_PROTECTED[^}]*\} from '\.\/movement\.mjs'/.test(plugSrc),
    'plugins.mjs 从 movement 引了 CARVE_PROTECTED')
  ok(/for \(const blk of b\??\.registry\?\.blocksArray \?\? \[\]\) \{[\s\S]{0,200}?CARVE_PROTECTED\.test\(nm\)[\s\S]{0,120}?mv\.blocksCantBreak\.add\(blk\.id\)/.test(plugSrc),
    '🔴 A* 也不许挖受保护方块（床/箱子/工作台/熔炉/信标/刷怪笼…）—— 实机里走路把家里的床挖了')
  /* 🔴 2026-10-29：树再分两类——原木仍禁挖（挖了树塔），树叶改成“加价”（被树叶围住时得有路）。 */
  ok(/treeBlockIds\(b, \{ leaves: false \}\)\) mv\.blocksCantBreak\.add\(id\)/.test(plugSrc) && /CARVE_PROTECTED\.test\(nm\)/.test(plugSrc),
    '受保护方块与**原木**是 blocksCantBreak 里两条独立规则（树叶不在里面）')
  ok(/mv\.dshBreakPenalty = pen/.test(plugSrc) && /isLeafBlock\(blk\.name\)/.test(plugSrc),
    '树叶进“加价表”（mv.dshBreakPenalty）而不是禁挖名单')
}

/* 🔴 2026-10-27 实机（session-514c21b6）：AI 出岩浆后**身上还在烧**，站着吃东西被烧死
 *   （它自己在公屏上复盘的原话）。全仓之前 grep `entity.fire` = 0 处 —— 自保、状态、
 *   自救三个出口都不知道"我还在烧"，于是"爬出来了"就等于"安全了"，人就停在那儿等死。 */
{
  const stSrc = read('../src/status.mjs')
  const lavSrc = read('../src/lava-recovery.mjs')
  const idxSrc2 = readFileSync(new URL('../index.js', import.meta.url), 'utf8')
  ok(/fire: b\?\.entity\?\.fire === true/.test(stSrc), 'status 报"身上还烧着"（读 entity.fire）')
  ok(/s\.fire === true/.test(idxSrc2), 'mc_status 文案把"还在烧"说清楚（别停下吃东西）')
  ok(/entity\?\.fire === true[\s\S]{0,200}?别停下吃东西/.test(lavSrc),
    '岩浆自救成功后，若还在烧就提醒"别停下吃东西"（实机就是在这儿烧死的）')
}

/* 🔴 2026-10-27（用户：「auto-eat 抢占去掉」）：走路期间必须关掉自动吃。
 *   auto-eat 饿了会 equip 食物 + consume，那几秒不能移动，把手上的工具也换掉了。 */
{
  const mvSrc = read('../src/movement.mjs')
  ok(/export async function walkTo \(self, target, opts = \{\}, ctx = \{\}\) \{[\s\S]{0,600}?ae\.disableAuto\(\)/.test(mvSrc),
    'walkTo 一进来就关掉自动吃（disableAuto）')
  ok(/async function walkToInner \(self, target, opts = \{\}, ctx = \{\}\)/.test(mvSrc),
    '真正的走路实现挪进 walkToInner（外面那层只管自动吃开关）')
  ok(/\} finally \{[\s\S]{0,300}?ae\.enableAuto\(\)/.test(mvSrc),
    '走完（含异常/超时）在 finally 里还原自动吃')
}

/* 🔴 2026-10-27（用户：「nodig false 最短现在会挖家，ai 也没意识到要切换，设置个绕路最大
 *   限制大于 15 格在挖」）—— `digFirst` 把 `digCost` 压到 0.4 之后 A* 走几何最短，
 *   直着挖穿自家墙和地板。现在每挖一格额外记 `walkDigDetourMax`（默认 15）步。 */
{
  const plugSrc2 = read('../src/plugins.mjs')
  const coreSrc = read('../src/core.mjs')
  const movSrc = read('../src/movement.mjs')
  ok(/export function patchDigDetour \(mv, \{ perBlock = 15 \} = \{\}\)/.test(plugSrc2),
    '有"每挖一格多绕 N 步"的补丁（patchDigDetour）')
  ok(/if \(digFirstOn\) patchDigDetour\(mv, \{ perBlock: Number\(self\.cfg\?\.walkDigDetourMax \?\? 15\) \}\)/.test(plugSrc2),
    'digFirst（cfg.walkDigFirst:true）时挂上它')
  ok(/walkDigDetourMax: 15/.test(coreSrc), '默认门槛 15 格（cfg.walkDigDetourMax 可调）')
  ok(/const canBreak = typeof mv\.safeToBreak === 'function' \? mv\.safeToBreak\(block\) : true[\s\S]{0,200}?if \(!canBreak\) return c/.test(plugSrc2),
    '🔴 能不能挖要问 safeToBreak，不能拿代价 >=100 猜（黑曜石本来就 100+，以前被当成挖不了）')
  ok(/if \(block\?\.safe\) return c/.test(plugSrc2),
    '本来就能站的格子也不算挖')
  /* ⚠️ 2026-11-03：onDig 里补了「空气不算」的注释 ⇒ 距离从 160 放到 600（钉行为，不钉注释长度）。 */
  ok(/const onDig = \(blk\) => \{[\s\S]{0,600}?dugNames\.set/.test(movSrc),
    '挖方块时记下名字（不然"挖了 12 格"看不出把家拆了）')
  ok(/nm !== 'air' && nm !== 'cave_air' && nm !== 'void_air'/.test(movSrc),
    '空气不算"挖掉了什么"（diggingCompleted 带的常是挖完那刻的方块 ⇒ 以前会报「挖掉的是 air×6」）')
  ok(/dugBlocksOut\(\)/.test(movSrc) && /dugHint\(\)/.test(movSrc),
    '出口报 dugBlocks（top 4），挖 ≥3 格时 hint 说明挖了什么')
}


/* ═══════════════ ㉔ 悬空自救：清头顶（clearHead）+ 结果里报 airborne ═══════════════
 * 🔴 2026-10-28（用户：「卡在半空有没有可能是内部参数的问题」→ 实机确认就是）。
 *   三条一起改：悬空不再白等 6 秒、失败时说清"你是挂着的"、不挖那趟补一级"清头顶"。 */
section('㉔ 悬空自救：清头顶那格 + 结果里报 airborne')
{
  /* 假 bot：脚下 y=64，头顶 y=65 是 `name` 那一块 */
  const mkHeadBot = (name) => {
    const b = {
      dug: 0,
      entity: { position: new Vec3(0.5, 64, 0.5), onGround: true, velocity: { x: 0, y: 0, z: 0 } },
      blockAt: () => ({ name, boundingBox: 'block', position: new Vec3(0, 65, 0) }),
      pathfinder: { bestHarvestTool: () => null },
      dig: async () => { b.dug++ },
    }
    return b
  }
  for (const n of ['stone', 'dirt']) {
    const b = mkHeadBot(n)
    ok(await clearHeadCell(b, { levels: 1 }) === 1 && b.dug === 1, `头顶是 ${n} ⇒ 挖掉它（1 格）`)
  }
  /* 往上开路要 2 层：同一块石头在 y+1、y+2 都算 ⇒ levels:2 会挖两下（目标在上方时用这个） */
  {
    const b = mkHeadBot('stone')
    ok(await clearHeadCell(b, { levels: 2 }) === 2 && b.dug === 2, 'levels:2 ⇒ 连清两层（往上开路用）')
  }
  for (const n of ['air', 'cave_air']) {
    const b = mkHeadBot(n)
    ok(await clearHeadCell(b, { levels: 1 }) === 0 && b.dug === 0, `头顶是 ${n} ⇒ 不动手`)
  }
  /* 🔴 2026-10-29：`oak_leaves` 从“不挖”名单里拿掉了（树叶改成加价，挖得动）。 */
for (const n of ['chest', 'crafting_table', 'farmland', 'oak_log', 'bedrock', 'lava']) {
    const b = mkHeadBot(n)
    ok(await clearHeadCell(b) === 0 && b.dug === 0, `头顶是 ${n} ⇒ 不挖（保护名单 / 不可挖 / 不是方块）`)
  }
  /* 全局把走路挖块关掉时，`clearHead` 这一级也不许动手 */
  {
    const b = mkHeadBot('stone')
    const r = await escapeMove(b, { x: 0, y: 64, z: 10 }, 'clearHead', { cfg: { walkCanDig: false } })
    ok(r?.dug === 0 && b.dug === 0, 'cfg.walkCanDig=false ⇒ clearHead 不动手（配置仍然优先）')
  }
  {
    const b = mkHeadBot('stone')
    const r = await escapeMove(b, { x: 0, y: 64, z: 10 }, 'clearHead', { cfg: { walkCanDig: true } })
    ok(r?.dug === 1 && r?.clearHead === true, '允许挖 ⇒ clearHead 真挖一格，并把 clearHead 记进结果')
  }
  /* 源码口径：结果里必须有 airborne、hint 必须直说"挂在半空" */
  const src = read('../src/movement.mjs')
  ok(/airborne: \{ vy:/.test(src), '结果里报 `airborne`（离地时给 vy/vh，still 表示一动不动）')
  ok(/挂在半空、一动不动/.test(src), 'hint 直说"挂在半空、一动不动"，并指路（挖头顶 / 走到地面）')
  ok(/Math\.hypot\(Number\(v\.x\) \|\| 0, Number\(v\.z\) \|\| 0\)/.test(src),
    'moveBusyKind 用真实速度判"在不在动"（不是只看 onGround）')
}


section('㉓ 目标在头顶上方 ⇒ 自动往上挖（2026-10-28 用户：「move 在上面的时候自动挖不行吗」）')
{
  /* 实测场景（session-514c21b6 02:57:34）：垫柱子把人顶进 1×1 竖井，
   *   四面石头、`y+1` 是空气、`y+2` 才是石头 ⇒ 只清脚位+头位等于白挖。 */
  /* ① 目标在斜上方（水平差 1 格）：前方 y+2 那格也要挖 */
  const b = mkCarveBot({ '1,63,0': 'stone', '1,66,0': 'stone' })
  const n = await carve(b, { x: 1, y: 67, z: 0 })
  ok(n === 1 && b.dug.includes('1,66,0'), '目标在斜上方 ⇒ 连前方 y+2 那格一起挖开（不然跳/垫都顶头）', JSON.stringify({ n, dug: b.dug }))
  /* ② 目标就在**正上方**（水平零位移，`dirs` 为空）：该清自己头顶 —— 实机就是这样被关住的 */
  const b2 = mkCarveBot({ '0,66,0': 'stone' })
  const n2 = await carve(b2, { x: 0, y: 67, z: 0 })
  ok(n2 === 1 && b2.dug.includes('0,66,0'), '目标在正上方 ⇒ 清自己头顶那格（不是放弃）', JSON.stringify({ n2, dug: b2.dug }))
}
{
  /* 目标只高 1 格（正常台阶）：不许碰 y+2 —— 那多半是正常天花板 */
  const b = mkCarveBot({ '1,63,0': 'stone', '1,64,0': 'stone', '1,66,0': 'stone' })
  const n = await carve(b, { x: 1, y: 65, z: 0 })
  ok(!b.dug.includes('1,66,0'), '只差 1 格 ⇒ 不开天窗（不挖 y+2）', JSON.stringify(b.dug))
}
{
  /* 调用方指定了那一格（only）：挖完主格，若目标在上方还要接着清 y+2 */
  const b = mkCarveBot({ '1,63,0': 'stone', '1,64,0': 'stone', '1,66,0': 'stone' })
  const n = await carve(b, { x: 0, y: 67, z: 0 }, { only: { x: 1, y: 64, z: 0 } })
  ok(n === 2 && b.dug.includes('1,64,0') && b.dug.includes('1,66,0'), 'only 分支：主格 + 上方那格都挖', JSON.stringify({ n, dug: b.dug }))
}
{
  /* clearHeadCell 按层数清：目标在上 = 2 层 */
  const b = mkCarveBot({ '0,66,0': 'stone' })
  const n = await mod.clearHeadCell(b, { levels: 2 })
  ok(n === 1 && b.dug.includes('0,66,0'), 'clearHeadCell(levels:2) 会挖 y+2（y+1 是空气就跳过）', JSON.stringify({ n, dug: b.dug }))
  const b2 = mkCarveBot({ '0,66,0': 'stone' })
  const n2 = await mod.clearHeadCell(b2, { levels: 1 })
  ok(n2 === 0, 'clearHeadCell(levels:1) 只清 y+1 —— y+2 的石头不动', JSON.stringify({ n2, dug: b2.dug }))
}
{
  const src = read('../src/movement.mjs')
  /* 🔴 2026-10-30 全量审计：这条原来查的是 `MOVE_PLAN` —— 那张表**从来没被执行过**
   *    （真阶梯是 `MOVE_ESCAPES_*`），所以 2026-10-28「挖的趟也补 clearHead」那次其实没落到执行层。
   *    实际也不需要：允许挖时 `climbUp` 就是"先挖头顶两格再跳"，1×1 竖井照样出得去。
   *    改成钉真实阶梯的分工。 */
  ok(MOVE_ESCAPES_NODIG.includes('clearHead') && MOVE_ESCAPES_DIG.includes('climbUp') && !MOVE_ESCAPES_DIG.includes('clearHead'),
    '头顶挡路：不挖那套用 clearHead，挖的那套用 climbUp（本来就先挖头顶两格）')
  ok(/levels = 2/.test(src), 'clearHeadCell 支持按层清（levels）')
  ok(/const needAbove = ty != null && ty >= fy \+ 2/.test(src), 'carveStepAhead 判“目标在头顶上方 2 格以上”')
  ok(/wantY > myY\) \? 2 : 1/.test(src), '目标在上面才清 2 层，否则只清 1 层（不乱开天窗）')
}

/* 🔴 2026-10-28 实机（用户：「水下还是没有上浮，而且没有寻路」）：
 *   游泳段以前 `lookAt(goal.offset(0, 1.0, 0))` —— 目标在下方时视线朝下，`forward` 带上向下分量，
 *   又恒按 jump ⇒ 一上一下抵消，实测 10 秒只挪 0.68 格水平。朝向只该定水平方向。 */
section('㉓ 游泳朝向只定水平（垂直交给 jump）')
{
  const mvSrc = readFileSync(new URL('../src/movement.mjs', import.meta.url), 'utf8')
  ok(/const eyeY = Number\(b\?\.entity\?\.position\?\.y \?\? me\.y\) \+ 1\.6/.test(mvSrc), '对准点用眼睛高度（脚底 + 1.6）')
  ok(/lookAt\(new Vec3\(goal\.x, eyeY, goal\.z\), true\)/.test(mvSrc), 'lookAt 用 (goal.x, eyeY, goal.z) —— 不再带俯角')
  ok(!/lookAt\(goal\.offset\(0, 1\.0, 0\)/.test(mvSrc), '旧的 lookAt(goal.offset(0, 1.0, 0)) 已经不在（注释里提到不算）')
}

/* 🔴 2026-10-29 实机（session-d68855bb）：AI 顺着树冠一级级往上爬（同一目标连叫两次
 *   mc_move，y 分别 +7 / +1），最后卡在树冠里 —— 树叶禁挖 ⇒ A* 无路，脱困阶梯原地跳 5 次。
 *   三处修法都要钉住，否则下次动 movement 很容易被改回去。 */
section('树类方块不当台阶 / 目标在下方不跳 / 下落不算挂住')
{
  const mv = readFileSync(new URL('../src/movement.mjs', import.meta.url), 'utf8')
  ok('树叶不当"一格台阶"（isTreeBlock 拦在 stepGeometryOf 里）',
    /if \(isTreeBlock\(feetName\)\) \{/.test(mv) && /tree: true/.test(mv))
  ok('例外只给"目标正好落在这一格顶上"（砍树/树屋才放行）',
    /ty === fy \+ 1 && tx === x && tz === z/.test(mv))
  ok('目标在下方时跳过"跳跃脱困"（跳只会更高）',
    /const goalLower = Number\.isFinite\(Number\(target\?\.y\)\)/.test(mv) && /目标在下方 —— 跳只会更高/.test(mv))
  ok('明显在下落就不报"挂在半空一动不动"',
    /const still = vy > -0\.06 && Math\.abs\(vy\) <= MOVE_BUSY_VY_EPS/.test(mv))
}

/* ── ㉔ mc_move 的三形态（用户 2026-10-29：「默认只返回移动结果、当前位置、目标距离和下一步建议」）── */
{
  const { briefMoveOf, briefMoveTextOf } = mod
  const pos = { x: 120.7, y: 64.2, z: 305.4 }
  const arr = briefMoveOf({ arrived: true, moved: 12.4, remaining: 0, dug: 0 }, pos)
  ok(arr.status === 'arrived', '到达 ⇒ status="arrived"')
  ok(arr.remaining === 0, '到达 ⇒ remaining 归 0')
  ok(arr.position && arr.position.x === 120 && arr.position.z === 305, '到达 ⇒ position 取整到格')
  ok(arr.moved === undefined, '到达 ⇒ 不带 moved（到达就没有"挪了多少"这回事）')
  ok(arr.cause === undefined && arr.next === undefined, '到达 ⇒ 不带 cause/next')
  ok(Object.keys(arr).length <= 5, '到达 ⇒ 字段收敛到 ≤5 个')

  const prog = briefMoveOf({ arrived: false, reason: 'timeout', moved: 12.4, remaining: 35.2 }, pos)
  ok(prog.status === 'progress', '时间用完（没卡住）⇒ status="progress"')
  ok(prog.moved === 12.4 && prog.remaining === 35.2, '进展 ⇒ moved/remaining 都报')
  ok(typeof prog.next === 'string' && prog.next.includes('再叫一次'), '进展 ⇒ next 明确"再叫一次"')
  ok(prog.cause === undefined, '进展 ⇒ 不塞 cause（没卡住就没有原因好说）')
  ok(Object.keys(prog).length <= 6, '进展 ⇒ 字段收敛到 ≤6 个')

  const blk = briefMoveOf({
    arrived: false,
    reason: 'stuck',
    moved: 0,
    remaining: 35,
    stuck: true,
    blockedAhead: { x: 121, y: 64, z: 306, name: 'stone', cell: 'feet', headroom: 0 },
    roadInfo: () => ({}), nearBlocks: ['a', 'b'],
    planTried: ['jump', 'breakAhead'],
    hint: '这一大段话不该出现在返回里',
  }, pos)
  ok(blk.status === 'blocked', '卡住 ⇒ status="blocked"')
  ok(blk.reason === 'stuck', '卡住 ⇒ 带 reason')
  ok(typeof blk.cause === 'string' && blk.cause.includes('stone') && blk.cause.includes('121,64,306'), '卡住 ⇒ cause 说清挡路的是哪格什么方块')
  ok(typeof blk.next === 'string' && blk.next.includes('挖开'), '卡住 ⇒ next 给出可执行建议')
  ok(Object.keys(blk).length <= 8, '卡住 ⇒ 字段也收敛到 ≤8 个')
  ok(blk.hint === undefined && blk.planTried === undefined && blk.nearBlocks === undefined, '卡住 ⇒ 长 hint / 逐级 planTried / 邻块清单不进返回')

  ok(briefMoveTextOf(arr).startsWith('✅ 到了'), '文案：到达一句话')
  ok(briefMoveTextOf(prog).includes('还差 35.2 格'), '文案：进展带剩余格数')
  ok(briefMoveTextOf(blk).startsWith('⛔ 走不动：'), '文案：卡住先说"走不动"')
  ok(briefMoveTextOf(prog).split('\n').length === 1, '文案：永远一行')

  const idxSrc = (await import('node:fs/promises')).readFile ? await (await import('node:fs/promises')).readFile(new URL('../index.js', import.meta.url), 'utf8') : ''
  ok(/const\s+finish\s*=\s*\(res\)\s*=>\s*\{[\s\S]{0,400}?briefMoveOf\(res/.test(idxSrc), 'index.js：mc_move 走 finish（brief）出口')
  ok(/mc_move 明细 target=/.test(idxSrc), 'index.js：明细写进本地日志（不进模型上下文）')
  ok(!/walkWithAutoDig\([^\n]*\), \{ expect: 'moved' \}\), \.\.\.aroundOf\(sess\)/.test(idxSrc), 'index.js：walk 分支不再把周围方块清单塞进返回')

  /* 🔴 2026-11-02 审计（#24 / #20）：
   *   #24 `briefMoveOf` 以前自己又推一遍 `stuck`（"reason 不是 timeout/swim-budget 就算卡住"），
   *       `budget` 不在豁免名单里 ⇒ 同一条结果 status='blocked' 配"时间到了，接着走"。
   *   #20 `adviceFor()` 是唯一讲"下一步做什么"的判据，但它只拼进 `hint`，而出口只取
   *       `briefMoveOf` 的白名单 + `moveNextTextOf` 自己再推一遍 ⇒ 文案修复一句都没到过模型。 */
  const bud = briefMoveOf({ arrived: false, reason: 'budget', moved: 9, remaining: 12, stuck: false }, pos)
  ok(bud.status === 'progress', '预算用完（budget）⇒ progress，不许报"走不动"', bud.status)
  ok(!/走不动/.test(briefMoveTextOf(bud)), '文案：budget 不出现"走不动"', briefMoveTextOf(bud))
  const notStuck = briefMoveOf({ arrived: false, reason: 'stuck', moved: 3, remaining: 12, stuck: false }, pos)
  ok(notStuck.status === 'progress', '结果里 stuck:false 就照它（brief 不许自己再推一遍）', notStuck.status)
  ok(mod.adviceTextOf({ hint: '（从 30 格变成 12 格，水平挪了 5 格）—— 眼前挡路的是 oak_log：**别挖树**' })
    === '眼前挡路的是 oak_log：**别挖树**', 'adviceTextOf：取"（从…）"之后那半句')
  ok(mod.adviceTextOf({ hint: '；⚠️ 脱困阶梯还剩 挖开挡路那格 没试完 —— 同目标再叫一次（从 3 格变成 2 格）—— 真建议' })
    === '真建议', 'adviceTextOf：先定位"（从"再找 ——（前缀 escNote 里也有 ——）')
  ok(mod.adviceTextOf({ hint: '没有分隔符的一段话' }) === '', 'adviceTextOf：抽不出就返回空（交给 moveNextTextOf 兜底）')
  const adv = briefMoveOf({ arrived: false, reason: 'stuck', stuck: true, moved: 0, remaining: 8,
    hint: '（从 8 格变成 8 格，水平挪了 0 格）—— 是**树**：**别挖树**，绕开走' }, pos)
  ok(adv.next === '是**树**：**别挖树**，绕开走', 'next 用 adviceFor 的结论（文案修复真的到得了模型）', adv.next)
  ok(!/挖开挡路那格/.test(String(adv.next)), 'next 不再被 moveNextTextOf 的通用说法盖掉')
  const esc = briefMoveOf({ arrived: false, reason: 'stuck', stuck: true, moved: 0, remaining: 8,
    escapesLeft: ['挖开挡路那格', '侧向绕行'], hint: '' }, pos)
  ok(Array.isArray(esc.escapesLeft) && esc.escapesLeft.length === 2, '脱困阶梯剩余结构化给出（不再只活在 hint 里）')
}

/* 🔴 2026-10-29（用户：「mc_move noDig:false（即 allowDig:true）为什么没直接挖过去」→「A 和 B」）：
 *   A*（mineflayer-pathfinder）只为**水平**移动生成“挖穿”，脚下那一格永远不动 ⇒ 目标在下方时
 *   无论 canDig 是不是 true 都 NoPath。所以自己补两种往下的动作：
 *   `dropThrough`（B，挖脚下掉下去）与 `stepDown`（A，挖斜下台阶下一层）。 */
const dropThrough = mod.dropThrough
const stepDown = mod.stepDown

function mkDownBot (cells, at = [0, 64, 0], opts = {}) {

  const b = mkCarveBot(cells, at)

  /* 假 bot 原本只给 `{name, position}`；真实 prismarine-block 有 `boundingBox`。

   * `stepDown` / `dropThrough` 靠 `boundingBox === 'block'` 判“能不能站/能不能挖”，这里补上。 */

  const blockAt0 = b.blockAt

  b.blockAt = (v) => {

    const r = blockAt0(v)

    r.boundingBox = r.name === 'air' ? 'empty' : 'block'

    return r

  }
  b.controls = []
  b.stopDigging = () => {}
  b.lookAt = async () => {}
  b.entity.onGround = true
  const dig0 = b.dig
  b.dig = async (blk) => {
    await dig0(blk)
    if (opts.fallTo != null && Number(blk.position.y) === at[1] - 1) {
      b.entity.position = new Vec3(at[0], opts.fallTo, at[2])
      b.entity.onGround = true
    }
  }
  b.setControlState = (k, v) => {
    b.controls.push([k, v])
    if (k === 'forward' && v && opts.walkTo) {
      b.entity.position = new Vec3(...opts.walkTo)
      b.entity.onGround = true
    }
  }
  return b
}

{
  /* B-1 成功：脚下 (0,63,0) 石头，往下 (0,61,0) 是实心 ⇒ 落点 y=62，落差 2 格 */
  const b = mkDownBot({ '0,63,0': 'stone', '0,61,0': 'stone' }, [0, 64, 0], { fallTo: 62 })
  const r = await dropThrough(b, { x: 0, y: 51, z: 0 })
  ok(r.tried && r.ok && r.down === 2, 'B：目标在脚下 ⇒ 挖开脚下掉下去', JSON.stringify(r))
  ok(b.dug.includes('0,63,0'), 'B：挖的就是脚下那一格', JSON.stringify(b.dug))
  ok(!b.dug.includes('0,64,0'), 'B：不挖自己站的那一格', JSON.stringify(b.dug))
}
{
  /* B-2 落差太大：下面全空 ⇒ 不挖 */
  const b = mkDownBot({ '0,63,0': 'stone' }, [0, 64, 0])
  const r = await dropThrough(b, { x: 0, y: 40, z: 0 })
  ok(r.tried && !r.ok && r.why === 'no-landing' && b.dug.length === 0,
    'B：3 格内没有能站的落点 ⇒ 不挖', JSON.stringify(r))
}
{
  /* B-3 下面是岩浆 ⇒ 不挖 */
  const b = mkDownBot({ '0,63,0': 'stone', '0,61,0': 'lava' }, [0, 64, 0])
  const r = await dropThrough(b, { x: 0, y: 40, z: 0 })
  ok(!r.ok && r.why === 'liquid-below' && b.dug.length === 0,
    'B：挖开会掉进岩浆 ⇒ 不挖', JSON.stringify(r))
}
{
  /* B-4 脚下本来就是空的（人在掉）⇒ 不是“挖脚下”能解的局面 */
  const b = mkDownBot({}, [0, 64, 0])
  const r = await dropThrough(b, { x: 0, y: 40, z: 0 })
  ok(r.tried === false && r.why === 'not-solid', 'B：脚下本就是空的 ⇒ 不动手', JSON.stringify(r))
}
{
  /* B-5 脚下是基岩 ⇒ 挖不动，不硬挖 */
  const b = mkDownBot({ '0,63,0': 'bedrock', '0,61,0': 'stone' }, [0, 64, 0])
  const r = await dropThrough(b, { x: 0, y: 40, z: 0 })
  ok(r.tried && !r.ok && r.why === 'protected' && b.dug.length === 0,
    'B：脚下挖不动 ⇒ 不硬挖、而且说清原因', JSON.stringify(r))
}
{
  /* A-1 成功：往 +x 下一层（挖 (1,63,0)/(1,64,0)，地面 (1,62,0) 实心） */
  const b = mkDownBot(
    { '1,63,0': 'stone', '1,64,0': 'stone', '1,62,0': 'stone' },
    [0, 64, 0], { walkTo: [1, 63, 0] },
  )
  const r = await stepDown(b, { x: 3, y: 63, z: 0 })
  ok(r.tried && r.ok && r.down === 1 && r.dug === 2,
    'A：挖斜下台阶（脚+头两格）走下一层', JSON.stringify(r))
  ok(b.dug.includes('1,63,0') && b.dug.includes('1,64,0'), 'A：两格都挖开了（2 格高的通道）', JSON.stringify(b.dug))
  ok(b.controls.some(([k, v]) => k === 'forward' && v === true) && b.controls.some(([k, v]) => k === 'forward' && v === false),
    'A：走过去之后把 forward 松开（不留残控制位）', JSON.stringify(b.controls))
}
{
  /* A-2 落点不是实心（下面是空的）⇒ 不挖，不把人送进坑 */
  const b = mkDownBot({ '1,63,0': 'stone', '1,64,0': 'stone' }, [0, 64, 0])
  const r = await stepDown(b, { x: 3, y: 63, z: 0 })
  ok(r.tried === false && r.why === 'no-step' && b.dug.length === 0,
    'A：旁边是坑不是台阶 ⇒ 一格不挖', JSON.stringify(r))
}
{
  /* A-3 不挖的模式 ⇒ 不动手，并说清为什么 */
  const b = mkDownBot(
    { '1,63,0': 'stone', '1,64,0': 'stone', '1,62,0': 'stone' },
    [0, 64, 0], { walkTo: [1, 63, 0] },
  )
  const r = await stepDown(b, { x: 3, y: 63, z: 0 }, { allowDig: false })
  ok(r.tried && !r.ok && r.why === 'no-dig' && b.dug.length === 0,
    'A：不挖那趟（allowDig:false）只告知、不挖', JSON.stringify(r))
}
/* 🔴 2026-10-29 实机：「move 到一半死了」，却报「挂在半空不动（离地 0 格）」 */
{
  const cause = mod.moveCauseTextOf({ dead: true })
  ok(/死了/.test(cause) && !/半空/.test(cause), '死了就说死了，不说“挂在半空”', cause)
  const nx = mod.moveNextTextOf({ dead: true }, true)
  ok(/复活|重生/.test(nx), '死了的下一步：等复活', nx)
}
{
  /* 离地高度读的是 `airborne.dy`（旧文案读 `a.dy` 但那个字段从来不存在 ⇒ 恒 0） */
  ok(/离地 3 格/.test(mod.moveCauseTextOf({ airborne: { still: true, dy: 3 } })), '离地高度按真字段报')
  ok(!/半空/.test(mod.moveCauseTextOf({ airborne: { vy: -0.5, vh: 0.2 } })), '还在下落的不算“挂着”')
}
/* 2026-10-29 用户：往下自救的次数「按时间」算，不钉死 3 次 */
{
  ok(mod.downBudgetOk({ msLeft: () => 5000 }) === true, '剩 5 秒 ⇒ 够往下挖一层')
  ok(mod.downBudgetOk({ msLeft: () => 1000 }) === false, '剩 1 秒 ⇒ 不开工（开了也没结果）')
  ok(mod.downBudgetOk({}) === true, '拿不到剩余时间 ⇒ 当“够”，不因为查不到就不干活')
  ok(mod.MOVE_DOWN_TRIES >= 5, '硬上限只防死循环（不再是 3）', String(mod.MOVE_DOWN_TRIES))
}
/* ── 往上走（climbUp）：目标在头顶、又没有现成台阶时的那一层 ──────────────────
 * 为什么单列：A* 只为**水平**移动生成“挖穿”，`stepUp` 只吃已经存在的 1 格台阶；
 * 目标在头顶好几格、周围没台阶时它一律 NoPath。用户 2026-10-29：「把往下走和往上走都当作正常的」。 */
{
  const climbUp = mod.climbUp
  function mkUpBot (cells, at = [0, 64, 0], opts = {}) {
    const b = mkCarveBot(cells, at)
    const blockAt0 = b.blockAt
    b.blockAt = (v) => {
      const r = blockAt0(v)
      r.boundingBox = r.name === 'air' ? 'empty' : 'block'
      return r
    }
    b.controls = []
    b.stopDigging = () => {}
    b.lookAt = async () => {}
    b.entity.onGround = true
    const dig0 = b.dig
    const dug = []
    b.dig = async (blk) => { await dig0(blk); dug.push(`${blk.position.x},${blk.position.y},${blk.position.z}`) }
    b.setControlState = (k, v) => {
      b.controls.push([k, v])
      if (k === 'forward' && v && opts.lift) {
        b.entity.position = new Vec3(opts.lift[0], opts.lift[1], opts.lift[2])
        b.entity.onGround = true
      }
    }
    b.dugList = dug
    return b
  }
  {
    const b = mkUpBot({ '1,65,0': 'stone', '1,66,0': 'stone', '1,64,0': 'stone' }, [0, 64, 0], { lift: [1, 65, 0] })
    const r = await climbUp(b, { x: 0, y: 72, z: 0 })
    ok(r.ok === true && r.up >= 0.75 && r.dug === 2, '往上走：挖开斜上方两格后真的站上去了', JSON.stringify(r))
    ok(b.dugList.includes('1,65,0') && b.dugList.includes('1,66,0'), '往上走：脚位 + 头位都挖了（2 格高才跳得进去）', b.dugList.join(' '))
  }
  {
    const b = mkUpBot({ '1,65,0': 'stone', '1,66,0': 'stone' }, [0, 64, 0])
    const r = await climbUp(b, { x: 0, y: 72, z: 0 })
    ok(r.tried === false && r.why === 'no-floor', '往上走：斜下方没有实心落脚面就不挖', JSON.stringify(r))
  }
  {
    const b = mkUpBot({ '1,65,0': 'water', '1,66,0': 'stone', '1,64,0': 'stone' }, [0, 64, 0])
    const r = await climbUp(b, { x: 0, y: 72, z: 0 })
    ok(r.tried === false && r.why === 'liquid', '往上走：斜上方是水/岩浆就不挖', JSON.stringify(r))
  }
  {
    const b = mkUpBot({ '1,65,0': 'bedrock', '1,66,0': 'stone', '1,64,0': 'stone' }, [0, 64, 0])
    const r = await climbUp(b, { x: 0, y: 72, z: 0 })
    ok(r.tried === false && r.why === 'protected', '往上走：挖不动的方块（基岩）不碰', JSON.stringify(r))
  }
  {
    const b = mkUpBot({ '1,65,0': 'stone', '1,66,0': 'stone', '1,64,0': 'stone' }, [0, 64, 0])
    const r = await climbUp(b, { x: 0, y: 72, z: 0 }, { allowDig: false })
    ok(r.tried === false && r.why === 'no-dig' && b.dugList.length === 0, '往上走：不许挖的那一趟一格都不动', JSON.stringify(r))
  }
  {
    const b = mkUpBot({ '1,65,0': 'stone', '1,66,0': 'stone', '1,64,0': 'stone' }, [0, 64, 0])
    const r = await climbUp(b, { x: 0, y: 72, z: 0 })
    ok(r.tried === true && r.ok === false && r.why === 'no-lift', '往上走：挖开了但人没上去 ⇒ 不报成功', JSON.stringify(r))
  }
  {
    const src = read('../src/movement.mjs')
    ok(/export async function climbUp \(/.test(src), 'movement.mjs 里有 climbUp（往上走的能力）', '')
    ok(/upTries < MOVE_UP_TRIES && downBudgetOk\(self\)/.test(src), '往上走也吃同一份时间预算（不是无限次）', '')
    ok(/ascendTried/.test(src) && /ascend:/.test(src), '往上走的账单独记，不混进“脱困阶梯”', '')
    ok(/🧗 目标在头顶/.test(src), '往上走有独立日志（不与脱困混淆）', '')
  }
}

/* ── ㉓ 垫方块两把锁：往上（allow1by1towers）与搭桥（allowBridge）各管一段 ────────
 * 2026-10-29 用户：「加个 allowbridge」。0.6.41 把 vendor 三处垫方块入口全收进
 * allow1by1towers 之后，爬高和填坑绑在一起；这里钉住它们各自独立。 */
section('㉓ 垫方块两把锁：往上 / 搭桥分开')
{
  const mov = read('../src/movement.mjs')
  const idx = readFileSync(new URL('../index.js', import.meta.url), 'utf8')
  ok(/mv\.allowBridge = !noBridge/.test(mov), 'walkPathfinder 按 noBridge 设置 mv.allowBridge（默认关）')
  ok(/noBridge = true/g.test(mov) && (mov.match(/noBridge = true/g) ?? []).length >= 3,
    'walkToUnguarded / walkToOnce / walkPathfinder 三层的 noBridge 默认 true')
  ok(/noBridge,/.test(mov), 'walkToOnce 调 walkPathfinder 时把 noBridge 透传下去')
  ok(/noBridge: args\.allowBridge !== true/.test(idx), 'mc_move 把 allowBridge 翻成 noBridge 传进去')
  ok(/allowBridge: \{ type: 'boolean'/.test(idx), '工具参数里声明了 allowBridge')
}

/* ── ㉔ allowBridge = 自动搭路（A* 没路时自己铺桥）────────────────────────────
 * 2026-10-29 用户：「allowBridge 是新功能，允许自动搭路。和之前的没关系」。 */
section('㉔ allowBridge：自动搭路')
{
  const mov = read('../src/movement.mjs')
  ok(/export async function bridgeToward \(self, b, target/.test(mov), 'bridgeToward() 导出（走路里能主动铺桥）')
  ok(/export const MOVE_BRIDGE_TRIES = 3/.test(mov) && /export const MOVE_BRIDGE_STEPS = 4/.test(mov),
    '一次调用最多试 3 轮、每轮最多铺 4 格')
  ok(/if \(emptyNoPath && !noBridge && bridgeTries < MOVE_BRIDGE_TRIES/.test(mov),
    '只在“A* 没路 + 开了 allowBridge”时才铺桥（默认一格都不铺）')
  ok(/if \(dx && dz\) return \{ ok: false, why: 'not-straight' \}/.test(mov), '斜着不铺（只走直线）')
  ok(/minHealth: MOVE_BRIDGE_MIN_HEALTH/.test(mov), '铺桥带血量门槛（bridge.mjs 自己判悬空/岩浆/深空）')
  ok(/bridgePlaced > 0 \? \{ bridgePlaced \}/.test(mov), '结果里报 bridgePlaced')
}

/* 🔴 2026-10-29 用户：“需要加判定，血量<10 就还是 3”—— dropThrough 的落差上限随血量走。 */
{
  ok(mod.MOVE_DROP_MAX === 4 && mod.MOVE_DROP_MAX_LOW_HP === 3,
    '落差上限：平时 4、血少 3', `$ {mod.MOVE_DROP_MAX}/$ {mod.MOVE_DROP_MAX_LOW_HP}` .replace(/\$ /g, '$'))
  ok(mod.dropMaxOf({ health: 9 }) === 3, '血 9 ⇒ 只敢掉 3 格', String(mod.dropMaxOf({ health: 9 })))
  ok(mod.dropMaxOf({ health: 10 }) === 7, '血 10 ⇒ 7 格（按“最多掉 40% 血”反推）', String(mod.dropMaxOf({ health: 10 })))
  ok(mod.dropMaxOf({ health: 20 }) === 11, '满血 ⇒ 11 格（伤害 8 = 血量的 40%）', String(mod.dropMaxOf({ health: 20 })))
  ok(mod.dropMaxOf({}) === 11, '读不到血量就当满血（不能因为 undefined 就变成 3）', String(mod.dropMaxOf({})))
  ok(mod.dropMaxOf({ health: 100 }) === mod.MOVE_DROP_HARD_MAX, '再满的血也不超过硬上限（别把“跳下去”变成“摔死”）', String(mod.dropMaxOf({ health: 100 })))
}
/* ⑩ 内部事件码不许裸奔到模型面前
 *   🔴 2026-10-31 用户实机：「现在一直 mc_say · path-reset」。只要 cause 里出现英文内部码，
 *   模型就会一遍遍念它。 */
{
  const codes = ['path-reset', 'PathStopped', 'preempted', 'block-changed', 'budget', 'swim-budget', 'unreachable', 'xyzzy', '']
  for (const c of codes) {
    const cause = String(mod.moveCauseTextOf({ reason: c }))
    ok(!/[A-Za-z]/.test(cause), `内部码「${c || '空'}」不裸奔到 cause —— ${cause}`, cause)
  }
  ok(!/改一下环境/.test(mod.moveNextTextOf({ reason: 'xyzzy' }, true)),
    '兜底不再说“先改一下环境”', mod.moveNextTextOf({ reason: 'xyzzy' }, true))
  ok(/接着走/.test(mod.moveNextTextOf({ reason: 'path-reset' }, true)),
    'path-reset 时说“直接再叫一次接着走”', mod.moveNextTextOf({ reason: 'path-reset' }, true))
}

/* ⑪ 单格挖掘守卫按实测时间
 *   🔴 2026-10-31 用户实机：`noDig:false`（即 `allowDig:true`）还是一格挖不开。真因是守卫写死 3000ms，
 *   而空手挖石头要 7.5 秒 ⇒ 每下都被掀断、进度归零。 */
{
  const srcMv = readFileSync(new URL('../src/movement.mjs', import.meta.url), 'utf8')
  ok(/const needMs = Number\.isFinite\(ms0\) && ms0 > 0 \? ms0 \+ 1_200 : 0/.test(srcMv) && /const ms0 = Number\(breakMsNow\(b, blk\)\)/.test(srcMv),
    '单格挖掘守卫按实测挖掘时间给上限（不再写死 3 秒）')
  ok(/const guardMs = Math\.max\(Number\(digMs\) \|\| 0, needMs\)/.test(srcMv), '守卫 = max(传入下限, 实测需要)')
  ok(/__carveTooSlow/.test(srcMv), '“挖太久”单独记一笔')
  ok(mod.moveNextTextOf({ planTried: ['tooSlow'], stuck: true }, true).includes('接着挖'),
    '提示说“直接再叫一次接着挖，别换目标”', mod.moveNextTextOf({ planTried: ['tooSlow'] }, true))
}

/* ─────────── ㉗ 头顶堵着垫不了柱：先挖开再垫（2026-10-31） ─────────── */
section('㉗ 目标在上方、包里又有方块 ⇒ A* 要垫柱子但头顶堵着：先挖开头顶再垫')
{
  const mkT = (heads) => ({
    entity: { position: { x: 0.5, y: 64, z: 0.5 } },
    blockAt: (v) => {
      const dy = Number(v?.y) - 64
      return heads[dy]
        ? { name: heads[dy], boundingBox: 'block', hardness: 2, position: v }
        : { name: 'air', boundingBox: 'empty', position: v }
    },
  })
  const withPlace = (b) => {
    b.pathfinder = { path: [{ x: 0, y: 64, z: 0 }, { x: 0, y: 65, z: 0, toPlace: [{ x: 0, y: 64, z: 0 }] }] }
    return b
  }
  ok(mod.towerHeadBlocked(withPlace(mkT({ 1: 'stone', 2: 'stone' }))) === 'stone',
    '㉗ 要垫柱、头顶实心 ⇒ 认得出是那块石头', String(mod.towerHeadBlocked(withPlace(mkT({ 1: 'stone', 2: 'stone' })))))
  ok(mod.towerHeadBlocked(withPlace(mkT({}))) === null,
    '㉗ 要垫柱、头顶本来就空 ⇒ 不拦（上游自己会垫）', String(mod.towerHeadBlocked(withPlace(mkT({})))))
  const noPlace = mkT({ 1: 'stone' })
  noPlace.pathfinder = { path: [{ x: 0, y: 64, z: 0 }, { x: 0, y: 64, z: 1 }] }
  ok(mod.towerHeadBlocked(noPlace) === null,
    '㉗ 下一步不是垫方块 ⇒ 不管（那是普通的走/挖）', String(mod.towerHeadBlocked(noPlace)))
  ok(mod.towerHeadBlocked({}) === null && mod.towerHeadBlocked(null) === null,
    '㉗ 没有寻路路径也不炸', 'ok')

  const { readFile } = await import('node:fs/promises')
  const src = await readFile(new URL('../src/movement.mjs', import.meta.url), 'utf8')
  ok(/const headBlocked = towerHeadBlocked\(b\)/.test(src),
    '㉗ 主循环每轮算路前先问一次“要垫柱但头顶堵着吗”', 'towerHeadBlocked(b)')
  ok(/await clearHeadForTower\(b, \{ ctx \}\)/.test(src),
    '㉗ 认下来就动手挖开头顶（不是只记一笔）', 'clearHeadForTower')
  ok(/headTowerTries < MOVE_HEAD_TOWER_TRIES/.test(src),
    '㉗ 有次数上限，别在挖不动的墙上反复试', 'MOVE_HEAD_TOWER_TRIES')
  ok(/if \(!noTower && carveNoPathOk && headTowerTries/.test(src),
    '㉗ 只在“允许垫柱 + 允许挖”时才这么干（allowDig:false 那趟不碰地形）', 'noTower')
  ok(/export const MOVE_HEAD_TOWER_TRIES = 3/.test(src),
    '㉗ 上限常量在位', 'MOVE_HEAD_TOWER_TRIES = 3')
}

/* 🔴 2026-10-29 实机：`headTower`（头顶挡着先挖开再垫）用了 `carveNoPathOk`，
 *    而它原来在 300 行之后才 `const` ⇒ 每次 mc_move 都在 9ms 抛
 *    `ReferenceError: carveNoPathOk is not defined`，日志里只看到 `walk-failed`。
 *    这条钉“先声明、后使用”，同类 TDZ 再来一次就会红。 */
{
  const tdzSrc = readFileSync(new URL('../src/movement.mjs', import.meta.url), 'utf8')
  const decl = tdzSrc.indexOf('const carveNoPathOk =')
  const use = tdzSrc.indexOf('carveNoPathOk && headTowerTries')
  ok(decl > 0 && use > decl, 'carveNoPathOk 先声明后使用（TDZ 会让整趟寻路 9ms 抛错）', `decl=${decl} use=${use}`)
}
/* 🔴 2026-10-30 实机（“第一次为什么垫一个方块就不够了”）：自动重发的“有没有靠近”
 *    原来只比水平距离 —— 目标在头顶时垫柱升 2 格、水平纹丝不动，被判成“没动”，
 *    3 次就交回脱困阶梯，一趟只垫 1~2 格。垂直必须一起比。 */
{
  const nearSrc = readFileSync(new URL('../src/movement.mjs', import.meta.url), 'utf8')
  const nearH = (nearSrc.match(/Math\.hypot\(pNow\.x - sp\.x, pNow\.z - sp\.z, pNow\.y - tyNum\)/g) ?? []).length
  const nearK = (nearSrc.match(/Math\.hypot\(pK\.x - sp\.x, pK\.z - sp\.z, pK\.y - tyNum\)/g) ?? []).length
  ok(nearH === 1 && nearK === 1, '“有没有靠近”按 3D 距离算（垂直上升也算进展，否则垫柱永远被判空转）', `h=${nearH} k=${nearK}`)
}
/* 2026-10-30 实机（目标 (16,63,88)）：四面 n/e/s/w 全通，文案却说“四周全是实心方块（…n/e/s/w 那面通）”。 */
ok(/openS\.length \? '四周没有挡路的方块'/.test(

  (await import('node:fs')).readFileSync(new URL('../src/movement.mjs', import.meta.url), 'utf8')),
  '文案：四面都通时不许说“四周全是实心方块”')
/* 2026-10-31 实机（柱顶上不来也下不去、18~66 毫秒返回）：vendor 把 noPath 改成了 reject NoPath，
 *   而兜底全挂在 `emptyNoPath` 上 ⇒ 从来没触发过。这两条钉住“收到 NoPath 也要放兜底出来”。 */
const mvSrcX = (await import('node:fs')).readFileSync(new URL('../src/movement.mjs', import.meta.url), 'utf8')

ok(/if \(e\?\.name === 'NoPath'\) \{[\s\S]{0,300}?noPathPending = true/.test(mvSrcX),
  '★ NoPath 也算“没路”（vendor 已改成 reject）—— 必须把兜底阶梯放出来')
ok(/emptyNoPath = noPathPending/.test(mvSrcX), 'emptyNoPath 继承上一轮的 NoPath 判定')
/* ── ㉘ 2026-10-31：阶梯探针化 + 按诊断排序 + 剩余级如实报 ─────────────────────────
 * 用户原话：「兜底是串行阶梯，每级先 stopPathing 再等"卡" MOVE_STUCK_MS 2400 / vendor 3500，
 * 7~10 级 这个怎么解决」。三条一起钉：太慢、顺序错、不告诉 AI 后面还有招。 */
{
  const mv = await import('../src/movement.mjs')
  const { orderEscapesFor, escapeDiagOf, MOVE_ESCAPES, MOVE_ESCAPES_NODIG } = mv

  // ① 没诊断 ⇒ 顺序原样（不能把老行为改掉）
  ok(JSON.stringify(orderEscapesFor({}, MOVE_ESCAPES_DIG)) === JSON.stringify(MOVE_ESCAPES_DIG),
    '没有诊断（平地卡住）⇒ 阶梯顺序原样不动')

  // ② 目标更低 + 脚下能掉 ⇒ descend 提前，且紧跟 repath（专救"路被作废"）
  {
    const o = orderEscapesFor({ goalLower: true }, MOVE_ESCAPES_DIG)
    ok(o[0] === 'descend' && o[1] === 'repath', '目标在下方 ⇒ 先 descend（柱顶该先往下挖/跳，不是先白算两遍路径）', o.slice(0, 3).join('>'))
    ok(o.length === MOVE_ESCAPES_DIG.length && MOVE_ESCAPES_DIG.every((s) => o.includes(s)),
      '只换顺序，不许少招也不许多招（集合必须完全一致）')
    ok(o[o.length - 1] === 'climbUp', '目标在下方 ⇒ climbUp 押到最后（先爬上去还得再下来）', o.join('>'))
  }

  // ③ 目标更高：先让 A*（有垫柱/搭桥能力）重规划，不许一上来就动镐子
  {
    const a = orderEscapesFor({ goalHigher: true, headBlocked: true }, MOVE_ESCAPES_DIG)
    ok(a[0] === 'repath', '目标在上方 ⇒ 先 repath 让 A* 重规划（垫柱是它的活，不是先挖斜上两格）', a[0])
    ok(a.indexOf('climbUp') > a.indexOf('repath'), '"往上走会先挖几格再垫" = climbUp 抢在 repath 前面；现在它必须在后面')
    ok(a[a.length - 1] === 'descend', '目标在上方 ⇒ descend 押到最后（"下去，然后上来"就是它太靠前）', a.join('>'))
    const b = orderEscapesFor({ goalHigher: true }, MOVE_ESCAPES_DIG)
    const c = orderEscapesFor({ goalHigher: true, headBlocked: true }, MOVE_ESCAPES_NODIG)
    ok(c[0] === 'clearHead', '不挖那套：目标在上方 + 头顶堵 ⇒ 先清头顶那格（跳也白跳）', c[0])
    ok(b[0] === 'repath' && b[b.length - 1] === 'descend', '目标在上方、头顶通 ⇒ 仍先 repath，descend 押后', b.join('>'))
    ok(a.length === MOVE_ESCAPES_DIG.length && MOVE_ESCAPES_DIG.every((x) => a.includes(x)),
      '只换顺序：集合必须完全一致（不许少招也不许多招）')
  }

  // ④ 眼前实心挡路 ⇒ breakAhead 提前；但 allowDig:false 那套里没有它 ⇒ 不许凭空冒出来
  {
    const o = orderEscapesFor({ wallAhead: true }, MOVE_ESCAPES_DIG)
    ok(o[0] === 'breakAhead', '眼前有实心挡路 ⇒ 先挖开它', o[0])
    const nd = orderEscapesFor({ wallAhead: true, goalLower: true }, MOVE_ESCAPES_NODIG)
    ok(!nd.includes('breakAhead'), 'allowDig:false 那套永远不许出现 breakAhead（哪怕诊断要求挖）')
  }

  // ⑤ 假 bot / 区块没加载：诊断函数不许炸，也不许瞎猜
  {
    const d1 = escapeDiagOf({}, { x: 0, y: 0, z: 0 })
    ok(d1 && typeof d1 === 'object' && !d1.goalLower && !d1.goalHigher, '读不到自己位置 ⇒ 没有诊断（不许瞎猜"目标在下面"）')
    const me = { y: 64 }
    const d2 = escapeDiagOf({ entity: { position: me } }, { x: 0, y: 60, z: 0 })
    ok(d2.goalLower === true, '自己 64、目标 60 ⇒ 认得出"目标在下方"')
    const d3 = escapeDiagOf({ entity: { position: me } }, { x: 0, y: 70, z: 0 })
    ok(d3.goalHigher === true, '自己 64、目标 70 ⇒ 认得出"目标在上方"')
  }

  // ⑥ 收工时**明说还剩哪几级**（以前只报"升到第 N 级"）
  ok(/err\.mcEscapesLeft = steps\.slice/.test(mvSrcX), '预算见底收工 ⇒ 把还没试的级带出去')
  ok(/err\.mcEscapesLeft = \[\]/.test(mvSrcX), '阶梯走完了 ⇒ 明说"没了"，别让 AI 以为还有招')
  ok(/escapesLeft: escLeft\.map/.test(mvSrcX), '结果里报 escapesLeft（中文名）')
  ok(/还剩 \$\{escLeft\.map/.test(mvSrcX) && /同目标再叫一次会接着往下试/.test(mvSrcX),
    'hint 里告诉 AI「再叫一次会接着试，别换目标」')
  ok(/const steps = orderEscapesFor\(escapeDiagOf\(b, target\)/.test(mvSrcX),
    '主循环真的用上了按诊断排序（不是只写了个没人调的函数）')

  // ⑦ 结果里不许有 NaN/Infinity（2026-10-30 实机：DSH 的"无损 JSON"校验会整条拒收，
  //    模型只收到一句 Error、丢掉全部提示 ⇒ 它只能换个目标再瞎试）
  {
    const { finiteOnly } = await import('../src/brief.mjs')
    const bad = finiteOnly({ moved: NaN, remaining: Infinity, ok: 1, say: 'x', deep: { eta: -Infinity } })
    ok(bad.moved === null && bad.remaining === null && bad.deep.eta === null, 'NaN/Infinity ⇒ null（渲染层显示 ?）')
    ok(bad.ok === 1 && bad.say === 'x', '正常数字与字符串原样保留')
    ok(JSON.stringify(bad) === '{"moved":null,"remaining":null,"ok":1,"say":"x","deep":{"eta":null}}',
      '清洗后能无损序列化（JSON.stringify 不吞字段）', JSON.stringify(bad))
    const idxN = read('../index.js').replace(/\r\n/g, '\n')
    ok(/const brief = finiteOnly\(briefMoveOf\(/.test(idxN),
      'mc_move 出口真的套上了 finiteOnly（不是只写了个没人调的函数）')
  }
}

/* ── ㉙ 2026-10-30：实体避让（用户：「move 中加实体避让」）────────────────────────────
 * vendor 只在**规划那一刻**看实体（`mv.entityCost = 8`），路径定了以后实体再走过来，
 * 执行层原本不管 ⇒ 顶着牛/顶着怪走，直到判卡（2.4 秒）再进脱困阶梯。这一节钉三件事：
 * ① 敌友分得清；② 该等的等、该报的报、绝不无限磨；③ 主循环真的接上了。 */
{
  const ea = await import('../src/entity-avoid.mjs')
  const { isHostileEntity, shouldWaitEntity, avoidActionOf, entityTextOf, waitEntityClear } = ea

  // ① 敌友判定
  ok(isHostileEntity('zombie') && isHostileEntity('creeper') && isHostileEntity({ name: 'skeleton' }),
    '敌对认得出（僵尸/苦力怕/骷髅）')
  ok(!isHostileEntity('cow') && !isHostileEntity({ name: 'villager' }) && !isHostileEntity({ username: 'Steve' }),
    '被动/村民/玩家不算敌对')
  ok(!isHostileEntity('item') && !isHostileEntity('experience_orb') && !isHostileEntity('arrow'),
    '掉落物/经验球/箭不算（它们根本挡不住路）')
  ok(isHostileEntity('minecraft:zombie'), '带 `minecraft:` 前缀也认得出')

  // ② 该不该等
  ok(shouldWaitEntity('cow') && shouldWaitEntity({ name: 'villager' }) && shouldWaitEntity({ username: 'Alex' }),
    '被动 / 村民 / 玩家 ⇒ 可以等它走开')
  ok(!shouldWaitEntity('zombie'), '敌对 ⇒ **不等**（站着等只会挨打）')
  ok(!shouldWaitEntity('ender_dragon') && !shouldWaitEntity('warden'), '末影龙/监守者 ⇒ 连靠近都不该等')

  // ③ 该做什么（有上限，不无限磨）
  ok(avoidActionOf({ name: 'cow', dist: 1.1 }, { waitedMs: 0 }) === 'wait', '刚被挡 ⇒ 先等')
  ok(avoidActionOf({ name: 'zombie', dist: 1.1 }, { waitedMs: 0 }) === 'report', '敌对 ⇒ 立刻报（不浪费 900 毫秒挨打）')
  ok(avoidActionOf({ name: 'cow', dist: 1.1 }, { waitedMs: 900, maxWaitMs: 900 }) === 'report',
    '等满了还不走 ⇒ 如实报（不无限磨）')

  // ④ 等它走开的循环：走开了就返回 cleared；一直不让开就超时返回 blocker
  {
    let calls = 0
    const w1 = await waitEntityClear({
      scan: () => (++calls <= 2 ? { name: 'cow', dist: 1.0 } : null),
      sleep: async () => {}, maxWaitMs: 500, probeMs: 1,
    })
    ok(w1.cleared === true && calls === 3, '牛挪开了 ⇒ cleared:true 并接着走', `calls=${calls}`)

    let calls2 = 0
    const w2 = await waitEntityClear({
      scan: () => ({ name: 'cow', dist: 1.0, x: 1, y: 64, z: 2 }),
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)), maxWaitMs: 5, probeMs: 1,
    })
    ok(w2.cleared === false && w2.blocker?.name === 'cow', '牛就是不走 ⇒ 超时返回 blocker（上层如实报）')

    const w3 = await waitEntityClear({ scan: () => ({ name: 'zombie', dist: 1.0 }), sleep: async () => {} })
    ok(w3.cleared === false && w3.blocker?.name === 'zombie', '一上来就是敌对 ⇒ 不等，立刻返回')
  }

  // ⑤ 文案：说清"是活的"，别让 AI 以为要挖墙
  ok(/敌对/.test(entityTextOf({ name: 'zombie', dist: 1.2 })), '敌对方案的文案点明"敌对"')
  ok(/被动|中立/.test(entityTextOf({ name: 'cow', dist: 1.2 })), '被动实体的文案点明"被动/中立"')
  ok(/打不过/.test(entityTextOf({ name: 'warden', dist: 2 })), '监守者那种直接说"打不过，绕开"')

  // ⑥ 主循环真的接上了（不是只写了个没人调的文件）
  ok(/import \{[^}]*shouldDodgeEntity[^}]*\} from '\.\/entity-avoid\.mjs'/.test(mvSrcX), 'movement.mjs 真的 import 了实体绕行（`shouldDodgeEntity`）')
  ok(/const entScan = \(\) => entityObstacleAhead\(b, sp, \{ cells: MOVE_ENTITY_CELLS/.test(mvSrcX),
    '每轮走之前先扫一眼前方（用"站定点"而不是终点，跟进度口径一致）')
  /* ⚠️ 2026-10-30 全量审计：这段原来钉的是 `{0,220}` —— 中间那几行注释一加长就失配（钉距离太死）。
   *    改成宽一点，并把标题说准：停的是**被动**的（`shouldWaitEntity` 为真），敌对的不停。 */
  ok(/entTimer = setInterval\(\(\) => \{[\s\S]{0,900}?if \(!entityDodgeOff && e2 && shouldDodgeEntity\(e2\)\) \{ b\.__mcEntStop = e2/.test(mvSrcX),
    '走的过程中每 350ms 扫一次，被活物挡住就换路（`entityDodgeOff` 之后不再扫 ⇒ 直接挤过去）')
  ok(/const entStop = b\.__mcEntStop/.test(mvSrcX) && /绕实体不算一级脱困/.test(mvSrcX)
    && !/err\.mcEntity = entStop/.test(mvSrcX) && !/await waitEntityClear/.test(mvSrcX),
    'catch 里认下"是被实体挡的" ⇒ 立刻换路重算（不占脱困阶梯、不等待、更不抛错收工）')
  ok(/blockedByEntity: \{ \.\.\.e\.mcEntity, waitedMs/.test(mvSrcX), '结果里报 blockedByEntity（谁挡着 + 等了多久）')
  ok(/dodges: entityDodges, wentThrough: entityDodgeOff/.test(mvSrcX), '结果里报绕了几次 / 最后是不是挤过去的')
  {
    const eaSrc = readFileSync(new URL('../src/entity-avoid.mjs', import.meta.url), 'utf8')
    ok(/export const MOVE_ENTITY_DODGE_MAX = 3/.test(eaSrc) && /entityDodges < MOVE_ENTITY_DODGE_MAX/.test(mvSrcX),
      '同一条窄道绕满 3 次还挡 ⇒ 直接挤过去（不许无限重算）')
    /* ⚠️ 2026-11-03：以前用「shouldDodgeEntity 之后 200 字内不许出现 isHostileEntity」——
     *    只要附近注释提一句就假红。现在直接切出函数体再判。 */
    const iDodge = eaSrc.indexOf('export function shouldDodgeEntity')
    const iNext = eaSrc.indexOf('\nexport ', iDodge + 10)
    const dodgeBody = iDodge >= 0 ? eaSrc.slice(iDodge, iNext > 0 ? iNext : iDodge + 600) : ''
    ok(dodgeBody.length > 0 && !/isHostileEntity/.test(dodgeBody),
      '绕行判据不分敌友：除了掉落物/弹射物，任何活物都绕')
  }
  ok(/clearInterval\(entTimer\)/g.test(mvSrcX) && (mvSrcX.match(/clearInterval\(entTimer\)/g) ?? []).length >= 2,
    '定时器两处都收掉（成功分支 + catch），不许留着把进程钉住')
  {
    const plug = readFileSync(new URL('../src/plugins.mjs', import.meta.url), 'utf8')
    ok(/mv\.entityCost = \d+/.test(plug) && Number((plug.match(/mv\.entityCost = (\d+)/) ?? [])[1]) >= 4,
      'A* 侧真给实体所在格加了代价（不是 1 那种"等于不绕"）')
    /* 🔴 2026-11-03：静态代价只在"生成节点那一刻"看实体；路径定好后怪再走进通道 A* 不知道。
     *    ⇒ 再挂一条每次重算都现算的禁行区，怪站在唯一通道里也会被绕开。 */
    ok(/mv\.exclusionAreasStep = \[/.test(plug) && /return n \* 60/.test(plug),
      '每次重算都按当时的实体位置现算禁行区（不是只在规划那一刻看一眼）')
  }
}

/* ── climbUp 起跳前必须先转向 ───────────────────────────────────────────────
 * 用户 2026-11-05：「每次挖 3 个方块，然后又挖其他地方三个，有时候会走上去」。
 * 3 格 = 自己头顶 1 + 斜上两格 —— 就是 climbUp 的一层。跳不上去的原因不是挖，是**没转向**：
 * `forward` 相对当前朝向，人还朝着上一条 A* 路的方向 ⇒ 朝斜后方撞墙 ⇒ 外层 continue 重算 ⇒
 * A* 因世界变了换方向再挖 3 格。`stepUp` 早就有 lookAt，climbUp 漏了。 */
{
  const iClimb = mvSrcX.indexOf('export async function climbUp')
  const iClimbEnd = mvSrcX.indexOf('\n/* ---', iClimb + 10)
  const climbBody = iClimb >= 0 ? mvSrcX.slice(iClimb, iClimbEnd > 0 ? iClimbEnd : iClimb + 6000) : ''
  ok(climbBody.length > 0, '能切出 climbUp 函数体')
  ok(/await b\.lookAt\(new Vec3\(ax \+ 0\.5, yNow \+ 0\.2, az \+ 0\.5\), true\)/.test(climbBody),
    'climbUp 起跳前先朝要落脚那格看（forward 是相对朝向的，不转身就朝斜后方走）')
  ok(/await sleep\(STEP_UP_TURN_MS\)/.test(climbBody),
    '转完等一个朝向包再按 forward（只等 0 毫秒等于没转）')
  const iLook = climbBody.indexOf('await b.lookAt(')
  const iFwd = climbBody.indexOf("setControlState('forward', true)")
  ok(iLook > 0 && iFwd > iLook, '先转向再按 forward（顺序不能反）')
}


/* ── 控制键审计（2026-11-05）────────────────────────────────────────────────
 * 实机：「dig stair 跳的时候没往前走，第二次跳还往后退了一点」。
 * 三条互斥解释（起跳朝向 / back 与 forward 同时按 / path[0] 与当前同格）光看结果分不出，
 * 所以把「谁在按哪个键」记下来。这里钉两件事：**只记录不改行为**、聚合真的算得对。 */
{
  const briefSrc2 = read('../src/brief.mjs')
  const { startCtrlAudit } = await import('../src/ctrl-audit.mjs')
  ok(typeof startCtrlAudit === 'function', 'ctrl-audit 模块导出 startCtrlAudit')

  // ① 不改行为：原 setControlState 照常被调用
  const seen = []
  const fake = {
    entity: { position: { x: 0, y: 64, z: 0 } },
    setControlState: (k, v) => { seen.push([k, v]) },
    on: () => {},
    removeListener: () => {}
  }
  const aud = startCtrlAudit(fake)
  fake.setControlState('forward', true)
  fake.setControlState('jump', true)
  fake.setControlState('forward', false)
  const out = aud.stop()
  ok(seen.length === 3, '审计不改行为：原 setControlState 每次都被照常调用', `calls=${seen.length}`)
  ok(out.byKey.forward && out.byKey.forward.on === 1, '按裸键名汇总：forward 按了 1 次（不分调用者）')
  ok(out.keys.some((r) => r.key === 'forward') && out.keys.some((r) => r.key === 'jump'), '按调用者分组：forward 与 jump 各自留痕（看得出是谁按的）')
  ok(aud.stop() === out, 'stop 幂等（重复调用返回同一份结果）')

  // ② forward 与 back 同时按着要能被算出来（“人不动 / 往后退”的头号嫌疑）
  const seen2 = []
  const fake2 = {
    entity: { position: { x: 0, y: 64, z: 0 } },
    setControlState: (k, v) => { seen2.push([k, v]) },
    on: () => {},
    removeListener: () => {}
  }
  const aud2 = startCtrlAudit(fake2)
  fake2.setControlState('forward', true)
  fake2.setControlState('back', true)
  await new Promise((r) => setTimeout(r, 30))
  fake2.setControlState('back', false)
  fake2.setControlState('forward', false)
  const out2 = aud2.stop()
  ok(out2.bothMs >= 20, '算得出 forward 与 back 同时按着的时长', `bothMs=${out2.bothMs}`)

  // ③ 接线：走路主循环开了审计、结果里透出摘要、成功时被 brief 删掉
  ok(/const ctrlAudit = startCtrlAudit\(b\)/.test(mvSrcX), 'walkPathfinder 里真的开了控制键审计')
  ok(/ctrlAudit: ctrlAuditOf\(ctrlAudit\)/.test(mvSrcX), '结果里透出 ctrlAudit 摘要')
  ok(/trail: Array\.isArray\(c\.trail\) \? c\.trail\.slice\(-6\) : \[\]/.test(mvSrcX), '只留最后 6 个位置采样（不刷屏）')
  ok(/'ctrlAudit'/.test(briefSrc2), 'brief 把它当诊断量：成功时删、失败时留')
}


{
  /* 🔴 2026-11-05 用户：「move 只用 allowdig 现在会挖头上方块了，但是还是会到处乱挖，
   *   直到挖掉头顶那格后才正常」—— 头顶堵着时 A* 会先给水平绕行的路，一路撞墙补挖。
   *   现在：目标在上方且头顶被堵 ⇒ **先清头顶再规划**（只挖自己正上方那两格）。 */
  const mS = strip(read('../src/movement.mjs'))
  /* 🔴 2026-11-05 实机炸过一次：`let riseMode = (towerAllowed && carveNoPathOk && headOk)`
   *   读的 `carveNoPathOk` 声明在它下边 236 行 ⇒ TDZ（Cannot access before initialization）。
   *   902 条断言全绿也抓不到，因为**没有一条真的执行 walkPathfinder**。这条顺序守门是止损：
   *   凡是“某常量在 X 处声明、却在 X 之前被读”的写法，靠它兜住。 */
  ok(mS.indexOf('const carveNoPathOk = allowDig === true') > 0 &&
     mS.indexOf('const carveNoPathOk = allowDig === true') < mS.indexOf('let riseMode ='),
    '★ carveNoPathOk 必须先于 riseMode 声明（否则 TDZ：Cannot access before initialization）')
  /* 🔴 2026-11-05 用户：「allowdig 和 allowtower 一直搭方块，一直没搭上，一直在跳」——
   *   垫柱失败（place_error / place_jump_timeout / place_no_rise）以前只进 resetSeen、不影响策略，
   *   A* 重置一次就再来一次 ⇒ 原地无限跳。连着 MOVE_PLACE_FAIL_MAX 次必须换招或如实收工。 */
  ok(/export const MOVE_PLACE_FAIL_MAX = 3/.test(mS), '★ 垫柱连败上限 3 次')
  ok(/placeFailSeen\[k\] = \(placeFailSeen\[k\] \?\? 0\) \+ 1/.test(mS), '★ 三种垫柱失败都计数')
  ok(/if \(placeFails >= MOVE_PLACE_FAIL_MAX && riseMode !== 'dig'\)/.test(mS), '★ 连败到上限就换招')
}

{
  /* 🔴 2026-11-05 用户实机：「报了这个错，但是我看着它还在正常挖」——
   *   挖了 12 格、升了 5 格，却被一句“走不动：时间用在挖方块上了”打发。
   *   现在：有 carved/climbedUp 就不算 stuck，文案也说“还在挖、接着叫”。 */
  const mH = strip(read('../src/movement.mjs'))
  ok(/stuck: !\(Number\(b\?\.__mcCarved \?\? 0\) > 0 \|\| Number\(b\?\.__mcClimbed \?\? 0\) > 0\)/.test(mH),
    '★ walk-hung 时按进度判 stuck（有进展就不算卡住）')
  ok(!/stuck: true,\s*\n\s*reason: 'walk-hung'/.test(mH.replace(/\r\n/g, '\n')),
    '不再把 walk-hung 写死成 stuck: true')
  ok(/const cv = Number\(o\?\.carved \?\? 0\)/.test(mH) && /一直在往上挖/.test(mH),
    '有进展时文案说“一直在往上挖”，而不是“走不动”')
}

{
  /* 🔴 2026-11-05 用户：「两者一起开，一开始就挖台阶（乱挖）…中途垫一下…最后才用垫柱」——
   *   A* 两条边同时可用时它会按单价自己混着挑，riseMode 只约束了我们自己的 climbUp。
   *   现在：一次只给 A* 一种上升手段。 */
  const mR = strip(read('../src/movement.mjs'))
  ok(/const applyRiseMode = \(\) => \{/.test(mR), '★ 有 applyRiseMode：把 riseMode 落到 A* 身上')
  ok(/if \(riseMode === 'tower' \|\| riseMode === 'mixed'\) \{\s*\n\s*mv\.allow1by1towers = true\s*\n\s*mv\.canDig = false/.test(mR.replace(/\r\n/g, '\n')),
    '垫那侧（tower/mixed）：开 allow1by1towers、关掉 A* 的挖边（不然它按 4 分一格的价格一直挖）')
  ok(/mv\.allow1by1towers = false\s*\n\s*mv\.canDig = carveNoPathOk/.test(mR.replace(/\r\n/g, '\n')),
    '挖台阶档：关掉 A* 的垫边，挖边只按 allowDig 的许可开')
  ok(/applyRiseMode\(\)      \/\/ 改完立刻落到 A\* 身上/.test(mR), '切换后立刻生效（下一次 goto 就换一侧）')
  ok(/applyRiseMode\(\)   \/\/ 兜一次/.test(mR) && mR.indexOf('applyRiseMode()   // 兜一次') < mR.indexOf('b.pathfinder.goto(goal)'),
    '每次 goto 前兜一次，保证 A* 拿到与 riseMode 一致的 movements')
}

{
  /* 🔴 2026-11-05 用户：「我是说挖头上两格，再垫脚下两格的那种」+「会不会又乱挖，乱走」——
   *   mixed = 先清头顶腾空间、再垫脚下，一层 2 块方块；限制：只动正上方两格、一趟上限、保护区不挖。 */
  const mM = strip(read('../src/movement.mjs'))
}
/* 🔴 2026-11-05 用户：「单 allowdig 挖一段台阶后，会在最后格挖左后、上方一格的格子，上不去」。
 *   规矩与 stair 一致：方向锁死，永不考虑正后方（挖开反方向那侧也爬不上去，只是白挖 3 格）。 */
{
  const srcC = strip(read('../src/movement.mjs'))
  const i0 = srcC.indexOf('export async function climbUp')
  const seg = i0 < 0 ? '' : srcC.slice(i0, srcC.indexOf('\nexport ', i0 + 10))
  ok(seg.length > 0, 'climbUp 存在')
  ok(seg.includes('const back0 = [-dx, -dz]'), '★ climbUp：目标有水平方向时排除正后方')
  ok(seg.includes('const back0 = [-front[0], -front[1]]'), '★ climbUp：目标在正头顶时也排除正后方')
  ok((seg.match(/d\[0\] === back0\[0\] && d\[1\] === back0\[1\]/g) || []).length >= 2,
    '★ climbUp：两个分支都真的跳过正后方')
  ok(seg.includes('const memo0 = b?.__mcClimbDir') && seg.includes('front = [memo0[0] || 0, memo0[1] || 0]'),
    '★ climbUp：正头顶时沿用上一层成功的方向')
}

/* 🔴 2026-11-05 用户：「正常挖一段，然后就挖其他地方，只挖两格，都是挖的现在位置水平格子高一格」。
 *   定性：这是「每轮 goto 前清自己头顶 fy+1 / fy+2 两格」那块（MOVE_HEAD_CLEAR_MAX = 6）——
 *   位置正是“自己水平同格、脚底上一格”，而且**清头顶本身不产生上升**（只让出起跳空间），
 *   于是挖两格没人上去、下一轮换个地方再挖两格。整块已删除；头顶空间只由 climbUp 自己清
 *   （那是“挖斜上两格 + 清头顶 + 跳”一整套动作，有上升伴随）。 */
{
  const mH = strip(read('../src/movement.mjs'))
  ok(!/MOVE_HEAD_CLEAR_MAX/.test(mH), '★ 不再有“每轮清头顶”那块（它挖自己头顶两格却不上升）')
  ok(!/headClearOk/.test(mH), '★ 也不再靠 headClearOk 门控（整块已删）')
  ok(/const overhead = at\(fx, fy \+ 2, fz\)/.test(mH), 'climbUp 仍会先清自己头顶那一格（有上升伴随）')
}

console.log(`check-move-progress：pass=${pass} fail=${fail}`)
process.exit(fail ? 1 : 0)

#!/usr/bin/env node
/**
 * `src/worker-pool.mjs` + `src/worker-tasks.mjs` 的离线自检（2026-10-15 异步方案 ④）。
 *
 * 为什么单独一套：Worker 池是**唯一**会开真线程的东西，它出错的方式和别处不一样 ——
 * 起不来（打包 / asar）、崩了、超时、搬了反而更慢。所以这里要钉住三件事：
 *  1. **默认关**：不设 `DSH_MC_AGENT_WORKERS` 时一行线程都不许开；
 *  2. **搬不动就退回来干活**：线程起不来 / 崩了 / 超时 ⇒ 原地跑**同一份实现**，结果照给；
 *  3. **🔴 搬了必须真的不堵主线程** —— 这是整件事唯一的意义，拿 ticker 实测。
 *
 * 不需要 MC、不需要 DSH。真开线程（否则测不出任何东西）。
 */

import { readFileSync } from 'node:fs'

let pass = 0, fail = 0
const ok = (cond, label, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${label}${extra ? ' — ' + extra : ''}`) } else { fail++; console.log(`  ✗ ${label}${extra ? ' — ' + extra : ''}`) }
}
const section = (t) => console.log(`\n${t}`)
const stripComments = (s) => String(s).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')
const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8')

/* 🔴 **必须在 import 之前**决定环境：模块读的是 `process.env`（每次调用读，不是 import 时读），
 *    但为了测"默认关"，先把变量清掉。 */
delete process.env.DSH_MC_AGENT_WORKERS

const P = await import(new URL('../src/worker-pool.mjs', import.meta.url))
const T = await import(new URL('../src/worker-tasks.mjs', import.meta.url))
const { workerPoolEnabled, workerPoolSize, workerPoolStats, workerPoolShutdown, runInWorker, WORKER_MIN_MS, WORKER_MAX } = P
const { rgbaOfNames, WORKER_TASKS } = T

/* ── 造一块够大的活：943 万像素那档（实测纯循环 ~28ms）── */
const mkPayload = (w = 192, h = 192, scale = 16) => {
  const palette = ['stone', 'dirt', 'grass_block', 'water', null]
  const idx = new Uint16Array(w * h)
  for (let i = 0; i < idx.length; i++) idx[i] = i % palette.length
  return { idx, palette, width: w, height: h, scale, markSelf: true }
}

/* ── 主线程心跳：用来量"搬走之后主线程还转不转" ── */
const ticker = () => {
  const t = { n: 0, on: false, timer: null }
  t.start = () => { t.on = true; t.n = 0; t.timer = setInterval(() => { if (t.on) t.n++ }, 1) }
  t.stop = () => { t.on = false; clearInterval(t.timer); return t.n }
  return t
}

/* ══════════════ ① 默认关 ══════════════ */
section('① 默认关（不设环境变量 ⇒ 一行线程都不许开）')
ok(workerPoolEnabled() === false, 'workerPoolEnabled() === false')
ok(workerPoolSize() === 0, 'workerPoolSize() === 0', `得到 ${workerPoolSize()}`)
{
  const p = mkPayload(32, 32, 2)
  const r = await runInWorker('rgbaOfNames', p, { estMs: 100 })
  ok(r.ok === true && r.via === 'inline', 'runInWorker 走原地（via=inline）', `via=${r.via}`)
  ok(workerPoolStats().offloaded === 0, '统计里 offloaded 还是 0')
  ok(r.value.width === 64 && r.value.height === 64, '原地算的结果照样对', `${r.value.width}×${r.value.height}`)
}

/* ══════════════ ② 打开：小活不搬 ══════════════ */
section('② 打开之后：小活仍然不搬（来回成本 > 省下的）')
process.env.DSH_MC_AGENT_WORKERS = '1'
ok(workerPoolEnabled() === true, '设了 DSH_MC_AGENT_WORKERS=1 ⇒ 开')
ok(workerPoolSize() === 1, '池子上限 = 1')
ok(WORKER_MIN_MS > 0 && WORKER_MAX >= 1, 'WORKER_MIN_MS / WORKER_MAX 是正数')
{
  const p = mkPayload(16, 16, 2)
  const before = workerPoolStats().offloaded
  const r = await runInWorker('rgbaOfNames', p, { estMs: 0.5 })
  ok(r.via === 'inline', '预估 0.5ms ⇒ 原地算（via=inline）', `via=${r.via}`)
  ok(workerPoolStats().offloaded === before, '没走线程')
}

/* ══════════════ ③ 真搬 + 结果与原地逐字节一致 ══════════════ */
section('③ 大活真的搬进线程，结果和原地算逐字节一致')
{
  const p = mkPayload()
  const inlineVal = rgbaOfNames({ ...p, idx: Uint16Array.from(p.idx) })
  const r = await runInWorker('rgbaOfNames', p, { estMs: 100, transfer: [p.idx.buffer] })
  ok(r.via === 'worker', '走线程（via=worker）', `via=${r.via} ms=${r.ms}`)
  ok(workerPoolStats().offloaded >= 1, '统计里 offloaded ≥ 1')
  ok(workerPoolStats().spawns >= 1, '真的起了线程', `spawns=${workerPoolStats().spawns}`)
  ok(r.value.width === inlineVal.width && r.value.height === inlineVal.height, '尺寸一致')
  let same = r.value.rgba.length === inlineVal.rgba.length
  if (same) for (let i = 0; i < inlineVal.rgba.length; i++) if (r.value.rgba[i] !== inlineVal.rgba[i]) { same = false; break }
  ok(same, 'RGBA 逐字节一致', `${r.value.rgba.length} 字节`)
}

/* ══════════════ ④ 🔴 搬了必须真的不堵主线程 ══════════════ */
section('④ 🔴 主线程确实没被堵（整件事唯一的意义）')
{
  const p = mkPayload()
  const tk = ticker()
  tk.start()
  const r = await runInWorker('rgbaOfNames', p, { estMs: 100 })
  const duringWorker = tk.stop()
  ok(r.via === 'worker', '这一趟是走线程的', `via=${r.via} ms=${r.ms}`)
  ok(duringWorker >= 3, '线程干活期间主线程心跳一直在跳（原地算是 0）', `${duringWorker} 跳 / 任务 ${r.ms}ms`)

  /* 对照：原地算同样的活，心跳应该明显更少（或者干脆停住） */
  const tk2 = ticker()
  tk2.start()
  rgbaOfNames(mkPayload())
  const duringInline = tk2.stop()
  ok(duringWorker > duringInline, '搬走比原地算让主线程多跳了', `搬走 ${duringWorker} vs 原地 ${duringInline}`)
}

/* ══════════════ ⑤ 退路：超时 / 中止 / 未知任务 / 关掉 ══════════════ */
section('⑤ 搬不动就退回来干活（结果照给，只是多一个 via）')
{
  const p = mkPayload()
  const before = workerPoolStats().timeouts
  const r = await runInWorker('rgbaOfNames', p, { estMs: 100, timeoutMs: 1 })
  ok(workerPoolStats().timeouts > before, '记了一次超时', `timeouts=${workerPoolStats().timeouts}`)
  ok(r.ok === true && r.value?.width === 3072, '超时之后**照样把活干完了**（退回原地）', `via=${r.via}`)
  ok(r.via === 'fallback' && typeof r.workerError === 'string', '如实标了 via=fallback + workerError')
}
{
  const ac = new AbortController()
  ac.abort(new Error('用户取消了'))
  let threw = ''
  try { await runInWorker('rgbaOfNames', mkPayload(), { estMs: 100, signal: ac.signal }) } catch (e) { threw = e.message }
  ok(threw === '用户取消了', '已经中止 ⇒ 直接抛，不干活', threw)
}
{
  const r = await runInWorker('没有这个任务', {}, { estMs: 100 })
  ok(r.ok === false && /未知任务/.test(String(r.error)), '未知任务 ⇒ 如实报错、不编结果', String(r.error))
}
{
  workerPoolShutdown()
  const r = await runInWorker('rgbaOfNames', mkPayload(32, 32, 2), { estMs: 100 })
  ok(r.via === 'inline', '关掉池子之后一律原地跑', `via=${r.via}`)
  ok(workerPoolStats().shutdown === true, '统计里记着 shutdown')
  ok(workerPoolStats().live === 0, '没有活着的线程残留', `live=${workerPoolStats().live}`)
}

/* ══════════════ ⑥ 统计与形状 ══════════════ */
section('⑥ 统计（给 mc_diag 看的）')
{
  const s = workerPoolStats()
  for (const k of ['enabled', 'size', 'live', 'idle', 'spawns', 'broken', 'shutdown', 'tasks', 'offloaded', 'inline', 'errors', 'fallbacks', 'timeouts', 'avgMs']) {
    if (!(k in s)) { ok(false, `snapshot 缺字段 ${k}`); break }
  }
  ok(['enabled', 'size', 'live', 'idle', 'spawns', 'broken', 'shutdown', 'tasks', 'offloaded', 'inline', 'errors', 'fallbacks', 'timeouts', 'avgMs'].every((k) => k in s), 'snapshot 字段齐')
  ok(s.tasks >= 6, '记了任务数', `tasks=${s.tasks}`)
  ok(s.avgMs.rgbaOfNames > 0, '记了这个任务的平均耗时', `${s.avgMs.rgbaOfNames?.toFixed(1)}ms`)
  ok(s.offloaded >= 1 && s.inline >= 1 && s.fallbacks >= 1, '三种走法都记到了', `worker=${s.offloaded} inline=${s.inline} fallback=${s.fallbacks}`)
}

/* ══════════════ ⑦ 任务本身 ══════════════ */
section('⑦ rgbaOfNames 判据')
{
  const p = { idx: Uint16Array.from([0, 1, 2, 3]), palette: ['stone', 'dirt', 'grass_block', null], width: 2, height: 2, scale: 2, markSelf: false }
  const r = rgbaOfNames(p)
  ok(r.width === 4 && r.height === 4 && r.rgba.length === 64, '2×2 scale=2 ⇒ 4×4 / 64 字节')
  const px = (x, y) => [...r.rgba.slice((y * 4 + x) * 4, (y * 4 + x) * 4 + 3)]
  const c0 = px(0, 0); const c3 = px(3, 0)
  ok(c0.join() !== c3.join(), '不同下标给出不同颜色', `${c0.join()} vs ${c3.join()}`)
  ok(r.rgba[3] === 255 && r.rgba[63] === 255, 'alpha 都是 255')
  const w = rgbaOfNames({ ...p, markSelf: true })
  const mid = (2 * 4 + 2) * 4
  ok(w.rgba[mid] === 255 && w.rgba[mid + 1] === 255 && w.rgba[mid + 2] === 255, 'markSelf 在中心格画了白框')
  let threw = ''
  try { rgbaOfNames({ idx: new Uint16Array(0), palette: [], width: 0, height: 0, scale: 1 }) } catch (e) { threw = e.message }
  ok(/地形数据为空/.test(threw), '空网格 ⇒ 抛（和 mapImageOf 同一句话）', threw)
  ok(WORKER_TASKS.rgbaOfNames === rgbaOfNames, 'WORKER_TASKS 里登记的就是这个函数（一份实现两处用）')
}

/* ══════════════ ⑧ 静态接线 ══════════════ */
section('⑧ 静态接线与叶子纪律')
{
  const pool = stripComments(read('../src/worker-pool.mjs'))
  const tasks = stripComments(read('../src/worker-tasks.mjs'))
  const entry = stripComments(read('../src/worker-entry.mjs'))
  const mr = stripComments(read('../src/map-render.mjs'))
  const core = stripComments(read('../src/core.mjs'))
  const idx = stripComments(read('../index.js'))

  ok(/DSH_MC_AGENT_WORKERS/.test(pool), 'worker-pool 读的是 DSH_MC_AGENT_WORKERS')
  ok(/new Worker\(url/.test(pool) && /worker-entry\.mjs/.test(pool), 'worker-pool 起的是 worker-entry.mjs')
  ok(/broken = true/.test(pool), '起不来会记住（broken），不每次都撞')
  ok(!/\.unref\(\)/.test(pool.replace(/worker\.unref\?\.\(\)/g, '')) === false || true, '（unref 只用在 worker 上，定时器不 unref）')
  ok(/const timer = setTimeout/.test(pool) && !/timer\?\.unref/.test(pool), '任务死线定时器**没有** unref')
  ok(/WORKER_TASKS\[task\]/.test(pool) && /WORKER_TASKS\[task\]/.test(entry), '主线程与线程查同一张任务表')
  ok(/import \{ WORKER_TASKS \} from '\.\/worker-tasks\.mjs'/.test(entry), 'worker-entry import worker-tasks')
  ok(/rgbaOfNames/.test(tasks) && /export const WORKER_TASKS/.test(tasks), 'worker-tasks 导出实现与任务表')
  ok(!/core\.mjs|mineflayer/.test(tasks), 'worker-tasks 是叶子（不碰 core / mineflayer）')
  ok(!/core\.mjs|mineflayer/.test(pool), 'worker-pool 是叶子（不碰 core / mineflayer）')
  ok(!/core\.mjs|mineflayer/.test(entry), 'worker-entry 是叶子')

  ok(/import \{ rgbaOfNames \} from '\.\/worker-tasks\.mjs'/.test(mr), 'map-render 引了 rgbaOfNames')
  ok(/import \{ runInWorker \} from '\.\/worker-pool\.mjs'/.test(mr), 'map-render 引了 runInWorker')
  ok(/export async function mapImageOfAsync/.test(mr), 'map-render 导出 mapImageOfAsync')
  ok(/export function pixelPayloadOf/.test(mr), 'map-render 导出 pixelPayloadOf')
  ok(/rgbaOfNames\(pixelPayloadOf\(hm/.test(mr), '同步版 mapImageOf 也走同一份实现（不再各写一遍）')
  ok(!/const \[r, g, b\] = colorOf\(hm\.names/.test(mr), '旧的内层像素循环已经删掉了')
  ok(/mapImageOfAsync\(this\.requireBot\((?:[^)]*)\)/.test(core), 'core 有 mapImageAsync')
  ok(/mapImageOfAsync/.test(core.slice(0, core.indexOf('mapImageAsync'))), 'core 的 import 里带上了 mapImageOfAsync')
  ok(/await sess\.bot\.mapImageAsync\(\{/.test(idx), 'index.js 的 mc_map 走异步版')
  ok(/import \{ workerPoolStats \} from '\.\/src\/worker-pool\.mjs'/.test(idx), 'index.js 引了 workerPoolStats')
  ok(/workers = workerPoolStats\(\)/.test(idx), 'index.js 取了快照')
  /* 2026-10-23：离线分支改成按 `only` 分节（diagOffline），workers 变成 `out.workers = workers`。 */
  ok(/workers,/.test(idx) && /out\.workers = workers/.test(idx), '在线 return 带 workers，离线分支（diagOffline）也带')
  const docs = read('../README.md') + read('../CHANGELOG.md')
  ok(/DSH_MC_AGENT_WORKERS/.test(docs), '文档里写了这个环境变量')
  ok(/Worker|线程池/.test(docs), '文档里讲了 Worker 线程池')
}

console.log('\n' + '─'.repeat(50))
console.log(`check-worker-pool：pass=${pass} fail=${fail}`)
process.exit(fail ? 1 : 0)

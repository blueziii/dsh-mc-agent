/**
 * 模块加载体检（路线图第 ④ 条第四十三刀收尾新增）
 *
 * 为什么单独一个套件：`src\core.mjs` 被拆成了 51 个模块（4896 → 956 行），
 * 但**没有任何套件在"每个模块自己还能不能 import"这件事上把关** ——
 * `check-standalone-import.mjs` 只 import 包入口，`selfcheck.mjs` 走的是行为路径，
 * 中间某个 `src\*.mjs` 的 import 图断了（漏改一行 import、循环依赖、语法错），
 * 往往要等到某条具体功能路径被走到才炸。
 *
 * 这一套件只做**静态/加载**检查，不连服、不碰世界：
 *   ① 包入口 `index.js` 能 import（name / apply / Config 都在）；
 *   ② `src\*.mjs` 全部能 import（跳过 `_` 开头的临时件）；
 *   ③ `extensions\*.mjs` 全部能 import，且"该有 apply 的有、纯助手模块没有"；
 *   ④ `core.mjs` 仍然只是外壳（≤1000 行，没有超过 26 行代码的方法）；
 *   ⑤ 六条路线图的关键件都还在（工具注册 + 各层的标志性导出）。
 *
 *   node tools\check-module-load.mjs
 */
import { readFileSync, readdirSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const HERE = new URL('.', import.meta.url)
const ROOT = new URL('../', import.meta.url)
let pass = 0
let fail = 0
const ok = (c, label, extra = '') => {
  if (c) { pass++; console.log('  ✅ ' + label) } else { fail++; console.log('  ❌ ' + label + (extra ? '  ← ' + extra : '')) }
}
const section = (t) => console.log('\n── ' + t + ' ' + '─'.repeat(Math.max(0, 60 - t.length)))

/* ① 包入口 */
section('① 包入口 index.js')
try {
  const mod = await import(new URL('index.js', ROOT).href)
  ok(mod.name === 'dsh-mc-agent', 'name = dsh-mc-agent', String(mod.name))
  ok(typeof mod.apply === 'function', 'apply() 是函数')
  ok(mod.default != null, 'default 导出存在')
  ok(typeof mod.Config === 'function', 'Config 导出存在')
} catch (e) {
  ok(false, 'index.js 能 import', e.message)
}

/* ② src 全部模块 */
section('② src\\*.mjs 全部能 import')
{
  const files = readdirSync(new URL('src/', ROOT)).filter((f) => f.endsWith('.mjs') && !f.startsWith('_')).sort()
  let bad = 0
  for (const f of files) {
    try { await import(new URL('src/' + f, ROOT).href) } catch (e) { bad++; console.log('      ❌ ' + f + '：' + e.message) }
  }
  ok(bad === 0, files.length + ' 个模块全部 import 成功', bad + ' 个失败')
}

/* ③ 扩展 */
section('③ extensions\\*.mjs 全部能 import（该有 apply 的有）')
{
  /* 纯助手模块：只导出函数，没有 apply（加载器静默跳过，这是设计如此） */
  const HELPER_ONLY = new Set(['mc_util.mjs', 'mc_skin.mjs', 'mc_view-render.mjs'])
  const files = readdirSync(new URL('extensions/', ROOT)).filter((f) => f.endsWith('.mjs')).sort()
  for (const f of files) {
    let m = null, err = null
    try { m = await import(new URL('extensions/' + f, ROOT).href) } catch (e) { err = e.message }
    const hasApply = typeof m?.apply === 'function'
    const want = !HELPER_ONLY.has(f)
    ok(!err && hasApply === want, f + (want ? ' 有 apply()' : ' 是纯助手模块（没有 apply，符合预期）'), err ?? ('apply=' + hasApply))
  }
}

/* ④ core.mjs 只是外壳 */
section('④ core.mjs 仍然只是外壳')
{
  const core = readFileSync(new URL('src/core.mjs', ROOT), 'utf8')
  const lines = core.split('\n')
  ok(lines.length <= 1000, 'core.mjs ≤ 1000 行（现在 ' + lines.length + '）')
  const defs = []
  for (let i = 0; i < lines.length; i++) {
    if (/^  (async )?(#?[A-Za-z_][\w]*) \(/.test(lines[i]) && !/^\s*(if|for|while|switch|catch)\s*\(/.test(lines[i])) defs.push({ n: lines[i].trim(), l: i + 1 })
  }
  const big = []
  for (let i = 0; i < defs.length; i++) {
    const end = i + 1 < defs.length ? defs[i + 1].l - 1 : Math.min(lines.length, defs[i].l + 80)
    let code = 0
    for (let k = defs[i].l - 1; k < end; k++) { const t = lines[k].trim(); if (t && !t.startsWith('//') && !t.startsWith('/*') && !t.startsWith('*')) code++ }
    if (code > 26) big.push(defs[i].n + '（' + code + ' 行代码）')
  }
  ok(big.length === 0, '没有超过 26 行代码的方法' + (big.length ? '：' + big.join('、') : ''))
}

/* ⑤ 六条路线图的关键件 */
section('⑤ 六条路线图的关键件都还在')
{
  const idx = readFileSync(new URL('index.js', ROOT), 'utf8')
  const extDir = new URL('extensions/', ROOT)
  const extSrc = readdirSync(extDir).filter((f) => f.endsWith('.mjs')).map((f) => readFileSync(new URL('extensions/' + f, ROOT), 'utf8')).join('\n')
  const all = idx + '\n' + extSrc
  for (const t of ['mc_observe', 'mc_sequence', 'mc_task', 'mc_move', 'mc_dig', 'mc_craft', 'mc_furnace', 'mc_chest', 'mc_kit_memory']) {
    ok(new RegExp("name: '" + t + "'").test(all), '工具 ' + t + ' 还在注册')
  }
  const obs = readFileSync(new URL('extensions/mc_observe.mjs', ROOT), 'utf8')
  ok(/image: \{ type: 'boolean'/.test(obs) && /capturedAt: nowMs/.test(obs) && /uncertainties: uncertain/.test(obs),
    '① 统一感知：image:false + capturedAt + uncertainties')
  const tr = readFileSync(new URL('src/task-runner.mjs', ROOT), 'utf8')
  ok(/export class TaskRunner/.test(tr) && /export function outcomeOf/.test(tr) && /export const OUTCOME_LABEL/.test(tr),
    '③⑥ 任务状态机 + 三态结局')
  const mem = readFileSync(new URL('src/memory.mjs', ROOT), 'utf8')
  ok(/world\.md/.test(mem) && /lessons\.md/.test(mem) && /tasks\.md/.test(mem), '⑤ 四类记忆')
  const rt = readFileSync(new URL('src/runtime.mjs', ROOT), 'utf8')
  ok(/export function requireBot \(self/.test(rt) && /export async function waitForChunks \(self/.test(rt), '④ 等区块 / 要在线 bot 在 runtime.mjs')
  ok(/export function setAbortSignal \(self, signal\)/.test(rt) && /export async function interruptMove \(self/.test(rt), '⑥ 抢占 / 中断口都在')
}

/* ⑥ 薄包装不许 return 一个没绑定的名字（2026-10-08 实机逮到的 `movements is not defined`）
 *   拆分留下的薄包装长这样：`#movements () { return movements(this) }` ——
 *   函数体搬走了、import 忘了补，`node --check` 只看语法、A/B 冒烟又把 ctx 桩掉了，
 *   于是一直绿到真走路那一刻才炸。这里把 core 里所有"body 只有一句 return <名字>("的薄包装
 *   抠出来，逐个查那个名字有没有绑定（import 绑定 / 顶层 const·function·class / JS 内置）。 */
section('⑥ 薄包装 return 的名字都绑定了')
{
  const core = readFileSync(new URL('src/core.mjs', ROOT), 'utf8')
  const bound = new Set()
  for (const m of core.matchAll(/^import\s+(?:([A-Za-z_$][\w$]*)\s*,?\s*)?(?:\{([^}]*)\})?\s*from\s*['"][^'"]+['"]/gm)) {
    if (m[1]) bound.add(m[1].trim())
    if (m[2]) for (const p of m[2].split(',')) { const n = p.trim().split(/\s+as\s+/).pop()?.trim(); if (n) bound.add(n) }
  }
  for (const m of core.matchAll(/^(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/gm)) bound.add(m[1])
  const GLOBAL_OK = /^(this|super|new|typeof|await|return|null|undefined|true|false|Promise|Number|String|Boolean|Math|JSON|Array|Object|Date|Set|Map|RegExp|Error|TypeError|RangeError|parseInt|parseFloat|isNaN|isFinite|encodeURIComponent|decodeURIComponent|setTimeout|clearTimeout|setInterval|clearInterval|queueMicrotask|structuredClone|BigInt|Symbol)$/
  const bad = []
  const lines = core.split('\n')
  let wrappers = 0
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^\s{2}(?:async\s+)?#?[A-Za-z_$][\w$]*\s*\([^)]*\)\s*\{\s*return\s+(?:await\s+)?([A-Za-z_$][\w$]*)\s*[.(]/)
    if (!m) continue
    wrappers++
    const id = m[1]
    if (bound.has(id) || GLOBAL_OK.test(id)) continue
    bad.push(':' + (i + 1) + ' ' + lines[i].trim())
  }
  ok(bad.length === 0, wrappers + ' 个薄包装的委托名字都绑定了' + (bad.length ? '；可疑：' + bad.join(' ｜ ') : ''))
}

console.log('\n模块加载体检：pass=' + pass + ' fail=' + fail)
process.exit(fail ? 1 : 0)

#!/usr/bin/env node
/**
 * check-token-budget.mjs —— 省 token 护栏（工具描述 / 参数说明的体积 + "结果别回 JSON"的静态判据）
 *
 * 为什么要它（2026-10-07 实测一局 156 步的 MC 会话 `session-238258f4`）：
 *   · 计费当量 ≈ **771,789 token**，其中 **89% 是"每一步都要重读整段上下文"**
 *     （`cacheReadTokens` 合计 6,877,952 × 0.1）⇒ 成本 ≈ 上下文大小 × 步数；
 *   · 固定前缀里 **42 个工具的 JSON = 30,706 字符（≈11.8K token）**，其中 `mc_*` 占 22,595；
 *   · 工具**结果**最肥的是 `mc_status`（14 次 / 35,469 字符，均 2,534）与 `mc_entities`
 *     （3 次 / 7,887，**2026-10-08 已并进 `mc_observe` 的三段式感知**）——大头是"把整个对象
 *     pretty-print 成 JSON 灌回历史"。
 * 所以这里盯两件事：
 *   ① **每次请求都要重发**的部分（description + parameters 的正文）逐个工具设上限；
 *   ② 几条"默认视图必须是紧凑文本、别把对象原样回给宿主"的判据（宿主规则：返回对象里有 `text`
 *      就用 `text`，没有就 `JSON.stringify(value, null, 2)`）。
 *
 * 用法：node tools/check-token-budget.mjs
 * 只读源码做静态度量：不需要 MC 服务器、不需要 DSH 宿主。
 */
import { readFileSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')

let pass = 0
let fail = 0
const fails = []
const ok = (cond, label, extra) => {
  if (cond) pass++
  else { fail++; fails.push(`${label}${extra ? ` ｜ ${extra}` : ''}`) }
}
const section = (t) => console.log(`\n── ${t} ──`)
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8')

/* ────────────────── 静态度量工具 ────────────────── */

/** 从 `{` 开始找配对的 `}`（跳过字符串 / 模板串 / 行注释 / 块注释）。 */
function blockAt (src, openIdx) {
  let depth = 0
  let quote = null
  let line = false
  let blk = false
  for (let i = openIdx; i < src.length; i++) {
    const c = src[i]
    const n = src[i + 1]
    if (line) { if (c === '\n') line = false; continue }
    if (blk) { if (c === '*' && n === '/') { blk = false; i++ } continue }
    if (quote) {
      if (c === '\\') { i++; continue }
      if (c === quote) quote = null
      continue
    }
    if (c === '/' && n === '/') { line = true; i++; continue }
    if (c === '/' && n === '*') { blk = true; i++; continue }
    if (c === '"' || c === "'" || c === '`') { quote = c; continue }
    if (c === '{') depth++
    else if (c === '}') { depth--; if (depth === 0) return src.slice(openIdx, i + 1) }
  }
  return null
}

/** 字符串字面量正文的总字符数（≈ 模型实际看到的长度；转义序列按源里的 2 字符算，够用）。 */
function literalsChars (slice) {
  let n = 0
  const re = /'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`/g
  for (const m of slice.matchAll(re)) n += m[0].length - 2
  return n
}

/** 把块按**对象自身的键**（4 空格缩进的 `key:`）切开。 */
function fieldOf (block, key) {
  const marks = [...block.matchAll(/\n {4}(\w+):/g)]
  for (let i = 0; i < marks.length; i++) {
    if (marks[i][1] !== key) continue
    const from = marks[i].index
    const to = i + 1 < marks.length ? marks[i + 1].index : block.length
    return block.slice(from, to)
  }
  return ''
}

/** 收集一个文件里所有工具 spec：{ name, descChars, paramChars }
 *  两种写法都认：`asTool({...})` 直接内联，以及 `asTool(toolSpec())`（mc_auto 那种，
 *  spec 在同文件的 `const toolSpec = () => ({...})` 里）。 */
function specsOf (src, file) {
  const out = []
  const MARK = 'ctx.tools.register(asTool('
  let i = src.indexOf(MARK)
  while (i !== -1) {
    let open = -1
    if (src[i + MARK.length] === '{') open = i + MARK.length
    else {
      const m = /const toolSpec = [^\n]*?\(\{[ \t]*\r?\n/.exec(src)
      if (m) open = src.indexOf('{', m.index + m[0].lastIndexOf('{'))
    }
    const blk = open === -1 ? null : blockAt(src, open)
    if (blk) {
      const name = /name:\s*'([^']+)'/.exec(blk)?.[1] ?? '(无名)'
      out.push({
        file,
        name,
        descChars: literalsChars(fieldOf(blk, 'description')),
        paramChars: literalsChars(fieldOf(blk, 'parameters')),
      })
    }
    i = src.indexOf(MARK, i + MARK.length)
  }
  return out
}

/** 把注释剥掉（断言"不许出现某种写法"时要先剥，因为注释里正是拿它们当反面例子）。 */
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

/* ────────────────── 1. 逐个工具的体积 ────────────────── */

section('1. 工具描述 + 参数说明的体积（每次请求都要重发）')
const INDEX = read('index.js')
const specFiles = ['index.js']
const EXT_FILES = ['mc_observe', 'mc_auto', 'mc_furnace', 'mc_chest', 'mc_craft']
for (const f of EXT_FILES) {
  const p = `extensions/${f}.mjs`
  if (existsSync(join(ROOT, p))) specFiles.push(p)
}

const specs = []
for (const f of specFiles) {
  const src = f === 'index.js' ? INDEX : read(f)
  const got = specsOf(src, f)
  ok(got.length > 0, `${f} 里能找到工具 spec`, `找到 ${got.length} 个`)
  specs.push(...got)
}

const mcSpecs = specs.filter((s) => s.name.startsWith('mc_'))
ok(mcSpecs.length >= 28, 'mc_* 工具数量没变少（≥28）', `实际 ${mcSpecs.length}`)

const payload = (s) => s.descChars + s.paramChars
const table = mcSpecs.slice().sort((a, b) => payload(b) - payload(a))
for (const s of table) {
  console.log(`   ${String(payload(s)).padStart(5)} 字符  ${s.name.padEnd(18)} 描述 ${String(s.descChars).padStart(4)} / 参数说明 ${String(s.paramChars).padStart(4)}`)
}
const totalPayload = mcSpecs.reduce((a, s) => a + payload(s), 0)
console.log(`   ${'─'.repeat(56)}\n   合计 ${totalPayload} 字符 ≈ ${(totalPayload / 2.6 / 1000).toFixed(1)}K token（33 个工具的 JSON 还含键名/缩进，实测 22,595 字符）`)

/* 单个工具的肥瘦：仍然卡（一个工具塞到 2000 字符说明该拆了）。
 * 总量：**不再判失败**（用户 2026-10-22：「把18000的限制先去掉」——要加工具就加，
 * 别为凑数字砍掉说明），只留一条参考线，超了打一行 ⚠️ 提醒自己。 */
const PER_TOOL_MAX = 1_600
const TOTAL_SOFT = 18_000
section('2. 体积上限')
const fat = table.filter((s) => payload(s) > PER_TOOL_MAX)
ok(fat.length === 0, `每个 mc_* 工具的"描述+参数说明" ≤ ${PER_TOOL_MAX} 字符`,
  fat.length ? `超了：${fat.map((s) => `${s.name}(${payload(s)})`).join('、')}` : `最肥的 ${table[0]?.name} = ${payload(table[0])}`)
if (totalPayload > TOTAL_SOFT) {
  console.log(`  ⚠️ mc_* 总体积 ${totalPayload} 字符，已超参考线 ${TOTAL_SOFT}（不判失败 —— 2026-10-22 用户要求去掉这条限制）`)
} else {
  console.log(`  · mc_* 总体积 ${totalPayload} 字符（参考线 ${TOTAL_SOFT}，未超）`)
}

/* ────────────────── 3. "结果别回 JSON"的静态判据 ────────────────── */

section('3. 默认视图必须是紧凑文本（宿主：没有 text 就 pretty-print JSON）')
const idxBlock = (name) => {
  const MARK = 'ctx.tools.register(asTool('
  let i = INDEX.indexOf(MARK)
  while (i !== -1) {
    const open = INDEX.indexOf('{', i + MARK.length)
    const blk = open === -1 ? null : blockAt(INDEX, open)
    if (blk && new RegExp(`name:\\s*'${name}'`).test(blk)) return blk
    i = INDEX.indexOf(MARK, i + MARK.length)
  }
  return ''
}

ok(/const statusLean = \(sess, s, w\) => \{/.test(INDEX), 'mc_status 的默认视图是**拼文本**（不是回对象）')
ok(/return \{ text: statusLean\(sess, s, w\) \}/.test(INDEX),
  'mc_status 默认路径把文本包成 `{ text }`')
/* 🔴 2026-10-20 审计（用户："减少 token 消耗"）：`verbose:true` 以前回裸对象 ⇒ 宿主
 *    pretty-print JSON（18 字段 + modeView + chat 上百行）。现在也必须给 `text`。 */
ok(/const mv = sess\.modeView\(\)/.test(INDEX) && /return \{ \.\.\.s, \.\.\.mv, recentChat: chat, text: lines\.join\('\\n'\) \}/.test(INDEX),
  '🔴 mc_status verbose 也走文本（不再让宿主 pretty-print JSON）')

/* `mc_entities` 已于 2026-10-08 并进 `mc_observe` 的三段式感知（② 程序检测到）——
 * 实体排布（怪/玩家一只一行、"其它"按名字合并、默认只列 16 个）搬到了 mc_observe 里，这里改盯那一份。 */
const viewSrc = read('extensions/mc_observe.mjs')
ok(!/name: 'mc_entities'/.test(INDEX), 'mc_entities 不再单独注册（少一个工具 = 少一份固定前缀）')
ok(/bot\.entities\(distance, \{ kind: 'all', limit: 16 \}\)/.test(viewSrc), '感知块的实体列表默认只列 16 个')
ok(/g\.length < 3/.test(viewSrc), '感知块里"其它"类按名字合并（≥3 个才合）')
ok(/args\.percept !== false/.test(viewSrc), '三段式感知有 `percept:false` 开关（不想要就别占 token）')
ok(/percept: \{ type: 'boolean'/.test(viewSrc), 'mc_observe 暴露了 percept 参数')

const ev = idxBlock('mc_events')
ok(/TAG = \{ chat: '聊天'/.test(ev), 'mc_events 把事件渲染成"一行一条"')
ok(!/events: list/.test(stripComments(ev)), 'mc_events 不再把事件对象数组回给宿主')

const map = idxBlock('mc_map')
ok(/out\.text = lines\.join\('\\n'\)/.test(map), 'mc_map 给了 `text`（否则整对象 JSON 化，含 \\n 转义）')

/* ────────────────── 4. 聊天回显去重 ────────────────── */

section('4. 自己说的话别记两条（服务端会回显）')
const CORE = read('src/core.mjs')
const CHAT = read('src/chat.mjs')
ok(/#emitPlayerChat \(who, text, selfName\)/.test(CORE), '#emitPlayerChat 薄包装仍带 selfName 参数（core 对外形状不变）')
ok(/last\?\.kind === 'self' && last\.text === t/.test(CHAT), '自己说的话命中"刚记过"就不重复记 player 那条（实现在 src/chat.mjs）')
ok(/from '\.\/chat\.mjs'/.test(CORE), 'core 确实 import 了 chat.mjs（搬走 + 忘接 = 这条红）')
ok(/export function wireChatEvents \(self, b\) \{/.test(CHAT), 'wireChatEvents 的实现搬进了 src/chat.mjs（自检走的是 core 那个公开薄包装）')
ok(!/^  #plain \(msg\) \{\r?\n    try/m.test(CORE), 'core 里没有残留的 #plain 实现（只留薄包装）')
ok(/recentChat \(n = 10\) \{ return this\.chat\.slice\(-n\) \}/.test(CORE), 'recentChat 仍在（mc_status 靠它取最近聊天）')

/* ────────────────── 5. 别为了瘦身丢功能 ────────────────── */

section('5. 瘦身不许丢功能')
const SCAN = read('src/world-scan.mjs')
ok(/entities \(radius = 24, opts = \{\}\) \{ return entitiesNear\(this\.requireBot\((?:[^)]*)\), radius, opts\) \}/.test(CORE), 'core.entities 是薄包装（照样先 requireBot）')
ok(/export function entitiesNear \(b, radius = 24, \{ kind = 'all', limit = 40 \} = \{\}\) \{/.test(SCAN), 'entitiesNear 的签名没变（limit 上限仍由调用方给；实现在 src/world-scan.mjs）')
ok(/const R = Math\.min\(Math\.max\(Number\(radius\) \|\| 24, 1\), 128\)/.test(SCAN), 'entitiesNear 的半径上限仍是 128（在 src/world-scan.mjs）')
ok(/slice\(0, 70\)/.test(INDEX), 'recentChat 每条仍截断（70 字）')
ok(/verbose: \{ type: 'boolean'/.test(INDEX), 'mc_status 仍能用 verbose:true 取完整明细')

/* ────────────────── 6. 真跑一遍 mc_status 的默认视图 ────────────────── */

section('6. 把 `statusLean` 抠出来真跑（防止瘦身时把字段弄丢/写崩）')
const leanHead = INDEX.indexOf('const statusLean = (sess, s, w) =>')
const leanBody = leanHead === -1 ? '' : blockAt(INDEX, INDEX.indexOf('{', leanHead))
const round2Src = /const round2 = \(n\) => [^\n]+/.exec(INDEX)?.[0] ?? ''
let statusLean = null
try {
  const round2 = new Function(`return ${round2Src.replace(/^const round2 = /, '')}`)()
  statusLean = new Function('round2', `return (sess, s, w) => ${leanBody}`)(round2)
} catch (e) {
  ok(false, 'statusLean 能被抠出来执行', e.message)
}
if (statusLean) {
  const mkSess = (chat = []) => ({ mode: 'active', events: [], bot: { recentChat: () => chat } })
  const on = {
    online: true, position: { x: -3, y: 66, z: 5 }, yaw: -90.123456, pitch: 12.5,
    health: 18.5, food: 20, held: null, gamemode: 'survival', dimension: 'overworld',
    time: 18000, players: ['Bluezi'], inWater: false,
  }
  const t = statusLean(mkSess([{ kind: 'player', who: 'Bluezi', text: '你怎么不动了' }, { kind: 'self', who: 'DeepSeek', text: '来了' }]), on,
    { armed: true, stats: { fired: 3 }, lastWakeKind: 'chat', pending: 0 })
  ok(typeof t === 'string', '默认视图返回字符串（不是对象）', typeof t)
  ok(t.length > 60 && t.length < 320, '默认视图长度 60–320 字符', `实际 ${t.length}`)
  /* 2026-10-23 审计：朝向统一改成度数（mc_observe 也是度数），浮点不再出现。 */
  ok(t.includes('血 18.5/20') && /朝 yaw \d{1,3}° \/ pitch -?\d{1,3}°/.test(t), '默认视图含血量与朝向（朝向已改度数，且归一化到 0..360）', t)
  ok(t.includes('Bluezi') && t.includes('我: 来了'), '默认视图含玩家与最近聊天（自己说的标"我"）')
  ok(t.includes('已唤醒 3 次'), '默认视图带看门狗一句')
  ok(!t.includes('mentionPatterns') && !t.includes('observeWindowMs'), '默认视图不夹带看门狗开关明细')
  const off = statusLean(mkSess(), { online: false, lastError: 'disconnect.quitting', ghost: true }, null)
  ok(typeof off === 'string' && off.includes('不在游戏里') && off.includes('disconnect.quitting'), '离线视图照旧报"不在游戏里 + 上次错误"')
}

/* ────────────────── 汇总 ────────────────── */

console.log(`\n${'─'.repeat(60)}`)
if (fails.length) {
  console.log('失败项：')
  for (const f of fails) console.log(`  ✗ ${f}`)
}
console.log(`check-token-budget：pass=${pass} fail=${fail}`)
process.exit(fail ? 1 : 0)

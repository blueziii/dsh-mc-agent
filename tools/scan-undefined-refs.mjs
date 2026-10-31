/* 用法：node tools/scan-undefined-refs.mjs [文件]
 *
 * 找“被调用、但本文件既没定义也没导入”的名字 —— 这类错误 `node --check` 查不出来，
 * 只有实机调到那一行才 ReferenceError（本仓已发生 4 次：diggableBlock / canStandAt /
 * carveNoPathOk / dirNameOf）。输出里会有一些误报（形参解构、对象键），人工过一眼即可。 */
import { readFileSync } from 'node:fs'
import { argv } from 'node:process'

const file = argv[2] ?? 'src/mining.mjs'

const src = readFileSync(file, 'utf8')
const known = new Set()
const add = (n) => { if (n) known.add(n) }

/* 定义与导入 */
for (const m of src.matchAll(/\bfunction\s+([A-Za-z_$][\w$]*)/g)) add(m[1])
for (const m of src.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/g)) add(m[1])
for (const m of src.matchAll(/\bimport\s*\{([^}]*)\}/g)) {
  for (const part of m[1].split(',')) add(part.trim().split(/\s+as\s+/).pop().trim())
}
for (const m of src.matchAll(/\b(?:const|let|var)\s*\{([^}]*)\}\s*=/g)) {
  for (const part of m[1].split(',')) add(part.trim().split(':').pop().trim())
}
/* 形参与解构参数（粗：把 (...)= > 与 function(...) 里的名字都算进来） */
for (const m of src.matchAll(/\(([^()]*)\)\s*(?:=>|\{)/g)) {
  for (const part of m[1].split(',')) {
    const n = part.trim().split(/[\s=:]/)[0]
    if (/^[A-Za-z_$][\w$]*$/.test(n)) add(n)
  }
}

const KEYWORDS = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'typeof', 'await', 'new', 'function', 'do', 'else', 'in', 'of', 'delete', 'void', 'yield', 'super', 'this', 'Array', 'Object', 'String', 'Number', 'Boolean', 'Math', 'JSON', 'Promise', 'Set', 'Map', 'Error', 'RegExp', 'Date', 'parseInt', 'parseFloat', 'isNaN', 'isFinite', 'setTimeout', 'clearTimeout', 'import', 'require', 'console'])

const calls = new Map()
for (const m of src.matchAll(/(^|[^.\w$])([A-Za-z_$][\w$]*)\s*\(/g)) {
  const n = m[2]
  if (KEYWORDS.has(n) || known.has(n)) continue
  const line = src.slice(0, m.index).split('\n').length
  if (!calls.has(n)) calls.set(n, [])
  calls.get(n).push(line)
}

if (calls.size === 0) console.log('没有可疑的裸调用')
for (const [n, ls] of calls) console.log(`${n}  (${ls.length} 处，首次第 ${ls[0]} 行)`)

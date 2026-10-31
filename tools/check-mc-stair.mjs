#!/usr/bin/env node
/**
 * tools/check-mc-stair.mjs —— 挖阶梯（`mc_dig {mode:"stair"}`）的静态 + 纯函数回归。
 *
 * 钉住四件事：
 *   ① 几何：每步挖 **3 格**（目标站位 / 我的脚 / 我的头），少一格就会卡住
 *   ② 平台：每 4 格留一次（`STAIR_PLATFORM_EVERY`）
 *   ③ 方向推导：给 x/z 用主轴；给 dir 直接用；都没给按朝向
 *   ④ 接线：`dig()` 转调、`mc_dig` 暴露 mode/dir/maxSteps、vendor 补丁禁掉「挖脚下」
 */
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { stairDirOf, stairDropOf, STAIR_MAX_STEPS, STAIR_WALK_MS, STAIR_MIN_STEP_MS, STAIR_DROP_OK } from '../src/mining.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const read = (p) => readFileSync(join(ROOT, p), 'utf8')
let pass = 0; let fail = 0
const ok = (cond, label, extra = '') => {
  if (cond) { pass++; console.log(`  ok   ${label}`) } else { fail++; console.log(`  FAIL ${label}${extra ? ' ｜ ' + extra : ''}`) }
}
const section = (t) => console.log(`\n── ${t} ──`)

const mvSrc = read('src/mining.mjs')
const idxSrc = read('index.js')
const patchSrc = read('tools/patch-mc-deps.mjs')

section('1. 常量')
ok(STAIR_MAX_STEPS === 64, '默认最多 64 步')
/* 🔴 2026-11-02 审计（#19）：原来钉着 `STAIR_STEP_MS === 3000`，可那常量根本没人读
 *   （真实每步预算 = `STAIR_WALK_MS`）。断言的应该是"没有那个 3 秒的常量了"。 */
ok(!/export const STAIR_STEP_MS/.test(mvSrc), '不再有"每走一格 3 秒"的死常量（真实预算见 STAIR_WALK_MS）')
ok(/export const STAIR_MAX_STEPS/.test(mvSrc), '常量有导出（测试能拿到）')

section('2. 几何：上下都挖 3 格（fy / fy+1 / fy+2）')
ok(/const cells = \[fy, fy \+ 1, fy \+ 2\]\.map\(/.test(mvSrc),
  '上下同一套：fy / fy+1 / fy+2 三格（2026-10-25 用户「stair往上挖也是挖3格」）')
ok(!/const cells = up/.test(mvSrc), '不再按方向分两套格数')
ok(/const fy = up \? cur\.y \+ 1 : cur\.y - 1/.test(mvSrc), '每步升/降 1 格（没有平台步）')
ok(/const up = start\.y < ty/.test(mvSrc) && /if \(up \? cur\.y >= ty : cur\.y <= ty\)/.test(mvSrc), '目标更高就是上升阶梯（循环按方向判完成）')
ok(/const hollowAhead = !up && isAir\(floor\.name\)/.test(mvSrc) && /STAIR_DROP_OK/.test(mvSrc),
  '脚下是空：往下挖先量落差、≤3 格就下去（2026-10-27 实机 31/115=27% 因此白跑一整趟）')
ok(/names\.some\(\(n\) => isLiquid\(n\)\)/.test(mvSrc), '三格里任何一格是液体就停')

section('3. 平台逻辑')
ok(!/STAIR_PLATFORM_EVERY/.test(mvSrc), '平台逻辑已彻底移除（2026-10-25 用户要求）')

section('4. 方向推导（纯函数）')
const bot = (x, y, z, yaw = 0) => ({ entity: { position: { x, y, z }, yaw } })
{
  const d = stairDirOf(bot(0, 64, 0), { pos: { x: 10, y: 50, z: 2 } })
  ok(d && d.x === 1 && d.z === 0, '目标在东边 ⇒ 朝 x+ 挖')
}
{
  const d = stairDirOf(bot(0, 64, 0), { pos: { x: 2, y: 50, z: -10 } })
  ok(d && d.z === -1 && d.x === 0, '目标在南边（z 小）⇒ 朝 z- 挖')
}
{
  const d = stairDirOf(bot(0, 64, 0), { pos: { x: 3, y: 50, z: 3 } })
  ok(d && Math.abs(d.x) === 1 && d.z === 0, '斜着给 ⇒ 取主轴（dx 与 dz 相等时取 x）')
}
{
  const d = stairDirOf(bot(0, 64, 0), { dir: 'z+' })
  ok(d && d.z === 1 && d.x === 0, 'dir:"z+" 直接用')
}
{
  const d = stairDirOf(bot(0, 64, 0), { dir: 'x-' })
  ok(d && d.x === -1, 'dir:"x-" 直接用')
}
{
  const d = stairDirOf(bot(0, 64, 0), {})
  ok(d && (Math.abs(d.x) === 1 || Math.abs(d.z) === 1), '都不给 ⇒ 按朝向（yaw=0 朝 -z）')
  ok(d && d.z === -1, 'yaw=0 时朝 z-')
}
{
  const d = stairDirOf(bot(0, 64, 0), { pos: { x: 0, y: 50, z: 0 } })
  ok(d === null, '目标就在脚下 ⇒ 算不出方向（返回 null）')
}
{
  const d = stairDirOf({ entity: null }, { dir: 'x+' })
  ok(d === null, '拿不到位置 ⇒ null（不崩）')
}

section('5. dig() 转调')
ok(/if \(mode === 'stair'\) return await digStair\(self, \{ pos, dir, targetY, maxSteps, budgetMs \}, ctx\)/.test(mvSrc),
  'dig() 在 requireBot 之前就转调 digStair（targetY 一起传）')
ok(/mode = 'block', dir = null, targetY = null, maxSteps = STAIR_MAX_STEPS, budgetMs = 10_000,/.test(mvSrc),
  'dig() 参数表有 mode/dir/targetY/maxSteps/budgetMs')
ok(/export async function digStair \(self, \{/.test(mvSrc), 'digStair 有导出')

section('6. 早退与报错')
ok(/已经在 y=\$\{start\.y\}/.test(mvSrc), '已经比目标低就直接说不用挖')
ok(/挖阶梯要知道挖到哪一层/.test(mvSrc), '不给 y 时报清楚的错')
ok(/算不出往哪挖/.test(mvSrc), '算不出方向时报清楚的错')
/* 🔴 2026-10-25 实机 bug：说明写「x/z 可选」，但 index.js 只在 x/y/z 齐全时才组 pos，
 *   于是 `mc_dig {mode:"stair", y:50, dir:"z+"}` 一路报「给 y」——用户明明给了。 */
ok(/const ty = Number\.isFinite\(Number\(targetY\)\) \? Math\.floor\(Number\(targetY\)\)/.test(mvSrc),
  '目标高度优先取 targetY（只给 y 也能用，不需要 x/z）')
ok(/pos && Number\.isFinite\(pos\.y\) \? Math\.floor\(pos\.y\) : null/.test(mvSrc),
  'targetY 没给时退回 pos.y（老写法照样能用）')
ok(/targetY = null, maxSteps = STAIR_MAX_STEPS/.test(mvSrc), 'digStair 参数表有 targetY')

section('7. mc_dig 工具面')
ok(/mode: \{ type: 'string', description: 'block（默认，挖方块）\/ stair（挖阶梯/.test(idxSrc), 'mc_dig 暴露 mode')
ok(/dir: \{ type: 'string', description: 'stair 专用/.test(idxSrc), 'mc_dig 暴露 dir')
ok(/maxSteps: \{ type: 'number', description: 'stair 专用/.test(idxSrc), 'mc_dig 暴露 maxSteps')
ok(/mode: args\.mode === 'stair' \? 'stair' : 'block',/.test(idxSrc), 'execute 把 mode 传下去')
ok(/targetY: Number\.isFinite\(Number\(args\.y\)\) \? Number\(args\.y\) : null,/.test(idxSrc),
  'execute 把 y 作为 targetY 单独传下去（不受 pos 三坐标齐全的限制）')
ok(/别指望 mc_move 挖竖井/.test(idxSrc), '描述里点明 move 不再挖竖井')
ok(/目标 y 比现在低就是往下挖、高就是往上挖/.test(idxSrc), '描述里点明 stair 双向（上/下）')

section('8. vendor 补丁：move「挖脚下」改成加价（2026-10-30 用户：「这个改成代价变高，不要禁止」）')
ok(/move 挖脚下：按挖价乘 3（不禁止）/.test(patchSrc), 'patch 脚本有 getMoveDown 补丁（加价，不禁止）')
ok(/move 斜下挖：按挖价乘 3（不禁止）/.test(patchSrc), 'patch 脚本有 getMoveDropDown 补丁（加价，不禁止）')
/* 形态：最多边挖边掉两格 + 代价乘 digDownFactor。判死那版（if (toBreak.length > 0) return）已废 ——
 * 它让实心柱落差一超 maxDropDown 就永远 NoPath。挖竖井仍归 mc_dig {mode:"stair"}（见第 109 行那条文案）。 */
ok(/if \(toBreak\.length > 2\) return/.test(patchSrc) && /cost \*= \(Number\.isFinite\(f\) && f > 0\) \? f : 3/.test(patchSrc),
  '两处都是「最多两格 + 按挖价乘系数」')

section('9. 结果文案')
ok(/再叫一次 [^ ]{0,3}mc_dig \{mode:"stair", y:/.test(mvSrc), '预算用完时告诉它怎么接着挖')
ok(/前面是水\/岩浆/.test(mvSrc), '遇到水/岩浆有明确说明')
ok(/climbed !== 0/.test(mvSrc), '卡住时区分"推进了"和"一步没动"（2026-10-27 用户 m02756「dig 和 move 根本不准确」）');

section('10. 往上挖：自己头顶也要清（跳跃空间）+ 走失败要重试')
{
  ok(/if \(up\) \{\s*\n\s*for \(const hy of \[cur\.y \+ 1, cur\.y \+ 2\]\)/.test(mvSrc),
    '往上时清自己站位上方 2 格（2026-10-26 用户「往上挖还是只挖两格会被卡住」）')
  ok(/自己站位上方 2 格净空/.test(mvSrc), '注释写清了为什么：跳跃要自己头顶 2 格净空')
  const headAt = mvSrc.indexOf('if (up) {')
  const cellsAt = mvSrc.indexOf('for (const c of cells) {')
  ok(headAt > 0 && cellsAt > headAt, '先清头顶、再挖前方（顺序不能反：头顶不清跳不上去）')
  ok(/头顶是液体时不挖/.test(mvSrc) === false && /isLiquid\(head\.name\)/.test(mvSrc), '头顶是液体时不挖（只记一条 notes）')
  ok(/const w2 = await self\.walkTo/.test(mvSrc), '第一次没走过去会再走一次（不是一步就 stuck）')
  /* 2026-11-05：需要抬升的那一步不再问 A*（needRise），所以重试条件多了 !needRise 前置 */
  ok(/if \(!ok && !needRise && budgetMs - \(Date\.now\(\) - t0\) >= STAIR_MIN_STEP_MS\)/.test(mvSrc),
    '重试也看剩余时间（不硬吃满预算，2026-10-27）')
  ok(/const needRise = up && standY > fy/.test(mvSrc), '需要抬升的这一步不交给 A*（它只会算“绕过去”＝往后退）')
  ok(/let ok = !needRise && \(w\?\.arrived/.test(mvSrc), 'needRise 时 ok 只认跳上去（不能靠 walkTo 的假成功）')
  ok(/脚下是 \$\{floorName\}/.test(mvSrc) && /自己头顶是 \$\{myHead1\}\/\$\{myHead2\}/.test(mvSrc),
    '真卡住时报出目标格脚下/头顶 + 自己头顶两格（2026-10-29：以前只说"头顶堵着"，出现过自相矛盾）')
}

section('11. 结果文案不能说反话：y 75→70 别报"卡住"、别出现"挖了 23 步、0 块方块"')
{
  /* 现场（session-514c21b6）：`挖了 23 步、0 块方块`（其实是沿早先挖好的阶梯走上去的），
   * 以及每轮明明推进了 5 格（y 75→70）还报「⛔ 挖开了但没走过去（卡住）」。 */
  ok(/dug > 0\s*\n?\s*\?\s*`挖了 \$\{steps\} 步、\$\{dug\} 块方块/.test(mvSrc),
    '只有真挖了方块才说"挖了 N 步、M 块"')
  ok(/走了 \$\{steps\} 步（没挖方块，沿已有通道）/.test(mvSrc),
    '一块没挖时如实说"走了 N 步"（不再出现"挖了 23 步、0 块方块"）')
  ok(/最后一步没走成，但这一轮已经从 y=\$\{start\.y\} 走到 y=\$\{now\.y\}/.test(mvSrc),
    '有推进时卡住要说清"这一轮已经推进到哪"')
  ok(/一步都没走动（还停在 y=\$\{now\.y\}）/.test(mvSrc), '真没动时才说"一步都没走动"')
  /* 断言要钉在**代码**上而不是注释上：旧断言 `/挖开了但没走过去/` 会命中历史注释，
   * 等于永远绿（假断言）。这条反过来：注释里可以留档，代码里不许再有。 */
  const codeOnly = mvSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
  ok(/挖开了但没走过去/.test(codeOnly) === false, '旧文案"挖开了但没走过去"已从代码里删掉')
}

console.log(`\n${'─'.repeat(60)}`)

section('12. 每步预算跟着剩余时间走（时间到 ≠ 卡住）+ 前方矿洞量落差')
{
  /* 🔴 2026-10-27 实机（两个会话 115 次 stair 调用，57 次报"卡住"= 50%，用户：「一半是失败的」）：
   *   其中 41 次耗时 ≥9.5 秒 —— 每步平均 1.72 秒，10 秒只够 6 步，最后那一步必然越过预算边界
   *   （走 walkTo 固定给 3 秒，而循环顶部只在开始前看预算）⇒ "时间到"被写成"卡住"。 */
  ok(STAIR_WALK_MS === 1500, '每步走路预算 1.5 秒（实测每步 1.72 秒，以前固定 3 秒必然越界）')
  ok(STAIR_MIN_STEP_MS === 1200, '剩余不足 1.2 秒就收工成 budget')
  ok(STAIR_DROP_OK === 3, '前方矿洞最多往下 3 格（不摔伤）')
  ok(/if \(budgetMs - \(Date\.now\(\) - t0\) < STAIR_MIN_STEP_MS\) \{ reason = 'budget'; break \}/.test(mvSrc),
    '循环开头：剩余不够一步 ⇒ budget（不再只看"开始前已超"）')
  /* 🔴 2026-10-29（预算收口）：这条以前钉的是 `Math.max(600, …)` 这个**写法**，
   *    所以改成 `needLeft`时它就红了。改钉行为：预算由 needLeft 算、且不再压 600 下限。 */
  ok(/const nbStep = needLeft\(self, 600, Math\.min\(STAIR_WALK_MS, budgetMs - \(Date\.now\(\) - t0\)\)\)/.test(mvSrc)
    && !/Math\.max\(600,/.test(mvSrc),
    '每步走路预算 = needLeft(600, min(1.5 秒, 剩余))（剩余不够就收工，不压下限）')
  ok((mvSrc.match(/budget: stepBudget/g) ?? []).length === 2, '两处 walkTo（首走 + 重试）都用 stepBudget（键名必须是 budget —— 写 budgetMs 会被静默丢掉）')
  ok(/budgetMs: STAIR_STEP_MS/.test(mvSrc) === false, '不再有固定 3 秒的 walkTo')
  ok(/时间到被砍断 ≠ 卡住/.test(mvSrc), '注释写清了为什么：时间到不许报卡住')
  ok(/< STAIR_MIN_STEP_MS\) \{ reason = 'budget'; break \}/.test(mvSrc)
    && mvSrc.lastIndexOf("reason = 'budget'") < mvSrc.lastIndexOf("reason = 'stuck'"),
    'stuck 之前先判一次预算（顺序不能反）')
  ok(/卡在 \$\{cur\.x\},\$\{cur\.y\},\$\{cur\.z\}：要去的/.test(mvSrc),
    '真卡住时把坐标/脚位/头顶写出来（省一趟 mc_observe）')
  ok(/const hollowAhead = !up && isAir\(floor\.name\)/.test(mvSrc), '前方脚下空：只有往下挖才量落差')
  ok(/mv\.stepUp\(b, new Vec3\(fx, standY, fz\)/.test(mvSrc) && /await import\('\.\/movement\.mjs'\)/.test(mvSrc),
    '两次 walkTo 都没成 ⇒ 用 stepUp 硬跳一次（不走 A*，动态 import 避开循环依赖）')
  ok(/if \(up \? now\.y >= ty : now\.y <= ty\) \{ reason = 'done'; break \}/.test(mvSrc),
    '已经到目标高度就报 done，不报卡住（2026-10-29「它挖到地表了，然后就报了」）')
  /* 🔴 2026-11-05 改语义（用户：「dig stair 现在周围有空气就不挖，应该找最近的墙往上挖」）：
   *   旧断言钉的是“前方脚下是空 ⇒ 立刻 no-floor 收工”，那会让站在矿洞里的人明明三面都是墙
   *   却一步也挖不了。现在的规矩是：**先横着换一面墙继续，换满 3 次还找不到才报 no-floor**；
   *   仍然不允许把“上升”挖成“坠落”（no-floor 依然是个 reason，只是晚一点）。 */
  /* 2026-11-05（用户「嗯」= 同意“走到最近的墙”）：四邻都没墙时自己走过去 */
  ok(/const findWallSpotAhead = \(from, dir, isUp, maxR = WALL_SCAN_AHEAD\)/.test(mvSrc),
    '沿 dir 方向找墙位（不再四邻乱找）')
  /* 🔴 2026-11-05 实机直接把 `dig stair` 跑崩了：`diggableBlock` 是 movement.mjs 的导出，
   *   mining.mjs 没导入（两者还有静态循环依赖）⇒ `Error: diggableBlock is not defined`。
   *   静态断言抓不到运行期，但这一条至少拦住“再把它写回来”。 */
  ok(!/\bdiggableBlock\b/.test(mvSrc), 'mining.mjs 不引用 movement 的 diggableBlock（没导入会 ReferenceError）')
  ok(/canBreakNow\(b, [a-z]\)/.test(mvSrc), '找墙时用本地已导入的 canBreakNow 判能不能挖')
  /* 2026-11-05（用户：「如果 dig stair 没跳上去会后退」）：失败时先回原位，别拿被顶开的坐标当新起点 */
  ok(/const cur0 = \{ x: cur\.x, y: cur\.y, z: cur\.z \}/.test(mvSrc), '每步记住起点 cur0')
  ok(/const off = Math\.hypot\(now\.x - cur0\.x, now\.z - cur0\.z\)/.test(mvSrc),
    '跳失败被顶开后尝试走回原位')
  /* 🔴 2026-11-05 实机（用户：「dig stair 现在挖着挖着会换位置挖」）：
   *   上一版“走回原位”不看走没走到就把 cur 改回原点 ⇒ 目标格按原点算、人却站在两格外，
   *   之后每次 stepUp 都在跳一个够不着的格子（日志：「↪ 前方脚下是空的 → 换一面墙」来回切）。
   *   规矩改成：cur 永远取人的真实位置。 */
  ok(/const real = await settleGround\(b, 300\)/.test(mvSrc), '失败后读一次真实位置（并等落地）')
  ok(/backOk = bck\?\.arrived === true/.test(mvSrc), '走回原位要看 walkTo 到底到没到')
  /* 🔴 2026-11-05 实机（用户：「stair 还是会后退」）：`stepUp` 返回 ok 只代表“离地抬高了”，
   *   那一刻人还在空中。直接 floor() 取坐标 ⇒ cur 记成空中高度（y=46）⇒ 人落回 y=42 ⇒
   *   下一步目标凭空高 5 格 ⇒ 跳不上去、反复重试、越挖越后退。
   *   规矩：**凡是刚跳完就取坐标，一律先等落地**（settleGround）。 */
  ok(/const settleGround = async \(maxMs = 500\) => \{/.test(mvSrc), '有 settleGround（等 y 稳定两次再取坐标）')
  ok(/const nowH = await settleGround\(b, 700\)/.test(mvSrc), '★ 先跳一次成功后等落地再取 cur')
  ok(!/const nowH = b\.entity\.position\.floored\(\)/.test(mvSrc), '不许在跳起瞬间直接取坐标')
  ok(/cur = real/.test(mvSrc), '★ cur 取真实位置（目标永远按人真正站的地方算）')
  ok(!/cur = \{ x: cur0\.x, y: cur0\.y, z: cur0\.z \}/.test(mvSrc),
    '不再把 cur 硬改回原点（那会造成“目标在人够不着的地方”）')
  ok(/reason = 'no-floor'/.test(mvSrc) && /都没有能往上挖的墙/.test(mvSrc),
    '换满 3 次还找不到墙才报 no-floor，并叫人先走到岩壁边上')
  ok(!/if \(up && isAir\(floor\.name\)\) \{ reason = 'no-floor'; break \}/.test(mvSrc),
    '旧的“一脚踩空就收工”写法已不存在')
  ok(/这次 \$\{Math\.round\(budgetMs \/ 1000\)\} 秒/.test(mvSrc), '预算文案写实际分到几秒，不再写死 10 秒')

  /* 纯函数：量落差（`stairDropOf` 只认 blkAt，注假世界即可测） */
  const mkWorld = (holes, lava = new Set()) => (x, y, z) => {
    const k = `${x},${y},${z}`
    if (lava.has(k)) return { name: 'lava' }
    return { name: holes.has(k) ? 'air' : 'stone' }
  }
  {
    /* cur.y=64 往下挖 ⇒ fy=63；前方 62/63 空、61 实心 ⇒ 站到 62（掉 2 格） */
    const w = mkWorld(new Set(['7,62,7', '7,63,7']))
    const dr = stairDropOf(w, 7, 63, 7)
    ok(dr && dr.stand === 62 && dr.below === 'stone', '落差 2 格 ⇒ 站到 y=62（不摔伤，继续挖）')
  }
  {
    const w = mkWorld(new Set(['7,62,7', '7,61,7', '7,60,7', '7,59,7']))
    ok(stairDropOf(w, 7, 63, 7) === null, '落差超过 3 格 ⇒ null（不往深洞跳）')
  }
  {
    const w = mkWorld(new Set(['7,62,7', '7,63,7']), new Set(['7,61,7']))
    ok(stairDropOf(w, 7, 63, 7)?.liquid === true, '底下是岩浆 ⇒ liquid（不跳）')
  }
  {
    /* 61 实心、62 是石头 ⇒ 落点被堵，掉不进一格缝 */
    const w = mkWorld(new Set(['7,63,7']))
    ok(stairDropOf(w, 7, 63, 7) === null, '落点那格被堵 ⇒ null（不硬塞）')
  }
}

/* 🔴 2026-11-05 用户：「不要自动换向，我要的是 ai 输入 x+，自动到靠近挖 x+ 的墙开始挖」。
 *   于是：方向由 dir 锁死；前面没台阶面就沿这个方向走过去找墙，绝不换面。
 *   这一组断言就是防止“换面 / 四邻乱找”偷偷回来。 */
{
  const mvS = readFileSync(new URL('../src/mining.mjs', import.meta.url), 'utf8')
  ok(/const WALL_SCAN_AHEAD = 8/.test(mvS), '沿 dir 前扫 8 格找墙')
  ok(!/pickStairDir\b/.test(mvS), '★ 没有“换一面墙”这套了（用户明确不要自动换向）')
  ok(!/findNearestWallSpot/.test(mvS), '不再四邻乱找墙（那会让 stair 左右横跳）')
  ok(!/\bd = nd\b/.test(mvS) && !/\bd = spot\.dir\b/.test(mvS), '★ dir 一旦给了就不再改')
  ok(/const huntAlongDir = async \(whyText, isUp\) =>/.test(mvS), '前方没台阶面 ⇒ 沿 dir 走过去找墙')
  ok(/if \(await huntAlongDir\(`前方 \$\{fx\},\$\{fy\},\$\{fz\} 没有台阶面（踩不住）`/.test(mvS),
    '往上挖时走这条；找不到就如实报 no-wall')
}
/* 🔴 2026-11-05 线上连着两次 `xxx is not defined`，根子是同一类错：在 mining.mjs 里直接用了
 *   movement.mjs 的导出（先是 `diggableBlock`，后是 `canStandAt`），既没 import（两个模块互相
 *   import 会成环）、也不是 mining 自己定义的 ⇒ 静态 `node --check` 查不出来，只有实机调用那一刻才炸。
 *   这里做一次通用守门：movement 的导出名只要在 mining 里以**裸标识符**出现，就必须是“自己定义”或
 *   “从别处导入”的。（`mv.stepUp(...)` 这种属性访问不算 —— 前面那个点已经排除了。） */
{
  const mvFile = read('src/movement.mjs')
  const mvExports = [...new Set([...mvFile.matchAll(/export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g)].map((m) => m[1]))]
  const minBare = mvSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
  const leaked = mvExports.filter((n) => {
    /* 只认“当成函数调用”的裸标识符：`f(` 且前一个字符不是点/标识符。
     * 属性访问（`mv.stepUp(`）、对象键（`{ jump: true }`）都不算。 */
    if (!new RegExp('(?<![.\\w$])' + n + '\\s*\\(').test(minBare)) return false
    if (new RegExp('(?:function|const|let|var|class)\\s+' + n + '\\b').test(minBare)) return false
    if (new RegExp('import[^;\\n]*\\b' + n + '\\b[^;\\n]*from').test(minBare)) return false
    return true
  })
  ok(leaked.length === 0, 'mining.mjs 里没有“借用了 movement 的导出却没导入”（成环 import 会 ReferenceError）', leaked.join(', '))
}

/* 🔴 2026-11-05 用户：「stair 为什么会被卡住 / 一直后退」—— 三条互相咬合的死锁，这里各留一条守门。 */
{
  const mvS = readFileSync(new URL('../src/movement.mjs', import.meta.url), 'utf8')
  const mnS = readFileSync(new URL('../src/mining.mjs', import.meta.url), 'utf8')

  /* ① 核心死锁：digStair 先把前方那格挖空，stepGeometryOf 就判“前方不是台阶”⇒ no-step 拒绝跳。
   *    现在补了“目标格本身能站就直接跳”的分支。 */
  ok(/if \(!geo0\) \{/.test(mvS) && /目标格本身已经能站/.test(mvS),
    '★ 目标格已挖空也能跳（不再因为“前方不是台阶”报 no-step）')
  ok(/let geo0 = stepGeometryOf\(b, target, \{ cells \}\)/.test(mvS), 'geo0 可被合成（不再是 const）')
  ok(/standY: ty2,[\s\S]{0,80}canStandOnTop: true/.test(mvS), '合成的台阶几何把落脚高度设成目标格本身')

  /* ② 锚点只前进：失败时绝不把 cur 改成人的真实位置（那就是“一直后退”）。 */
  ok(/if \(ok\) cur = now/.test(mnS), '★ 锚点只前进（成功才更新）')
  /* 注意：注释里也写着 `cur = real`（解释为什么删掉它），所以只能钉“缩进后的真代码行”。 */
  ok(!/\n\s*cur = real\s*\r?\n/.test(mnS)
    && (mnS.match(/\n\s*cur = b\.entity\.position\.floored\(\)\s*\r?\n/g) || []).length === 1,
    '失败时不再把锚点改成真实位置（只剩“走到墙位后重新取锚点”那一处对的）')
  ok(/没走回原位[\s\S]{0,200}下一步仍然按原锚点算/.test(mnS), '走不回原位时如实说出来，并向模型保证不会跟着退')

  /* ③ 高度对了还不够：跳上旁边一格不算这一步。 */
  ok(/const stayedHere = Math\.hypot\(nowH\.x - fx, nowH\.z - fz\) <= 0\.9/.test(mnS),
    '★ 跳成功要真落在目标那一格（水平 ≤0.9），否则不算这一步')
}

  /* 🔴 2026-11-05 `Error: dirNameOf is not defined`：它原来定义在被“删 39 行换向死代码”清掉的
   *   `pickStairDirAt` 里，而 `huntAlongDir` 的日志还在用它。这是第 4 次“用了却没定义/没导入”的
   *   事故（前三次：`diggableBlock`、`canStandAt`、`carveNoPathOk`）。`node --check` 只查语法，查不出。 */
  {
    const mnD = readFileSync(new URL('../src/mining.mjs', import.meta.url), 'utf8')
    ok(!/dirNameOf\(/.test(mnD) || /const dirNameOf = \(v\) =>/.test(mnD),
      '★ 用了 dirNameOf 就必须有定义（删函数别把调用点落下）')
  }
console.log(`check-mc-stair：pass=${pass} fail=${fail}`)
process.exit(fail ? 1 : 0)

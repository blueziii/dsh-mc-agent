#!/usr/bin/env node
/**
 * check-mc-pathfinder.mjs —— vendor 里那份 mineflayer-pathfinder 的补丁体检
 *
 * 补的是哪个坑（实机复现于 2026-10-14，用户原话「还是动不了」）：
 *   机器人被 1 格台阶 / 墙角挡住时，`lib/physics.js` 的 `canStraightLine` 会给出**假阳性** ——
 *   直走模拟是从机器人**当前**位置起算的，而机器人被自己的 forward 顶在墙上时，真实位置
 *   已经扎进方块几个百分点；prismarine-physics 在「起点已穿模」的情况下拦不住继续往墙里走，
 *   于是模拟报告「我能直着走到下一个节点」。执行器（`index.js:614`）据此把 jump 关掉，
 *   机器人就直着撞墙角，3.5 秒后 `resetPath('stuck')`，重算同一条路，永远磨在那里。
 *
 * 补丁（三处）：
 *   ① 新增 `collides(pos)` —— 按 `block.shapes` 判玩家 AABB 是否**真正**与实体方块重叠
 *      （碰着不算；用 shapes 而不是 `boundingBox === 'block'`，免得把半砖/台阶误判成墙）。
 *   ② 新增 `simulateStraight()`，并在 `canStraightLine` 里用它 —— 第 0 刻不查（起点本来
 *      就可能贴着墙），从第 1 刻起一旦扎进方块就立刻停下并标 `blocked`；`blocked` 的模拟
 *      不算「能直走」，于是执行器落到 `canSprintJump` / `canWalkJump` 分支，真的跳一下。
 *   ③ `lib/movements.js` 的 `getMoveDiagonal` 里加 `if (cost1 > 0 || cost2 > 0) return` ——
 *      **不许「斜切拐角」**。① ② 只是把「假阳性」修掉，实机验证证明光这样还不够：执行器改成
 *      跳之后，机器人在半空扎进台阶角，落地时 x/z 两个轴的 clip 一起变 0，反而卡死。
 *      真正的病根是 `getMoveDiagonal` 会从 (-3,66,5) 直接给出对角节点 (-2,66,4)，绕过实体方块
 *      (-2,66,5) —— 真人会沿墙滑（x 挡住、z 继续）走出去，**mineflayer 不会**：AABB 一旦扎进
 *      方块 0.01 格，两个轴同时锁死。禁掉斜切后 A* 改走「先北后东」，执行器瞄的是正交节点，
 *      实机朝北 2 秒能走 8.37 格 ⇒ 走得出去。
 *
 * 用法：node tools/check-mc-pathfinder.mjs [vendor 目录]
 */
import { readFileSync, existsSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'

const HERE = dirname(fileURLToPath(import.meta.url))

// ── 找 vendor 树（和 check-mc-deps.mjs 同一套候选）──────────────────────────────
function pickVendor () {
  const arg = process.argv.slice(2).find((a) => !a.startsWith('--'))
  const cands = [
    arg,
    process.env.DSH_MC_AGENT_MC_DEPS,
    resolve(HERE, '../../../vendor/mc-deps'),
    join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'profiles', 'desktop', 'vendor', 'mc-deps'),
  ].filter((p) => typeof p === 'string' && p && existsSync(p))
  return cands[0] ?? null
}

const VENDOR = pickVendor()
if (!VENDOR) {
  console.log('✗ 找不到 vendor 树 —— 用参数指定：node tools/check-mc-pathfinder.mjs <vendor 目录>')
  process.exit(2)
}
const PF_DIR = join(VENDOR, 'node_modules', 'mineflayer-pathfinder')

let pass = 0, fail = 0
const ok = (cond, label, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${label}${extra ? ' — ' + extra : ''}`) } else { fail++; console.log(`  ✗ ${label}${extra ? ' — ' + extra : ''}`) }
}
const section = (t) => console.log(`\n${t}`)

// ── 1. 补丁在不在（源码文本）───────────────────────────────────────────────────
section('1. 补丁在不在')
const physicsSrc = existsSync(join(PF_DIR, 'lib', 'physics.js')) ? readFileSync(join(PF_DIR, 'lib', 'physics.js'), 'utf8') : ''
const indexSrc = existsSync(join(PF_DIR, 'index.js')) ? readFileSync(join(PF_DIR, 'index.js'), 'utf8') : ''
const coreSrc = existsSync(join(HERE, '..', 'src', 'core.mjs')) ? readFileSync(join(HERE, '..', 'src', 'core.mjs'), 'utf8') : ''
// 第二十九刀起 `movements()`（`walkAllowParkour` 的读点）搬进了 src/plugins.mjs；
// 导航 P2（2026-10-15）起那几行权重改由 `src/terrain.mjs` 的地形档案铺上去，
// 配置键登记在 `TERRAIN_CFG_KEYS` —— 所以两处都要看。
const plugSrc = existsSync(join(HERE, '..', 'src', 'plugins.mjs')) ? readFileSync(join(HERE, '..', 'src', 'plugins.mjs'), 'utf8') : ''
const terrainSrc = existsSync(join(HERE, '..', 'src', 'terrain.mjs')) ? readFileSync(join(HERE, '..', 'src', 'terrain.mjs'), 'utf8') : ''

ok(/collides\s*\(pos\)/.test(physicsSrc), 'physics.js 有 collides(pos)（按 shapes 判真正重叠）')
ok(/simulateStraight\s*\(/.test(physicsSrc), 'physics.js 有 simulateStraight()')
ok(/straight\.blocked/.test(physicsSrc), 'canStraightLine 里认 blocked（撞进方块就不算能直走）')
ok(/block\.shapes/.test(physicsSrc), 'collides 用 block.shapes 判（半砖/台阶不会误判成墙）')
ok(/allowSprinting\s*&&\s*physics\.canSprintJump\(path\)/.test(indexSrc), 'index.js 里 canSprintJump → jump=true 的分支还在（返回 false 才会走到这里）')
ok(/profileFor\(terrain\?\.kind/.test(plugSrc), 'movements() 按地形取权重（导航 P2）')
ok(/allowParkour: 'walkAllowParkour'/.test(terrainSrc), 'walkAllowParkour 配置键登记在 terrain.mjs 的 TERRAIN_CFG_KEYS 里（默认关）')
ok(/from '\.\/plugins\.mjs'/.test(coreSrc), 'core.mjs 确实从 plugins.mjs 取装配（搬走 + 忘接 = 这条会红）')
/* 🔴 2026-10-23（二档，来源 mindcraft 的 pathfinder 补丁）：脚那一格是木门/栅栏门/活板门时，
 * vendor 的 `postProcessPath` 会走进 `getPositionOnTopOf` —— minecraft-data 里门的 boundingBox
 * 一律是 `block`（开没开都一样），它于是算出"门顶上方"那个点，把路径点抬高一格 ⇒
 * 机器人对着门往上撞。补丁 = 门那一格直接瞄格心（y 不变）。 */
ok(/const doorHere = Boolean\(b && typeof b\.name === 'string'/.test(indexSrc) && /const doorHere[\s\S]{0,400}?curPoint\.y = Math\.floor\(curPoint\.y\)/.test(indexSrc),
  'index.js 的 postProcessPath 认门（门格瞄格心，不抬到门顶上）')

/* 🔴 2026-10-24 用户实机：「正在垫方块往上爬，悬空超过 3 秒才掉下来」。
 *    根因在 vendor `index.js` 的 placing 分支：
 *      ① 垫柱时先 `setControlState("jump", true)` 再判断够不够高，达不到就 `return` ——
 *         而这条 return 在 3500ms 卡住检测**之前**，于是永远轮不到超时恢复，jump 一直按着；
 *      ② 装备失败 `.catch(_ignoreError => {})` 什么都不做 ⇒ `lockEquipItem` 永不释放、
 *         `placing` 永远为 true ⇒ 每 tick 都在 `tryAcquire` 处 return，永久卡死。 */
ok(/let placingStartedAt = 0/.test(indexSrc) && /resetPath\('place_jump_timeout'\)/.test(indexSrc),
  '垫柱跳跃有专用超时：达不到放置高度时松开 jump 并结束这条路径（不再绕过 3500ms 卡住检测）')
ok(/let placingBestY = 0/.test(indexSrc), '垫柱跳每跳记下最高点（有进展就重计时）')
ok(/inWater \? 6000 : 1500/.test(indexSrc), '水里垫柱放宽到 6 秒（上浮只有 ~0.6 格/秒）')
ok(/resetPath\('equip_error'\)/.test(indexSrc),
  '装备失败会释放锁并结束这条路径（不再永久卡在 placing 状态）')

/* 🔴 2026-10-24 寻路通审（用户：「完全卡住，tp 也不行，最后重进才好」）：
 *    挖掘分支的 `return` 同样排在 3500ms 卡住检测**之前**，而 `digging` 只靠
 *    diggingAborted/diggingCompleted 事件复位 —— 服务端不回包时这两个事件永远不来，
 *    `digging` 就永远是 true，之后**每一次移动**都在挖掘分支 return ⇒ 永久卡死。 */
ok(/let digStartedAt = 0/.test(indexSrc) && /resetPath\('dig_timeout'\)/.test(indexSrc),
  '挖掘分支有超时（digTimeout）：服务端不回包时不会永久粘在 digging=true')
ok(/if \(digging\) \{[\s\S]{0,400}?digging = false/.test(indexSrc),
  'resetPath 直接把 digging 复位，不再只靠事件（事件可能永远不来）')
ok(/resetPath\('dig_equip_error'\)/.test(indexSrc),
  '挖前装备失败就结束这条路径，而不是拿错工具硬挖')
ok(/resetPath\('use_block_error'\)/.test(indexSrc),
  '开门/按按钮失败会结束这条路径（不再无限重试同一扇门）')
ok(/!movements\.emptyBlocks\.has\(b\.type\)/.test(indexSrc),
  '起点 +1 偏移用传入的 movements 判断（不是全局 stateMovements）')
const gotoSrc = existsSync(join(PF_DIR, 'lib', 'goto.js')) ? readFileSync(join(PF_DIR, 'lib', 'goto.js'), 'utf8') : ''
ok(/status === 'noPath'\)[\s\S]{0,300}?path\.length === 0\)/.test(gotoSrc),
  'goto.js 先判 noPath 再判空路径（「无路可走」不再被当成「到了」）')

// ── 假世界：一小片地板 + 那个 1 格台阶 + 一块半砖 + 一条 1 格宽走廊 ────────────────
const FULL = [[0, 0, 0, 1, 1, 1]]
const grid = new Map()
const put = (x, y, z, shapes, name = 'grass_block') => grid.set(`${x},${y},${z}`, { name, shapes, boundingBox: 'block' })
for (let x = -6; x <= 3; x++) for (let z = 2; z <= 8; z++) put(x, 65, z, FULL)   // 地板 y=65
put(-2, 66, 5, FULL)                                                             // 那个 1 格台阶（实机卡点）
put(2, 65, 5, [[0, 0, 0, 1, 0.5, 1]], 'stone_slab')                              // 半砖
put(-1, 66, 5, FULL)                                                             // 走廊左墙
put(1, 66, 5, FULL)                                                              // 走廊右墙

const V = (x, y, z) => ({
  x, y, z,
  clone () { return V(this.x, this.y, this.z) },
  minus (o) { return { x: this.x - o.x, y: this.y - o.y, z: this.z - o.z } },
  offset (dx, dy, dz) { return V(this.x + dx, this.y + dy, this.z + dz) },
  floored () { return V(Math.floor(this.x), Math.floor(this.y), Math.floor(this.z)) }
})

let step = 0.25
const makeBot = (pos) => ({
  entity: { position: V(pos.x, pos.y, pos.z) },
  controlState: { forward: false, back: false, left: false, right: false, jump: false, sprint: false, sneak: false },
  blockAt: (p) => grid.get(`${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`) ?? null,
  physics: {
    // 假模拟器：每刻朝当前控制器瞄的那个点挪 step 格（x/z 各一步）。
    // 真 physics 在「起点已穿模」时就是这样一路挪进墙里的。
    simulatePlayer (state, world) {
      const dx = state._tx - state.pos.x
      const dz = state._tz - state.pos.z
      if (Math.abs(dx) > 1e-6) state.pos.x += Math.sign(dx) * Math.min(step, Math.abs(dx))
      if (Math.abs(dz) > 1e-6) state.pos.z += Math.sign(dz) * Math.min(step, Math.abs(dz))
      state.onGround = true
      state.isInWater = false
      state.isInLava = false
    }
  }
})

const req = createRequire(join(PF_DIR, 'index.js'))
const Physics = req(join(PF_DIR, 'lib', 'physics.js'))

// 给第 5 节用的真 registry（Movements 的构造函数要它；版本随便挑一个能加载的）
let mcData = null
for (const v of ['1.21.9', '1.21.4', '1.21.1', '1.20.4', '1.16.5']) {
  try { mcData = req('minecraft-data')(v); break } catch { /* 换下一个 */ }
}
if (!mcData) {
  console.log('✗ 加载不了 minecraft-data，第 5 节没法跑')
  process.exit(2)
}

// 真 getController 只设 yaw / control，假模拟器需要知道「朝哪个点走」——在实例上补一层，
// 这样 Physics 内部自己造的控制器（canSprintJump / canWalkJump）也会带上目标点。
const makePhys = (bot) => {
  const phys = new Physics(bot)
  phys.newPlayerState = () => ({ pos: bot.entity.position.clone(), control: {}, onGround: true, isInWater: false, isInLava: false })
  const realGetController = phys.getController.bind(phys)
  phys.getController = (target, jump, sprint, jumpAfter = 0) => {
    const ctrl = realGetController(target, jump, sprint, jumpAfter)
    return (state, tick) => { ctrl(state, tick); state._tx = target.x; state._tz = target.z }
  }
  return phys
}

// ── 2. collides() ─────────────────────────────────────────────────────────────
section('2. collides()：贴墙穿模算、正常站着不算')
{
  const bot = makeBot(V(-2.3, 66, 5.5))
  const phys = makePhys(bot)
  ok(phys.collides(V(-2.06, 66, 5.5)) === true, '身体扎进台阶 0.06 格 → 算碰撞（实机假阳性的起点）')
  ok(phys.collides(V(-2.30, 66, 5.5)) === false, '贴着台阶但没穿模（AABB 正好擦到）→ 不算')
  ok(phys.collides(V(-3.00, 66, 5.5)) === false, '台阶左边一格 → 不算')
  ok(phys.collides(V(2.5, 65.5, 5.5)) === false, '站在半砖顶面 → 不算（shapes 判据的用处）')
  ok(phys.collides(V(0.5, 66, 5.5)) === false, '1 格宽走廊正中 → 不算')
  ok(phys.collides(V(0.8, 66, 5.5)) === true, '同一走廊里往右挤到 0.8 → 算（右边是墙）')
}

// ── 3. simulateStraight() 的 blocked 标记 ─────────────────────────────────────
section('3. simulateStraight()：撞进方块就标 blocked')
{
  const bot = makeBot(V(-2.3, 66, 5.5))
  const phys = makePhys(bot)
  const path = [V(-1.5, 66, 4.5)]
  const reached = phys.getReached(path)
  const straight = phys.simulateStraight(reached, phys.getController(path[0], false, true), 200)
  ok(straight.blocked === true, '朝台阶斜着走 → blocked=true')
  ok(reached(straight.state) === false, '撞进方块时模拟就停了，没把这次当成「到了」')
  ok(reached(phys.simulateUntil(reached, phys.getController(path[0], false, true), 200)) === true,
    '同一段路若不管穿模，模拟确实会「到」 —— 这就是假阳性的来源')

  const bot2 = makeBot(V(-4.5, 66, 5.5))
  const phys2 = makePhys(bot2)
  const path2 = [V(-3.0, 66, 5.5)]
  const reached2 = phys2.getReached(path2)
  const clear = phys2.simulateStraight(reached2, phys2.getController(path2[0], false, true), 200)
  ok(clear.blocked === false, '空地上直着走 → blocked=false')
  ok(reached2(clear.state) === true, '空地上直着走 → 到得了')
}

// ── 4. canStraightLine() 不再假阳性 ───────────────────────────────────────────
section('4. canStraightLine()：补丁前误判、补丁后不误判')
{
  const bot = makeBot(V(-2.3, 66, 5.5))
  const phys = makePhys(bot)
  const path = [V(-1.5, 66, 4.5)]
  const reached = phys.getReached(path)

  // 补丁前的老写法：simulateUntil + reached
  const oldWay = reached(phys.simulateUntil(reached, phys.getController(path[0], false, true), 200))
  ok(oldWay === true, '老写法（simulateUntil+reached）在实机卡点上会误判成「能直走」')
  ok(phys.canStraightLine(path, true) === false, '补丁后 canStraightLine 说「不能直走」→ 执行器会跳')

  // 跳一下真的能到（执行器下一步就会走这个分支）
  ok(phys.canSprintJump(path) === true, 'canSprintJump 为真 → index.js:617 分支会 setControlState(jump,true)')

  const bot2 = makeBot(V(-4.5, 66, 5.5))
  const phys2 = makePhys(bot2)
  const path2 = [V(-3.0, 66, 5.5)]
  ok(phys2.canStraightLine(path2, true) === true, '空地上走还是照旧算「能直走」（没把正常走路改坏）')
}

// ── 5. getMoveDiagonal() 不再「斜切拐角」──────────────────────────────────────
section('5. getMoveDiagonal()：斜切拐角被禁（这才是实机真正的病根）')
{
  const Movements = req(join(PF_DIR, 'lib', 'movements.js'))
  const Block = req('prismarine-block')(mcData)
  const Vec3 = req('vec3').Vec3 ?? req('vec3')

  const cells = new Map()
  const key = (x, y, z) => `${x},${y},${z}`
  const fill = (x, y, z, name) => {
    const b = Block.fromStateId(mcData.blocksByName[name].defaultState, 0)
    b.position = new Vec3(x, y, z)
    cells.set(key(x, y, z), b)
  }
  for (let x = -7; x <= 3; x++) for (let y = 64; y <= 68; y++) for (let z = 1; z <= 9; z++) fill(x, y, z, 'air')
  for (let x = -7; x <= 3; x++) for (let z = 1; z <= 9; z++) fill(x, 65, z, 'grass_block')

  const mvBot = {
    registry: mcData,
    username: 'check',
    entity: { position: V(-2.5, 66, 5.5), username: 'check', effects: [] },
    entities: {},
    pathfinder: { bestHarvestTool: () => null },
    blockAt: (p) => cells.get(key(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z))) ?? null
  }
  const mv = new Movements(mvBot)
  const node = { x: -3, y: 66, z: 5, remainingBlocks: 0 }
  const NE = { x: 1, z: -1 }

  fill(-2, 66, 5, 'grass_block')                     // 实机那个 1 格台阶（东边）
  const nb1 = []
  mv.getMoveDiagonal(node, NE, nb1)
  ok(nb1.length === 0, '台阶角上：往东北的斜切被禁掉（老版本会给出一个对角节点）')
  const nbF = []
  mv.getMoveForward(node, { x: 0, z: -1 }, nbF)
  ok(nbF.length === 1, '同一位置往北的正交走法还在 → A* 会改走「先北后东」（实机朝北 2 秒走 8.37 格）')

  fill(-2, 66, 5, 'air')                             // 把台阶换成空气（真世界里 blockAt 也不会返回 null）
  const nb2 = []
  mv.getMoveDiagonal(node, NE, nb2)
  ok(nb2.length === 1, '拐角空着时斜着走照旧允许（没把正常的斜走改坏）')
}


/* ─────────── 6. 「不破坏方块」的走路模式（noDig）─────────── */
section('6. mc_move 的 noDig：走路一格都不挖')

/* 用户 2026-10-20：「move 加一个不破坏方块的模式」。这条链路跨两个文件：
 *   index.js（mc_move 的参数与分发）→ src/movement.mjs（walkTo/walkToOnce/walkPathfinder 把
 *   `canDig` 关掉、并且不许走"卡住就挖开台阶"那条补救）。
 * 这里做**契约检查**（各自该有的那一句必须在），不重跑寻路 —— 真行为由实机验证。 */
const mcIndexSrc = readFileSync(join(HERE, '..', 'index.js'), 'utf8')
const patchSrc = readFileSync(new URL('./patch-mc-deps.mjs', import.meta.url), 'utf8')
const mvSrc = readFileSync(join(HERE, '..', 'src', 'movement.mjs'), 'utf8')
const countOf = (hay, needle) => hay.split(needle).length - 1

ok(/noDig: \{ type: 'boolean'/.test(mcIndexSrc), 'mc_move 有 noDig 参数')
ok(/walk \/ fly \/ jump \/ boat/.test(mcIndexSrc), 'mode 说明里没有 walk-nodig / swim（都已删）')
ok(!/mode === 'walk-nodig'/.test(mcIndexSrc), '分发里没有 walk-nodig 分支（已删）')
ok(/const noDig = args\.noDig !== false/.test(mcIndexSrc),
  '默认不挖：只有显式 noDig:false 才允许挖')
const seqSrc = readFileSync(join(HERE, '..', 'src', 'sequence.mjs'), 'utf8')
ok(/noDig: s\.noDig !== false/.test(seqSrc), 'mc_sequence 的 move 步骤默认也不挖（和 mc_move 一致）')
/* 2026-10-27（用户：「把 mode swim 去掉」）：swim 分支删了，现在只剩 walk 这一条出口。 */
ok(/noDig,[^}]*?noTower: args\.allowTower !== true[^}]*?intent: intentArgOf\(args\.intent\)/.test(mcIndexSrc)
  && countOf(mcIndexSrc, 'walkWithAutoDig(sess, target,') === 1,
  'noDig 传进了走路调用（walk 那条；swim 分支已删）')
/* 2026-10-25（用户：「move和dig如果没办法到那格应该自动切换成可破坏」）：
 *   walk 那条改走 `walkWithAutoDig` —— 先不挖走一遍，走不通自动改成挖穿挡路方块再走。 */
ok(/walkWithAutoDig\(sess, target, \{ noDig, noTower: args\.allowTower !== true/.test(mcIndexSrc),
  'walk 走自动挖穿兜底（walkWithAutoDig）')
ok(/const walkWithAutoDig = async \(sess, target, opts, budgetMs, autoDig\)/.test(mcIndexSrc),
  'walkWithAutoDig 收 autoDig 开关（显式 noDig:false 时不自动挖）')
ok(/autoDigWorth/.test(mcIndexSrc) && /AUTO_DIG_REASONS/.test(mcIndexSrc),
  '只对「路被挡/卡住/不可达/头顶被堵」这类原因升级，其余不重试')
/* 🔴 2026-10-25 自查抓到的真 bug：AUTO_DIG_REASONS 里原来写的是 'stuck' / 'no-path' / 'unreachable'
 *   —— movement 根本不产生这几个值（真实值是 `NoPath` 等），等于自动挖穿从来没触发过。
 *   这条断言把「名单里的每个值都必须真在 movement 源码里出现」钉死，防止再写幽灵值。 */
{
  const m = mcIndexSrc.match(/AUTO_DIG_REASONS = new Set\(\[([^\]]+)\]\)/)
  const names = m ? [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]) : []
  ok(names.length >= 3, 'AUTO_DIG_REASONS 至少列了 3 个原因', names.join(','))
  const ghosts = names.filter((n) => !mvSrc.includes(`'${n}'`))
  ok(ghosts.length === 0, '名单里没有幽灵值（每个都真在 movement 里出现过）', ghosts.join(',') || '无')
  ok(names.includes('NoPath'), '认了 NoPath（"这条路走不通"最主要的那个）', names.join(','))
}
/* 🔴 2026-10-28 实机（用户：「工具报回来的移动预算只有 4 秒左右，所以从 y48 爬回地表花了六七次调用」）：
 *   第一遍"一格不挖"只分 40% 预算，以前以 `timeout` 结束时**不认**（只列 NoPath 一类）⇒
 *   "4 秒用完 + 剩下 6 秒白扔"，一次调用只推进 3~4 格。这三条把修好的行为钉住。 */
ok(/String\(r\.reason \?\? ''\) === 'timeout' && Boolean\(r\.blockedAhead\)/.test(mcIndexSrc),
  '第一遍 timeout 但眼前真被方块挡着 ⇒ 剩下时间改成挖穿（不再白扔）')
/* 🔴 2026-10-28（用户：「刚刚的 move 就给 4 秒」）：40% 切分已撤销 —— 第一遍直接吃满。
 *   真走不通会自己早退（NoPath 实测 0.3 秒），不需要预先切给第二遍。 */
ok(/noDig: true, budget: total \}\)/.test(mcIndexSrc) && !/total \* 0\.4/.test(mcIndexSrc),
  '第一遍"一格不挖"直接吃满预算（不再切 40%），走不通自己早退、剩下的留给挖穿')
ok(/budgetPlan: \{ totalMs: total, trialMs: total/.test(mcIndexSrc),
  '返回里带 budgetPlan（这一轮一共几秒 / 试绕路几秒 / 挖穿几秒）')
ok(countOf(mvSrc, 'noDig = false, xz = false } = {}, ctx = {})') === 3,
  'walkToUnguarded / walkToOnce / walkPathfinder 三个函数都收 noDig（连 xz 一起逐层转发）',
  String(countOf(mvSrc, 'noDig = false, xz = false } = {}, ctx = {})')))
ok(countOf(mvSrc, 'if (noDig) mv') === 3,
  '三处新建 Movements 都关掉 canDig（出厂 / 垫柱 / 地形重估）', String(countOf(mvSrc, 'if (noDig) mv')))
ok(/const carveAllowed = !noDig &&/.test(mvSrc), '卡住时"挖开台阶"的补救也因 noDig 关掉')
/* 🔴 2026-10-20：goal-reached-elsewhere（别人的 goal_reached 把我这次 goto 一起 resolve）要自己重试一次，
 *   实机撞到过两次「同一目标第一次秒返回、第二次才走」。只重试这一个 reason，且要有剩余预算。 */
ok(/info\.reason === 'goal-reached-elsewhere'/.test(mvSrc) && /retriedElsewhere: true/.test(mvSrc),
  'walkTo 对 goal-reached-elsewhere 自动重试一次（不靠 AI 手动再叫）')

/* 🔴 2026-10-24 用户实机：「现在寻路老是会跑到树上」。
 *    vendor `movements.js:233` 的 `b.safe` 对树叶/原木是 false（boundingBox 是 block），
 *    而 `safeOrBreak`（:282）认为"不能站但能挖开就行"，挖树叶的 laborCost 约 4.6–7.6、
 *    比绕树（2–3 步）便宜 ⇒ A* 一路挖着树冠往上爬。
 *    修法：把树这一类塞进 `blocksCantBreak`（vendor :41），`safeToBreak()` 就会返回 false。 */
const bnSrc = readFileSync(join(HERE, '..', 'src', 'block-names.mjs'), 'utf8')
const treePlugSrc = readFileSync(join(HERE, '..', 'src', 'plugins.mjs'), 'utf8')
const brSrc = readFileSync(join(HERE, '..', 'src', 'bridge.mjs'), 'utf8')
ok(/export const TREE_BLOCK_RE =/.test(bnSrc) && /export const isTreeBlock =/.test(bnSrc),
  'block-names 有 TREE_BLOCK_RE / isTreeBlock（树这一类）')
ok(/export const isLeafBlock =/.test(bnSrc) && /export const isTreeLog =/.test(bnSrc),
  '树再分两类：isLeafBlock（树叶）/ isTreeLog（原木）')
ok(/export function treeBlockIds \(b, \{ leaves = true \} = \{\}\)/.test(brSrc),
  'bridge 的 treeBlockIds 支持排除树叶（`{ leaves: false }`）')
ok(/for \(const id of treeBlockIds\(b, \{ leaves: false \}\)\) mv\.blocksCantBreak\.add\(id\)/.test(treePlugSrc),
  '只有**原木**被塞进 blocksCantBreak（树叶不在里面了）')
ok(/mv\.dshBreakPenalty = pen/.test(treePlugSrc) && /walkLeafDigPenalty \?\? 6/.test(treePlugSrc),
  '树叶改成“加价”：塞进 mv.dshBreakPenalty（默认 ×6，walkLeafDigPenalty 可调）')
ok(/const diggable = \(blk\) => diggableBlock\(blk\) && !isTreeLog\(nameOf\(blk\)\)/.test(mvSrc),
  '补挖（carveStepAhead）只禁原木，树叶可挖（被树叶围住时才有路）')
ok(/isTreeBlock\(blockedAhead\.name\)/.test(mvSrc), '挡路的是树时，提示明说「别挖树」')

ok(/if \(b\?\.vehicle && e === b\.vehicle\) continue/.test(mvSrc),
  '实体挡路检查排除了**自己骑的船**（不再把船报成挡路）')
ok(/自己骑的载具不算障碍/.test(patchSrc),
  'patch-mc-deps 里有「自己骑的载具不算障碍」补丁')
ok(/this\.bot\.vehicle && ent === this\.bot\.vehicle/.test(patchSrc),
  '补丁内容就是跳过 bot.vehicle')

ok(/!blockC\.physical && !blockC\.liquid/.test(patchSrc),
  '水里不垫方块：jumpUp 目标格是水时不规划放方块')
ok(/!blockD\.physical && !blockD\.liquid/.test(patchSrc),
  '水里不垫方块：脚下那格是水时也不规划放方块')

/* ── 传送门：xz 目标也要迈那一步（2026-10-25 实机「还是走不进末地传送门」） ── */
section('传送门：只给 x/z 也要能进')
{
  const mv = mvSrc
  ok(!/xz \? null : portalAt/.test(mv), '🔴 不再有「xz 目标不判传送门」那条短路')
  ok(/const portalProbeY = Number\.isFinite\(Number\(ty\)\) \? Number\(ty\) : \(b\?\.entity\?\.position\?\.y \?\? 0\)/.test(mv),
    'xz 时用自己脚下的 y 当探针（xz 分支的 ty 是 undefined）')
  ok(/portalAt\(b, Math\.floor\(target\.x\), portalProbeY, Math\.floor\(target\.z\), xz \? 2 : 1\)/.test(mv),
    'xz 时半径放到 2，覆盖上下一层')
  ok(/const GoalXZ = \(xz && !gp\.portal\) \? goals\?\.GoalXZ : null/.test(mv),
    '命中门就升级成三维精确目标（GoalXZ 只锁水平两维，人站不进去）')
}

console.log(`\n${fail === 0 ? '✓ 全部通过' : '✗ 有失败项'}：pass=${pass} fail=${fail}`)
ok(/bot\.pathfinder\.sneakWhenPlacing = false/.test(indexSrc),
  'vendor 默认就是「站着放」（sneakWhenPlacing 初始化为 false）')
ok(/if \(bot\.pathfinder\.sneakWhenPlacing === false\) return true/.test(indexSrc),
  '放方块前可以跳过「蹲着后退贴到边缘」（sneakWhenPlacing=false）')
ok(/b\.pathfinder\.sneakWhenPlacing = false/.test(readFileSync(resolve(HERE, '../src/plugins.mjs'), 'utf8')),
  '我们自己把 sneakWhenPlacing 关掉了 —— 站着直接放，不蹲着贴边')
ok(/放方块前不再蹲着贴边/.test(patchSrc),
  'patch-mc-deps 里有「不再蹲着贴边」这条补丁')

/* 🔴 2026-10-31 用户实机：「allowTower 能上去的地方也会搭方块」。
 *    上游 `placeCost` 默认 1 ⇒ 垫一格 = 多走 1 步，能跳上去、能绕两步的地方也去垫。
 *    现在按“多绕 N 步”计价（默认 12）。 */
ok(/mv\.placeCost = Number\(self\.cfg\.walkTowerCost \?\? 4\)/.test(plugSrc),
  '垫一格的代价按“多绕 N 步”算（不是上游的 1）')
ok(/walkTowerCost: 4/.test(coreSrc), 'cfg 里 walkTowerCost 默认 4（垫一格 ≈ 多走 4 步）')

process.exit(fail === 0 ? 0 : 1)

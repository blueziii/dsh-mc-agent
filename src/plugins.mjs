/**
 * **vendor 依赖加载器**（路线图第 ④ 条第二十八刀：从 `src\core.mjs` 搬出来的）。
 *
 * 这一层负责两件事（本来就是一件事）：**把 PrismarineJS 生态那几个现成插件找出来**、**把它们挂到 bot 上**。
 * `MC_DEPS`（清单）、`loadMcDep(key, opts)`（找 + 缓存**成功**）、`loadPathfinder()`（兼容旧名字）、
 * `setupPathfinder(self, opts)` / `movements(self)` / `setupPlugins(self, opts)`（第二十九刀搬进来的装配）、
 * `resetMcDepCache()` / `resetPathfinderCache()`（自检脚本用）。
 *
 * 三条约定：
 *   ① **不反向 import `core.mjs`**；只借 `node:fs` / `node:path` / `node:url` 与 `format.mjs` 的 `resolveHarnessHome`。
 *   ② **只缓存成功**：找不到时每次调用都重新试一遍（修好 vendor 树后下一次连接就能加载上，不用重启 DSH）。
 *   ③ 相对路径 `../../../vendor/mc-deps/...` 是按**本文件位置**算的 —— 本文件与 `core.mjs` 同在 `src/`，
 *      所以搬过来之后这条相对路径仍然对；但 junction / 符号链接安装时它会落到 `.pnpm` 深路径上，
 *      所以另有"按 `$DSH_HOME\profiles\<profile>\vendor\mc-deps` 绝对路径找"那条兜底。
 */
import { existsSync, readdirSync } from 'node:fs'
import Vec3 from 'vec3'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { resolveHarnessHome } from './format.mjs'
import { withTimeout } from './async-util.mjs'
import { scaffoldingItemIds } from './place-items.mjs'
import { patchDigTime } from './dig-speed.mjs'
import { applyProfile, classifyTerrainCached, profileFor } from './terrain.mjs'
import { avoidBlockIds, treeBlockIds } from './bridge.mjs'
import { PLANT_PASSABLE } from './block-names.mjs'
import { inLavaNow } from './world-observer.mjs'
import { shouldDodgeEntity } from './entity-avoid.mjs'
/* 门的判断/去重/冷却只有一份（`src/movement.mjs`）：上半格可能没有 `open` 属性，
 * 必须统一下半块判断；两处各写一份就会各按一次（踩坑 #175/#176）。 */
import { CARVE_PROTECTED, DOOR_PRESS_COOL_MS, doorBaseKey, doorFaceOf, doorOpenStateOf } from './movement.mjs'
/**
 * ── 现成的 mineflayer 生态插件（PrismarineJS 官方/社区项目；**这些都不自己写**） ──────
 *
 * 用户 2026-10-06 要求："应该有写好的防卡住项目，现在它会一直跳来跳去，完全是瞎动。"
 * 之后又要求把「自动吃 / 捡东西 / 挖方块 / 换工具 / 打怪」也换成现成的项目。
 *
 * | 键 | 包 | 干什么 |
 * | --- | --- | --- |
 * | `pathfinder` | mineflayer-pathfinder | A* 寻路 + 挖穿挡路方块 + 垫 1×1 塔 + 卡住检测 |
 * | `collectBlock` | mineflayer-collectblock | 走过去挖方块 / 捡掉落物（内部自己换工具） |
 * | `tool` | mineflayer-tool | 按方块选并换上最好的工具 |
 * | `pvp` | mineflayer-pvp | 追击并打怪（近战节奏自己算） |
 * | `autoEat` | mineflayer-auto-eat | 饿了自动吃（自己挑食物、吃完换回原手上的东西） |
 *
 * 装法见 `dsh-mc-agent/PATHFINDER.md`：装到 `<profile>\vendor\mc-deps`（**不碰宿主的 node_modules**，
 * 免得 pnpm 一重装就把 readable-stream 那个补丁冲掉）。这里按顺序找：
 *   ① `DSH_MC_AGENT_MC_DEPS`（给"装依赖的目录"，可含 node_modules）② 插件包旁边的 vendor 树
 *   ③ 裸包名（宿主自己装了就能解析到）。找不到 = 那一项能力没有，其它照旧。
 */
export const MC_DEPS = {
  pathfinder: { pkg: 'mineflayer-pathfinder', entry: 'index.js', label: '寻路 mineflayer-pathfinder（A* + 挖穿 + 垫脚 + 卡住检测）' },
  collectBlock: { pkg: 'mineflayer-collectblock', entry: 'lib/index.js', label: '挖/捡 mineflayer-collectblock（走过去挖方块、捡掉落物）' },
  tool: { pkg: 'mineflayer-tool', entry: 'lib/index.js', label: '换工具 mineflayer-tool（按方块挑最好的工具）' },
  pvp: { pkg: 'mineflayer-pvp', entry: 'lib/index.js', label: '打怪 mineflayer-pvp（追击 + 近战节奏）' },
  autoEat: { pkg: 'mineflayer-auto-eat', entry: 'dist/index.js', label: '自动吃 mineflayer-auto-eat' },
  /* 射箭弹道（用户 2026-10-19：「hawkeye 主要是水晶和末影龙」）。
   * 🔴 它的导出叫 `default`（`dist/index.js` 是 `exports.default = inject`），既不是 `plugin` 也不是
   *    `loader` —— 所以这条要显式声明 `exports`，否则 `pickExport` 找不到函数、整个能力静默缺失。 */
  hawkeye: { pkg: 'minecrafthawkeye', entry: 'dist/index.js', label: '射箭弹道 minecrafthawkeye（弓/弩/三叉戟的抛物线角度）', exports: ['default'] },
}

const DEP_OFF = /^(off|0|false|no|none)$/i
const _depCache = new Map()

/**
 * `import()` 出来的模块可能是 CJS 也可能是 ESM，具名导出还不全 ——
 * 既看具名导出也看 `default`，按名字顺序取第一个拿到的。
 */
function pickExport (mod, names) {
  const d = mod?.default ?? {}
  for (const n of names) {
    const v = mod?.[n] ?? d?.[n]
    if (v !== undefined && v !== null) return v
  }
  return undefined
}

/**
 * 找一个 vendor 依赖并 `import()` 它。**只缓存成功**：找不到时每次调用都重新试一遍。
 * （踩过的坑：以前把"找不到"也缓存了，结果在 vendor 树里修好文件之后，
 *   进程内再也等不到重试 —— 只能重启 DSH。失败重试很便宜，只在连接时发生。）
 * @param {'pathfinder'|'collectBlock'|'tool'|'pvp'|'autoEat'} key
 * @param {{log?:Function, logWarn?:Function, spec?:string}} opts
 *   `log` = 成功细节（调用方一般传 `logDebug`，默认看不见）；`logWarn` = 失败/形状不对（info，真出问题时要看得见）
 * @returns {Promise<any>} pathfinder 返回 `{pathfinder,Movements,goals}`；其它返回 `loadPlugin` 要的那个函数；找不到返回 null
 */
export async function loadMcDep (key, { log = null, logWarn = null, spec = null } = {}) {
  if (_depCache.has(key)) return _depCache.get(key)
  const info = MC_DEPS[key]
  if (!info) throw new Error(`未知的 vendor 依赖：${key}（可用：${Object.keys(MC_DEPS).join(' / ')}）`)
  const raw = spec ?? process.env.DSH_MC_AGENT_MC_DEPS ?? null
  const cands = []
  if (raw && !DEP_OFF.test(String(raw).trim())) {
    const s = String(raw).trim()
    if (/\.(m?js|cjs)$/i.test(s)) cands.push(/^[a-zA-Z]:[\\/]|^\//.test(s) ? pathToFileURL(s).href : s)
    else {
      // 当成"装依赖的目录"：目录本身 / 目录/node_modules 里都能找
      for (const p of [
        join(s, info.pkg, info.entry),
        join(s, 'node_modules', info.pkg, info.entry),
        join(s, info.entry),
      ]) if (existsSync(p)) cands.push(pathToFileURL(p).href)
      if (!cands.length) cands.push(s)
    }
  }
  try {
    // 本文件在 <profile>/node_modules/dsh-mc-agent/src/ → 往上三层就是 <profile>
    cands.push(new URL(`../../../vendor/mc-deps/node_modules/${info.pkg}/${info.entry}`, import.meta.url).href)
  } catch {}
  // 兜底：`$DSH_HOME/profiles/*/vendor/mc-deps/` 的**绝对路径**。
  // 🔴 为什么需要它：上面那条是**相对本文件**算的，只有插件包正好是
  //   `<profile>/node_modules/dsh-mc-agent/` 这个真目录时才对。一旦装成符号链接 /
  //   junction（`file:` / `link:` 依赖），`import.meta.url` 会落到
  //   `node_modules/.pnpm/<name>@file+.../node_modules/<name>/src/` 这种深路径上，
  //   往上三层就不再是 profile ⇒ vendor 树**静默**加载不到（移动/采集/吃/打怪全哑）。
  //   这条按绝对路径找，与安装拓扑无关。
  try {
    const profRoot = join(resolveHarnessHome(), 'profiles')
    for (const ent of readdirSync(profRoot, { withFileTypes: true })) {
      if (!ent.isDirectory()) continue
      const p = join(profRoot, ent.name, 'vendor', 'mc-deps', 'node_modules', info.pkg, info.entry)
      if (existsSync(p)) cands.push(pathToFileURL(p).href)
    }
  } catch {}
  cands.push(info.pkg)                        // 宿主自己装了也能解析到
  for (const c of cands) {
    const where = c.startsWith('file:') ? 'vendor 树' : c
    try {
      const m = await import(c)
      if (key === 'pathfinder') {
        // ⚠️ 它是 CJS：`import()` 出来的具名导出**不全**（实测只有 Movements/pathfinder，
        //    `goals` 只在 default 上）—— 所以两边都要看，凑成一个完整对象。
        const mod = {
          pathfinder: pickExport(m, ['pathfinder']),
          Movements: pickExport(m, ['Movements']),
          goals: pickExport(m, ['goals']),
        }
        if (mod.pathfinder && mod.Movements && mod.goals) {
          _depCache.set(key, mod)
          log?.(`已找到现成的${info.label}（${where}）`)
          return mod
        }
        ;(logWarn ?? log)?.(`pathfinder 候选不是预期的模块：${c}`)
        continue
      }
      // 其余插件：入口就是 `bot.loadPlugin()` 要的那个函数
      // （collectblock/tool/pvp 的 CJS 导出叫 `plugin`，auto-eat 的 ESM 导出叫 `loader`）
      let fn = pickExport(m, ['plugin', 'loader', ...(info.exports ?? [])])
      /* 🔴 2026-10-19（minecrafthawkeye）：它写的是 `exports.default = inject`，Node 的 CJS→ESM
       *   interop 会把**整个 `module.exports`** 当成 `m.default` ⇒ `m.default` 是
       *   `{ default: inject, Vec2, Weapons, isEntity, weaponsProps }` 这个**对象**，不是函数。
       *   以前只看一层，结果 `typeof fn === 'function'` 不成立 ⇒ 整个能力静默缺失。
       *   这里往下剥最多三层，拿到真正的函数为止。 */
      for (let i = 0; i < 3 && fn && typeof fn !== 'function'; i++) {
        fn = fn.default ?? fn.plugin ?? fn.loader
      }
      if (typeof fn === 'function') {
        _depCache.set(key, fn)
        log?.(`已找到现成的${info.label}（${where}）`)
        return fn
      }
      ;(logWarn ?? log)?.(`${key} 候选不是预期的模块：${c}`)
    } catch (e) {
      ;(logWarn ?? log)?.(`${key} 候选不可用（${c.startsWith('file:') ? c.slice(0, 60) + '…' : c}）：${e?.code ?? e?.message}`)
    }
  }
  // 故意不缓存失败：修好 vendor 树后，下一次连接（不用重启 DSH）就能加载上
  return null
}

/**
 * 兼容旧名字：只要寻路插件。`DSH_MC_AGENT_PATHFINDER` 仍然只影响"显式指定的那一路"，
 * 真正的开关是配置里的 `pathfinder: false`（见 `setupPathfinder`）。
 */
export async function loadPathfinder ({ log = null, logWarn = null, spec = null } = {}) {
  const raw = spec ?? process.env.DSH_MC_AGENT_PATHFINDER ?? null
  return await loadMcDep('pathfinder', { log, logWarn, spec: raw })
}

/** 测试用：清掉已成功的缓存（失败本来就不缓存，真机不需要调） */
export function resetPathfinderCache () { _depCache.delete('pathfinder') }
/** 测试用：清掉所有 vendor 依赖的成功缓存 */
export function resetMcDepCache () { _depCache.clear() }

/**
 * 挂上**现成的**寻路插件（mineflayer-pathfinder）。没装上只是"没有它"，其它功能照旧。
 *
 * 为什么用它：用户 2026-10-06 说"应该有写好的防卡住项目，现在它会一直跳来跳去，完全是瞎动"。
 * 手写的那套（按住前进 + 卡住就跳/挖/垫）在真机就是瞎动；pathfinder 是 A* + 自动挖/垫/绕路，
 * 自带卡住检测（3.5s 没进展 → `path_reset('stuck')`）和 noPath 判定。见文件顶部 `loadPathfinder`。
 */
/**
 * 把 pathfinder 挂在 tick 上的监听**接过来**（见 `setupPathfinder` 里 2026-10-18 崩溃的注释）。
 *
 * 为什么必须接：那个监听（`monitorMovement`）在 vendor 里是裸的，任何一次
 * `placingBlock`/`bot.entity` 是 undefined 都会从 `setInterval` 回调抛到进程级 ——
 * 宿主只对 `unhandledRejection` fail-loud，`uncaughtException` 直接**应用闪退**。
 *
 * 接管后：
 * - 统一挂到新事件 `physicsTick`（vendor 写的是已废弃的 `physicTick`）；
 * - `bot.entity?.position` 不在了（断线/重生一瞬）就跳过这一拍；
 * - 监听里抛错 ⇒ 记一条（每分钟最多一条）+ 停寻路 + 继续跑。
 *
 * @returns {number} 接管了几个监听（0 = 没装上 pathfinder，正常）
 */
export function guardPathfinderTicks (b, { log = null } = {}) {
  if (!b?.on || typeof b.listeners !== 'function') return 0
  const fns = []
  for (const ev of ['physicTick', 'physicsTick']) {
    for (const fn of b.listeners(ev) ?? []) if (typeof fn === 'function' && !fns.includes(fn)) fns.push(fn)
  }
  if (!fns.length) return 0
  for (const ev of ['physicTick', 'physicsTick']) b.removeAllListeners?.(ev)
  let lastLogAt = 0
  for (const fn of fns) {
    b.on('physicsTick', function (...args) {
      if (!b.entity?.position) return
      /* 标记"这一段是寻路插件自己在跑"：只有它发起的挖方块才会被 `guardDoorDig` 换成"开门"。
       * AI 自己调 `mc_dig`/`mc_act{break}` 走的是工具线程，不受影响。 */
      const prev = b.__inPathTick
      b.__inPathTick = true
      try {
        return fn.apply(this, args)
      } catch (e) {
        const now = Date.now()
        if (now - lastLogAt > 60_000) {
          lastLogAt = now
          try { log?.(`寻路 tick 里抛错（已拦住，没让宿主崩）：${e?.stack ?? e?.message ?? e}`) } catch {}
        }
        try { b.pathfinder?.stop?.() } catch {}
      } finally {
        b.__inPathTick = prev
      }
    })
  }
  return fns.length
}

/**
 * 寻路器要挖门时，**改成"把门按开"**（2026-10-18 实机第三次反馈："门还是不行，栅栏门可以"）。
 *
 * 现场：门前停 8 秒（`stuck`，只挪 1.56 格），再叫一次就把门挖了 —— 说明规划里门确实
 * 带着"挖掉"的账，而 vendor 的开门分支（`useOne`）对门本身是坏的（踩坑 #172）。
 * 与其和它的放置状态机较劲，不如在**执行层**拦一道：门/活板门/栅栏门被寻路器要求挖时，
 * 先 `activateBlock` 按开；按开了就当"这一步完成了"，人直接走过去。
 *
 * 只拦**寻路器自己**发起的挖（`b.__inPathTick`）——AI 点名挖门照旧真的挖。
 * **绝不回落到挖门**：开着 / 按开成功 / 按开失败 / 状态未知，一律不挖 ——
 * 门是用户和世界的资产，失败就交给上层重新寻路（用户 2026-10-18 明确要求）。铁门不在这条里。
 */
export function guardDoorDig (b, { log = null } = {}) {
  if (!b || typeof b.dig !== 'function' || b.__dshGuardedDig) return false
  const orig = b.dig.bind(b)
  let lastLogAt = 0
  const say = (m) => {
    const now = Date.now()
    if (now - lastLogAt < 15_000) return
    lastLogAt = now
    try { log?.(m) } catch {}
  }
  /* 门有上下两格：按任意一格都能开关，**按两格 = 开了又关**。
   * 这里统一折算到"门轴那一格"，并按 1.5 秒冷却去重 —— 实机"卡在门外一直开门"就是
   * 400ms 定时器 + 这里各按一次、上下半格再各按一次，来回把门打开又关上。
   * 与 `openNearbyDoor` 共享同一套 key / 冷却 / 在途锁（`b.__doorPressAt` / `b.__doorInFlight`）。 */
  /* 来源判断不能只看同步标记（2026-10-18 用户指出）：
   * vendor 的执行顺序是 `bot.equip(tool,'hand').then(() => bot.dig(block, true))` ——
   * 真正调用 `dig` 时 `physicsTick` 包装早已退出、`__inPathTick` 已复位，
   * 于是"寻路器要挖门"被当成"普通挖掘"放行。改判据：
   * `__inPathTick` **或** `pathfinder.isMining()`（等装备的异步窗口里它仍为 true）。 */
  const fromPathfinder = () => {
    if (b.__inPathTick === true) return true
    try { return b.pathfinder?.isMining?.() === true } catch { return false }
  }
  /* 要保护的"门"：① 正要挖的就是门；② 正要挖的方块**上方**是门（门脚支撑）。
   * 第二种是 2026-10-18 用户指出的实机现象 —— 门没事，门下面那格被挖了。 */
  const protectedDoorOf = (block) => {
    const nm = block?.name
    if (typeof nm === 'string' && DOOR_BLOCK_RE.test(nm) && !IRON_DOOR_RE.test(nm)) return block
    const p = block?.position
    if (!p || typeof b.blockAt !== 'function') return null
    try {
      const above = b.blockAt(new Vec3(Math.floor(Number(p.x)), Math.floor(Number(p.y)) + 1, Math.floor(Number(p.z))))
      if (above?.name && DOOR_BLOCK_RE.test(above.name) && !IRON_DOOR_RE.test(above.name)) return above
    } catch {}
    return null
  }
  /* 紧挨着门的普通方块：门**前面那一格**、门框、门后那一格。
   * 2026-10-18 用户实机：门脚下的砖不挖了，但"门前那块"还在被挖 ——
   * 那一格既不是门、也不在门下方，规划层与执行层都认不出来。
   * 只在**寻路器发起**时保护（见下面 `fromPathfinder()` 判断），AI 自己要求挖照旧放行，
   * 所以不会出现"房子周围一律不许挖"。 */
  const doorNextTo = (block) => {
    const p = block?.position
    if (!p || typeof b.blockAt !== 'function') return null
    const px = Math.floor(Number(p.x)), py = Math.floor(Number(p.y)), pz = Math.floor(Number(p.z))
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (let dz = -1; dz <= 1; dz++) {
          if (!dx && !dy && !dz) continue
          let q = null
          try { q = b.blockAt(new Vec3(px + dx, py + dy, pz + dz)) } catch { continue }
          const n = q?.name
          if (typeof n === 'string' && DOOR_BLOCK_RE.test(n) && !IRON_DOOR_RE.test(n)) return q
        }
      }
    }
    return null
  }
  b.dig = function (block, ...rest) {
    /* AI 自己叫的挖（不在寻路 tick 里、也没在挖矿）⇒ 一概放行：
     * 只有"寻路器自动挖"才受门保护，别因为附近有门就禁止 AI 拆方块。 */
    if (!fromPathfinder()) return orig(block, ...rest)
    /* 要挖的**本身就是门**（含铁门）⇒ 只按门本身那条规则判断，不再看邻居：
     * 铁门旁正好有一扇木门时，不能因此就拦住"挖铁门" —— 那是正常脱困。 */
    const itselfDoor = typeof block?.name === 'string' && DOOR_BLOCK_RE.test(block.name)
    const doorBlk = protectedDoorOf(block) ?? (itselfDoor ? null : doorNextTo(block))
    if (!doorBlk) return orig(block, ...rest)
    const nm = doorBlk.name
    return (async () => {
      const target = doorFaceOf(b, doorBlk) ?? doorBlk
      const key = doorBaseKey(target) ?? `${target?.position?.x},${target?.position?.y},${target?.position?.z}`
      const pressAt = b.__doorPressAt instanceof Map ? b.__doorPressAt : (b.__doorPressAt = new Map())
      const inFlight = b.__doorInFlight instanceof Set ? b.__doorInFlight : (b.__doorInFlight = new Set())
      /* 正在按 / 1.5 秒内按过这扇门 ⇒ 当这一步已经完成（别关回去，也别再挖） */
      if (inFlight.has(key)) return
      if (Date.now() - Number(pressAt.get(key) ?? 0) < DOOR_PRESS_COOL_MS) return
      const state = doorOpenStateOf(target)
      if (state === 'open') return          // 已经开着：这一步当过了
      if (state !== 'closed') {
        /* 🔴 状态读不到也不许挖：不知道 ≠ 可以破坏（用户的明确要求） */
        say(`🚪 ${nm} 状态读不到（${state}），不按也不挖（${key}）`)
        return
      }
      if (typeof b.activateBlock !== 'function') {
        say(`🚪 ${nm} 无法交互，已阻止寻路挖门（${key}）`)
        return
      }
      inFlight.add(key)
      pressAt.set(key, Date.now())          // await 之前就上锁（tick 会重入）
      try {
        /* 🔴 2026-10-24 全量体检：`activateBlock` 要等服务端回包才 resolve，回包丢了就永久挂住
         * —— 这里挂住会让 `inFlight` 里那扇门**永远占着锁**（之后再也不按它）。给个上限。 */
        await withTimeout(b.activateBlock(target), 1500, '开门')
        if (b.__autoOpenedDoors instanceof Map) b.__autoOpenedDoors.set(key, Date.now())
        b.__doorOpens = (b.__doorOpens ?? 0) + 1
        say(`🚪 寻路请求开门 ${nm}，不挖门（${key}）`)
      } catch (e) {
        /* 🔴 开门失败也**绝不**回落到挖门：门是用户/世界的资产，失败就交给上层重新寻路 */
        say(`🚪 ${nm} 未能打开，已阻止自动挖门：${e?.message ?? e}（${key}）`)
      } finally {
        inFlight.delete(key)
      }
    })()
  }
  b.__dshGuardedDig = true
  return true
}

/**
 * 给 `bot.pathfinder.goto` 加一层"拒绝一定有人接"的保险（2026-10-18 第二次闪退）。
 *
 * 崩溃现场：`goto` → `setGoal(null)` → `resetPath` → `stop()` → 发 `path_stop` →
 * **上一次还没走完的 goto** 被 reject 成 `PathStopped`，而它已经没人 await 了
 * （超时先返回、或 collectBlock/pvp 内部先撤）⇒ `unhandledRejection` ⇒
 * 宿主 fail-loud 直接 `exit(1)`（应用闪退）。
 *
 * 做法：包一层 `goto`，对返回的 promise **挂一个空 catch**（只是标记"已处理"，
 * 不改变返回值 —— 调用方自己 `.catch` / `await` 仍然照常收到 reject）。
 */
export function guardPathfinderRejections (b, { log = null } = {}) {
  const pf = b?.pathfinder
  if (!pf || typeof pf.goto !== 'function' || pf.__dshGuardedGoto) return false
  const orig = pf.goto.bind(pf)
  pf.goto = function (...args) {
    const p = orig(...args)
    try {
      p?.catch?.(() => {})
    } catch (e) {
      try { log?.(`给 goto 的拒绝挂 catch 失败：${e?.message ?? e}`) } catch {}
    }
    return p
  }
  pf.__dshGuardedGoto = true
  return true
}

export async function setupPathfinder (self, { spec = null } = {}) {
  const b = self.bot
  if (!b) return false
  if (self.cfg.pathfinder === false) { self.pfReady = false; return false }
  const mod = await loadPathfinder({ log: (m) => self.logDebug(m), logWarn: (m) => self.log(m), spec })
  if (!mod) {
    self.pfReady = false
    self.log('没有可用的 mineflayer-pathfinder（见 dsh-mc-agent/PATHFINDER.md）→ 所有移动已停止，避免盲跳')
    return false
  }
  try {
    if (typeof b.pathfinder?.goto !== 'function') b.loadPlugin(mod.pathfinder)
    /* 2026-10-18 真机崩溃：pathfinder 的 `monitorMovement` 挂在 tick 上，某次
     * `placingBlock`/`bot.entity` 是 undefined ⇒ `TypeError: Cannot read properties of undefined (reading 'y')`
     * 从 setInterval 回调里抛出去 = uncaughtException = **整个 DSH 宿主进程退出**（不是掉线，是应用闪退）。
     * 它同时还在用已废弃的 `physicTick` 事件。这里把它的 tick 监听接过来：
     * ① 换到新事件 `physicsTick`（不再触发弃用警告）② `entity` 还没回来就跳过
     * ③ 抛错时只记日志并停住寻路，绝不让它冒到进程级。 */
    const guarded = guardPathfinderTicks(b, { log: (m) => self.log(m) })
    if (guarded) self.logDebug(`pathfinder tick 已接管（${guarded} 个监听）`)
    guardPathfinderRejections(b, { log: (m) => self.log(m) })
    // 想路线的预算：服务器卡顿时别想太久；搜索半径别放到无限。
    // 🔴 4000 太短了 —— 2026-10-06 实机挖树时频繁 "Took to long to decide path to goal!"，
    //    collectBlock 因此整批失败（改成逐个喂之后至少不会再一坏全坏）。8000 让"目标在高处、
    //    要垫脚才够得着"这类难想的目标有机会想出来，同时仍能及时放弃。
    /* 🔴 2026-10-22 用户「还是能卡住」：8000ms 是**纯算路**时间，而 A* 在这 8 秒里
     *   一个控制位都不按（vendor index.js:475 直接 return）—— 一次 mc_move 总共才 10~11 秒，
     *   于是"叫了 move、人就站着不动 10 秒"。改 3500ms：超时返回的是
     *   `reconstructPath(bestNode)`（**半截路也照样能走**），先走起来比想满更划算。
     *   真需要长考的目标由脱困阶梯重试，而不是一次性把整轮预算烧在算路上。 */
    /* 🔴 2026-10-25 用户（「搭路是蹲着到方块边缘放，其实站在前一格就能直接放」）：
     *    vendor `moveToEdge()` 在放方块前会 `sneak + back` 把自己挪到方块边缘
     *    （每块多花约 1 秒，还容易把自己挤下边缘）。我们不需要那个姿态：
     *    站在当前格时相邻格就在 1.4 格内，脚下是实地就不会掉。关掉。 */
    b.pathfinder.sneakWhenPlacing = false
    b.pathfinder.thinkTimeout = Number(self.cfg.pfThinkTimeoutMs ?? 3500)
    b.pathfinder.tickTimeout = 40
    b.pathfinder.searchRadius = Number(self.cfg.pfSearchRadius ?? 192)
    self._pf = mod
    self.pfReady = true
    return true
  } catch (e) {
    self.log('pathfinder 挂载失败：' + e.message)
    self.pfReady = false
    return false
  }
}

/**
 * 造一份 `Movements`（走路 / 寻路 / collectBlock / pvp 共用同一套配置，
 * 免得"我走的时候不乱跳、插件走的时候乱跳"）。
 *
 * `terrain` 是 `classifyTerrain()` 的结果（`src/terrain.mjs`，导航 P2）——
 * 给了它就**按地形挑权重**（台阶上挖便宜一点、沟边垫方块便宜一点、岩浆边一格都不许跳），
 * 不给就退回平地那套（= 改动前的全局值）。用户显式配置永远优先（见 `profileFor` 的 `over`）。
 */
/** 门这类方块：能按开就不该挖（2026-10-18 实机第二次反馈："会开但是不走门那，还是会挖方块"）。 */
export const DOOR_BLOCK_RE = /_(door|trapdoor|fence_gate)$/
/** 铁门/铁活板门要红石，按不开 —— 这条规则不管它们（仍允许挖，至少能脱困）。 */
const IRON_DOOR_RE = /^iron_(door|trapdoor)$/

/**
 * 给 vendor 的 `Movements` 打两个补丁（**只影响规划出来的那条 move**，不改 A*）：
 *
 * ① **别把门算进 `toBreak`**：vendor 的 `getMoveForward` 先
 *    `cost += safeOrBreak(blockB, toBreak)`（门的上半格就是 blockB）—— "穿门"这条路
 *    因此带着一条"把门挖掉"的账；执行到那一步就把门挖了，`canOpenDoors` 只救了门的下半格。
 * ② **门已经开着就不要再 `activateBlock`**：vendor 的 `useOne` 是无条件按一下；
 *    我们 400ms 定时器已经按开了，vendor 再按一次 = **又把门关上**（"开了但不走"）。
 *
 * 只过滤木门/栅栏门/活板门；铁门按不开，保留原行为。
 */
/**
 * **每挖一格额外记 `perBlock` 步**（默认走 `cfg.walkDigDetourMax` = 15）。
 *
 * 为什么需要：`digFirst`（显式 `allowDig:true`）把 `digCost` 压到 0.4 之后，A* 眼里
 * "挖一格"几乎等于"走一步"，于是它选的是**几何最短**——直着挖穿自家墙、把地板刨开。
 * 用户实机原话：「nodig false 最短现在会挖家，ai 也没意识到要切换，设置个绕路最大限制
 * 大于 15 格在挖」。给每格挖加固定的 15 步之后：绕路 ≤15 格 ⇒ 绕；>15 格 ⇒ 才挖。
 *
 * 两个入口都要包（`vendor/lib/movements.js`）：
 * - `safeOrBreak(block, toBreak)` —— 走/跳时顺手挖开的那几格（:298）；
 * - `breakLabor(block)` —— 垫方块/爬 1×1 柱子时挖的（:261）。
 * ⚠️ vendor 用 **100** 表示"这格挖不了"（`safeToBreak` 失败），绝不能加成 115 ——
 * 那会把"禁挖"变成"可行但贵一点"。所以只在 `cost < 100` 且**真的挖了**时才加。
 */
export function patchDigDetour (mv, { perBlock = 15 } = {}) {
  if (!mv || !(Number(perBlock) > 0)) return mv
  const add = Number(perBlock)
  if (typeof mv.safeOrBreak === 'function' && !mv.__dshDigDetour) {
    mv.__dshDigDetour = true
    const origSafe = mv.safeOrBreak.bind(mv)
    /* 🔴 2026-11-02 审计（#13）：`100` 只是上游 `safeOrBreak` 的**哨兵返回值**
     *   （`safeToBreak()` 失败时 `return 100`），而正常代价是**累计值**
     *   （`exclusionBreak + (1+3*digTime/1000)*digCost*pen`，黑曜石就已经 100，再加 exclusion 就超了）
     *   ⇒ 以前 `c >= 100` 把"贵但能挖"当成"挖不了"，那条路直接被判死。
     *   能不能挖要问 `safeToBreak`，不要拿代价猜。 */
    mv.safeOrBreak = (block, toBreak) => {
      const c = origSafe(block, toBreak)
      const canBreak = typeof mv.safeToBreak === 'function' ? mv.safeToBreak(block) : true
      if (!canBreak) return c          // 真挖不了（基岩 / 排除区）—— 别动那个 100
      if (block?.safe) return c        // 这格本来就能站，压根没挖
      return c + add
    }
    const origLabor = typeof mv.breakLabor === 'function' ? mv.breakLabor.bind(mv) : null
    if (origLabor) {
      mv.breakLabor = (block) => {
        const c = origLabor(block)
        const canBreak = typeof mv.safeToBreak === 'function' ? mv.safeToBreak(block) : true
        return canBreak ? c + add : c
      }
    }
  }
  return mv
}

export function patchDoorMoves (mv, { digPenalty = 0, parkourPenalty = 0, digDirTax = 0 } = {}) {
  if (!mv) return mv
  const doorAt = (node, p) => {
    try { return mv.getBlock?.(node, p.x - node.x, p.y - node.y, p.z - node.z) ?? null } catch { return null }
  }
  const isDoor = (blk) => Boolean(blk?.name && DOOR_BLOCK_RE.test(blk.name) && !IRON_DOOR_RE.test(blk.name))
  /* 🔴 门**下方那格支撑**也不能挖（2026-10-18 用户指出）：只保护门本身时，
   * 寻路器仍会把门槛下的地板列进 `toBreak`（挖掉门脚下的砖 = 门悬空掉下去/门框被拆）。
   * 只认"正上方是普通门"的方块，铁门不算（按不开的门不当资产）。 */
  const isDoorSupport = (node, p) => {
    try {
      const above = doorAt(node, { x: p.x, y: p.y + 1, z: p.z })
      return isDoor(above)
    } catch { return false }
  }
  /* 把"挖这扇门"的工钱退掉：vendor 的 safeOrBreak 已经把它算进 `m.cost` 了，
   * 只在 toBreak 里删位置而不扣钱，A* 仍然觉得"挖门"和"走门"一样贵 ⇒ 还是选墙。
   * 公式照 `movements.js:290-298`（laborCost = (1 + 3*digTime/1000) * digCost）。 */
  const laborOf = (blk) => {
    try {
      /* 🔴 2026-11-02 审计（#11）：这里以前自己抄了一遍 `(1+3*digTime/1000)*digCost`，
       *   漏了树叶加价 `dshBreakPenalty`、也漏了 `patchDigDetour` 的每格 +15，
       *   工具 NBT 附魔/药水效果还是用空数组顶的 ⇒ **退的钱 ≠ 收的钱**：
       *   门/门框那格退少了，A* 依然觉得"挖门"和"走门"差不多贵，于是继续选墙。
       *   现在直接调同一个 `mv.breakLabor`（它已被上面的补丁包过）—— 退价与收费天生同源。 */
      if (typeof mv.breakLabor === 'function') return Number(mv.breakLabor(blk)) || 0
      if (!Number.isFinite(mv.digCost) || typeof blk?.digTime !== 'function') return 0
      const tool = mv.bot?.pathfinder?.bestHarvestTool?.(blk)
      const digTime = blk.digTime(tool?.type ?? null, false, false, false, [], {}) || 0
      return (1 + 3 * digTime / 1000) * mv.digCost
    } catch { return 0 }
  }
  /* 统一在 `getNeighbors()` 的返回值上做后处理（2026-10-18 用户指出）：
   * 逐个包 `getMoveForward`/`getMoveJumpUp`/… 是在维护一份"生成器清单"，
   * vendor 一共 7 个生成器（还有 DropDown / Down / Up / ParkourForward），漏一个
   * 那种移动就仍带着"挖门"。改为**所有候选 move 一律过一遍**，与来源无关。 */
  /* 紧挨着门的普通方块（门前一格/门框/门后一格）：2026-10-18 用户实机 ——
   * 门脚下的砖已不挖，但"门前那块"还会被挖；它既不是门、也不在门下方。
   * 注意这里**不是**把门周围两格永久保护：只有"寻路为了走过去而要挖它"时才作废这条 move，
   * AI 自己叫的挖掘不受影响（执行层 `guardDoorDig` 同理只拦寻路器发起的）。 */
  const isDoorAdjacent = (node, p) => {
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (let dz = -1; dz <= 1; dz++) {
          if (!dx && !dy && !dz) continue
          if (isDoor(doorAt(node, { x: p.x + dx, y: p.y + dy, z: p.z + dz }))) return true
        }
      }
    }
    return false
  }
  /* @returns {boolean} false = 这条 move 作废（规划里就不该从门旁边挖过去） */
  const clean = (node, m) => {
    if (!m) return true
    if (Array.isArray(m.toBreak) && m.toBreak.length) {
      const kept = []
      for (const p of m.toBreak) {
        const blk = doorAt(node, p)
        if (isDoor(blk)) {
          m.cost = Math.max(0, (Number(m.cost) || 0) - laborOf(blk))
          continue
        }
        /* 门脚下的支撑块：同样剔掉并退工钱（挖它等于把门拆了） */
        if (isDoorSupport(node, p)) {
          m.cost = Math.max(0, (Number(m.cost) || 0) - laborOf(blk))
          continue
        }
        /* 门旁边的普通方块：**整条 move 作废**。
         * 只把 toBreak 删掉会留下一条"穿过实心方块"的假路（执行时走不动、原地卡住）；
         * 作废后 A* 会改走门/绕路 —— 门由 `openNearbyDoor` 负责打开。 */
        if (isDoorAdjacent(node, p)) return false
        kept.push(p)
      }
      m.toBreak = kept
    }
    if (Array.isArray(m.toPlace) && m.toPlace.length) {
      /* 🔴 门的 `useOne` **一律删掉**（不管门现在是开是关）。
       * 2026-10-18 第三次闪退/卡门的根因就在这：vendor 的 `monitorMovement`
       * 在 `useOne` 只有一步时 `placingBlock = nextPoint.toPlace.shift()` 会拿到 undefined，
       * 而 `placing` 标志不复位 ⇒ 下一拍读 `placingBlock.y` 抛 TypeError
       * （我们拦住后它停住寻路 ⇒ 表现成"卡在门口、原地不动"）。
       * 门由 `openNearbyDoor`（400ms 探一次、够得着就按）负责开 —— 规划里不需要这一步。 */
      const keptPlace = m.toPlace.filter((p) => !(p?.useOne && isDoor(doorAt(node, p))))
      if (keptPlace.length !== m.toPlace.length) {
        /* 🔴 2026-11-02 审计（#12）：删掉门的 `useOne` 之后这些垫料**其实没花掉**，
         *   可 `remainingBlocks` 还是按原来的 `toPlace.length` 扣的 ⇒ 背包刚好 1 块垫料时，
         *   1×1 柱子那条边会被误判"料不够"而剪掉（人就被困在坑里）。删几格就还回几格。 */
        if (Number.isFinite(m.remainingBlocks)) m.remainingBlocks += m.toPlace.length - keptPlace.length
        m.toPlace = keptPlace
      }
    }
    /* 🔴 必须显式返回 true：`getNeighbors` 用 `filter((m) => clean(node, m))` 收集候选，
     * 漏了这句 ⇒ 所有 move 都被当成 falsy 丢掉 ⇒ A* 无路 ⇒ 到处 `NoPath` 走不动。 */
    return true
  }
  const origNeighbors = mv.getNeighbors
  if (typeof origNeighbors === 'function') {
    mv.getNeighbors = function (node) {
      const moves = origNeighbors.call(this, node)
      if (!Array.isArray(moves)) return moves
      const kept = moves.filter((m) => clean(node, m))
      /* 🔴 2026-10-24 审计（用户第三份）：**不再退回未过滤的候选**。
       * 旧写法 `return kept.length > 0 ? kept : moves`：某个节点上所有候选都因为
       * "得挖门/门框"被作废时，把**原样的**候选还给 A* —— 那等于给了一条"挖穿门框过去"的
       * 假路：规划上通，执行时被 `guardDoorDig` 拦下，机器人就在门口反复蹭，
       * 既不报 NoPath 也不进脱困阶梯。宁可这里无路（⇒ NoPath ⇒ 脱困阶梯 / 等
       * `openNearbyDoor` 把门按开），也不要给一条走不通的路。 */
      /* 🔴 `preferDoors`（2026-10-18 用户要求）：**所有"还得挖方块"的移动加一笔固定惩罚**。
       * 门/绕路本身不受影响，只是"挖墙"更不划算 ⇒ 有门的房子会优先走门、宁可多绕两步。
       * 放在 `clean()` 之后：门已经从 `toBreak` 里剔掉了，不会误伤"穿过门"。 */
      if (digPenalty > 0) {
        for (const m of kept) {
          if (Array.isArray(m.toBreak) && m.toBreak.length) m.cost = (Number(m.cost) || 0) + digPenalty
        }
      }
      /* 🔴 2026-10-30：跑酷边（跨 1~2 格空隙）加价。
       *    vendor `getMoveParkourForward` 的 cost 只有 1~2（`let cost = 1`），
       *    一开 allowParkour，A* 会为了省两步到处跳；加 `parkourPenalty`（默认 4）之后
       *    "跨一格沟"≈ 多走 4 步 —— 比绕远便宜、比"没路/掉下去"贵，沟边才会主动规划。 */
      if (parkourPenalty > 0) {
        for (const m of kept) {
          if (m.parkour === true) m.cost = (Number(m.cost) || 0) + parkourPenalty
        }
      }
      /* 🔴 2026-11-02 用户：「只用 allowDig 上地表，它会乱挖」——
       *    `allowDig:true` 只松 `canDig`，A* 就把"挖一格"当成一条普通边，
       *    在三维里挑最便宜的挖法：横着掏、往下掏、斜着掏，出来坑坑洼洼。
       *    这里加"方向税"：向上挖原价（上升本来就得靠挖），水平 +2 份、向下 +5 份。
       *    一份 = `walkDigSideTax`（默认 15 步 ≈ 挖一格石头的工钱）⇒ 横着挖多花 30 步、
       *    往下多花 75 步，有竖井/楼梯就走；真没路时仍然会挖（只是贵），不会变 NoPath。 */
      if (digDirTax > 0) {
        for (const m of kept) {
          if (!Array.isArray(m.toBreak) || !m.toBreak.length) continue
          const dyDir = Number(m.y) - Number(node.y)
          if (!Number.isFinite(dyDir) || dyDir > 0) continue
          m.cost = (Number(m.cost) || 0) + digDirTax * (dyDir < 0 ? 5 : 2)
        }
      }
      return kept
    }
    mv.__dshDoorPatched = true
    return mv
  }
  /* 回退：没有 `getNeighbors` 的假对象/旧版 Movements ⇒ 包住所有已知生成器 */
  const wrap = (name) => {
    const orig = mv[name]
    if (typeof orig !== 'function') return
    mv[name] = function (node, dir, neighbors) {
      const before = Array.isArray(neighbors) ? neighbors.length : 0
      const r = orig.call(this, node, dir, neighbors)
      if (!Array.isArray(neighbors)) return r
      for (let i = neighbors.length - 1; i >= before; i--) {
        if (clean(node, neighbors[i]) === false) neighbors.splice(i, 1)
      }
      return r
    }
  }
  for (const name of ['getMoveForward', 'getMoveJumpUp', 'getMoveDiagonal',
    'getMoveDropDown', 'getMoveDown', 'getMoveUp', 'getMoveParkourForward']) wrap(name)
  return mv
}

/**
 * 「站上去 / 走过去就掉血」的方块 —— A* 要绕开它们。
 * 2026-10-22 用户实机：「现在寻路会踩在岩浆块上掉血」。
 *
 * 🔴 为什么 `blocksToAvoid` 治不了这事：那个名单管的是**"这一格能不能站"**
 *    （`movements.js:233` 的 `b.safe`），而岩浆块是**实心方块** —— 人站在它**上面**，
 *    脚那一格永远是空气（永远 safe）。所以 `magma_block` 早就躺在
 *    `BRIDGE_FATAL_NAMES` / `avoidBlockIds()` 里，**一次都没生效过**（看起来"修过了"，其实没有）。
 *
 * 真正该看的是**脚下那一格**（`m.y - 1`，托着你的方块）和**脚踩进去那一格**（`m.y`，
 * 甜浆果丛/凋灵玫瑰这类空碰撞盒但会扎人的东西在这一格）。
 *
 * 做法：给这种 move **加一笔重罚**（默认 60 ≈ 宁可绕 60 格也不踩），**不删 move** ——
 * 岩浆三角洲那种"满地板都是岩浆块"的地方删光了就是 NoPath，宁可慢一点走过去也不能原地不动。
 */
export const HARMFUL_FLOOR = /^(magma_block|campfire|soul_campfire|cactus|sweet_berry_bush|wither_rose|fire|soul_fire|powder_snow)$/

export function patchHarmfulFloorMoves (mv, { penalty = 60 } = {}) {
  if (!mv || typeof mv.getNeighbors !== 'function') return mv
  const P = Number.isFinite(Number(penalty)) ? Math.max(0, Number(penalty)) : 60
  if (P <= 0) return mv
  const nameAt = (node, dx, dy, dz) => {
    try { return mv.getBlock?.(node, dx, dy, dz)?.name ?? null } catch { return null }
  }
  const order = (node, m) => {
    if (!m) return m
    const dx = Number(m.x) - Number(node.x)
    const dy = Number(m.y) - Number(node.y)
    const dz = Number(m.z) - Number(node.z)
    if (![dx, dy, dz].every((v) => Number.isFinite(v))) return m
    const feet = nameAt(node, dx, dy, dz)
    const floor = nameAt(node, dx, dy - 1, dz)
    const hit = HARMFUL_FLOOR.test(String(feet ?? '')) ? feet
      : (HARMFUL_FLOOR.test(String(floor ?? '')) ? floor : null)
    if (hit) {
      m.cost = (Number(m.cost) || 0) + P
      m.__harmfulFloor = hit
    }
    return m
  }
  const origNeighbors = mv.getNeighbors
  mv.getNeighbors = function (node) {
    const moves = origNeighbors.call(this, node)
    if (!Array.isArray(moves) || !node) return moves
    return moves.map((m) => order(node, m))
  }
  mv.__dshHarmfulFloorPatched = true
  return mv
}

/** 能像梯子一样往上爬的藤蔓族（原版 `isClimbable` 认的就是这几个）。 */
const CLIMBABLE_NAMES = [
  'vine', 'weeping_vines', 'weeping_vines_plant', 'twisting_vines', 'twisting_vines_plant',
  'cave_vines', 'cave_vines_plant',
]

/**
 * 把藤蔓族补进 `mv.climbables`（和梯子一样能往上爬）。
 *
 * 为什么值得补：vendor 只加了 `ladder`（`movements.js:64`，`vine` 那行被注释掉了），
 * 而 `getMoveUp`（`movements.js:555`）只有在 `block1.climbable` 时才走"顺着爬上去、
 * 不用垫方块"那条分支 ⇒ 藤蔓在原版里能爬，在 A* 眼里却只能当"empty 的空格"，
 * 于是爬树取苹果、洞穴藤蔓上地面、下界缠怨藤下山全都要靠 1×1 垫柱子。
 *
 * 只动 `climbables`，不动 `blocksToAvoid` 也不动 `carpets`：藤蔓 boundingBox 本来就是
 * `empty`（`minecraft-data` 里 7 个全是），safe 早就成立，缺的只是"能顺着爬"。
 */
export function patchClimbables (mv, b) {
  if (!mv || !(mv.climbables instanceof Set)) return 0
  const reg = b?.registry?.blocksByName
  if (!reg) return 0
  let added = 0
  for (const nm of CLIMBABLE_NAMES) {
    const id = reg[nm]?.id
    if (typeof id !== 'number') continue
    if (mv.climbables.has(id)) continue
    mv.climbables.add(id)
    added++
  }
  if (added) mv.__dshClimbables = added
  return added
}

/**
 * 把"能直接走进去"的作物/贴地植物补进 `mv.carpets`。
 *
 * 🔴 2026-10-22 用户实机：「家里非实体方块走不了」—— 家里那片麦田 A* 死活不肯走进去
 *    （表现：`blockedAhead: farmland / headroom 0`、`NoPath`、绕着田转圈）。
 *    根因在 vendor `lib/movements.js:233`：
 *    `b.safe = (b.boundingBox === 'empty' || b.climbable || this.carpets.has(b.type)) && !blocksToAvoid.has(...)`
 *    而 `carpets` 只在 `lib/movements.js:89` 按 `block.shapes[0][4] < 0.1` 自动收集：
 *    地毯（0.0625）进得去，**小麦（≈0.3125）进不去**；prismarine 给作物的 `boundingBox`
 *    也不是 `'empty'` ⇒ `safe === false` ⇒ A* 把整块田当墙。
 *    这里按名字把 `PLANT_PASSABLE`（`src/block-names.mjs`）里的方块塞进 `carpets`，
 *    人就能像正常玩家一样从麦田里走过去。
 *    ⚠️ 只动 `carpets`（"这一格能不能站"），不动 `blocksToAvoid`；甜浆果丛不在名单里（踩了掉血）。
 */
export function patchPlantPassable (mv, b) {
  if (!mv || !(mv.carpets instanceof Set)) return 0
  const B = b?.registry?.blocksArray
  if (!Array.isArray(B)) return 0
  let added = 0
  for (const blk of B) {
    const nm = String(blk?.name ?? '')
    if (!nm || !Number.isFinite(blk.id)) continue
    if (!PLANT_PASSABLE.test(nm)) continue
    if (mv.carpets.has(blk.id)) continue
    mv.carpets.add(blk.id)
    added++
  }
  if (added) mv.__dshPlantPassable = added
  return added
}

export function movements (self, { terrain = null, digFirst = false, allowDig = false } = {}) {
  const b = self.bot
  const { Movements } = self._pf ?? {}
  if (typeof Movements !== 'function') return null
  const mv = new Movements(b)
  // 地形档案（导航 P2）：先铺一套，再用下面那几行把"跟地形无关的"补上
  const profile = profileFor(terrain?.kind ?? 'unknown', self.cfg)
  /* 2026-10-18 实机（用户："move 遇到门不会开，会直接从墙挖进去"）：
   * vendor 默认 `canOpenDoors = false`（注释：Causes issues），门在 A* 眼里就是实心；
   * 配上 canDig=true ⇒ "挖墙"永远比"绕路"便宜。规划允许穿门，执行由
   * `src/movement.mjs` 的 `openNearbyDoor` 走到门边按一下。 */
  mv.canOpenDoors = true
  /* 🔴 2026-10-24 用户（导航世界模型）：**实体挡路要让 A* 看得见** ——
   *    vendor 默认 `entityCost = 1`（`lib/movements.js:27`），A* 绕一步就抵掉了，
   *    怪站在唯一通道里它照样硬穿。调到 8：明显倾向绕开，但真没别的路时还是走。
   *    ⚠️ 成本只在**生成路径那一刻**按当时实体位置算（`lib/movements.js:298` 等 9 处）；
   *    路径出来之后怪再走进通道，A* 不知道 —— 那一半靠 `entityObstacleAhead()` 在卡住时补。 */
  mv.allowEntityDetection = true
  mv.entityCost = 8
  /* 🔴 2026-11-03 用户（原文）：「不要抛错，直接绕过去。敌对和末影龙都不要」「不要不动和遇到停住」。
   *    光靠 `entityCost` 不够 —— vendor 只在**生成节点那一刻**按当时实体位置算（`lib/movements.js` 9 处），
   *    路径定好之后怪再走进通道，A* 完全不知道，执行层就只能顶着走、被卡住、然后收工。
   *    所以再挂一条**每次重算都现算**的禁行区：把实体现在占着的格子按 60/格计费
   *    （≈ 多绕 60 步，抵得过任何绕远），于是「怪站在唯一通道里」也会被推着从它旁边挤过去。
   *    `exclusionAreasStep` 是 vendor `lib/movements.js:99-132` 的函数数组，返回权重累加。 */
  mv.exclusionAreasStep = [
    (blk) => {
      try {
        const es = b.entities
        if (!es || !blk?.position) return 0
        const px = blk.position.x + 0.5
        const py = blk.position.y
        const pz = blk.position.z + 0.5
        let n = 0
        for (const k in es) {
          const e2 = es[k]
          if (!e2 || e2 === b.entity || !e2.position) continue
          if (!shouldDodgeEntity(e2)) continue
          const q = e2.position
          /* 实体占的格 = 脚那一格 + 它高度覆盖到的格（末影人 3 格高、玩家 2 格）。 */
          const span = Math.max(1, Math.ceil(Number(e2.height) || 1.8))
          if (Math.abs(q.x - px) >= 0.9 || Math.abs(q.z - pz) >= 0.9) continue
          if (py < Math.floor(q.y) - 0.2 || py > Math.floor(q.y) + span - 1 + 0.2) continue
          n++
        }
        return n * 60
      } catch { return 0 }
    }
  ]
  /* 🔴 2026-10-30（m14028「往上垫有时候会失败，视线会慢慢移动到脚下那格」）：
   *    发包时朝向是**逐 tick 爬**的（`physics.js:169`，`0.05 * yawSpeed` = 0.15 rad
   *    ≈ 8.6°/tick，转 90° 要 11 个 tick），而放置/挖掘这类发包操作只等一次发包
   *    就把 packet 送出去 ⇒ 服务端看到的朝向还在半路。提到 60 ⇒ 一 tick 转 3 rad，
   *    任何转头一次到位。只影响发包平滑，不影响碰撞/移动方向。 */
  try {
    if (b.physics) { b.physics.yawSpeed = 60; b.physics.pitchSpeed = 60 }
  } catch { /* 没装 physics 插件就跳过 */ }
  /* 门进 `mv.openable`（2026-10-18 晚第二版，用户实机："你屋里我寻路进不去，
   * 我的寻路不会开门，只会硬挖，已经挖了你两块木板"）。
   *
   * 为什么这次敢开：`openable` 只影响**规划**里"这一格算不算实心"；
   * `patchDoorMoves` 会把门那一步的 `useOne` **全部删掉**（见下），所以：
   *   · A* 眼里门是能穿过去的（不再绕墙/挖墙），
   *   · `toPlace` 永远是空的 ⇒ 不会触发 vendor 那个"`useOne` 是最后一步 ⇒
   *     `shift()` 出 undefined ⇒ 读 `placingBlock.y` 抛 TypeError"的崩溃路径，
   *   · 真正开门仍由 400ms 的 `openNearbyDoor` 负责（够得着才按，按过冷却）。
   *
   * vendor 自带的 `openable` 只收名字含 `gate` 的方块（门/活板门根本不在里面），
   * 所以这里要自己把木门/木活板门/木栅栏门塞进去（铁门按不开，不算）。 */
  try {
    const B = b.registry?.blocksArray
    if (Array.isArray(B)) {
      for (const blk of B) {
        const nm = String(blk?.name ?? '')
        if (!DOOR_BLOCK_RE.test(nm) || IRON_DOOR_RE.test(nm)) continue
        if (Number.isFinite(blk.id)) mv.openable.add(blk.id)
      }
    }
  } catch {}
  mv.canDig = self.cfg.walkCanDig !== false        // 挡路的方块可以挖穿（不然掉坑里出不来）
  /* 2026-10-31：垫一格按“多绕 N 步”计价。上游默认 1 太便宜 ⇒ `allowTower:true` 时
   *   “能跳上去 / 能绕”的地方也一路垫方块。现在只有真没路才垫。
   * 🔴 2026-11-02 审计（#9）：这里以前就把 `cfg.walkTowerCost ?? 4` 写进 `mv.placeCost` ——
   *   可紧接着的 `applyProfile()` 会用地形档案**无条件覆盖** `placeCost`，
   *   于是 `walkTowerCost` 是个**死配置**（用户改了不起任何作用）。
   *   现在：默认走向地形档案，只有显式配了才覆盖 —— 见 `applyProfile` 后面那段。 */
  /* 🔴 2026-10-30：往下挖的加价系数（vendor `getMoveDown` / `getMoveDropDown` 里用）。
   * 见 `tools/patch-mc-deps.mjs` 那条补丁：这两个 move 以前是"要挖就整条判死"，
   * 导致实心柱落差 > maxDropDown 时永远 NoPath；现在改成按挖价乘这个系数。
   * 3 是照"竖井 22×3=66 > 阶梯 44"定的 —— 下矿仍走阶梯，柱顶才肯挖。
   * ⚠️ 没登记进 `core.mjs` 的 DEFAULTS：那个文件已经卡在 1000 行上限，加不进去；
   *    省略即用 vendor 的 `?? 3`，要走 cfg 直接传 `walkDigDownFactor` 即可。 */
  mv.digDownFactor = Number(self.cfg?.walkDigDownFactor ?? 3)
  mv.allowSprinting = true
  mv.dontMineUnderFallingBlock = true
  /* 危险方块进寻路黑名单（mc_map 第二轮）：`blocksToAvoid` 决定"这格能不能站"
   * （`movements.js:233` 的 `b.safe`），上游只放了 fire/cobweb/web/lava ——
   * 把仙人掌 / 细雪 / 甜浆果丛 / 岩浆块 / 营火补上，A* 会主动绕开。 */
  for (const id of avoidBlockIds(b)) mv.blocksToAvoid.add(id)
  /* 🔴 2026-10-24 用户实机：「现在寻路老是会跑到树上」。
   *    `blocksToAvoid` 治不了这个 —— 它只管"这格能不能站"，而树叶/原木的 `boundingBox`
   *    本来就是 `block`（`safe` 已经是 false）；真正的病是 `safeOrBreak` 认为"不能站但能挖开"，
   *    而挖树叶的 laborCost（约 4.6–7.6）比绕树（2–3 步）便宜 ⇒ A* 一路挖着树冠往上爬。
   *    塞进 `blocksCantBreak` 之后 `safeToBreak()` 返回 false ⇒ 那条 move 记 100（不可行）。
   *    ⚠️ 只影响**寻路**；`mc_dig` 砍树不走 A*，照旧能砍。 */
  for (const id of treeBlockIds(b, { leaves: false })) mv.blocksCantBreak.add(id)
  /* 🔴 2026-10-29 用户实机：「出生在树上 → 困在竖井里（头顶 7 格净空）」。
   *   上次把**树叶也塞进 blocksCantBreak**，代价是“站在树冠上四面全是树叶”时彻底无路可走：
   *   A* 不许挖、我们自己的兜底补挖也照抄了同一条线 ⇒ 只能报错让模型自己猜该挖哪块。
   *   树叶挖起来 0.2 秒、不掉落、不塌，比绕路 20 格便宜得多 —— 该挖。
   *   现在改成**加价**（默认 ×6）：`laborCost` 乘上去之后绕树（2~3 步）仍然远便宜于挖树叶
   *   （基础 4.6~7.6 ⇒ 约 28~46 步）⇒ 平时不往树上爬；真被树叶围住时它是唯一出路，A* 就会挖。 */
  try {
    const pen = {}
    for (const blk of b?.registry?.blocksArray ?? []) {
      if (blk && isLeafBlock(blk.name) && typeof blk.id === 'number') pen[blk.id] = self.cfg.walkLeafDigPenalty ?? 6
    }
    mv.dshBreakPenalty = pen
  } catch { /* registry 形状不对就不加价（退化成上游默认） */ }
  /* 🔴 2026-10-27 实机（session-514c21b6，**AI 自己记的账**）：
   *   「**床没了**：我在家附近用 noDig:false（即 `allowDig:true`）走动时把 black_bed (-10,79,38) 挖掉，
   *     掉落的床 5 分钟后消失 → 重生点失效，要重做一张床」。
   *   那次走路是**上游 A* 在挖**：`CARVE_PROTECTED`（床/箱子/工作台/熔炉/附魔台/信标/
   *   刷怪笼/传送门/矿石…）只拦 DSH 自己的 `carveStepAhead` / `stepUp`（`diggableBlock`），
   *   上游 A* 的 dig 只看它自己的 `blocksCantBreak`（vendor 默认只有 chest + 不可挖方块）
   *   ⇒ 保护名单根本管不到它，"走路"就把家里的床砸了，而且掉落物 5 分钟就消失。
   *   这里把**同一张名单**灌进去：受保护方块 A* 一律不许挖。
   *   ⚠️ 只影响**寻路**；`mc_dig` / `mc_act{break}` 是 AI 显式下令，不走 A*，照旧能挖。 */
  for (const blk of b?.registry?.blocksArray ?? []) {
    const nm = String(blk?.name ?? '')
    if (Number.isFinite(blk?.id) && CARVE_PROTECTED.test(nm)) mv.blocksCantBreak.add(blk.id)
  }
  /* 🔴 2026-10-23（二档，移植自 mindcraft / baritone 的同一个坑）：
   *    `avoidBlockIds()` 里含 `lava` ⇒ 一旦人**真掉进岩浆**，A* 眼里四面八方全是
   *    "不能站"，就再也规划不出"游出去"的路（只剩原地跳的 Escape）。
   *    规则改成**看当下状态**：脚下是岩浆时把 lava 从黑名单里放出来（能规划穿岩浆脱困），
   *    不在岩浆里时才把它当禁区。`src/movement.mjs` 每轮走路前都会重建一份 Movements，
   *    所以掉进去之后下一轮就生效。
   *    ⚠️ 只放 `blocksToAvoid`，不往 `mv.liquids` 里加 lava —— 那等于告诉 A*
   *    "岩浆湖是水下通道"，平时就会规划着往里钻。 */
  const lavaId = b?.registry?.blocksByName?.lava?.id
  if (typeof lavaId === 'number') {
    /* 🔴 2026-10-27：判据从 `entity.isInLava` 换成 `inLavaNow`（照 `inWaterNow` 的三层兜底）——
     *    浮在岩浆表面时 `entity.isInLava` 可能读不到，于是 lava 留在黑名单里，A* 连"游出去"都规划不出来。 */
    let inLava = false
    try { inLava = inLavaNow(b) } catch { /* 假 bot 没有 entity */ }
    if (inLava) mv.blocksToAvoid.delete(lavaId)
    else mv.blocksToAvoid.add(lavaId)
    mv.__dshInLava = inLava
  }
/* 2026-10-29 用户：“耕地 / 土径这两个去掉” —— 原来把 farmland / dirt_path
 * 塞进 mv.blocksToAvoid（代价：踩上去会把耕地变回泥土、土径踩成泥土）。
 * 代价是“唯一通路是耕地时 A* 直接 NoPath”—— 用户宁可踩坏也要能走。
 * 现在耕地/土径就是普通可站方块；`protectFarmland` 配置项一并废弃。 */
  /* 🔴 2026-10-19 用户：「还有把末影传送门视为危险方块」——
   *    `blocksToAvoid` 是"这格**能不能站**"（`movements.js:233`），里面一旦混进传送门，
   *    A* 就永不生成"站进门里"的节点，人只会在门外打转（末地/下界都进不去）。
   *    传送门是**目的地**不是危险：这里显式剔除（上游目前没加，纯属兜底 —— 免得哪天
   *    有人看名字顺手把 `_portal` 塞进 `avoidBlockIds()`）。清理逻辑本身由
   *    `src/movement.mjs` 的 `PORTAL_RE` 一处说了算。 */
  for (const nm of ['end_portal', 'end_gateway', 'nether_portal']) {
    const id = b?.registry?.blocksByName?.[nm]?.id
    if (typeof id === 'number') mv.blocksToAvoid.delete(id)
  }
  // 垫方块（pathfinder 的 scaffolding）：上游默认 `placeCost = 1`，比挖一格（4）还便宜 4 倍
  // ⇒ A* 有得垫就垫，下坡时表现为"横向往行进方向垫方块"（`movements.js:372-385` 的
  // `getMoveForward`：斜前方下面那格是空气就计划 toPlace）。平地上调高到 12，让它变成最后手段：
  // 掉进 1 格坑里垫出来那种仍然会垫（那时只有这一条路），下坡时改成绕路 / 挖穿。
  // ⚠️ 不能靠清空 `scafoldingBlocks` 来治 —— `remainingBlocks === 0` 会把
  // `getMoveUp`（1×1 柱子）那条路一起剪掉，机器人就爬不出坑了。
  applyProfile(mv, profile)
  /* 🔴 2026-11-02 审计（#9）：垫一块的价钱 —— 地形档案给默认（平地 12 / 沟 8 …），
   *   用户显式配 `walkTowerCost` 时才盖掉它（`null` = 不覆盖，见 core.mjs 默认值）。 */
  if (self.cfg?.walkTowerCost != null && Number.isFinite(Number(self.cfg.walkTowerCost))) {
    mv.placeCost = Number(self.cfg.walkTowerCost)
  }
  /* 🔴 2026-10-27 用户：「noDig:false 还是优先走现有路线，false 应该直接按最短路线挖」（旧字段名，现 `allowDig:true`）——
   *   `applyProfile` 按地形给的 `digCost` 是 3~8（挖一格石头 ≈ 走 16~44 步，见 `src\terrain.mjs`），
   *   A* 因此宁可绕远路也不挖。**显式 `allowDig:true`（"允许挖"）时就该反过来**：把挖按
   *   "多走一步"计价，让它走最短的那条（该挖就挖），而不是"能不挖就绕"。
   *   ⚠️ 只改成本，不碰 `canDig` / `blocksCantBreak` / `blocksToAvoid` / 岩浆黑名单 ——
   *   安全边界照旧。`cfg.walkDigFirst:false` 可退回"能绕就绕"，`cfg.walkDigFirstCost` 微调。 */
  /* 2026-10-31：`digFirst` 的开关收归调用方（`movement.mjs` 读 `cfg.walkDigFirst`）——
   * 这里再判一次 cfg 等于两处开关，`walkDigFirst:false` 时连显式传 true 都失效，难查。 */
const digFirstOn = digFirst === true
  if (digFirstOn) mv.digCost = Number(self.cfg?.walkDigFirstCost ?? 0.4)
  /* 🔴 2026-10-27（用户：「nodig false 最短现在会挖家，ai 也没意识到要切换，设置个绕路最大
   *   限制大于 15 格在挖」）—— 光压 `digCost` 等于"挖一格 ≈ 走一步"，A* 会挖穿自家墙地板。
   *   每挖一格再记 `walkDigDetourMax`（默认 15）步 ⇒ 绕 15 格以内不挖，超过才挖。 */
  if (digFirstOn) patchDigDetour(mv, { perBlock: Number(self.cfg?.walkDigDetourMax ?? 15) })
  mv.scafoldingBlocks = scaffoldingItemIds(b)      // 背包里能垫的方块（**item id**，见该函数注释）
  /* 🔴 2026-10-30：搭桥收进 A* 之后，"垫一格"的额外代价（vendor `getMoveForward` 里读）。
   *    默认 5 ⇒ 走一格 1、垫一格 6+；平地绝不会铺，沟边才比"绕 5 格"划算。
   *    只有 `mc_move{allowBridge:true}`（`mv.allowBridge`）打开时这条边才生成。 */
  mv.bridgeCost = Number(self.cfg?.walkBridgeCost ?? 5)
  /* 2026-10-18：门只许"按开"，不许挖；已经开着就别再按（否则等于关回去）。见 `patchDoorMoves`。 */
  /* `preferDoors`（默认开）：给"还要挖方块"的移动加 8 点惩罚 —— 平地挖一格石头本来
   * 就要 ~18 点（`digCost` 4 × (1 + 3×挖掘秒数)），再 +8 基本等于"多绕二十几步"，
   * 有门就走门。用户要挖墙可以显式 `preferDoors:false`，或直接叫 `mc_dig`。 */
  const preferDoors = self.cfg.preferDoors !== false
  /* 门那 8 点惩罚是"有门就走门"用的；挖路优先（digFirst）时它会把"挖一格捷径"又顶回绕路去。 */
  patchDoorMoves(mv, {
    digPenalty: (digFirstOn || !preferDoors) ? 0 : Number(self.cfg.doorDigPenalty ?? 8),
    parkourPenalty: Number(self.cfg.walkParkourPenalty ?? 4),
    /* 只有"允许挖"那趟才收方向税；不许挖那趟压根没有 toBreak 边，收了也没意义。 */
    digDirTax: allowDig === true ? Number(self.cfg.walkDigSideTax ?? 15) : 0,
  })
  /* 2026-10-22 用户实机：「现在寻路会踩在岩浆块上掉血」—— 站上去会掉血的地板加点重罚，让它绕开。
   * 为什么光有 `blocksToAvoid` 不够，见 `patchHarmfulFloorMoves` 的注释（那名单管"能不能站"，
   * 而岩浆块是实心的、人站在它上面，脚那格永远是空气 ⇒ 那条路从来就没生效过）。 */
  patchHarmfulFloorMoves(mv, { penalty: Number(self.cfg.walkHarmfulFloorPenalty ?? 60) })
  /* 作物/花草：「这一格能站进去」（`carpets`）—— 见 `patchPlantPassable` 的注释
   * （用户 2026-10-22：「家里非实体方块走不了」，整片麦田被 A* 当成墙）。 */
  patchPlantPassable(mv, b)
  /* 藤蔓族能爬（2026-10-23 二档）：vendor 只认梯子，`vine` 那行是注释掉的。 */
  patchClimbables(mv, b)
  return mv
}

/**
 * 按当前地形**重挂**一份 `Movements`（`b.pathfinder.setMovements`），返回
 * `{ terrain, profile, changed }`；没挂上 pathfinder 就回 `null`。
 *
 * 这是"地形变了就换策略"的唯一入口 —— `src/movement.mjs` 每次走路前调它。
 */
export function adaptMovements (self, { feet = null, radius = null } = {}) {
  const b = self.bot
  if (!b?.pathfinder || typeof b.pathfinder.setMovements !== 'function') return null
  if (!self.pfReady) return null
  const terrain = radius == null ? classifyTerrainCached(b, { feet }) : classifyTerrainCached(b, { feet, radius })
  const mv = movements(self, { terrain })
  if (!mv) return null
  try { b.pathfinder.setMovements(mv) } catch { return null }
  const profile = profileFor(terrain.kind, self.cfg)
  return { terrain, profile, mv }
}

/**
 * 我们**自己按开**的门：vendor 的 `useOne` 是无条件 `activateBlock` ——
 * 定时器刚把门按开，它走到门口又按一下，等于**把门关回去**（实机："开了但不走门"）。
 * 这里给 `b.activateBlock` 加一层"最近被我们打开过的门，重复按直接忽略"。
 * 只在 12 秒内、且门**现在确实是开着**时才忽略；别人关了/状态不明就照常按。
 */
export function guardDoorActivate (b) {
  if (!b || typeof b.activateBlock !== 'function' || b.__doorGuard) return b
  const orig = b.activateBlock.bind(b)
  b.__doorGuard = true
  b.__autoOpenedDoors = new Map()
  b.activateBlock = async function (blk, ...rest) {
    /* 🔴 2026-11-02 审计（#10）：这里原来是一份**自己写的门判据**，两个毛病：
     *   ① key 直接取传入那格的整数坐标 —— 可门占上下两格：`openNearbyDoor` 记的是下半格，
     *      vendor 的 `useOne` 常常传上半格 ⇒ 同一个 key 对不上，守卫等于没生效（门被按回去）；
     *   ② 状态读不到就 `open = false` ⇒ **"不知道"被当成"关着"**，这和 `doorOpenStateOf()`
     *      在 movement.mjs 里立的规矩（不知道 ≠ 关着）正好相反。
     *   现在：上下两半的 key 都试，状态只认 `doorOpenStateOf()` 这一个判据。 */
    const posOf = blk?.position
    const keyOf = (p) => (p && Number.isFinite(p.x) && Number.isFinite(p.z))
      ? `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}` : null
    const keys = []
    const k0 = keyOf(posOf)
    if (k0) {
      keys.push(k0)
      let upper = false
      try { upper = blk.getProperties?.()?.half === 'upper' } catch { upper = false }
      const kOther = keyOf(upper ? { x: posOf.x, y: posOf.y - 1, z: posOf.z } : { x: posOf.x, y: posOf.y + 1, z: posOf.z })
      if (kOther) keys.push(kOther)
    }
    const at = keys.map((k) => b.__autoOpenedDoors.get(k)).find((t) => Number.isFinite(t)) ?? null
    if (at && Date.now() - at < 12_000) {
      const seen = doorOpenStateOf(blk)
      if (seen === 'open') { for (const k of keys) b.__autoOpenedDoors.delete(k); return }
      /* 明确关着 = 记录作废，让它按（有人自己关上了）；读不出状态就照常按，不当成关着也不当成开着。 */
      if (seen === 'closed') for (const k of keys) b.__autoOpenedDoors.delete(k)
    }
    return orig(blk, ...rest)
  }
  return b
}

/**
 * 把**现成的**生态插件都挂上（`MC_DEPS` 里那几个）。缺哪个只是少那项能力，其它照旧。
 *
 * 顺序有依赖：pathfinder 必须最先（collectBlock / pvp 都要用它的 `Movements`）。
 * 用户 2026-10-06 的要求："不要自己写，用现成的项目" —— 走路/挖/捡/换工具/打怪/吃饭
 * 全部交给 PrismarineJS 生态，`core.mjs` 只留编排和"诚实报错"。
 */
export async function setupPlugins (self, { spec = null } = {}) {
  const b = self.bot
  if (!b) return { pathfinder: false }
  const out = { pathfinder: false, collectBlock: false, tool: false, pvp: false, autoEat: false, hawkeye: false }
  // 成功细节（"找到了哪个文件"）走 debug：依赖横幅原来每个连接重打一遍，占全日志 31.5%
  const log = (m) => self.logDebug(m)
  const logWarn = (m) => self.log(m)      // 候选不可用 / 形状不对：真出问题时要看得见
  out.pathfinder = await setupPathfinder(self, { spec }).catch((e) => { self.log('pathfinder 初始化异常：' + e.message); return false })
  /* 门：① 规划时别挖门/别重复按（`patchDoorMoves`，在 `movements()` 里）；
   *     ② 执行时"我们刚按开的门"别被 vendor 的 useOne 再按回去（`guardDoorActivate`）。 */
  guardDoorActivate(b)
  guardDoorDig(b, { log: (m) => self.log(m) })
  const mv = self.pfReady ? movements(self) : null

  // ① 走过去挖方块 / 捡掉落物（内部自己用 mineflayer-tool 换工具）
  try {
    const fn = await loadMcDep('collectBlock', { log, logWarn })
    if (fn) {
      if (typeof b.collectBlock?.collect !== 'function') b.loadPlugin(fn)
      if (mv && b.collectBlock) b.collectBlock.movements = mv
      out.collectBlock = typeof b.collectBlock?.collect === 'function'
    }
  } catch (e) { self.log('collectBlock 挂载失败：' + e.message) }

  // ② 按方块挑最好的工具（dig 会用它）
  try {
    const fn = await loadMcDep('tool', { log, logWarn })
    if (fn) {
      if (typeof b.tool?.equipForBlock !== 'function') b.loadPlugin(fn)
      out.tool = typeof b.tool?.equipForBlock === 'function'
    }
  } catch (e) { self.log('tool 挂载失败：' + e.message) }

  // ③ 追击并打怪
  try {
    const fn = await loadMcDep('pvp', { log, logWarn })
    if (fn) {
      if (typeof b.pvp?.attack !== 'function') b.loadPlugin(fn)
      if (mv && b.pvp) b.pvp.movements = mv
      out.pvp = typeof b.pvp?.attack === 'function'
    }
  } catch (e) { self.log('pvp 挂载失败：' + e.message) }

  /* ③.5 射箭弹道（`mc_shoot` 用）。**每次射之前还会再 bind 一遍**
   *      （`src\shoot.mjs`：它的 bot 是模块级单例，同进程连第二个号就会拿错坐标）。 */
  try {
    const fn = await loadMcDep('hawkeye', { log, logWarn })
    if (fn) {
      if (typeof b.hawkEye?.getMasterGrade !== 'function') fn(b)
      out.hawkeye = typeof b.hawkEye?.getMasterGrade === 'function'
    }
  } catch (e) { self.log('hawkeye 挂载失败：' + e.message) }

  // ④ 饿了自动吃（**默认不开自动**：由 mc_auto 按自己的开关决定，免得两套逻辑抢）
  try {
    const fn = await loadMcDep('autoEat', { log, logWarn })
    if (fn) {
      if (!b.autoEat) b.loadPlugin(fn)
      if (b.autoEat?.setOpts) {
        b.autoEat.setOpts({
          priority: 'foodPoints',
          minHunger: Number(self.cfg.autoEatAt ?? 14),
          minHealth: 0,
          returnToLastItem: true,
          offhand: false,
          eatingTimeout: 10_000,
          strictErrors: false,
        })
      }
      b.autoEat?.disableAuto?.()
      out.autoEat = typeof b.autoEat?.eat === 'function'
    }
  } catch (e) { self.log('autoEat 挂载失败：' + e.message) }

  self.mcPlugins = out
  /* ⑤ 修 `bot.digTime`：它是**实际挖掘时长**（不是估算），而上游数据把 108 个"要石镐以上"的方块的
   *    material 写成了 `incorrect_for_wooden_tool` ⇒ 铁矿不管拿什么镐都按 4550ms 挖（真值 750ms）。
   *    见 `src\dig-speed.mjs` 的 `fixDigMs` / `patchDigTime` 注释。失败不影响别的功能。 */
  try { patchDigTime(b) } catch (e) { self.log('修 digTime 失败（不影响其它功能）：' + e.message) }
  const have = Object.entries(out).filter(([, v]) => v).map(([k]) => k)
  // 每个连接都会重打一遍（每个连接是新的模块实例）⇒ 进程内只留一行
  self.logOnce('deps-ready', `现成插件就绪：${have.length ? have.join(' / ') : '（一个都没有）'}`)
  return out
}

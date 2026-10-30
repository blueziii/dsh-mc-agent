#!/usr/bin/env node
/**
 * tools/patch-mc-deps.mjs —— 把我们对 **vendor 依赖**（`mineflayer-pathfinder` 等）打的补丁重新打上。
 *
 * 为什么要这个脚本：vendor 树在 `%USERPROFILE%\.dsh\profiles\<profile>\vendor\mc-deps\`
 * 里（见 PATHFINDER.md），重装 / 升级依赖时会被整包覆盖，我们改过的文件就回到原版 ——
 * 症状是「以前修好的毛病又回来了」，而且很难联想到是依赖被覆盖。
 *
 * 用法：
 *   node tools/patch-mc-deps.mjs           # 打补丁（幂等，已打过就跳过）
 *   node tools/patch-mc-deps.mjs --check   # 只检查，不改文件；缺补丁时 exit 1
 *   node tools/patch-mc-deps.mjs --dir <vendor 树>   # 指定 vendor 目录
 *
 * 目前自动化的是 `mineflayer-pathfinder/index.js` 里的四处（2026-10-24 垫柱悬空）。
 * 其它补丁（`lib/physics.js` 的 canStraightLine、`lib/movements.js` 的斜切拐角、
 * index.js 的水下 jump）只做**存在性检查** —— 它们的改法写在踩坑档案里，脚本不重放。
 */
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'

const HERE = dirname(fileURLToPath(import.meta.url))
const args = process.argv.slice(2)
const CHECK_ONLY = args.includes('--check')
const dirArgIdx = args.indexOf('--dir')
const DIR_ARG = dirArgIdx >= 0 ? args[dirArgIdx + 1] : null

/** 找 vendor 树（含 node_modules/mineflayer-pathfinder 的目录） */
function pickVendor () {
  const cands = []
  if (DIR_ARG) cands.push(DIR_ARG)
  if (process.env.DSH_MC_AGENT_MC_DEPS) cands.push(process.env.DSH_MC_AGENT_MC_DEPS)
  cands.push(join(HERE, '..', '..', 'vendor', 'mc-deps'))
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  const profRoot = join(home, 'profiles')
  if (existsSync(profRoot)) {
    for (const ent of readdirSync(profRoot, { withFileTypes: true })) {
      if (ent.isDirectory()) cands.push(join(profRoot, ent.name, 'vendor', 'mc-deps'))
    }
  }
  for (const c of cands) {
    const nm = join(c, 'node_modules')
    if (existsSync(nm) && existsSync(join(nm, 'mineflayer-pathfinder'))) return c
  }
  return null
}

const VENDOR = pickVendor()
if (!VENDOR) {
  console.error('✗ 找不到 vendor 树（含 node_modules/mineflayer-pathfinder）。用 --dir 指定。')
  process.exit(1)
}
const PF_DIR = join(VENDOR, 'node_modules', 'mineflayer-pathfinder')
const IDX = join(PF_DIR, 'index.js')

let src = readFileSync(IDX, 'utf8')
const EOL = src.includes('\r\n') ? '\r\n' : '\n'
let changed = 0
let missing = 0

/** 幂等替换：已含新文本就跳过；否则要求旧锚点存在 */
function rep (oldText, newText, label) {
  const n = newText.split('\n').join(EOL)
  if (src.includes(n)) { console.log(`  = ${label}（已打过）`); return }
  const o = oldText.split('\n').join(EOL)
  if (!src.includes(o)) { console.error(`  ✗ ${label}：锚点找不到（vendor 版本变了？）`); missing++; return }
  src = src.replace(o, n)
  changed++
  console.log(`  + ${label}`)
}

console.log(`vendor: ${VENDOR}`)
console.log('mineflayer-pathfinder/index.js:')

rep(
  '  let placing = false\n  let placingBlock = null',
  '  let placing = false\n  /* 🔴 2026-10-30 DSH：自己放/自己挖造成的变化不算“路没了”（垫柱每垫一格都会改脚下那格）。\n   * ① `placing` / `digging` 期间（正自己在动）直接忽略；\n   * ② DSH 侧绕过 pathfinder 单独放/挖的，用 `bot.pathfinder.markExpected(pos)` 预登记，\n   *    命中一次就消费掉；5 秒没命中自动过期（防泄漏）。 */\n  const expectedChanges = new Map()\n  const EXPECTED_TTL_MS = 5000\n  const posKeyOf = (p) => `${Math.floor(Number(p?.x))},${Math.floor(Number(p?.y))},${Math.floor(Number(p?.z))}`\n  function takeExpected (p) {\n    const k = posKeyOf(p)\n    const t = expectedChanges.get(k)\n    if (t == null) return false\n    expectedChanges.delete(k)\n    return Date.now() - t <= EXPECTED_TTL_MS\n  }\n  let placingBlock = null',
  '自己造成的变化不作废路径：expectedChanges + markExpected'
)

rep(
  '  bot.on(\'blockUpdate\', (oldBlock, newBlock) => {\n    if (!oldBlock || !newBlock) return\n    if (isPositionNearPath(oldBlock.position, path) && oldBlock.type !== newBlock.type) {',
  '  bot.on(\'blockUpdate\', (oldBlock, newBlock) => {\n    if (!oldBlock || !newBlock) return\n    /* 🔴 2026-10-30 DSH：自己造成的变化不作废路径。\n     *    实机：垫柱 1.3 秒垫了 2 格就被 `block_updated` 清空整条路，一趟只上 1~2 格。 */\n    if (placing || digging) return\n    if (takeExpected(oldBlock.position)) return\n    if (isPositionNearPath(oldBlock.position, path) && oldBlock.type !== newBlock.type) {',
  'blockUpdate：自己放的/自己挖的不 resetPath'
)

rep(
  '  bot.pathfinder = {}',
  '  bot.pathfinder = {}\n  /* DSH：告诉 pathfinder「接下来这一格是我自己改的」—— blockUpdate 里消费掉，不作废路径。 */\n  bot.pathfinder.markExpected = (pos) => {\n    if (!pos) return\n    expectedChanges.set(posKeyOf(pos), Date.now())\n  }',
  '暴露 bot.pathfinder.markExpected(pos)'
)

rep(
  '  let placingBlock = null\n  let lastNodeTime = performance.now()',
  '  let placingBlock = null\n  let placingStartedAt = 0\n  let placingBestY = 0\n  let digStartedAt = 0\n  let lastNodeTime = performance.now()',
  '计时变量：placingStartedAt / digStartedAt'
)

rep(
  '  bot.pathfinder.LOSWhenPlacingBlocks = true',
  '  bot.pathfinder.LOSWhenPlacingBlocks = true\n'
  + '  /* 🔴 2026-10-25 DSH：放方块前不再 sneak+back 贴到方块边缘（那是给真人防掉下去的姿态）。\n'
  + '   *    站在当前格就能放到相邻格（约 1.4 格）。要恢复旧行为把它设成 true。 */\n'
  + '  bot.pathfinder.sneakWhenPlacing = false',
  '默认不蹲着贴边（sneakWhenPlacing = false）'
)

rep(
  '    // While the bot is not in the right position rotate the view and press back while crouching\n'
  + '    if (bot.entity.position.distanceTo(refBlock.clone().offset(edge.x + 0.5, 1, edge.z + 0.5)) > 0.4) {',
  '    /* 🔴 2026-10-25 DSH 补丁（用户：「搭路是蹲着到方块边缘放，其实站在前一格就能直接放」）：\n'
  + '     *    原来放方块前会 sneak + back 贴到边缘（每块多花约 1 秒，还容易把自己挤下边缘）。\n'
  + '     *    关掉开关后直接站在当前格放：相邻格在 4.5 格可达范围内，脚下是实地就不会掉。 */\n'
  + '    if (bot.pathfinder.sneakWhenPlacing === false) return true\n'
  + '    // While the bot is not in the right position rotate the view and press back while crouching\n'
  + '    if (bot.entity.position.distanceTo(refBlock.clone().offset(edge.x + 0.5, 1, edge.z + 0.5)) > 0.4) {',
  '放方块前不再蹲着贴边（sneakWhenPlacing=false）'
)

rep(
  `      if (!placing) {
        placing = true
        placingBlock = nextPoint.toPlace.shift()
        fullStop()
      }`,
  `      if (!placing) {
        placing = true
        placingStartedAt = performance.now()
        placingBestY = bot.entity.position.y
        placingBlock = nextPoint.toPlace.shift()
        placingEquipped = false
        fullStop()
      }`,
  '垫柱计时：记录开始时间（+2026-10-27 复位预装备标记）'
)

rep(
  `      let canPlace = true
      if (placingBlock.jump) {
        bot.setControlState('jump', true)
        canPlace = placingBlock.y + 1 < bot.entity.position.y
      }`,
  `      let canPlace = true
      if (placingBlock.jump) {
        /* 🔴 2026-10-24 DSH 补丁：原来"先按 jump，再判断够不够高"，
         * 而这条路径末尾的 "return" 在 3500ms 卡住检测**之前** ——
         * 头顶被顶板 / 树叶挡住、永远升不到放置高度时，jump 会一直按着，
         * 卡住检测永远轮不到它。实机现象：「正在垫方块往上爬，悬空超过 3 秒才掉下来」。
         * 现在：达不到高度只按有限的时间（bot.pathfinder.placeJumpTimeout，默认 1500ms），
         * 到点就松开 jump 并 resetPath，让外层照常重算 / 换招。 */
        canPlace = placingBlock.y + 1 < bot.entity.position.y
        if (!canPlace) {
          /* 🔴 2026-10-25 DSH 补丁（用户：「水里搭不了方块的原因是上浮比普通跳跃慢」）：
           *   水里按住 jump 的上浮速度只有 ~0.6 格/秒（陆上起跳是瞬间 1.25 格），
           *   1500ms 根本升不到放置高度 ⇒ 每次都被判超时，水下垫柱子/搭桥永远失败。
           *   两处放宽：① 水里时限放到 6 秒（陆上仍是 1500）；
           *   ② 只要这一跳还在往上走（比本跳最高点又高 0.15 格）就重新计时，
           *   别把“慢慢在上升”当成“卡住了”。
           */
          const yNow = bot.entity.position.y
          if (yNow > placingBestY + 0.15) {
            placingBestY = yNow
            placingStartedAt = performance.now()
          }
          const isW = (nm) => /^(water|flowing_water|bubble_column|kelp|kelp_plant|seagrass|tall_seagrass)$/.test(String(nm ?? ""))
          const inWater = bot.entity?.isInWater === true
            || (() => { try { return isW(bot.blockAt(bot.entity.position.floored(), false)?.name) || isW(bot.blockAt(bot.entity.position.floored().offset(0, 1, 0), false)?.name) } catch (e) { return false } })()
          const jumpLimit = bot.pathfinder.placeJumpTimeout ?? (inWater ? 6000 : 1500)
          if (performance.now() - placingStartedAt > jumpLimit) {
            bot.setControlState('jump', false)
            resetPath('place_jump_timeout')
            return
          }
          bot.setControlState('jump', true)
          return
        }
        bot.setControlState('jump', false)
      }`,
  '垫柱跳跃：限时 + 水里放宽 + 有进展就重计时'
)

rep(
  `          })
          .catch(_ignoreError => {})
      }
      return`,
  `          })
          .catch(_ignoreError => {
            /* 🔴 2026-10-24 DSH 补丁：装备失败原来什么都不做 ⇒ lockEquipItem 永不释放、
             * placing 永远为 true，这条路径**永久卡死**（每 tick 都在 tryAcquire 处 return，
             * 连 3500ms 卡住检测都到不了）。 */
            lockEquipItem.release()
            resetPath('equip_error')
          })
      }
      return`,
  '装备失败：释放锁 + 结束路径'
)

/* ── 2026-10-24 寻路通审：挖掘分支的永久粘住 ───────────────────────────── */
rep(
  `      if (!digging && bot.entity.onGround) {
        digging = true
        const b = nextPoint.toBreak.shift()`,
  `      if (!digging && bot.entity.onGround) {
        digging = true
        digStartedAt = performance.now()
        const b = nextPoint.toBreak.shift()`,
  '挖掘计时：记录开始时间'
)

rep(
  `    if (digging) {
      bot.on('diggingAborted', detectDiggingStopped)
      bot.on('diggingCompleted', detectDiggingStopped)
      bot.stopDigging()
    }`,
  `    if (digging) {
      /* 🔴 2026-10-24 DSH 补丁：原来只注册事件、等 diggingAborted/diggingCompleted 来复位
       * digging。但 stopDigging() 在方块已经不存在（被别人挖了 / 服务端没回包）时
       * **一个事件都不会发** ⇒ digging 永远是 true ⇒ 之后每次移动都在挖掘分支 return，
       * 永久卡死，只能重连。实机现象：「完全卡住，tp 也不行，最后重进才好」。 */
      digging = false
      try { bot.stopDigging() } catch (e) {}
    }`,
  '挖掘状态：resetPath 时直接复位'
)

rep(
  `      return
    }
    // Handle block placement
    // TODO: sneak when placing or make sure the block is not interactive`,
  `      /* 🔴 2026-10-24 DSH 补丁：挖掘分支的 return 在 3500ms 卡住检测**之前** ——
       * 服务端不回包时 digging 永远是 true，每 tick 都在这里 return，卡住检测永远轮不到。 */
      if (digging && performance.now() - digStartedAt > (bot.pathfinder.digTimeout ?? 8000)) {
        try { bot.stopDigging() } catch (e) {}
        digging = false
        resetPath('dig_timeout')
      }
      return
    }
    // Handle block placement
    // TODO: sneak when placing or make sure the block is not interactive`,
  '挖掘分支：加超时（digTimeout，默认 8000ms）'
)

rep(
  `          bot.equip(tool, 'hand')
            .catch(_ignoreError => {})
            .then(() => digBlock())`,
  `          bot.equip(tool, 'hand')
            .then(() => digBlock())
            .catch(_ignoreError => {
              /* 🔴 2026-10-24 DSH 补丁：装备失败原来照样硬挖（拿着手上的错工具白等几秒，
               * 然后被判卡）。现在失败就结束这条路径。 */
              resetPath('dig_equip_error')
            })`,
  '挖前装备失败：结束路径而不是硬挖'
)

/* ── 2026-10-24 寻路通审：开门失败无限重试 ───────────────────────────── */
rep(
  `        }, err => {
          console.error(err)
          lockUseBlock.release()
        })`,
  `        }, err => {
          console.error(err)
          lockUseBlock.release()
          /* 🔴 2026-10-24 DSH 补丁：原来只 release 锁，placingBlock 不前进也不 resetPath
           * ⇒ 下一 tick 重试同一扇门；门打不开（铁门 / 被挡 / 够不着）就**无限重试**。 */
          resetPath('use_block_error')
        })`,
  '开门失败：结束路径而不是无限重试'
)

/* ── 2026-10-24 寻路通审：起点偏移用错 movements 对象 ─────────────────── */
rep(
  'const offset = (b && dy > 0.001 && bot.entity.onGround && !stateMovements.emptyBlocks.has(b.type)) ? 1 : 0',
  'const offset = (b && dy > 0.001 && bot.entity.onGround && !movements.emptyBlocks.has(b.type)) ? 1 : 0',
  '起点偏移：用传入的 movements 而不是全局 stateMovements'
)

if (!CHECK_ONLY && changed > 0) writeFileSync(IDX, src)

/* ── goto.js：noPath 被当成"到了" ─────────────────────────────────────── */
const GOTO = join(PF_DIR, 'lib', 'goto.js')

function repIn (file, oldText, newText, label) {
  const txt = readFileSync(file, 'utf8')
  const eol = txt.includes('\r\n') ? '\r\n' : '\n'
  const n = newText.split('\n').join(eol)
  if (txt.includes(n)) { console.log(`  = ${label}（已打过）`); return }
  const o = oldText.split('\n').join(eol)
  if (!txt.includes(o)) { console.error(`  ✗ ${label}：锚点找不到（vendor 版本变了？）`); missing++; return }
  if (!CHECK_ONLY) writeFileSync(file, txt.replace(o, n))
  changed++
  console.log(`  + ${label}`)
}

/* ── 2026-10-27：移动老是卡（用户：「卡在半空 1~2 秒才掉下来」「脚踩实地杵着不动」） ──
 * ① 暴露"最后一次为什么重置路径"（goto 被 stop 时只剩 PathStopped，真实原因全丢）；
 * ② 正常重算（block_updated / chunk_loaded / movements_updated / goal_moved）不再把整次
 *    goto 掐死 —— 以前它们走 stop()，人立刻站住，表现就是"杵着不动"；
 * ③ 垫方块改成**起跳前**预装备（equip 是一次网络往返，等回包时人已经在往下掉了）。 */
rep(
  '  let returningPos = null\n  let stopPathing = false',
  `  let returningPos = null
  let stopPathing = false
  /* 🔴 2026-10-27 DSH 补丁：最近一次 resetPath 的理由。goto 被 stop 时只剩一句
   * 'PathStopped'，真实原因（place_error / dig_error / no_scaffolding_blocks / stuck …）
   * 全丢了 —— 外层因此永远说不清"为什么卡住"。 */
  let lastResetReason = null
  /* 起跳垫方块前是否已经预装备过（见放方块段）。随每次 placing 复位。 */
  let placingEquipped = false`,
  '记录 lastResetReason / placingEquipped'
)

rep(
  `  function resetPath (reason, clearStates = true) {
    if (!stopPathing && path.length > 0) bot.emit('path_reset', reason)
    path = []`,
  `  /* 这几类 reset 只是"路径作废、下个 tick 重算"，不代表该放弃这次 goto。
   * 长路上每跨一个区块就会来一次 chunk_loaded、脚下方块一变就 block_updated ——
   * 以前它们统统走 stop()（stateGoal 清空 + path_stop）⇒ goto 以 PathStopped 拒绝、
   * 人立刻站住，实机表现就是「脚踩实地杵着不动」。 */
  const RESUMABLE_RESETS = new Set(['block_updated', 'chunk_loaded', 'movements_updated', 'goal_moved'])

  function resetPath (reason, clearStates = true) {
    lastResetReason = reason
    /* 🔴 2026-10-27 DSH 补丁：原来是
     *   if (!stopPathing && path.length > 0) bot.emit('path_reset', reason)
     * —— goto 期间 stopPathing 恒为 true，因此**一次都不外发**，外层只看到
     * goto reject 出的 PathStopped，拿不到真实原因。现在无条件外发，
     * 由外层自己过滤"正常重算"那几类（见 DSH 侧 BENIGN_RESET）。 */
    bot.emit('path_reset', reason)
    path = []`,
  'resetPath：无条件外发原因 + 正常重算不算中止'
)

rep(
  `    if (clearStates) bot.clearControlStates()
    if (stopPathing) return stop()
  }`,
  `    if (clearStates) bot.clearControlStates()
    if (stopPathing && !RESUMABLE_RESETS.has(reason)) return stop()
  }`,
  'resetPath：可恢复的重置不再 stop()'
)

rep(
  '  bot.pathfinder.isBuilding = () => placing',
  `  bot.pathfinder.isBuilding = () => placing
  /* 🔴 2026-10-27 DSH 补丁：把"最后一次为什么重置"暴露出去 —— goto 因 stop 而 reject 时，
   * 外层只能拿到 'PathStopped'，靠它才能知道真实原因（供 DSH 的 reason 归因 / 日志）。 */
  bot.pathfinder.lastResetReason = () => lastResetReason`,
  '暴露 lastResetReason'
)

rep(
  `      const block = stateMovements.getScaffoldingItem()
      if (!block) {
        resetPath('no_scaffolding_blocks')
        return
      }`,
  `      const block = stateMovements.getScaffoldingItem()
      if (!block) {
        resetPath('no_scaffolding_blocks')
        return
      }
      /* 🔴 2026-10-27 DSH 补丁（用户：「移动老是卡在半空 1~2 秒才掉下来」）：
       *  原来的顺序是「先按住 jump 升到摆放高度 → 再 bot.equip() 装备 → 装备回包后才
       *  placeBlock」。equip 是一次网络往返（几十到两百毫秒），等它回来人已经在往下掉了，
       *  placeBlock 时脚下那格往往已经不可放置 ⇒ place_error，人直接摔下去。
       *  实机统计（session-514c21b6）：**97 次坠落、累计 696 格、最深 28 格**，多发生在垫方块时。
       *  现在在**起跳之前**就把垫块拿到手上；下面那次 equip 因此多数情况是空操作。 */
      if (!placingEquipped) {
        placingEquipped = true
        if (!lockEquipItem.tryAcquire()) return
        bot.equip(block, 'hand')
          .then(function () { lockEquipItem.release() })
          .catch(function () {
            lockEquipItem.release()
            resetPath('equip_error')
          })
        return          // 这个 tick 只做预装备，下一个 tick 再决定跳不跳
      }`,
  '垫方块：起跳前先预装备（治悬空坠落）'
)

rep(
  `      if (canPlace) {
        if (!lockEquipItem.tryAcquire()) return
        bot.equip(block, 'hand')
          .then(function () {`,
  `      if (canPlace) {
        if (!lockEquipItem.tryAcquire()) return
        /* 2026-10-27：起跳前已预装备过（见上面 placingEquipped），这里若是同一件就直接跳过，
         * 把"跳起来到落地"这段窗口全留给 placeBlock。 */
        const equipP = (bot.heldItem && block && bot.heldItem.type === block.type)
          ? Promise.resolve()
          : bot.equip(block, 'hand')
        equipP
          .then(function () {`,
  '垫方块：已预装备就不再重复 equip'
)

repIn(
  join(PF_DIR, 'lib', 'goto.js'),
  `    function pathStopped () {
      cleanup(error('PathStopped', 'Path was stopped before it could be completed! Thus, the desired goal was not reached.'))
    }`,
  `    function pathStopped () {
      /* 🔴 2026-10-27 DSH 补丁：原来只抛一句 'Path was stopped...'，把"到底哪一步失败"
       * 抹平成同一类错误（外层只能报「寻路被打断」）。这里带上 vendor 记下的真实理由：
       * place_error / dig_error / no_scaffolding_blocks / stuck … 都能直达日志与模型。 */
      let why = 'unknown'
      try {
        if (typeof bot.pathfinder.lastResetReason === 'function') why = bot.pathfinder.lastResetReason() ?? 'unknown'
      } catch (e) {}
      const err = error('PathStopped', \`Path was stopped before it could be completed (\${why}). Thus, the desired goal was not reached.\`)
      err.resetReason = why
      cleanup(err)
    }`,
  'goto.js：PathStopped 带上真实原因'
)

console.log('\nmineflayer-pathfinder/lib/goto.js:')
repIn(
  GOTO,
  `    function noPathListener (results) {
      if (results.path.length === 0) {
        cleanup()
      } else if (results.status === 'noPath') {
        cleanup(error('NoPath', 'No path to the goal!'))
      } else if (results.status === 'timeout') {
        cleanup(error('Timeout', 'Took to long to decide path to goal!'))
      }
    }`,
  `    function noPathListener (results) {
      /* 🔴 2026-10-24 DSH 补丁：原来**先**判 \`path.length === 0\` 就 cleanup()（= 当成功），
       * 而 noPath 时 bestNode 往往就是起点、path 正好为空 ⇒「无路可走」被当成「到了」。
       * 外层于是收到 resolve，只能靠"到了但还差 N 格"去反推，归因全错。 */
      if (results.status === 'noPath') {
        cleanup(error('NoPath', 'No path to the goal!'))
      } else if (results.status === 'timeout') {
        cleanup(error('Timeout', 'Took to long to decide path to goal!'))
      } else if (results.path.length === 0) {
        cleanup()
      }
    }`,
  'noPath 不再被当成到达'
)
if (CHECK_ONLY) console.log(`  （--check：未写文件）`)

/* ── movements.js：自己骑的船被当成障碍（A* 每格 +entityCost） ─────────── */
console.log('\nmineflayer-pathfinder/lib/movements.js:')
repIn(
  join(PF_DIR, 'lib', 'movements.js'),
  `  updateCollisionIndex () {
    for (const ent of Object.values(this.bot.entities)) {
      if (ent === this.bot.entity) { continue }
`,
  `  updateCollisionIndex () {
    for (const ent of Object.values(this.bot.entities)) {
      if (ent === this.bot.entity) { continue }
      /* 🔴 2026-10-24 DSH 补丁：**自己骑的那条船 / 矿车**也在 bot.entities 里。
       * 原来只跳过 bot.entity ⇒ 骑着船寻路时，脚下的船被算成障碍（每格 +entityCost，我们设的 8），
       * 下船后船还停在原地继续挡路 —— 实机现象：「在船上 / 刚下船后基本走不了，走得很慢」。 */
      if (this.bot.vehicle && ent === this.bot.vehicle) { continue }
`,
  '自己骑的载具不算障碍'
)

repIn(
  join(PF_DIR, 'lib', 'movements.js'),
  `    if (!blockC.physical) {
      if (node.remainingBlocks === 0) return // not enough blocks to place

      if (this.getNumEntitiesAt(blockC.position, 0, 0, 0) > 0) return // Check for any entities in the way of a block placement`,
  `    if (!blockC.physical && !blockC.liquid) return`,
  'A* 不垫方块：jumpUp 目标格'
)

repIn(
  join(PF_DIR, 'lib', 'movements.js'),
  `      if (!blockD.physical) {
        if (node.remainingBlocks === 1) return // not enough blocks to place

        if (this.getNumEntitiesAt(blockD.position, 0, 0, 0) > 0) return // Check for any entities in the way of a block placement`,
  `    if (!blockD.physical && !blockD.liquid) return`,
  'A* 不垫方块：jumpUp 脚下那格'
)

/* ── 2026-10-25：move 不许"挖脚下"直上直下（用户：下矿应该挖阶梯） ──────── */
repIn(
  join(PF_DIR, 'lib', 'movements.js'),
  `    const blockLand = this.getLandingBlock(node, { x: 0, z: 0 })
    if (!blockLand) return

    cost += this.safeOrBreak(block0, toBreak)
    if (cost > 100) return

    if (this.getBlock(node, 0, 0, 0).liquid) return // dont go underwater`,
  `    const blockLand = this.getLandingBlock(node, { x: 0, z: 0 })
    if (!blockLand) return

    cost += this.safeOrBreak(block0, toBreak)
    if (cost > 100) return

    /* 🔴 2026-10-25 DSH 补丁（用户：「下矿的时候 AI 更倾向直上直下，而不选择挖阶梯」）：
     * 要**挖**才能掉下去 ⇒ 这条边直接判不可行。已经挖通的空气柱（toBreak 为空）照常掉，
     * 想开竖井 / 斜井请显式用 mc_dig {mode:\"stair\"}。
     * 原因：竖井下一层 cost = 1 + digCost×digTime ≈ 9.8，阶梯下两层 ≈ 18，
     * A* 永远选竖井；而竖井 >maxDropDown(3) 格之后自己也下不去（没有落点），
     * 挖完基本废掉。阶梯挖一次永久可通行。 */
    if (toBreak.length > 0) return

    if (this.getBlock(node, 0, 0, 0).liquid) return // dont go underwater`,
  'move 不挖脚下：getMoveDown'
)

repIn(
  join(PF_DIR, 'lib', 'movements.js'),
  `    cost += this.safeOrBreak(blockD, toBreak)
    if (cost > 100) return

    if (blockC.liquid) return // dont go underwater`,
  `    cost += this.safeOrBreak(blockD, toBreak)
    if (cost > 100) return

    /* 🔴 2026-10-25 DSH 补丁：斜着往下掉也**不许边挖边掉**（同上）。 */
    if (toBreak.length > 0) return

    if (blockC.liquid) return // dont go underwater`,
  'move 不挖脚下：getMoveDropDown'
)

/* ── 2026-10-29：均衡差不许在前方脚下垫方块（用户：「把这个功能去掉」） ──── */
repIn(
  join(PF_DIR, 'lib', 'movements.js'),
  `    if (!blockD.physical && !blockC.liquid) {
      if (node.remainingBlocks === 0) return // not enough blocks to place

      if (this.getNumEntitiesAt(blockD.position, 0, 0, 0) > 0) return // D intersects an entity hitbox

      if (!blockD.replaceable) {
        if (!this.safeToBreak(blockD)) return
        cost += this.breakLabor(blockD)
        toBreak.push(blockD.position)
      }
      cost += this.exclusionPlace(blockC)
      toPlace.push({ x: node.x, y: node.y - 1, z: node.z, dx: dir.x, dy: 0, dz: dir.z })
      cost += this.placeCost // additional cost for placing a block
    }`,
  `    if (!blockD.physical && !blockD.liquid) return

    cost += this.safeOrBreak(blockB, toBreak)`,
  'move 不在前方脚下垫方块：getMoveForward'
)



repIn(
  join(PF_DIR, 'lib', 'movements.js'),
  `    if (!blockC.physical && !blockC.liquid) {

      if (this.getNumEntitiesAt(blockC.position, 0, 0, 0) > 0) return // Check for any entities in the way of a block placement`,
  `    /* 🔴 2026-10-29 DSH 补丁（用户：「A* 底层“顺手垫一格”不要」）：
     *    这一处是“跳上去时顺手垫一块台阶”，同样不看任何开关。
     *    现在一律不垫：高低差走 DSH 的 climbUp（挖开斜上方两格跳上去）。 */
    if (!blockC.physical && !blockC.liquid) return`,
  'move 不在前方脚下垫方块：getMoveJumpUp'
)




/* ── 2026-10-29：jumpUp 不再在目标格下面顺手垫一格 ─────────── */
repIn(
  join(PF_DIR, 'lib', 'movements.js'),
  `      cost += this.exclusionPlace(blockC)
      toPlace.push({ x: node.x + dir.x, y: node.y - 1, z: node.z + dir.z, dx: 0, dy: 1, dz: 0 })
      cost += this.placeCost // additional cost for placing a block`,
  `    cost += this.exclusionPlace(blockC)
    /* 🔴 2026-10-29 DSH 补丁：这里原本还要在目标格下面“顺手垫一格”，已禁用。 */`,
  'A* 不垫方块：jumpUp 目标格下方'
)

/* ── 2026-10-29：树叶改成“加价”而不是“禁挖” ──────────────────── */
repIn(
  join(PF_DIR, 'lib', 'movements.js'),
  `    return this.exclusionBreak(block) + (1 + 3 * digTime / 1000) * this.digCost`,
  `    /* 🔴 2026-10-29 DSH 补丁：按方块类型加价（树叶 ×6）。
     *    上游没有“这种方块挖起来很亏”的概念，只能禁掉；禁掉就把“被树叶围住”变成无路。
     *    加价后：绕路 2~3 步 仍远便宜于挖树叶（约 28~46 步）⇒ 平时不往树上爬；真没别的路时 A* 就会挖。 */
    const pen = (this.dshBreakPenalty && this.dshBreakPenalty[block.type]) || 1
    return this.exclusionBreak(block) + (1 + 3 * digTime / 1000) * this.digCost * pen`,
  'breakLabor 按类型加价（树叶）'
)

/* ── 其它补丁只做存在性检查（改法在踩坑档案里，不在这里重放） ───────────── */
console.log('\n其它已知补丁（只检查）：')
const checks = [
  [join(PF_DIR, 'lib', 'physics.js'), /simulateStraight|collides\s*\(pos\)/, 'lib/physics.js：canStraightLine 假阳性'],
  [join(PF_DIR, 'lib', 'movements.js'), /cost1\s*>\s*0\s*\|\|\s*cost2\s*>\s*0/, 'lib/movements.js：禁斜切拐角'],
  [IDX, /waterCeil/, 'index.js：水下 jump 看头顶净空']
]
for (const [file, re, label] of checks) {
  if (!existsSync(file)) { console.error(`  ✗ ${label}：文件不存在`); missing++; continue }
  const txt = readFileSync(file, 'utf8')
  if (re.test(txt)) console.log(`  ✓ ${label}`)
  else { console.error(`  ✗ ${label}：**没打**（重装后需按踩坑档案手工补）`); missing++ }
}

if (missing > 0) {
  console.error(`\n✗ ${missing} 处缺失`)
  process.exit(1)
}
console.log(`\n${CHECK_ONLY ? '✓ 全部补丁在位' : `✓ 完成（本次新打 ${changed} 处）`}`)

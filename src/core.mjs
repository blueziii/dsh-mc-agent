// -*- coding: utf-8 -*-
/**
 * dsh-mc-agent / core.mjs —— Minecraft 无头机器人核心（不依赖 DSH，可独立运行与测试）
 * ---------------------------------------------------------------------------
 * 从 mc-bridge/server.mjs 抽出来：连接/保活/世界读取/移动/挖掘/事件分发。供两处使用：
 *   1. plugins/dsh-mc-agent/index.js（DSH 宿主插件，机器人跑在 DSH 进程里）
 *   2. dsh-mc-agent/standalone.mjs（脱离 DSH 单独跑，调试用）
 *
 * 依赖：`mineflayer` —— **装哪一份由部署方决定**（官方 npm 版，或本机 link 进来的打过补丁的树）。
 *   🔴 插件不指定版本、不打包、不打补丁（2026-09-16 用户决策）：所以这里只写裸包名，
 *      谁想连新版本就把自己那份 link 成 `mineflayer`（见 .agent-docs/mc-agent-opensource-plan）。
 * 关键坑（详见 .agent-docs/mc-bridge-agent-tools-2026-09-14.md）：
 *   - auth 传函数时必须自己 options.connect(client)
 *   - spawn 早于区块下发，读世界前要 waitForChunks
 *   - 给 mineflayer 传坐标一律用真 Vec3
 *   - 走路必须"一直按住"前进键
 */
/* 🔴 2026-10-20：不再静态 import mineflayer —— 它会把 readable-stream 整条链拉起来，而那条链上有「尾斜杠内置名」，DSH 解析器一碰就整个插件 import 失败（见 src/dep-guard.mjs / 踩坑档案 #224）。真正用 mineflayer 的地方只有 src/connection.mjs 的 ensureMineflayer()（懒加载 + 撞雷自愈）。 */
import vec3pkg from 'vec3'
/* 第三十一刀起 `dashUuid` / `offlineUuid` 不在这里用了：造 session 的活全在 `src\auth-session.mjs`。 */
/* 路线图第 ④ 条的第一刀：把**纯函数**搬出去（`lossless`/`redactPath`/`resolveHarnessHome`）。
 * 三个名字在这里**照样导出**（`export { … } from …`），外部 import 一行都不用改。 */
import { lossless, redactPath, resolveHarnessHome } from './format.mjs'
import { TaskRunner, TASK_FILE, taskLine, taskBrief } from './task-runner.mjs'
import { taskHave, verdictLine, taskSettle ,
  taskStart as taskStartImpl,
  taskList as taskListImpl,
  taskGet as taskGetImpl,
  taskResume as taskResumeImpl,
  taskNote as taskNoteImpl,
  taskDone as taskDoneImpl,
  taskCancel as taskCancelImpl,
  taskForget as taskForgetImpl,
  taskPlan as taskPlanImpl,
  taskStep as taskStepImpl
} from './task-report.mjs'
import { taskExecOf } from './task-exec.mjs'
import { actionSchedulerOf, resourceSpecOf } from './action-scheduler.mjs'
import { startObserver as startObserverImpl, stopObserver as stopObserverImpl, invSignature, observeTick } from './observer.mjs'
import { isAir, isLiquid, CONTAINER_RE, TOGGLE_RE, canPlaceInto } from './block-names.mjs'
/* 路线图第 ④ 条第三刀：异步小工具（sleep/withTimeout/raceAbort/abortError）搬到 `src/async-util.mjs`。
 * `withTimeout`/`raceAbort` 在下面照样导出 —— 4 个扩展和 selfcheck 都是 `import { withTimeout } from '../src/core.mjs'`，一行都不用改。 */
import { sleep, withTimeout, raceAbort, abortError } from './async-util.mjs'
import { plainText, playerChatFrom, pushChat, emitPlayerChat, wireChatEvents, chatSay as chatSayImpl } from './chat.mjs'
/* 路线图第 ④ 条第十七刀：朝向/相机层（`lookAnglesTo`/`aimAt`/`lookAt`）搬到
 * `src/camera.mjs`。下面留三个同名薄包装（`static lookAnglesTo` / `#aimAt` / `async lookAt`），
 * 调用点一行没改。核心动机见 `src/camera.mjs` 头注释：**不要用 mineflayer 的 `bot.lookAt()`**。 */
import { lookAnglesTo, aimAt, lookAt } from './camera.mjs'
import { useBlock, useItem, interact, equip, enchantTable, anvilTable, smithingTable } from './world-use.mjs'
import { build as buildImpl } from './build.mjs'
import {
  jump as jumpImpl, swimUp as swimUpImpl,
  walkTo as walkToImpl, walkSwim as walkSwimImpl, flyTo as flyToImpl, walkPathfinder as walkPathfinderImpl,
} from './movement.mjs'
import { breakBlock as breakBlockImpl, dig as digImpl } from './mining.mjs'
import { placeRef, placeBlock as placeBlockImpl } from './place.mjs'
import { bridgeAcross } from './bridge.mjs'
import { attack } from './attack.mjs'
import { driveBoat, dismountVehicle } from './boat.mjs'
import { shoot } from './shoot.mjs'
import { runSequence } from './sequence.mjs'
/* 路线图第 ④ 条第十八刀：「服务端到底认没认这次破坏」的判决监听搬到
 * `src/server-break.mjs`（`watchServerBreak` / `awaitServerBreak`）。下面留两个同名薄包装，
 * 调用点一行没改。为什么单独一层见模块头注释（客户端预测世界 + 服务端拒了会发"复原包"）。 */
import { watchServerBreak, awaitServerBreak } from './server-break.mjs'
import { EventEmitter } from 'node:events'
import { createRequire } from 'node:module'
import {
  writeFileSync, existsSync, mkdirSync, readFileSync, unlinkSync, appendFileSync,
  statSync, renameSync, readdirSync,   // 日志轮转（2026-10-06）
} from 'node:fs'
import { join, dirname, basename, sep } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
const Vec3 = vec3pkg.Vec3 ?? vec3pkg
const HERE = dirname(fileURLToPath(import.meta.url))

/**
 * 从 mineflayer **自己的**依赖树里解析包（同一份 node_modules）。
 * 用途：创造模式取物要 new 一个 prismarine-item 的 Item 实例塞进槽位。
 * ⚠️ 用"解析到的 mineflayer 实际路径"当锚点，**不写死目录** —— 这样插件装在哪儿都成立。
 */
const requireFromMineflayer = (() => {
  try { return createRequire(createRequire(import.meta.url).resolve('mineflayer')) } catch { return createRequire(import.meta.url) }
})()

/* ─────────── 「Yggdrasil 会话 join」的兼容补丁（用户 2026-09-17：它把整个 DSH 搞崩过）───────────
 * 事故链（真机实测栈）：
 *   minecraft-protocol/src/client/encrypt.js:41
 *     yggdrasilServer.join(accessToken, profileId, serverId, secret, pubkey, cb)   ← **老式回调**
 *   yggdrasil/src/Server.js:20  join 是 **async 函数，根本不调那个 cb**
 *   yggdrasil/src/utils.js:35   `if (body?.error !== undefined) throw new Error(body.error)`
 *                               → 皮肤站令牌失效时抛 `ForbiddenOperationException`
 *   ⇒ 这个 rejection **没有任何人接**（回调没人调、返回的 promise 没人 await）
 *   ⇒ 宿主的 `installFailLoud` 把它当致命错误 → `dsh: fatal load failure` → **exit(1)**
 *
 * 所以这里把 `yggdrasil.server(...)` 返回的对象包一层：
 *   · 调用方传了回调 → 我们替新版库把回调调起来（成功/失败都调）⇒ 恢复老式调用的语义、不产生悬空拒绝；
 *   · 没传回调 → 至少 `.catch()` 掉，别把它变成 unhandledRejection。
 * 同时把这类认证失败记下来（`takeAuthJoinError()`），好让上层给出"去 MC设置重新登录"的明确指引。
 * ⚠️ 只动这一个方法；resolver 锚在 **mineflayer 自己的依赖树**上（保证和 minecraft-protocol 用的是同一份）。
 * ─────────────────────────────────────────────────────────────────────────────────────────── */
let lastAuthJoinError = null
/** 取出（并清空）最近一次 session-join 失败 */
export function takeAuthJoinError () { const e = lastAuthJoinError; lastAuthJoinError = null; return e }

/**
 * 把 `yggdrasil.server()` 的对象包一层（**纯函数**，自检直接测它）。
 * @param {object} server `yggdrasil.server({...})` 的返回值
 * @param {(e:Error)=>void} [onError] 失败时的记录钩子
 */
export function wrapYggdrasilServer (server, onError = (e) => { lastAuthJoinError = e }) {
  if (!server || typeof server.join !== 'function' || server.__wcJoinWrapped) return server
  const orig = server.join.bind(server)
  server.join = (...args) => {
    const cb = typeof args[args.length - 1] === 'function' ? args.pop() : null
    const p = orig(...args)
    if (cb) {
      // 回调式调用方（minecraft-protocol 就是这个）：替新版库把回调调起来
      Promise.resolve(p).then((r) => cb(null, r), (e) => { try { onError(e) } catch {} ; cb(e) })
      return p
    }
    return Promise.resolve(p).catch((e) => { try { onError(e) } catch {} })
  }
  server.__wcJoinWrapped = true
  return server
}

/** 一次性装上补丁（模块加载时装；拿不到 yggdrasil 就静默跳过） */
const yggCompat = (() => {
  try {
    const mod = requireFromMineflayer('yggdrasil')
    if (!mod || typeof mod.server !== 'function') return 'no-server-export'
    const orig = mod.server
    const wrapped = function (...args) { return wrapYggdrasilServer(orig.apply(this, args)) }
    try { mod.server = wrapped } catch { return 'readonly-export' }
    return 'patched'
  } catch (e) { return `skip:${e?.code ?? e?.message ?? 'unknown'}` }
})()

/** 认证类失败 → 给用户看的可执行错误（needUserAction 让前端/工具照原样转达） */
export function friendlyAuthError (e) {
  const raw = String(e?.message ?? e ?? '')
  if (/ForbiddenOperationException|InvalidToken|invalid session|Unauthorized|HTTP 40[13]|HTTP 400/i.test(raw)) {
    const err = new Error(`皮肤站认证被拒（${raw}）：这个账户当前的登录令牌在那个认证服上无效`)
    err.needUserAction = true
    err.hint = '请让用户在「MC设置」里重新登录这个账户（或点该账户的「刷新」），再重新进服'
    err.cause = e
    return err
  }
  return e instanceof Error ? e : new Error(raw)
}

/**
 * 交给 minecraft-protocol 的**凭据开关**（纯函数，自检直接测）。
 *
 * 🔴 2026-09-17 真机致命事故的另一半：`haveCredentials` 的语义是"**有真凭据**能拿给认证服看"
 *   （minecraft-protocol `microsoftAuth.js:33` / `mojangAuth.js:24` 都这么设），而我们以前
 *   **无条件设 true** ⇒ 离线账户也会被拖去做 session join，假 token 必被拒
 *   （`ForbiddenOperationException`）→ 那条 rejection 没人接 → 宿主 fail-loud `exit(1)`，整个 Harness 死。
 *   离线账户必须走 encrypt.js 的"无凭据"分支；2026-10-15 加微软正版（跟皮肤站一样是**真凭据**）。
 * @param {'offline'|'yggdrasil'|'microsoft'} mode 账户类型
 * @returns {{haveCredentials:boolean, useAccessToken:boolean}}
 */
export function sessionFlags (mode) {
  const real = mode === 'yggdrasil' || mode === 'microsoft'
  return { haveCredentials: real, useAccessToken: real }
}

let _itemLoader = null
function itemLoader () {
  if (!_itemLoader) _itemLoader = requireFromMineflayer('prismarine-item')
  return _itemLoader
}

export const DEFAULTS = {
  // ⚠️ 不预设服务器：host/authUrl/authUser/authPass/subserver 一律由调用方（mc_connect 工具）传入。
  //    这里只留环境变量口子（脱机调试用），没有默认值——避免"忘了传参就静默连到某个服"。
  host: process.env.MC_HOST ?? '',
  port: Number(process.env.MC_PORT ?? 25565),   // 25565 是 MC 协议默认端口，不是某台服务器的绑定
  subserver: process.env.MC_SUBSERVER ?? '',
  authUrl: process.env.MC_AUTH_URL ?? '',
  authUser: process.env.MC_AUTH_USER ?? '',
  authPass: process.env.MC_AUTH_PASS ?? '',
  connectTimeoutMs: 45_000,
  moveBudgetMs: CALL_BUDGET_MS,   // 2026-10-28 参数审计：原来 40_000（超单次上限 CALL_MS）⇒“忘了传 budget”的内部走路以为有 40 秒
  preferDoors: true, doorDigPenalty: 8,   // 优先走门/绕路：给"挖墙"加代价（2026-10-18）
  walkDigFirst: false, walkDigFirstCost: 0.4,   // 2026-10-31：默认关（一律先绕、绕不过才挖）；true = 挖一格按 0.4 步计价
  walkDigDetourMax: 15,   // 2026-10-27：每挖一格额外按"多绕 N 步"记账 ⇒ 绕 ≤N 格不挖、超过才挖（用户：允许挖（`allowDig:true`）会挖家）
  walkTowerCost: null,   // null = 按地形档案（平地 12 / 沟 8…），显式给数值才覆盖
  walkLeafDigPenalty: 6,   // 2026-10-29：树叶不进禁挖名单，改成每格按 ×N 记账（塞进 mv.dshBreakPenalty；0 = 回到禁挖）
  /* 2026-10-23：耕地/土径不进 A* 的落脚点（防踩坏、防挖开挡路的）。代价：唯一通路时寻路报 NoPath 而不是硬穿。 */
  chatHistory: 300,
  /* 自动重连最多试几次（以前没上限、5s→…→60s 无限重试，看门狗又让 AI 干等）。 */
  maxReconnectAttempts: 5,
  /**
   * 日志落盘位置。🔴 **默认不写插件包目录**（装进 `node_modules/` 后那可能是只读的、
   * 升级时也会被覆盖）：默认写 `$DSH_HOME/dsh-mc-agent/logs/`，可用 `MC_LOG` 覆盖。
   */
  logFile: process.env.MC_LOG ?? join(resolveHarnessHome(), 'dsh-mc-agent', 'logs', 'dsh-mc-agent.log'),
}

/* 日志模块的默认落点（第五刀）：DEFAULTS 定义完就注入 —— 别让 core ↔ log 循环 import */
setDefaultLogFile(DEFAULTS.logFile)

/** 宿主家目录与路径脱敏已搬到 `src/format.mjs`（路线图第 ④ 条第一刀）；这里保留同名导出 */
export { lossless, redactPath } from './format.mjs'
/** 方块名 → 字符/颜色/类别已搬到 `src/block-names.mjs`（路线图第 ④ 条第二刀）；这里保留同名导出 */
export { glyphOf } from './block-names.mjs'
/** 异步小工具已搬到 `src/async-util.mjs`（路线图第 ④ 条第三刀）；这里保留同名导出 */
export { withTimeout, raceAbort } from './async-util.mjs'
/** 日志基建已搬到 `src/log.mjs`（路线图第 ④ 条第五刀）；这里保留同名导出 */
export { logLine, logDebug, logOnce, logLevel, stamp } from './log.mjs'
/** 挑方块/垫脚料已搬到 src/place-items.mjs（路线图第 ④ 条第六刀）；这里保留同名导出 */
export { isFullBlockItem, scaffoldingItemIds, pickPlaceItem } from './place-items.mjs'
export { TIMEOUTS, CALL_MS, CALL_BUDGET_MS, callBudget, callDeadline, callSecText, budgetSecText, needLeft, insufficientText } from './budget.mjs'
/** 实体名字与分类已搬到 `src/entity-names.mjs`（路线图第 ④ 条第四刀）；都是私有件，无需 re-export */
import { isDropEntity } from './entity-names.mjs'
/* 路线图第 ④ 条第五刀：日志基建（stamp/logLevel/logDebug/logLine/logOnce + 轮转）搬到
 * `src/log.mjs`。下面照样导出同名函数 —— index.js、4 个扩展、8 个套件都从 core.mjs import。 */
import { LOG_LEVELS, logLevel, stamp, appendLog, logLine, logDebug, logOnce, setDefaultLogFile } from './log.mjs'
/* 路线图第 ④ 条第六刀：挑方块/垫脚料那一层（NON_FULL_BLOCK/isFullBlockItem/NO_SCAFFOLD/
 * scaffoldingItemIds/pickPlaceItem）搬到 src/place-items.mjs。下面照样导出三个公开件 ——
 * tools\check-core-place.mjs 与 实机验证\搭方块\live-place.mjs 都从 core.mjs import。 */
import { NON_FULL_BLOCK, isFullBlockItem, NO_SCAFFOLD, scaffoldingItemIds, pickPlaceItem } from './place-items.mjs'

/* 路线图第 ④ 条第七刀：背包那一层（heldText/invSnap/invUsed/canHarvestNow/toolKinds/countOf/freeSlot）
 * 搬到 src/inventory.mjs —— 第一次搬"读 bot 实时状态"的东西，只读、不 await、不改状态。 */
import { invSnap, invUsed, canHarvestNow, toolKinds, countOf, freeSlot,
         inventoryView, giveItem, clearInventory, tossItem, equipFor, setEnchantRegistry } from './inventory.mjs'
import { TIMEOUTS, CALL_MS, CALL_BUDGET_MS, callBudget, callDeadline, callSecText, budgetSecText, needLeft, insufficientText } from './budget.mjs'
import { entityHealth, inWaterNow, slowDigWhy, dropsNear, dropHint, blockReachOf, stateNameOf } from './world-observer.mjs'
import { grabDrops } from './pickup.mjs'
import { digMsFor, patchDigTime, bestToolFor } from './dig-speed.mjs'
import { collectBusy, cancelCollect, waitGrounded, withHeld } from './dig-guard.mjs'
import { heightmapOf, glyphMapText, mapImageOf, mapImageOfAsync } from './map-render.mjs'
import { scanAround, entitiesNear } from './world-scan.mjs'
import { readBossBars } from './bossbar.mjs'
import { connectionViewOf, statusOf } from './status.mjs'

/* 路线图第 ④ 条第二十八刀：vendor 依赖加载器（`MC_DEPS` / `loadMcDep` / `loadPathfinder` /
 *  `resetMcDepCache` / `resetPathfinderCache`）搬进 `src\plugins.mjs`。
 *  为什么这里还留同名 re-export：这几个名字从第一版起就是 `core.mjs` 的公开导出，
 *  自检脚本/以后的外部调用点按名字找它，re-export 之后调用点一行都不用改。 */
import { setupPathfinder, movements, setupPlugins } from './plugins.mjs'
import { authOnly as authOnlyImpl, makeSession } from './auth-session.mjs'
import { reportError, withBudget, stopPathing, interruptMove as interruptMoveImpl, setAbortSignal as setAbortSignalImpl, holdControl as holdControlImpl, releaseControls, requireBot as requireBotImpl, waitForChunks as waitForChunksImpl, respawnNow as respawnNowImpl } from './runtime.mjs'
import { connect as connectImpl, scheduleReconnect as scheduleReconnectImpl, disconnect as disconnectImpl } from './connection.mjs'
export { MC_DEPS, loadMcDep, loadPathfinder, resetMcDepCache, resetPathfinderCache } from './plugins.mjs'


/* ============================================================================
 * 🔴 超时保护 —— "对话卡在生成中、停止键也按不动"的根因修复（2026-09-15）
 * ----------------------------------------------------------------------------
 * mineflayer 的 dig / placeBlock / equip / lookAt / creative.flyTo 返回的都是
 * "**等服务端 ack**" 的 promise。服务端可能根本不回包（版本对不上、支持不完整
 * 时尤其如此）→ promise 永不 settle
 * → 工具 execute 永不返回 → 整轮 turn 卡死：
 *     前端一直"生成中" · 停止键无效（没有中断点） · 无法插话
 * 症状表现为"LLM 也停止输出了"——其实模型早调完工具在等结果，是工具卡住了。
 *
 * 注意：超时只是**不再等**，底层 promise 仍悬着（JS 无法取消已发出的网络等待）。
 * 因此超时后必须把机器人当作"可能已失步"处理：松掉所有控制位 + 记 lastTimeout。
 *
 * 🔴 2026-10-06 补充（实机"机器人走不了了"的根因）：对 mineflayer-collectblock
 *    这种**后台还在跑**的任务，光松控制位不够 —— 它自己会立刻把 `forward` 按回去，
 *    机器人就"物理冻住"：`mc_diag` 显示 `forward:true` 而 `velocity` 全 0、位置一格不动，
 *    之后的 `mc_move` 也全部失败（15 秒只挪 0.03 格），只有重连才恢复。
 *    必须显式 `cancelTask()` 把那个循环停下来，见 `#cancelCollect`。
 * ========================================================================== */

/**
 * 服务器指令的**内置**白名单（保底值）。
 * 插件层会传自己的可配置白名单覆盖它（`command(cmd, { allow })`）——
 * 这份只是"没有配置时也能安全跑"的默认，和 src/config.mjs 的默认值保持一致。
 */
export const DEFAULT_COMMAND_WHITELIST = new Set([
  'tp', 'teleport', 'give', 'time', 'weather', 'say', 'tell', 'msg',
  'gamemode', 'effect', 'enchant', 'setblock', 'fill', 'clone', 'summon',
  'title', 'spawnpoint', 'difficulty', 'kill', 'clear', 'xp', 'experience',
])

/**
 * 一个 Minecraft 机器人（保活、事件、世界操作）。
 * 事件（EventEmitter）：'chat'(玩家聊天) 'system'(系统消息) 'spawn' 'end' 'kicked' 'error' 'damage' 'log'
 */
export class McBot extends EventEmitter {
  constructor (config = {}) {
    super()
    this.cfg = { ...DEFAULTS, ...config }
    // 实例标识：多会话各自一个 McBot，锁文件按实例分开（同进程 pid 相同，共用一个锁会互相误删）
    this.instanceId = String(config.instanceId ?? 'default').replace(/[^\w.-]/g, '_')
    if (!existsSync(dirname(this.cfg.logFile))) mkdirSync(dirname(this.cfg.logFile), { recursive: true })
    this.bot = null
    this.sub = null
    this.connecting = null
    this.connectedAt = 0
    this.lastError = null
    this.autoReconnect = true
    this.reconnectDelay = 5000
    this.reconnecting = false
    /** 断线期（从掉线一直置到**真重连成功**）：前端据此显示"重连中…"，见 end 处理里的说明 */
    this.reconnectPending = false
    this.chat = []            // { at, kind, who, text }
    this.stopped = false
    this.lastTimeout = null
    this.abortSignal = null       // 本轮 turn 的 abort signal（工具层注入）
    this.observerTimer = null     // 世界观察器（语义事件）
    this._obs = null
    this._selfMovingAt = 0        // 我们自己发起移动的时刻（排除"被传送"误判）
    this.stats = { connects: 0, deaths: 0, chats: 0, lastEventAt: 0, timeouts: 0 }
    /* 🔴 任务状态机（用户 2026-10-08 路线图第 ②③ 条）：进度落**磁盘**（`<记忆根>/tasks.json`），
     * 不只在对话上下文里 —— 掉线、重连、换一轮对话回来都能接着做。
     * 路径由宿主（`index.js` 的 `asTool`）每次调用喂一次 `setTaskDir()`；
     * 拿不到记忆根（脚本直接 new McBot）就退化成"只在内存里记"，不写文件。 */
    this.tasks = new TaskRunner({ log: (m) => this.log(m) })
    /* 统一动作调度器（用户 2026-10-14 设计「统一动作调度」的**阶段 P0：只记账**）。
     * 懒建（见 `actionScheduler()`），因为它只维护"谁在占什么"的一张表，
     * 不碰 `_moveGen` / `_ctrlLease` / `interruptMove` —— 抢占仍然只有那一条路。 */
    this._actions = null
  }

  /** 统一动作调度器（阶段 P0：只记账，不拦人）。懒建与实现在 `src/action-scheduler.mjs`。 */
  actionScheduler () { return actionSchedulerOf(this) }

  /** 调度器一眼视图（`mc_diag` 用）：谁在占什么、撞过几次车 */
  actionSnapshot () { return this.actionScheduler().snapshot() }

  /** 这个工具该登记哪些资源（`null` = 只读工具 / 不认识的工具 ⇒ 根本不进调度器） */
  actionSpecOf (name, args = {}) { return resourceSpecOf(name, args) }

  /** 任务文件放哪（宿主每次工具调用喂一次；路径没变是空操作） */
  setTaskDir (dir) {
    this.tasks.setFile(dir ? join(String(dir), TASK_FILE) : null)
    return this.tasks.file
  }

  /** 背包里某样东西有几个（同名合计，含手上那叠）—— 任务恢复时的"现场状态" */
  countOf (name) {
    // 路线图第 ④ 条第七刀：函数体搬到 `src\inventory.mjs` 了，这里只留公开面的薄包装
    return countOf(this.bot, name)
  }

    /* ── 任务收工报告（路线图第 ④ 条第二十四刀）：函数体搬到 `src\task-report.mjs` 了 ── */

  #taskHave (item) { return taskHave(this.bot, item) }

  #verdictLine (out, okCount, wantTotal) { return verdictLine(out, okCount, wantTotal) }

  #taskSettle (task, out, okCount, wantTotal) { return taskSettle(this, task, out, okCount, wantTotal) }

  /* ───────────── 任务（可恢复的任务状态机） ─────────────
   * 用户 2026-10-08 路线图第 ②③ 条。这些方法只是**记账**：
   * 不碰移动编号、不碰控制位、不下发动作 —— 那些仍然归 `walkTo` / `dig` 自己管。
   * 函数体已搬到 `src\task-report.mjs`（路线图第 ④ 条第四十二刀），这里只留公开面的薄包装。
   * ------------------------------------------------------------------------- */

  taskStart (opts = {}) { return taskStartImpl(this, opts) }

  taskList (opts = {}) { return taskListImpl(this, opts) }

  /** 单个任务的明细（含最近几条历史）—— `mc_task {action:"get"}` */
  taskGet (opts = {}) { return taskGetImpl(this, opts) }

  /** 恢复：用**现场背包**复核进度，给出下一个动作（不重新规划） */
  taskResume (opts = {}) { return taskResumeImpl(this, opts) }

  taskNote (opts = {}) { return taskNoteImpl(this, opts) }

  taskDone (opts = {}) { return taskDoneImpl(this, opts) }

  taskCancel (opts = {}) { return taskCancelImpl(this, opts) }

  taskForget (opts = {}) { return taskForgetImpl(this, opts) }

  /** 步骤台账：写/看计划（2026-10-14 "任务驱动"第一步） */
  taskPlan (opts = {}) { return taskPlanImpl(this, opts) }

  /** 推进当前那一步（只记账，不下发动作） */
  taskStep (opts = {}) { return taskStepImpl(this, opts) }

  /* ───────────── 任务执行器（2026-10-14 "任务驱动"第二步） ─────────────
   * 一轮只推进一个可验证的步骤。懒建、看现场、收手都在 `src/task-exec.mjs` 里
   * （`taskExecOf` / `taskObserveOf` / `taskCancelStepOf`）—— 那儿不 import 游戏库，
   * 干活由宿主每轮给 `call`（工具处理器表），"谁来推"因此可换。
   * ------------------------------------------------------------------------- */

  /** 跑一轮任务。`opts.call(tool, args, ctx)` 由宿主（`index.js` 的 `mc_task`）给。 */
  taskRun (opts = {}) { return taskExecOf(this).run(opts) }

  /** 取消任务（**先收手再改状态**） */
  taskRunCancel (opts = {}) { return taskExecOf(this).cancel(opts.taskId ?? null, opts.reason ?? '取消') }

  /**
   * 在线 = **有身体** 且 **连接还活着**。
   *
   * 🔴 2026-09-19「幽灵在线」（别人反馈，本地复现）：被踢之后 mineflayer 的 `bot.entity` **还在**，
   *    只看 entity 就会把死连接报成"在线" ⇒ 工具对着死 socket 干等（世界时间冻结、`/list` 零回应）、
   *    用户以为还在游戏里。socket 已结束（`_client.ended`）就不算在线。
   */
  get online () { return Boolean(this.bot?.entity) && this.bot?._client?.ended !== true }
  /** 当前位置（纯对象，绝不返回 Vec3） */
  get position () {
    const p = this.bot?.entity?.position
    if (!p) return null
    return { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) }
  }

  /** 日志短标签：多会话共用一份日志时，至少能看出是哪只机器人（2026-10-06）
   *  🔴 2026-10-15 审计（报告 B 第 8 条）：以前读的是 `this.cfg.auth.name`，但**凭据只走
   *     `opts.auth`**（`src/connection.mjs` 把它存进 `self._connectOpts.auth`），全仓库没有任何
   *     `cfg.auth` 的写入点 ⇒ 这个标签**恒为空**，"看不出是哪只机器人"那个初衷从没生效。
   *     改读真正存凭据的地方（脱敏：只用 label/name，不带 token）。 */
  get logTag () {
    const a = this._connectOpts?.auth
    const n = a?.label ?? a?.name ?? this.cfg?.auth?.name
    return n ? ` ${String(n).slice(0, 12)}` : ''
  }

  log (...args) {
    const line = `[dsh-mc-agent ${stamp()}${this.logTag}] ${args.join(' ')}`
    this.emit('log', line)
    appendLog(this.cfg.logFile, line)
  }

  /** 只在 `MC_LOG_LEVEL=debug` 落盘（噪声行的归属地） */
  logDebug (...args) { if (logLevel() >= LOG_LEVELS.debug) this.log(...args) }

  /** 整个进程只落盘一次（`globalThis` 判重：每个连接是新的模块实例） */
  logOnce (key, ...args) {
    const g = (globalThis.__dshMcAgentLogged ??= new Set())
    if (g.has(key)) return false
    g.add(key)
    this.log(...args)
    return true
  }

  /** 统一错误上报口（实现在 `src\runtime.mjs` 的 `reportError`：记 lastError + 一行日志 + 只在真有监听者时才 emit）。 */
  #reportError (e) { return reportError(this, e) }

  /** 运行时管线要用的两件**私有**件（迁移规矩第 17 · 37 条）—— 模块里够不着 `#releaseControls` / `#cancelCollect`，包成箭头函数递进去 */
  #runCtx () {
    return {
      releaseControls: () => this.#releaseControls(),
      cancelCollect: (b, o) => this.#cancelCollect(b, o)
    }
  }

  /** 所有 await 过的超时闸门（实现在 `src\runtime.mjs` 的 `withBudget`：本轮 abort signal + 本地 deadline 双保险）。 */
  #t (promise, kind, label = kind) { return withBudget(this, promise, kind, label, this.#runCtx()) }

  /**
   * 标记"本轮工具调用"的截止时刻。`asTool` 每次 execute 前调一次。
   * 长动作（走远路 / 挖一片 / 搭一片 / 连串步骤）靠 `msLeft()` 到点就带着进度返回，
   * 而不是把这一次调用挂住几分钟（用户要求：一次别挂太久，宁可少量多次）。
   */
  setCallDeadline (ms = CALL_MS) {
    // 🔴 别写 `Number(ms) || CALL_MS`：`setCallDeadline(0)` 的意思是"这一轮已经没时间了"，
    //    写成 `||` 会反过来**再给一整轮**（和 `msLeft() || CALL_BUDGET_MS` 是同一类坑）。
    const n = Number(ms)
    this.callDeadlineAt = Date.now() + (Number.isFinite(n) && n >= 0 ? n : CALL_MS)
    return this.callDeadlineAt
  }

  /** 距离本轮截止还剩多少毫秒；没设过（脚本直接调 McBot）就当作整整一轮 */
  msLeft () {
    const at = Number(this.callDeadlineAt)
    if (!Number.isFinite(at) || at <= 0) return CALL_MS
    return Math.max(0, at - Date.now())
  }

  /**
   * 本轮**还能给一个动作**多少毫秒：`min(一整轮 11 秒, 本轮剩余)`。
   * 长动作（挖一片 / 搭一片）自己排 deadline 时用它 —— 别直接 `Date.now() + CALL_MS`，
   * 那样在 `mc_sequence` 里"走 10 秒再搭"会变成 10+11=21 秒（超过 11 秒上限）。
   */
  callLeft () {
    return Math.max(0, Math.min(CALL_MS, this.msLeft()))
  }

  /**
   * 移动的"当前归属者"编号。
   * 🔴 为什么需要（2026-10-06 实机）：自主层被怪贴上会自己逃，AI 那轮可能正在 mc_move/mc_dig，
   *    两份移动占同一个 bot.pathfinder，先收尾的那份会把另一份一起停掉。每次移动领一个号，收尾时只有"号还是最新的"才允许动。
  */
  _moveGen = 0

  /** 领一个新的移动号（旧号的那次走路收尾从此失效） */
  #beginMove () { return ++this._moveGen }

  /** 抢占正在走的 / 正在挖着走的（实现在 `src\runtime.mjs` 的 `interruptMove`：推移动号 + 停采集 + 松控制位）。 */
  async interruptMove (reason = '') { return await interruptMoveImpl(this, reason, this.#runCtx()) }

  /** 真停 pathfinder（实现在 `src\runtime.mjs` 的 `stopPathing`：`stop()` 只置标志，`setGoal(null)` 才走 resetPath）。 */
  #stopPathing (b) { return stopPathing(b) }

  /**
   * 自保反射（`mc_auto`）按下的控制位租约：`{ key: 到期时刻 }`。
   *
   * 🔴 为什么需要：反射在危险脚下按 `back`（320ms）/ 在岩浆里按 `jump`（200ms）/ 溺水濒死按 `jump`（600ms），
   *    而任何一次移动收尾都会 `#releaseControls()` 把七个键全松掉 —— 实机表现是
   *    "脚边就是岩浆，走一步收尾把后退松了，机器人继续往危险里走"。反射那边没有握手，
   *    所以由这边**声明租约**：没到期的键不松。
   */
  _ctrlLease = new Map()

  /**
   * 反射层专用：按住一个控制位一小会儿，并声明租约（`releaseControls` 会跳过没过期的键）。
   *
   * 实现搬到了 `src\runtime.mjs`（路线图第 ④ 条第四十一刀）—— 控制位租约和
   * `stopPathing` / `interruptMove` 本来就是一套：都是"收尾时别抢别人的控制位"。
   * @returns {number} 到期时刻（ms epoch）
   */
  holdControl (key, ms = 300) { return holdControlImpl(this, key, ms) }

  /** 松掉所有控制位（超时/中断后必做，否则"一直按住前进"会跑飞）—— 但跳过反射的租约（实现见 `src\runtime.mjs`） */
  #releaseControls () { return releaseControls(this) }

  /** mineflayer-collectblock 现在还有任务在跑吗（实现见 `src\dig-guard.mjs`） */
  #collectBusy (b) { return collectBusy(b) }

  /**
   * 停掉还在后台跑的 mineflayer-collectblock 任务，并松掉控制位。
   *
   * 实现搬到了 `src\dig-guard.mjs`（路线图第 ④ 条第十五刀）；这里只把**实例状态**
   * 打包成 ctx 传进去（迁移规矩第 17 条：搬出去的模块不碰 `this`）。
   */
  async #cancelCollect (b, opts = {}) {
    return await cancelCollect(b, {
      ...opts,
      bumpGen: () => { this._moveGen++ },
      stopPathing: (bb) => this.#stopPathing(bb),
      releaseControls: () => this.#releaseControls(),
      log: (m) => this.log(m)
    })
  }

  /** 接本轮 turn 的 abort signal（实现在 `src\runtime.mjs` 的 `setAbortSignal`：signal 一 abort 就立刻真停 + 松控制位）。 */
  setAbortSignal (signal) { return setAbortSignalImpl(this, signal, this.#runCtx()) }

  /* ───────────── 世界观察器（把"变化"变成语义事件，供看门狗判定唤醒）─────────────
   * 路线图第 ④ 条第二十五刀：函数体搬到 `src\observer.mjs` 了，这里只留四个薄包装。
   * 这一层收 `self`（要读 self.bot/_obs/position/_selfMovingAt、要 self.emit）；定时器回调
   * 里的异常上报是**私有**方法，按第 28 条走 `ctx.reportError`。
   * ------------------------------------------------------------------------- */

  startObserver () { return startObserverImpl(this, { reportError: (e) => this.#reportError(e) }) }

  stopObserver () { return stopObserverImpl(this) }

  #invSignature () { return invSignature(this.bot) }

  #observeTick () { return observeTick(this) }
  /* ───────────── 连接与保活 ───────────── */

  /* ───────────── 连接与保活（路线图第 ④ 条第三十一刀：函数体搬到 `src\connection.mjs`）─────────────
   * 这一层收 `self`（读写的全是实例状态）；`DEFAULTS` / 私有 `#reportError` / 三个认证助手
   * 走 `ctx`（第 17 · 24 · 28 条）。 */
  /** 连接到 MC 服务器（实现在 `src\connection.mjs` 的 `connect`）。 */
  async connect (opts = {}) { return await connectImpl(this, opts, this.#connCtx()) }

  /** 掉线后按记下的真参数重连（实现在 `src\connection.mjs` 的 `scheduleReconnect`）。 */
  #scheduleReconnect (sub) { return scheduleReconnectImpl(this, sub, this.#connCtx()) }

  /** 连接层那三样"模块不该知道"的东西。 */
  #connCtx () {
    return {
      defaults: DEFAULTS,
      reportError: (e) => this.#reportError(e),
      auth: { sessionFlags, friendlyAuthError, takeAuthJoinError },
    }
  }

  /** 下线（实现在 `src\connection.mjs` 的 `disconnect`）。 */
  async disconnect (reason = '主动下线', { graceMs = 3000 } = {}) { return await disconnectImpl(this, reason, { graceMs }) }

  /* 路线图第 ④ 条第三十刀：认证/会话层（`authOnly` / `#makeSession` / `#refresh` / `#authenticate`）
   *  搬进 `src\auth-session.mjs` 了 —— 那里是全插件唯一接触凭据的地方。 */
  /** 只做认证、不连服（实现在 `src\auth-session.mjs` 的 `authOnly`）。 */
  async authOnly (auth, opts = {}) { return await authOnlyImpl(this, auth, opts) }

  /** 账户描述符 → session（实现在 `src\auth-session.mjs` 的 `makeSession`）。 */
  async #makeSession (auth) { return await makeSession(this, auth) }

  /* 按键上报兼容层（player_input）—— 已整体移除（2026-10-02 用户决策）：上游连不了 26.2（mineflayer
   * 4.39.0 testedVersions 到 26.1；minecraft-data 3.117.0 只有 26.2 元数据、`minecraft-data('26.2')` 为 null）。
   * 将来重建**必须**沿用"先查后发"：protodef 对未知包名不报错，会写出「id=0x00 + 空 body」（实测 `02 00 00`），
   * 服务端把 0x00 当 `accept_teleportation` 读 teleportId ⇒ DecoderException ⇒ 进服 1 秒后秒踢（CHANGELOG 0.1.7）。 */

  /* ───────────── 单实例锁（按实例分文件：同进程多会话不能共用一把锁） ───────────── */

  /**
   * 单实例锁文件（连服时才有，断开即删）。
   *
   * 🔴 默认**不写插件包目录**（与日志同一个道理）：装进 `node_modules/` 后那可能是只读的，
   *    升级时也会被覆盖。优先用调用方给的 `lockDir`（= `$DSH_HOME/dsh-mc-agent/`），
   *    只有没给时才退回包目录（老行为，保底能用）。
   */
  get lockFile () {
    const dir = this.cfg.lockDir || HERE
    return join(dir, `.instance.${this.instanceId}.json`)
  }

  writeLock () {
    try {
      const f = this.lockFile
      if (!existsSync(dirname(f))) mkdirSync(dirname(f), { recursive: true })
      writeFileSync(f, JSON.stringify({ pid: process.pid, instanceId: this.instanceId, at: new Date().toISOString(), sub: this.sub }))
    } catch {}
  }

  releaseLock () {
    try {
      const rec = JSON.parse(readFileSync(this.lockFile, 'utf8'))
      if (Number(rec?.pid) === process.pid && rec?.instanceId === this.instanceId) unlinkSync(this.lockFile)
    } catch {}
  }

  /* ───────────── 聊天记录（已搬到 src\chat.mjs，第十六刀） ───────────── */

  /** 把 mineflayer 的聊天/系统消息接到本实例的 `chat` / `system` 事件上。见 `src\chat.mjs` 的 `wireChatEvents()`。 */
  wireChatEvents (b) { return wireChatEvents(this, b) }

  /** 一条"玩家说话"进账（唯一入口：签名聊天与未签名聊天都走这里）。见 `src\chat.mjs` 的 `emitPlayerChat()`。 */
  #emitPlayerChat (who, text, selfName) { return emitPlayerChat(this, who, text, selfName) }

  /** 从 `bot.on('message')` 收到的消息里认出"玩家聊天"。见 `src\chat.mjs` 的 `playerChatFrom()`。 */
  #playerChatFrom (msg, plain) { return playerChatFrom(msg, plain) }

  /** 消息 → 纯文本（去掉颜色码 §x）。见 `src\chat.mjs` 的 `plainText()`。 */
  #plain (msg) { return plainText(msg) }

  /** 记一条聊天（按 `cfg.chatHistory` 截断）。见 `src\chat.mjs` 的 `pushChat()`。 */
  #pushChat (kind, who, text) { return pushChat(this, kind, who, text) }

  recentChat (n = 10) { return this.chat.slice(-n) }

  /* ───────────── 世界读取 ───────────── */

  /** 等区块加载好（实现在 `src\runtime.mjs` 的 `waitForChunks()`：算进本轮 11 秒，用完立刻回 `false`）。 */
  async waitForChunks (timeoutMs = 20_000) { return await waitForChunksImpl(this, timeoutMs) }


  /* ───────────── 连接/状态视图（已搬到 src\status.mjs，第十三刀） ───────────── */

  /** 连接信息（只有 host/port/subserver，**不含账号/认证模式**）。见 `src\status.mjs` 的 `connectionViewOf()`。 */
  connectionView () { return connectionViewOf(this._connectionProfile) }

  /** 状态视图：离线（可能带 `ghost`/`reconnecting`）或在线（坐标/朝向/模式/血量/饥饿/氧气/手持/在线时长）。见 `src\status.mjs` 的 `statusOf()`。 */
  status () {
    return statusOf(this.bot, {
      sub: this.sub, connection: this.connectionView(), lastError: this.lastError,
      reconnecting: this.reconnecting, reconnectPending: this.reconnectPending, connectedAt: this.connectedAt,
    }, this)   /* 2026-10-29：第三参传实例（读 stats.deaths / _life）—— 不传就拿不到死亡记录 */
  }

  /* ───────────── 附近方块扫描（已搬到 src\world-scan.mjs，第十二刀） ───────────── */

  /** 周围方块：不点名给计数（前 25 种），点名给坐标列表（按到我的距离升序）。见 `src\world-scan.mjs` 的 `scanAround()`。 */
  scan (opts = {}) { return scanAround(this.requireBot({ allowDead: true }), opts) }

  /* ───────────── 地图（已搬到 src\map-render.mjs，第十一刀） ───────────── */

  /** 俯视地形（**地表图**）：见 `src\map-render.mjs` 的 `heightmapOf()`。
   *  2026-10-22：`mode:"cave"` / `"auto"` 和 `isUnderground()` 一起删了 —— 这里没有模式可选。 */
  heightmap (opts = {}) { return heightmapOf(this.requireBot({ allowDead: true }), opts) }

  /** 字符地形图（无视觉也能读） */
  static glyphMap (names, step = 2, selfIndex = null, opts = {}) { return glyphMapText(names, step, selfIndex, opts) }

  /** 俯视地形 → RGBA 像素图（视觉模型看图像比看字符强）；异步版把"网格→像素"交给 Worker 池（默认关）。 */
  mapImage (opts = {}) { return mapImageOf(this.requireBot({ allowDead: true }), opts) }
  mapImageAsync (opts = {}) { return mapImageOfAsync(this.requireBot({ allowDead: true }), opts) }
  /* ───────────── 行动 ───────────── */

  /**
   * 在公屏说一句话（实现在 `src\chat.mjs` 的 `chatSay`）。
   *
   * `/` 开头会被**拒**（并提示用 `mc_command`）—— 走公屏发指令会绕过指令白名单，见那个文件里的注释。
   */
  chatSay (text) { return chatSayImpl(this, text) }

  /* 路线图第 ④ 条第二十九刀：插件装配（`setupPathfinder` / `#movements` / `setupPlugins`）
   *  也搬进 `src\plugins.mjs` 了 —— 加载器和装配放在同一个模块里（它们本来就是一件事）。 */
  /** 挂上现成的寻路插件（实现在 `src\plugins.mjs` 的 `setupPathfinder`）。 */
  async setupPathfinder (opts = {}) { return await setupPathfinder(this, opts) }

  /** 造一份 `Movements`（实现在 `src\plugins.mjs` 的 `movements`；`terrain` 是地形分类结果，导航 P2）。 */
  #movements (terrain = null, opts = null) { return movements(this, { terrain, ...(opts ?? {}) }) }

  /** 把现成的生态插件都挂上（实现在 `src\plugins.mjs` 的 `setupPlugins`）。 */
  async setupPlugins (opts = {}) { return await setupPlugins(this, opts) }

  /**
   * 用 pathfinder 走到目标（**现成的防卡住寻路**：自己绕路、挖穿挡路的方块、垫 1×1 塔、过门）。
   *
   * 返回值保持 `arrived / moved / remaining / stuck / hint` 结构；
   * 上层 `mc_move` 和自主层直接使用；额外带 `via:"pathfinder"` 便于排查。
   *
   * 函数体在 `src\movement.mjs` 的 `walkPathfinder`（路线图第 ④ 条第三十七刀）——
   * 事件监听 / 移动编号 / 控制位租约的推导都写在那个文件里。
   */
  async #walkPathfinder (target, opts = {}) {
    return await walkPathfinderImpl(this, target, opts, this.#pathCtx())
  }

  #pathCtx () {
    return {
      movements: (terrain, opts) => this.#movements(terrain, opts),
      collectBusy: (b) => this.#collectBusy(b),
      cancelCollect: (b) => this.#cancelCollect(b),
      beginMove: () => this.#beginMove(),
      stopPathing: (b) => this.#stopPathing(b),
      releaseControls: () => this.#releaseControls(),
      /* 2026-10-23 审计：原来这里没有 cfg ⇒ movement.mjs 里 `ctx.cfg?.walkCanDig !== false` 恒真
       * （可选链短路），A* 不挖了、手写挖台阶补救却在挖。cfg 只塞进 #moveCtx 是漏接线。 */
      cfg: this.cfg,
      moveGenOf: () => this._moveGen,   // 2026-10-24 通审：_moveGen 在实例上、不在 bot 上
    }
  }

  /* ─────────── 移动（路线图第 ④ 条第三十六刀：函数体搬到 `src\movement.mjs`）─────────── */

  /** 在水里"直接游"到目标附近（**绕开 pathfinder**）。为什么水里不能用 pathfinder，见 `src\movement.mjs` 的注释。 */
  async #walkSwim (target, opts = {}) {
    return await walkSwimImpl(this, target, opts, this.#moveCtx())
  }

  /** 走到目标（水里先交给 `#walkSwim`，上岸再交回 pathfinder）。实现见 `src\movement.mjs`。 */
  async walkTo (target, opts = {}) {
    return await walkToImpl(this, target, opts, this.#moveCtx())
  }

  /** 飞到某个坐标（仅创造模式）。为什么刻意不用 `bot.creative.flyTo`，见 `src\movement.mjs` 的注释。 */
  async flyTo (x, y, z, opts = {}) {
    return await flyToImpl(this, x, y, z, opts, this.#moveCtx())
  }

  /** 移动层要用的私有件（模块够不着私有名）—— 打包递进去（迁移规矩第 28 条）。 */
  #moveCtx () {
    return {
      walkPathfinder: (t, o) => this.#walkPathfinder(t, o),
      beginMove: () => this.#beginMove(),
      releaseControls: () => this.#releaseControls(),
      cfg: this.cfg,   // 挖台阶补救要读 walkCanDig/walkCarveStep（2026-10-18 审计 Bug 3）
      moveGenOf: () => this._moveGen,   // 同上：bot 上没有 _moveGen
    }
  }
  /* ─────────── 手上的东西 / 背包快照：已搬到 `src\inventory.mjs`（路线图第 ④ 条第七刀）─────────── */

  /** 站到地上再动手（实现见 `src\dig-guard.mjs` 的 `waitGrounded`；这里只把 abort signal 传进去） */
  async #waitGrounded (b, maxMs = 1_200) { return await waitGrounded(b, { maxMs, signal: this.abortSignal }) }

  /**
   * 挖完顺手捡掉落物。给 `b` 就捡它周围的；返回**背包里多了几个**（不是"捡了几个实体"）。
   * 实现见 `src\pickup.mjs`（为什么要按背包差报数、为什么捡不到要显式收尾，都写在那边的文件头上）。
   */
  async #grabDrops (b, opts = {}) {
    return await grabDrops(this, b, opts, { cancelCollect: (bb, o) => this.#cancelCollect(bb, o) })
  }
  /** 公开一层（自检脚本 / 以后重连时手动补挂用）：见 `src\dig-speed.mjs` 的 `patchDigTime`。 */
  patchDigTime (b) { return patchDigTime(b) }

  /** 结果里补一行"手上变了"（实现见 `src\dig-guard.mjs` 的 `withHeld`） */
  #withHeld (out, b, before) { return withHeld(out, b, before) }

  /**
   * 动手前把对的工具拿到手上（实现在 `src\inventory.mjs` 的 `equipFor`）。
   *
   * 为什么要换、换多快、"换不上就照旧"这三件事的完整推导，都写在那个函数的头注释里。
   */
  async #equipFor (b, blk, label = '换工具') {
    return await equipFor(this, b, blk, label, { t: (p, k, l) => this.#t(p, k, l) })
  }

  /* ─── 挖方块（路线图第 ④ 条第四十刀：函数体搬到 src\mining.mjs）─── */

  /** 挖方块（`mc_dig` 的正文：走过去 → 换工具 → 认服务端的破坏回包 → 捡掉落物）—— 实现在 `src\mining.mjs`（`dig`）。 */
  async dig (opts = {}) { return await digImpl(this, opts, this.#mineCtx()) }

  /** 背包一览（`mc_inventory` 的正文）—— 实现在 `src\inventory.mjs`（`inventoryView`） */
  inventory () { return inventoryView(this.requireBot({ allowDead: true })) }

  /* ───────────── 朝向（"看向我"就该用工具，不要用 /tp 指令） ───────────── */

  /** 目标点 → mineflayer 的 yaw/pitch（mineflayer yaw = 反方向 + PI）—— 实现在 `src/camera.mjs` */
  static lookAnglesTo (from, to) { return lookAnglesTo(from, to) }

  /** 看向坐标或某个玩家/实体（who 传名字；英文名/玩家名/中文别名都认）—— 实现在 `src/camera.mjs` */
  async lookAt (opts = {}) { return await lookAt(this.requireBot({ allowDead: true }), opts) }

  /* ───────────── 放置 / 破坏（"搭高"就该用工具，不要用 /setblock） ───────────── */

  /** 找一个能对着放的相邻实体方块 —— 实现在 `src\place.mjs`（`placeRef`）。 */
  #placeRef (pos) { return placeRef(this, pos) }

  /** 把背包里的方块放到某个坐标（先走近、必要时往上搭）—— 实现在 `src\place.mjs`（`placeBlock`）。 */
  async placeBlock (opts = {}) { return await placeBlockImpl(this, opts, this.#placeCtx()) }

  #placeCtx () { return { t: (p, kind, label) => this.#t(p, kind, label) } }


  /** 挂"服务端到底认没认这次破坏"的监听（`src\server-break.mjs` 的 `watchServerBreak`，完整推导在那个模块头）。
   *  一句话：mineflayer **不做客户端预测** —— 本地世界要等服务端的 `block_change` 才变，
   *  所以"本地变 air"不能当证据（客户端只会**落后**、不会抢先）；服务端拒绝时还会用同一个包
   *  把原方块发回来"复原"—— 只有"服务端说这块变 air"才算挖掉。 */
  #watchServerBreak (b, pos) { return watchServerBreak(b, pos) }

  /** 等**服务端的判决**（最多 `maxMs`，服务端说"这块变空气了"就提前收手）—— 实现在 `src\server-break.mjs`（`awaitServerBreak`）。 */
  async #awaitServerBreak (b, watch, opts = {}) {
    return await awaitServerBreak(b, watch, { ...opts, callLeft: () => this.callLeft(), signal: this.abortSignal })
  }

  /* ─── 挖掘（路线图第 ④ 条第三十八刀：函数体搬到 src\mining.mjs）─── */

  /** 破坏某个坐标的方块（比 mc_dig 更直接：按坐标）—— 实现在 `src\mining.mjs`（`breakBlock`）。 */
  async breakBlock (opts = {}) { return await breakBlockImpl(this, opts, this.#mineCtx()) }

  #mineCtx () {
    return {
      /* 第四十刀：`dig` 与 `breakBlock` 共用这份 ctx —— 这几项只有 `dig` 用得到
       * （捡掉落物、任务记账、收工判决、结果里补"手上变了"、领移动号）。 */
      grabDrops: (b, opts) => this.#grabDrops(b, opts),
      taskHave: (item) => this.#taskHave(item),
      taskSettle: (task, out, okCount, wantTotal) => this.#taskSettle(task, out, okCount, wantTotal),
      verdictLine: (out, okCount, wantTotal) => this.#verdictLine(out, okCount, wantTotal),
      withHeld: (out, b, before) => this.#withHeld(out, b, before),
      beginMove: () => this.#beginMove(),
      waitGrounded: (b, ms) => this.#waitGrounded(b, ms),
      equipFor: (b, blk, label) => this.#equipFor(b, blk, label),
      watchServerBreak: (b, pos) => this.#watchServerBreak(b, pos),
      awaitServerBreak: (b, watch, opts) => this.#awaitServerBreak(b, watch, opts),
      t: (p, kind, label) => this.#t(p, kind, label),
    }
  }

  /** 统一交互入口：mode = look / place / break / toward（实现在 `src\world-use.mjs` 的 `interact`）。 */
  async interact (args = {}) { return await interact(this, args) }

  /** 装备某物到手上（实现在 `src\world-use.mjs` 的 `equip`）。 */
  async equip (opts = {}) { return await equip(this, opts, { t: (p, k, l) => this.#t(p, k, l) }) }
  /** 附魔台：看三个选项 / 选一个附魔（实现在 `src\world-use.mjs` 的 `enchantTable`）。 */
  async enchantTable (opts = {}) { return await enchantTable(this, opts, { t: (p, k, l) => this.#t(p, k, l) }) }
  /** 铁砧：合并/修复两件、或者改名（实现在 `src\world-use.mjs` 的 `anvilTable`）。 */
  async anvilTable (opts = {}) { return await anvilTable(this, opts, { t: (p, k, l) => this.#t(p, k, l) }) }
  /** 锻造台：模板 + 底座 + 附加 → 成品（实现在 `src\world-use.mjs` 的 `smithingTable`）。 */
  async smithingTable (opts = {}) { return await smithingTable(this, opts, { t: (p, k, l) => this.#t(p, k, l) }) }
  /** 批量放置：(x1,y1,z1)→(x2,y2,z2) 的实心长方体，逐个 `placeBlock`（`src\build.mjs`）。 */
  async build (opts = {}) { return await buildImpl(this, opts) }
  /** 搭路（水平搭桥）：一格格铺，**每块等服务端确认了才走**（`src\bridge.mjs`；寻路库不会水平搭桥）。 */
  async bridge (opts = {}) { return await bridgeAcross(this, opts, { t: (p, k, l) => this.#t(p, k, l) }) }

  /** 原地跳一下（爬台阶用）—— 实现在 `src\movement.mjs` 的 `jump`。 */
  async jump () { return await jumpImpl(this, { bumpGen: () => this.#beginMove() }) }

  /** 上浮换气（在水里按住 jump 游泳）—— 实现在 `src\movement.mjs` 的 `swimUp`。 */
  async swimUp (opts = {}) { return await swimUpImpl(this, opts, { bumpGen: () => this.#beginMove() }) }
  async respawnNow () { return await respawnNowImpl(this) }

  /** 船/矿车：开（`look` 定方向 + `moveVehicle` 给动力）与下来（潜行，不是 dismount 包）—— `src\boat.mjs`。 */
  async driveBoat (target, opts = {}) { return await driveBoat(this, target, opts, { bumpGen: () => this.#beginMove() }) }
  async dismountVehicle (opts = {}) { return await dismountVehicle(this, opts) }

  /* ───────────── 创造取物 / 使用 / 攻击 / 丢弃（补能力，2026-09-15）───────────── */

  /** 选槽位放取来的物品：已搬到 `src\inventory.mjs` 的 `freeSlot(b, itemName)`（路线图第 ④ 条第七刀） */

  /** 创造模式直接获取物品（为什么不用 /give 见 `src\inventory.mjs` 的 `giveItem`）—— 实现在那个模块里 */
  async giveItem (opts = {}) {
    const b = this.requireBot()
    return await giveItem(b, opts, {
      t: (p, k, l) => this.#t(p, k, l),
      /* 🔴 2026-10-15 审计：`prismarine-item` 的 `Item` 构造函数**第一个参数是数字 id**
       *    （`node_modules/prismarine-item/index.js:36` 是 `registry.items[type]`，按 id 查表）。
       *    这里原来直接传 `type` **对象**（调用方给的是 `registry.itemsByName[itemName]`）⇒ 查不到
       *    ⇒ `item.name` 退化成 `'unknown'` ⇒ 物品确实进了背包、但名字对不上，
       *    紧接着 `pickPlaceItem(b, 'oak_planks')` 找不到它、报"背包里没有 oak_planks"
       *    （实机症状：创造模式 `mc_build` 给个方块名却说背包里没有）。
       *    所以这里统一取 `type.id`（同时兼容调用方直接给数字 id）。 */
      makeItem: (type, n) => new (itemLoader()(b.registry))(
        (type && typeof type === 'object') ? type.id : type, n),
    })
  }

  /** 清空背包（创造模式，清完抽查一遍再说结果）—— 实现在 `src\inventory.mjs`（`clearInventory`） */
  async clearInventory () {
    return await clearInventory(this.requireBot(), { t: (p, k, l) => this.#t(p, k, l) })
  }

  /** 把朝向**立刻**拧到某个点（**不等物理 tick**）—— 实现与原因见 `src/camera.mjs` 的 `aimAt` */
  #aimAt (b, point) { return aimAt(b, point) }

  /** 使用/激活方块或实体（开门、按按钮、开箱子…；服务端不回执，所以要复核）—— 实现在 `src\world-use.mjs` */
  async useBlock (opts = {}) {
    return await useBlock(this.requireBot(), opts, { t: (p, k, l) => this.#t(p, k, l) })
  }

  /** 对着空气用手上的东西（扔眼睛/射箭/喝药水）—— 实现在 `src\world-use.mjs`（`useItem`） */
  async useItem (opts = {}) {
    return await useItem(this.requireBot(), opts, {
      t: (p, k, l) => this.#t(p, k, l),
      callLeft: () => this.callLeft(),
    })
  }

  /** 攻击实体。给 `who` 就按名字找，否则打最近的那个 —— 实现在 `src\attack.mjs`
   *  （为什么不能 `await pvp.attack()` 完就 stop、名字怎么匹配、掉落物怎么提示，都写在那个文件头上）
   *
   *  `moveTo` / `equipTo` 是**能力回调**：战斗策略层要"走位/换武器"时通过这里做（撤退不做了，见
   *  attack.mjs 的 `hold-line`），而不是自己去碰 bot —— 它就不可能悄悄长成第二套移动控制器。 */
  async attack (opts = {}) {
    return await attack(this.requireBot(), opts, {
      t: (p, k, l) => this.#t(p, k, l),
      callLeft: () => this.callLeft(),
      abortSignal: this.abortSignal,
      hasPvp: Boolean(this.mcPlugins?.pvp),
      moveTo: async (pos, o = {}) => await this.walkTo(pos, o),
      equipTo: async (name) => await this.equip({ name }),
    })
  }

  /** 射箭：弹道交给现成的 `minecrafthawkeye`（水晶/末影龙怎么用、为什么每次重 bind，见 `src\shoot.mjs` 文件头） */
  async shoot (opts = {}) {
    return await shoot(this.requireBot(), opts, { t: (p, k, l) => this.#t(p, k, l), callLeft: () => this.callLeft(), log: (m) => this.logDebug(m) })
  }

  /** 丢弃手上的物品（`name` 给了就先换上那个）—— 实现在 `src\inventory.mjs`（`tossItem`） */
  async tossItem (opts = {}) {
    return await tossItem(this.requireBot(), opts, { t: (p, k, l) => this.#t(p, k, l) })
  }

  /* ───────────── 序列执行（需求 5：世界交互往往要连串调用）───────────── */

  /**
   * 按顺序执行一串步骤。替代"让 AI 写脚本"——我们不给它脚本能力，
   * 而是把"走这里→放几个→再走那里"这种连串动作收进一个工具，服务端逐步跑。
   *
   * 步骤 op：wait / move / look / toward / place / break / dig / use / useitem /
   *          attack / equip / give / toss / say / jump / swim
   *
   * 实现在 `src\sequence.mjs`（预算 / 中断 / 从第几步续跑 / 为什么 `move` 的 ok 要看 `arrived`，都写在注释里）。
   */
  async runSequence (steps, opts = {}) { return await runSequence(this, steps, opts) }

  /* ───────────── 附近有谁（已搬到 src\world-scan.mjs，第十二刀） ───────────── */
  /** 附近有谁（怪 / 玩家 / 动物 / 掉落物）：名字、坐标、距离、上下差、血量、是不是远程。见 `src\world-scan.mjs` 的 `entitiesNear()`。 */
  entities (radius = 24, opts = {}) { return entitiesNear(this.requireBot({ allowDead: true }), radius, opts) }
  readBossBars () { return readBossBars(this.requireBot({ allowDead: true })) }           // Boss 血条（龙/凋灵的血只在 Boss Bar 里，实体元数据读不到）

  /**
   * 发服务器指令（以玩家身份走聊天）。
   * @param {string} cmd 以 `/` 开头的完整指令
   * @param {{allow?: ((name:string)=>boolean)|null}} [opts] 白名单判定：默认用**内置**那份（保底，独立测试时不依赖插件配置）；插件层会传自己的可配置白名单进来（用户 2026-09-16 要求白名单可配置）。
   */
  command (cmd, { allow = null } = {}) {
    const b = this.requireBot({ allowDead: true })
    const c = String(cmd).trim()
    /* 🔴 换行符的聊天包会被服务端当场踢下线（2026-10-19 实机：10 条 /fill 拼多行 → `illegal_characters`）。这里挡死；多行用法走 `mc_command`（它逐条发）。 */
    if (/[\r\n]/.test(c)) throw new Error('一条 command() 只能发一条指令：换行符会让服务端以 illegal_characters 把我踢下线（mc_command 支持多行，它会逐条发）')
    if (!c.startsWith('/')) throw new Error('指令必须以 / 开头')
    const name = c.slice(1).split(/\s+/)[0].toLowerCase()
    const ok = typeof allow === 'function' ? Boolean(allow(name)) : DEFAULT_COMMAND_WHITELIST.has(name)
    if (!ok) throw new Error(`指令不在白名单：/${name}`)
    b.chat(c)
    return c
  }

  /** 要一个一定在线的 bot，否则抛出带原因的错（幽灵在线也认得出）—— 实现见 `src\runtime.mjs` 的 `requireBot()`。 */
  requireBot () { const b = requireBotImpl(this); try { setEnchantRegistry(b?.registry) } catch {} return b }   // 1.21 的附魔只有数字 id（`[{id:32,level:5}]`），换取名字要 registry —— 在这唯一的取 bot 口登记一次，说明见 inventory.setEnchantRegistry

}

/**
 * 边界信息：这个插件"能连哪些 MC 版本"、用的 mineflayer 是哪一版。
 * 数据源是 mineflayer 的模块级常量 `lib/version.js`（`testedVersions` 决定上界拒绝）。
 * 给 `mc_capabilities` 工具用；**不连服、不产生副作用**。
 */
export function libraryInfo () {
  const out = { mineflayer: null, testedVersions: [], oldest: null, latest: null, dataVersions: null, error: null, yggdrasilCompat: yggCompat }
  try {
    const pkg = requireFromMineflayer('./package.json')
    out.mineflayer = pkg?.version ?? null
    const v = requireFromMineflayer('./lib/version.js')
    const list = Array.isArray(v?.testedVersions) ? v.testedVersions : (Array.isArray(v?.default) ? v.default : [])
    out.testedVersions = [...list]
    out.oldest = v?.oldestSupportedVersion ?? list[0] ?? null
    out.latest = v?.latestSupportedVersion ?? list[list.length - 1] ?? null
  } catch (e) { out.error = String(e?.message ?? e) }
  try {
    const mcd = requireFromMineflayer('minecraft-data')
    const pc = mcd?.versions?.pc ?? []
    const releases = pc.map((x) => x?.minecraftVersion).filter((x) => typeof x === 'string' && /^\d+\.\d+(\.\d+)?$/.test(x))
    out.dataVersions = { total: pc.length, releaseCount: releases.length, newest: releases.slice(-6) }
  } catch { /* minecraft-data 拿不到就算了 */ }
  return out
}

export { Vec3 }
export default McBot

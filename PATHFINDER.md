# 寻路 / 防卡住：用现成的 mineflayer-pathfinder

怎么装、怎么跑自检、配置速查见 [README.md](README.md)；故障的完整根因见 [踩坑档案.md](踩坑档案.md)。

## 为什么换

之前是自己手写的走路器（`src/core.mjs` 的 `walkTo`），遇到坑/墙/1 格窄缝只能"跳一下、垫一格、横移一下"硬试。
实测两个毛病：

- **瞎跳**：每次判定卡住就 `setControlState('jump', true)` 跳 350ms，原地跳来跳去，用户原话"完全是瞎动"。
- **绕远/掉坑**：卡住的判据看"有没有动"，于是"一路挖一路走、挪了 25 格却离目标 49 格、还掉下 40 格"也算有进展。

所以按"先找现成方案"的原则，改用 PrismarineJS 官方项目
**[mineflayer-pathfinder](https://github.com/PrismarineJS/mineflayer-pathfinder)**（v2.4.5）：
A\* 寻路 + 挖穿挡路方块 + 垫 1×1 塔 / 搭桥 + 过门 + 卡住检测 + `NoPath` 判定，全是现成的。
手写的那套（含"卡住就盲跳"）**已整段删除**。

## 装在哪（重要）

```
%USERPROFILE%\.dsh\profiles\desktop\vendor\mc-deps\
  package.json
  node_modules\mineflayer-pathfinder\      ← 2.4.5
  node_modules\...（41 个包，版本跟宿主一致）
```

**故意不装进 profile 的 `node_modules`**：那里是 pnpm 的符号链接农场，跑一次 `pnpm install` 就会把
打过补丁的 `readable-stream` 冲掉（那个补丁没了 DSH 起不来）。`vendor\mc-deps` 是独立的 npm 树，互不影响。
装/重装：

```powershell
cd %USERPROFILE%\.dsh\profiles\desktop\vendor\mc-deps
npm install --no-audit --no-fund mineflayer-pathfinder@2.4.5
node %USERPROFILE%\Desktop\agent\dsh-mc-agent\tools\check-mc-deps.mjs   # 装完必跑
```

> 插件目录现在是 **junction**（profile 依赖写 `link:C:/Users/BLUE/Desktop/agent/dsh-mc-agent`），
> Node 会把符号链接解析成 realpath ⇒ 靠 `import.meta.url` 往上数三层的 `<profile>\vendor\...` 那条候选
> **会失效**（`../../../vendor` 变成 `%USERPROFILE%\Desktop\vendor`）。所以 `loadMcDep` 里加了一条
> **绝对路径兜底**（`$DSH_HOME\profiles\*\vendor\mc-deps\...`），见踩坑档案第 10 条。

## 怎么接上的

`src/core.mjs`：

| 东西 | 作用 |
| --- | --- |
| `loadPathfinder({log, logWarn, spec})` | 找并 `import()` 这个包。顺序：环境变量 `DSH_MC_AGENT_PATHFINDER`（给目录或 `index.js`）→ 插件包旁边的 `<profile>\vendor\mc-deps\node_modules\mineflayer-pathfinder\index.js` → **`$DSH_HOME\profiles\*\vendor\mc-deps\node_modules\...`（绝对路径兜底）** → 裸包名。`log` = 成功细节（调用方传 `logDebug`，默认不落盘），`logWarn` = 候选不可用/形状不对（info） |
| `resetPathfinderCache()` | 清缓存，重查（**只缓存成功、不缓存失败**） |
| `scaffoldingItemIds(bot)` | 算出"能拿来垫脚"的方块 **item id**（土/圆石/木板…，排除矿石、钻石/铁/金块、远古残骸；只认整方块，见踩坑档案第 6 条） |
| `McBot.setupPathfinder()` | `bot.loadPlugin(pathfinder)`，设 `thinkTimeout=8000`、`tickTimeout=40`、`searchRadius=192`，成功置 `pfReady=true`；`connect()` 里自动调。**`thinkTimeout` 原来是 4000，实机挖树频繁 `Took to long to decide path to goal!`（挖 4 根原木只拿到 1 根），改成 8000 后"目标在高处要垫脚"这类难想的目标才有机会想出来** |
| `McBot.#walkPathfinder()` | 真正走：`goals.GoalNear(x,y,z, arrive-0.6)` + `Movements`（`canDig`、`maxDropDown=3`、`liquidCost=4`、`digCost=4`、`dontMineUnderFallingBlock`、`scafoldingBlocks`）、超时/中断走 `raceAbort`，完了**自己再核一遍距离**（"说到了但人没到"一律报 `arrived:false, stuck:true`） |
| `McBot.walkTo()` | **只调用** `#walkPathfinder()`；pathfinder 没装上就停止移动并如实返回 `PathfinderUnavailable`，不再盲跳或退回手写逻辑 |

行为变化：走路会**自己挖穿软方块、垫 1×1 塔**（用背包里的土/圆石之类）；`allowParkour=false`、
`maxDropDown=3`（不乱跳崖）、`liquidCost=4`（不太愿意下水）。
`#movements()` 造的那份 `Movements` 同时给 pathfinder / collectBlock / pvp 用 —— 免得"我自己走不乱跳、
插件走就乱跳"。

## 怎么关 / 怎么调

- **禁用**：`DSH_MC_AGENT_PATHFINDER=off`，或插件配置 `pathfinder: false`。禁用后移动会安全停止，不退回手写走路器。
- **调走路**：`walkCanDig`（默认 true，false = 只走不挖）、`walkDigCost`（默认 4，越小越愿意挖）、
  `walkDigFirst`（默认 true：显式 `noDig:false` 时把挖按"多走一步"计价、走最短那条；
  false = 回到"能绕就绕"）、`walkDigFirstCost`（默认 0.4，挖一格的系数，越小越爱挖）、
  `walkPlaceCost`（默认 12，**垫方块的代价**；上游默认 1 ⇒ 比挖一格还便宜，会"下坡时横向垫方块"，
  调高到比 `walkDigCost` 大才只在没别的路时垫 —— 掉坑里垫出来仍然会垫）、
  `walkMaxDropDown`（默认 3）、`walkAllowParkour`（默认 false = 不跳远；打开它对"1 格台阶卡住"没用）。
- **调寻路本身**：`setupPathfinder()` 里的 `thinkTimeout` / `tickTimeout` / `searchRadius`
  （配置键 `pfThinkTimeoutMs` / `pfSearchRadius`）。
- **查日志**：`已找到现成的寻路插件（…）` 这类"加载到哪一步"的细节行**默认不落盘**（降级到 debug，
  原来每个连接都重打一遍、占主日志三成）。要查加载过程就 `MC_LOG_LEVEL=debug` 重连一次；
  走路相关的 info 行仍在（`已进入` / `连接结束` / `⚠️ 寻路 超时…`）。

## 打过的补丁（都在 vendor 树里，`npm install` 不会冲掉）

| 包 | 补丁 | 体检 |
| --- | --- | --- |
| `mineflayer-pathfinder` | ①`lib/physics.js`：`collides()` + `simulateStraight()`（贴墙穿模不算"能直走"）②`lib/movements.js`：`getMoveDiagonal` 禁掉**斜切拐角**（"怎么不动了"的根因） | `check-mc-pathfinder.mjs` 24/0 |
| `mineflayer-pathfinder` | ③（2026-10-27）`index.js`：**`resetPath` 不再把"正常重算"当成中止**（`RESUMABLE_RESETS` 不 `stop()`、`path_reset` 无条件外发、暴露 `lastResetReason()`），`lib/goto.js` 的 `PathStopped` 带上真实理由；**垫方块改成起跳前预装备**（`placingEquipped`，以前"先起跳、再 equip、再放"在 200ms 延迟下必然摔） | `check-move-progress.mjs` 549/0、`tools/patch-mc-deps.mjs --check` |
| `mineflayer-tool` | `lib\Tool.js` 加 `_triedChest`（空手挖方块会无限递归到 OOM） | `check-mc-deps.mjs` 第 4 段 |
| `readable-stream` | 8 处 `require('X/')` → `require('X')`（尾斜杠地雷，会让整个 `import()` 失败） | `check-mc-deps.mjs` |

前两条的完整现象/根因/实机证据见 [踩坑档案.md](踩坑档案.md) 第 2、4 条（2026-10-27 那条见文末「移动老是卡」）；
成品备份在 `dsh-mc-agent\备份\pathfinder-补丁备份\`（`index.js` / `goto.js` / `movements.js` / `physics.js`，
可直接还原）。③ 这类可自动重放的补丁都写在 `tools/patch-mc-deps.mjs` 里，**重装依赖后跑一次**
`node tools/patch-mc-deps.mjs` 即可（`--check` 只检查）。

## 上游复核（2026-10-06）：已经修了，只是没发布

把 npm 原版 2.4.5、上游 master（2026-10-03，PR #393 已合入）、本地两处补丁塞进同一个实机场景
（空背包站在 1 格深沟里，往东上 1 格台阶到 `(4,66,3)`）：

| 版本 | 结果 |
| --- | --- |
| npm 2.4.5 原版 | `arrived=false`，30 秒只挪 1.6 格，`path_reset('stuck')` 8 次 |
| 上游 master | `arrived=true`，1434 ms，挪 6.32 格，stuck 0 |
| 本地两处补丁 | `arrived=true`，1705 ms，挪 6.82 格，stuck 0 |

⇒ master 的 `getMoveDiagonal` 里 `if (y === 1) return` 治的是同一个病根；**npm latest 仍是 2.4.5，
没带上这个修复**，所以本地补丁照旧留着。**已决定不上报**（`#310` 还开着、`#393` 已合进 master，再开是重复）。

## 单次调用 ≤11 秒：走不到常常是"这一轮的时间到了"

`walkTo` 一次**最多走 10 秒**（`CALL_BUDGET_MS`，设计见 [README.md](README.md) 的「单次调用 ≤11 秒」一节）。
长路要分几次走，**到点返回不是失败**：

- 返回值 `arrived:false` 带 `moved` / `remaining`，告诉你走了多少、还差多少；
- `hint` 明确写"这一轮的走路时间用完了（单次调用最多 10 秒），**不是走不通**：直接再叫一次 mc_move
  往同一个目标走，会接着走"；
- 只有 `reason:"NoPath"`（真没路）才会建议"换个能走到的目标点，或先解除挡住它的方块"。

判断"是不是被预算截断的"用 `#walkPathfinder` 的 `budgetAsked` 入参 —— 以前只看 `msLeft() <= 400`，
DSH 把截止时刻设成一整轮时，预算到点还剩约 1 秒 ⇒ 被误判成"真走不通"。

## 长程赶路：只给 x/z + 报出"还要几次调用"（2026-10-23，用户点名要的）

用户点破的真问题不是"少一个移动项目"，而是**现成的 pathfinder 长程能力没暴露给 AI**。四处漏：

| 漏在哪 | 以前 | 现在 |
| --- | --- | --- |
| 目标必须猜 y | `mc_move` 强制 x/y/z，goal 恒为 `GoalNear(x, ty, z, ~1)`，`standPointFor` 只兜 ±1 格（y 猜错 2 格就救不回来） | `mc_move {x, z}`（或 `xz:true`）⇒ `goals.GoalXZ`，**按"到那一列"算，y 不用猜**；**给了 y 就按 y 走（y 优先）**，`xz` 被忽略 |
| 走了多远没数 | 只报 `moved` / `remaining` | 多报 `pathLenPlanned`（首次规划多少节点）、`pathLen`（最后一次还剩多少）、`estCalls`（按一次 10 秒 ≈ 43 格算**大约还要几次调用**）；hint 直接说"同参数接着叫，别换目标点" |
| 路径每轮都被扔掉 | `finally` 里 `stopPathing(b)` ⇒ `setGoal(null)` ⇒ `resetPath`，**整条 A\* 路径丢**（这轮走 10 秒，下轮从头重算） | 仍然每轮重算（P0 没动这条，见下面"还没做"），但现在**报得出"还剩多少节点"**，模型能估还要不要接着叫 |
| 旋钮全锁死 | `allowSprinting` / `dontMineUnderFallingBlock` / `blocksToAvoid` / `profileFor` 全在内部 | 仍未暴露（P2 待做），AI 目前只能间接碰 `noDig` / `allowTower` |

- `xz` 下**到达判定与"卡住"判定一律用水平距离**（`Math.hypot(dx, dz)`）：`GoalXZ` 只有两维，
  用三维距离判"靠近"会把"在上层来回乱爬"也当成进展，长路永远不判卡。
- `xz` 目标**不过 `standPointFor`**：那函数会替目标挪列（找附近能站的格），等于替 AI 改目的地。
- `xz` 下到达复核也放宽到"水平距离 ≤ arrive + 1"（`GoalXZ.isEnd` 要求真踏进那一列，太严）。
- `fly` / `boat` 是三维移动，**必须给 y**（`xz` 只对 walk 有效）。
- **还没做（P1 / P2）**：`resume:true` 保留路径续走（省掉每轮重算 A* 的开销）、
  `allowParkour` / `maxDrop` / `sprint` 旋钮。真要做得先确认"保留路径"不会和 `#walkPathfinder`
  的抢占号（`_moveGen`）打架。

回归：`check-move-progress.mjs` 第 ⑨ 节（`xz` 采样器对比、`GoalXZ` 接线、
`pathLenPlanned === 200` / `estCalls === 5`、不给 xz 时不多出字段、静态接线 9 条）。

## 移动抢占：两份移动共用一个 `bot.pathfinder` 会互相停掉

自主层原来那份自保（被怪贴上时先跑）和 AI 那一轮的 `mc_move`/`mc_dig` 用的是**同一个** `bot.pathfinder`，
而 `#walkPathfinder` 的 `finally` 原来**无条件** `b.pathfinder.stop()` + 松控制位 ⇒ 先结束的那份会把
另一份一起停掉：**动一下就僵住**（用户 m10335「他动了一下不动了，应该是 move 的时候冲突了」）。

现在：

- 每次移动开始**领一个号**（`_moveGen` / `#beginMove()`），`finally` 里只有"号还是最新的"才允许动
  pathfinder 和控制位；
- 公开 `interruptMove(reason)` 用来**抢占**（号 +1、停 pathfinder、停采集任务、松控制位，立刻返回），
  现在只有 `mc_dig` / `mc_craft` 抢占用它 —— 自保反射已经**不再自己移动**（用户 m11410：把受到攻击
  自动跑离开去掉），所以它也不抢了；
- 被抢占的那次 `walkTo` 如实返回 `reason:"preempted"`，hint 写明"被另一次移动打断了，再叫一次 mc_move
  接着走，**不是走不通**"—— 不能让模型误以为路不通而换目标；
- `#cancelCollect` 和 `dig()` 的采集分支也各领一次号（collectBlock 自己走过去，同样算"一次移动"）。

细节与回归见 [踩坑档案.md](踩坑档案.md) 第 9 条（`check-call-budget.mjs` 第 ⑩ 节 17 条）。

## 进度监控 + 自动脱困阶梯（2026-10-15，用户点名要的）

上面那套"到点返回不是失败"解决的是**预算用完**；这一节解决的是另一种最常见的失败：
**路找得到、但机器人就是没挪窝**（卡方块边缘、贴墙角来回抖、跳不上去）。

**判据是"既没挪动、也没靠近"，不是"速度为 0"** —— 跳跃、落地、正挖着、正放着方块这些
**正常等待不算卡住**，而且挖/放最多豁免 `MOVE_BUSY_MAX_MS = 6000`，免得"一直挖个不停"被当成正常。
`MOVE_SAMPLE_MS = 600` 采一次样，连续 `MOVE_STUCK_MS = 2400` 没进展才判卡
（`MOVE_PROGRESS_EPS = 0.35`：比"历史最近距离"近 0.35 格才算靠近）。

判卡后按 `MOVE_ESCAPES = ['repath', 'jump', 'backoff']` 三级依次试，
每级**先 `ctx.stopPathing(b)` 真停**（`pathfinder.stop()` 只置 `stopPathing = true`，
要走到**下一个节点**才理会 —— 卡住时永远走不到，喊停等于没喊；见 [踩坑档案.md](踩坑档案.md) 第 96 条），
再按控制位（`jump` 320ms / `backoff` 按 `back` 420ms），然后**用同一个 `goal` 对象**重新 `goto`
（换对象会被 `lib/goto.js` 的 `goalChangedListener` 判成 `GoalChanged` 直接拒绝）。

三级用完还是没改善 ⇒ `reason:"unreachable"`，文案是"**真的走不动了**"，并劝 AI **别原地重试**
（把长路拆成几段、`mc_scan` 看看挡路的到底是什么）。返回里多一个 **`repathCount`**（没卡住就不出现）。

**⚠️ 与 2026-10-06 那次回退的区别**（别把这两件事混起来）：当时是**没被要求就自己加**了一层
"就地挖垫脚料 → 跳 → 再走"，用户当天说「先把你刚刚写的掉进竖井自己爬出来删了，我遇到问题再找你」，
于是整段回退。**这次是用户点名要的**（原话见下），而且形态不同：
只在"确认卡住"之后动作、每级都先真停、动作有上限、失败如实报 `unreachable` 而不是无限瞎动。
用户 2026-10-15 的原话：「给移动增加'进度监控 + 自动脱困'…**不要只根据速度为零判断卡住**…
按顺序尝试重新计算路径、跳跃脱困、后退后重新寻路…多次失败后返回明确的 stuck 或 unreachable，
**不要无限重试**」。

细节、常量与回归见 [踩坑档案.md](踩坑档案.md) 第 96 条（`check-move-progress.mjs` 104 条）。

## 路径失效重算 + 到达判定分两轴（2026-10-15）

上面那套解决的是"**没挪窝**"；这一节解决另外两种：**路一直被改**、**到了但站错了层**。

### 一、路径被反复失效 ⇒ 光重算没用

`mineflayer-pathfinder` 自己有一道判卡（`index.js:632`）：`performance.now() - lastNodeTime > 3500`
就 `resetPath('stuck')`。另外 `block_updated`（方块变了）、`path_stopped`、`goal_updated` 也都会 `resetPath`。
**问题是它只会重算同一条路** —— 路一直被世界变化打断（别人在放方块、实体走过来、岩浆在流、方块在更新）时，
它会一直重算到超时，然后我们这边报一句"时间到了"。

所以现在**数失效次数**：`onReset` 里累加 `pathResets`（本轮）、`pathResetsTotal`（整次）、
`resetReasons`（按理由分类）。**本轮**失效 ≥ `MOVE_RESET_LIMIT = 4` 且**没有进展** ⇒ 直接进脱困阶梯，
不用再等满 `MOVE_STUCK_MS`。

三条纪律（都有断言钉着）：

- **进展优先**：还在靠近就不叫停（一直被打断但还在往前挪，那就让它挪）。
- **正常等待不叫停**：挖着 / 放着 / 悬空时不看失效次数（挖本身就会让世界更新、路径失效）。
- **报清成因**：`err.mcPathThrash = true` 与"没进展"分开，返回里多 `pathThrash` 和
  `pathResets` + `pathResetReasons`（≥2 次才报，1 次是正常的），文案是
  "路一直在被世界变化打断…**不是**找不到路"，建议**把长路拆成几段** / `mc_scan`、`mc_observe` 看路上在变什么。

### 二、到达判定分两轴

`goal_reached` 是插件说的，我们自己**再核一遍**。原来只核三维距离 `left > arrive + 1.0`，
漏掉一种假成功：**水平到位了、垂直差一两格**（站在目标正上方/正下方，比如目标格旁边是个坑），
三维距离照样小于阈值 ⇒ 报"到了"。现在拆成两轴：

```js
const horiz = Math.hypot(end.x - target.x, end.z - target.z)
const vert  = end.y - ty
const vertBad = vert < -1.5 || vert > 1.5      // 一步台阶以内
if (left > arrive + 1.0 || vertBad) { … }
```

`goal_reached-but-far` 那条返回新增 `horiz` / `vert` 两个字段，hint 在 `vertBad` 时改说
"**高度不对**：水平只差 X 格、垂直差了 Y 格（我站在目标上方/下方）—— 先 `mc_move` 走到目标**同一层**"。

## 搭路：`mc_act { mode: "bridge" }`（2026-10-15）

**为什么必须单独做**：pathfinder **不会水平搭桥**。过一条沟只有两条老路 —— 让 AI 自己"边走边往脚下放方块"
（而 `src/place.mjs:31-32` 明确拒绝朝半空垫方块，`mv.placeCost = 12` 让垫脚变成最后手段），
或者干等 `NoPath`。用户点名要的就是这条：**"搭路做成独立的状态机"**。

**形状**（`src/bridge.mjs`，严格按用户给的 A/B/C/D 四步）：`x/y/z` 写**对岸那一格**，
`bridgeDirTo(feet, {x,y,z})` 从它反推方向与格数（只走直线、`y` 必须等于 `feet.y - 1`），
桥面铺在 `脚.y - 1` 那一层。每轮：

1. **A 看脚下与前方** —— 脚下是实地吗？在下落吗？前方 `hazardIn()` 有没有致命方块？血量够吗？
2. **B 定这一格** —— 已有实心方块就跳过（断点续铺）；否则 `canPlaceInto()` + 重新挑料。
3. **C 放一块** —— `self.placeBlock()`，然后 **`confirmBlockAt()` 回读服务端确认**（不认"我以为放上了"）。
4. **D 确认了才走** —— `self.walkTo(stepTo, {arrive:0.9, budget:min(3500, 剩余)})`，
   核对 `feetOf()` 真到那一格了、且新位置脚下仍是实心。

**任何一处对不上就 `stop(why)` 立即返回，绝不继续往下铺**。收场字段
`{ ok, stopped, why, dir, count, from, placed, walked, placedAt, held, hint }`。

**常量**：`BRIDGE_MAX = 16`（一次最多 16 格，更长要分几次）、`BRIDGE_MIN_HEALTH = 8`、
`BRIDGE_DEEP = 8`（落差超过它、又看不到底 ⇒ 拦）、`BRIDGE_CONFIRM_TRIES = 8` × `BRIDGE_CONFIRM_MS = 150`（回读轮询）、
`BRIDGE_STEP_MS = 3500` / `BRIDGE_STEP_ARRIVE = 0.9`（每格走多久 / 走到多近算到）、
`BRIDGE_FATAL`（lava / fire / soul_fire / magma_block / campfire / soul_campfire / cactus / powder_snow / sweet_berry_bush）、
`BRIDGE_WET`（water / bubble_column，只是记 `risk` 不拦）。

**接进来的地方**：`src/core.mjs` 的 `async bridge(opts)` 薄包装；`index.js` 的 `mc_act` 里 `case 'bridge'`；
`src/movement.mjs` 的 `emptyNoPath` hint 会劝"是沟/缺口就改用 `mc_act{mode:\"bridge\"}`"。
**没加新工具、没加新参数**（只复用 `mc_act` 已有的 `x/y/z` + `name`）—— 因为工具描述的 token 预算当时只剩 27 字符。

**实机验收**：`实机验证/搭路/live-bridge-op.mjs`（**需要 OP/允许作弊**，用 `/fill` 在高空造平台，跑完一定拆干净）
—— **7 ✅ / 0 ❌**：正常 3 格沟铺成 `dirt/dirt/dirt` 并走到对岸（`placed:3` / `walked:4` / `skipped:1`）；
沟里放岩浆时 **`placed:0` / `walked:0`**，一块没放并说清原因。

## 地形分类 + 路径评分（2026-10-15，用户点名要的 P2）

用户原话（导航方案）：**"能根据台阶、落差和危险地形选策略"**、"**不要用一种搭路方式应付所有地形**"。

**做了什么**：`src/terrain.mjs` 每次走路前把脚边一圈（切比雪夫半径 4、窗口上 2 下 4）的柱子量一遍，
归成 `hazard / gap / drops / steps / narrow / flat`（判不出来 `unknown`），
每类给一套 `Movements` 权重，由 `src/plugins.mjs` 的 `movements(self, { terrain })` 铺上去。
接线只有三处：`movement.mjs:592` 分类 → `ctx.movements(terrain)` → `core.mjs` 的 `#movements(terrain)`。

**六类怎么判**（命中即停，先报最要命的）：

| 类 | 判据 | 这套权重想干什么 |
| --- | --- | --- |
| `hazard` | 圈里有岩浆/火/仙人掌/细雪 | 一格都不许往下跳（`maxDropDown 1`）、水一滴都别碰（`liquidCost 20`） |
| `gap` | ≥1 根柱子**整根找不到落脚点**（自己那层还是空气） | 垫方块明显放宽（`placeCost 4`）—— 这地方就是要垫/搭 |
| `drops` | 往下 ≥3 处，或最深处 ≤ −3 | 收窄往下跳（`maxDropDown 2`）、挖更贵（挖了脚下可能塌） |
| `steps` | 往上 ≥3 处，或最高一步 ≥2 | 挖穿更便宜（`digCost 3`）—— 一格台阶绕路要好几步 |
| `narrow` | 实心墙 ≥ max(3, 45% 的柱子) | 挖更贵（挖了容易把自己埋了）、垫方块稍放宽 |
| `flat` | 以上都不是 | **就是改动前那套全局值**（3/4/4/12、跳远关） |

> **跳远（`allowParkour`）2026-11-04 起 8 档全关。** 2026-10-30 曾给 `drops` / `gap` / `narrow`
> 三档开过（柱林/断崖之间 A\* 才不至于 NoPath），但跑酷落地判定延迟、观感像"飘过去"，用户要求关掉。
> 要开就显式配 `walkAllowParkour: true`（配置赢过档案）。

**⚠️ 三条纪律**（改这张表之前先读）：

1. **只调权重，不换算法** —— A* 还是 mineflayer-pathfinder 的（用户 2026-10-06："应该有写好的
   防卡住项目…完全是瞎动"，所以不自写寻路）。看错了顶多走回原来的路，不会让机器人做危险动作。
2. **用户显式配置永远赢** —— `walkMaxDropDown` / `walkLiquidCost` / `walkDigCost` / `walkPlaceCost` /
   `walkAllowParkour` 只要设过就盖过地形档案（`profileFor().over` 记下是谁盖的）。
3. **判不出来就说 `unknown`** —— 区块没加载 / 没坐标 / `blockAt` 抛错，一律退回平地那套，不硬猜。

**说人话**：不是平地时日志里一句 `🧭 脚边是沟/缺口（80 根柱子、缺口 2…）—— 按这一类调寻路权重`；
走不通时按地形给不同的下一步（脚边是沟 ⇒ "别绕着试了，直接 `mc_act {mode:"bridge"}`"，
是岩浆 ⇒ "别从这边走"）；返回值里带 `terrain`（平地/未知时不带，报了纯占地方）。

**导航缓存（同一件事别重算两遍）**：分类结果按「脚下那一格 + 半径 + 窗口」做键缓 3 秒
（`TERRAIN_CACHE_MS`），**世界一变就作废** —— 挂的是 `blockUpdate` / `chunkDidLoad` / `chunkDidUnload`
三个事件，任意一个发生就把 `version` 加一，版本对不上立刻重扫。
`unknown`（区块还在加载）**一律不写进缓存** —— 缓存住它等于"以后一直看不出来"。
账在 `mc_diag` 的 `terrainCache` 里（`hits` / `misses` / `scans` / `version`）。

**为什么不上 Worker**：实测一次扫描 **0.193ms**（假世界 80 根柱子，2000 次共 292ms），
而 `src/perf-monitor.mjs` 的判据是 `cpuMs ≥ 30 && cpuRatio ≥ 0.5` 才值得搬线程 —— 差两个数量级。
这条判决**钉在测试里**（`check-terrain.mjs` 有一条 `perMs < 30` 的动态断言），
哪天分类真的变贵了，回归会先红。

细节、常量与回归见 [踩坑档案.md](踩坑档案.md) 第 102 条（`check-terrain.mjs` 132 条）。

## 水下：找出口 → 选出口 → 识别失败（2026-10-15，用户点名要的）

旧代码里"水里游不动"和"陆地上走不动"走的是同一套判断。但水里缺的不是按键逻辑 ——
缺的是**一个"该往哪游"的目标**和**一个"这条路走不通"的闭环**。所以这一版补的是这两件事，
**一行游泳按键都没新写**。

### 两个新模块，职责切得很干净

| 模块 | 干什么 | 不干什么 |
| --- | --- | --- |
| `src/water-navigation.mjs` | **只读**扫描 + 纯计算：找出口、给候选打分、排序 | 一行 `setControlState` 都没有；不 import `core.mjs`，不 import 游戏库 |
| `src/water-recovery.mjs` | 状态判断 + 恢复流程："搜出口 → 执行 → 复核" | 移动全靠注入的 `ctx.walkTo` / `ctx.swimUp`，自己不碰键盘 |

### 三类出口与分阶段评分（**不是"越高越好"**）

扫描范围：以脚下为中心 **水平 8 格 / 上下 8 格**，**6 邻域**分层 BFS（不用 26 邻域 ——
斜穿墙角在游戏里会被方块挡住、人卡在半路；宁可少找，不要找一条走不通的）。

| 类 | 是什么 | 注意 |
| --- | --- | --- |
| **`dry` 干燥落脚点** | 脚位 + 头位都空、脚下有实心支撑、7 格内没有要命方块 | **最优先** —— 到了就能交回陆地寻路器 |
| **`breath` 可呼吸空间** | 头位是空气（能回氧） | **只算中间目标**，不代表离开洞穴；文案里明确写"别当已经上岸" |
| **`passage` 可通行水道** | 只是更开阔的水格 | 兜底用（脱离局部死路），**不应误判为已安全** |

评分**按阶段来**，前一步不过就不看后一步：
**可达性（必须有一条真的连得通的路）→ 生存安全（岩浆/明显坠落的候选直接不进候选列表）
→ 呼吸恢复 → 真正脱险（`dry` 压过 `breath`）→ 路径成本（安全性相近时选近的）**。
所以**近在眼前 1 格的空气口袋，不会盖过远处 7 格那块能上岸的干地**（第 ⑤ 节钉住了这条）。

三条容易写错的判据（都进了踩坑档案 105 / 106）：

- **"是不是空气"不够** —— 要看脚位 + 头位塞不塞得进去、脚下有没有支撑、
  以及**从当前位置到那儿有没有一条真的连得通的路**。未加载的格子算 `unknown`，**不能当空气**。
- **`passage` 兜底必须比起点更开阔**（`open > startOpen`）+ **距离 ≥ 2**。
  少了这两道门槛，**密闭水牢里每格都是"6 个可游邻居"** ⇒ 水牢被报成"找到出口"，
  场景⑤（完全没有可达出口 ⇒ 明确失败）永远走不到。
- **起点判据用 `inWaterAt`，不是 `swimmableAt`** —— 站在干燥岸上时"脚空气 + 头空气"也可通行，
  拿它当门会变成"人都上岸了，系统还在找出口"。

找不到就**老实说找不到**，`reason` 分四种：`no-exit-found`（扫完没有）、
`budget-out`（预算用完）、`all-tried`（找得到的都试过、都没走通）、`not-in-water`。
文案统一带一句"**别在原地一直游**，换个方向再叫我一次" —— **不假装找到路**。

### 恢复控制器：复核不认"离目标够近"

`recoverFromWater` 主循环：每轮先查取消信号（**一次 `walkTo` 都不调**）→ 查预算 →
`waterExitSearch`（把"上轮走过没走通"的目标传成 `avoid` 黑名单）→ 执行 → **重新读位置和氧气**。
复核判据是**四个各自独立的证据取或**（详见踩坑档案 105）：

```js
const atTarget   = sameCell(after, res.target)              // 真站上去了
const improved   = distNow <= distWas - WATER_PROGRESS_EPS  // 真的近了一截
const gained     = st.air > beforeAir                       // 氧气真回来了
const outOfWater = !st.inWater                              // 真的出水了
```

**不能只写 `距离 <= WATER_ARRIVE`** —— 出口就在正上方一格时，距离本来就是 1.0，
人**一次都没动**也满足它。没走通就把目标加进 `tried`，下一轮重新搜。

### 接进来的三处（用户 2026-10-15 的硬约束）

1. **`src/movement.mjs` 的 `walkTo` 水里分支** —— `walkSwim` 报 `stuck` 之后：
   ```js
   if (swim.stuck && !ctx.noWaterRecover && self.msLeft() > 1_500) {
     const rec = await recoverFromWater(self,
       { budgetMs: Math.min(12_000, Math.max(0, self.msLeft() - 900)) },
       recoverCtxOf(self, ctx))
     ...
   }
   ```
   - **接进现有水中流程**（不是另开一条路）、**不另起一套按键控制**；
   - `recoverCtxOf` 给的就是**这一层已有的** `walkTo` / `swimUp`，**不新建移动代次、不新建资源锁**；
   - `noWaterRecover: true` **防递归**（恢复过程中再走路时不许再次触发恢复）；
   - `self.msLeft() > 1_500` 是**调用预算闸门** —— 用户要求"避免一次出口搜索耗尽整个工具调用预算"，
     剩不到 1.5 秒就老实报 `swim-budget`，不开这一趟；
   - 结果挂回返回值：`waterRecover: rec` + `outOfWater` + 换过的 `hint`。
2. **`extensions/mc_auto.mjs` 的反射层** —— 憋气那条分支里 `startWaterRecover(...)`，
   限流 15 秒 / 单次上限 15 秒；**自救那一路一行 `setControlState` 都没有**。
3. **🔴 绝不偷偷接管** —— 每次自动救援结束都走原来那条叫醒通道
   `agent.steer(userMessage({ content: [{ type:'text', text: waterReportText(res, trigger) }] }))`，
   文案结尾固定一句 **"我没有替你决定接下来去哪 —— 原来的任务要不要继续，你看一眼再定。"**
   累计次数与上一次结果进 `stats`，`mc_diag` 里看得到（`🌊 水下自救 N 次（出来 M 次）`）。

### 第一版没动的

**没改 mineflayer-pathfinder 的水下移动规则**（按用户要求）——
先用现有的 `walkTo` / `swimUp` 执行路线，让新模块专门解决"找路线、选出口、识别失败"；
等离线与实机都证明出口搜索有效，再考虑动寻路器自己的水中规则。

## 已知能力缺口：掉进竖井 + 背包里一块方块都没有 = 出不来

实机踩到过（`mc_move` 连试 3 次全失败，90 秒只挪 0.2 格，`reason:"partial"` / `"stuck"`，
其中一次 `pillared:26` 全是白垫）：

- 机器人站在一个 **1 格宽、4 格高**的竖井里，头顶被 `jungle_planks` 封住。
- pathfinder 的 `canDig` **只挖路径前方的方块**；要往上走只能靠 `allow1by1towers` 垫 1×1 塔，
  而垫塔**需要背包里有 `scafoldingBlocks`**（土就行）—— 一块都没有就彻底出不来。
- 更细的一条：竖井里**必须先能跳**（头顶要有空位）才垫得动。实测让它先跳一下（y=79 → 80），
  之后同一次 `walkTo` **2825 ms 就到了**。
  → 2026-10-18 起 `mc_map {mode:"column"}` **会把头顶一起报出来**（`above.headroom` / `above.ceiling` /
  头顶的水·岩浆，默认往上看 40 格）：头顶顶死时报告直接说"**跳不起来**，别在原地试垫脚"，
  不用再靠 AI 自己猜"为什么垫了也上不去"。**但"判得出来"不等于"爬得出来"** —— 缺口本身没修。

**"能挖"不等于"能爬"。这条目前没修** —— 上面那套脱困阶梯**只换策略、不补材料**：
背包里一块垫脚方块都没有时，三级试完仍会如实报 `unreachable`（不会再无限重试，但也没法自己爬出来）。
真要补它得动"就地挖垫脚料"这类**改世界**的自救，而用户明确要求过
「删掉自写的脱困、只信 pathfinder，别又变成瞎动」——**要动这条规矩得先问用户**。
（2026-10-06 曾按用户要求试做过一版 `walkTo` 里的"卡住自救"：就地挖垫脚料 → 跳 → 再走，实机验过确实能从
竖井里出来；但用户当天又说「先把你刚刚写的掉进竖井自己爬出来删了，我遇到问题再找你」，于是**已整段回退**。
记录在这儿只是免得以后重复踩坑。）

## 窄隧道 / 一格台阶：`carveStepAhead`（2026-10-18）

实机投诉（游戏内 AI）：「窄隧道和1格台阶上它基本走不动，10秒原地蹭0.8格，还会自己拿圆石垫脚乱搭。我都是手工挖斜台阶（挖脚+挖头）」。

- **为什么会卡**：1×2 的隧道里遇到 1 格台阶，站上去要头顶再空出一格。插件的 `JumpUp` 只查"跳起来会不会撞头"，
  **不会把"挖掉天花板"当成上台阶的一步** ⇒ A* 判无路 ⇒ 人贴在台阶前 `stuck`（`remaining` 只有 0.8）。
- **现在怎么补**：`walkPathfinder` 在 `mcStuck` 且**离目标 ≤ 4.5 格**时，先 `carveStepAhead` 朝目标方向看 2 格，
  把挡在脚上/头顶的那一格挖开（要求底下有实心支撑；岩浆/火/水/基岩/黑曜石不碰；**永不挖自己站的那格**），
  然后重跑**同一个** `goto`。`attempt` 手动推进 ⇒ 这次补救**不白吃一级脱困**；最多 2 次，仍不行就把
  "挖脚+挖头再走"写进 hint。结果里多一个 `carved`。
- **`noTower` 默认改成 `true`**：`walkTo` / `walkPathfinder` 不再让插件原地垫 1×1 柱（实机"拿圆石垫脚乱搭"、
  之前还垫歪摔过 21 格）；确实要垫高只能 `mc_move {allowTower:true}`。
- **注意**：这仍然不是"会自己挖路"——只在**已经贴着目标、且脚下那格有支撑**时才动**前方脚的上面那格**。
  沟/水/悬崖/远处卡住一律不挖（照旧报 `unreachable` 并劝拆段走）。

## 2026-10-23：四条「寻路器不懂这个世界」的补丁

前三条抄自 mindcraft 的 vendor 补丁（`备份/mindcraft-参考/patches_mineflayer-pathfinder+2.4.5.patch`），
每一条都对应一次真机上的难看死法。**两处改 vendor 源码、两处在 `src/plugins.mjs` 运行时改对象** ——
分界线是「能不能在拿到 `Movements` 实例后改」：能改的一律不改 vendor（升级依赖时不丢）。

### 1. 门：路径点瞄到门顶上（改 vendor `mineflayer-pathfinder/lib/index.js`）

门在方块数据里是**整格碰撞箱**，`getBlockInfo` 给的 `point` 是「站在这一格上面」=
`{x: 格子x, y: 格子y + 1, z: 格子z}`。结果人走到门口一直往门框上顶。
`postProcessPath` 里对 `openable` 的门改成瞄**格子中心、脚在那格**，即
`{x: floor(x) + 0.5, y: floor(y), z: floor(z) + 0.5}`。铁门不在 `openable` 里，照旧当实心。
备份：`备份/pathfinder-补丁备份/index.js.已打补丁`。

### 2. 岩浆：人在岩浆里时 A* 一条路都规划不出（改 `src/plugins.mjs`）

vendor 构造器无条件 `blocksToAvoid.add(lava)`。设计上是对的（别靠近岩浆），但**人已经在里面**时
四面全是「不能站」，`goto()` 直接返回空 —— 于是掉进岩浆只能原地跳到烧死。
现在 `movements()` 建完实例后看当下状态：脚下或眼高那一格是 `lava` 就把岩浆从禁区里删掉，
否则照旧加进去。**只在「已经在里面」时放出来**，不会主动往岩浆湖里钻。

### 3. 藤蔓：在寻路眼里只是「空着的格子」（改 `src/plugins.mjs`）

vendor 的 `climbables` 只有 `ladder`（`vine` 那行是注释掉的）=> 藤蔓能站进去、不会顺着爬，
爬树 / 竖井上来 / 下界藤蔓落地全靠垫柱子。`patchClimbables(mv)` 按原版规则补七种：
`vine`、`weeping_vines`、`weeping_vines_plant`、`twisting_vines`、`twisting_vines_plant`、
`cave_vines`、`cave_vines_plant`（顶部挂的向上爬、底部垂的向下爬、`cave_vines` 双向）。
名字对不上就跳过，不抛错（换版本不会炸）。

### 4. 顺带：放方块等回包 5 秒 = 一轮 10 秒被它吃光（改 vendor `mineflayer/lib/plugins/place_block.js`）

`blockUpdate` 的等待超时上游是 `5000`，碰上幽灵方块放两个就整轮报废。改成 `1500`
（局域网实测正常回包 <100ms），失败后交给我们自己的复核逻辑判（`localRestored` 那套）。
备份：`备份/mineflayer-补丁备份/place_block.js.已打补丁`。

### 钉住它们的回归

- `node tools\check-mc-pathfinder.mjs`（36/0）—— 藤蔓七个名字各一条、「不认识的方块名不抛」、门点=格子中心；
- `node tools\check-mc-deps.mjs`（9/0）第 5 节 —— `place_block` 的 `timeout` 必须是 1500；
- `node tools\check-terrain.mjs`（146/0）—— 岩浆动态开关的接线断言。

> 注意：vendor 不在本仓库里（在 `<profile>/vendor/mc-deps/node_modules/`）。**重装依赖树后**
> `src/plugins.mjs` 那两条自动生效（代码在本仓库），**改 vendor 源码的两条要拷回备份文件**。

## 测试

- **离线**：pathfinder 的加载、`via:"pathfinder"`、不许谎报到达、`NoPath` 如实上报、超时和未加载时安全停止，
  随 `check-mc-observe-host.mjs` 的移动回归覆盖。
- **补丁体检**：`node tools\check-mc-pathfinder.mjs`（26/0）—— 两处补丁在不在、`collides()` 六种情形
  （穿模 0.06 算 / 擦到不算 / 半砖顶面不算 / 1 格宽走廊不算）、`simulateStraight()` 撞进方块标 `blocked`、
  `canStraightLine()` 老写法误判而补丁后不误判、`getMoveDiagonal()` 在台阶角上被禁而拐角空着时照旧允许。
  **给 vendor 树 `npm install` 之后也要跑。**
- **进度监控/脱困阶梯 + 路径失效重算 + 两轴到达判定**：`node tools\check-move-progress.mjs`（104/0）——
  阶梯顺序与命名、`moveBusyNow()` 的豁免、判据（含"绕圈只挪动不靠近 ⇒ 照样判卡"）、豁免上限、
  `stop()` 之后彻底安静、`escapeMove()` 先真停再按控制位、整条循环（假时钟 + 假 bot：三级走完 ⇒
  `unreachable` / `repathCount:3` / `goto` 调 4 次 / 定时器全清；一路靠近 ⇒ 一次 `goto` 就走完且不报
  `repathCount`）；以及 P1 那几条 —— 失效到上限 ⇒ **不等满 2.4 秒**就带 `mcPathThrash` 认输、
  一直靠近 ⇒ 失效次数再多也不叫停、挖着 ⇒ 不叫停、`resetsOf` 抛错当 0、不传 `resetsOf` 退回老判据。
- **搭路状态机**：`node tools\check-bridge.mjs`（108/0）—— 方向名与 `bridgeDirTo` 反推、桥面层级、
  `dropBelow` / `hazardIn` 的深浅判定、危险闸（血量/脚下/岩浆/材料/看不到底）、`confirmBlockAt` 轮询，
  以及整条 `bridgeAcross`（顺序必须是 `place,walk,place,walk`；`placed:false`、回读对不上、
  没走过去、走完脚下塌了、前方岩浆、没材料、断点续铺、目标格被占、区块未加载、超 `BRIDGE_MAX` 各一条）。
- **地形分类 + 路径评分（P2）**：`node tools\check-terrain.mjs`（132/0）——
  `columnAt`（能站的那层 / 缺口 / 墙 / 未加载 / 危险 / 水，窗口上 2 下 4）、`columnGlyph`、
  `classifyTerrain` 六类与**优先级**（危险 > 沟 > 落差 > 台阶 > 窄道 > 平地）、
  "一格台阶不把平地判成台阶"、`unknown` 的四种来源（没 bot / 没坐标 / 全未加载 / `blockAt` 抛错）、
  `profileFor`（每类一套权重 + **用户配置永远赢** + `over` 记账）、`applyProfile`（冻结对象不炸），
  以及端到端：`movements(self, { terrain })` 真的换了一套权重。
- **水下出口搜索**：`node tools\check-water-navigation.mjs`（95/0）——
  单格判据（水/空气/挡路/未加载、岩浆 ⇒ 挡路、梯子算空气而关着的门算挡路）、
  `swimmableAt` / `breathableAt` / `standableAt` / `hazardNear`（7 格邻域）、
  用户点名的八个场景里的前五个（①头顶通水面 ⇒ 优先上浮 ②头顶封住、侧面有出口
  ③空气口袋 ⇒ `breath` 且文案说"中间目标、别当已经上岸" ④近处死路、远处出口 ⇒ **选远的干地**
  ⑤密闭水牢 ⇒ `no-exit-found` + 空候选 + "别在原地一直游"），
  以及边界（干燥岸上 ⇒ `not-in-water`、`radius` 收窄、`maxNodes` 用光 ⇒ `budget-out`、`up:0` 不许往上、危险候选不进列表）。
- **水下恢复控制器**：`node tools\check-water-recovery.mjs`（103/0）——
  状态与触发（`waterTriggerOf` 纯函数：氧气低 / 掉血 / 氧气在降 / 没进展，按顺序判）、
  选执行器（正上方 ⇒ `swimUp`，其余 ⇒ `walkTo`）、场景⑥（走不通就换下一条）、
  场景⑦（取消信号 ⇒ 一次 `walkTo` 都不调）、场景⑧（上岸后交回 AI）、
  兜底上浮与失败路径（`no-executor` 不假装成功）、
  以及第 ⑧ 节的接线断言（movement.mjs 的 `recoverCtxOf` / `noWaterRecover` / 预算闸门；
  mc_auto.mjs 的 `startWaterRecover` / `agent.steer` / `stats` / 只在憋气分支启动）。
- **依赖体检**：`node tools\check-mc-deps.mjs`（8/0）。
- **真服**：`实机验证\走路\live-walk.mjs`（4/0，就是踩坑档案第 4 条那个卡点）；
  `实机验证\搭路\live-bridge-op.mjs`（7/0，**需要 OP/允许作弊**）。平时直接调 `mc_move` / `mc_act` 验证。

## 生效

`src/core.mjs` 是 DSH 启动时加载的，**改完要重启 DSH** 才生效（重启会掉当前 MC 会话）。

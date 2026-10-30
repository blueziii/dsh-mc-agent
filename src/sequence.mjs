/**
 * 连串动作的调度层（路线图第 ④ 条第二十二刀）
 *
 * 从 `src\core.mjs` 搬出来的两个成员：
 *   · `runSequence(steps, { stopOnError, budgetMs })` —— 按顺序跑一串步骤，到点/被打断就停下，
 *     并**明确告诉模型从第几步接着发**（`stoppedAt` / `remaining` / `hint`）。
 *   · `#runStep(s)` —— 单个步骤的分发（op → 具体动作）。
 *
 * ## 为什么第一参数是 `self` 而不是 `ctx`（迁移规矩第 17 / 20 条）
 * 这一层**不改**实例状态，但它要**调**一堆实例方法（`self.walkTo` / `self.placeBlock` /
 * `self.dig` / `self.attack` …）和读 `self.msLeft()` / `self.abortSignal` / `self.bot`。
 * 按第 17 条的判据（"只读几项实例状态"才打包成 `ctx`），这里要的东西既多又杂、还得回调回去，
 * 所以直接收 `self`。模块自己不 import `core.mjs`、不 import 任何游戏库（只 import 兄弟叶子模块）。
 *
 * ## 三条容易改回去的语义（都是审计钉过的，改回去就是 bug）
 * 1. **不为没执行的步骤记一条 `ok:false`**（审计⑪）：以前时间到/被打断时也会 push 一条，
 *    于是 `succeeded + failed + remaining > requested`，模型据此以为"那步做失败了"。
 *    现在只记 `next`（重发时从那步开始），不写 `results`。
 * 2. **`move` 的 `ok` 必须看 `arrived`**（审计⑧）：`walkTo` 走不通时返回
 *    `{arrived:false, stuck:true}`，以前 `ok` 硬编码 true，汇总把它算成功，模型以为"我已经到目标点了"。
 * 3. **步骤自己发现预算用尽 ⇒ 一样给 `stoppedAt`**（审计⑦）：`jump` / `flyTo` 开头就查
 *    `msLeft()`，抛出的错带 `mcCallOver`；不能让它变成"整串失败、从第 1 步重来"。
 */

import { CALL_BUDGET_MS, callBudget } from './budget.mjs'
import { sleep, raceAbort } from './async-util.mjs'
import { dangerNow, dangerText, dangerNotice, healthOf, noticeKey } from './danger.mjs'

/**
 * 这一步**到底成没成**（报告 H3，2026-10-13）。
 *
 * 以前是 `step.op === 'move' ? r?.arrived !== false : r?.ok !== false` —— 只有 `move` 特判，
 * 其余全走 `r?.ok !== false`，而**动作模块没有一个返回 `ok` 字段**：
 *   `place` 回 `{placed: 名|false}`、`break` 回 `{broken: 名|false}`、`dig` 回 `{result:[…]}`、
 *   `attack` 回 `{killed, attacked}` … ⇒ `undefined !== false` 恒真 ⇒ 汇总把失败的
 *   place / break / dig / attack 全算成 `succeeded`，模型据此以为做成了。
 *
 * 判据只认"明确的失败证据"（各 op 自己的成功字段为 `false`，或返回里带 `error`），
 * 拿不准就按成功算 —— 宁可让模型自己看 `results` 里的原文，也不要凭空报失败。
 */
export function stepOk (step, r) {
  const op = step?.op
  if (r == null) return true
  if (r.ok === false || r.error) return false
  switch (op) {
    case 'move':
    case 'swim':
      return r.arrived !== false
    case 'place':
      return r.placed !== false && r.placed != null
    case 'break':
      /* 🔴 2026-10-17（用户实机：`mc_sequence` 里某一格已经是空气，整串中止，报的还是
       *    「这一轮时间不够」而 `elapsedMs` 只有 300ms）：`breakBlock` 对空气格返回
       *    `broken: null`（"那里本来就是空气"），而这里以前判 `broken != null` ⇒ **算失败**。
       *    可这一步的**目标已经达成**（那格已经不是实心的），不该算失败、更不该中止整串。
       *    只有 `broken === false` 才是真的没挖成（够不着 / 挖不动 / 被复原）。 */
      if (r.broken === null) return true
      return r.broken !== false && r.broken != null
    case 'attack': {
      /* 🔴 2026-11-02 审计（#15）：原来是 `r.killed !== false && r.attacked !== false`，
       *   而 `attacked` 恒为**目标名字**（字符串，见 attack.mjs 的 `attacked: label`）⇒
       *   这条判据其实只剩"打死了吗"：时间到、目标跑了、只挥了两拳 —— 全算失败，
       *   `stopOnError` 于是把整串掐断，后面的步骤一步不跑。
       *   现在：打死了算成功；没打死但**确实挥到过**（swings/pvpSwings > 0，或目标掉了血）
       *   也算这一步做完了；一下都没挥到（够不着 / 目标没了）才算失败。 */
      if (r.killed === true) return true
      if (Number(r.swings ?? 0) > 0 || Number(r.pvpSwings ?? 0) > 0) return true
      if (r.sawDamage === true) return true
      return false
    }
    /* 🔴 2026-10-15 审计（报告 C 第 1 条）：下面 equip / toss / use / useitem 四条原来都是
     *   `r.xxx !== false` —— 而那几个字段**要么根本不存在、要么永远是真值**，于是"失败的步骤
     *   被算成成功"，`stopOnError` 也就永远不触发。改成看各动作**真正复核过的**字段
     *   （字段是 2026-10-15 一并补上的：`equipped` / `ok` / `opened` / `toggled`）。 */
    case 'equip':
      if (typeof r.equipped === 'boolean') return r.equipped
      return r.held !== undefined || r.now !== undefined
    case 'give':
      return r.gave !== false
    case 'toss':
      if (typeof r.ok === 'boolean') return r.ok
      if (typeof r.tossed === 'boolean') return r.tossed
      return !/只少了|没丢出去/.test(String(r.note ?? ''))
    case 'use': {
      // 容器看窗口开没开、门/按钮看状态翻没翻（这两条是硬证据）；其它方块服务端不回执，按"拿不准就算成功"
      if (r.usedBlock !== undefined && r.usedBlock !== null) {
        if (r.opened !== undefined) return Boolean(r.opened)
        if (r.toggled !== undefined) return Boolean(r.toggled)
        return true
      }
      if (r.usedEntity !== undefined) return r.reached !== false
      return r.used !== false && r.usedBlock !== false
    }
    case 'useitem':
      return r.used !== false
    case 'dig': {
      const txt = Array.isArray(r.result) ? r.result.join('\n') : String(r.result ?? '')
      return !/没挖成|没挖掉|够不着|没有能挖|不在线|复原|找不到|失败/.test(txt)
    }
    default:
      return true
  }
}

/** 按顺序执行一串步骤。替代"让 AI 写脚本"——我们不给它脚本能力，而是把"走这里→放几个→再走那里"收进一个工具。 */
export async function runSequence (self, steps, { stopOnError = true, budgetMs = CALL_BUDGET_MS } = {}) {
  if (!Array.isArray(steps) || !steps.length) throw new Error('steps 必须是非空数组')
  if (steps.length > 64) throw new Error(`步骤太多（${steps.length}），上限 64`)
  const t0 = Date.now()
  // 🔴 单次调用 ≤11 秒（用户要求：少量多次）。到点就停，并明确告诉模型**从第几步接着发**。
  //    2026-10-08 审计⑦：`msLeft()` 已经用完时，`Math.max(300, …)` 会白送 300ms。
  const leftMs = self.msLeft()
  const bd = leftMs <= 100 ? 0 : Math.max(0, Math.min(callBudget(budgetMs), leftMs))
  /* 🔴 2026-10-17（实机：AI 报「mc_sequence 会假失败：秒回报 stoppedAt:0 / elapsedMs:0 / 本轮时间不够，
   *    但方块其实已经挖掉了……我后来靠 mc_dig 复核才发现」）：
   *    `bd === 0` 时这个循环**一步都不会做**（`Date.now() - t0 > 0` 在 1 毫秒后就成立）。
   *    而这**不是"没做成"，是"没做"** —— 两件事必须分开说（踩坑档案第 107 条）：
   *    模型看到 `stoppedAt:0` 只会得出"这活没干成、再发一遍"，于是把已经做完的事重做一遍，
   *    或者在 `mc_task` 里反复撞同一堵墙。所以 `bd <= 0` 要单独标出来、单独给一句话。 */
  const noBudget = bd <= 0
  const results = []
  let next = null
  let aborted = false
  let danger = null
  /* 🔴 2026-10-17（用户报"工具排队执行、延迟很大"）：一次调用是**原子**的 ——
   *    实机 12 个 break 挖竖井，骷髅跟下来一路射，AI 要等这 10 秒过完才知道。
   *    循环开始时记一次血，之后每步之间问一次 `dangerNow()`（判据保守，见 `src/danger.mjs`）。 */
  const hp0 = healthOf(self.bot)
  /* 🔴 2026-10-19 用户：「不要打断只提醒」—— 默认**不再**因为险情把整串动作交回去：
   *    险情只写进 `warnings`（每轮 ≤11 秒，跑完这一轮再说），停下来处理由反射层叫醒决定。
   *    想恢复旧行为（一挨打就带进度退出、给 `interrupted:'danger'`）把 config.stopOnDanger 设成 true。 */
  const stopOnDanger = self.cfg?.stopOnDanger === true
  const notices = []
  const noticed = new Set()
  for (let i = 0; i < steps.length; i++) {
    /* 🔴 2026-10-08 第四份审计报告 ⑪：这两支以前会为**根本没执行**的那步 push 一条 `ok:false`
     *    ⇒ 汇总里 `succeeded + failed + remaining > requested`（模型据此以为"那步做失败了"）。
     *    现在只记 `next`（那步没做，重发时从它开始），不写 results。 */
    if (self.abortSignal?.aborted) { aborted = true; next = i; break }
    /* 挨打了 / 有怪贴脸 / 龙息（云或火球）：
     *   · `stopOnDanger`（默认 false）⇒ 立刻把控制权还回去（这一步没做，重发时从它开始）；
     *   · 否则只记一句提醒，接着跑（同一种险情一次调用只提醒一次）。 */
    const d = dangerNow(self.bot, { hp0 })
    if (d) {
      if (stopOnDanger) { danger = d; next = i; break }
      const k = noticeKey(d)
      if (!noticed.has(k)) { noticed.add(k); notices.push(dangerNotice(d)) }
    }
    if (Date.now() - t0 > bd) { next = i; break }
    const step = steps[i] ?? {}
    try {
      const r = await runStep(self, step)
      /* 🔴 2026-10-08 审计⑧：`ok: true` 以前是硬编码的 —— 而 move 步骤在"一格没挪"时返回
       *    `{arrived:false, stuck:true, reason:…}`，汇总里 `succeeded` 于是把它也算成功，
       *    模型据此以为"我已经在目标点了"。move 的 ok 必须看 `arrived`。
       * 🔴 报告⑤：`wait` 步骤被本轮预算**静默截断**时也会自报 `ok:false`（没等完），
       *    那时也要如实算失败、并从这一步重发。
       * 🔴 报告 H3：其余 op 以前走 `r?.ok !== false`（动作模块根本不回 `ok`）⇒ 恒真。
       *    现在交给 `stepOk()` 按各 op 的真实成功字段判（见上面那个函数的注释）。 */
      const ok = stepOk(step, r)
      /* 🔴 2026-10-17（用户实机：序列里某格是空气 ⇒ 整串中止，报的却是「这一轮时间不够」，
       *    他花很久才想明白是撞到空气）：非 move 步骤失败时，note 以前是**硬编码**的
       *    「本轮时间不够」，跟真实原因毫无关系 —— 动作模块明明已经把原因写在 `note` /
       *    `reason` / `error` 里了（够不着 / 挖不动 / 被复原 / 缺料 / 那里本来就是空气）。
       *    把真实原因原样带出来，模型才可能一次就改对。 */
      const why = String(r?.note ?? r?.reason ?? r?.error ?? '').trim()
      /* 🔴 2026-10-24 输出瘦身（用户："只要 ai 读就行"）：成功的步骤不再把整个返回对象展开
       *    （move 的 around/above/pathLen、break 的 held… 全塞进来，一串 8 步能堆出几千字），
       *    只留"这步做了、走到没走到、还剩多少"。**失败**的步骤仍然原样带上，那是排查依据。 */
      results.push({
        i, op: step.op, ok,
        ...(ok
          ? (step.op === 'move' ? { arrived: r?.arrived ?? null, remaining: r?.remaining ?? null } : {})
          : r),
        ...(ok ? {} : {
          note: step.op === 'move'
            ? '这一步**没走到**（看 arrived / remaining）—— 再叫一次 mc_sequence，从这一步往后发就行'
            : `这一步**没做完**${why ? `：${why}` : '（动作没给原因）'}`
              + ' —— 先按上面这句的原因处理，再叫一次 mc_sequence，从这一步往后发就行',
        }),
      })
      if (!ok) { next = i; break }
    } catch (e) {
      results.push({ i, op: step.op, ok: false, error: e.message })
      /* 🔴 2026-10-08 审计⑦：预算用尽也可能是**步骤自己**先发现的（`jump` / `flyTo` 开头就查
       *    `msLeft()`，`#t()` 也会抛带 `mcCallOver` 的错）。那时错误文案是"这一轮的 N 秒用完了"。
       *    不能让它变成"整串失败、从第 1 步重来"：跟循环顶部那支一样记下停在第几步。 */
      /* 🔴 2026-11-02 审计（#18）：兜底那条原来写 `self.msLeft() <= 150` —— 只要抛错那一刻
       *   剩余时间不到 0.15 秒，**任何**错误（含真正的 bug、NaN、插件异常）都会被解释成
       *   "这轮没时间了"，真实原因被吞掉。现在只在真的一秒不剩时才兜底。 */
      const exhausted = e?.mcCallOver === true
        || /这一轮的 [\d.]+ 秒用完了|这一轮的时间已经用完了/.test(String(e?.message ?? ''))
        || self.msLeft() <= 0
      if (exhausted) { next = i; break }
      /* 🔴 2026-11-02 审计（#18）：真出错（不是"没时间"）时以前直接 `break`，**不设 `next`** ⇒
       *   返回里没有 `stoppedAt` / "从第几步接着发"，模型只能整串从头重发，前面做成功的白做。 */
      if (stopOnError) { next = i; break }
    }
  }
  const okCount = results.filter((r) => r.ok).length
  const dText = dangerText(danger)
  const out = {
    requested: steps.length, succeeded: okCount, failed: results.length - okCount,
    /* 🔴 报告⑪：`remaining` 从"第一步还没做完的"算起（**含那一步本身**）⇒ 它和 `failed` 会
     *    指向同一步。想让账目不重复，看 `succeeded === stoppedAt`（stoppedAt 之前全成功）。 */
    attempted: results.length,
    elapsedMs: Date.now() - t0, results,
    ...(aborted ? { aborted: true } : {}),
    /* 这次调用**自己没分到时间** ⇒ 明说（`bd` 也一并给出来，别让模型猜）。
     * 与"时间用完了"是两件事：那一种是"做了一部分、时间到了"，这一种是"一步都没做"。 */
    ...(noBudget ? { noBudget: true, budgetMs: bd } : {}),
    /* 只提醒时（默认）：险情在这儿，`interrupted` 不会出现 —— 活已经跑完了。
     * 每一条都是一句现成的话，直接给模型看，不用它自己去拼。 */
    ...(notices.length ? { warnings: notices } : {}),
    /* 挨打退出：`interrupted:'danger'` 是个**能直接判**的字段（不用去啃 hint 的自然语言）。
     * `results` 里保留已经做完的那几步 —— 前功没有尽弃，AI 从 `stoppedAt` 接着发就行。 */
    ...(danger ? { interrupted: 'danger', danger: { ...danger, text: dText } } : {}),
    ...(next == null ? {} : {
      stoppedAt: next, remaining: steps.length - next,
      hint: danger
        ? `⚠️ 第 ${next + 1} 步**没做** —— 先处理眼前这个（${dText}）：`
          + '`mc_attack` 打掉它，或者 `mc_move` 躲开、`mc_act {mode:"equip"}` 换上装备。'
          + `安全了再叫一次 mc_sequence，steps 从第 ${next + 1} 步往后发。`
        : aborted
          ? `被中断了（第 ${next + 1} 步还没做）—— 要接着做就再叫一次 mc_sequence，steps 从第 ${next + 1} 步往后发。`
          : noBudget
            /* 🔴 别写成"时间用完了，原样再发一次" —— 模型会以为"刚才那串没干成"，
             *    而它**根本不知道**上一串干到哪了（这一串一步没做，上一串可能已经干完了）。
             *    正确的指令是**先复核**。 */
            ? `⚠️ 这次调用**自己没分到时间**（外层只剩 ${leftMs}ms）—— **一步都没做**。`
              + '**这不等于那些方块没动过**：先 `mc_dig` / `mc_scan` 复核一下到底做完没有，'
              + '确认真没干再单独叫一次 mc_sequence（**别塞在 mc_task 里** —— 外层时间早被前面的步骤吃掉了）。'
            : next === 0
              /* 🔴 2026-10-17：这一步以前**一律**说"时间用完了"。可第 1 步就失败、而且只花了几百
               *    毫秒时，原因显然不是时间（用户就是被这句带偏、花很久才想明白）。用"用掉的时间
               *    远不到预算"当判据分开说 —— 真原因就在 `results[0].note` 里。 */
              ? (results.length > 0 && (Date.now() - t0) < bd * 0.6
                ? `第 1 步就没做成（**不是时间不够** —— 只用了 ${Date.now() - t0}ms / 预算 ${bd}ms，`
                  + '真原因见 results[0] 的 note）—— 先按那句话处理，再叫一次 mc_sequence。'
                : '这一轮的时间已经用完了（前面什么都没做）—— 直接再叫一次 mc_sequence，steps 原样发就行。')
              : `做到第 ${next + 1} 步时这一轮的时间到了 —— 再叫一次 mc_sequence，`
                + `steps 从第 ${next + 1} 步往后发就行（前面已经做完了）。`,
    }),
  }
  out.text = seqTextOf(out, results, steps)
  return out
}


/**
 * 单个步骤的分发。
 *
 * 步骤 op：wait / move / look / turn(toward) / place / break / dig / use / useitem /
 *          attack / equip / give / toss / say / jump / swim
 */
export async function runStep (self, s) {
  const op = String(s.op ?? '')
  switch (op) {
    case 'wait': {
      const rawSec = s.sec != null ? Number(s.sec) : (s.ms != null ? Number(s.ms) / 1000 : 1)
      const sec = Number.isFinite(rawSec) ? rawSec : 1
      const requestedMs = Math.min(Math.max(sec * 1000, 0), 30_000)
      const ms = Math.min(requestedMs, Math.max(0, self.msLeft()))
      /* 🔴 2026-10-08 第四份审计报告 ③⑤：以前 `await sleep(ms)` ——
       *   ③ 完全不可中断（探针：60ms abort 后仍等满 2009ms）；
       *   ⑤ 被本轮预算截断时照样报 `ok:true, waitedMs:300`，汇总说"成功了"，模型以为等够了。 */
      await raceAbort(sleep(ms), self.abortSignal, '等待')
      const short = ms < requestedMs - 50
      return {
        waitedMs: ms,
        ...(short
          ? {
              ok: false, requestedMs,
              note: `只等了 ${(ms / 1000).toFixed(1)} 秒（想要 ${(requestedMs / 1000).toFixed(1)} 秒）—— 这一轮的时间不够，`
                + '再叫一次 mc_sequence 从这一步往后发，接着等',
            }
          : {}),
      }
    }
    case 'move': {
      const target = { x: Number(s.x), y: Number(s.y), z: Number(s.z) }
      const creative = self.bot?.game?.gameMode === 'creative'
      const mode = String(s.mode ?? (creative ? 'fly' : 'walk'))
      // 🔴 2026-10-08 审计⑤：fly 以前**不传 budgetMs** —— AI 写 `budgetMs:2000` 想飞一小段，
      //    实际跑满 callBudget 的 10 秒，把整串步骤的预算全吃掉。
      if (mode === 'fly') return { ...(await self.flyTo(target.x, target.y, target.z, { budget: callBudget(s.budgetMs) })), mode }
      // 用户 2026-10-20：走路**默认不挖方块**（和 mc_move 一致）—— 要挖得在步骤里写 `allowDig:true`
      // 2026-10-30 用户：「nodig 改成 allowdig 默认 false」—— 步骤字段改名 `allowDig`（旧 `noDig` 仍认）。
      /* 🔴 2026-10-24 用户实机：这里以前只传 budget、把挖不挖的开关漏了，**把 intent 丢了** ⇒
       *    步骤里写 `intent:"stand"` 也永远按 near（半径 1.6）判到达，差 1.5 格就算"到了"。 */
      return {
        ...(await self.walkTo(target, {
          budget: callBudget(s.budgetMs),
          allowDig: s.allowDig !== undefined ? s.allowDig === true : s.noDig === false,
          ...(s.intent ? { intent: s.intent } : {}),
        })),
        mode,
      }
    }
    case 'look':    return self.lookAt(s)
    // 'toward' 要与 mc_act{mode:"toward"} 语义一致：**看向并走近**（只 lookAt 是错的）
    case 'toward':  return self.interact({ mode: 'toward', who: s.who, approach: s.approach, budgetMs: s.budgetMs })
    case 'place':   return self.placeBlock(s)
    case 'break':   return self.breakBlock(s)
    case 'dig':     return { result: await self.dig(s) }
    case 'use':     return self.useBlock(s)
    case 'useitem': return self.useItem(s)
    case 'attack':  return self.attack(s)
    case 'equip':   return self.equip(s)
    case 'give':    return self.giveItem(s)
    case 'toss':    return self.tossItem(s)
    case 'say':     return { said: self.chatSay(s.text ?? '') }
    case 'jump':    return self.jump()
    /* 🔴 2026-10-28 参数审计：这一步以前直接 `self.walkTo(s)` —— 步骤里写的 `budgetMs`
     *    没有键能接住（`walkTo` 只认 `budget`），一路落到 `cfg.moveBudgetMs` 兜底值，
     *    把整串步骤的时间全吃掉。和上面 fly 那条是同一个坑。 */
    case 'swim':    return (s.x != null && s.y != null && s.z != null)
      ? self.walkTo(s, { budget: callBudget(s.budgetMs) })
      : self.swimUp(s)
    default:
      throw new Error(`未知步骤 op："${op}"（可用：wait/move/look/toward/place/break/dig/use/useitem/attack/equip/give/toss/say/jump/swim）`)
  }
}

/* 🔴 2026-10-29（用户给的输出规范，阶段 2）：一串步骤的结果以前没有 `text`，
 *    宿主只能把整个返回对象压成 JSON —— 10 步全成功也要 500+ 字符，而且每步都带
 *    `{"i":0,"op":"move","ok":true,"arrived":true,"remaining":null}` 这种壳。
 *    现在：成功的合成区间，失败的逐条（方块名/原因/下一步线索都在里面），hint 照旧。
 *    返回对象本身不动（套件和内部都还在读 `results`）。 */
function seqTextOf (r, results, steps) {
  const ok = results.filter((x) => x.ok).map((x) => x.i)
  const bad = results.filter((x) => !x.ok)
  const spans = []
  if (ok.length) {
    let a = ok[0]
    let prev = a
    for (const n of ok.slice(1)) {
      if (n === prev + 1) { prev = n; continue }
      spans.push(a === prev ? String(a + 1) : `${a + 1}–${prev + 1}`)
      a = n
      prev = n
    }
    spans.push(a === prev ? String(a + 1) : `${a + 1}–${prev + 1}`)
  }
  const lines = [
    `🧩 ${steps.length} 步：做成 ${r.succeeded} 步${spans.length ? `（第 ${spans.join('、')} 步）` : ''}`
      + (bad.length ? `，第 ${bad.map((x) => x.i + 1).join('、')} 步没做成` : '（全部做完）'),
  ]
  for (const x of bad) {
    /* move 步报失败时把 `arrived` / `remaining` 一并写出来 —— note 是通用文案，
     * 模型看不到真实数值就要再叫一次工具。 */
    const extra = (x.op === 'move' || x.op === 'swim')
      ? `（arrived=${x.arrived}${x.remaining != null ? `，剩余 ${x.remaining} 步` : ''}）`
      : ''
    lines.push(`✗ 第 ${x.i + 1} 步 ${x.op}${extra}：${String(x.note ?? x.error ?? '没说原因')}`)
  }
  if (r.danger?.text) lines.push(`⚠️ ${r.danger.text}`)
  for (const w of (r.warnings ?? [])) lines.push(String(w))
  if (r.noBudget) lines.push('⚠️ 这次调用自己没分到时间，一步都没做 —— 先复核现场，别当成没动过')
  if (r.hint) lines.push(r.hint)
  return lines.join('\n')
}

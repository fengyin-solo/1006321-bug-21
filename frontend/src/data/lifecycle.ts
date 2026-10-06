// 通风机组生命周期：一条单向链路，所有状态切换只能沿表内的边走。
//
//   待开机 ──提交开机──▶ 运行中 ──登记停机──▶ 已停机 ──提交开机──▶ 运行中
//                        │
//                        └──上报故障──▶ 故障停机 ──登记停机──▶ 已停机
//
// 从故障停机恢复必须先「登记停机」回到已停机，再「提交开机」重新开机；
// 中途改档（比如故障停机直接开机）一律打回，并写清卡在哪一段。
// 每一步落库的内容（状态、运行模式、停机原因、待办/异常标记）都写死在步定义里，
// 提交时一次落库，列表、详情、交接班与概览读到的才是同一份。

export type LifecycleStep = {
  action: string
  from: string
  to: string
  /** 落库的运行模式 */
  mode: string
  /** 落库的停机原因（空串表示清除） */
  reason: string
  pending: boolean
  abnormal: boolean
}

export const VENTILATION_STEPS: LifecycleStep[] = [
  { action: '提交开机', from: '待开机', to: '运行中', mode: '连续运行', reason: '', pending: false, abnormal: false },
  { action: '提交开机', from: '已停机', to: '运行中', mode: '连续运行', reason: '', pending: false, abnormal: false },
  { action: '登记停机', from: '运行中', to: '已停机', mode: '停机待机', reason: '正常停机', pending: false, abnormal: false },
  { action: '上报故障', from: '运行中', to: '故障停机', mode: '故障停运', reason: '机组故障', pending: true, abnormal: true },
  { action: '登记停机', from: '故障停机', to: '已停机', mode: '停机待机', reason: '故障处理完毕，停机待命', pending: false, abnormal: false },
]

/** 各状态对应的待办/异常标记，存量数据规范化也用它，保证概览与清单同源。 */
export const VENTILATION_STATE_FLAGS: Record<string, { pending: boolean; abnormal: boolean }> = {
  待开机: { pending: true, abnormal: false },
  运行中: { pending: false, abnormal: false },
  已停机: { pending: false, abnormal: false },
  故障停机: { pending: true, abnormal: true },
}

export type StepResolution =
  | { kind: 'apply'; step: LifecycleStep }
  /** 已在目标态：同一机组重复操作只生效一次，幂等吸收，不重复落库 */
  | { kind: 'noop'; message: string }
  /** 跳段：打回并写清卡在哪一段 */
  | { kind: 'blocked'; message: string }

export function resolveVentilationAction(action: string, current: string): StepResolution {
  const direct = VENTILATION_STEPS.find((step) => step.action === action && step.from === current)
  if (direct) {
    return { kind: 'apply', step: direct }
  }
  const knownAction = VENTILATION_STEPS.some((step) => step.action === action)
  if (!knownAction) {
    return { kind: 'blocked', message: `通风机组没有登记「${action}」这个动作` }
  }
  if (VENTILATION_STEPS.some((step) => step.action === action && step.to === current)) {
    return {
      kind: 'noop',
      message: `通风机组已处于「${current}」，「${action}」只生效一次，本次不重复落库`,
    }
  }
  const path = findPathToAction(current, action)
  if (path.length > 0) {
    const first = path[0]
    return {
      kind: 'blocked',
      message:
        `当前状态「${current}」不能执行「${action}」：需先「${first.action}」` +
        `（${first.from} → ${first.to}），卡在这一段；生命周期是单向链路，请按顺序恢复`,
    }
  }
  return { kind: 'blocked', message: `当前状态「${current}」没有通往「${action}」的链路` }
}

/** 从当前状态沿链路找一条能执行目标动作的路径，返回第一段（即卡住的那段）。 */
function findPathToAction(current: string, action: string): LifecycleStep[] {
  const queue: { state: string; path: LifecycleStep[] }[] = [{ state: current, path: [] }]
  const seen = new Set([current])
  while (queue.length > 0) {
    const { state, path } = queue.shift() as { state: string; path: LifecycleStep[] }
    if (path.length > 0 && VENTILATION_STEPS.some((step) => step.action === action && step.from === state)) {
      return path
    }
    for (const step of VENTILATION_STEPS.filter((item) => item.from === state)) {
      if (!seen.has(step.to)) {
        seen.add(step.to)
        queue.push({ state: step.to, path: [...path, step] })
      }
    }
  }
  return []
}

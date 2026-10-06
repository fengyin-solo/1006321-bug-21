import type {
  FanAction,
  FanEvent,
  FanRecord,
  FanState,
  FanStatus,
  TransitionInput,
  TransitionOutcome,
} from '@/data/types'

/**
 * 通风机组生命周期是一条单向链路：
 *
 *   待开机 ──提交开机──▶ 运行中 ──登记停机──▶ 已停机 ──提交开机──▶ 运行中 ……
 *                            │
 *                            └──上报故障──▶ 故障停机 ──故障恢复──▶ 已停机
 *
 * 故障停机只能先恢复成已停机，再重新提交开机；任何跨段跳转一律打回。
 * 中途申请改档（换运行模式）不允许在运行中直接落值：记下申请、待重新开机时按新档位提交。
 */

export const FAN_STATUSES: FanStatus[] = ['待开机', '运行中', '已停机', '故障停机']

/** 每条状态边允许走的动作；不在这里的（动作，当前态）组合全部打回。 */
const EDGES: Partial<Record<FanStatus, { action: FanAction; to: FanStatus }[]>> = {
  待开机: [{ action: '提交开机', to: '运行中' }],
  运行中: [
    { action: '登记停机', to: '已停机' },
    { action: '上报故障', to: '故障停机' },
  ],
  已停机: [{ action: '提交开机', to: '运行中' }],
  故障停机: [{ action: '故障恢复', to: '已停机' }],
}

export function initialFanState(): FanState {
  return { status: '待开机', mode: null, stopReason: null, lastAt: null, faultActive: false }
}

/** 由事件链推导当前态。事件链是唯一事实来源，任何页面不得自行另算。 */
export function deriveFanState(events: FanEvent[]): FanState {
  if (events.length === 0) {
    return initialFanState()
  }
  let state = initialFanState()
  for (const event of events) {
    state = applyEventToState(state, event)
  }
  return state
}

function applyEventToState(state: FanState, event: FanEvent): FanState {
  switch (event.to) {
    case '运行中':
      // 重新开机：携带新档位、清空上一轮停机原因、故障轮次结束
      return {
        status: '运行中',
        mode: event.mode,
        stopReason: null,
        lastAt: event.at,
        faultActive: false,
      }
    case '已停机':
      // 正常停机落停机原因；故障恢复回到已停机时原因保留（沿故障链）
      return {
        status: '已停机',
        mode: state.mode,
        stopReason: event.action === '登记停机' ? event.stopReason : state.stopReason,
        lastAt: event.at,
        faultActive: false,
      }
    case '故障停机':
      return {
        status: '故障停机',
        mode: state.mode,
        stopReason: event.stopReason ?? state.stopReason,
        lastAt: event.at,
        faultActive: true,
      }
    default:
      return { ...state, status: '待开机', lastAt: event.at }
  }
}

export function nextEventSeq(events: FanEvent[]): number {
  return events.reduce((max, event) => Math.max(max, event.seq), 0) + 1
}

/** 校验一次动作能否走通；打回时明确指出卡在哪一段、下一步该做什么。 */
export function validateTransition(
  current: FanState,
  action: FanAction,
  input: TransitionInput = {},
): TransitionOutcome {
  const edge = (EDGES[current.status] ?? []).find((item) => item.action === action)
  if (!edge) {
    const allowed = EDGES[current.status] ?? []
    return {
      ok: false,
      message:
        allowed.length > 0
          ? `当前卡在「${current.status}」段，只能先「${allowed[0].action}」，不能直接「${action}」`
          : `当前卡在「${current.status}」段，没有可执行的「${action}」`,
      blockedSegment: current.status,
      expectedAction: allowed[0]?.action,
    }
  }

  if (action === '提交开机') {
    const mode = (input.mode ?? '').toString().trim()
    if (!mode) {
      return {
        ok: false,
        message: '开机必须填写运行模式，状态、运行模式要一次落库，缺值不许拿默认值顶替',
        blockedSegment: current.status,
        expectedAction: '提交开机',
      }
    }
  }
  if (action === '登记停机' || action === '上报故障') {
    const reason = (input.stopReason ?? '').toString().trim()
    if (!reason) {
      const label = action === '上报故障' ? '故障现象/停机原因' : '停机原因'
      return {
        ok: false,
        message: `当前在「${current.status}」段，${label}必填，缺值不许拿默认值顶替`,
        blockedSegment: current.status,
        expectedAction: action,
      }
    }
  }
  return { ok: true, message: '' }
}

/** 产出下一条事件（纯函数，不写库）；同一机组同一轮启停只允许置一次故障。 */
export function buildEvent(
  record: Pick<FanRecord, 'events'>,
  action: FanAction,
  input: TransitionInput = {},
): TransitionOutcome {
  const current = deriveFanState(record.events)

  // 幂等：同一轮运行中已置过故障的，重复上报一律打回，不再追加故障事件
  if (action === '上报故障' && current.faultActive) {
    return {
      ok: false,
      message: '该机组本轮已置过故障，重复上报不再落故障，须先「故障恢复」回到已停机',
      blockedSegment: '故障停机',
      expectedAction: '故障恢复',
    }
  }

  const check = validateTransition(current, action, input)
  if (!check.ok) {
    return check
  }
  const edge = EDGES[current.status]!.find((item) => item.action === action)!

  let mode: string | null = current.mode
  let stopReason: string | null = current.stopReason
  if (action === '提交开机') {
    mode = input.mode?.toString().trim() || null
    stopReason = null
  } else if (action === '登记停机') {
    stopReason = input.stopReason?.toString().trim() || null
  } else if (action === '上报故障') {
    stopReason = input.stopReason?.toString().trim() || stopReason
  }

  const event: FanEvent = {
    seq: nextEventSeq(record.events),
    at: input.at ?? null,
    action,
    from: current.status,
    to: edge.to,
    mode,
    stopReason,
    operator: input.operator?.toString().trim() || null,
    note: input.note === undefined ? null : input.note,
  }
  return {
    ok: true,
    message: `已${action}，状态「${current.status}」→「${edge.to}」`,
    event,
  }
}

/* ------------------------------------------------------------------ */
/* 存量机组回填：只信启停时间与运行模式，没有故障记录就不补故障           */
/* ------------------------------------------------------------------ */

export type LegacyFanInput = {
  id: number
  机组编号: string
  所属舱室: string
  风机型号: string
  运行模式: string | null
  送风风速: string | null
  启停时间: string | null
  操作人员: string | null
  旧版状态: string
}

export type BackfilledFan = FanRecord & {
  /** 回填说明，写进留痕：新旧两版冲突时一律以新版事件链为准。 */
  backfillNote: string
}

function normalizeLegacyTime(value: unknown): string | null {
  const text = value === null || value === undefined ? '' : String(value).trim()
  if (!text) {
    return null
  }
  const parsed = new Date(text)
  if (Number.isNaN(parsed.getTime())) {
    return null
  }
  // 只有日期时按本地零点补全，不编造时分秒；无法解析就留空。
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? `${text}T00:00:00.000Z` : parsed.toISOString()
}

function cleanLegacyText(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null
  }
  const text = String(value).trim()
  return text ? text : null
}

/**
 * 存量回填裁决（理由同时写入 docs/完工清单-通风状态链路.md）：
 * - 只有启停时间 + 运行模式可信：按它们补 start/stop 事件；
 * - 早年没有故障记录的，绝不补故障停机；旧版若平推成了「故障停机」，
 *   判定冲突，以新版事件链为准，降级回已停机，旧值原样留痕；
 * - 缺停机原因、缺操作人员、时间不可解析的，一律留 null，不拿默认值顶。
 */
export function backfillLegacyFan(input: LegacyFanInput): BackfilledFan {
  const at = normalizeLegacyTime(input.启停时间)
  const mode = cleanLegacyText(input.运行模式)
  const events: FanEvent[] = []
  let note = ''

  if (input.旧版状态 === '运行中' || (input.旧版状态 === '待开机' && mode)) {
    events.push({
      seq: 1,
      at,
      action: '提交开机',
      from: '待开机',
      to: '运行中',
      mode,
      stopReason: null,
      operator: cleanLegacyText(input.操作人员),
      note: '按存量启停时间回填',
    })
  }

  if (input.旧版状态 === '已停机' || input.旧版状态 === '故障停机') {
    // 停机档：没有任何故障事件佐证，就按正常停机补，停机原因缺失留空
    events.push({
      seq: events.length + 1,
      at,
      action: '登记停机',
      from: '待开机',
      to: '已停机',
      mode,
      stopReason: null,
      operator: cleanLegacyText(input.操作人员),
      note:
        input.旧版状态 === '故障停机'
          ? '存量回填：无故障记录，旧版状态故障停机不予采信，降级为已停机'
          : '按存量启停时间回填',
    })
    if (input.旧版状态 === '故障停机') {
      note = '旧版平推为「故障停机」但查无故障记录，按新版事件链裁决降级为「已停机」；旧值仅作留痕'
    }
  }

  if (events.length === 0) {
    note = '存量机组无可用启停时间与运行模式，保持待开机，未编造任何事件'
  }

  return {
    id: input.id,
    机组编号: input.机组编号,
    所属舱室: input.所属舱室,
    风机型号: input.风机型号,
    送风风速: cleanLegacyText(input.送风风速),
    操作人员: cleanLegacyText(input.操作人员),
    events,
    legacyStatus: input.旧版状态,
    backfillNote: note,
  }
}

/* ------------------------------------------------------------------ */
/* 一致性核对：概览条数、列表条数、另存清单必须相等                      */
/* ------------------------------------------------------------------ */

export type ConsistencyDiff = {
  listCount: number
  savedCount: number
  consistent: boolean
}

export function checkCountConsistency(listCount: number, savedCount: number): ConsistencyDiff {
  return { listCount, savedCount, consistent: listCount === savedCount }
}

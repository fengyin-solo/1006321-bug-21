/** 纯前端数据层的公共类型：与全栈版后端返回的结构保持一致，换回后端时页面不用改。 */

export type EntryField = string | number | boolean | null

export type EntryRow = {
  id: number
  status: string
  pending: boolean
  abnormal: boolean
  [field: string]: EntryField
}

export type ModuleMeta = {
  key: string
  name: string
  entity: string
  desc: string
  fields: string[]
  statuses: string[]
  actions: string[]
  actionTargets: Record<string, string>
  metrics: string[]
}

export type PageResult = {
  items: EntryRow[]
  total: number
  page: number
  size: number
}

export type ActionResult = {
  ok: boolean
  message: string
}

export type OverviewResult = {
  cards: { label: string; value: number }[]
  modules: { name: string; created: number; pending: number; abnormal: number }[]
}

/* ------------------------------------------------------------------ */
/* 通风机组生命周期：状态、运行模式、停机原因三件套一次落库，事件链可追溯 */
/* ------------------------------------------------------------------ */

export type FanStatus = '待开机' | '运行中' | '已停机' | '故障停机'

export type FanAction = '提交开机' | '登记停机' | '上报故障' | '故障恢复'

/** 机组生命周期事件：不可变，只追加。当前状态一律由事件链末尾推导，不允许平推状态字段。 */
export type FanEvent = {
  seq: number
  /** ISO 时间；存量回填时若启停时间不可信则为 null，不许编造。 */
  at: string | null
  action: FanAction
  from: FanStatus
  to: FanStatus
  /** 该事件落库瞬间的运行模式快照（停机/故障/恢复事件沿用上一次开机的档位）。 */
  mode: string | null
  /** 该事件落库瞬间的停机原因；开机事件固定为 null（重新开机即清空上一轮原因）。 */
  stopReason: string | null
  operator: string | null
  note?: string | null
}

/** 机组档案：静态属性 + 事件链 + 旧版状态留痕。 */
export type FanRecord = {
  id: number
  机组编号: string
  所属舱室: string
  风机型号: string
  送风风速: string | null
  操作人员: string | null
  events: FanEvent[]
  /** 旧版平推状态字段的原文，仅作留痕，不参与任何统计与判定。 */
  legacyStatus?: string | null
}

/** 由事件链推导出的当前态：列表、详情、交接班、概览只能读这一份推导结果。 */
export type FanState = {
  status: FanStatus
  mode: string | null
  stopReason: string | null
  lastAt: string | null
  /** 当前这一轮启停里是否已置过故障（用于重复上报幂等判断）。 */
  faultActive: boolean
}

export type TransitionInput = {
  mode?: string | null
  stopReason?: string | null
  operator?: string | null
  at?: string | null
  note?: string | null
}

export type TransitionOutcome = {
  ok: boolean
  message: string
  /** 被卡在哪一段、下一步该走哪条边，打回时必填。 */
  blockedSegment?: FanStatus
  expectedAction?: FanAction
  event?: FanEvent
}

/* ------------------------------------------------------------------ */
/* 同步 outbox：断线后续传从「第一条未同步成功」的记录开始，载荷入队即冻结 */
/* ------------------------------------------------------------------ */

export type OutboxItem = {
  id: number
  fanId: number
  eventSeq: number
  action: FanAction
  /** 入队瞬间的冻结快照；同步时只发这份，绝不回读机组当前值顶替。 */
  payload: { status: FanStatus; mode: string | null; stopReason: string | null }
  at: string | null
  synced: boolean
  attempts: number
  lastError?: string | null
}

/* ------------------------------------------------------------------ */
/* 共享完工清单：验收结果只落这一份，来源入口与其他入口读的是同一条记录   */
/* ------------------------------------------------------------------ */

export type CompletionRecord = {
  id: number
  sourceKey: string
  sourceLabel: string
  sourceId: number
  code: string | null
  title: string | null
  completedAt: string | null
  acceptedAt: string | null
  operator: string | null
}

/** 老处置记录补录：字段缺失一律保留 null/空串，不用默认值顶替。 */
export type DisposalTrace = {
  处置编号: string | null
  渗漏点位: string | null
  渗漏程度: string | null
  处置方式: string | null
  处置班组: string | null
  发现日期: string | null
  完工日期: string | null
}

export type LocalDatabase = {
  version: 2
  migratedAt: string | null
  /** 通用模块（含通风模块的推导投影行）。 */
  rows: Record<string, EntryRow[]>
  fans: FanRecord[]
  outbox: OutboxItem[]
  completions: CompletionRecord[]
  disposalTraces: DisposalTrace[]
}

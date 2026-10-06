import type { CompletionRecord, DisposalTrace, EntryRow, OutboxItem } from '@/data/types'
import type { FanEvent, FanRecord, FanStatus } from '@/data/types'

/* ------------------------------------------------------------------ */
/* 完工清单：只有一个落点。来源模块验收时追加，其他入口只读这一份         */
/* ------------------------------------------------------------------ */

export type CompletionInput = {
  sourceKey: string
  sourceLabel: string
  sourceId: number
  code?: string | null
  title?: string | null
  completedAt?: string | null
  acceptedAt?: string | null
  operator?: string | null
}

/** 追加验收结果；同一来源记录重复验收只保留第一次（幂等，不覆盖、不取默认值）。 */
export function appendCompletion(
  list: CompletionRecord[],
  input: CompletionInput,
  id: number,
  acceptedAt: string,
): { list: CompletionRecord[]; added: boolean } {
  const existed = list.some(
    (item) => item.sourceKey === input.sourceKey && item.sourceId === input.sourceId,
  )
  if (existed) {
    return { list, added: false }
  }
  const record: CompletionRecord = {
    id,
    sourceKey: input.sourceKey,
    sourceLabel: input.sourceLabel,
    sourceId: input.sourceId,
    code: input.code ?? null,
    title: input.title ?? null,
    completedAt: input.completedAt ?? null,
    acceptedAt: input.acceptedAt ?? acceptedAt,
    operator: input.operator ?? null,
  }
  return { list: [...list, record], added: true }
}

/* ------------------------------------------------------------------ */
/* 老处置记录补录：按发现日期倒排；缺值留空，不用默认值顶                 */
/* ------------------------------------------------------------------ */

const TRACE_FIELDS: (keyof DisposalTrace)[] = [
  '处置编号',
  '渗漏点位',
  '渗漏程度',
  '处置方式',
  '处置班组',
  '发现日期',
  '完工日期',
]

function traceValue(row: EntryRow, field: keyof DisposalTrace): string | null {
  const value = row[field]
  if (value === null || value === undefined) {
    return null
  }
  const text = String(value).trim()
  return text ? text : null
}

/** 从渗漏水处置老数据补录：发现日期倒排（空日期排最后），所有缺值原样留 null。 */
export function backfillDisposalTraces(rows: EntryRow[]): DisposalTrace[] {
  const traces: DisposalTrace[] = rows.map((row) => {
    const trace = {} as DisposalTrace
    for (const field of TRACE_FIELDS) {
      trace[field] = traceValue(row, field)
    }
    return trace
  })
  return traces.sort((a, b) => {
    if (!a.发现日期 && !b.发现日期) {
      return 0
    }
    if (!a.发现日期) {
      return 1
    }
    if (!b.发现日期) {
      return -1
    }
    return a.发现日期 < b.发现日期 ? 1 : a.发现日期 > b.发现日期 ? -1 : 0
  })
}

/* ------------------------------------------------------------------ */
/* 同步 outbox：载荷入队即冻结；重传从第一条未同步成功的接着走            */
/* ------------------------------------------------------------------ */

export function enqueueOutbox(
  queue: OutboxItem[],
  record: FanRecord,
  event: FanEvent,
): OutboxItem[] {
  const status: FanStatus = event.to
  const item: OutboxItem = {
    id: queue.reduce((max, entry) => Math.max(max, entry.id), 0) + 1,
    fanId: record.id,
    eventSeq: event.seq,
    action: event.action,
    // 冻结快照：同步时只发这份，绝不回读机组当前值顶替
    payload: { status, mode: event.mode, stopReason: event.stopReason },
    at: event.at,
    synced: false,
    attempts: 0,
    lastError: null,
  }
  return [...queue, item]
}

/**
 * 模拟一次同步：只从第一条未同步成功的记录开始尝试；
 * 该条失败立即中断，后面的一律不碰（断线不跳过、不用上一次的值顶）。
 */
export function flushOutbox(
  queue: OutboxItem[],
  options: { online: boolean; failFanIds?: number[]; syncedAt: string },
): { queue: OutboxItem[]; synced: number; failed: OutboxItem | null } {
  if (!options.online) {
    return { queue, synced: 0, failed: null }
  }
  const firstPending = queue.find((item) => !item.synced)
  if (!firstPending) {
    return { queue, synced: 0, failed: null }
  }

  const index = queue.indexOf(firstPending)
  const shouldFail = (options.failFanIds ?? []).includes(firstPending.fanId)
  if (shouldFail) {
    const next = [...queue]
    next[index] = {
      ...firstPending,
      attempts: firstPending.attempts + 1,
      lastError: `同步失败（${options.syncedAt}）：机组 ${firstPending.fanId} 暂不可达`,
    }
    return { queue: next, synced: 0, failed: next[index] }
  }

  const next = [...queue]
  next[index] = {
    ...firstPending,
    synced: true,
    attempts: firstPending.attempts + 1,
    lastError: null,
  }
  // 首条成功后继续顺序放行后续记录（同样是从头逐条，不跳过任何一条）
  let synced = 1
  let cursor = index + 1
  while (cursor < next.length && !next[cursor].synced) {
    const current = next[cursor]
    if ((options.failFanIds ?? []).includes(current.fanId)) {
      next[cursor] = {
        ...current,
        attempts: current.attempts + 1,
        lastError: `同步失败（${options.syncedAt}）：机组 ${current.fanId} 暂不可达`,
      }
      return { queue: next, synced, failed: next[cursor] }
    }
    next[cursor] = { ...current, synced: true, attempts: current.attempts + 1, lastError: null }
    synced += 1
    cursor += 1
  }
  return { queue: next, synced, failed: null }
}

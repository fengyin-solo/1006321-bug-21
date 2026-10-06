import { appendCompletion, enqueueOutbox, flushOutbox } from '@/domain/records'
import { buildEvent, deriveFanState, initialFanState } from '@/domain/fan-lifecycle'
import { MODULE_BY_KEY } from '@/data/modules'
import {
  commitDatabase,
  fanProjectionRow,
  listFans,
  listOutbox,
  listRows,
  loadDatabase,
  resetRows,
} from '@/data/local-store'
import type {
  ActionResult,
  CompletionRecord,
  DisposalTrace,
  EntryRow,
  FanAction,
  FanRecord,
  FanState,
  FanStatus,
  ModuleMeta,
  OutboxItem,
  OverviewResult,
  PageResult,
} from '@/data/types'

// 会写进数据的「往回走」动作：命中就把这条记录标成异常态，看板上能一眼看出来。
const NEGATIVE_ACTIONS = ['撤销', '作废', '拒绝', '驳回', '停用', '忽略', '下线', '回滚']

// 走到这些目标态的通用动作，视同验收通过：结果统一落进共享完工清单。
const ACCEPT_TARGETS: Record<string, { key: string; label: string; codeField: string }> = {
  leak: { key: 'leak', label: '渗漏水处置单', codeField: '处置编号' },
  maintenance: { key: 'maintenance', label: '检修记录', codeField: '检修编号' },
  hazard: { key: 'hazard', label: '隐患记录', codeField: '隐患编号' },
}

export function moduleMeta(key: string): ModuleMeta {
  const meta = MODULE_BY_KEY.get(key)
  if (!meta) {
    throw new Error(`没有登记名为 ${key} 的业务模块`)
  }
  return meta
}

export function filterRows(rows: EntryRow[], filters: Record<string, string>): EntryRow[] {
  const pairs = Object.entries(filters).filter(([, value]) => value.trim() !== '')
  if (pairs.length === 0) {
    return rows
  }
  return rows.filter((row) =>
    pairs.every(([field, value]) => String(row[field] ?? '').includes(value.trim())),
  )
}

export function listEntries(key: string, filters: Record<string, string> = {}): PageResult {
  const matched = filterRows(listRows(key), filters)
  return { items: matched, total: matched.length, page: 1, size: matched.length }
}

/** 通用模块动作：事务落库；验收类动作同时把结果写进唯一的共享完工清单。 */
export function runAction(key: string, id: number, action: string): ActionResult {
  const meta = moduleMeta(key)
  const target = meta.actionTargets[action]
  if (!target) {
    return { ok: false, message: `${meta.entity}没有登记「${action}」这个动作` }
  }

  const db = loadDatabase()
  const rows = db.rows[key] ?? []
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` }
  }
  const current = String(rows[index].status)
  if (current === target) {
    return { ok: false, message: `${meta.entity}已经是「${target}」，不用重复操作` }
  }

  const updated: EntryRow = {
    ...rows[index],
    status: target,
    pending: target !== meta.statuses[meta.statuses.length - 1],
    abnormal: NEGATIVE_ACTIONS.some((verb) => action.startsWith(verb)),
  }

  let completions = db.completions
  let completionNote = ''
  const accept = ACCEPT_TARGETS[key]
  if (accept && (target === '已完工' || target === '已验收')) {
    const result = appendCompletion(
      completions,
      {
        sourceKey: accept.key,
        sourceLabel: accept.label,
        sourceId: id,
        code: updated[accept.codeField] === undefined ? null : String(updated[accept.codeField]),
        title: null,
        completedAt: updated['完工日期'] === undefined ? null : String(updated['完工日期']),
        acceptedAt: new Date().toISOString(),
        operator: null,
      },
      completions.reduce((max, item) => Math.max(max, item.id), 0) + 1,
      new Date().toISOString(),
    )
    completions = result.list
    completionNote = result.added ? '，验收结果已落入共享完工清单' : '，完工清单已有该记录，不重复登记'
  }

  const nextRows = [...rows]
  nextRows[index] = updated
  commitDatabase((current) => ({
    ...current,
    rows: { ...current.rows, [key]: nextRows },
    completions,
  }))
  return { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」${completionNote}` }
}

export function resetModule(key: string): PageResult {
  resetRows(key)
  return listEntries(key)
}

/* ------------------------------------------------------------------ */
/* 通风机组：详情、动作、统计全部围绕事件链，任何页面只读到同一份推导值   */
/* ------------------------------------------------------------------ */

export const FAN_RUN_MODES = ['低速送风', '高速排风', '事故排烟', '自然通风']

export type FanActionPayload = {
  mode?: string | null
  stopReason?: string | null
  operator?: string | null
  note?: string | null
}

export function getFan(id: number): { record: FanRecord; state: FanState } | null {
  const record = listFans().find((item) => Number(item.id) === id)
  if (!record) {
    return null
  }
  return { record, state: deriveFanState(record.events) }
}

export function fanTimeline(fan: FanRecord) {
  return fan.events.map((event) => ({ ...event }))
}

export type FanCounters = Record<FanStatus, number> & { total: number; pendingSync: number }

/** 页脚、图例、交接班核对、概览都走这一个函数，从同一批机组事件链计数。 */
export function fanCounters(): FanCounters {
  const db = loadDatabase()
  const counters: FanCounters = {
    待开机: 0,
    运行中: 0,
    已停机: 0,
    故障停机: 0,
    total: db.fans.length,
    pendingSync: db.outbox.filter((item) => !item.synced).length,
  }
  for (const fan of db.fans) {
    counters[deriveFanState(fan.events).status] += 1
  }
  return counters
}

/**
 * 通风动作唯一入口：状态、运行模式、停机原因、事件、同步快照一次落库。
 * 跳着切换在 buildEvent 阶段就被打回，并指明卡在哪一段。
 */
export function submitFanAction(
  id: number,
  action: FanAction,
  payload: FanActionPayload = {},
  at: string = new Date().toISOString(),
): ActionResult {
  const db = loadDatabase()
  const index = db.fans.findIndex((item) => Number(item.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的通风机组` }
  }
  const fan = db.fans[index]
  const outcome = buildEvent(fan, action, {
    mode: payload.mode ?? null,
    stopReason: payload.stopReason ?? null,
    operator: payload.operator ?? null,
    note: payload.note ?? null,
    at,
  })
  if (!outcome.ok || !outcome.event) {
    return { ok: false, message: outcome.message }
  }
  const event = outcome.event

  commitDatabase((current) => {
    const fans = current.fans.map((item) =>
      item.id === id ? { ...item, events: [...item.events, event] } : item,
    )
    const updatedFan = fans[index]
    return {
      ...current,
      fans,
      outbox: enqueueOutbox(current.outbox, updatedFan, event),
    }
  })
  return { ok: true, message: `${outcome.message}，已进入待同步队列` }
}

/* ------------------------------------------------------------------ */
/* 同步：断线后只从第一条没同步成功的记录接着走，载荷用入队冻结快照        */
/* ------------------------------------------------------------------ */

export function pendingOutbox(): OutboxItem[] {
  return listOutbox().filter((item) => !item.synced)
}

export function flushFanSync(options: { online: boolean; failFanIds?: number[] }): {
  synced: number
  failed: OutboxItem | null
  pendingLeft: number
} {
  const db = loadDatabase()
  const result = flushOutbox(db.outbox, {
    online: options.online,
    failFanIds: options.failFanIds,
    syncedAt: new Date().toISOString(),
  })
  commitDatabase((current) => ({ ...current, outbox: result.queue }))
  return {
    synced: result.synced,
    failed: result.failed,
    pendingLeft: result.queue.filter((item) => !item.synced).length,
  }
}

/* ------------------------------------------------------------------ */
/* 共享完工清单 / 老处置补录：其他入口只读，不另存副本                    */
/* ------------------------------------------------------------------ */

export function listCompletions(): CompletionRecord[] {
  return loadDatabase().completions
}

export function listDisposalTraces(): DisposalTrace[] {
  return loadDatabase().disposalTraces
}

/* ------------------------------------------------------------------ */
/* 导出：清单与页面读同一份数据                                          */
/* ------------------------------------------------------------------ */

function toCsvCell(value: unknown): string {
  if (value === null || value === undefined) {
    return ''
  }
  const text = String(value)
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

export function exportEntries(key: string): { filename: string; content: string } {
  const meta = moduleMeta(key)
  const header = ['编号', ...meta.fields, '当前状态']
  const lines = [header.map(toCsvCell).join(',')]
  for (const row of listRows(key)) {
    lines.push(
      [row.id, ...meta.fields.map((field) => row[field] ?? ''), row.status].map(toCsvCell).join(','),
    )
  }
  return { filename: `${meta.name}-清单.csv`, content: `﻿${lines.join('\n')}` }
}

const COMPLETION_HEADER = ['来源模块', '来源编号', '业务单号', '完工日期', '验收时间', '验收人员']

export function exportCompletions(): { filename: string; content: string } {
  const lines = [COMPLETION_HEADER.join(',')]
  for (const item of listCompletions()) {
    lines.push(
      [
        item.sourceLabel,
        item.sourceId,
        item.code ?? '',
        item.completedAt ?? '',
        item.acceptedAt ?? '',
        item.operator ?? '',
      ]
        .map(toCsvCell)
        .join(','),
    )
  }
  return { filename: '验收完工清单.csv', content: `﻿${lines.join('\n')}` }
}

export function downloadText(filename: string, content: string): void {
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

export function downloadEntries(key: string): void {
  const { filename, content } = exportEntries(key)
  downloadText(filename, content)
}

export function downloadCompletions(): void {
  const { filename, content } = exportCompletions()
  downloadText(filename, content)
}

/* ------------------------------------------------------------------ */
/* 概览：条数直接来自同一份库；通风异常量来自事件链投影                    */
/* ------------------------------------------------------------------ */

export function loadOverview(): OverviewResult {
  const db = loadDatabase()
  const modules = [...MODULE_BY_KEY.values()].map((meta) => {
    const entries = db.rows[meta.key] ?? []
    return {
      name: meta.name,
      created: entries.length,
      pending: entries.filter((row) => row.pending).length,
      abnormal: entries.filter((row) => row.abnormal).length,
    }
  })
  const cards = [
    { label: '业务模块', value: modules.length },
    { label: '登记总量', value: modules.reduce((sum, item) => sum + item.created, 0) },
    { label: '待处理', value: modules.reduce((sum, item) => sum + item.pending, 0) },
    { label: '异常量', value: modules.reduce((sum, item) => sum + item.abnormal, 0) },
    { label: '验收完工数', value: db.completions.length },
  ]
  return { cards, modules }
}

// 供详情面板直接复用投影字段，避免两处各算一遍
export { fanProjectionRow, initialFanState }

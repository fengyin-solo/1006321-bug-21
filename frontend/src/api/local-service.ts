import { closeFault, listFaultRecords, reportFault } from '@/data/fault-log'
import { resolveVentilationAction } from '@/data/lifecycle'
import { MODULE_BY_KEY } from '@/data/modules'
import { allRows, listRows, resetRows, saveRows } from '@/data/local-store'
import type { ActionResult, EntryRow, FaultRecord, ModuleMeta, OverviewResult, PageResult } from '@/data/types'

// 会写进数据的「往回走」动作：命中就把这条记录标成异常态，看板上能一眼看出来。
const NEGATIVE_ACTIONS = ['撤销', '作废', '拒绝', '驳回', '停用', '忽略', '下线', '回滚']

const VENTILATION_KEY = 'ventilation'

function formatNow(): string {
  const now = new Date()
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`
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

export function runAction(key: string, id: number, action: string): ActionResult {
  const meta = moduleMeta(key)
  const target = meta.actionTargets[action]
  if (!target) {
    return { ok: false, message: `${meta.entity}没有登记「${action}」这个动作` }
  }
  const rows = listRows(key)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` }
  }
  if (key === VENTILATION_KEY) {
    return runVentilationAction(key, rows, index, action)
  }
  const current = String(rows[index].status)
  if (current === target) {
    return { ok: false, message: `${meta.entity}已经是「${target}」，不用重复操作` }
  }
  const lastStatus = meta.statuses[meta.statuses.length - 1]
  const updated: EntryRow = {
    ...rows[index],
    status: target,
    pending: target !== lastStatus,
    abnormal: NEGATIVE_ACTIONS.some((verb) => action.startsWith(verb)),
  }
  const next = [...rows]
  next[index] = updated
  saveRows(key, next)
  return { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」` }
}

/**
 * 通风机组动作：先过生命周期状态机，跳段一律打回并写清卡在哪一段；
 * 通过后状态、运行模式、停机原因、启停时间与故障记录在一次提交里落库，
 * 列表、详情、交接班与概览读到的才是同一份。
 */
function runVentilationAction(key: string, rows: EntryRow[], index: number, action: string): ActionResult {
  const row = rows[index]
  const resolution = resolveVentilationAction(action, String(row.status))
  if (resolution.kind === 'blocked') {
    return { ok: false, message: resolution.message }
  }
  if (resolution.kind === 'noop') {
    return { ok: true, message: resolution.message }
  }
  const { step } = resolution
  const now = formatNow()
  const updated: EntryRow = {
    ...row,
    status: step.to,
    pending: step.pending,
    abnormal: step.abnormal,
    运行模式: step.mode,
    停机原因: step.reason,
    启停时间: now,
  }
  const next = [...rows]
  next[index] = updated
  saveRows(key, next)
  // 故障记录与状态同一次提交落库：上报故障开单，故障停机转回已停机即验收完工。
  // 同一机组重复上报只置一次故障（reportFault 内部幂等，状态机也把重复动作拦成 noop）。
  if (action === '上报故障') {
    reportFault({
      entryId: Number(row.id),
      unitCode: String(row['机组编号'] ?? ''),
      foundDate: now,
      reason: step.reason,
      operator: String(row['操作人员'] ?? ''),
      source: '页面操作',
    })
  }
  if (step.from === '故障停机' && step.to === '已停机') {
    closeFault(Number(row.id), now)
  }
  return { ok: true, message: `通风机组已${action}：${step.from} → ${step.to}，状态、运行模式与停机原因已一次落库` }
}

export function getEntry(key: string, id: number): EntryRow | null {
  return listRows(key).find((row) => Number(row.id) === id) ?? null
}

/** 按模块状态顺序统计台数：通风页统计卡、交接班快照都从这里取，保证两边一致。 */
export function statusCounts(key: string): { status: string; count: number }[] {
  const meta = moduleMeta(key)
  const rows = listRows(key)
  return meta.statuses.map((status) => ({
    status,
    count: rows.filter((row) => String(row.status) === status).length,
  }))
}

/** 故障处置/完工清单：通风页与交接班页读同一份。 */
export function listFaults(entryId?: number): FaultRecord[] {
  return listFaultRecords(entryId)
}

export function resetModule(key: string): PageResult {
  resetRows(key)
  return listEntries(key)
}

export function exportEntries(key: string): { filename: string; content: string } {
  const meta = moduleMeta(key)
  const header = ['编号', ...meta.fields, '当前状态']
  const lines = [header.join(',')]
  for (const row of listRows(key)) {
    lines.push([row.id, ...meta.fields.map((field) => row[field] ?? ''), row.status].join(','))
  }
  return { filename: `${meta.name}-清单.csv`, content: `\uFEFF${lines.join('\n')}` }
}

export function downloadEntries(key: string): void {
  const { filename, content } = exportEntries(key)
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

export function loadOverview(): OverviewResult {
  const rows = allRows()
  const modules = [...MODULE_BY_KEY.values()].map((meta) => {
    const entries = rows[meta.key] ?? []
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
  ]
  return { cards, modules }
}

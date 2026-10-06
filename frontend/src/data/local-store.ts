import { hasFaultRecord, reportFault } from './fault-log'
import { VENTILATION_STATE_FLAGS } from './lifecycle'
import { SEED_ROWS } from './seed'
import type { EntryRow } from './types'

// 本地持久化：数据放在 localStorage 里，刷新、关掉再打开都还在。
const STORAGE_KEY = 'urban-utility-tunnel:entries'

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function readStorage(): Record<string, EntryRow[]> {
  const fallback = clone(SEED_ROWS)
  if (typeof window === 'undefined' || !window.localStorage) {
    migrateVentilation(fallback)
    return fallback
  }
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    migrateVentilation(fallback)
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    return fallback
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, EntryRow[]>
    const merged = { ...fallback, ...parsed }
    migrateVentilation(merged)
    return merged
  } catch {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    return fallback
  }
}

/**
 * 存量通风机组回填，逐条处理、逐条落库：
 * - 待办/异常标记按生命周期状态规范化，保证概览与清单读到同一份；
 * - 「故障停机」却没有故障记录的机组，按本行启停时间回填一条处置记录（来源=存量回填），
 *   停机原因、操作人员缺了就空着，缺值不拿默认值顶；
 * - 早年只有运行模式、没有故障记录的机组（非故障停机）：不补记录，只规范化标记位，
 *   凭空补一条等于伪造处置历史（裁决见 docs/ventilation-lifecycle.md）。
 *
 * 游标就是故障清单本身：某台机组有没有回填过，查清单就知道。同步断线后下次
 * 从没补上记录的那一台接着走，每台只用自己的启停时间，不拿上一台的值顶。
 */
function migrateVentilation(store: Record<string, EntryRow[]>): void {
  const rows = store['ventilation']
  if (!rows) {
    return
  }
  let dirty = false
  for (const row of rows) {
    const flags = VENTILATION_STATE_FLAGS[String(row.status)]
    if (flags && (row.pending !== flags.pending || row.abnormal !== flags.abnormal)) {
      row.pending = flags.pending
      row.abnormal = flags.abnormal
      dirty = true
    }
    if (row.status === '故障停机' && !hasFaultRecord(Number(row.id))) {
      reportFault({
        entryId: Number(row.id),
        unitCode: String(row['机组编号'] ?? ''),
        foundDate: String(row['启停时间'] ?? ''),
        reason: String(row['停机原因'] ?? ''),
        operator: String(row['操作人员'] ?? ''),
        source: '存量回填',
      })
    }
  }
  if (dirty && typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(store))
  }
}

let cache: Record<string, EntryRow[]> | null = null

export function allRows(): Record<string, EntryRow[]> {
  if (cache === null) {
    cache = readStorage()
  }
  return cache
}

export function listRows(key: string): EntryRow[] {
  return allRows()[key] ?? []
}

export function saveRows(key: string, rows: EntryRow[]): void {
  const next = { ...allRows(), [key]: rows }
  cache = next
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  }
}

export function resetRows(key: string): EntryRow[] {
  const rows = clone(SEED_ROWS[key] ?? [])
  saveRows(key, rows)
  return rows
}

export function storageKey(): string {
  return STORAGE_KEY
}

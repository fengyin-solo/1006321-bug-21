import { backfillDisposalTraces } from '@/domain/records'
import { backfillLegacyFan, deriveFanState } from '@/domain/fan-lifecycle'
import { SEED_FANS } from './fan-seed'
import { SEED_ROWS } from './seed'
import type {
  EntryRow,
  FanRecord,
  FanState,
  FanStatus,
  LocalDatabase,
  OutboxItem,
  CompletionRecord,
} from './types'

// v1：旧版纯扁平行存储（urban-utility-tunnel:entries），迁移后原样保留只作留痕。
const LEGACY_STORAGE_KEY = 'urban-utility-tunnel:entries'
// v2：机组事件链 + outbox + 共享完工清单的唯一落点。
const STORAGE_KEY = 'urban-utility-tunnel:db:v2'
export const DB_VERSION = 2

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

/** 通风模块投影行：列表/详情/交接班/概览读到的状态全部来自事件链推导，保证同一份。 */
export function fanProjectionRow(record: FanRecord): EntryRow {
  const state: FanState = deriveFanState(record.events)
  const lastEvent = record.events[record.events.length - 1] ?? null
  return {
    id: record.id,
    status: state.status,
    // 只有「待处理中间态」在通风里体现为运行中：已停机/故障停机都不算待处理
    pending: state.status === '运行中',
    abnormal: state.status === '故障停机',
    机组编号: record.机组编号,
    所属舱室: record.所属舱室,
    风机型号: record.风机型号,
    运行模式: state.mode,
    送风风速: record.送风风速,
    启停时间: state.lastAt,
    操作人员: lastEvent?.operator ?? record.操作人员,
    停机原因: state.stopReason,
    风机状态: state.status,
  }
}

export function ventilationRows(fans: FanRecord[]): EntryRow[] {
  return fans.map(fanProjectionRow)
}

/* ------------------------------------------------------------------ */
/* 迁移：v1 扁平行 → v2 事件链。新旧两版冲突时以新版事件链为准，旧值留痕  */
/* ------------------------------------------------------------------ */

export function migrateLegacyRows(
  legacy: Record<string, EntryRow[]>,
  migratedAt: string | null,
): LocalDatabase {
  const rows: Record<string, EntryRow[]> = {}
  for (const [key, list] of Object.entries(legacy)) {
    if (key === 'ventilation') {
      continue // 通风模块改由事件链投影，旧扁平行不直接搬运
    }
    rows[key] = clone(list)
  }

  // 存量通风机组：按启停时间 + 运行模式回填；无故障记录不补故障，缺值不顶默认
  const fans: FanRecord[] = (legacy.ventilation ?? []).map((row) => {
    const backfilled = backfillLegacyFan({
      id: Number(row.id),
      机组编号: String(row['机组编号'] ?? ''),
      所属舱室: String(row['所属舱室'] ?? ''),
      风机型号: String(row['风机型号'] ?? ''),
      运行模式: row['运行模式'] === null || row['运行模式'] === undefined ? null : String(row['运行模式']),
      送风风速: row['送风风速'] === null || row['送风风速'] === undefined ? null : String(row['送风风速']),
      启停时间: row['启停时间'] === null || row['启停时间'] === undefined ? null : String(row['启停时间']),
      操作人员: row['操作人员'] === null || row['操作人员'] === undefined ? null : String(row['操作人员']),
      旧版状态: String(row.status ?? ''),
    })
    return {
      id: backfilled.id,
      机组编号: backfilled.机组编号,
      所属舱室: backfilled.所属舱室,
      风机型号: backfilled.风机型号,
      送风风速: backfilled.送风风速,
      操作人员: backfilled.操作人员,
      events: backfilled.events,
      legacyStatus: backfilled.legacyStatus ?? null,
    }
  })

  // 老处置记录：按发现日期倒排补录，缺值保留 null
  const disposalTraces = backfillDisposalTraces(legacy.leak ?? [])

  const db: LocalDatabase = {
    version: DB_VERSION,
    migratedAt,
    rows,
    fans,
    outbox: [],
    completions: seedCompletions(rows),
    disposalTraces,
  }
  rows.ventilation = ventilationRows(db.fans)
  return db
}

/** 已经走到「已完工/已验收」终态的存量记录，一次性补进共享完工清单（缺值留空）。 */
function seedCompletions(rows: Record<string, EntryRow[]>): CompletionRecord[] {
  const accepted: { key: string; label: string; codeField: string; rows: EntryRow[] }[] = [
    { key: 'leak', label: '渗漏水处置单', codeField: '处置编号', rows: rows.leak ?? [] },
    { key: 'maintenance', label: '检修记录', codeField: '检修编号', rows: rows.maintenance ?? [] },
    { key: 'hazard', label: '隐患记录', codeField: '隐患编号', rows: rows.hazard ?? [] },
  ]
  const list: CompletionRecord[] = []
  let id = 0
  for (const group of accepted) {
    for (const row of group.rows) {
      if (row.status !== '已完工' && row.status !== '已验收') {
        continue
      }
      id += 1
      list.push({
        id,
        sourceKey: group.key,
        sourceLabel: group.label,
        sourceId: Number(row.id),
        code: row[group.codeField] === undefined ? null : String(row[group.codeField]),
        title: null,
        completedAt: row['完工日期'] === undefined ? null : String(row['完工日期']),
        acceptedAt: null,
        operator: null,
      })
    }
  }
  return list
}

/** 全新库：通用模块播种示例数据，通风模块播种事件链机组。 */
export function freshDatabase(migratedAt: string | null = null): LocalDatabase {
  const rows: Record<string, EntryRow[]> = {}
  for (const [key, list] of Object.entries(SEED_ROWS)) {
    if (key === 'ventilation') {
      continue
    }
    rows[key] = clone(list)
  }
  const fans = clone(SEED_FANS)
  const db: LocalDatabase = {
    version: DB_VERSION,
    migratedAt,
    rows,
    fans,
    outbox: [],
    completions: seedCompletions(rows),
    disposalTraces: backfillDisposalTraces(SEED_ROWS.leak ?? []),
  }
  rows.ventilation = ventilationRows(db.fans)
  return db
}

function readLegacy(): Record<string, EntryRow[]> | null {
  if (typeof window === 'undefined' || !window.localStorage) {
    return null
  }
  const raw = window.localStorage.getItem(LEGACY_STORAGE_KEY)
  if (!raw) {
    return null
  }
  try {
    return JSON.parse(raw) as Record<string, EntryRow[]>
  } catch {
    return null
  }
}

let cache: LocalDatabase | null = null

export function loadDatabase(): LocalDatabase {
  if (cache !== null) {
    return cache
  }
  if (typeof window === 'undefined' || !window.localStorage) {
    cache = freshDatabase(null)
    return cache
  }
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (raw) {
    try {
      cache = JSON.parse(raw) as LocalDatabase
      return cache
    } catch {
      // v2 数据损坏时落到迁移/播种分支，不拿半成品顶替
    }
  }

  const legacy = readLegacy()
  cache = legacy
    ? migrateLegacyRows(legacy, new Date().toISOString())
    : freshDatabase(null)
  persist(cache)
  return cache
}

export function persist(db: LocalDatabase): void {
  cache = db
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(db))
  }
}

/**
 * 事务式落库：一次回调里改完状态、运行模式、停机原因、事件链与 outbox，
 * 要么整体生效、要么整体不生效，杜绝列表与详情读到两版中间值。
 */
export function commitDatabase(mutate: (db: LocalDatabase) => LocalDatabase): LocalDatabase {
  const next = mutate(loadDatabase())
  // 通风投影始终随事件链刷新后再写
  next.rows.ventilation = ventilationRows(next.fans)
  persist(next)
  return next
}

export function allRows(): Record<string, EntryRow[]> {
  return loadDatabase().rows
}

export function listRows(key: string): EntryRow[] {
  return loadDatabase().rows[key] ?? []
}

export function listFans(): FanRecord[] {
  return loadDatabase().fans
}

export function listOutbox(): OutboxItem[] {
  return loadDatabase().outbox
}

export function resetRows(key: string): EntryRow[] {
  const db = loadDatabase()
  if (key === 'ventilation') {
    const fans = clone(SEED_FANS)
    commitDatabase((current) => ({
      ...current,
      fans,
      // 通风重置只重置机组与其事件链；同步队列也一并回到初始空队列
      outbox: [],
      rows: { ...current.rows, ventilation: ventilationRows(fans) },
    }))
    return listRows(key)
  }
  const rows = clone(SEED_ROWS[key] ?? [])
  commitDatabase((current) => ({ ...current, rows: { ...current.rows, [key]: rows } }))
  return rows
}

export function storageKey(): string {
  return STORAGE_KEY
}

export function legacyStorageKey(): string {
  return LEGACY_STORAGE_KEY
}

export type { FanStatus }

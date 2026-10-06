import type { FaultRecord } from './types'

// 故障处置记录独立持久化：上报故障开单，故障停机转回已停机时验收完工。
// 通风页看到的是处置清单，交接班页看到的是同一份完工清单，两边同源。
const FAULT_LOG_KEY = 'urban-utility-tunnel:fault-log'

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function readStorage(): FaultRecord[] {
  if (typeof window === 'undefined' || !window.localStorage) {
    return []
  }
  const raw = window.localStorage.getItem(FAULT_LOG_KEY)
  if (!raw) {
    return []
  }
  try {
    const parsed = JSON.parse(raw) as FaultRecord[]
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

let cache: FaultRecord[] | null = null

function allRecords(): FaultRecord[] {
  if (cache === null) {
    cache = readStorage()
  }
  return cache
}

function persist(records: FaultRecord[]): void {
  cache = records
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(FAULT_LOG_KEY, JSON.stringify(records))
  }
}

/** 处置记录按发现日期倒排；缺发现日期的一律排最后，缺值不拿默认值顶。 */
export function listFaultRecords(entryId?: number): FaultRecord[] {
  const records = allRecords().filter((item) => entryId === undefined || item.entryId === entryId)
  return [...records].sort((a, b) => {
    if (a.foundDate === '' && b.foundDate === '') {
      return b.id - a.id
    }
    if (a.foundDate === '') {
      return 1
    }
    if (b.foundDate === '') {
      return -1
    }
    if (a.foundDate !== b.foundDate) {
      return a.foundDate < b.foundDate ? 1 : -1
    }
    return b.id - a.id
  })
}

export function hasFaultRecord(entryId: number): boolean {
  return allRecords().some((item) => item.entryId === entryId)
}

function openRecordFor(entryId: number): FaultRecord | null {
  return allRecords().find((item) => item.entryId === entryId && item.status === '处置中') ?? null
}

export type FaultReport = {
  entryId: number
  unitCode: string
  foundDate: string
  reason: string
  operator: string
  source: string
}

/**
 * 开一张故障单。同一机组已有「处置中」的单子就直接返回原单：
 * 重复上报只置一次故障，不重复落库。
 */
export function reportFault(report: FaultReport): { record: FaultRecord; created: boolean } {
  const existing = openRecordFor(report.entryId)
  if (existing) {
    return { record: existing, created: false }
  }
  const records = allRecords()
  const record: FaultRecord = {
    id: records.reduce((max, item) => Math.max(max, item.id), 0) + 1,
    entryId: report.entryId,
    unitCode: report.unitCode,
    foundDate: report.foundDate,
    reason: report.reason,
    operator: report.operator,
    source: report.source,
    status: '处置中',
    finishedDate: '',
  }
  persist([...records, record])
  return { record, created: true }
}

/** 验收完工：故障停机转回已停机时落笔，完工清单与处置清单是同一份记录。 */
export function closeFault(entryId: number, finishedDate: string): FaultRecord | null {
  const records = allRecords()
  const index = records.findIndex((item) => item.entryId === entryId && item.status === '处置中')
  if (index < 0) {
    return null
  }
  const closed: FaultRecord = { ...records[index], status: '已完工', finishedDate }
  const next = [...records]
  next[index] = closed
  persist(next)
  return closed
}

/** 仅供迁移与测试使用：清空故障清单缓存。 */
export function resetFaultRecords(): void {
  persist(clone([]))
}

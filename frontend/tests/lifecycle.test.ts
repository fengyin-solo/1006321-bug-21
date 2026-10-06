import assert from 'node:assert/strict'

import {
  backfillLegacyFan,
  buildEvent,
  checkCountConsistency,
  deriveFanState,
  initialFanState,
} from '../src/domain/fan-lifecycle'
import { appendCompletion, backfillDisposalTraces, enqueueOutbox, flushOutbox } from '../src/domain/records'
import { migrateLegacyRows } from '../src/data/local-store'
import type { EntryRow, FanAction, FanRecord } from '../src/data/types'

let passed = 0
function test(name: string, fn: () => void) {
  fn()
  passed += 1
  console.log(`  ✓ ${name}`)
}

function act(events: FanRecord['events'], action: FanAction, extra: Record<string, string> = {}) {
  const record: FanRecord = {
    id: 1,
    机组编号: 'V',
    所属舱室: 'C',
    风机型号: 'M',
    送风风速: null,
    操作人员: null,
    events,
  }
  return buildEvent(record, action, { mode: '低速送风', stopReason: '测试原因', at: '2026-10-06T08:00:00.000Z', ...extra })
}

console.log('1. 单向链路：合法流转')
test('待开机 --提交开机(带模式)--> 运行中', () => {
  const r = act([], '提交开机')
  assert.equal(r.ok, true)
  assert.equal(r.event!.to, '运行中')
  assert.equal(r.event!.mode, '低速送风')
})
test('运行中 --登记停机(带原因)--> 已停机', () => {
  const start = act([], '提交开机').event!
  const r = act([start], '登记停机')
  assert.equal(r.ok, true)
  assert.equal(r.event!.to, '已停机')
  assert.equal(r.event!.stopReason, '测试原因')
})
test('已停机 --提交开机(可改新档)--> 运行中，停机原因清空', () => {
  const start = act([], '提交开机').event!
  const stop = act([start], '登记停机').event!
  const r = act([start, stop], '提交开机', { mode: '高速排风' })
  assert.equal(r.ok, true)
  assert.equal(r.event!.mode, '高速排风')
  assert.equal(r.event!.stopReason, null)
  const state = deriveFanState([start, stop, r.event!])
  assert.equal(state.stopReason, null)
})
test('运行中 --上报故障--> 故障停机 --故障恢复--> 已停机，原因保留', () => {
  const start = act([], '提交开机').event!
  const fault = act([start], '上报故障', { stopReason: '轴承损坏' }).event!
  const recover = act([start, fault], '故障恢复').event!
  assert.equal(fault.to, '故障停机')
  assert.equal(recover.to, '已停机')
  assert.equal(deriveFanState([start, fault, recover]).stopReason, '轴承损坏')
})

console.log('2. 跳着切换一律打回，并写明卡在哪一段')
test('待开机直接上报故障：打回，卡在待开机', () => {
  const r = act([], '上报故障')
  assert.equal(r.ok, false)
  assert.equal(r.blockedSegment, '待开机')
  assert.match(r.message, /待开机/)
})
test('故障停机直接提交开机：打回，卡在故障停机，要求先故障恢复', () => {
  const start = act([], '提交开机').event!
  const fault = act([start], '上报故障').event!
  const r = act([start, fault], '提交开机', { mode: '低速送风' })
  assert.equal(r.ok, false)
  assert.equal(r.blockedSegment, '故障停机')
  assert.equal(r.expectedAction, '故障恢复')
})
test('已停机直接上报故障：打回，卡在已停机', () => {
  const start = act([], '提交开机').event!
  const stop = act([start], '登记停机').event!
  const r = act([start, stop], '上报故障')
  assert.equal(r.ok, false)
  assert.equal(r.blockedSegment, '已停机')
})
test('中途改档也照原顺序：运行中不接受再走一遍开机改档', () => {
  const start = act([], '提交开机', { mode: '低速送风' }).event!
  // 运行中再提交开机（任何想绕开停机直接换档的入口）一律打回
  const r = act([start], '提交开机', { mode: '高速排风' })
  assert.equal(r.ok, false)
  assert.equal(r.blockedSegment, '运行中')
  assert.equal(r.expectedAction, '登记停机')
  assert.equal(deriveFanState([start]).mode, '低速送风')
})

console.log('3. 缺值不许拿默认值顶')
test('开机不填运行模式：打回', () => {
  const r = buildEvent(
    { id: 1, 机组编号: '', 所属舱室: '', 风机型号: '', 送风风速: null, 操作人员: null, events: [] },
    '提交开机',
    { mode: '   ' },
  )
  assert.equal(r.ok, false)
})
test('停机不填原因：打回', () => {
  const start = act([], '提交开机').event!
  const r = act([start], '登记停机', { stopReason: '' })
  assert.equal(r.ok, false)
})

console.log('4. 同一机组重复上报只置一次故障')
test('故障停机后再次上报故障：幂等打回', () => {
  const start = act([], '提交开机').event!
  const fault = act([start], '上报故障').event!
  const r = act([start, fault], '上报故障')
  assert.equal(r.ok, false)
  assert.match(r.message, /已置过故障/)
})
test('故障恢复并重新开机后可再次上报故障（新一轮）', () => {
  const start = act([], '提交开机').event!
  const fault = act([start], '上报故障', { stopReason: '第一次' }).event!
  const recover = act([start, fault], '故障恢复').event!
  const restart = act([start, fault, recover], '提交开机', { mode: '高速排风' }).event!
  const again = act([start, fault, recover, restart], '上报故障', { stopReason: '第二次' })
  assert.equal(again.ok, true)
  assert.equal(deriveFanState([start, fault, recover, restart, again.event!]).faultActive, true)
})

console.log('5. 存量机组回填裁决')
test('运行中存量：按启停时间补开机事件，模式保留', () => {
  const fan = backfillLegacyFan({
    id: 1, 机组编号: 'V1', 所属舱室: '', 风机型号: '',
    运行模式: '高速排风', 送风风速: null, 启停时间: '2026-09-02', 操作人员: '老李', 旧版状态: '运行中',
  })
  const state = deriveFanState(fan.events)
  assert.equal(state.status, '运行中')
  assert.equal(state.mode, '高速排风')
  assert.equal(fan.events[0].at, '2026-09-02T00:00:00.000Z')
  assert.equal(fan.legacyStatus, '运行中')
})
test('已停机存量：正常补停机，缺停机原因留 null', () => {
  const fan = backfillLegacyFan({
    id: 1, 机组编号: 'V2', 所属舱室: '', 风机型号: '',
    运行模式: '低速送风', 送风风速: null, 启停时间: '2026-09-03', 操作人员: null, 旧版状态: '已停机',
  })
  const state = deriveFanState(fan.events)
  assert.equal(state.status, '已停机')
  assert.equal(state.stopReason, null)
})
test('旧版平推故障停机但无故障记录：裁决以新版为准，降级已停机，旧值留痕', () => {
  const fan = backfillLegacyFan({
    id: 1, 机组编号: 'V3', 所属舱室: '', 风机型号: '',
    运行模式: '低速送风', 送风风速: null, 启停时间: '2026-09-03', 操作人员: null, 旧版状态: '故障停机',
  })
  assert.equal(deriveFanState(fan.events).status, '已停机')
  assert.equal(fan.legacyStatus, '故障停机')
  assert.match(fan.backfillNote, /降级/)
  assert.equal(fan.events.some((e) => e.action === '上报故障'), false)
})
test('只有运行模式没有启停时间：时间留 null，不编造', () => {
  const fan = backfillLegacyFan({
    id: 1, 机组编号: 'V4', 所属舱室: '', 风机型号: '',
    运行模式: '低速送风', 送风风速: null, 启停时间: '无法解析的日期', 操作人员: '', 旧版状态: '运行中',
  })
  assert.equal(fan.events[0].at, null)
})
test('待开机且无模式：不编造事件', () => {
  const fan = backfillLegacyFan({
    id: 1, 机组编号: 'V5', 所属舱室: '', 风机型号: '',
    运行模式: null, 送风风速: null, 启停时间: null, 操作人员: null, 旧版状态: '待开机',
  })
  assert.deepEqual(deriveFanState(fan.events), initialFanState())
})

console.log('6. 同步 outbox：断线续传、冻结载荷')
const fanRecord: FanRecord = {
  id: 7, 机组编号: 'V7', 所属舱室: '', 风机型号: '', 送风风速: null, 操作人员: null,
  events: [],
}
test('入队载荷为冻结快照，之后机组改档不影响已排队记录', () => {
  const e1 = act([], '提交开机', { mode: '低速送风' }).event!
  let queue = enqueueOutbox([], fanRecord, e1)
  assert.deepEqual(queue[0].payload, { status: '运行中', mode: '低速送风', stopReason: null })
  // 模拟机组随后继续变化，但队列第 1 条载荷保持冻结
  const e2 = act([e1], '登记停机', { stopReason: '计划停机' }).event!
  queue = enqueueOutbox(queue, fanRecord, e2)
  assert.deepEqual(queue[0].payload, { status: '运行中', mode: '低速送风', stopReason: null })
  assert.equal(queue[1].payload.status, '已停机')
})
test('断线：不发送；恢复后从第一条未成功的接着走', () => {
  const e1 = act([], '提交开机').event!
  const e2 = act([e1], '登记停机').event!
  let queue = enqueueOutbox(enqueueOutbox([], fanRecord, e1), fanRecord, e2)
  const offline = flushOutbox(queue, { online: false, syncedAt: 't' })
  assert.equal(offline.synced, 0)
  queue = offline.queue
  const online = flushOutbox(queue, { online: true, syncedAt: 't' })
  assert.equal(online.synced, 2)
  assert.equal(online.queue.every((i) => i.synced), true)
})
test('第一条失败即中断，后面的不发；再次同步从失败那条重试', () => {
  const e1 = act([], '提交开机').event!
  const e2 = act([e1], '登记停机').event!
  let queue = enqueueOutbox(enqueueOutbox([], fanRecord, e1), fanRecord, e2)
  const failed = flushOutbox(queue, { online: true, failFanIds: [7], syncedAt: 't' })
  assert.equal(failed.synced, 0)
  assert.equal(failed.failed!.id, 1)
  assert.equal(queue[1].synced, false)
  queue = failed.queue
  // 机组 7 恢复可达：从第 1 条继续，两条顺序成功（不会跳过第 1 条）
  const recovered = flushOutbox(queue, { online: true, failFanIds: [], syncedAt: 't' })
  assert.equal(recovered.synced, 2)
  assert.equal(recovered.queue[0].attempts, 2)
})

console.log('7. 共享完工清单：唯一落点、幂等')
test('验收追加；同一来源重复验收不新增', () => {
  let list = [] as ReturnType<typeof appendCompletion>['list']
  const first = appendCompletion(list, {
    sourceKey: 'leak', sourceLabel: '渗漏水处置单', sourceId: 1, code: 'LEAK-1',
  }, 1, '2026-10-06T08:00:00.000Z')
  list = first.list
  assert.equal(first.added, true)
  const second = appendCompletion(list, {
    sourceKey: 'leak', sourceLabel: '渗漏水处置单', sourceId: 1, code: 'LEAK-1',
  }, 2, '2026-10-06T09:00:00.000Z')
  assert.equal(second.added, false)
  assert.equal(second.list.length, 1)
})

console.log('8. 老处置记录按发现日期倒排，缺值不顶默认')
test('倒排 + null 原样保留', () => {
  const rows: EntryRow[] = [
    { id: 1, status: '已完工', pending: false, abnormal: false, 处置编号: 'L1', 发现日期: '2026-09-01', 完工日期: '' },
    { id: 2, status: '处置中', pending: true, abnormal: false, 处置编号: 'L2', 发现日期: '2026-09-05', 完工日期: '' },
    { id: 3, status: '已完工', pending: false, abnormal: false, 处置编号: 'L3', 发现日期: '', 完工日期: '' },
  ]
  const traces = backfillDisposalTraces(rows)
  assert.deepEqual(traces.map((t) => t.处置编号), ['L2', 'L1', 'L3'])
  assert.equal(traces[2].发现日期, null)
})

console.log('9. v1→v2 迁移与条数一致性')
test('旧版通风迁移后列表条数＝机组台数，故障停机不被无记录采信', () => {
  const legacy: Record<string, EntryRow[]> = {
    ventilation: [
      { id: 1, status: '运行中', pending: true, abnormal: false, 机组编号: 'V1', 所属舱室: '', 风机型号: '', 运行模式: '低速送风', 送风风速: '', 启停时间: '2026-09-02', 操作人员: '' },
      { id: 2, status: '已停机', pending: false, abnormal: false, 机组编号: 'V2', 所属舱室: '', 风机型号: '', 运行模式: '低速送风', 送风风速: '', 启停时间: '2026-09-03', 操作人员: '' },
      { id: 3, status: '故障停机', pending: false, abnormal: false, 机组编号: 'V3', 所属舱室: '', 风机型号: '', 运行模式: '低速送风', 送风风速: '', 启停时间: '2026-09-03', 操作人员: '' },
    ],
    leak: [
      { id: 1, status: '已完工', pending: false, abnormal: false, 处置编号: 'L1', 渗漏点位: '', 渗漏程度: '', 处置方式: '', 处置班组: '', 发现日期: '2026-09-02', 完工日期: '2026-09-03' },
    ],
  }
  const db = migrateLegacyRows(legacy, '2026-10-06T00:00:00.000Z')
  assert.equal(db.fans.length, 3)
  assert.equal(db.rows.ventilation.length, db.fans.length)
  const statuses = db.rows.ventilation.map((r) => r.status)
  assert.deepEqual(statuses, ['运行中', '已停机', '已停机'])
  assert.equal(db.rows.ventilation.filter((r) => r.abnormal).length, 0)
  // 老处置补录倒排、完工清单已补登
  assert.equal(db.disposalTraces.length, 1)
  assert.equal(db.completions.length, 1)
  assert.equal(db.completions[0].sourceKey, 'leak')
  // 旧库结构保留不动，新库 version=2
  assert.equal(db.version, 2)
  // 概览条数 ＝ 另存清单条数
  assert.equal(checkCountConsistency(db.rows.ventilation.length, db.fans.length).consistent, true)
})

console.log(`\n全部通过：${passed} 项`)

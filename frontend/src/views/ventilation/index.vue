<template>
  <section class="page" data-module="ventilation">
    <header class="page-head">
      <div>
        <h2>通风系统运维</h2>
        <p class="page-desc">
          机组生命周期是单向链路：待开机 → 运行中 → 已停机 → 重新开机；故障停机必须先故障恢复回已停机。
          状态、运行模式、停机原因随事件一次落库，列表、详情、交接班、概览读同一份推导结果。
        </p>
      </div>
      <div class="page-actions">
        <button class="btn" type="button" @click="exportRows">导出通风系统运维清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in statCards" :key="item.label" class="stat-card" :class="item.kind">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in legend" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
      <span class="legend-item">合计：{{ counters.total }}</span>
    </p>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">{{ formatCell(row[column]) }}</td>
          <td><span class="status-tag" :class="statusClass(String(row.status))">{{ row.status }}</span></td>
          <td class="row-actions">
            <button class="link" type="button" @click="openDetail(Number(row.id))">详情</button>
            <button
              v-for="action in actionsFor(String(row.status))"
              :key="action"
              class="link"
              type="button"
              @click="openDetail(Number(row.id), action)"
            >
              {{ action }}
            </button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无通风系统运维数据</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>
        共 {{ total }} 条 · 运行中 {{ counters.运行中 }} · 已停机 {{ counters.已停机 }} ·
        故障停机 {{ counters.故障停机 }} · 待开机 {{ counters.待开机 }}
        （列表/详情/交接班同一份推导值{{ counters.total === rows.length || filtered ? '' : '' }}）
      </span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>

    <!-- 同步面板：断线后从第一条没同步成功的记录接着走 -->
    <section class="sync-panel">
      <header class="sync-head">
        <h3>上行同步队列</h3>
        <div class="sync-controls">
          <label class="switch-line">
            <input v-model="online" type="checkbox" />
            链路{{ online ? '在线' : '断线' }}
          </label>
          <button class="btn" type="button" @click="doFlush">尝试同步</button>
          <span>待同步 {{ counters.pendingSync }} 条</span>
        </div>
      </header>
      <p v-if="syncMessage" class="sync-msg">{{ syncMessage }}</p>
      <table v-if="outbox.length" class="data-table sync-table">
        <thead>
          <tr><th>队列序</th><th>机组</th><th>事件序</th><th>动作</th><th>冻结状态</th><th>时间</th><th>同步情况</th></tr>
        </thead>
        <tbody>
          <tr v-for="item in outbox" :key="item.id" :class="{ head: !item.synced && item.id === firstPendingId }">
            <td>{{ item.id }}</td>
            <td>{{ fanCode(item.fanId) }}</td>
            <td>#{{ item.eventSeq }}</td>
            <td>{{ item.action }}</td>
            <td>{{ item.payload.status }}｜{{ item.payload.mode ?? '无档位' }}｜{{ item.payload.stopReason ?? '无停机原因' }}</td>
            <td>{{ formatCell(item.at) }}</td>
            <td>
              <span v-if="item.synced" class="ok-text">已同步</span>
              <span v-else class="error-text">
                未同步（第 {{ item.attempts }} 次尝试）{{ item.lastError ? `｜${item.lastError}` : '' }}
              </span>
            </td>
          </tr>
        </tbody>
      </table>
      <p v-else class="empty-state">同步队列为空，机组动作提交后会在此排队</p>
    </section>

    <!-- 详情抽屉 -->
    <div v-if="detail" class="drawer-mask" @click.self="closeDetail">
      <aside class="drawer">
        <header class="drawer-head">
          <h3>{{ detail.record.机组编号 }} · 机组详情</h3>
          <button class="btn ghost" type="button" @click="closeDetail">关闭</button>
        </header>

        <div class="detail-grid">
          <div><span>所属舱室</span><strong>{{ detail.record.所属舱室 }}</strong></div>
          <div><span>风机型号</span><strong>{{ detail.record.风机型号 }}</strong></div>
          <div><span>当前状态</span><strong :class="statusClass(detail.state.status)">{{ detail.state.status }}</strong></div>
          <div><span>运行模式</span><strong>{{ detail.state.mode ?? '—' }}</strong></div>
          <div><span>停机原因</span><strong>{{ detail.state.stopReason ?? '—' }}</strong></div>
          <div><span>最近事件时间</span><strong>{{ formatCell(detail.state.lastAt) }}</strong></div>
        </div>
        <p v-if="detail.record.legacyStatus" class="legacy-note">
          旧版平推状态为「{{ detail.record.legacyStatus }}」，仅作留痕，当前状态以新版事件链为准。
        </p>

        <div class="blocked-hint">
          当前卡在「{{ detail.state.status }}」段，本段只允许：
          <strong>{{ allowedHint(detail.state.status) }}</strong>；其余动作一律打回。
        </div>

        <!-- 开机：待开机 / 已停机；已停机重开可在此改档，中途改档不许直接落值 -->
        <form v-if="detail.state.status === '待开机' || detail.state.status === '已停机'" class="action-form" @submit.prevent="submit('提交开机')">
          <h4>提交开机{{ detail.state.status === '已停机' ? '（重新开机，可在此改档）' : '' }}</h4>
          <label>
            <span>运行模式（必填）</span>
            <select v-model="form.mode">
              <option value="" disabled>请选择运行模式</option>
              <option v-for="mode in runModes" :key="mode" :value="mode">{{ mode }}</option>
            </select>
          </label>
          <label>
            <span>操作人员</span>
            <input v-model="form.operator" placeholder="缺省取当前值班人" />
          </label>
          <button class="btn primary" type="submit">提交开机</button>
        </form>

        <template v-if="detail.state.status === '运行中'">
          <form class="action-form" @submit.prevent="submit('登记停机')">
            <h4>登记停机</h4>
            <label>
              <span>停机原因（必填）</span>
              <input v-model="form.stopReason" placeholder="如：例行轮换停机" />
            </label>
            <button class="btn" type="submit">登记停机</button>
          </form>
          <form class="action-form" @submit.prevent="submit('上报故障')">
            <h4>上报故障（本轮只置一次，重复上报打回）</h4>
            <label>
              <span>故障现象/停机原因（必填）</span>
              <input v-model="form.faultReason" placeholder="如：电机过热联锁停机" />
            </label>
            <button class="btn danger" type="submit">上报故障</button>
          </form>
          <form class="action-form" @submit.prevent="changeGear">
            <h4>申请改档（运行中）</h4>
            <p class="form-note">生命周期单向：运行中不允许直接换运行模式，须先登记停机、重新开机时再选新档位。</p>
            <button class="btn ghost" type="submit">申请改档</button>
          </form>
        </template>

        <form v-if="detail.state.status === '故障停机'" class="action-form" @submit.prevent="submit('故障恢复')">
          <h4>故障恢复</h4>
          <p class="form-note">
            故障停机不能直接开机：先故障恢复回到「已停机」，停机原因保留可查，之后再提交开机。
          </p>
          <label>
            <span>恢复说明（选填）</span>
            <input v-model="form.recoverNote" placeholder="如：更换轴承后试转正常" />
          </label>
          <button class="btn primary" type="submit">故障恢复</button>
        </form>

        <section class="timeline">
          <h4>生命周期事件链（倒序）</h4>
          <ol v-if="timeline.length">
            <li v-for="event in reversedTimeline" :key="event.seq">
              <span class="t-seq">#{{ event.seq }}</span>
              <span class="t-flow">{{ event.from }} → {{ event.to }}（{{ event.action }}）</span>
              <span class="t-meta">
                档位：{{ event.mode ?? '—' }} ｜ 停机原因：{{ event.stopReason ?? '—' }} ｜
                操作人：{{ event.operator ?? '未登记' }} ｜ 时间：{{ formatCell(event.at) }}
              </span>
              <span v-if="event.note" class="t-note">备注：{{ event.note }}</span>
            </li>
          </ol>
          <p v-else class="empty-state">尚无生命周期事件</p>
        </section>
      </aside>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'

import {
  downloadEntries,
  FAN_RUN_MODES,
  fanCounters,
  fanTimeline,
  flushFanSync,
  getFan,
  listEntries,
  moduleMeta,
  pendingOutbox,
  submitFanAction,
} from '@/api/local-service'
import { listOutbox } from '@/data/local-store'
import { useSessionStore } from '@/stores/session'
import type { EntryRow, FanAction, FanStatus, OutboxItem } from '@/data/types'

const session = useSessionStore()
const meta = moduleMeta('ventilation')
const columns = ['机组编号', '所属舱室', '风机型号', '运行模式', '送风风速', '停机原因', '启停时间', '操作人员', '风机状态']
const runModes = FAN_RUN_MODES

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = ['机组编号', '所属舱室', '风机型号']
const counters = ref(fanCounters())
const filtered = ref(false)

const statCards = computed(() => [
  { label: '运行中风机', value: counters.value.运行中, kind: 'running' },
  { label: '已停机风机', value: counters.value.已停机, kind: 'stopped' },
  { label: '故障停机风机', value: counters.value.故障停机, kind: 'fault' },
  { label: '待同步事件', value: counters.value.pendingSync, kind: 'sync' },
])

const legend = computed(() =>
  (['待开机', '运行中', '已停机', '故障停机'] as FanStatus[]).map((status) => ({
    status,
    count: counters.value[status],
  })),
)

const detail = ref<ReturnType<typeof getFan>>(null)
const focusAction = ref<FanAction | null>(null)
const timeline = computed(() => (detail.value ? fanTimeline(detail.value.record) : []))
const reversedTimeline = computed(() => [...timeline.value].sort((a, b) => b.seq - a.seq))

const form = reactive({ mode: '', stopReason: '', faultReason: '', recoverNote: '', operator: '' })

const online = ref(true)
const outbox = ref<OutboxItem[]>([])
const syncMessage = ref('')
const firstPendingId = computed(() => outbox.value.find((item) => !item.synced)?.id ?? 0)

function fanCode(fanId: number): string {
  return getFan(fanId)?.record.机组编号 ?? `机组${fanId}`
}

function actionsFor(status: string): FanAction[] {
  switch (status) {
    case '待开机':
      return ['提交开机']
    case '运行中':
      return ['登记停机', '上报故障']
    case '已停机':
      return ['提交开机']
    case '故障停机':
      return ['故障恢复']
    default:
      return []
  }
}

function allowedHint(status: FanStatus): string {
  const actions = actionsFor(status)
  return actions.length ? actions.join('、') : '无（请联系管理员核对事件链）'
}

function statusClass(status: string): string {
  if (status === '运行中') {
    return 'ok-text'
  }
  if (status === '故障停机') {
    return 'error-text'
  }
  if (status === '已停机') {
    return 'muted-text'
  }
  return ''
}

function formatCell(value: unknown): string {
  if (value === null || value === undefined || value === '') {
    return '—'
  }
  const text = String(value)
  const parsed = new Date(text)
  if (/^\d{4}-\d{2}-\d{2}T/.test(text) && !Number.isNaN(parsed.getTime())) {
    const pad = (n: number) => String(n).padStart(2, '0')
    return `${parsed.getFullYear()}-${pad(parsed.getMonth() + 1)}-${pad(parsed.getDate())} ${pad(parsed.getHours())}:${pad(parsed.getMinutes())}`
  }
  return text
}

function resetForm() {
  form.mode = detail.value?.state.mode ?? ''
  form.stopReason = ''
  form.faultReason = ''
  form.recoverNote = ''
  form.operator = session.operator
}

function openDetail(id: number, action?: FanAction) {
  detail.value = getFan(id)
  focusAction.value = action ?? null
  resetForm()
}

function closeDetail() {
  detail.value = null
  focusAction.value = null
}

function submit(action: FanAction) {
  if (!detail.value) {
    return
  }
  const result = submitFanAction(
    detail.value.record.id,
    action,
    {
      mode: action === '提交开机' ? form.mode : null,
      stopReason: action === '登记停机' ? form.stopReason : action === '上报故障' ? form.faultReason : null,
      operator: form.operator || session.operator,
      note: action === '故障恢复' && form.recoverNote.trim() ? form.recoverNote.trim() : null,
    },
  )
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  errorMessage.value = ''
  reload()
  detail.value = getFan(detail.value.record.id)
  resetForm()
}

function changeGear() {
  // 中途改档也得照原顺序恢复：运行中直接打回，指明卡在运行中段
  errorMessage.value = '打回：当前卡在「运行中」段，运行中不能直接改运行模式；先「登记停机」，重新「提交开机」时再选新档位'
}

function doFlush() {
  const result = flushFanSync({ online: online.value })
  if (!online.value) {
    syncMessage.value = '链路断线，本次不发送任何记录；恢复后仍从队列第一条未同步成功的记录接着走'
  } else if (result.failed) {
    syncMessage.value = `卡在队列第 ${result.failed.id} 条（机组 ${fanCode(result.failed.fanId) }）：${result.failed.lastError ?? '同步失败'}；其后记录保持未同步，未用上一次的值顶替`
  } else if (result.synced > 0) {
    syncMessage.value = `本次顺序同步 ${result.synced} 条，剩余待同步 ${result.pendingLeft} 条`
  } else {
    syncMessage.value = '没有待同步记录'
  }
  reload()
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
    counters.value = fanCounters()
    outbox.value = listOutbox()
    filtered.value = Object.values(filters.value).some((value) => value.trim() !== '')
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '通风系统运维列表读取失败'
  }
}

onMounted(reload)
</script>

<style scoped>
.status-tag {
  display: inline-block;
  padding: 2px 8px;
  border-radius: 999px;
  font-size: 12px;
}
.status-tag.ok-text {
  background: #e7f6ec;
  color: #1a7f37;
}
.status-tag.error-text {
  background: #fdecec;
  color: #b42318;
}
.status-tag.muted-text {
  background: #eef2f7;
  color: var(--muted);
}
.stat-card.fault .stat-value {
  color: #b42318;
}
.stat-card.running .stat-value {
  color: #1a7f37;
}
.stat-card.sync .stat-value {
  color: var(--brand);
}
.sync-panel {
  margin-top: 16px;
  background: #fff;
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 12px;
}
.sync-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
}
.sync-head h3 {
  margin: 0;
  font-size: 14px;
}
.sync-controls {
  display: flex;
  gap: 12px;
  align-items: center;
  font-size: 13px;
}
.switch-line {
  display: flex;
  gap: 6px;
  align-items: center;
}
.sync-msg {
  font-size: 12px;
  color: var(--muted);
}
.sync-table tr.head {
  outline: 2px solid #f59e0b;
}
.drawer-mask {
  position: fixed;
  inset: 0;
  background: rgba(15, 23, 42, 0.45);
  display: flex;
  justify-content: flex-end;
  z-index: 20;
}
.drawer {
  width: 640px;
  max-width: 92vw;
  background: #fff;
  height: 100%;
  overflow-y: auto;
  padding: 16px 20px;
}
.drawer-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
}
.detail-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px 16px;
  margin: 12px 0;
}
.detail-grid span {
  display: block;
  font-size: 12px;
  color: var(--muted);
}
.legacy-note {
  font-size: 12px;
  color: #92400e;
  background: #fef3c7;
  border-radius: 6px;
  padding: 6px 8px;
}
.blocked-hint {
  font-size: 12px;
  background: #eef2f7;
  border-radius: 6px;
  padding: 8px;
  margin-bottom: 12px;
}
.action-form {
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 10px 12px;
  margin-bottom: 10px;
}
.action-form h4 {
  margin: 0 0 8px;
  font-size: 13px;
}
.action-form label {
  display: block;
  margin-bottom: 8px;
  font-size: 12px;
  color: var(--muted);
}
.action-form input,
.action-form select {
  width: 100%;
  margin-top: 2px;
  padding: 6px 8px;
  border: 1px solid var(--border);
  border-radius: 6px;
}
.btn.danger {
  border-color: #b42318;
  color: #b42318;
}
.form-note {
  font-size: 12px;
  color: var(--muted);
  margin: 0 0 8px;
}
.timeline {
  margin-top: 12px;
}
.timeline h4 {
  font-size: 13px;
}
.timeline ol {
  list-style: none;
  margin: 0;
  padding: 0;
}
.timeline li {
  border-left: 3px solid var(--brand);
  padding: 6px 10px;
  margin-bottom: 6px;
  background: #f8fafc;
  border-radius: 0 6px 6px 0;
  font-size: 12px;
}
.t-seq {
  font-weight: 700;
  margin-right: 8px;
}
.t-meta {
  display: block;
  color: var(--muted);
}
.t-note {
  display: block;
  color: #92400e;
}
</style>

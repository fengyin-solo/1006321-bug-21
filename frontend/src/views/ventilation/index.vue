<template>
  <section class="page" data-module="ventilation">
    <header class="page-head">
      <div>
        <h2>通风系统运维管理</h2>
        <p class="page-desc">维护通风机组，围绕机组编号、所属舱室、风机型号、运行模式做登记、筛选与状态流转。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记通风机组</button>
        <button class="btn" type="button" @click="exportRows">导出通风系统运维清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
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
          <td v-for="column in columns" :key="column">{{ row[column] ?? '—' }}</td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <button class="link" type="button" @click="openDetail(row)">查看</button>
            <button
              v-for="action in actions"
              :key="action"
              class="link"
              type="button"
              @click="runAction(action, row)"
            >
              {{ action }}
            </button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无通风系统运维数据，可先登记通风机组</td>
        </tr>
      </tbody>
    </table>

    <section v-if="detail" class="detail-panel">
      <header class="detail-head">
        <h3>机组详情：{{ detail['机组编号'] }}</h3>
        <button class="btn ghost" type="button" @click="closeDetail">收起</button>
      </header>
      <dl class="detail-grid">
        <div v-for="field in detailFields" :key="field" class="detail-item">
          <dt>{{ field }}</dt>
          <dd>{{ detail[field] ?? '—' }}</dd>
        </div>
        <div class="detail-item">
          <dt>当前状态（状态机为准）</dt>
          <dd>{{ detail.status }}</dd>
        </div>
        <div class="detail-item">
          <dt>风机状态（旧版留痕，不参与判定）</dt>
          <dd>{{ detail['风机状态'] ?? '—' }}</dd>
        </div>
      </dl>
      <table class="data-table">
        <thead>
          <tr><th>发现日期</th><th>停机原因</th><th>操作人员</th><th>来源</th><th>处置状态</th><th>完工日期</th></tr>
        </thead>
        <tbody>
          <tr v-for="fault in detailFaults" :key="fault.id">
            <td>{{ fault.foundDate || '—' }}</td>
            <td>{{ fault.reason || '—' }}</td>
            <td>{{ fault.operator || '—' }}</td>
            <td>{{ fault.source }}</td>
            <td>{{ fault.status }}</td>
            <td>{{ fault.finishedDate || '—' }}</td>
          </tr>
          <tr v-if="!detailFaults.length">
            <td colspan="6" class="empty-state">该机组暂无故障处置记录</td>
          </tr>
        </tbody>
      </table>
    </section>

    <section class="detail-panel">
      <header class="detail-head">
        <h3>故障处置与完工清单（按发现日期倒排）</h3>
      </header>
      <table class="data-table">
        <thead>
          <tr><th>机组编号</th><th>发现日期</th><th>停机原因</th><th>操作人员</th><th>来源</th><th>处置状态</th><th>完工日期</th></tr>
        </thead>
        <tbody>
          <tr v-for="fault in faults" :key="fault.id">
            <td>{{ fault.unitCode || '—' }}</td>
            <td>{{ fault.foundDate || '—' }}</td>
            <td>{{ fault.reason || '—' }}</td>
            <td>{{ fault.operator || '—' }}</td>
            <td>{{ fault.source }}</td>
            <td>{{ fault.status }}</td>
            <td>{{ fault.finishedDate || '—' }}</td>
          </tr>
          <tr v-if="!faults.length">
            <td colspan="7" class="empty-state">暂无故障处置记录</td>
          </tr>
        </tbody>
      </table>
    </section>

    <footer class="page-foot">
      <span>共 {{ total }} 条通风系统运维记录</span>
      <span v-if="noticeMessage" class="notice-text">{{ noticeMessage }}</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  downloadEntries,
  getEntry,
  listEntries,
  listFaults,
  moduleMeta,
  runAction as applyAction,
} from '@/api/local-service'
import type { EntryRow, FaultRecord } from '@/data/types'

const meta = moduleMeta('ventilation')
const columns = ["机组编号", "所属舱室", "风机型号", "运行模式", "送风风速", "启停时间", "操作人员", "停机原因", "风机状态"]
const actions = ["提交开机", "登记停机", "上报故障"]
const statuses = ["待开机", "运行中", "已停机", "故障停机"]
const metricStatus: Record<string, string> = { 运行中风机: '运行中', 已停机风机: '已停机', 故障停机风机: '故障停机' }
const detailFields = ["机组编号", "所属舱室", "风机型号", "运行模式", "送风风速", "启停时间", "操作人员", "停机原因"]

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const noticeMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)
const faults = ref<FaultRecord[]>([])
const detail = ref<EntryRow | null>(null)
const detailFaults = ref<FaultRecord[]>([])

// 统计卡与状态条都按当前列表实时算，动作落库后 reload，台数跟着变。
const stats = computed(() =>
  Object.entries(metricStatus).map(([label, status]) => ({
    label,
    value: rows.value.filter((row) => String(row.status) === status).length,
  })),
)
const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  errorMessage.value = '通风机组登记入口尚未接入审批流'
}

function openDetail(row: EntryRow) {
  detail.value = getEntry(meta.key, Number(row.id))
  detailFaults.value = listFaults(Number(row.id))
}

function closeDetail() {
  detail.value = null
  detailFaults.value = []
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  noticeMessage.value = ''
  const result = applyAction(meta.key, Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  noticeMessage.value = result.message
  reload()
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
    faults.value = listFaults()
    if (detail.value) {
      detail.value = getEntry(meta.key, Number(detail.value.id))
      detailFaults.value = listFaults(Number(detail.value?.id))
    }
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '通风系统运维列表读取失败'
  }
}

onMounted(reload)
</script>

<style scoped>
.detail-panel {
  background: #fff;
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 12px;
  margin-top: 12px;
}
.detail-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 8px;
}
.detail-head h3 {
  margin: 0;
  font-size: 14px;
}
.detail-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
  gap: 8px 16px;
  margin: 0 0 12px;
}
.detail-item dt {
  color: var(--muted);
  font-size: 12px;
}
.detail-item dd {
  margin: 2px 0 0;
  font-size: 13px;
}
.notice-text {
  color: #067647;
}
</style>

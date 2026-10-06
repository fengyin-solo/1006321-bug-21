<template>
  <section class="page" data-module="leak">
    <header class="page-head">
      <div>
        <h2>渗漏水处置管理</h2>
        <p class="page-desc">维护渗漏处置单，围绕处置编号、渗漏点位、渗漏程度、处置方式做登记、筛选与状态流转。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记渗漏处置单</button>
        <button class="btn" type="button" @click="exportRows">导出渗漏水处置清单</button>
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
          <td :colspan="columns.length + 2" class="empty-state">暂无渗漏水处置数据，可先登记渗漏处置单</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条渗漏水处置记录</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>

    <section class="trace-panel">
      <h3>老处置记录补录（按发现日期倒排）</h3>
      <p class="trace-desc">存量处置记录迁移补录，缺值一律显示「未登记」，不用默认值顶替。</p>
      <table class="data-table">
        <thead>
          <tr>
            <th v-for="column in traceColumns" :key="column">{{ column }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="(item, index) in traces" :key="index">
            <td v-for="column in traceColumns" :key="column">{{ item[column] ?? '未登记' }}</td>
          </tr>
          <tr v-if="!traces.length">
            <td :colspan="traceColumns.length" class="empty-state">无补录记录</td>
          </tr>
        </tbody>
      </table>
    </section>

    <CompletionLedger ref="ledgerRef" title="本模块验收完工（与概览、其他入口同一份）" />
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import CompletionLedger from '@/components/CompletionLedger.vue'
import {
  downloadEntries,
  listDisposalTraces,
  listEntries,
  moduleMeta,
  runAction as applyAction,
} from '@/api/local-service'
import type { DisposalTrace, EntryRow } from '@/data/types'

const meta = moduleMeta('leak')
const columns = ["处置编号", "渗漏点位", "渗漏程度", "处置方式", "处置班组", "发现日期", "完工日期", "处置状态"]
const traceColumns = ["处置编号", "渗漏点位", "渗漏程度", "处置方式", "处置班组", "发现日期", "完工日期"] as const
const actions = ["派出处置", "确认完工", "要求返工"]
const statuses = ["待处置", "处置中", "已完工", "需返工"]
const stats = [{"label": "待处置渗漏点", "value": 0}, {"label": "处置中渗漏点", "value": 0}, {"label": "本月完工数", "value": 0}]

const rows = ref<EntryRow[]>([])
const traces = ref<DisposalTrace[]>([])
const ledgerRef = ref<InstanceType<typeof CompletionLedger> | null>(null)
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)
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
  errorMessage.value = '渗漏处置单登记入口尚未接入审批流'
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  const result = applyAction(meta.key, Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  reload()
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
    traces.value = listDisposalTraces()
    ledgerRef.value?.refresh()
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '渗漏水处置列表读取失败'
  }
}

onMounted(reload)
</script>

<style scoped>
.trace-panel {
  margin-top: 16px;
  background: #fff;
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 12px;
}
.trace-panel h3 {
  margin: 0 0 4px;
  font-size: 14px;
}
.trace-desc {
  margin: 0 0 10px;
  font-size: 12px;
  color: var(--muted);
}
</style>

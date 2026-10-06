<template>
  <section class="page" data-module="duty">
    <header class="page-head">
      <div>
        <h2>运维值班交接管理</h2>
        <p class="page-desc">维护值班交接记录，围绕交接编号、值班班组、值班日期、班次做登记、筛选与状态流转。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记值班交接记录</button>
        <button class="btn" type="button" @click="exportRows">导出运维值班交接清单</button>
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
          <td :colspan="columns.length + 2" class="empty-state">暂无运维值班交接数据，可先登记值班交接记录</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条运维值班交接记录</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>

    <section class="fan-check">
      <h3>交接核对 · 通风机组台数</h3>
      <p class="fan-check-desc">
        台数直接取自通风机组事件链的同一份推导结果，与通风列表、详情、概览一致；接班时逐项核对后再交接。
      </p>
      <div class="stat-row">
        <article class="stat-card running">
          <span class="stat-label">运行中风机</span>
          <strong class="stat-value">{{ fanCounts.运行中 }}</strong>
        </article>
        <article class="stat-card stopped">
          <span class="stat-label">已停机风机</span>
          <strong class="stat-value">{{ fanCounts.已停机 }}</strong>
        </article>
        <article class="stat-card fault">
          <span class="stat-label">故障停机风机</span>
          <strong class="stat-value">{{ fanCounts.故障停机 }}</strong>
        </article>
        <article class="stat-card">
          <span class="stat-label">待开机风机</span>
          <strong class="stat-value">{{ fanCounts.待开机 }}</strong>
        </article>
      </div>
      <p class="fan-check-foot">
        合计 {{ fanCounts.total }} 台；另有 {{ fanCounts.pendingSync }} 条机组事件待上行同步，列入交接遗留。
      </p>
    </section>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  downloadEntries,
  fanCounters,
  listEntries,
  moduleMeta,
  runAction as applyAction,
} from '@/api/local-service'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('duty')
const columns = ["交接编号", "值班班组", "值班日期", "班次", "值班人员", "交接事项", "交接人员", "交接状态"]
const actions = ["发起交接", "确认交接", "登记遗留"]
const statuses = ["待交接", "交接中", "已交接", "有遗留"]
const stats = [{"label": "待交接班次", "value": 0}, {"label": "已交接班次", "value": 0}, {"label": "有遗留事项", "value": 0}]

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)
// 交接班读到的风机台数：与通风列表、详情共用 fanCounters 这一份
const fanCounts = ref(fanCounters())
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
  errorMessage.value = '值班交接记录登记入口尚未接入审批流'
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
    fanCounts.value = fanCounters()
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '运维值班交接列表读取失败'
  }
}

onMounted(reload)
</script>

<style scoped>
.fan-check {
  margin-top: 16px;
  background: #fff;
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 12px;
}
.fan-check h3 {
  margin: 0 0 4px;
  font-size: 14px;
}
.fan-check-desc {
  margin: 0 0 10px;
  font-size: 12px;
  color: var(--muted);
}
.fan-check-foot {
  margin: 8px 0 0;
  font-size: 12px;
  color: var(--muted);
}
.stat-card.fault .stat-value {
  color: #b42318;
}
.stat-card.running .stat-value {
  color: #1a7f37;
}
.stat-card.stopped .stat-value {
  color: var(--muted);
}
</style>

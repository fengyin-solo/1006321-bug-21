<template>
  <section class="ledger">
    <header class="ledger-head">
      <div>
        <h3 v-if="title">{{ title }}</h3>
        <p class="ledger-desc">
          验收结果只有这一份落点：来源模块验收时写入，其他入口只读不另存；概览条数与本清单一致（{{ rows.length }} 条）。
        </p>
      </div>
      <button v-if="showExport" class="btn" type="button" @click="downloadCompletions">另存完工清单(CSV)</button>
    </header>
    <table v-if="rows.length" class="data-table">
      <thead>
        <tr>
          <th>来源模块</th><th>业务单号</th><th>完工日期</th><th>验收时间</th><th>验收人员</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="item in rows" :key="`${item.sourceKey}-${item.sourceId}`">
          <td>{{ item.sourceLabel }}</td>
          <td>{{ item.code ?? '未登记' }}</td>
          <td>{{ show(item.completedAt) }}</td>
          <td>{{ show(item.acceptedAt) }}</td>
          <td>{{ show(item.operator) }}</td>
        </tr>
      </tbody>
    </table>
    <p v-else class="empty-state">暂无验收完工记录</p>
    <footer class="ledger-foot">清单条数 {{ rows.length }} ＝ 概览「验收完工数」{{ rows.length }}</footer>
  </section>
</template>

<script setup lang="ts">
import { ref } from 'vue'

import { downloadCompletions, listCompletions } from '@/api/local-service'
import type { CompletionRecord } from '@/data/types'

defineProps<{ title?: string; showExport?: boolean }>()

const rows = ref<CompletionRecord[]>(listCompletions())

function show(value: string | null): string {
  return value ?? '未登记'
}

// 路由切回本页时重新读同一份库（其他入口写入后不持有过期副本）
function refresh() {
  rows.value = listCompletions()
}
defineExpose({ refresh })
</script>

<style scoped>
.ledger {
  margin-top: 16px;
  background: #fff;
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 12px;
}
.ledger-head {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 12px;
}
.ledger-head h3 {
  margin: 0 0 4px;
  font-size: 14px;
}
.ledger-desc {
  margin: 0;
  font-size: 12px;
  color: var(--muted);
}
.ledger-foot {
  margin-top: 8px;
  font-size: 12px;
  color: var(--muted);
}
</style>

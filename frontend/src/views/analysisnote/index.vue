<template>
  <section class="page" data-module="analysisnote">
    <header class="page-head">
      <div>
        <h2>分析笔记管理</h2>
        <p class="page-desc">
          笔记与标签化数据集联动：按频次检索时读取同一份完整版本，标签名称、使用频次、最后使用时间都能回到标签分类逐项核对。
        </p>
      </div>
      <div class="page-actions">
        <button class="btn" type="button" @click="reload">刷新标签频次</button>
        <button class="btn" type="button" @click="exportRows">导出分析笔记清单</button>
      </div>
    </header>

    <p v-if="feed" class="banner" :class="bannerClass">
      <strong>标签化数据集 v{{ feed.version }}</strong>
      <span>{{ feed.notice }}</span>
      <span class="banner-meta">
        指纹 {{ feed.checksum }} · 发布 {{ feed.publishedAt }}
      </span>
    </p>

    <div class="stat-row">
      <article v-for="item in statCards" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <div class="toolbar">
      <label class="toolbar-item">
        <span>按笔记标题 / 标签 / 数据集检索</span>
        <input v-model="keyword" placeholder="例如：口径复核 或 DS-ORDER-DAILY" />
      </label>
      <span class="muted">
        排序依据：笔记关联标签中的最高使用频次（同频次按最近使用时间）
      </span>
    </div>

    <h3 class="section-title">笔记列表（按最高频次排序）</h3>
    <table class="data-table">
      <thead>
        <tr>
          <th>笔记编号</th>
          <th>笔记标题</th>
          <th>关联数据集</th>
          <th>标签（名称 / 频次 / 最后使用）</th>
          <th>最高频次</th>
          <th>最近使用</th>
          <th>状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="note in noteRows" :key="note.noteId">
          <td>{{ note.noteCode }}</td>
          <td>{{ note.title }}</td>
          <td>{{ note.datasetId }}</td>
          <td>
            <span v-for="tag in note.tags" :key="tag.tagCode" class="tag-chip">
              {{ tag.tagName }} · {{ tag.frequency }} 次 · {{ tag.lastUsed || '未使用' }}
            </span>
            <span v-if="!note.tags.length" class="muted">无标签</span>
          </td>
          <td>{{ note.maxFrequency }}</td>
          <td>{{ note.latestDetailAt || note.latestLastUsed || '—' }}</td>
          <td>{{ note.status }}</td>
          <td class="row-actions">
            <button
              v-for="action in actions"
              :key="action"
              class="link"
              type="button"
              @click="runAction(action, note.noteId)"
            >
              {{ action }}
            </button>
          </td>
        </tr>
        <tr v-if="!noteRows.length">
          <td colspan="8" class="empty-state">没有匹配的分析笔记</td>
        </tr>
      </tbody>
    </table>

    <h3 class="section-title">标签频次（同一份标签化数据集）</h3>
    <table class="data-table">
      <thead>
        <tr>
          <th>标签名称</th>
          <th>使用频次</th>
          <th>最后使用</th>
          <th>使用明细</th>
          <th>数据集</th>
          <th>核对</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in tagRows" :key="row.tagCode">
          <td>{{ row.tagName }}</td>
          <td>{{ row.frequency }}</td>
          <td>{{ row.lastUsed || '—' }}</td>
          <td>{{ row.detailCount }} 条</td>
          <td>{{ row.datasetIds.join('、') || '—' }}</td>
          <td>
            <RouterLink class="link" to="/taggroup">回查标签分类</RouterLink>
          </td>
        </tr>
        <tr v-if="!tagRows.length">
          <td colspan="6" class="empty-state">标签化数据集还没有标签</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>
        共 {{ noteRows.length }} 条笔记 · 标签化数据集 v{{ feed?.version ?? '—' }}
        <template v-if="feed?.noteStale"> · 笔记表单有变更，等待重算后刷新标签视图</template>
      </span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import { downloadEntries, moduleMeta, runAction as applyAction } from '@/api/local-service'
import { loadAnalysisNoteFeed } from '@/api/tag-service'
import type { AnalysisNoteFeed } from '@/data/tag-types'

const meta = moduleMeta('analysisnote')
const actions = meta.actions
const feed = ref<AnalysisNoteFeed | null>(null)
const keyword = ref('')
const errorMessage = ref('')

const statCards = computed(() => {
  const current = feed.value
  if (!current) {
    return []
  }
  return [
    { label: '笔记条目', value: current.rows.length },
    { label: '标签数', value: current.totals.tags },
    { label: '有效关系', value: current.totals.relations },
    { label: '总使用频次', value: current.totals.frequency },
    { label: '待重算标签', value: current.pendingChanges },
  ]
})

const noteRows = computed(() => {
  const rows = feed.value?.rows ?? []
  const text = keyword.value.trim()
  if (!text) {
    return rows
  }
  return rows.filter(
    (row) =>
      row.title.includes(text) ||
      row.noteCode.includes(text) ||
      row.datasetId.includes(text) ||
      row.tags.some((tag) => tag.tagName.includes(text) || tag.tagCode.includes(text)),
  )
})

const tagRows = computed(() => {
  const rows = feed.value?.tags ?? []
  const text = keyword.value.trim()
  if (!text) {
    return rows
  }
  return rows.filter(
    (row) => row.tagName.includes(text) || row.datasetIds.some((item) => item.includes(text)),
  )
})

const bannerClass = computed(() => {
  const current = feed.value
  if (!current) {
    return ''
  }
  if (current.interrupted) {
    return 'banner-warn'
  }
  if (current.building || current.pendingChanges > 0) {
    return 'banner-info'
  }
  return 'banner-ok'
})

function runAction(action: string, id: number) {
  const result = applyAction(meta.key, id, action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function reload() {
  errorMessage.value = ''
  try {
    feed.value = loadAnalysisNoteFeed()
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '分析笔记列表读取失败'
  }
}

onMounted(reload)
</script>

<style scoped>
.banner {
  display: flex; flex-wrap: wrap; gap: 8px 16px; align-items: center;
  border: 1px solid var(--border); border-radius: 8px; padding: 10px 12px;
  background: #fff; font-size: 13px; margin: 0 0 12px;
}
.banner-ok { border-left: 4px solid #0f9d58; }
.banner-info { border-left: 4px solid #1f6feb; }
.banner-warn { border-left: 4px solid #b42318; background: #fff8f7; }
.banner-meta { color: var(--muted); }
.toolbar { display: flex; flex-wrap: wrap; gap: 12px; align-items: flex-end; margin-bottom: 10px; }
.toolbar-item span { display: block; font-size: 12px; color: var(--muted); }
.section-title { font-size: 14px; margin: 18px 0 8px; }
.muted { color: var(--muted); font-size: 12px; }
.tag-chip {
  display: inline-block; margin: 2px 4px 2px 0; padding: 2px 8px;
  border-radius: 999px; background: #eef2f7; font-size: 12px;
}
</style>

<template>
  <section class="page" data-module="taggroup">
    <header class="page-head">
      <div>
        <h2>标签分类管理</h2>
        <p class="page-desc">
          标签定义 → 标签关系 → 使用明细 → 标签化数据集。频次与最后使用只在完整版本上发布，分析笔记读取同一份结果。
        </p>
      </div>
      <div class="page-actions">
        <button class="btn" type="button" @click="refresh">重新读取</button>
        <button class="btn" type="button" @click="exportDataset">导出标签化数据集</button>
        <button class="btn" type="button" @click="exportRows">导出标签定义</button>
        <button class="btn ghost" type="button" @click="resetDemo">重置示例数据</button>
      </div>
    </header>

    <div class="tabs">
      <button
        v-for="tab in tabs"
        :key="tab.key"
        class="btn"
        :class="{ primary: view === tab.key }"
        type="button"
        @click="view = tab.key"
      >
        {{ tab.label }}
      </button>
    </div>

    <p v-if="dataset" class="banner" :class="bannerClass">
      <strong>v{{ dataset.stableVersion }}</strong>
      <span>{{ dataset.notice }}</span>
      <span v-if="dataset.job" class="banner-job">
        任务 {{ dataset.job.jobId }} · {{ statusText(dataset.job.status) }} · 已处理
        {{ dataset.job.processed.length }} / 待处理 {{ dataset.job.pending.length }}
      </span>
    </p>

    <!-- 标签化数据集 -->
    <template v-if="view === 'dataset' && dataset">
      <div class="stat-row">
        <article v-for="card in datasetCards" :key="card.label" class="stat-card">
          <span class="stat-label">{{ card.label }}</span>
          <strong class="stat-value">{{ card.value }}</strong>
        </article>
      </div>

      <div class="toolbar">
        <label class="toolbar-item">
          <span>按标签名称 / 数据集检索</span>
          <input v-model="datasetKeyword" placeholder="输入标签名称或数据集" />
        </label>
        <button class="btn primary" type="button" @click="runVerify">逐项核验</button>
        <span class="muted">
          校验指纹 {{ dataset.snapshot.checksum }} · 采集于
          {{ dataset.snapshot.sourceCapturedAt || '—' }}
        </span>
      </div>

      <table class="data-table">
        <thead>
          <tr>
            <th>标签名称</th>
            <th>使用频次</th>
            <th>最后使用</th>
            <th>使用明细</th>
            <th>数据集</th>
            <th>来源定义（频次 / 最后使用）</th>
            <th>一致性</th>
            <th>回查</th>
          </tr>
        </thead>
        <tbody>
          <template v-for="row in datasetRows" :key="row.tagCode">
            <tr>
              <td>
                <strong>{{ row.tagName }}</strong>
                <small class="sub">{{ row.tagCode }} · {{ row.tagStatus }}</small>
              </td>
              <td>{{ row.frequency }}</td>
              <td>{{ row.lastUsed || '—' }}</td>
              <td>
                {{ row.detailCount }} 条
                <small v-if="row.detailCount" class="sub">
                  首用 {{ row.firstUsed || '—' }}
                </small>
              </td>
              <td>{{ row.datasetIds.join('、') || '—' }}</td>
              <td class="muted">
                {{ row.sourceDefinition.frequency ?? '非数字' }} /
                {{ row.sourceDefinition.lastUsed || '空' }}
              </td>
              <td>
                <span :class="row.frequencyConsistent && row.lastUsedConsistent ? 'ok' : 'warn'">
                  {{ row.frequencyConsistent && row.lastUsedConsistent ? '频次与时间一致' : '本次重算已修正' }}
                </span>
                <small v-if="row.issues.length" class="sub">{{ row.issues[0] }}</small>
              </td>
              <td>
                <button class="link" type="button" @click="toggleRow(row.tagCode)">
                  {{ expanded.has(row.tagCode) ? '收起明细' : '查看明细' }}
                </button>
              </td>
            </tr>
            <tr v-if="expanded.has(row.tagCode)" class="detail-row">
              <td colspan="8">
                <p class="detail-title">使用明细（一个关系只保留一条，重复写入合并在同一条上）</p>
                <table class="inner-table">
                  <thead>
                    <tr>
                      <th>明细编号</th>
                      <th>关系键</th>
                      <th>数据集</th>
                      <th>关联笔记</th>
                      <th>最近使用</th>
                      <th>合并写入</th>
                      <th>来源</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr v-for="detail in row.details" :key="detail.eventId">
                      <td>#{{ detail.eventId }}</td>
                      <td>{{ detail.relationKey }}</td>
                      <td>{{ detail.datasetId }}</td>
                      <td>{{ detail.noteId ?? '—' }}</td>
                      <td>{{ detail.occurredAt }}</td>
                      <td>{{ detail.mergedWrites }} 次</td>
                      <td>{{ detail.source }}</td>
                    </tr>
                    <tr v-if="!row.details.length">
                      <td colspan="7" class="empty-state">该标签还没有有效关系，频次为 0</td>
                    </tr>
                  </tbody>
                </table>
                <p v-if="row.corrections.length" class="warn">
                  构建输入修正：{{ row.corrections.join('；') }}
                </p>
              </td>
            </tr>
          </template>
          <tr v-if="!datasetRows.length">
            <td colspan="8" class="empty-state">当前标签化数据集没有匹配的标签</td>
          </tr>
        </tbody>
      </table>

      <h3 class="section-title">数据集分组</h3>
      <table class="data-table">
        <thead>
          <tr><th>数据集</th><th>包含标签</th><th>标签数</th><th>使用明细</th><th>最后使用</th></tr>
        </thead>
        <tbody>
          <tr v-for="group in dataset.snapshot.datasetGroups" :key="group.datasetId">
            <td>{{ group.datasetId }}</td>
            <td>{{ group.tagCodes.join('、') }}</td>
            <td>{{ group.tagCount }}</td>
            <td>{{ group.detailCount }}</td>
            <td>{{ group.lastUsed || '—' }}</td>
          </tr>
          <tr v-if="!dataset.snapshot.datasetGroups.length">
            <td colspan="5" class="empty-state">还没有标签关系</td>
          </tr>
        </tbody>
      </table>

      <h3 class="section-title">版本历史（可回查）</h3>
      <table class="data-table">
        <thead>
          <tr><th>版本</th><th>发布说明</th><th>标签 / 关系 / 明细</th><th>指纹</th><th>发布时间</th><th>回查</th></tr>
        </thead>
        <tbody>
          <tr v-for="item in dataset.versions" :key="item.version">
            <td>v{{ item.version }}{{ item.version === dataset.stableVersion ? '（当前）' : '' }}</td>
            <td>{{ item.buildNote }}</td>
            <td>{{ item.tags }} / {{ item.relations }} / {{ item.events }}</td>
            <td class="muted">{{ item.checksum }}</td>
            <td>{{ item.publishedAt }}</td>
            <td>
              <button class="link" type="button" @click="openVersion(item.version)">查看该版本</button>
            </td>
          </tr>
        </tbody>
      </table>

      <template v-if="versionPreview">
        <div class="toolbar">
          <strong>回查 v{{ versionPreview.version }}</strong>
          <span class="muted">{{ versionPreview.buildNote }} · {{ versionPreview.checksum }}</span>
          <button class="btn ghost" type="button" @click="versionPreview = null">关闭</button>
        </div>
        <table class="data-table">
          <thead><tr><th>标签名称</th><th>使用频次</th><th>最后使用</th><th>明细</th><th>数据集</th></tr></thead>
          <tbody>
            <tr v-for="row in versionPreview.rows" :key="row.tagCode">
              <td>{{ row.tagName }}</td>
              <td>{{ row.frequency }}</td>
              <td>{{ row.lastUsed || '—' }}</td>
              <td>{{ row.detailCount }}</td>
              <td>{{ row.datasetIds.join('、') || '—' }}</td>
            </tr>
          </tbody>
        </table>
      </template>

      <template v-if="verify">
        <h3 class="section-title">
          核验结果：{{ verify.summary.passed }} / {{ verify.summary.total }} 项通过（v{{ verify.version }}）
        </h3>
        <p class="muted">
          {{ verify.pendingNote }}
          <span v-if="verify.summary.expectedDrift">
            · 另有 {{ verify.summary.expectedDrift }} 项差异属于「已登记、等待重算」的预期差异
          </span>
        </p>
        <p>
          <span :class="verify.ok ? 'ok' : 'warn'">
            版本内 / 标签定义一致：{{ verify.ok ? '是' : '否' }}
          </span>
          ·
          <span :class="verify.liveOk ? 'ok' : 'warn'">
            与实时明细一致：{{ verify.liveOk ? '是' : '否' }}
          </span>
        </p>
        <table class="data-table">
          <thead>
            <tr><th>范围</th><th>标签</th><th>字段</th><th>数据集值</th><th>对比值</th><th>结果</th><th>说明</th></tr>
          </thead>
          <tbody>
            <tr v-for="(item, index) in verifyItems" :key="index">
              <td>{{ item.scope }}</td>
              <td>{{ item.tagName }}</td>
              <td>{{ item.field }}</td>
              <td>{{ item.datasetValue }}</td>
              <td>{{ item.comparedValue }}</td>
              <td :class="item.ok ? 'ok' : item.expected ? 'muted' : 'warn'">
                {{ item.ok ? '一致' : item.expected ? '待重算' : '不一致' }}
              </td>
              <td class="muted">{{ item.note }}</td>
            </tr>
          </tbody>
        </table>
        <button class="btn ghost" type="button" @click="showAllVerify = !showAllVerify">
          {{ showAllVerify ? '只看异常项' : `展开全部 ${verify.items.length} 项` }}
        </button>
      </template>
    </template>

    <!-- 标签定义 -->
    <template v-if="view === 'definitions'">
      <form class="filter-bar" @submit.prevent="createTag">
        <label class="filter-item">
          <span>新增标签名称</span>
          <input v-model="newTag.name" placeholder="例如：活动复盘" />
        </label>
        <label class="filter-item">
          <span>所属分类</span>
          <input v-model="newTag.category" placeholder="例如：活动分析" />
        </label>
        <label class="filter-item">
          <span>标签颜色</span>
          <input v-model="newTag.color" placeholder="#1f6feb" />
        </label>
        <button class="btn primary" type="submit">新增标签定义</button>
      </form>

      <table class="data-table">
        <thead>
          <tr>
            <th>标签编号</th>
            <th>标签名称</th>
            <th>所属分类</th>
            <th>状态</th>
            <th>使用频次</th>
            <th>最后使用</th>
            <th>关联数据集</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="tag in tags" :key="tag.code">
            <td>{{ tag.code }}</td>
            <td>{{ tag.name }}</td>
            <td>{{ tag.category }}</td>
            <td>{{ tag.status }}</td>
            <td>{{ tag.frequencyRaw ?? '非数字' }}</td>
            <td>{{ tag.lastUsedRaw || '—' }}</td>
            <td>{{ tag.datasetRaw || '—' }}</td>
            <td class="row-actions">
              <button
                v-for="action in tagActions"
                :key="action"
                class="link"
                type="button"
                @click="runTagAction(tag.id, action)"
              >
                {{ action }}
              </button>
              <button class="link" type="button" @click="deleteTag(tag.code)">删除标签</button>
            </td>
          </tr>
          <tr v-if="!tags.length">
            <td colspan="8" class="empty-state">暂无标签定义，可先新增</td>
          </tr>
        </tbody>
      </table>
      <p class="muted">
        使用频次与最后使用由重算任务回写；新增标签会先以 0 频次进入标签化数据集，登记关系后重算更新。
      </p>
    </template>

    <!-- 关系与使用登记 -->
    <template v-if="view === 'relations'">
      <form class="filter-bar" @submit.prevent="writeUsage">
        <label class="filter-item">
          <span>标签</span>
          <select v-model="usageForm.tagCode">
            <option v-for="tag in tags" :key="tag.code" :value="tag.code">
              {{ tag.code }} · {{ tag.name }}
            </option>
          </select>
        </label>
        <label class="filter-item">
          <span>数据集</span>
          <input v-model="usageForm.datasetId" list="dataset-options" placeholder="DS-ORDER-DAILY" />
          <datalist id="dataset-options">
            <option v-for="item in workbench?.datasets ?? []" :key="item" :value="item" />
          </datalist>
        </label>
        <label class="filter-item">
          <span>关联笔记</span>
          <select v-model="usageForm.noteId">
            <option :value="null">不关联</option>
            <option v-for="note in notes" :key="note.id" :value="note.id">
              {{ note.code }} · {{ note.title }}
            </option>
          </select>
        </label>
        <button class="btn primary" type="submit">登记一次使用</button>
        <button class="btn ghost" type="button" @click="removeSelectedRelation">移除所选关系</button>
        <button class="btn ghost" type="button" @click="restoreSelectedRelation">重新登记关系</button>
      </form>
      <p class="muted">
        同一「标签 + 数据集」重复写入只会合并到同一条使用明细，关系数、频次与最后使用时间都不变；
        关系移除后该数据集不再累加最后使用时间，需要重新使用请点「重新登记关系」（生成新的关系版本 rN）。
      </p>

      <div class="stat-row">
        <article class="stat-card">
          <span class="stat-label">关系总数</span>
          <strong class="stat-value">{{ workbench?.relationsTotal ?? 0 }}</strong>
        </article>
        <article class="stat-card">
          <span class="stat-label">有效关系</span>
          <strong class="stat-value">{{ workbench?.relationsActive ?? 0 }}</strong>
        </article>
        <article class="stat-card">
          <span class="stat-label">使用明细</span>
          <strong class="stat-value">{{ workbench?.eventsTotal ?? 0 }}</strong>
        </article>
        <article class="stat-card">
          <span class="stat-label">合并写入次数</span>
          <strong class="stat-value">{{ workbench?.mergedWrites ?? 0 }}</strong>
        </article>
      </div>

      <h3 class="section-title">有效关系</h3>
      <table class="data-table">
        <thead>
          <tr><th>关系键</th><th>标签</th><th>数据集</th><th>笔记</th><th>最近使用</th><th>版本</th><th>来源</th><th>操作</th></tr>
        </thead>
        <tbody>
          <tr v-for="relation in workbench?.activeRelations ?? []" :key="relation.key">
            <td>{{ relation.key }}</td>
            <td>{{ relation.tagName }}</td>
            <td>{{ relation.datasetId }}</td>
            <td>{{ relation.noteId ?? '—' }}</td>
            <td>
              {{ latestEvent(relation.key)?.occurredAt ?? '—' }}
              <small v-if="!dataset?.snapshot.relations.some((item) => item.key === relation.key)" class="sub">
                待重算
              </small>
            </td>
            <td>r{{ relation.revision }}</td>
            <td>{{ relation.source }}</td>
            <td>
              <button class="link" type="button" @click="removeRelationRow(relation)">移除</button>
              <button class="link" type="button" @click="writeUsageFor(relation)">再记一次使用</button>
            </td>
          </tr>
          <tr v-if="!(workbench?.activeRelations ?? []).length">
            <td colspan="8" class="empty-state">暂无有效关系</td>
          </tr>
        </tbody>
      </table>

      <h3 class="section-title">最近使用明细（含合并记录）</h3>
      <table class="data-table">
        <thead>
          <tr><th>明细</th><th>关系键</th><th>标签</th><th>数据集</th><th>最近使用</th><th>合并写入</th><th>状态</th><th>历史</th></tr>
        </thead>
        <tbody>
          <tr v-for="event in workbench?.recentEvents ?? []" :key="event.id">
            <td>#{{ event.id }}</td>
            <td>{{ event.relationKey }}</td>
            <td>{{ event.tagName }}</td>
            <td>{{ event.datasetId }}</td>
            <td>{{ event.occurredAt }}</td>
            <td>{{ event.mergedWrites }} 次</td>
            <td>{{ event.state === 'active' ? '有效' : '已移除' }}</td>
            <td class="muted">
              {{ event.history.map((item) => `${item.action}@${item.at}`).join(' / ') }}
            </td>
          </tr>
        </tbody>
      </table>

      <h3 class="section-title">数据集迁移</h3>
      <form class="filter-bar" @submit.prevent="migrate">
        <label class="filter-item">
          <span>源数据集</span>
          <input v-model="migrateForm.from" list="dataset-options" placeholder="DS-CHANNEL-SALES" />
        </label>
        <label class="filter-item">
          <span>目标数据集</span>
          <input v-model="migrateForm.to" list="dataset-options" placeholder="DS-ORDER-DAILY" />
        </label>
        <button class="btn primary" type="submit">迁移标签关系</button>
      </form>
      <p class="muted">
        迁移会把源数据集的有效关系转到目标数据集；目标已有同标签关系时合并成一条，频次不重复增加，
        源关系不再累加最后使用。
      </p>
    </template>

    <!-- 重算任务 -->
    <template v-if="view === 'recompute' && dataset">
      <div class="toolbar">
        <label class="toolbar-check">
          <input
            type="checkbox"
            :checked="workbench?.autoRecompute ?? false"
            @change="toggleAuto(($event.target as HTMLInputElement).checked)"
          />
          <span>关系变化后自动增量重算</span>
        </label>
        <button class="btn primary" type="button" @click="recompute('incremental')">增量重算（只补变化标签）</button>
        <button class="btn" type="button" @click="recompute('full')">全量重算</button>
        <button class="btn" type="button" @click="advance">推进一项</button>
        <button class="btn" type="button" @click="simulateFail">模拟中断（处理 1 项后停下）</button>
        <button class="btn" type="button" @click="resume">继续重算（只补缺口）</button>
      </div>

      <div class="stat-row">
        <article class="stat-card">
          <span class="stat-label">对外稳定版本</span>
          <strong class="stat-value">v{{ dataset.stableVersion }}</strong>
        </article>
        <article class="stat-card">
          <span class="stat-label">待重算标签</span>
          <strong class="stat-value">{{ dataset.pendingKeys.length }}</strong>
        </article>
        <article class="stat-card">
          <span class="stat-label">任务状态</span>
          <strong class="stat-value">{{ dataset.job ? statusText(dataset.job.status) : '无任务' }}</strong>
        </article>
        <article class="stat-card">
          <span class="stat-label">合并写入</span>
          <strong class="stat-value">{{ workbench?.mergedWrites ?? 0 }}</strong>
        </article>
      </div>

      <p v-if="dataset.job" class="muted">
        任务 {{ dataset.job.jobId }} · {{ dataset.job.mode === 'full' ? '全量' : '增量' }} ·
        基线 v{{ dataset.job.baseVersion }} → v{{ dataset.job.targetVersion }} · 第
        {{ dataset.job.attempts }} 次执行
        <template v-if="dataset.job.lastError"> · {{ dataset.job.lastError }}</template>
      </p>

      <h3 class="section-title">待重算变更</h3>
      <table class="data-table">
        <thead><tr><th>#</th><th>标签</th><th>变更</th><th>说明</th><th>时间</th></tr></thead>
        <tbody>
          <tr v-for="change in dataset.pendingChanges" :key="change.seq">
            <td>{{ change.seq }}</td>
            <td>{{ change.tagCode }}</td>
            <td>{{ changeLabel(change.action) }}</td>
            <td>{{ change.note }}</td>
            <td>{{ change.at }}</td>
          </tr>
          <tr v-if="!dataset.pendingChanges.length">
            <td colspan="5" class="empty-state">没有待重算的变更</td>
          </tr>
        </tbody>
      </table>

      <h3 class="section-title">重算与发布记录</h3>
      <table class="data-table">
        <thead><tr><th>时间</th><th>动作</th><th>标签</th><th>说明</th><th>操作人</th></tr></thead>
        <tbody>
          <tr v-for="entry in dataset.auditLog" :key="entry.id">
            <td>{{ entry.at }}</td>
            <td>{{ entry.action }}</td>
            <td>{{ entry.tagCode || '—' }}</td>
            <td class="muted">{{ entry.detail }}</td>
            <td>{{ entry.actor }}</td>
          </tr>
        </tbody>
      </table>
    </template>

    <footer class="page-foot">
      <span>{{ message || `共 ${tags.length} 条标签定义` }}</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import { downloadEntries, moduleMeta } from '@/api/local-service'
import {
  advanceRecompute,
  applyTagAction,
  createTagDefinition,
  deleteTagDefinition,
  downloadTagDataset,
  loadTagDatasetVersion,
  loadTagWorkbench,
  migrateDataset,
  recordRelationUsage,
  removeRelation,
  resetTagDemo,
  restoreRelation,
  runRecompute,
  setAutoRecompute,
  verifyTagDataset,
} from '@/api/tag-service'
import type {
  RecomputeChange,
  RecomputeJobStatus,
  TagMutationResult,
  TagRelation,
  TagWorkbench,
  TaggedDataset,
  VerifyResult,
} from '@/data/tag-types'

const meta = moduleMeta('taggroup')
const tagActions = meta.actions
type TabKey = 'dataset' | 'definitions' | 'relations' | 'recompute'
const tabs: { key: TabKey; label: string }[] = [
  { key: 'dataset', label: '标签化数据集' },
  { key: 'definitions', label: '标签定义' },
  { key: 'relations', label: '关系与使用登记' },
  { key: 'recompute', label: '频次重算' },
]
const view = ref<TabKey>('dataset')
const workbench = ref<TagWorkbench | null>(null)
const verify = ref<VerifyResult | null>(null)
const versionPreview = ref<TaggedDataset | null>(null)
const expanded = ref(new Set<string>())
const datasetKeyword = ref('')
const message = ref('')
const errorMessage = ref('')
const showAllVerify = ref(false)
const newTag = ref({ name: '', category: '', color: '#1f6feb' })
const usageForm = ref<{ tagCode: string; datasetId: string; noteId: number | null }>({
  tagCode: 'TAGG-0001',
  datasetId: 'DS-ORDER-DAILY',
  noteId: null,
})
const migrateForm = ref({ from: '', to: '' })

const dataset = computed(() => workbench.value?.dataset ?? null)
const tags = computed(() => workbench.value?.tags ?? [])
const notes = computed(() => workbench.value?.notes ?? [])

const datasetCards = computed(() => {
  const snapshot = dataset.value?.snapshot
  if (!snapshot) {
    return []
  }
  return [
    { label: '标签数', value: snapshot.totals.tags },
    { label: '有效关系', value: snapshot.totals.relations },
    { label: '使用明细', value: snapshot.totals.events },
    { label: '总使用频次', value: snapshot.totals.frequency },
    { label: '覆盖笔记', value: snapshot.totals.notes },
  ]
})

const datasetRows = computed(() => {
  const rows = dataset.value?.snapshot.rows ?? []
  const keyword = datasetKeyword.value.trim()
  if (!keyword) {
    return rows
  }
  return rows.filter(
    (row) =>
      row.tagName.includes(keyword) ||
      row.tagCode.includes(keyword) ||
      row.datasetIds.some((item) => item.includes(keyword)),
  )
})

const verifyItems = computed(() => {
  const result = verify.value
  if (!result) {
    return []
  }
  if (showAllVerify.value) {
    return result.items
  }
  return result.items.filter((item) => !item.ok || item.scope === '校验指纹')
})

const bannerClass = computed(() => {
  if (!dataset.value) {
    return ''
  }
  if (dataset.value.interrupted) {
    return 'banner-warn'
  }
  if (dataset.value.building) {
    return 'banner-info'
  }
  return dataset.value.pendingKeys.length > 0 ? 'banner-info' : 'banner-ok'
})

function statusText(status: RecomputeJobStatus): string {
  return status === 'running' ? '进行中' : status === 'failed' ? '已中断' : '已完成'
}

function changeLabel(action: RecomputeChange['action']): string {
  const map: Record<RecomputeChange['action'], string> = {
    added: '新增关系',
    removed: '移除关系',
    merged: '重复写入合并',
    migrated: '数据集迁移',
    'tag-added': '新增标签',
    'tag-updated': '标签定义变化',
    'tag-removed': '删除标签',
  }
  return map[action] ?? action
}

/** 关系最近一次使用的时间取自已发布的标签化数据集，保证与管理页展示同一边界。 */
function latestEvent(key: string): { occurredAt: string } | undefined {
  const fromSnapshot = dataset.value?.snapshot.events.find((event) => event.relationKey === key)
  if (fromSnapshot) {
    return fromSnapshot
  }
  return (workbench.value?.recentEvents ?? []).find((event) => event.relationKey === key)
}

function refresh() {
  workbench.value = loadTagWorkbench()
  versionPreview.value = null
  verify.value = null
  if (!usageForm.value.tagCode && tags.value.length > 0) {
    usageForm.value.tagCode = tags.value[0].code
  }
}

function apply(result: TagMutationResult) {
  message.value = result.message
  errorMessage.value = result.ok ? '' : result.message
  refresh()
}

function exportRows() {
  downloadEntries(meta.key)
}

function exportDataset() {
  downloadTagDataset()
}

function toggleRow(tagCode: string) {
  const next = new Set(expanded.value)
  if (next.has(tagCode)) {
    next.delete(tagCode)
  } else {
    next.add(tagCode)
  }
  expanded.value = next
}

function openVersion(version: number) {
  versionPreview.value = loadTagDatasetVersion(version)
}

function runVerify() {
  verify.value = verifyTagDataset()
}

function createTag() {
  apply(createTagDefinition({ ...newTag.value }))
  newTag.value = { name: '', category: '', color: '#1f6feb' }
}

function runTagAction(id: number, action: string) {
  apply(applyTagAction(id, action))
}

function deleteTag(tagCode: string) {
  apply(deleteTagDefinition(tagCode))
}

function writeUsage() {
  apply(
    recordRelationUsage({
      tagCode: usageForm.value.tagCode,
      datasetId: usageForm.value.datasetId.trim(),
      noteId: usageForm.value.noteId,
    }),
  )
}

function removeSelectedRelation() {
  apply(removeRelation(usageForm.value.tagCode, usageForm.value.datasetId.trim()))
}

function restoreSelectedRelation() {
  apply(restoreRelation(usageForm.value.tagCode, usageForm.value.datasetId.trim()))
}

function writeUsageFor(relation: TagRelation) {
  usageForm.value.tagCode = relation.tagCode
  usageForm.value.datasetId = relation.datasetId
  usageForm.value.noteId = relation.noteId
  writeUsage()
}

function removeRelationRow(relation: TagRelation) {
  apply(removeRelation(relation.tagCode, relation.datasetId))
}

function migrate() {
  apply(migrateDataset(migrateForm.value.from.trim(), migrateForm.value.to.trim()))
}

function toggleAuto(enabled: boolean) {
  setAutoRecompute(enabled)
  message.value = enabled ? '已开启自动重算' : '已改为手动重算'
  refresh()
}

function recompute(mode: 'incremental' | 'full') {
  const result = runRecompute({ mode })
  message.value = result.message
  errorMessage.value = result.ok ? '' : result.message
  refresh()
}

function advance() {
  const result = advanceRecompute(1)
  message.value = result.message
  refresh()
}

function simulateFail() {
  if (!dataset.value || dataset.value.pendingKeys.length === 0) {
    message.value = '当前没有待重算的标签关系：先在「关系与使用登记」里新增 / 移除一条关系，或取消勾选自动重算后再制造变更'
    return
  }
  // 临时切到手动模式制造一次中断：处理 1 项后停下，读侧继续用上一份完整版本。
  const wasAuto = workbench.value?.autoRecompute ?? true
  setAutoRecompute(false)
  const result = runRecompute({ mode: 'incremental', failAfter: 1 })
  if (wasAuto) {
    setAutoRecompute(true)
  }
  message.value = result.message
  errorMessage.value = result.ok ? '' : result.message
  refresh()
}

function resetDemo() {
  resetTagDemo()
  message.value = '已恢复示例标签定义、关系与笔记'
  errorMessage.value = ''
  refresh()
}

function resume() {
  const result = runRecompute({ mode: 'incremental' })
  message.value = result.message
  errorMessage.value = result.ok ? '' : result.message
  refresh()
}

onMounted(refresh)
</script>

<style scoped>
.tabs { display: flex; gap: 8px; margin-bottom: 12px; flex-wrap: wrap; }
.banner {
  display: flex; flex-wrap: wrap; gap: 8px 16px; align-items: center;
  border: 1px solid var(--border); border-radius: 8px; padding: 10px 12px;
  background: #fff; font-size: 13px; margin: 0 0 12px;
}
.banner-ok { border-left: 4px solid #0f9d58; }
.banner-info { border-left: 4px solid #1f6feb; }
.banner-warn { border-left: 4px solid #b42318; background: #fff8f7; }
.banner-job { color: var(--muted); }
.toolbar { display: flex; flex-wrap: wrap; gap: 12px; align-items: flex-end; margin-bottom: 10px; }
.toolbar-item span { display: block; font-size: 12px; color: var(--muted); }
.toolbar-check { display: flex; gap: 6px; align-items: center; font-size: 13px; }
.section-title { font-size: 14px; margin: 18px 0 8px; }
.sub { display: block; color: var(--muted); font-size: 11px; }
.muted { color: var(--muted); font-size: 12px; }
.ok { color: #0f7b45; font-size: 12px; }
.warn { color: #b42318; font-size: 12px; }
.detail-row td { background: #f9fbfd; }
.detail-title { margin: 0 0 8px; font-size: 12px; color: var(--muted); }
.inner-table { width: 100%; border-collapse: collapse; font-size: 12px; }
.inner-table th, .inner-table td { border: 1px solid var(--border); padding: 6px 8px; text-align: left; }
</style>

/**
 * 标签使用统计 / 标签化数据集的公共类型。
 *
 * 存储口径（本项目最终依据）：
 * - 关系（TagRelation）是「标签被哪个数据集使用」的唯一登记，键为 标签编号 + 数据集；
 * - 使用明细（TagUsageEvent）每个关系只保留最近一条：重复写入合并到同一条明细
 *   （mergedWrites 计数 + history），不新增关系，也不增加频次；
 * - 关系移除后，这条明细转为 removed 保留审计，不再计入频次和最后使用时间；
 * - 标签化数据集每次发布同时保存关系、明细和标签定义来源快照，频次 / 最后使用可按关系逐项回查。
 */

export type TagRelationState = 'active' | 'removed'
export type TagEventState = 'active' | 'removed'
export type TagSource = 'seed' | 'manual' | 'note' | 'migrated'

export type TagRelation = {
  key: string
  tagId: number
  tagCode: string
  tagName: string
  datasetId: string
  noteId: number | null
  noteCode: string
  state: TagRelationState
  revision: number
  createdAt: string
  createdBy: string
  removedAt: string
  removedBy: string
  source: TagSource
}

export type TagEventHistory = {
  action: 'created' | 'merged' | 'removed' | 'rejected'
  at: string
  note: string
}

export type TagUsageEvent = {
  id: number
  relationKey: string
  relationRevision: number
  tagId: number
  tagCode: string
  tagName: string
  datasetId: string
  noteId: number | null
  occurredAt: string
  state: TagEventState
  mergedWrites: number
  lastMergedAt: string
  removedAt: string
  source: TagSource
  history: TagEventHistory[]
}

export type TagDefinitionSource = {
  id: number
  code: string
  name: string
  status: string
  color: string
  category: string
  /** 构建前从标签定义里读到的使用频次（原始输入）。 */
  frequency: number | null
  /** 构建前从标签定义里读到的最后使用时间（原始输入）。 */
  lastUsed: string
  capturedAt: string
}

export type TagDefinitionAfter = {
  frequency: number
  lastUsed: string
  datasets: string
  syncedAt: string
}

export type TagDatasetDetail = {
  eventId: number
  relationKey: string
  datasetId: string
  noteId: number | null
  occurredAt: string
  mergedWrites: number
  source: string
  relationRevision: number
}

export type TagDatasetRow = {
  tagId: number
  tagCode: string
  tagName: string
  tagStatus: string
  color: string
  category: string
  frequency: number
  lastUsed: string
  firstUsed: string
  detailCount: number
  relationKeys: string[]
  eventIds: number[]
  datasetIds: string[]
  noteIds: number[]
  details: TagDatasetDetail[]
  sourceDefinition: TagDefinitionSource
  definitionAfter: TagDefinitionAfter
  /** 构建输入一致：构建时读到的标签定义值与按明细算出的值相同。 */
  frequencyConsistent: boolean
  lastUsedConsistent: boolean
  consistent: boolean
  /** 本版本相对构建输入修正了什么（用于回看这次重算改了什么）。 */
  corrections: string[]
  issues: string[]
}

export type TagDatasetNoteRow = {
  noteId: number
  noteCode: string
  title: string
  datasetId: string
  tagCode: string
  tagName: string
  frequency: number
  lastUsed: string
  detailCount: number
}

export type TagDatasetGroup = {
  datasetId: string
  tagCodes: string[]
  tagCount: number
  detailCount: number
  frequency: number
  lastUsed: string
}

export type TagDatasetEventRef = {
  id: number
  relationKey: string
  tagCode: string
  tagName: string
  datasetId: string
  noteId: number | null
  occurredAt: string
  source: string
  mergedWrites: number
}

export type TagDatasetRelationRef = {
  key: string
  tagCode: string
  tagName: string
  datasetId: string
  noteId: number | null
  createdAt: string
  revision: number
  source: string
}

export type TaggedDataset = {
  schemaVersion: 1
  version: number
  builtAt: string
  publishedAt: string
  jobId: string
  status: 'published'
  rows: TagDatasetRow[]
  notes: TagDatasetNoteRow[]
  datasetGroups: TagDatasetGroup[]
  relations: TagDatasetRelationRef[]
  events: TagDatasetEventRef[]
  totals: {
    tags: number
    relations: number
    events: number
    notes: number
    frequency: number
  }
  sourceCapturedAt: string
  noteSignature: string
  /** 逐条笔记的内容指纹（编号 / 标题 / 数据集 / 状态 / 关联标签），用于精确找出受影响的标签。 */
  noteHashes: Record<string, string>
  checksum: string
  buildNote: string
  relationSignature: string
  catalogSignature: string
  coveredSeq: Record<string, number>
}

export type RecomputeChangeAction =
  | 'added'
  | 'removed'
  | 'merged'
  | 'migrated'
  | 'tag-added'
  | 'tag-updated'
  | 'tag-removed'

export type RecomputeChange = {
  key: string
  action: RecomputeChangeAction
  tagCode: string
  seq: number
  at: string
  note: string
}

export type RecomputeJobStatus = 'running' | 'failed' | 'completed'

export type RecomputeJob = {
  jobId: string
  mode: 'full' | 'incremental'
  targetVersion: number
  baseVersion: number
  baseSeq: number
  status: RecomputeJobStatus
  pending: string[]
  processed: string[]
  failed: string[]
  processedSeq: Record<string, number>
  targetSeq: Record<string, number>
  startedAt: string
  updatedAt: string
  finishedAt: string
  attempts: number
  lastError: string
  changes: RecomputeChange[]
}

export type TagDraftAggregate = {
  tagCode: string
  details: TagDatasetDetail[]
  relationKeys: string[]
}

export type RecomputeDraft = {
  jobId: string
  targetVersion: number
  baseVersion: number
  aggregates: Record<string, TagDraftAggregate>
  sourceByTag: Record<string, TagDefinitionSource>
  createdAt: string
  updatedAt: string
  catalogSignature: string
  relationSignature: string
  noteSignature: string
  noteHashes: Record<string, string>
  coveredSeq: Record<string, number>
}

export type TagAuditEntry = {
  id: number
  at: string
  action: string
  tagCode: string
  relationKey: string
  detail: string
  actor: string
}

export type TagDatasetVersionRef = {
  version: number
  builtAt: string
  publishedAt: string
  checksum: string
  tags: number
  relations: number
  events: number
  notes: number
  jobId: string
  buildNote: string
}

export type TagDatasetView = {
  snapshot: TaggedDataset
  versions: TagDatasetVersionRef[]
  stableVersion: number
  building: boolean
  interrupted: boolean
  pendingChanges: RecomputeChange[]
  pendingKeys: string[]
  job: RecomputeJob | null
  notice: string
  auditLog: TagAuditEntry[]
}

export type VerifyScope = '快照内部' | '标签定义' | '实时明细' | '校验指纹'

export type VerifyItem = {
  scope: VerifyScope
  tagCode: string
  tagName: string
  field: string
  datasetValue: string
  comparedValue: string
  ok: boolean
  /** 差异是否属于「已登记但还没重算」的预期差异，而不是数据错误。 */
  expected: boolean
  note: string
}

export type VerifyResult = {
  ok: boolean
  liveOk: boolean
  checkedAt: string
  version: number
  checksum: string
  checksumOk: boolean
  items: VerifyItem[]
  summary: {
    total: number
    passed: number
    failed: number
    liveDrift: number
    expectedDrift: number
  }
  pendingChanges: number
  pendingNote: string
}

export type TagCatalogItem = {
  id: number
  code: string
  name: string
  status: string
  color: string
  category: string
  datasetRaw: string
  frequencyRaw: number | null
  lastUsedRaw: string
  createdAt: string
}

export type NoteRef = {
  id: number
  code: string
  title: string
  datasetId: string
  tagCodes: string[]
  status: string
}

export type UsageWriteResult = {
  ok: boolean
  message: string
  kind: 'created' | 'merged' | 'rejected'
  relationKey: string
  eventId: number
  frequencyBefore: number
  frequencyAfter: number
  lastUsed: string
  detailCount: number
}

export type RecomputeResult = {
  ok: boolean
  status: 'noop' | 'completed' | 'failed'
  message: string
  jobId: string
  version: number
  processed: number
  pending: number
}

export type TagMutationResult = {
  ok: boolean
  message: string
  changedKeys: string[]
  snapshotVersion: number
  pending: number
  recomputeStatus: 'auto' | 'queued' | 'interrupted' | 'none'
  usage: UsageWriteResult | null
}

export type AnalysisNoteTagRef = {
  tagCode: string
  tagName: string
  frequency: number
  lastUsed: string
  detailCount: number
}

export type AnalysisNoteFeedRow = {
  noteId: number
  noteCode: string
  title: string
  datasetId: string
  status: string
  tags: AnalysisNoteTagRef[]
  maxFrequency: number
  latestLastUsed: string
  latestDetailAt: string
}

export type AnalysisNoteFeed = {
  version: number
  builtAt: string
  publishedAt: string
  checksum: string
  rows: AnalysisNoteFeedRow[]
  tags: TagDatasetRow[]
  notice: string
  pendingChanges: number
  building: boolean
  interrupted: boolean
  noteStale: boolean
  totals: TaggedDataset['totals']
}

export type TagWorkbench = {
  dataset: TagDatasetView
  tags: TagCatalogItem[]
  activeRelations: TagRelation[]
  removedRelations: TagRelation[]
  recentEvents: TagUsageEvent[]
  notes: NoteRef[]
  datasets: string[]
  publishSummary: string
  autoRecompute: boolean
  relationsTotal: number
  relationsActive: number
  eventsTotal: number
  mergedWrites: number
}

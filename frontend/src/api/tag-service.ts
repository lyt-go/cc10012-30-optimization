import { listRows, resetRows, saveRows } from '@/data/local-store'
import { runAction } from '@/api/local-service'
import {
  loadTagLedger,
  relationKey,
  resetTagLedger,
  saveTagLedger,
  type TagLedgerState,
} from '@/data/tag-store'
import type {
  AnalysisNoteFeed,
  AnalysisNoteFeedRow,
  NoteRef,
  RecomputeChange,
  RecomputeDraft,
  RecomputeJob,
  RecomputeResult,
  TagAuditEntry,
  TagCatalogItem,
  TagDatasetDetail,
  TagDatasetGroup,
  TagDatasetNoteRow,
  TagDatasetRelationRef,
  TagDatasetRow,
  TagDatasetView,
  TagDefinitionSource,
  TagDraftAggregate,
  TagMutationResult,
  TagRelation,
  TaggedDataset,
  TagUsageEvent,
  TagWorkbench,
  UsageWriteResult,
  VerifyItem,
  VerifyResult,
} from '@/data/tag-types'

/**
 * 标签使用统计与标签化数据集的唯一计算入口。
 *
 * 最终依据（本项目选择的存储口径）：
 * 1. 关系（标签 × 数据集）是唯一登记。重复写入同一关系只合并到该关系的同一条使用明细上
 *    （mergedWrites + history 留痕），既不新增关系也不增加频次；「最近使用明细 + 合并旧记录」
 *    就是这同一条明细，频次与最后使用时间始终来自同一边界。
 * 2. 使用频次 = 有效关系条数 = 有效明细条数；最后使用 = 这些明细中最晚的 occurredAt。
 *    二者在同一次发布里一起生成、一起回写标签定义，便于逐项核对。
 * 3. 标签化数据集按版本发布；读侧（分析笔记）始终读取最新已发布版本，
 *    重算期间、重算中断时都继续读上一份完整版本，不会看到半成品或零频次。
 * 4. 关系/标签/数据集变化只追加待重算变更；恢复重算按变更项补齐，已完成项沿用。
 */

const TAG_MODULE = 'taggroup'
const NOTE_MODULE = 'analysisnote'
const MAX_SNAPSHOTS = 12
const MAX_CHANGES = 400
const MAX_AUDIT = 200

type CatalogSnapshot = { item: TagCatalogItem; source: TagDefinitionSource }

function nowISO(): string {
  return new Date().toISOString()
}

function hashText(text: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

function checksumOf(
  snapshot: Pick<TaggedDataset, 'rows' | 'notes' | 'datasetGroups' | 'totals'>,
): string {
  return hashText(
    JSON.stringify({
      rows: snapshot.rows,
      notes: snapshot.notes,
      groups: snapshot.datasetGroups,
      totals: snapshot.totals,
    }),
  )
}

function parseFrequency(raw: unknown): number | null {
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    return Math.max(0, Math.trunc(raw))
  }
  const text = String(raw ?? '').trim()
  return /^\d+$/.test(text) ? Number(text) : null
}

function splitCodes(raw: unknown): string[] {
  return String(raw ?? '')
    .split(/[,，\s;；]+/)
    .map((item) => item.trim())
    .filter(Boolean)
}

function maxIso(values: string[]): string {
  return values.filter(Boolean).sort().at(-1) ?? ''
}

function minIso(values: string[]): string {
  return values.filter(Boolean).sort()[0] ?? ''
}

function uniqueSorted(values: (string | number)[]): string[] {
  return [...new Set(values.map((item) => String(item)).filter(Boolean))].sort()
}

function fmt(value: unknown): string {
  return value === '' || value === null || value === undefined ? '（空）' : String(value)
}

// ---------- 标签定义读取 / 来源快照 ----------

export function readTagCatalog(): TagCatalogItem[] {
  return listRows(TAG_MODULE)
    .map((row) => ({
      id: Number(row.id),
      code: String(row['标签编号'] ?? ''),
      name: String(row['标签名称'] ?? ''),
      status: String(row.status ?? ''),
      color: String(row['标签颜色'] ?? ''),
      category: String(row['所属分类'] ?? ''),
      datasetRaw: String(row['关联数据集'] ?? ''),
      frequencyRaw: parseFrequency(row['使用频次']),
      lastUsedRaw: String(row['最后使用'] ?? ''),
      createdAt: String(row['创建时间'] ?? ''),
    }))
    .filter((item) => item.code)
    .sort((left, right) => left.code.localeCompare(right.code))
}

function captureCatalog(): Map<string, CatalogSnapshot> {
  const map = new Map<string, CatalogSnapshot>()
  const capturedAt = nowISO()
  for (const item of readTagCatalog()) {
    map.set(item.code, {
      item,
      source: {
        id: item.id,
        code: item.code,
        name: item.name,
        status: item.status,
        color: item.color,
        category: item.category,
        frequency: item.frequencyRaw,
        lastUsed: item.lastUsedRaw,
        capturedAt,
      },
    })
  }
  return map
}

export function readNotes(): NoteRef[] {
  return listRows(NOTE_MODULE)
    .map((row) => ({
      id: Number(row.id),
      code: String(row['笔记编号'] ?? ''),
      title: String(row['笔记标题'] ?? ''),
      datasetId: String(row['关联数据集'] ?? ''),
      tagCodes: splitCodes(row['标签分类']),
      status: String(row.status ?? ''),
    }))
    .filter((item) => item.code)
    .sort((left, right) => left.id - right.id)
}

function noteHashOf(note: NoteRef): string {
  return hashText(
    [note.code, note.title, note.datasetId, note.status, [...note.tagCodes].sort().join(',')].join('|'),
  )
}

function noteHashesOf(notes: NoteRef[]): Record<string, string> {
  const map: Record<string, string> = {}
  for (const note of notes) {
    map[String(note.id)] = noteHashOf(note)
  }
  return map
}

function noteSignatureOf(notes: NoteRef[]): string {
  return hashText(
    Object.entries(noteHashesOf(notes))
      .map(([id, hash]) => `${id}:${hash}`)
      .sort()
      .join(';'),
  )
}

// ---------- 关系 / 明细 ----------

function activeRelationsOf(ledger: TagLedgerState, tagCode: string): TagRelation[] {
  return ledger.relations.filter((item) => item.state === 'active' && item.tagCode === tagCode)
}

function activeEventOf(ledger: TagLedgerState, key: string): TagUsageEvent | undefined {
  return ledger.events.find((item) => item.relationKey === key && item.state === 'active')
}

function detailOf(relation: TagRelation, event: TagUsageEvent): TagDatasetDetail {
  return {
    eventId: event.id,
    relationKey: relation.key,
    datasetId: relation.datasetId,
    noteId: relation.noteId,
    occurredAt: event.occurredAt,
    mergedWrites: event.mergedWrites,
    source: relation.source,
    relationRevision: relation.revision,
  }
}

function aggregateFor(ledger: TagLedgerState, tagCode: string): TagDraftAggregate {
  const details: TagDatasetDetail[] = []
  const relationKeys: string[] = []
  for (const relation of activeRelationsOf(ledger, tagCode)) {
    const event = activeEventOf(ledger, relation.key)
    if (!event) {
      continue
    }
    details.push(detailOf(relation, event))
    relationKeys.push(relation.key)
  }
  details.sort((left, right) => left.occurredAt.localeCompare(right.occurredAt))
  return { tagCode, details, relationKeys: uniqueSorted(relationKeys) }
}

function lastUsedOfDetails(details: TagDatasetDetail[]): string {
  return maxIso(details.map((detail) => detail.occurredAt))
}

function audit(ledger: TagLedgerState, entry: Omit<TagAuditEntry, 'id' | 'at'>): void {
  ledger.auditLog.unshift({ id: ledger.nextAuditId, at: nowISO(), ...entry })
  ledger.nextAuditId += 1
  if (ledger.auditLog.length > MAX_AUDIT) {
    ledger.auditLog.length = MAX_AUDIT
  }
}

function appendChange(
  ledger: TagLedgerState,
  change: { key: string; action: RecomputeChange['action']; tagCode: string; note: string },
): number {
  const seq = ledger.nextSeq
  ledger.nextSeq += 1
  ledger.changes.push({ ...change, seq, at: nowISO() })
  if (ledger.changes.length > MAX_CHANGES) {
    ledger.changes = ledger.changes.slice(-MAX_CHANGES)
  }
  return seq
}

function pendingChangesOf(ledger: TagLedgerState): RecomputeChange[] {
  return ledger.changes
    .filter((change) => change.seq > ledger.stableSeq)
    .sort((left, right) => right.seq - left.seq)
}

/**
 * 对外展示的待重算清单：显式变更 + 标签定义漂移（名称 / 状态 / 分类被改）+
 * 笔记关联变化。漂移项没有 seq，用负数序号排在同一份清单里，避免「显示 3 个待重算但清单为空」。
 */
function pendingChangesDetailed(ledger: TagLedgerState): RecomputeChange[] {
  const explicit = pendingChangesOf(ledger)
  const explicitTags = new Set(explicit.map((change) => change.tagCode))
  const snapshot = ledger.snapshots.at(-1)
  const catalog = captureCatalog()
  const derived: RecomputeChange[] = []
  // 派生项的展示时间取上一份完整版本的发布时间，保证多次读取看到的是同一份清单。
  const seenAt = snapshot?.publishedAt ?? nowISO()
  let index = 1
  for (const tag of catalogDriftTags(snapshot, catalog).values()) {
    if (explicitTags.has(tag)) {
      continue
    }
    const entry = catalog.get(tag)
    derived.push({
      key: tag,
      action: entry ? 'tag-updated' : 'tag-removed',
      tagCode: tag,
      seq: -index,
      at: seenAt,
      note: entry
        ? `标签定义 ${tag} 的名称 / 状态 / 分类有变化，尚未进入标签化数据集`
        : `标签 ${tag} 已删除，等待重算从标签化数据集移除`,
    })
    index += 1
  }
  for (const tag of noteDriftTags(snapshot, readNotes())) {
    if (explicitTags.has(tag) || derived.some((item) => item.tagCode === tag)) {
      continue
    }
    derived.push({
      key: tag,
      action: 'tag-updated',
      tagCode: tag,
      seq: -index,
      at: seenAt,
      note: '笔记关联的标签有变化，等待重算刷新笔记视图',
    })
    index += 1
  }
  return [...explicit, ...derived]
}

// ---------- 快照构建 ----------

function buildRow(
  tagCode: string,
  aggregate: TagDraftAggregate | undefined,
  catalog: CatalogSnapshot,
  captured: TagDefinitionSource | undefined,
): TagDatasetRow {
  const details = aggregate ? [...aggregate.details] : []
  const frequency = details.length
  const lastUsed = lastUsedOfDetails(details)
  const firstUsed = minIso(details.map((detail) => detail.occurredAt))
  const datasetIds = uniqueSorted(details.map((detail) => detail.datasetId))
  const source = captured ?? catalog.source
  const frequencyConsistent = source.frequency === frequency
  const lastUsedConsistent = source.lastUsed === lastUsed
  const corrections: string[] = []
  if (source.frequency === null) {
    corrections.push(`标签定义「使用频次」不是数字（${fmt(source.frequency)}），已按明细写为 ${frequency}`)
  } else if (!frequencyConsistent) {
    corrections.push(`使用频次 ${source.frequency} → ${frequency}`)
  }
  if (!lastUsedConsistent) {
    corrections.push(`最后使用 ${source.lastUsed || '（空）'} → ${lastUsed || '（空）'}`)
  }
  return {
    tagId: catalog.item.id,
    tagCode,
    tagName: catalog.item.name,
    tagStatus: catalog.item.status,
    color: catalog.item.color,
    category: catalog.item.category,
    frequency,
    lastUsed,
    firstUsed,
    detailCount: details.length,
    relationKeys: uniqueSorted(details.map((detail) => detail.relationKey)),
    eventIds: details.map((detail) => detail.eventId),
    datasetIds,
    noteIds: [...new Set(details.map((detail) => detail.noteId).filter((id): id is number => typeof id === 'number'))].sort(
      (left, right) => left - right,
    ),
    details,
    sourceDefinition: source,
    definitionAfter: {
      frequency,
      lastUsed,
      datasets: datasetIds.join(','),
      syncedAt: nowISO(),
    },
    frequencyConsistent,
    lastUsedConsistent,
    consistent: frequencyConsistent && lastUsedConsistent,
    corrections,
    issues: frequencyConsistent && lastUsedConsistent ? [] : [`构建输入已修正：${corrections.join('；')}`],
  }
}

function buildNotes(rows: TagDatasetRow[], notes: NoteRef[]): TagDatasetNoteRow[] {
  const rowMap = new Map(rows.map((row) => [row.tagCode, row]))
  const result: TagDatasetNoteRow[] = []
  for (const note of notes) {
    for (const tagCode of note.tagCodes) {
      const row = rowMap.get(tagCode)
      if (!row) {
        continue
      }
      // 笔记按标签整体的使用频次 / 最后使用检索，另给出这条笔记自己的明细条数。
      const own = row.details.filter((detail) => detail.noteId === note.id)
      result.push({
        noteId: note.id,
        noteCode: note.code,
        title: note.title,
        datasetId: note.datasetId,
        tagCode,
        tagName: row.tagName,
        frequency: row.frequency,
        lastUsed: row.lastUsed,
        detailCount: own.length,
      })
    }
  }
  return result.sort((left, right) =>
    left.noteId === right.noteId ? left.tagCode.localeCompare(right.tagCode) : left.noteId - right.noteId,
  )
}

function buildGroups(rows: TagDatasetRow[]): TagDatasetGroup[] {
  const map = new Map<string, TagDatasetGroup & { tagSet: Set<string> }>()
  for (const row of rows) {
    for (const detail of row.details) {
      const current =
        map.get(detail.datasetId) ??
        {
          datasetId: detail.datasetId,
          tagCodes: [],
          tagCount: 0,
          detailCount: 0,
          frequency: 0,
          lastUsed: '',
          tagSet: new Set<string>(),
        }
      current.tagSet.add(row.tagCode)
      current.detailCount += 1
      current.frequency += 1
      current.lastUsed = maxIso([current.lastUsed, detail.occurredAt])
      map.set(detail.datasetId, current)
    }
  }
  return [...map.values()]
    .map((group) => ({
      datasetId: group.datasetId,
      tagCodes: [...group.tagSet].sort(),
      tagCount: group.tagSet.size,
      detailCount: group.detailCount,
      frequency: group.frequency,
      lastUsed: group.lastUsed,
    }))
    .sort((left, right) => left.datasetId.localeCompare(right.datasetId))
}

function buildRelationRefs(rows: TagDatasetRow[]): TagDatasetRelationRef[] {
  const refs: TagDatasetRelationRef[] = []
  for (const row of rows) {
    for (const detail of row.details) {
      refs.push({
        key: detail.relationKey,
        tagCode: row.tagCode,
        tagName: row.tagName,
        datasetId: detail.datasetId,
        noteId: detail.noteId,
        createdAt: detail.occurredAt,
        revision: detail.relationRevision,
        source: detail.source,
      })
    }
  }
  return refs.sort((left, right) => left.key.localeCompare(right.key))
}

function buildEventRefs(rows: TagDatasetRow[]): TaggedDataset['events'] {
  const refs: TaggedDataset['events'] = []
  for (const row of rows) {
    for (const detail of row.details) {
      refs.push({
        id: detail.eventId,
        relationKey: detail.relationKey,
        tagCode: row.tagCode,
        tagName: row.tagName,
        datasetId: detail.datasetId,
        noteId: detail.noteId,
        occurredAt: detail.occurredAt,
        source: detail.source,
        mergedWrites: detail.mergedWrites,
      })
    }
  }
  return refs.sort((left, right) => left.id - right.id)
}

function totalsOf(rows: TagDatasetRow[], notes: TagDatasetNoteRow[]): TaggedDataset['totals'] {
  return {
    tags: rows.length,
    relations: rows.reduce((sum, row) => sum + row.relationKeys.length, 0),
    events: rows.reduce((sum, row) => sum + row.details.length, 0),
    notes: new Set(notes.map((note) => note.noteId)).size,
    frequency: rows.reduce((sum, row) => sum + row.frequency, 0),
  }
}

function composeSnapshot(
  ledger: TagLedgerState,
  jobId: string,
  version: number,
  nextRows: TagDatasetRow[],
  coveredSeq: Record<string, number>,
  buildNote: string,
): TaggedDataset {
  const rows = [...nextRows].sort((left, right) => left.tagCode.localeCompare(right.tagCode))
  const notes = readNotes()
  const noteRows = buildNotes(rows, notes)
  const datasetGroups = buildGroups(rows)
  const totals = totalsOf(rows, noteRows)
  const snapshot: TaggedDataset = {
    schemaVersion: 1,
    version,
    builtAt: nowISO(),
    publishedAt: nowISO(),
    jobId,
    status: 'published',
    rows,
    notes: noteRows,
    datasetGroups,
    relations: buildRelationRefs(rows),
    events: buildEventRefs(rows),
    totals,
    sourceCapturedAt: maxIso(rows.map((row) => row.sourceDefinition.capturedAt)),
    noteSignature: noteSignatureOf(notes),
    noteHashes: noteHashesOf(notes),
    checksum: '',
    buildNote,
    relationSignature: hashText(rows.flatMap((row) => row.relationKeys).sort().join(';')),
    catalogSignature: hashText(
      rows
        .map((row) => [row.tagCode, row.tagName, row.tagStatus, row.color, row.category].join('|'))
        .sort()
        .join(';'),
    ),
    coveredSeq,
  }
  snapshot.checksum = checksumOf(snapshot)
  return snapshot
}

function writeBackDefinitions(snapshot: TaggedDataset): void {
  const byCode = new Map(snapshot.rows.map((row) => [row.tagCode, row]))
  saveRows(
    TAG_MODULE,
    listRows(TAG_MODULE).map((row) => {
      const computed = byCode.get(String(row['标签编号'] ?? ''))
      return {
        ...row,
        '使用频次': String(computed?.frequency ?? 0),
        '最后使用': computed?.lastUsed ?? '',
        '关联数据集': computed?.definitionAfter.datasets ?? '',
      }
    }),
  )
}

// ---------- 待重算判定 ----------

function tagsWithPendingChanges(ledger: TagLedgerState): Set<string> {
  const tags = new Set<string>()
  for (const change of ledger.changes) {
    if (change.seq > ledger.stableSeq) {
      tags.add(change.tagCode)
    }
  }
  return tags
}

/**
 * 标签定义与上一份完整版本之间的漂移。
 * 除了名称 / 状态 / 分类，也包含定义里的「使用频次 / 最后使用」被改成旧值或手工改动的场景——
 * 这类漂移必须重算纠正，否则分析笔记会按错误频次排序。
 */
function catalogDriftTags(
  snapshot: TaggedDataset | undefined,
  catalog: Map<string, CatalogSnapshot>,
): Set<string> {
  const tags = new Set<string>()
  if (!snapshot) {
    return new Set(catalog.keys())
  }
  const seen = new Set<string>()
  for (const row of snapshot.rows) {
    seen.add(row.tagCode)
    const entry = catalog.get(row.tagCode)
    if (!entry) {
      tags.add(row.tagCode)
      continue
    }
    if (
      entry.item.name !== row.tagName ||
      entry.item.status !== row.tagStatus ||
      entry.item.color !== row.color ||
      entry.item.category !== row.category ||
      entry.source.frequency !== row.frequency ||
      entry.source.lastUsed !== row.lastUsed
    ) {
      tags.add(row.tagCode)
    }
  }
  for (const code of catalog.keys()) {
    if (!seen.has(code)) {
      tags.add(code)
    }
  }
  return tags
}

/** 笔记侧变化只影响「标签 ↔ 笔记」的对应关系，只把受影响的标签排进重算。 */
function noteDriftTags(snapshot: TaggedDataset | undefined, notes: NoteRef[]): Set<string> {
  const tags = new Set<string>()
  if (!snapshot) {
    return tags
  }
  const previousHashes = snapshot.noteHashes ?? {}
  const currentHashes = noteHashesOf(notes)
  const previousTags = new Map<number, string[]>()
  for (const item of snapshot.notes) {
    const bucket = previousTags.get(item.noteId) ?? []
    bucket.push(item.tagCode)
    previousTags.set(item.noteId, bucket)
  }
  const currentTags = new Map<number, string[]>(notes.map((note) => [note.id, note.tagCodes]))
  const noteIds = new Set<number>([
    ...Object.keys(previousHashes).map(Number),
    ...Object.keys(currentHashes).map(Number),
  ])
  for (const noteId of noteIds) {
    const changed = previousHashes[String(noteId)] !== currentHashes[String(noteId)]
    if (!changed) {
      continue
    }
    for (const code of new Set([...(previousTags.get(noteId) ?? []), ...(currentTags.get(noteId) ?? [])])) {
      tags.add(code)
    }
  }
  return tags
}

function notesChanged(snapshot: TaggedDataset | undefined, notes: NoteRef[]): boolean {
  return !!snapshot && noteDriftTags(snapshot, notes).size > 0
}

export function pendingTagCodes(ledger: TagLedgerState): string[] {
  const snapshot = ledger.snapshots.at(-1)
  const pending = tagsWithPendingChanges(ledger)
  for (const tag of catalogDriftTags(snapshot, captureCatalog())) {
    pending.add(tag)
  }
  for (const tag of noteDriftTags(snapshot, readNotes())) {
    pending.add(tag)
  }
  return [...pending].sort()
}

// ---------- 重算任务 ----------

function seqMapOf(ledger: TagLedgerState): Map<string, number> {
  const map = new Map<string, number>()
  for (const change of ledger.changes) {
    if (change.seq > ledger.stableSeq) {
      map.set(change.tagCode, Math.max(map.get(change.tagCode) ?? 0, change.seq))
    }
  }
  return map
}

function createJob(
  ledger: TagLedgerState,
  targets: string[],
  mode: 'full' | 'incremental',
  base: TaggedDataset | undefined,
): { job: RecomputeJob; draft: RecomputeDraft } {
  const seqMap = seqMapOf(ledger)
  const targetVersion = (base?.version ?? 0) + 1
  const jobId = `RC-${targetVersion}-${ledger.nextSeq}`
  const coveredSeq: Record<string, number> = { ...(base?.coveredSeq ?? {}) }
  const targetSeq: Record<string, number> = {}
  for (const tag of targets) {
    // 只有显式变更才有序号；纯标签定义漂移不推进变更游标，避免误清掉别的标签的待重算项。
    const seq = seqMap.get(tag) ?? 0
    targetSeq[tag] = seq
    coveredSeq[tag] = Math.max(coveredSeq[tag] ?? 0, seq)
  }
  const job: RecomputeJob = {
    jobId,
    mode,
    targetVersion,
    baseVersion: base?.version ?? 0,
    baseSeq: ledger.stableSeq,
    status: 'running',
    pending: [...targets],
    processed: [],
    failed: [],
    processedSeq: {},
    targetSeq,
    startedAt: nowISO(),
    updatedAt: nowISO(),
    finishedAt: '',
    attempts: 1,
    lastError: '',
    changes: pendingChangesOf(ledger),
  }
  const draft: RecomputeDraft = {
    jobId,
    targetVersion,
    baseVersion: base?.version ?? 0,
    aggregates: {},
    sourceByTag: {},
    createdAt: nowISO(),
    updatedAt: nowISO(),
    catalogSignature: '',
    relationSignature: '',
    noteSignature: noteSignatureOf(readNotes()),
    noteHashes: noteHashesOf(readNotes()),
    coveredSeq,
  }
  const catalog = captureCatalog()
  for (const tag of targets) {
    draft.aggregates[tag] = aggregateFor(ledger, tag)
    const entry = catalog.get(tag)
    if (entry) {
      draft.sourceByTag[tag] = entry.source
    }
  }
  draft.relationSignature = hashText(
    Object.values(draft.aggregates).flatMap((aggregate) => aggregate.relationKeys).sort().join(';'),
  )
  draft.catalogSignature = hashText(
    Object.values(draft.sourceByTag)
      .map((source) => [source.code, source.name, source.status].join('|'))
      .sort()
      .join(';'),
  )
  return { job, draft }
}

function publish(
  ledger: TagLedgerState,
  job: RecomputeJob,
  draft: RecomputeDraft,
  buildNote: string,
): void {
  // 任务可能跨多次尝试：中断前已算好的标签也必须进最终版本，否则会丢掉中间结果。
  const processed = [...job.processed]
  const base = ledger.snapshots.at(-1)
  const catalog = captureCatalog()
  const rowMap = new Map<string, TagDatasetRow>()
  if (job.mode === 'incremental' && base) {
    for (const row of base.rows) {
      rowMap.set(row.tagCode, row)
    }
  }
  for (const tag of processed) {
    const entry = catalog.get(tag)
    if (!entry) {
      rowMap.delete(tag)
      continue
    }
    rowMap.set(tag, buildRow(tag, draft.aggregates[tag], entry, draft.sourceByTag[tag]))
  }
  // 不在标签定义里的标签不能出现在标签化数据集里。
  for (const code of [...rowMap.keys()]) {
    if (!catalog.has(code)) {
      rowMap.delete(code)
    }
  }
  const coveredSeq: Record<string, number> = { ...(base?.coveredSeq ?? {}) }
  for (const tag of processed) {
    const seq = job.targetSeq[tag] ?? 0
    coveredSeq[tag] = Math.max(coveredSeq[tag] ?? 0, seq)
  }
  for (const code of Object.keys(coveredSeq)) {
    if (!rowMap.has(code)) {
      delete coveredSeq[code]
    }
  }
  const snapshot = composeSnapshot(
    ledger,
    job.jobId,
    job.targetVersion,
    [...rowMap.values()],
    coveredSeq,
    buildNote,
  )
  ledger.snapshots.push(snapshot)
  if (ledger.snapshots.length > MAX_SNAPSHOTS) {
    ledger.snapshots.splice(0, ledger.snapshots.length - MAX_SNAPSHOTS)
  }
  for (const seq of Object.values(job.processedSeq)) {
    ledger.stableSeq = Math.max(ledger.stableSeq, seq)
  }
  ledger.stableSeq = Math.max(ledger.stableSeq, job.baseSeq)
  ledger.stableVersion = snapshot.version
  writeBackDefinitions(snapshot)
  ledger.changes = ledger.changes.filter((change) => change.seq > ledger.stableSeq)
  ledger.job = { ...job, status: 'completed' as const }
  ledger.draft = null
  const corrections = snapshot.rows
    .filter((row) => processed.includes(row.tagCode) && row.corrections.length > 0)
    .map((row) => `${row.tagCode}: ${row.corrections.join('，')}`)
  audit(ledger, {
    action: '发布标签化数据集',
    tagCode: processed.join(','),
    relationKey: '',
    detail: `版本 v${snapshot.version}，标签 ${snapshot.totals.tags} 个，关系 ${snapshot.totals.relations} 条，明细 ${snapshot.totals.events} 条；${
      corrections.length > 0 ? `修正 ${corrections.join('；')}` : '频次与最后使用无需修正'
    }；校验指纹 ${snapshot.checksum}`,
    actor: '重算任务',
  })
}

function mergeLateChanges(
  ledger: TagLedgerState,
  job: RecomputeJob,
  draft: RecomputeDraft,
): string[] {
  const seqMap = seqMapOf(ledger)
  const catalog = captureCatalog()
  const late: string[] = []
  for (const [tag, seq] of seqMap) {
    if (job.pending.includes(tag)) {
      if (seq > (job.targetSeq[tag] ?? 0)) {
        job.targetSeq[tag] = seq
        draft.aggregates[tag] = aggregateFor(ledger, tag)
        draft.coveredSeq[tag] = Math.max(draft.coveredSeq[tag] ?? 0, seq)
      }
      continue
    }
    const processedAt = job.processedSeq[tag]
    if (processedAt !== undefined && seq <= processedAt) {
      continue
    }
    job.pending.push(tag)
    job.targetSeq[tag] = seq
    draft.aggregates[tag] = aggregateFor(ledger, tag)
    draft.coveredSeq[tag] = Math.max(draft.coveredSeq[tag] ?? 0, seq)
    const entry = catalog.get(tag)
    if (entry) {
      draft.sourceByTag[tag] = entry.source
    }
    late.push(tag)
  }
  return late
}

function runJob(
  ledger: TagLedgerState,
  setup: { job: RecomputeJob; draft: RecomputeDraft; resume: boolean },
  limit: number | null,
  failAfter: number | null,
): RecomputeResult {
  const { job, draft } = setup
  if (setup.resume) {
    job.status = 'running'
    job.failed = []
    job.lastError = ''
    job.attempts += 1
    audit(ledger, {
      action: '恢复重算',
      tagCode: job.pending.join(','),
      relationKey: '',
      detail: `任务 ${job.jobId} 第 ${job.attempts} 次执行，仅补 ${job.pending.length} 项缺口`,
      actor: '重算任务',
    })
  }
  // 任务执行期间可能又产生了新变更（中断期间尤其常见）：并入待处理缺口，
  // 已经在本次任务里算过且没有新变更的标签不重复处理。
  const lateAdded = mergeLateChanges(ledger, job, draft)
  if (lateAdded.length > 0) {
    audit(ledger, {
      action: '并入缺口',
      tagCode: lateAdded.join(','),
      relationKey: '',
      detail: `任务 ${job.jobId} 第 ${job.attempts} 次执行时并入 ${lateAdded.length} 个新变更标签`,
      actor: '重算任务',
    })
  }
  const processedNow: string[] = []
  let stopped = false
  while (job.pending.length > 0) {
    if (failAfter !== null && processedNow.length >= failAfter) {
      job.status = 'failed'
      job.failed = [...job.pending]
      job.lastError = `重算在「${job.pending[0]}」处中断`
      job.updatedAt = nowISO()
      ledger.job = job
      ledger.draft = draft
      audit(ledger, {
        action: '重算中断',
        tagCode: job.pending[0],
        relationKey: '',
        detail: `任务 ${job.jobId} 中断，剩余 ${job.pending.length} 项；稳定版本 v${ledger.stableVersion} 继续对外`,
        actor: '重算任务',
      })
      stopped = true
      break
    }
    if (limit !== null && processedNow.length >= limit) {
      break
    }
    const tag = job.pending.shift() as string
    // 重算时重新读取标签定义：来源快照反映「这一项处理当时的定义值」。
    const entry = captureCatalog().get(tag)
    if (entry) {
      draft.sourceByTag[tag] = entry.source
    } else {
      delete draft.sourceByTag[tag]
    }
    draft.aggregates[tag] = aggregateFor(ledger, tag)
    if (!job.processed.includes(tag)) {
      job.processed.push(tag)
    }
    job.processedSeq[tag] = job.targetSeq[tag] ?? 0
    processedNow.push(tag)
  }

  if (stopped) {
    saveTagLedger(ledger)
    return {
      ok: false,
      status: 'failed',
      message: job.lastError,
      jobId: job.jobId,
      version: ledger.stableVersion,
      processed: job.processed.length,
      pending: job.pending.length,
    }
  }
  if (job.pending.length > 0) {
    job.updatedAt = nowISO()
    ledger.job = job
    ledger.draft = draft
    saveTagLedger(ledger)
    return {
      ok: true,
      status: 'noop',
      message: `重算进行中：已处理 ${job.processed.length} 项，剩余 ${job.pending.length} 项；分析笔记仍读取 v${ledger.stableVersion}`,
      jobId: job.jobId,
      version: ledger.stableVersion,
      processed: job.processed.length,
      pending: job.pending.length,
    }
  }
  job.status = 'completed'
  job.finishedAt = nowISO()
  job.updatedAt = job.finishedAt
  job.failed = []
  job.lastError = ''
  const buildNote =
    job.mode === 'full'
      ? '全量重算：读取全部标签定义与有效关系'
      : `增量重算：仅处理 ${job.processed.length} 个变化标签，其余沿用量 v${job.baseVersion}`
  publish(ledger, job, draft, buildNote)
  saveTagLedger(ledger)
  return {
    ok: true,
    status: 'completed',
    message: `${buildNote}，已发布 v${job.targetVersion}`,
    jobId: job.jobId,
    version: job.targetVersion,
    processed: job.processed.length,
    pending: 0,
  }
}

export type RecomputeOptions = {
  mode?: 'full' | 'incremental'
  limit?: number
  failAfter?: number | null
  resume?: boolean
}

export function runRecompute(options: RecomputeOptions = {}): RecomputeResult {
  const ledger = loadTagLedger()
  const snapshot = ledger.snapshots.at(-1)
  const mode = options.mode ?? 'incremental'
  const limit = options.limit ?? null
  const failAfter = options.failAfter ?? null

  // 中断恢复：只补齐 job.pending 里剩下的项，已完成项直接沿用上一份完整版本。
  if (mode === 'incremental' && ledger.job?.status === 'failed' && ledger.draft) {
    return runJob(ledger, { job: { ...ledger.job }, draft: ledger.draft, resume: true }, limit, failAfter)
  }
  // 未完成的任务（分步执行）继续推进；已完成的旧任务不能顶替本次新变更。
  if (mode === 'incremental' && ledger.job?.status === 'running' && ledger.draft) {
    return runJob(ledger, { job: { ...ledger.job }, draft: ledger.draft, resume: false }, limit, failAfter)
  }

  let targets: string[]
  if (mode === 'full') {
    targets = readTagCatalog().map((item) => item.code)
  } else {
    targets = pendingTagCodes(ledger)
  }
  if (targets.length === 0) {
    return {
      ok: true,
      status: 'noop',
      message: '没有待重算的标签关系，标签化数据集保持当前版本',
      jobId: '',
      version: snapshot?.version ?? 0,
      processed: 0,
      pending: 0,
    }
  }
  const created = createJob(ledger, targets, mode, snapshot)
  ledger.job = created.job
  ledger.draft = created.draft
  audit(ledger, {
    action: mode === 'full' ? '启动全量重算' : '启动增量重算',
    tagCode: targets.join(','),
    relationKey: '',
    detail: `任务 ${created.job.jobId} 覆盖 ${targets.length} 个标签，基线 v${created.job.baseVersion}`,
    actor: '重算任务',
  })
  return runJob(ledger, { job: created.job, draft: created.draft, resume: false }, limit, failAfter)
}

/**
 * 分步推进重算：第一步按当前待重算清单建任务（部分模式下只处理 steps 项后停下），
 * 之后每调用一次推进 steps 项；全部处理完才发布新版本。
 */
export function advanceRecompute(steps = 1): RecomputeResult {
  const ledger = loadTagLedger()
  const existing = ledger.job
  if (existing && existing.status !== 'completed' && ledger.draft) {
    return runRecompute({ mode: 'incremental', limit: steps })
  }
  const targets = pendingTagCodes(ledger)
  if (targets.length === 0) {
    return {
      ok: true,
      status: 'noop',
      message: '没有待重算的标签关系',
      jobId: '',
      version: ledger.stableVersion,
      processed: 0,
      pending: 0,
    }
  }
  return runRecompute({ mode: 'incremental', limit: steps })
}

// ---------- 写入关系 / 明细 ----------

export type RelationWriteInput = {
  tagCode: string
  datasetId: string
  noteId?: number | null
  actor?: string
  source?: TagRelation['source']
}

/**
 * 变更登记完成后触发增量重算。
 * 调用前必须先把账本落盘：重算会重新读取最新账本，不能让它读到旧内存副本。
 */
function applyAutoRecompute(): 'auto' | 'queued' | 'interrupted' {
  const current = loadTagLedger()
  if (!current.autoRecompute) {
    return 'queued'
  }
  if (current.job?.status === 'failed') {
    return 'interrupted'
  }
  return runRecompute({ mode: 'incremental' }).status === 'failed' ? 'interrupted' : 'auto'
}

function pendingCountNow(): number {
  return pendingTagCodes(loadTagLedger()).length
}

function stableVersionNow(): number {
  return loadTagLedger().stableVersion
}

function rejectUsage(
  message: string,
  key: string,
  frequency: number,
  lastUsed: string,
): UsageWriteResult {
  return {
    ok: false,
    kind: 'rejected',
    message,
    relationKey: key,
    eventId: 0,
    frequencyBefore: frequency,
    frequencyAfter: frequency,
    lastUsed,
    detailCount: 0,
  }
}

export function recordRelationUsage(input: RelationWriteInput): TagMutationResult {
  const ledger = loadTagLedger()
  const catalog = captureCatalog()
  const actor = input.actor ?? '值班管理员'
  const key = relationKey(input.tagCode, input.datasetId)
  const snapshotRow = ledger.snapshots.at(-1)?.rows.find((row) => row.tagCode === input.tagCode)
  const frequencyBefore = snapshotRow?.frequency ?? 0
  const lastUsedBefore = snapshotRow?.lastUsed ?? ''
  // 同一关系键可能同时存在「已移除的旧记录」和「重新登记的新记录」，必须优先拿有效的那条。
  const existing =
    ledger.relations.find((item) => item.key === key && item.state === 'active') ??
    [...ledger.relations].reverse().find((item) => item.key === key)
  const noteId = input.noteId ?? existing?.noteId ?? null

  const fail = (usage: UsageWriteResult): TagMutationResult => {
    saveTagLedger(ledger)
    return {
      ok: false,
      message: usage.message,
      changedKeys: [],
      snapshotVersion: stableVersionNow(),
      pending: pendingCountNow(),
      recomputeStatus: 'none',
      usage,
    }
  }

  if (!catalog.has(input.tagCode)) {
    return fail(rejectUsage(`没有找到标签 ${input.tagCode}，不能登记使用`, key, frequencyBefore, lastUsedBefore))
  }
  if (!input.datasetId) {
    return fail(rejectUsage('数据集不能为空', key, frequencyBefore, lastUsedBefore))
  }
  if (existing?.state === 'removed') {
    return fail(
      rejectUsage(
        `关系 ${key} 已于 ${existing.removedAt} 移除，旧关系不再增加最后使用时间；如需重新使用请先重新登记关系`,
        key,
        frequencyBefore,
        lastUsedBefore,
      ),
    )
  }

  let usage: UsageWriteResult
  const occurredAt = nowISO()
  if (existing) {
    const event = activeEventOf(ledger, key)
    if (!event) {
      return fail(rejectUsage(`关系 ${key} 缺少使用明细，请先重算修复`, key, frequencyBefore, lastUsedBefore))
    }
    // 重复写入：合并进同一条明细，关系数与频次都不变，最后使用时间也不推进。
    event.mergedWrites += 1
    event.lastMergedAt = occurredAt
    event.history.push({
      action: 'merged',
      at: occurredAt,
      note: `重复写入合并（第 ${event.mergedWrites} 次），不新增关系 / 明细`,
    })
    const backfilledNote = existing.noteId === null && typeof noteId === 'number'
    if (backfilledNote) {
      existing.noteId = noteId
      existing.revision += 1
      event.noteId = noteId
      event.relationRevision = existing.revision
    }
    // 合并写入不在频次 / 最后使用上加数，但合并次数与笔记归属属于明细内容，
    // 同样登记为待重算项，保证数据集里的明细与账本一致。
    appendChange(ledger, {
      key,
      action: 'merged',
      tagCode: input.tagCode,
      note: `重复写入 ${key} 已合并${backfilledNote ? '并补登笔记归属' : ''}，频次保持 ${frequencyBefore}`,
    })
    audit(ledger, {
      action: '合并重复使用',
      tagCode: input.tagCode,
      relationKey: key,
      detail: `第 ${event.mergedWrites} 次合并写入，频次与最后使用时间保持 ${event.occurredAt}`,
      actor,
    })
    usage = {
      ok: true,
      kind: 'merged',
      message: `关系 ${key} 已存在：本次写入合并进明细 #${event.id}，频次保持 ${frequencyBefore}，最后使用保持 ${event.occurredAt}`,
      relationKey: key,
      eventId: event.id,
      frequencyBefore,
      frequencyAfter: frequencyBefore,
      lastUsed: event.occurredAt,
      detailCount: 1,
    }
  } else {
    const relation: TagRelation = {
      key,
      tagId: catalog.get(input.tagCode)?.item.id ?? 0,
      tagCode: input.tagCode,
      tagName: catalog.get(input.tagCode)?.item.name ?? input.tagCode,
      datasetId: input.datasetId,
      noteId,
      noteCode: '',
      state: 'active',
      revision: 1,
      createdAt: occurredAt,
      createdBy: actor,
      removedAt: '',
      removedBy: '',
      source: input.source ?? 'manual',
    }
    const event: TagUsageEvent = {
      id: ledger.nextEventId,
      relationKey: key,
      relationRevision: 1,
      tagId: relation.tagId,
      tagCode: relation.tagCode,
      tagName: relation.tagName,
      datasetId: relation.datasetId,
      noteId,
      occurredAt,
      state: 'active',
      mergedWrites: 0,
      lastMergedAt: '',
      removedAt: '',
      source: relation.source,
      history: [{ action: 'created', at: occurredAt, note: '登记关系并记录首次使用' }],
    }
    ledger.nextEventId += 1
    ledger.relations.push(relation)
    ledger.events.push(event)
    appendChange(ledger, {
      key,
      action: 'added',
      tagCode: input.tagCode,
      note: `新增关系 ${key}，频次 +1`,
    })
    audit(ledger, {
      action: '登记标签关系',
      tagCode: input.tagCode,
      relationKey: key,
      detail: `关系 ${key} 使用明细 #${event.id}，数据集 ${input.datasetId}`,
      actor,
    })
    usage = {
      ok: true,
      kind: 'created',
      message: `已登记关系 ${key}，使用明细 #${event.id}`,
      relationKey: key,
      eventId: event.id,
      frequencyBefore,
      frequencyAfter: frequencyBefore + 1,
      lastUsed: occurredAt,
      detailCount: 1,
    }
  }

  saveTagLedger(ledger)
  const recomputeStatus = applyAutoRecompute()
  return {
    ok: true,
    message: `${
      recomputeStatus === 'auto'
        ? `${usage.message}；标签化数据集已按本次写入重算`
        : `${usage.message}；变更已登记，待重算`
    }（对外版本 v${stableVersionNow()}）`,
    changedKeys: [key],
    snapshotVersion: stableVersionNow(),
    pending: pendingCountNow(),
    recomputeStatus,
    usage,
  }
}

/**
 * 重新登记一个已被移除的关系：生成新的关系版本与新的使用明细（明确是一次新的使用）。
 * 已移除的旧关系不会因此恢复计数，历史明细保持 removed 供审计。
 */
export function restoreRelation(tagCode: string, datasetId: string, actor = '值班管理员'): TagMutationResult {
  const ledger = loadTagLedger()
  const key = relationKey(tagCode, datasetId)
  const relation = ledger.relations.find((item) => item.key === key && item.state === 'active')
  if (relation) {
    return {
      ok: false,
      message: `关系 ${key} 仍有效，无需重新登记`,
      changedKeys: [],
      snapshotVersion: ledger.stableVersion,
      pending: pendingTagCodes(ledger).length,
      recomputeStatus: 'none',
      usage: null,
    }
  }
  const current = loadTagLedger()
  const catalog = captureCatalog()
  if (!catalog.has(tagCode)) {
    return {
      ok: false,
      message: `没有找到标签 ${tagCode}`,
      changedKeys: [],
      snapshotVersion: current.stableVersion,
      pending: pendingTagCodes(current).length,
      recomputeStatus: 'none',
      usage: null,
    }
  }
  const at = nowISO()
  const previous = ledger.relations.filter((item) => item.key === key)
  const revision = previous.reduce((max, item) => Math.max(max, item.revision), 0) + 1
  const noteId = previous.at(-1)?.noteId ?? null
  const newRelation: TagRelation = {
    key,
    tagId: catalog.get(tagCode)?.item.id ?? 0,
    tagCode,
    tagName: catalog.get(tagCode)?.item.name ?? tagCode,
    datasetId,
    noteId,
    noteCode: '',
    state: 'active',
    revision,
    createdAt: at,
    createdBy: actor,
    removedAt: '',
    removedBy: '',
    source: 'manual',
  }
  const event: TagUsageEvent = {
    id: ledger.nextEventId,
    relationKey: key,
    relationRevision: revision,
    tagId: newRelation.tagId,
    tagCode,
    tagName: newRelation.tagName,
    datasetId,
    noteId,
    occurredAt: at,
    state: 'active',
    mergedWrites: 0,
    lastMergedAt: '',
    removedAt: '',
    source: 'manual',
    history: [{ action: 'created', at, note: `重新登记关系（r${revision}），作为一次新的使用` }],
  }
  ledger.nextEventId += 1
  ledger.relations.push(newRelation)
  ledger.events.push(event)
  appendChange(ledger, {
    key,
    action: 'added',
    tagCode,
    note: `重新登记关系 ${key}（r${revision}），频次 +1`,
  })
  audit(ledger, {
    action: '重新登记关系',
    tagCode,
    relationKey: key,
    detail: `关系 ${key} 以新版本 r${revision} 重新登记，旧明细保持已移除`,
    actor,
  })
  saveTagLedger(ledger)
  const recomputeStatus = applyAutoRecompute()
  return {
    ok: true,
    message: `已重新登记关系 ${key}（r${revision}）`,
    changedKeys: [key],
    snapshotVersion: stableVersionNow(),
    pending: pendingCountNow(),
    recomputeStatus,
    usage: null,
  }
}

export function removeRelation(tagCode: string, datasetId: string, actor = '值班管理员'): TagMutationResult {
  const ledger = loadTagLedger()
  const key = relationKey(tagCode, datasetId)
  const relation = ledger.relations.find((item) => item.key === key && item.state === 'active')
  if (!relation) {
    return {
      ok: false,
      message: `没有找到有效关系 ${key}`,
      changedKeys: [],
      snapshotVersion: ledger.stableVersion,
      pending: pendingTagCodes(ledger).length,
      recomputeStatus: 'none',
      usage: null,
    }
  }
  const at = nowISO()
  relation.state = 'removed'
  relation.removedAt = at
  relation.removedBy = actor
  const event = activeEventOf(ledger, key)
  if (event) {
    event.state = 'removed'
    event.removedAt = at
    event.history.push({ action: 'removed', at, note: '关系移除，之后不再计入频次与最后使用' })
  }
  appendChange(ledger, {
    key,
    action: 'removed',
    tagCode,
    note: `移除关系 ${key}，频次 -1，最后使用随之重算`,
  })
  audit(ledger, {
    action: '移除标签关系',
    tagCode,
    relationKey: key,
    detail: `关系 ${key} 移除；旧关系不再累加最后使用时间`,
    actor,
  })
  saveTagLedger(ledger)
  const recomputeStatus = applyAutoRecompute()
  return {
    ok: true,
    message: `已移除关系 ${key}；频次与最后使用已按剩余关系重算`,
    changedKeys: [key],
    snapshotVersion: stableVersionNow(),
    pending: pendingCountNow(),
    recomputeStatus,
    usage: null,
  }
}

export function migrateDataset(fromDataset: string, toDataset: string, actor = '值班管理员'): TagMutationResult {
  const ledger = loadTagLedger()
  if (!fromDataset || !toDataset || fromDataset === toDataset) {
    return {
      ok: false,
      message: '请填写不同的源数据集和目标数据集',
      changedKeys: [],
      snapshotVersion: ledger.stableVersion,
      pending: pendingTagCodes(ledger).length,
      recomputeStatus: 'none',
      usage: null,
    }
  }
  const moving = ledger.relations.filter(
    (item) => item.state === 'active' && item.datasetId === fromDataset,
  )
  if (moving.length === 0) {
    return {
      ok: false,
      message: `数据集 ${fromDataset} 没有可迁移的有效标签关系`,
      changedKeys: [],
      snapshotVersion: ledger.stableVersion,
      pending: pendingTagCodes(ledger).length,
      recomputeStatus: 'none',
      usage: null,
    }
  }
  const at = nowISO()
  const changedKeys: string[] = []
  for (const relation of moving) {
    const targetKey = relationKey(relation.tagCode, toDataset)
    const target = ledger.relations.find((item) => item.key === targetKey && item.state === 'active')
    const sourceEvent = activeEventOf(ledger, relation.key)
    changedKeys.push(relation.key, targetKey)
    if (target) {
      // 目标数据集已有同标签关系：迁移后合并成一条，最后使用取较晚时间，频次不重复增加。
      const targetEvent = activeEventOf(ledger, targetKey)
      if (targetEvent && sourceEvent) {
        targetEvent.occurredAt = maxIso([targetEvent.occurredAt, sourceEvent.occurredAt])
        targetEvent.history.push({
          action: 'merged',
          at,
          note: `数据集 ${fromDataset} 迁移并入，最后使用取两者较晚时间，频次不重复增加`,
        })
        if (target.noteId === null && relation.noteId !== null) {
          target.noteId = relation.noteId
          targetEvent.noteId = relation.noteId
        }
      }
    } else {
      const movedRelation: TagRelation = {
        ...relation,
        key: targetKey,
        datasetId: toDataset,
        revision: relation.revision + 1,
        source: 'migrated',
        createdAt: at,
      }
      const movedEvent: TagUsageEvent = {
        id: ledger.nextEventId,
        relationKey: targetKey,
        relationRevision: movedRelation.revision,
        tagId: relation.tagId,
        tagCode: relation.tagCode,
        tagName: relation.tagName,
        datasetId: toDataset,
        noteId: relation.noteId,
        occurredAt: sourceEvent?.occurredAt ?? at,
        state: 'active',
        mergedWrites: sourceEvent?.mergedWrites ?? 0,
        lastMergedAt: sourceEvent?.lastMergedAt ?? '',
        removedAt: '',
        source: 'migrated',
        history: [
          ...(sourceEvent?.history ?? []),
          { action: 'created', at, note: `随数据集从 ${fromDataset} 迁移到 ${toDataset}` },
        ],
      }
      ledger.nextEventId += 1
      ledger.relations.push(movedRelation)
      ledger.events.push(movedEvent)
    }
    relation.state = 'removed'
    relation.removedAt = at
    relation.removedBy = actor
    if (sourceEvent) {
      sourceEvent.state = 'removed'
      sourceEvent.removedAt = at
      sourceEvent.history.push({
        action: 'removed',
        at,
        note: target
          ? `迁移到 ${toDataset} 后与已有关系合并，源关系不再单独计数`
          : `关系迁移为 ${targetKey}`,
      })
    }
    appendChange(ledger, {
      key: targetKey,
      action: 'migrated',
      tagCode: relation.tagCode,
      note: `数据集迁移 ${fromDataset} → ${toDataset}`,
    })
  }
  ledger.migrateCount += 1
  audit(ledger, {
    action: '迁移数据集标签',
    tagCode: uniqueSorted(moving.map((item) => item.tagCode)).join(','),
    relationKey: '',
    detail: `${fromDataset} → ${toDataset}，迁移 ${moving.length} 条关系`,
    actor,
  })
  saveTagLedger(ledger)
  const recomputeStatus = applyAutoRecompute()
  return {
    ok: true,
    message: `已迁移 ${moving.length} 条关系到 ${toDataset}；频次与最后使用已重算`,
    changedKeys: uniqueSorted(changedKeys),
    snapshotVersion: stableVersionNow(),
    pending: pendingCountNow(),
    recomputeStatus,
    usage: null,
  }
}

export function createTagDefinition(input: {
  name: string
  category?: string
  color?: string
  actor?: string
}): TagMutationResult {
  const ledger = loadTagLedger()
  const name = input.name.trim()
  const rows = listRows(TAG_MODULE)
  if (!name) {
    return {
      ok: false,
      message: '标签名称不能为空',
      changedKeys: [],
      snapshotVersion: ledger.stableVersion,
      pending: pendingTagCodes(ledger).length,
      recomputeStatus: 'none',
      usage: null,
    }
  }
  const nextId = rows.reduce((max, row) => Math.max(max, Number(row.id)), 0) + 1
  const code = `TAGG-${String(nextId).padStart(4, '0')}`
  const created = nowISO()
  saveRows(TAG_MODULE, [
    ...rows,
    {
      id: nextId,
      status: '草稿',
      pending: true,
      abnormal: false,
      '标签编号': code,
      '标签名称': name,
      '标签颜色': input.color ?? '#1f6feb',
      '所属分类': input.category ?? '未分类',
      '关联数据集': '',
      '使用频次': '0',
      '创建时间': created.slice(0, 10),
      '最后使用': '',
    },
  ])
  appendChange(ledger, {
    key: code,
    action: 'tag-added',
    tagCode: code,
    note: `新增标签定义 ${code} ${name}`,
  })
  audit(ledger, {
    action: '新增标签定义',
    tagCode: code,
    relationKey: '',
    detail: `标签 ${name} 加入标签定义，频次从 0 起算`,
    actor: input.actor ?? '值班管理员',
  })
  saveTagLedger(ledger)
  const recomputeStatus = applyAutoRecompute()
  return {
    ok: true,
    message: `已新增标签 ${code} ${name}`,
    changedKeys: [code],
    snapshotVersion: stableVersionNow(),
    pending: pendingCountNow(),
    recomputeStatus,
    usage: null,
  }
}

export function deleteTagDefinition(tagCode: string, actor = '值班管理员'): TagMutationResult {
  const ledger = loadTagLedger()
  const rows = listRows(TAG_MODULE)
  if (!rows.some((row) => row['标签编号'] === tagCode)) {
    return {
      ok: false,
      message: `没有找到标签 ${tagCode}`,
      changedKeys: [],
      snapshotVersion: ledger.stableVersion,
      pending: pendingTagCodes(ledger).length,
      recomputeStatus: 'none',
      usage: null,
    }
  }
  const at = nowISO()
  const changedKeys: string[] = [tagCode]
  for (const relation of ledger.relations.filter(
    (item) => item.state === 'active' && item.tagCode === tagCode,
  )) {
    relation.state = 'removed'
    relation.removedAt = at
    relation.removedBy = actor
    changedKeys.push(relation.key)
    const event = activeEventOf(ledger, relation.key)
    if (event) {
      event.state = 'removed'
      event.removedAt = at
      event.history.push({ action: 'removed', at, note: '标签定义删除，关系一并失效' })
    }
  }
  saveRows(
    TAG_MODULE,
    rows.filter((row) => row['标签编号'] !== tagCode),
  )
  appendChange(ledger, {
    key: tagCode,
    action: 'tag-removed',
    tagCode,
    note: `删除标签定义 ${tagCode}，其关系全部失效`,
  })
  audit(ledger, {
    action: '删除标签定义',
    tagCode,
    relationKey: '',
    detail: `标签 ${tagCode} 及其有效关系失效，旧关系不再累加最后使用`,
    actor,
  })
  saveTagLedger(ledger)
  const recomputeStatus = applyAutoRecompute()
  return {
    ok: true,
    message: `已删除标签 ${tagCode}`,
    changedKeys: uniqueSorted(changedKeys),
    snapshotVersion: stableVersionNow(),
    pending: pendingCountNow(),
    recomputeStatus,
    usage: null,
  }
}

/** 标签定义的状态流转仍走 local-service 的统一动作表，再触发一次增量重算。 */
export function applyTagAction(id: number, action: string): TagMutationResult {
  const result = runAction(TAG_MODULE, id, action)
  if (!result.ok) {
    return {
      ok: false,
      message: result.message,
      changedKeys: [],
      snapshotVersion: loadTagLedger().stableVersion,
      pending: pendingCountNow(),
      recomputeStatus: 'none',
      usage: null,
    }
  }
  const code = String(listRows(TAG_MODULE).find((row) => Number(row.id) === id)?.['标签编号'] ?? '')
  if (code) {
    const ledger = loadTagLedger()
    appendChange(ledger, {
      key: code,
      action: 'tag-updated',
      tagCode: code,
      note: `标签状态流转「${action}」，需要重算刷新标签化数据集`,
    })
    saveTagLedger(ledger)
  }
  const recomputeStatus = applyAutoRecompute()
  return {
    ok: true,
    message: `${result.message}；${recomputeStatus === 'auto' ? '标签化数据集已重算' : '待重算'}`,
    changedKeys: [code],
    snapshotVersion: stableVersionNow(),
    pending: pendingCountNow(),
    recomputeStatus,
    usage: null,
  }
}

export function setAutoRecompute(enabled: boolean): void {
  const ledger = loadTagLedger()
  ledger.autoRecompute = enabled
  audit(ledger, {
    action: enabled ? '开启自动重算' : '改为手动重算',
    tagCode: '',
    relationKey: '',
    detail: enabled ? '关系变化后自动做增量重算' : '关系变化只登记待重算',
    actor: '值班管理员',
  })
  saveTagLedger(ledger)
}

// ---------- 读侧 ----------

function ensureStableSnapshot(): void {
  const ledger = loadTagLedger()
  if (ledger.snapshots.length === 0) {
    runRecompute({ mode: 'full' })
  }
}

export function loadTagDatasetView(): TagDatasetView {
  ensureStableSnapshot()
  const ledger = loadTagLedger()
  const snapshot = ledger.snapshots.at(-1) as TaggedDataset
  const job = ledger.job
  const pendingChanges = pendingChangesDetailed(ledger)
  const pendingKeys = pendingTagCodes(ledger)
  const interrupted = job?.status === 'failed'
  const building = job?.status === 'running'
  let notice = `稳定版本 v${snapshot.version}（发布于 ${snapshot.publishedAt}）：${snapshot.totals.tags} 个标签 / ${snapshot.totals.relations} 条关系 / ${snapshot.totals.events} 条使用明细`
  if (interrupted) {
    notice = `重算中断：${job?.lastError || '任务失败'}。分析笔记继续读取上一份完整版本 v${snapshot.version}；剩余 ${job?.pending.length ?? 0} 项，可继续重算补齐。`
  } else if (building) {
    const total = (job?.processed.length ?? 0) + (job?.pending.length ?? 0)
    notice = `重算进行中：已处理 ${job?.processed.length ?? 0}/${total} 项，读取侧仍使用上一份完整版本 v${snapshot.version}`
  } else if (pendingKeys.length > 0) {
    notice = `有 ${pendingKeys.length} 个标签的关系变更待重算，当前对外仍是 v${snapshot.version}`
  }
  return {
    snapshot,
    versions: ledger.snapshots
      .map((item) => ({
        version: item.version,
        builtAt: item.builtAt,
        publishedAt: item.publishedAt,
        checksum: item.checksum,
        tags: item.totals.tags,
        relations: item.totals.relations,
        events: item.totals.events,
        notes: item.totals.notes,
        jobId: item.jobId,
        buildNote: item.buildNote,
      }))
      .sort((left, right) => right.version - left.version),
    stableVersion: snapshot.version,
    building,
    interrupted,
    pendingChanges,
    pendingKeys,
    job: job ?? null,
    notice,
    auditLog: ledger.auditLog.slice(0, 80),
  }
}

export function loadTagWorkbench(): TagWorkbench {
  const dataset = loadTagDatasetView()
  const ledger = loadTagLedger()
  const activeRelations = ledger.relations
    .filter((item) => item.state === 'active')
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
  const removedRelations = ledger.relations
    .filter((item) => item.state === 'removed')
    .sort((left, right) => right.removedAt.localeCompare(left.removedAt))
  const recentEvents = [...ledger.events]
    .sort((left, right) => right.occurredAt.localeCompare(left.occurredAt))
    .slice(0, 24)
  const datasets = uniqueSorted([
    ...ledger.relations.map((item) => item.datasetId),
    ...readNotes().map((note) => note.datasetId),
  ])
  return {
    dataset,
    tags: readTagCatalog(),
    activeRelations,
    removedRelations,
    recentEvents,
    notes: readNotes(),
    datasets,
    publishSummary: `v${dataset.stableVersion} · ${dataset.snapshot.buildNote}`,
    autoRecompute: ledger.autoRecompute,
    relationsTotal: ledger.relations.length,
    relationsActive: activeRelations.length,
    eventsTotal: ledger.events.length,
    mergedWrites: ledger.events.reduce((sum, event) => sum + event.mergedWrites, 0),
  }
}

export function loadTagDatasetVersion(version: number): TaggedDataset | null {
  return loadTagLedger().snapshots.find((item) => item.version === version) ?? null
}

/** 导出标签化数据集：频次、最后使用与明细逐项可回查。 */
export function exportTagDataset(): { filename: string; content: string } {
  const view = loadTagDatasetView()
  const snapshot = view.snapshot
  const header = [
    '版本',
    '标签编号',
    '标签名称',
    '使用频次',
    '最后使用',
    '首次使用',
    '使用明细数',
    '关系键',
    '使用明细ID',
    '数据集',
    '来源定义频次',
    '来源定义最后使用',
    '频次一致',
    '最后使用一致',
    '校验指纹',
  ]
  const lines = [header.join(',')]
  for (const row of snapshot.rows) {
    lines.push(
      [
        snapshot.version,
        row.tagCode,
        row.tagName,
        row.frequency,
        row.lastUsed,
        row.firstUsed,
        row.detailCount,
        row.relationKeys.join('|'),
        row.eventIds.join('|'),
        row.datasetIds.join('|'),
        fmt(row.sourceDefinition.frequency),
        fmt(row.sourceDefinition.lastUsed),
        row.frequencyConsistent ? '是' : '否',
        row.lastUsedConsistent ? '是' : '否',
        snapshot.checksum,
      ].join(','),
    )
  }
  return { filename: `标签化数据集-v${snapshot.version}.csv`, content: `\uFEFF${lines.join('\n')}` }
}

export function downloadTagDataset(): void {
  const { filename, content } = exportTagDataset()
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}


// ---------- 校验 ----------

export function verifyTagDataset(): VerifyResult {
  const view = loadTagDatasetView()
  const snapshot = view.snapshot
  const catalog = new Map(readTagCatalog().map((item) => [item.code, item]))
  const ledger = loadTagLedger()
  const liveMap = new Map<string, TagDraftAggregate>()
  for (const tagCode of new Set(ledger.relations.map((item) => item.tagCode))) {
    liveMap.set(tagCode, aggregateFor(ledger, tagCode))
  }
  const pending = view.pendingKeys.length
  const items: VerifyItem[] = []
  const push = (item: Omit<VerifyItem, 'expected'> & { expected?: boolean }): void => {
    items.push({ expected: false, ...item })
  }

  for (const row of snapshot.rows) {
    push({
      scope: '快照内部',
      tagCode: row.tagCode,
      tagName: row.tagName,
      field: '使用频次',
      datasetValue: fmt(row.frequency),
      comparedValue: fmt(row.detailCount),
      ok: row.frequency === row.detailCount,
      note: '频次应等于快照内有效明细条数',
    })
    push({
      scope: '快照内部',
      tagCode: row.tagCode,
      tagName: row.tagName,
      field: '最后使用',
      datasetValue: fmt(row.lastUsed),
      comparedValue: fmt(lastUsedOfDetails(row.details)),
      ok: row.lastUsed === lastUsedOfDetails(row.details),
      note: '最后使用应等于快照内明细的最晚时间',
    })
    push({
      scope: '快照内部',
      tagCode: row.tagCode,
      tagName: row.tagName,
      field: '关系 / 明细',
      datasetValue: `${row.relationKeys.length} 条关系`,
      comparedValue: `${row.details.length} 条明细`,
      ok: row.relationKeys.length === row.details.length,
      note: '一条有效关系只保留一条使用明细，重复写入合并后数量应相等',
    })
    const groupDatasets = snapshot.datasetGroups
      .filter((group) => group.tagCodes.includes(row.tagCode))
      .map((group) => group.datasetId)
      .sort()
    push({
      scope: '快照内部',
      tagCode: row.tagCode,
      tagName: row.tagName,
      field: '数据集覆盖',
      datasetValue: fmt(row.datasetIds.join(',')),
      comparedValue: fmt(groupDatasets.join(',')),
      ok: groupDatasets.join(',') === row.datasetIds.join(','),
      note: '标签涉及的数据集应能在数据集分组里逐个找到',
    })

    const definition = catalog.get(row.tagCode)
    const tagPending = view.pendingKeys.includes(row.tagCode)
    push({
      scope: '标签定义',
      tagCode: row.tagCode,
      tagName: row.tagName,
      field: '标签名称',
      datasetValue: fmt(row.tagName),
      comparedValue: definition ? fmt(definition.name) : '标签已删除',
      ok: !!definition && definition.name === row.tagName,
      expected: !definition && tagPending,
      note: !definition
        ? tagPending
          ? '标签定义已删除，该标签在待重算队列中；上一份完整版本仍保留它'
          : '标签定义已删除，但快照仍保留该标签，需要重算清理'
        : '标签名称按标签定义核对',
    })
    push({
      scope: '标签定义',
      tagCode: row.tagCode,
      tagName: row.tagName,
      field: '使用频次',
      datasetValue: fmt(row.frequency),
      comparedValue: definition ? fmt(definition.frequencyRaw) : '标签已删除',
      ok: !!definition && definition.frequencyRaw === row.frequency,
      expected: (!definition || definition.frequencyRaw !== row.frequency) && tagPending,
      note: '标签定义的频次要等于按明细算出的频次',
    })
    push({
      scope: '标签定义',
      tagCode: row.tagCode,
      tagName: row.tagName,
      field: '最后使用',
      datasetValue: fmt(row.lastUsed),
      comparedValue: definition ? fmt(definition.lastUsedRaw) : '标签已删除',
      ok: !!definition && definition.lastUsedRaw === row.lastUsed,
      expected: (!definition || definition.lastUsedRaw !== row.lastUsed) && tagPending,
      note: '标签定义的最后使用要与标签化数据集同一边界、同一次发布',
    })

    const live = liveMap.get(row.tagCode) ?? { tagCode: row.tagCode, details: [], relationKeys: [] }
    const liveFrequency = live.details.length
    const liveLast = lastUsedOfDetails(live.details)
    push({
      scope: '实时明细',
      tagCode: row.tagCode,
      tagName: row.tagName,
      field: '使用频次',
      datasetValue: fmt(row.frequency),
      comparedValue: fmt(liveFrequency),
      ok: row.frequency === liveFrequency,
      expected: row.frequency !== liveFrequency && tagPending,
      note:
        row.frequency !== liveFrequency
          ? `实时明细已变化，尚有 ${pending} 个标签待重算；发布版本 v${snapshot.version} 保持不变`
          : '与实时有效明细一致',
    })
    push({
      scope: '实时明细',
      tagCode: row.tagCode,
      tagName: row.tagName,
      field: '最后使用',
      datasetValue: fmt(row.lastUsed),
      comparedValue: fmt(liveLast),
      ok: row.lastUsed === liveLast,
      expected: row.lastUsed !== liveLast && tagPending,
      note:
        row.lastUsed !== liveLast
          ? '实时明细已变化，最后使用时间等待同一次重算一起更新'
          : '与实时明细最晚时间一致',
    })
  }

  const recomputed = checksumOf(snapshot)
  push({
    scope: '校验指纹',
    tagCode: '*',
    tagName: '标签化数据集',
    field: '内容指纹',
    datasetValue: snapshot.checksum,
    comparedValue: recomputed,
    ok: recomputed === snapshot.checksum,
    note: '按快照内容重算指纹，防止读到半成品缓存',
  })
  push({
    scope: '校验指纹',
    tagCode: '*',
    tagName: '标签化数据集',
    field: '版本号',
    datasetValue: fmt(snapshot.version),
    comparedValue: fmt(view.stableVersion),
    ok: snapshot.version === view.stableVersion,
    note: '对外稳定版本应等于最新已发布版本',
  })

  const failures = items.filter((item) => item.scope !== '实时明细' && !item.ok && !item.expected)
  const liveDrift = items.filter((item) => item.scope === '实时明细' && !item.ok && !item.expected).length
  const expectedDrift = items.filter((item) => item.expected).length
  return {
    ok: failures.length === 0,
    liveOk: liveDrift === 0,
    checkedAt: nowISO(),
    version: snapshot.version,
    checksum: snapshot.checksum,
    checksumOk: recomputed === snapshot.checksum,
    items,
    summary: {
      total: items.length,
      passed: items.filter((item) => item.ok).length,
      failed: failures.length,
      liveDrift,
      expectedDrift,
    },
    pendingChanges: pending,
    pendingNote:
      pending > 0
        ? `${pending} 个标签的关系变更尚未进入标签化数据集，继续读取上一份完整版本 v${snapshot.version}`
        : '没有待重算的标签关系变更',
  }
}

// ---------- 分析笔记读侧 ----------

export function loadAnalysisNoteFeed(): AnalysisNoteFeed {
  ensureStableSnapshot()
  const view = loadTagDatasetView()
  const snapshot = view.snapshot
  const notes = readNotes()
  const rowMap = new Map(snapshot.rows.map((row) => [row.tagCode, row]))
  const rows: AnalysisNoteFeedRow[] = notes.map((note) => {
    const tags = note.tagCodes
      .map((code) => rowMap.get(code))
      .filter((row): row is TagDatasetRow => !!row)
      .map((row) => {
        const own = row.details.filter((detail) => detail.noteId === note.id)
        return {
          tagCode: row.tagCode,
          tagName: row.tagName,
          frequency: row.frequency,
          lastUsed: row.lastUsed,
          detailCount: own.length,
        }
      })
      .sort(
        (left, right) =>
          right.frequency - left.frequency || left.tagCode.localeCompare(right.tagCode),
      )
    const detailTimes = snapshot.rows
      .flatMap((row) => row.details)
      .filter((detail) => detail.noteId === note.id)
      .map((detail) => detail.occurredAt)
    return {
      noteId: note.id,
      noteCode: note.code,
      title: note.title,
      datasetId: note.datasetId,
      status: note.status,
      tags,
      maxFrequency: tags.reduce((max, tag) => Math.max(max, tag.frequency), 0),
      latestLastUsed: maxIso(tags.map((tag) => tag.lastUsed)),
      latestDetailAt: maxIso(detailTimes),
    }
  })
  rows.sort(
    (left, right) =>
      right.maxFrequency - left.maxFrequency ||
      right.latestDetailAt.localeCompare(left.latestDetailAt) ||
      left.noteId - right.noteId,
  )
  const noteStale = noteSignatureOf(notes) !== snapshot.noteSignature
  let notice = `读取标签化数据集 v${snapshot.version}（发布于 ${snapshot.publishedAt}），按最高频次排序`
  if (view.interrupted) {
    notice = `频次重算已中断：继续读取上一份完整版本 v${snapshot.version}，排序不来自半成品缓存；恢复后只补剩余变更项`
  } else if (view.building) {
    notice = `频次重算进行中：仍读取上一份完整版本 v${snapshot.version}，不会读到半成品缓存`
  } else if (view.pendingKeys.length > 0) {
    notice = `有 ${view.pendingKeys.length} 个标签关系待重算，当前排序仍来自 v${snapshot.version} 完整版本`
  }
  return {
    version: snapshot.version,
    builtAt: snapshot.builtAt,
    publishedAt: snapshot.publishedAt,
    checksum: snapshot.checksum,
    rows,
    tags: [...snapshot.rows].sort(
      (left, right) => right.frequency - left.frequency || left.tagCode.localeCompare(right.tagCode),
    ),
    notice,
    pendingChanges: view.pendingKeys.length,
    building: view.building,
    interrupted: view.interrupted,
    noteStale,
    totals: snapshot.totals,
  }
}

export function resetTagDemo(): void {
  resetTagLedger()
  resetRows(TAG_MODULE)
  resetRows(NOTE_MODULE)
}

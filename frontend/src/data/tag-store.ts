import { SEED_ROWS } from './seed'
import type {
  RecomputeChange,
  RecomputeDraft,
  RecomputeJob,
  TagAuditEntry,
  TaggedDataset,
  TagRelation,
  TagUsageEvent,
} from './tag-types'

/**
 * 标签关系账本 + 标签化数据集发布的本地持久化。
 *
 * 口径：关系是「标签 × 数据集」的唯一登记；每个关系只保留一条最近使用明细，
 * 重复写入合并到明细上（mergedWrites/history），不再新增关系。
 * 标签定义（taggroup 模块）仍保存「使用频次 / 最后使用」，重算时作为输入读取，
 * 重算完成后回写为按明细计算出的值，两边能逐项核对。
 */
export const TAG_STORAGE_KEY = 'data-explore-selfservice:tag-ledger'

export type TagLedgerState = {
  schemaVersion: 1
  seededAt: string
  relations: TagRelation[]
  events: TagUsageEvent[]
  nextEventId: number
  nextAuditId: number
  nextSeq: number
  stableVersion: number
  stableSeq: number
  changes: RecomputeChange[]
  snapshots: TaggedDataset[]
  draft: RecomputeDraft | null
  job: RecomputeJob | null
  auditLog: TagAuditEntry[]
  autoRecompute: boolean
  migrateCount: number
}

type SeedLink = {
  tagCode: string
  datasetId: string
  noteId: number | null
  at: string
  rev: number
}

// 示例关系：TAGG-0001 × DS-ORDER-DAILY 有两次写入，播种时即合并成一条明细。
const SEED_LINKS: SeedLink[] = [
  { tagCode: 'TAGG-0001', datasetId: 'DS-ORDER-DAILY', noteId: 1, at: '2026-09-02T10:15:00.000Z', rev: 1 },
  { tagCode: 'TAGG-0001', datasetId: 'DS-ORDER-DAILY', noteId: 1, at: '2026-09-08T14:30:00.000Z', rev: 2 },
  { tagCode: 'TAGG-0001', datasetId: 'DS-USER-PROFILE', noteId: 2, at: '2026-09-12T09:05:00.000Z', rev: 1 },
  { tagCode: 'TAGG-0002', datasetId: 'DS-ORDER-DAILY', noteId: 1, at: '2026-09-05T08:40:00.000Z', rev: 1 },
  { tagCode: 'TAGG-0002', datasetId: 'DS-CHANNEL-SALES', noteId: 3, at: '2026-09-15T16:20:00.000Z', rev: 1 },
  { tagCode: 'TAGG-0003', datasetId: 'DS-CHANNEL-SALES', noteId: 3, at: '2026-09-18T11:45:00.000Z', rev: 1 },
  { tagCode: 'TAGG-0004', datasetId: 'DS-USER-PROFILE', noteId: 2, at: '2026-09-20T13:10:00.000Z', rev: 1 },
  { tagCode: 'TAGG-0004', datasetId: 'DS-ORDER-DAILY', noteId: 1, at: '2026-09-21T09:35:00.000Z', rev: 1 },
]

export function relationKey(tagCode: string, datasetId: string): string {
  return `${tagCode}@${datasetId}`
}

function tagNameOf(tagCode: string): string {
  const row = (SEED_ROWS.taggroup ?? []).find((item) => item['标签编号'] === tagCode)
  return String(row?.['标签名称'] ?? tagCode)
}

function seedLedger(): TagLedgerState {
  const byKey = new Map<string, SeedLink[]>()
  for (const link of SEED_LINKS) {
    const key = relationKey(link.tagCode, link.datasetId)
    const bucket = byKey.get(key) ?? []
    bucket.push(link)
    byKey.set(key, bucket)
  }

  const relations: TagRelation[] = []
  const events: TagUsageEvent[] = []
  let eventId = 1
  let seq = 1
  for (const [key, links] of byKey) {
    const ordered = [...links].sort((left, right) => left.at.localeCompare(right.at))
    const first = ordered[0]
    const latest = ordered[ordered.length - 1]
    const merged = ordered.length - 1
    relations.push({
      key,
      tagId: 0,
      tagCode: first.tagCode,
      tagName: tagNameOf(first.tagCode),
      datasetId: first.datasetId,
      noteId: first.noteId,
      noteCode: '',
      state: 'active',
      revision: ordered.length,
      createdAt: first.at,
      createdBy: '示例数据',
      removedAt: '',
      removedBy: '',
      source: 'seed',
    })
    events.push({
      id: eventId,
      relationKey: key,
      relationRevision: ordered.length,
      tagId: 0,
      tagCode: first.tagCode,
      tagName: tagNameOf(first.tagCode),
      datasetId: first.datasetId,
      noteId: first.noteId,
      occurredAt: latest.at,
      state: 'active',
      mergedWrites: merged,
      lastMergedAt: merged > 0 ? latest.at : '',
      removedAt: '',
      source: 'seed',
      history: ordered.map((link, index) => ({
        action: index === 0 ? 'created' : 'merged',
        at: link.at,
        note: index === 0 ? '示例数据登记关系' : `同一关系重复写入合并（第 ${index + 1} 次）`,
      })),
    })
    eventId += 1
    seq += 1
  }

  return {
    schemaVersion: 1,
    seededAt: '2026-11-01T09:00:00.000Z',
    relations,
    events,
    nextEventId: eventId,
    nextAuditId: 1,
    nextSeq: seq,
    stableVersion: 0,
    stableSeq: 0,
    changes: [],
    snapshots: [],
    draft: null,
    job: null,
    auditLog: [],
    autoRecompute: true,
    migrateCount: 0,
  }
}

// 没有 window 时（构建脚本 / 单测）退回进程内存储，行为与浏览器一致。
let memoryRaw: string | null = null

function storageAvailable(): boolean {
  return typeof window !== 'undefined' && !!window.localStorage
}

function readRaw(): string | null {
  if (storageAvailable()) {
    return window.localStorage.getItem(TAG_STORAGE_KEY)
  }
  return memoryRaw
}

function writeRaw(value: string): void {
  if (storageAvailable()) {
    window.localStorage.setItem(TAG_STORAGE_KEY, value)
    return
  }
  memoryRaw = value
}

export function loadTagLedger(): TagLedgerState {
  const raw = readRaw()
  if (!raw) {
    const seeded = seedLedger()
    writeRaw(JSON.stringify(seeded))
    return seeded
  }
  try {
    const parsed = JSON.parse(raw) as TagLedgerState
    if (!parsed || parsed.schemaVersion !== 1 || !Array.isArray(parsed.relations)) {
      throw new Error('标签账本结构不匹配')
    }
    return parsed
  } catch {
    const seeded = seedLedger()
    writeRaw(JSON.stringify(seeded))
    return seeded
  }
}

export function saveTagLedger(ledger: TagLedgerState): void {
  writeRaw(JSON.stringify(ledger))
}

export function resetTagLedger(): void {
  const seeded = seedLedger()
  memoryRaw = JSON.stringify(seeded)
  writeRaw(JSON.stringify(seeded))
}

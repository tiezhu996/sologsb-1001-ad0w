export type CueStatus = 'draft' | 'reviewed' | 'issue'
export type Locale = 'zh-CN' | 'en-US' | 'ja-JP'

export interface Cue {
  id: string
  start: number
  end: number
  source: string
  target: string
  actorId: string
  speed: number
  termIds: string[]
  status: CueStatus
  locked: boolean
}

export interface Actor {
  id: string
  name: string
  color: string
  localeHint: string
}

export interface Term {
  id: string
  source: string
  target: string
  note: string
}

export interface Snapshot {
  id: string
  name: string
  createdAt: number
  cues: Cue[]
}

export interface EditorDocument {
  id: string
  title: string
  language: Locale
  cues: Cue[]
  actors: Actor[]
  terms: Term[]
  snapshots: Snapshot[]
  updatedAt: number
  revision: number
  lastWriter: string
}

export interface CueConflict {
  cueId: string
  type: 'actor' | 'tone' | 'address'
  message: string
}

export type MergeSide = 'mine' | 'theirs'

export type CueMergeField = 'start' | 'end' | 'source' | 'target' | 'actorId' | 'speed' | 'termIds' | 'status' | 'locked'

export interface FieldContest {
  field: CueMergeField
  base: unknown
  mine: unknown
  theirs: unknown
}

export interface CueMergeConflict {
  cueId: string
  mineDeleted: boolean
  theirsDeleted: boolean
  mineCue: Cue | null
  theirsCue: Cue | null
  contests: FieldContest[]
}

export interface CueMergeResult {
  cues: Cue[]
  conflicts: CueMergeConflict[]
  tookTheirs: number
  keptMine: number
  blended: number
}

export interface DocumentMergeResult extends CueMergeResult {
  title: string
  language: Locale
  actors: Actor[]
  terms: Term[]
  snapshots: Snapshot[]
}

export interface PendingMerge extends DocumentMergeResult {
  theirsCues: Cue[]
  theirsRevision: number
}

export interface HistoryEntry {
  label: string
  cues: Cue[]
  selectedCueId: string | null
}

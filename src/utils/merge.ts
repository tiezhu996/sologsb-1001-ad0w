import type { Cue } from '../types'

export type CueField = 'start' | 'end' | 'source' | 'target' | 'actorId' | 'speed' | 'termIds' | 'status' | 'locked'
export const CUE_FIELDS: CueField[] = ['start', 'end', 'source', 'target', 'actorId', 'speed', 'termIds', 'status', 'locked']

export type MergeChoice = 'mine' | 'theirs'

export interface CueMergeConflict {
  cueId: string
  kind: 'edit-edit' | 'delete-edit'
  /** which side deleted the cue (delete-edit only) */
  deletedBy: MergeChoice | null
  /** fields both sides changed to different values (edit-edit only) */
  fields: CueField[]
  base: Cue | null
  mine: Cue | null
  theirs: Cue | null
}

export interface MergePlan {
  /** auto-merged cue list; contested fields tentatively keep my value until resolveMerge */
  cues: Cue[]
  conflicts: CueMergeConflict[]
  /** number of cues that received a change coming from the other tab */
  theirChanges: number
}

const cloneCue = (cue: Cue): Cue => ({ ...cue, termIds: [...cue.termIds] })

const fieldEqual = (a: Cue, b: Cue, field: CueField): boolean => {
  if (field === 'termIds') return [...a.termIds].sort().join('\n') === [...b.termIds].sort().join('\n')
  return a[field] === b[field]
}

const cuesEqual = (a: Cue, b: Cue): boolean => CUE_FIELDS.every((field) => fieldEqual(a, b, field))

const assignField = (target: Cue, field: CueField, source: Cue): void => {
  if (field === 'termIds') target.termIds = [...source.termIds]
  else target[field] = source[field] as never
}

/**
 * Three-way merge of two cue lists that both descend from `base`.
 * A side "changed" a cue/field only when it differs from base — never from
 * comparing the two sides against each other, otherwise every cue the other
 * tab touched alone would be misread as a both-sides conflict.
 */
export const planMerge = (base: Cue[], mine: Cue[], theirs: Cue[]): MergePlan => {
  const baseById = new Map(base.map((cue) => [cue.id, cue]))
  const mineById = new Map(mine.map((cue) => [cue.id, cue]))
  const theirsById = new Map(theirs.map((cue) => [cue.id, cue]))
  const conflicts: CueMergeConflict[] = []
  const mergedById = new Map<string, Cue>()
  let theirChanges = 0

  for (const myCue of mine) {
    const baseCue = baseById.get(myCue.id)
    const theirCue = theirsById.get(myCue.id)
    if (!baseCue) {
      mergedById.set(myCue.id, cloneCue(myCue))
      continue
    }
    if (!theirCue) {
      if (cuesEqual(baseCue, myCue)) {
        theirChanges += 1
        continue
      }
      conflicts.push({ cueId: myCue.id, kind: 'delete-edit', deletedBy: 'theirs', fields: [], base: baseCue, mine: cloneCue(myCue), theirs: null })
      mergedById.set(myCue.id, cloneCue(myCue))
      continue
    }
    const merged = cloneCue(myCue)
    const contested: CueField[] = []
    let tookTheirs = false
    for (const field of CUE_FIELDS) {
      const mineChanged = !fieldEqual(baseCue, myCue, field)
      const theirsChanged = !fieldEqual(baseCue, theirCue, field)
      if (!theirsChanged) continue
      if (!mineChanged) {
        assignField(merged, field, theirCue)
        tookTheirs = true
        continue
      }
      if (fieldEqual(myCue, theirCue, field)) continue
      contested.push(field)
    }
    if (tookTheirs) theirChanges += 1
    if (contested.length) {
      conflicts.push({ cueId: myCue.id, kind: 'edit-edit', deletedBy: null, fields: contested, base: baseCue, mine: cloneCue(myCue), theirs: cloneCue(theirCue) })
    }
    mergedById.set(myCue.id, merged)
  }

  for (const baseCue of base) {
    if (mineById.has(baseCue.id)) continue
    const theirCue = theirsById.get(baseCue.id)
    if (!theirCue) continue
    if (cuesEqual(baseCue, theirCue)) continue
    conflicts.push({ cueId: baseCue.id, kind: 'delete-edit', deletedBy: 'mine', fields: [], base: baseCue, mine: null, theirs: cloneCue(theirCue) })
  }

  const cues: Cue[] = []
  for (const myCue of mine) {
    const merged = mergedById.get(myCue.id)
    if (merged) cues.push(merged)
  }
  for (let index = 0; index < theirs.length; index += 1) {
    const theirCue = theirs[index]
    if (baseById.has(theirCue.id) || mineById.has(theirCue.id)) continue
    let position = -1
    for (let back = index - 1; back >= 0; back -= 1) {
      const at = cues.findIndex((cue) => cue.id === theirs[back].id)
      if (at >= 0) {
        position = at
        break
      }
    }
    cues.splice(position + 1, 0, cloneCue(theirCue))
    theirChanges += 1
  }

  return { cues, conflicts, theirChanges }
}

/** Apply the user's per-cue pick to the planned list. Uncontested field merges always stand. */
export const applyMergeChoice = (cues: Cue[], base: Cue[], conflict: CueMergeConflict, choice: MergeChoice): void => {
  if (conflict.kind === 'edit-edit') {
    const cue = cues.find((item) => item.id === conflict.cueId)
    const source = choice === 'mine' ? conflict.mine : conflict.theirs
    if (!cue || !source) return
    for (const field of conflict.fields) assignField(cue, field, source)
    return
  }
  const index = cues.findIndex((item) => item.id === conflict.cueId)
  if (choice === 'mine') return
  if (conflict.deletedBy === 'mine') {
    if (index >= 0 || !conflict.theirs) return
    const baseIndex = base.findIndex((item) => item.id === conflict.cueId)
    let position = -1
    for (let back = baseIndex - 1; back >= 0; back -= 1) {
      const at = cues.findIndex((cue) => cue.id === base[back].id)
      if (at >= 0) {
        position = at
        break
      }
    }
    cues.splice(position + 1, 0, cloneCue(conflict.theirs))
    return
  }
  if (index >= 0) cues.splice(index, 1)
}

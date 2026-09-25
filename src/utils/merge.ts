import type {
  Cue, CueMergeConflict, CueMergeResult, DocumentMergeResult, EditorDocument, FieldContest, MergeSide,
} from '../types'

const SCALAR_FIELDS = ['start', 'end', 'source', 'target', 'actorId', 'speed', 'status', 'locked'] as const

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

const sameTerms = (a: string[], b: string[]) => {
  if (a.length !== b.length) return false
  const sortedA = [...a].sort()
  const sortedB = [...b].sort()
  return sortedA.every((id, index) => id === sortedB[index])
}

// 关联术语按集合做三方合并：任一方新增的保留，一方删除而另一方未动的删除。
const mergeTermIds = (base: string[], mine: string[], theirs: string[]): string[] => {
  const baseSet = new Set(base)
  const theirsSet = new Set(theirs)
  const keep = new Set<string>()
  for (const id of mine) {
    if (theirsSet.has(id) || !baseSet.has(id)) keep.add(id)
  }
  for (const id of theirs) {
    if (!baseSet.has(id)) keep.add(id)
  }
  const ordered: string[] = []
  for (const id of [...mine, ...theirs]) {
    if (keep.has(id) && !ordered.includes(id)) ordered.push(id)
  }
  return ordered
}

// 逐字段三方合并一条台词。单边改动直接采用；同一字段两边都改成不同值才记入 contests。
const mergeCue = (base: Cue, mine: Cue, theirs: Cue): { cue: Cue; contests: FieldContest[] } => {
  const merged = clone(mine)
  const contests: FieldContest[] = []
  for (const field of SCALAR_FIELDS) {
    const baseValue = base[field]
    const mineValue = mine[field]
    const theirsValue = theirs[field]
    const mineChanged = !same(mineValue, baseValue)
    const theirsChanged = !same(theirsValue, baseValue)
    if (theirsChanged && (!mineChanged || same(mineValue, theirsValue))) {
      merged[field] = clone(theirsValue) as never
    } else if (mineChanged && theirsChanged) {
      contests.push({ field, base: clone(baseValue), mine: clone(mineValue), theirs: clone(theirsValue) })
      merged[field] = clone(mineValue) as never
    }
  }
  const mineTermsChanged = !sameTerms(mine.termIds, base.termIds)
  const theirsTermsChanged = !sameTerms(theirs.termIds, base.termIds)
  if (mineTermsChanged && theirsTermsChanged) {
    merged.termIds = mergeTermIds(base.termIds, mine.termIds, theirs.termIds)
  } else if (theirsTermsChanged) {
    merged.termIds = [...theirs.termIds]
  }
  return { cue: merged, contests }
}

// 把尚未放入结果的新台词按其在来源列表中的相邻位置锚定插入。
const insertMissing = (result: Cue[], placed: Set<string>, source: Cue[], mergedById: Map<string, Cue>) => {
  const order = source.map((cue) => cue.id)
  for (const cue of source) {
    if (!mergedById.has(cue.id) || placed.has(cue.id)) continue
    const index = order.indexOf(cue.id)
    let at = -1
    for (let i = index - 1; i >= 0 && at < 0; i -= 1) {
      const position = result.findIndex((item) => item.id === order[i])
      if (position >= 0) at = position + 1
    }
    if (at < 0) {
      for (let i = index + 1; i < order.length && at < 0; i += 1) {
        const position = result.findIndex((item) => item.id === order[i])
        if (position >= 0) at = position
      }
    }
    const merged = mergedById.get(cue.id)
    if (!merged) continue
    if (at < 0) result.push(merged)
    else result.splice(at, 0, merged)
    placed.add(cue.id)
  }
}

export const mergeCues = (base: Cue[], mine: Cue[], theirs: Cue[]): CueMergeResult => {
  const baseById = new Map(base.map((cue) => [cue.id, cue]))
  const mineById = new Map(mine.map((cue) => [cue.id, cue]))
  const theirsById = new Map(theirs.map((cue) => [cue.id, cue]))
  const mergedById = new Map<string, Cue>()
  const conflicts: CueMergeConflict[] = []
  let tookTheirs = 0
  let keptMine = 0
  let blended = 0

  for (const baseCue of base) {
    const mineCue = mineById.get(baseCue.id)
    const theirsCue = theirsById.get(baseCue.id)
    if (mineCue && theirsCue) {
      const mineChanged = !same(mineCue, baseCue)
      const theirsChanged = !same(theirsCue, baseCue)
      const { cue, contests } = mergeCue(baseCue, mineCue, theirsCue)
      mergedById.set(cue.id, cue)
      if (contests.length) {
        conflicts.push({ cueId: cue.id, mineDeleted: false, theirsDeleted: false, mineCue: clone(mineCue), theirsCue: clone(theirsCue), contests })
      } else if (mineChanged && theirsChanged) {
        blended += 1
      } else if (theirsChanged) {
        tookTheirs += 1
      } else if (mineChanged) {
        keptMine += 1
      }
    } else if (mineCue && !theirsCue) {
      // 对方删除了此条：本页没动过就接受删除，否则列为冲突（默认保留本页版本）。
      if (!same(mineCue, baseCue)) {
        mergedById.set(mineCue.id, clone(mineCue))
        conflicts.push({ cueId: mineCue.id, mineDeleted: false, theirsDeleted: true, mineCue: clone(mineCue), theirsCue: null, contests: [] })
      }
    } else if (!mineCue && theirsCue) {
      // 本页删除了此条：对方没动过就接受删除，否则列为冲突（默认保持删除）。
      if (!same(theirsCue, baseCue)) {
        conflicts.push({ cueId: theirsCue.id, mineDeleted: true, theirsDeleted: false, mineCue: null, theirsCue: clone(theirsCue), contests: [] })
      }
    }
  }

  for (const mineCue of mine) {
    if (baseById.has(mineCue.id)) continue
    const theirsCue = theirsById.get(mineCue.id)
    if (!theirsCue) {
      mergedById.set(mineCue.id, clone(mineCue))
      keptMine += 1
    } else if (same(mineCue, theirsCue)) {
      mergedById.set(mineCue.id, clone(mineCue))
    } else {
      // 双方各自新增了同一 id 的台词（理论上极少见）：整条的差异字段都列为冲突。
      mergedById.set(mineCue.id, clone(mineCue))
      const contests: FieldContest[] = []
      for (const field of SCALAR_FIELDS) {
        if (!same(mineCue[field], theirsCue[field])) {
          contests.push({ field, base: null, mine: clone(mineCue[field]), theirs: clone(theirsCue[field]) })
        }
      }
      if (!sameTerms(mineCue.termIds, theirsCue.termIds)) {
        contests.push({ field: 'termIds', base: null, mine: [...mineCue.termIds], theirs: [...theirsCue.termIds] })
      }
      conflicts.push({ cueId: mineCue.id, mineDeleted: false, theirsDeleted: false, mineCue: clone(mineCue), theirsCue: clone(theirsCue), contests })
    }
  }
  for (const theirsCue of theirs) {
    if (!baseById.has(theirsCue.id) && !mineById.has(theirsCue.id)) {
      mergedById.set(theirsCue.id, clone(theirsCue))
      tookTheirs += 1
    }
  }

  // 顺序：哪一边相对 base 调整过共享台词的顺序，就用哪一边的排列；都没动则沿用本页。
  const baseIds = new Set(baseById.keys())
  const sharedOrder = (cues: Cue[]) => cues.filter((cue) => baseIds.has(cue.id)).map((cue) => cue.id)
  const reordered = (cues: Cue[]) => {
    const kept = sharedOrder(cues)
    return !same(kept, sharedOrder(base).filter((id) => kept.includes(id)))
  }
  const skeleton = reordered(mine) ? mine : reordered(theirs) ? theirs : mine
  const result: Cue[] = []
  const placed = new Set<string>()
  for (const cue of skeleton) {
    const merged = mergedById.get(cue.id)
    if (merged && !placed.has(cue.id)) {
      result.push(merged)
      placed.add(cue.id)
    }
  }
  insertMissing(result, placed, mine, mergedById)
  insertMissing(result, placed, theirs, mergedById)

  return { cues: result, conflicts, tookTheirs, keptMine, blended }
}

// 应用逐条挑选结果：只覆盖有争议的字段，其余字段保持自动合并的结果。
export const applyMergePicks = (
  mergedCues: Cue[],
  conflicts: CueMergeConflict[],
  picks: Record<string, MergeSide>,
  theirsCues: Cue[],
): Cue[] => {
  const result = clone(mergedCues)
  for (const conflict of conflicts) {
    const pick = picks[conflict.cueId] ?? 'mine'
    const index = result.findIndex((cue) => cue.id === conflict.cueId)
    if (conflict.mineDeleted) {
      if (pick === 'theirs' && conflict.theirsCue) {
        const restored = clone(conflict.theirsCue)
        const order = theirsCues.map((cue) => cue.id)
        const anchor = order.indexOf(conflict.cueId)
        let at = -1
        for (let i = anchor - 1; i >= 0 && at < 0; i -= 1) {
          const position = result.findIndex((cue) => cue.id === order[i])
          if (position >= 0) at = position + 1
        }
        if (at < 0) {
          for (let i = anchor + 1; i < order.length && at < 0; i += 1) {
            const position = result.findIndex((cue) => cue.id === order[i])
            if (position >= 0) at = position
          }
        }
        if (at < 0) result.push(restored)
        else result.splice(at, 0, restored)
      }
    } else if (conflict.theirsDeleted) {
      if (pick === 'theirs' && index >= 0) result.splice(index, 1)
    } else if (pick === 'theirs' && index >= 0) {
      for (const contest of conflict.contests) {
        const target = result[index] as unknown as Record<string, unknown>
        target[contest.field] = clone(contest.theirs)
      }
    }
  }
  return result
}

// 文档级字段：单边改动采用改动方，两边都改则保留本页；快照按 id 取并集。
export const mergeDocuments = (base: EditorDocument, mine: EditorDocument, theirs: EditorDocument): DocumentMergeResult => {
  const cueResult = mergeCues(base.cues, mine.cues, theirs.cues)
  const pickSide = <T>(baseValue: T, mineValue: T, theirsValue: T): T =>
    (!same(theirsValue, baseValue) && same(mineValue, baseValue)) ? clone(theirsValue) : mineValue
  const seen = new Set<string>()
  const snapshots = [...mine.snapshots, ...theirs.snapshots]
    .filter((snapshot) => {
      if (seen.has(snapshot.id)) return false
      seen.add(snapshot.id)
      return true
    })
    .sort((a, b) => b.createdAt - a.createdAt)
  return {
    ...cueResult,
    title: pickSide(base.title, mine.title, theirs.title),
    language: pickSide(base.language, mine.language, theirs.language),
    actors: pickSide(base.actors, mine.actors, theirs.actors),
    terms: pickSide(base.terms, mine.terms, theirs.terms),
    snapshots,
  }
}

import { describe, expect, it } from 'vitest'
import type { Cue, EditorDocument } from '../types'
import { applyMergePicks, mergeCues, mergeDocuments } from './merge'

let serial = 0
const makeCue = (patch: Partial<Cue> = {}): Cue => ({
  id: `cue-${(serial += 1)}`,
  start: 0,
  end: 2,
  source: '原文',
  target: '译文',
  actorId: 'actor-a',
  speed: 1,
  termIds: [],
  status: 'draft',
  locked: false,
  ...patch,
})

const makeDoc = (cues: Cue[], patch: Partial<EditorDocument> = {}): EditorDocument => ({
  id: 'doc',
  title: '标题',
  language: 'zh-CN',
  cues,
  actors: [],
  terms: [],
  snapshots: [],
  updatedAt: 0,
  revision: 1,
  lastWriter: '',
  ...patch,
})

describe('mergeCues 单边改动', () => {
  it('只有本页改过的台词保留本页版本，不产生冲突', () => {
    const base = [makeCue({ id: 'a' }), makeCue({ id: 'b' }), makeCue({ id: 'c' })]
    const mine = [base[0], { ...base[1], target: '本页改的译文' }, base[2]]
    const result = mergeCues(base, mine, base)
    expect(result.conflicts).toHaveLength(0)
    expect(result.cues.map((cue) => cue.id)).toEqual(['a', 'b', 'c'])
    expect(result.cues[1].target).toBe('本页改的译文')
    expect(result.keptMine).toBe(1)
    expect(result.tookTheirs).toBe(0)
  })

  it('只有对方改过的台词采用对方版本，不产生冲突', () => {
    const base = [makeCue({ id: 'a' }), makeCue({ id: 'b' }), makeCue({ id: 'c' })]
    const theirs = [base[0], base[1], { ...base[2], source: '对方改的原文', speed: 1.2 }]
    const result = mergeCues(base, base, theirs)
    expect(result.conflicts).toHaveLength(0)
    expect(result.cues[2].source).toBe('对方改的原文')
    expect(result.cues[2].speed).toBe(1.2)
    expect(result.tookTheirs).toBe(1)
  })

  it('本页改了大量台词而对方没动时，不会冒出双边冲突', () => {
    const base = Array.from({ length: 8 }, (_, index) => makeCue({ id: `c${index}` }))
    const mine = base.map((cue, index) => (index % 2 === 0 ? { ...cue, target: `本页译文${index}` } : cue))
    const result = mergeCues(base, mine, base)
    expect(result.conflicts).toHaveLength(0)
    expect(result.keptMine).toBe(4)
    expect(result.cues[0].target).toBe('本页译文0')
    expect(result.cues[1].target).toBe('译文')
  })

  it('双方各自改了不同的台词时全部自动合并', () => {
    const base = [makeCue({ id: 'a' }), makeCue({ id: 'b' })]
    const mine = [{ ...base[0], target: '本页译文' }, base[1]]
    const theirs = [base[0], { ...base[1], target: '对方译文' }]
    const result = mergeCues(base, mine, theirs)
    expect(result.conflicts).toHaveLength(0)
    expect(result.cues[0].target).toBe('本页译文')
    expect(result.cues[1].target).toBe('对方译文')
  })
})

describe('mergeCues 字段级合并', () => {
  it('同一条台词的角色、语速等字段按字段合并，不退回旧值', () => {
    const base = [makeCue({ id: 'a', actorId: 'actor-a', speed: 1, termIds: ['t1'] })]
    const mine = [{ ...base[0], actorId: 'actor-b' }]
    const theirs = [{ ...base[0], speed: 1.25 }]
    const result = mergeCues(base, mine, theirs)
    expect(result.conflicts).toHaveLength(0)
    expect(result.blended).toBe(1)
    expect(result.cues[0].actorId).toBe('actor-b')
    expect(result.cues[0].speed).toBe(1.25)
    expect(result.cues[0].termIds).toEqual(['t1'])
  })

  it('双方各自增删关联术语时按集合三方合并', () => {
    const base = [makeCue({ id: 'a', termIds: ['t1', 't2'] })]
    const mine = [{ ...base[0], termIds: ['t1', 't3'] }]
    const theirs = [{ ...base[0], termIds: ['t1', 't2', 't4'] }]
    const result = mergeCues(base, mine, theirs)
    expect(result.conflicts).toHaveLength(0)
    expect(result.cues[0].termIds).toEqual(['t1', 't3', 't4'])
  })

  it('同一字段两边都改成不同值才列为冲突，且可逐条挑边', () => {
    const base = [makeCue({ id: 'a', target: '旧译文', speed: 1 })]
    const mine = [{ ...base[0], target: '本页译文', speed: 1.3 }]
    const theirs = [{ ...base[0], target: '对方译文' }]
    const result = mergeCues(base, mine, theirs)
    expect(result.conflicts).toHaveLength(1)
    expect(result.conflicts[0].contests.map((contest) => contest.field)).toEqual(['target'])
    // 未挑选时默认本页，且本页的语速改动保留
    expect(result.cues[0].target).toBe('本页译文')
    expect(result.cues[0].speed).toBe(1.3)
    const pickedTheirs = applyMergePicks(result.cues, result.conflicts, { a: 'theirs' }, theirs)
    expect(pickedTheirs[0].target).toBe('对方译文')
    expect(pickedTheirs[0].speed).toBe(1.3)
    const pickedMine = applyMergePicks(result.cues, result.conflicts, { a: 'mine' }, theirs)
    expect(pickedMine[0].target).toBe('本页译文')
  })

  it('挑边只覆盖争议字段，另一边改过的其余字段不回退', () => {
    const base = [makeCue({ id: 'a', actorId: 'actor-a', speed: 1, target: '旧译文' })]
    const mine = [{ ...base[0], actorId: 'actor-b', target: '本页译文' }]
    const theirs = [{ ...base[0], speed: 0.9, target: '对方译文' }]
    const result = mergeCues(base, mine, theirs)
    expect(result.conflicts).toHaveLength(1)
    const picked = applyMergePicks(result.cues, result.conflicts, { a: 'theirs' }, theirs)
    expect(picked[0].target).toBe('对方译文')
    expect(picked[0].actorId).toBe('actor-b')
    expect(picked[0].speed).toBe(0.9)
  })
})

describe('mergeCues 增删与顺序', () => {
  it('一方删除而另一方未动的台词被删除', () => {
    const base = [makeCue({ id: 'a' }), makeCue({ id: 'b' }), makeCue({ id: 'c' })]
    const mine = [base[0], base[2]]
    const result = mergeCues(base, mine, base)
    expect(result.conflicts).toHaveLength(0)
    expect(result.cues.map((cue) => cue.id)).toEqual(['a', 'c'])
  })

  it('一方删除而另一方改过的台词列为冲突，可挑选恢复或保持删除', () => {
    const base = [makeCue({ id: 'a' }), makeCue({ id: 'b' }), makeCue({ id: 'c' })]
    const mine = [base[0], base[2]]
    const theirs = [base[0], { ...base[1], target: '对方译文' }, base[2]]
    const result = mergeCues(base, mine, theirs)
    expect(result.conflicts).toHaveLength(1)
    expect(result.conflicts[0].mineDeleted).toBe(true)
    expect(result.cues.map((cue) => cue.id)).toEqual(['a', 'c'])
    const restored = applyMergePicks(result.cues, result.conflicts, { b: 'theirs' }, theirs)
    expect(restored.map((cue) => cue.id)).toEqual(['a', 'b', 'c'])
    expect(restored[1].target).toBe('对方译文')
    const keptDeleted = applyMergePicks(result.cues, result.conflicts, { b: 'mine' }, theirs)
    expect(keptDeleted.map((cue) => cue.id)).toEqual(['a', 'c'])
  })

  it('对方删除而本页改过的台词默认保留本页版本，也可选择删除', () => {
    const base = [makeCue({ id: 'a' }), makeCue({ id: 'b' })]
    const mine = [base[0], { ...base[1], target: '本页译文' }]
    const theirs = [base[0]]
    const result = mergeCues(base, mine, theirs)
    expect(result.conflicts).toHaveLength(1)
    expect(result.conflicts[0].theirsDeleted).toBe(true)
    expect(result.cues.map((cue) => cue.id)).toEqual(['a', 'b'])
    const removed = applyMergePicks(result.cues, result.conflicts, { b: 'theirs' }, theirs)
    expect(removed.map((cue) => cue.id)).toEqual(['a'])
  })

  it('双方各自新增的台词都保留并按相邻位置插入', () => {
    const base = [makeCue({ id: 'a' }), makeCue({ id: 'b' })]
    const mine = [base[0], makeCue({ id: 'mine-new', source: '本页新增' }), base[1]]
    const theirs = [base[0], base[1], makeCue({ id: 'theirs-new', source: '对方新增' })]
    const result = mergeCues(base, mine, theirs)
    expect(result.conflicts).toHaveLength(0)
    expect(result.cues.map((cue) => cue.id)).toEqual(['a', 'mine-new', 'b', 'theirs-new'])
  })

  it('只有对方调整过顺序时采用对方的排列', () => {
    const base = [makeCue({ id: 'a' }), makeCue({ id: 'b' }), makeCue({ id: 'c' })]
    const theirs = [base[1], base[2], base[0]]
    const result = mergeCues(base, base, theirs)
    expect(result.cues.map((cue) => cue.id)).toEqual(['b', 'c', 'a'])
  })
})

describe('mergeDocuments', () => {
  it('标题单边改动采用改动方，快照取并集', () => {
    const cues = [makeCue({ id: 'a' })]
    const base = makeDoc(cues, { title: '旧标题', snapshots: [{ id: 's1', name: 'v1', createdAt: 1, cues }] })
    const mine = makeDoc(cues, { title: '旧标题', snapshots: [{ id: 's1', name: 'v1', createdAt: 1, cues }, { id: 's2', name: 'v2', createdAt: 2, cues }] })
    const theirs = makeDoc(cues, { title: '新标题', snapshots: [{ id: 's1', name: 'v1', createdAt: 1, cues }] })
    const result = mergeDocuments(base, mine, theirs)
    expect(result.title).toBe('新标题')
    expect(result.snapshots.map((snapshot) => snapshot.id)).toEqual(['s2', 's1'])
  })
})

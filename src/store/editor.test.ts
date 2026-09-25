// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { IDBFactory } from 'fake-indexeddb'

type EditorStoreModule = typeof import('./editor')

let useEditorStore: EditorStoreModule['useEditorStore']

const waitFor = async (cond: () => boolean, timeout = 3000) => {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > timeout) throw new Error('waitFor timeout')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

// 每个用例使用全新的模块实例与 IndexedDB，模拟两个互不影响的标签页。
beforeEach(async () => {
  vi.resetModules()
  globalThis.indexedDB = new IDBFactory()
  ;({ useEditorStore } = await import('./editor'))
})

afterEach(async () => {
  // 等防抖保存的定时器全部落定，避免污染下一个用例。
  await new Promise((resolve) => setTimeout(resolve, 800))
})

const openTabs = async () => {
  setActivePinia(createPinia())
  const tabA = useEditorStore()
  await tabA.initialize()
  setActivePinia(createPinia())
  const tabB = useEditorStore()
  await tabB.initialize()
  return { tabA, tabB }
}

describe('多标签页按条合并', () => {
  it('单边改动自动合并：对方改的台词用对方的，本页改的保留，不产生人工冲突', async () => {
    const { tabA, tabB } = await openTabs()
    tabB.updateCue('cue-demo-02', { target: '对方改的译文' })
    await tabB.persist()
    expect(tabB.saveState).toBe('saved')

    tabA.updateCue('cue-demo-04', { target: '本页改的译文' })
    await tabA.persist()
    await waitFor(() => !tabA.merging && tabA.saveState === 'saved')

    expect(tabA.conflict).toBe(false)
    expect(tabA.pendingMerge).toBeNull()
    expect(tabA.document.cues.find((cue) => cue.id === 'cue-demo-02')?.target).toBe('对方改的译文')
    expect(tabA.document.cues.find((cue) => cue.id === 'cue-demo-04')?.target).toBe('本页改的译文')
    expect(tabA.mergeNotice).not.toBe('')
  })

  it('合并结果可以撤销，撤销后回到合并前的本页内容', async () => {
    const { tabA, tabB } = await openTabs()
    tabB.updateCue('cue-demo-02', { target: '对方改的译文' })
    await tabB.persist()

    tabA.updateCue('cue-demo-04', { target: '本页改的译文' })
    await tabA.persist()
    await waitFor(() => !tabA.merging && tabA.saveState === 'saved')
    expect(tabA.past.at(-1)?.label).toBe('merge-remote')

    tabA.undo()
    expect(tabA.document.cues.find((cue) => cue.id === 'cue-demo-02')?.target).not.toBe('对方改的译文')
    expect(tabA.document.cues.find((cue) => cue.id === 'cue-demo-04')?.target).toBe('本页改的译文')
  })

  it('同一条两边都改过才列出，逐条挑边后自动保存，其余字段不回退', async () => {
    const { tabA, tabB } = await openTabs()
    tabB.updateCue('cue-demo-03', { target: '对方的译文' })
    await tabB.persist()

    tabA.updateCue('cue-demo-03', { target: '本页的译文', speed: 1.5 })
    await tabA.persist()
    await waitFor(() => !!tabA.pendingMerge)

    expect(tabA.conflict).toBe(true)
    expect(tabA.pendingMerge?.conflicts).toHaveLength(1)
    const item = tabA.pendingMerge!.conflicts[0]
    expect(item.cueId).toBe('cue-demo-03')
    expect(item.contests.map((contest) => contest.field)).toEqual(['target'])

    await tabA.resolveMerge({ 'cue-demo-03': 'theirs' })
    await waitFor(() => !tabA.merging && tabA.saveState === 'saved')
    const cue = tabA.document.cues.find((entry) => entry.id === 'cue-demo-03')
    expect(cue?.target).toBe('对方的译文')
    expect(cue?.speed).toBe(1.5)
    expect(tabA.pendingMerge).toBeNull()
    expect(tabA.conflict).toBe(false)

    tabA.undo()
    expect(tabA.document.cues.find((entry) => entry.id === 'cue-demo-03')?.target).toBe('本页的译文')
  })

  it('本页删除而对方改过的台词列为冲突，挑对方可连内容一起恢复', async () => {
    const { tabA, tabB } = await openTabs()
    tabB.updateCue('cue-demo-05', { target: '对方补的译文' })
    await tabB.persist()

    tabA.deleteCue('cue-demo-05')
    await tabA.persist()
    await waitFor(() => !!tabA.pendingMerge)

    const item = tabA.pendingMerge!.conflicts[0]
    expect(item.cueId).toBe('cue-demo-05')
    expect(item.mineDeleted).toBe(true)

    await tabA.resolveMerge({ 'cue-demo-05': 'theirs' })
    await waitFor(() => !tabA.merging && tabA.saveState === 'saved')
    const index = tabA.document.cues.findIndex((entry) => entry.id === 'cue-demo-05')
    expect(index).toBe(4)
    expect(tabA.document.cues[index].target).toBe('对方补的译文')
  })
})

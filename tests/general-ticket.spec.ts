import { existsSync, mkdirSync, realpathSync, renameSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defaultPrompts } from '../src/app/prompts.ts'
import { generalDirectory, inputMessage, ticketExecution } from '../src/executor/dsh.ts'
import type { Ticket } from '../src/core/index.ts'
import { feishu, startRuntime, type Host } from './fixtures/host.ts'

let h: Host, root: string
beforeEach(async () => {
  h = await startRuntime()
  root = join(h.directory, 'general')
  mkdirSync(root)
  const settings = h.runtime.store.settings()
  h.runtime.store.saveSettings({ ...settings, paused: true, executor: { ...settings.executor, generalRoots: [root], prepare: 'repo-prepare-only' } })
})
afterEach(async () => { await h.stop() })

async function accept(directory?: string, extra: Record<string, unknown> = {}, id = '1'): Promise<Ticket> {
  const trigger = feishu(id, '@bot 整理一份本地说明')
  h.runtime.receive(trigger)
  const result = await h.route({ action: 'accept', kind: 'general', trigger_id: trigger.id, title: '本地说明', acknowledgement: '整理本地说明。',
    ...(directory !== undefined ? { directory } : {}), ...extra })
  return h.runtime.store.tickets.get((result.ticket as { ticket_id: string }).ticket_id)!
}
const launch = async () => { await h.runtime.settings.pause(false, 'panel'); await h.runtime.idle() }

describe('general tickets', () => {
  it('rejects an out-of-bounds directory before recording a ticket, decision or acknowledgement', async () => {
    const before = h.runtime.store.decisions.byThread(`feishu:unused`)
    await expect(accept(join(h.directory, 'general-sibling', 'new'))).rejects.toThrow('outside executor.generalRoots')
    expect(h.runtime.store.tickets.list()).toEqual([])
    const trigger = feishu('1', '@bot 整理一份本地说明')
    expect(h.runtime.store.triggers.disposition(trigger.id)?.decisionId).toBeUndefined()
    expect(h.runtime.store.decisions.byThread(`${trigger.source}:${trigger.threads[0]!.id}`)).toEqual(before)
    expect(h.deliveries.mock.calls.filter(([call]) => call.sessionId.startsWith('worker-'))).toEqual([])
    expect(existsSync(join(h.directory, 'general-sibling'))).toBe(false)
  })

  it('rejects an existing symlink escape and a missing child below the escape', async () => {
    const outside = join(h.directory, 'outside')
    mkdirSync(outside)
    symlinkSync(outside, join(root, 'escape'))
    await expect(accept(join(root, 'escape'))).rejects.toThrow('outside executor.generalRoots')
    await expect(accept(join(root, 'escape', 'new'), {}, '2')).rejects.toThrow('outside executor.generalRoots')
    expect(existsSync(join(outside, 'new'))).toBe(false)
    expect(h.runtime.store.tickets.list()).toEqual([])
  })

  it('rejects every general ticket when generalRoots is empty, including an omitted directory', async () => {
    const settings = h.runtime.store.settings()
    h.runtime.store.saveSettings({ ...settings, executor: { ...settings.executor, generalRoots: [] } })
    await expect(accept(root)).rejects.toThrow('generalRoots is empty')
    await expect(accept(undefined, {}, '2')).rejects.toThrow('generalRoots is empty')
    expect(h.runtime.store.tickets.list()).toEqual([])
  })

  it('rejects relative, empty and file paths rather than falling back to repo', async () => {
    await expect(accept('relative')).rejects.toThrow('absolute directory')
    await expect(accept('', {}, '2')).rejects.toThrow('absolute directory')
    const file = join(root, 'file')
    writeFileSync(file, 'keep')
    await expect(accept(file, {}, '3')).rejects.toThrow('Not a directory')
    expect(h.runtime.store.tickets.list()).toEqual([])
  })

  it('rejects dangling symlinks rather than creating their target', async () => {
    const target = join(h.directory, 'missing')
    symlinkSync(target, join(root, 'dangling'))
    await expect(accept(join(root, 'dangling', 'child'))).rejects.toThrow('Unresolved directory symlink')
    expect(existsSync(target)).toBe(false)
  })

  it('does not run prepare, create a worktree or perform git verification for general work', async () => {
    const ticket = await accept(join(root, 'new'))
    h.subprocess.spawn.mockClear()
    await launch()
    expect(h.subprocess.spawn).not.toHaveBeenCalled()
    expect(existsSync(ticket.execution!.directory)).toBe(true)
    expect(h.runtime.store.tickets.get(ticket.id)?.assignments[0]?.state).toBe('running')
  })

  it('uses the canonical directory as the worker workspace and sets workspace-write before delivering work', async () => {
    const actual = join(root, 'actual')
    mkdirSync(actual)
    symlinkSync(actual, join(root, 'alias'))
    const ticket = await accept(join(root, 'alias'))
    const permissions = vi.spyOn(h.ctx.permissionPresets, 'set')
    const prompt = vi.spyOn(h.runtime.sessions, 'prompt')
    await launch()
    const sessionId = `worker-${ticket.id}`
    expect(ticket.mandate).toMatchObject({ kind: 'general', directory: realpathSync(actual) })
    expect(h.runtime.store.decisions.get(ticket.decisionId)?.mandate).toEqual(ticket.mandate)
    expect(h.controller.create).toHaveBeenCalledWith(expect.objectContaining({ sessionId, workspaceId: realpathSync(actual) }))
    expect(permissions).toHaveBeenLastCalledWith(h.agents.get(sessionId)!.session, 'workspace-write')
    const delivery = prompt.mock.calls.findIndex(([id]) => id === sessionId)
    expect(permissions.mock.invocationCallOrder.at(-1)!).toBeLessThan(prompt.mock.invocationCallOrder[delivery]!)
  })

  it('chooses generalRoots[0]/<ticket id> and creates it only when the executor launches', async () => {
    const ticket = await accept()
    const directory = join(realpathSync(root), ticket.id)
    expect(ticket.mandate).toMatchObject({ kind: 'general', directory })
    expect(ticket.execution?.directory).toBe(directory)
    expect(existsSync(directory)).toBe(false)
    await launch()
    expect(existsSync(directory)).toBe(true)
  })

  it('accepts a directory under a later root and canonicalizes symlinked roots', async () => {
    const second = join(h.directory, 'second'), alias = join(h.directory, 'second-alias')
    mkdirSync(second); symlinkSync(second, alias)
    const settings = h.runtime.store.settings()
    h.runtime.store.saveSettings({ ...settings, executor: { ...settings.executor, generalRoots: [root, alias] } })
    expect((await accept(join(alias, 'child'))).mandate.directory).toBe(join(realpathSync(second), 'child'))
  })

  it('rechecks symlinks between acceptance and launch and never starts an escaped worker', async () => {
    const directory = join(root, 'work'), outside = join(h.directory, 'outside')
    mkdirSync(directory); mkdirSync(outside)
    const ticket = await accept(directory)
    renameSync(directory, join(root, 'old-work')); symlinkSync(outside, directory)
    await launch()
    expect(h.agents.has(`worker-${ticket.id}`)).toBe(false)
    expect(h.runtime.store.tickets.get(ticket.id)?.assignments[0]?.report).toMatchObject({ state: 'failed', summary: expect.stringContaining('outside executor.generalRoots') })
  })

  it('refuses launch when roots are revoked after acceptance', async () => {
    const ticket = await accept()
    const settings = h.runtime.store.settings()
    h.runtime.store.saveSettings({ ...settings, executor: { ...settings.executor, generalRoots: [] } })
    await launch()
    expect(h.agents.has(`worker-${ticket.id}`)).toBe(false)
    expect(h.runtime.store.tickets.get(ticket.id)?.assignments[0]?.report?.summary).toContain('generalRoots is empty')
  })

  it('keeps repo accepts and legacy tickets on the original preparation and permission path', async () => {
    const ticket = await accept(undefined, { action: undefined, kind: 'accept', worktree_name: 'fix-local' })
    expect(ticket.mandate.kind).toBe('repo')
    expect(ticket.mandate.directory).toBeUndefined()
    const legacy = { ...ticket, mandate: { ...ticket.mandate } }
    delete legacy.mandate.kind
    h.runtime.store.tickets.save(legacy)
    expect(ticketExecution(legacy, { kind: 'accept', title: ticket.title, scope: ticket.title, reason: 'request', name: 'fix-local' },
      h.runtime.store.settings(), h.directory)).toEqual(ticket.execution)
    const permissions = vi.spyOn(h.ctx.permissionPresets, 'set')
    h.subprocess.spawn.mockClear()
    await launch()
    expect(h.subprocess.spawn.mock.calls.some(([spec]) => spec.argv.includes('repo-prepare-only'))).toBe(true)
    expect(h.subprocess.spawn.mock.calls.length).toBeGreaterThan(1)
    expect(h.controller.create).toHaveBeenCalledWith(expect.objectContaining({ sessionId: `worker-${ticket.id}`, workspaceId: ticket.execution!.directory }))
    expect(permissions).toHaveBeenLastCalledWith(h.agents.get(`worker-${ticket.id}`)!.session, 'danger-full-access')
  })

  it('defaults action=accept to repo and rejects a directory without kind=general', async () => {
    await expect(accept(root, { kind: 'repo', worktree_name: 'fix-local' })).rejects.toThrow('directory requires kind=general')
    const ticket = await accept(undefined, { kind: undefined, worktree_name: 'fix-local' }, '2')
    expect(ticket.mandate.kind).toBe('repo')
  })

  it('selects the general worker prompt with no repository delivery requirements', async () => {
    const ticket = await accept()
    const prompt = h.runtime.prompts.compose(defaultPrompts(), 'worker', [{ key: 'DSH_SUPERAGENT_TICKET', value: ticket.id,
      owner: 'executor', description: { zh: '工单', en: 'Ticket' } }])
    expect(prompt).toContain('worker for a general ticket')
    expect(prompt).toContain('orchestrator_report')
    expect(prompt).not.toMatch(/Use gh|commit as|PR creation|code change without a PR|worktree/)
    expect(inputMessage({ kind: 'resumed', id: 'resume', triggerId: 'followup', at: '' }, undefined, 'general')).not.toMatch(/worktree|git|PR/)
  })

  it('keeps an accepted general ticket idempotent when routed again', async () => {
    const first = await accept()
    const again = await accept(join(root, 'another'))
    expect(again).toEqual(first)
    expect(h.runtime.store.tickets.list()).toHaveLength(1)
  })

  it('checks traversal and allows the configured root itself', () => {
    expect(() => generalDirectory(join(root, '..', 'outside'), [root])).toThrow('outside executor.generalRoots')
    expect(generalDirectory(root, [root])).toBe(realpathSync(root))
  })
})

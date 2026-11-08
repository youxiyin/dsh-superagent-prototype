import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ensureFleetWorktree, fleetWorktreePath, type FleetGitRun } from '../src/app/tools/fleet-worktree.ts'

let root: string, repository: string, ticket: string, calls: string[][]

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, HOME: root, GIT_CONFIG_NOSYSTEM: '1' } }).trim()
}

const run: FleetGitRun = async (program, args, cwd) => {
  calls.push([program, ...args])
  return execFileSync(program, args, { cwd, encoding: 'utf8', env: { ...process.env, HOME: root, GIT_CONFIG_NOSYSTEM: '1' } })
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'fleet-worktree-')))
  repository = join(root, 'repository')
  ticket = repository
  mkdirSync(ticket, { recursive: true })
  git(repository, ['init', '--quiet'])
  git(repository, ['config', 'user.name', 'Fleet Test'])
  git(repository, ['config', 'user.email', 'fleet@example.invalid'])
  writeFileSync(join(repository, 'tracked.txt'), 'base\n')
  git(repository, ['add', 'tracked.txt'])
  git(repository, ['commit', '--quiet', '--no-verify', '-m', 'initial'])
  calls = []
})

afterEach(() => { rmSync(root, { recursive: true, force: true }) })

describe('fleet worktrees', () => {
  it('creates a clean detached HEAD worktree at the card path and excludes it from repository status', async () => {
    const worktree = fleetWorktreePath(ticket, 'card-1')
    expect(worktree).toBe(join(ticket, '.fleet', 'worktrees', 'card-1'))
    await expect(ensureFleetWorktree(ticket, 'card-1', run)).resolves.toBe(worktree)

    expect(git(worktree, ['rev-parse', 'HEAD'])).toBe(git(repository, ['rev-parse', 'HEAD']))
    expect(git(worktree, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('HEAD')
    expect(git(worktree, ['status', '--porcelain'])).toBe('')
    expect(git(repository, ['status', '--porcelain'])).toBe('')
    expect(readFileSync(join(repository, '.git', 'info', 'exclude'), 'utf8'))
      .toContain('/.fleet/worktrees/card-1/\n')
  })

  it('appends exclude idempotently, preserves other rules and repairs a missing final newline', async () => {
    const exclude = join(repository, '.git', 'info', 'exclude')
    writeFileSync(exclude, '# local rules\n*.log')
    const worktree = await ensureFleetWorktree(ticket, 'card-1', run)
    const expected = '# local rules\n*.log\n/.fleet/worktrees/card-1/\n'
    expect(readFileSync(exclude, 'utf8')).toBe(expected)

    await expect(ensureFleetWorktree(ticket, 'card-1', run)).resolves.toBe(worktree)
    expect(readFileSync(exclude, 'utf8')).toBe(expected)
    expect(readFileSync(exclude, 'utf8').match(/\/\.fleet\/worktrees\/card-1\//g)).toHaveLength(1)
  })

  it('falls back without invoking Git outside a repository', async () => {
    const ordinary = join(root, 'ordinary')
    mkdirSync(ordinary)
    await expect(ensureFleetWorktree(ordinary, 'card-1', run)).resolves.toBeUndefined()
    expect(calls).toEqual([])
    expect(existsSync(fleetWorktreePath(ordinary, 'card-1'))).toBe(false)
  })

  it('falls back without creating a worktree in a repository with no HEAD commit', async () => {
    const unborn = join(root, 'unborn')
    mkdirSync(unborn)
    git(unborn, ['init', '--quiet'])
    calls = []
    await expect(ensureFleetWorktree(unborn, 'card-1', run)).resolves.toBeUndefined()
    expect(calls.map(call => call.slice(1, 3))).toEqual([
      ['rev-parse', '--show-toplevel'],
      ['rev-parse', '--verify'],
    ])
    expect(existsSync(fleetWorktreePath(unborn, 'card-1'))).toBe(false)
  })

  it('reuses a valid worktree and keeps worker changes without merge, move or deletion commands', async () => {
    const worktree = await ensureFleetWorktree(ticket, 'card-1', run)
    writeFileSync(join(worktree!, 'worker-output.txt'), 'keep me\n')
    const head = git(repository, ['rev-parse', 'HEAD'])

    await expect(ensureFleetWorktree(ticket, 'card-1', run)).resolves.toBe(worktree)
    expect(readFileSync(join(worktree!, 'worker-output.txt'), 'utf8')).toBe('keep me\n')
    expect(calls.filter(call => call[1] === 'worktree' && call[2] === 'add')).toHaveLength(1)
    expect(calls.every(call => call[0] === 'git' && ['rev-parse', 'worktree'].includes(call[1]!))).toBe(true)
    expect(git(repository, ['rev-parse', 'HEAD'])).toBe(head)
  })

  it('does not reuse a symlink disguised as a worktree', async () => {
    const legitimate = await ensureFleetWorktree(ticket, 'legitimate', run)
    const disguised = fleetWorktreePath(ticket, 'disguised')
    symlinkSync(legitimate!, disguised, 'dir')
    calls = []

    await expect(ensureFleetWorktree(ticket, 'disguised', run)).rejects.toThrow()
    expect(calls.some(call => call[1] === 'worktree' && call[2] === 'add' && call.includes(disguised))).toBe(true)
    expect(readFileSync(join(legitimate!, 'tracked.txt'), 'utf8')).toBe('base\n')
  })
})

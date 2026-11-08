/** Per-card Git worktrees for fleet workers; the host never merges or removes them. */
import { appendFileSync, existsSync, lstatSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

export type FleetGitRun = (program: string, args: string[], cwd: string) => Promise<string>

/** The host-owned worktree path for one fleet card slug. */
export function fleetWorktreePath(directory: string, id: string): string {
  return join(directory, '.fleet', 'worktrees', id)
}

/** Avoid spawning Git for an ordinary non-repository ticket, including tickets in repository subdirectories. */
function hasGitMarker(directory: string): boolean {
  for (let current = directory; ; current = dirname(current)) {
    if (lstatSync(join(current, '.git'), { throwIfNoEntry: false })) return true
    const parent = dirname(current)
    if (parent === current) return false
  }
}

/** Append one repository-relative ignore rule without rewriting any existing exclude content. */
function excludeWorktree(commonDir: string, repository: string, worktree: string): void {
  const info = join(commonDir, 'info')
  const file = join(info, 'exclude')
  let previous = ''
  try { previous = readFileSync(file, 'utf8') } catch { /* A missing exclude is created by append. */ }
  const pattern = `/${relative(repository, worktree).split(sep).join('/')}/`
  if (previous.split(/\r?\n/).includes(pattern)) return
  mkdirSync(info, { recursive: true })
  appendFileSync(file, `${previous && !previous.endsWith('\n') ? '\n' : ''}${pattern}\n`, 'utf8')
}

/**
 * Create (or reuse) a clean detached worktree at HEAD for one card. Outside a Git repository, or before its first
 * commit, there is no worktree and the caller keeps its legacy ticket-directory path. Existing worker output is kept.
 */
export async function ensureFleetWorktree(directory: string, id: string, run: FleetGitRun): Promise<string | undefined> {
  if (!hasGitMarker(directory)) return undefined
  let repository: string
  try { repository = (await run('git', ['rev-parse', '--show-toplevel'], directory)).trim() }
  catch { return undefined }
  if (!isAbsolute(repository)) return undefined
  try { await run('git', ['rev-parse', '--verify', 'HEAD'], directory) }
  catch { return undefined }
  const common = (await run('git', ['rev-parse', '--git-common-dir'], directory)).trim()
  const worktree = fleetWorktreePath(directory, id)
  excludeWorktree(resolve(repository, common), repository, worktree)
  if (existsSync(worktree)) {
    const root = lstatSync(worktree, { throwIfNoEntry: false })
    const marker = lstatSync(join(worktree, '.git'), { throwIfNoEntry: false })
    if (root && !root.isSymbolicLink() && marker?.isFile()) return worktree
  }
  mkdirSync(dirname(worktree), { recursive: true })
  await run('git', ['worktree', 'add', '--detach', worktree], directory)
  return worktree
}

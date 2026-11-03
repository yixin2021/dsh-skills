/**
 * DSH Skills — what a skill looks like inside a file tree.
 *
 * A skill is one directory bundle: `<dir>/SKILL.md` plus whatever it
 * references. Both ways of reading a remote repository — a GitHub archive and
 * a git clone — end up as the same thing: a map of repository-relative paths
 * to bytes. This module owns that map's policy: which paths may become a file
 * name, which directories are worth looking inside, and which files belong to
 * one skill directory.
 *
 * The policy lives here rather than in either fetcher because the two must
 * agree. A skill found in a clone and the same skill found in an archive are
 * the same skill, and a person must not get a different answer because the
 * repository happened to live on another host.
 *
 * @module dsh-skills/skill-tree
 */

import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { MAX_INSTALL_BYTES, MAX_INSTALL_FILES, SKILL_FILE, describeSkill } from './skills-core.js'

/** Directories that never hold a skill worth installing. */
export const IGNORED_DIRS = new Set([
  '.git',
  '.github',
  'node_modules',
  '.disabled',
  '.trash',
  '__pycache__',
  '.venv',
  'venv',
  'dist',
  'build',
])

/** How many candidates are worth showing in a picker. */
export const MAX_CANDIDATES = 40

/** How deep a candidate may sit below the repository root. */
export const MAX_DEPTH = 4

/** How many branch names are tried when a link cannot say where the branch ends. */
const MAX_REF_GROWTH = 3

/** How deep the tree walk may go at all. */
export const MAX_TREE_DEPTH = 12

/** Files one remote tree may hold. */
export const MAX_TREE_FILES = 2000

/** Bytes one remote tree may hold in total. */
export const MAX_TREE_BYTES = 64 * 1024 * 1024

/** Bytes one file of a remote tree may hold. */
export const MAX_TREE_FILE_BYTES = 16 * 1024 * 1024

/**
 * Split a path into segments, refusing anything that could leave a directory.
 *
 * @param path - the tree-relative path.
 * @returns the clean segments, or undefined when the path is not one a skill
 * directory may contain.
 */
export function safeSegments(path) {
  if (typeof path !== 'string' || path.length === 0) return undefined
  if (path.startsWith('/') || path.includes('\\') || path.includes('\0')) return undefined
  const segments = path.split('/').filter((segment) => segment.length > 0 && segment !== '.')
  if (segments.length === 0) return undefined
  if (segments.some((segment) => segment === '..')) return undefined
  return segments
}

/**
 * The branch names worth trying for a link whose branch contains slashes.
 *
 * `https://github.com/o/r/tree/release/2.0/skills/foo` cannot be split
 * without knowing the branch; `release` alone will 404, so the segments after
 * `tree` are tried as refs from shortest to longest, with the remainder as the
 * path.
 *
 * The common single-segment branch costs one request, and a `release/2.0`
 * branch costs two rather than failing outright.
 *
 * @param parsed - the ref and path from the link.
 * @returns candidate `{ ref, path }` pairs, shortest ref first.
 */
export function refAttempts(parsed) {
  const pieces =
    parsed.ref === undefined ? [] : parsed.ref.split('/').concat(parsed.path === undefined ? [] : parsed.path.split('/'))
  if (pieces.length === 0) return [{ ref: undefined, path: '' }]
  const most = Math.min(MAX_REF_GROWTH, pieces.length)
  const attempts = []
  for (let take = 1; take <= most; take += 1) {
    attempts.push({ ref: pieces.slice(0, take).join('/'), path: pieces.slice(take).join('/') })
  }
  return attempts
}

/**
 * @param files - tree-relative paths to bytes.
 * @param path - the directory to look for.
 * @returns whether the tree holds anything under that directory.
 */
export function treeHasPath(files, path) {
  if (path.length === 0) return true
  const prefix = `${path}/`
  for (const key of files.keys()) {
    if (key.startsWith(prefix)) return true
  }
  return false
}

/**
 * Every directory in the tree that holds a SKILL.md.
 *
 * A repository of one skill has one candidate at its root. A repository of
 * many has one per bundle, which is the case a picker exists for.
 *
 * @param files - tree-relative paths to bytes.
 * @returns candidates, shallowest first, each with its name and description.
 */
export function findSkillCandidates(files) {
  const candidates = []
  for (const path of files.keys()) {
    const segments = safeSegments(path)
    if (segments === undefined) continue
    if (segments[segments.length - 1] !== SKILL_FILE) continue
    const dir = segments.slice(0, -1)
    if (dir.length > MAX_DEPTH) continue
    if (dir.some((segment) => IGNORED_DIRS.has(segment) || segment.startsWith('.'))) continue
    const text = files.get(path).toString('utf8')
    const described = describeSkill({ text, entryName: dir.length === 0 ? 'skill' : dir[dir.length - 1], entryKind: 'directory' })
    candidates.push({
      path: dir.join('/'),
      name: described.name,
      description: described.description,
      depth: dir.length,
    })
  }
  candidates.sort((left, right) => left.depth - right.depth || left.path.localeCompare(right.path))
  return candidates
}

/**
 * Pick the files that belong to one skill directory, with limit metadata.
 *
 * @param files - tree-relative paths to bytes.
 * @param dir - the candidate's directory, or an empty string for the root.
 * @returns the files and whether the bundle exceeded an install limit.
 */
export function collectSkillFilesDetailed(files, dir) {
  const prefix = dir.length === 0 ? '' : `${dir}/`
  const collected = []
  let total = 0
  let truncated = false
  for (const [path, content] of files) {
    if (prefix.length > 0 && !path.startsWith(prefix)) continue
    const relative = path.slice(prefix.length)
    const segments = safeSegments(relative)
    if (segments === undefined) continue
    if (segments.some((segment) => IGNORED_DIRS.has(segment))) continue
    const size = content.byteLength
    if (size > MAX_INSTALL_BYTES) {
      truncated = true
      continue
    }
    if (total + size > MAX_INSTALL_BYTES) {
      truncated = true
      break
    }
    if (collected.length >= MAX_INSTALL_FILES) {
      truncated = true
      break
    }
    total += size
    collected.push({ path: segments.join('/'), content })
  }
  return { files: collected, truncated, totalBytes: total }
}

/**
 * Pick the files that belong to one skill directory.
 *
 * @param files - tree-relative paths to bytes.
 * @param dir - the candidate's directory, or an empty string for the root.
 * @returns `{ path, content }` pairs relative to the skill directory.
 */
export function collectSkillFiles(files, dir) {
  return collectSkillFilesDetailed(files, dir).files
}

/**
 * Read a directory on disk as a tree of the same shape an archive has.
 *
 * Only regular files are read. A symlink is skipped rather than followed: a
 * repository may point at a file anywhere on the machine, and a skill bundle
 * has no business carrying that in. The archive reader drops links for the
 * same reason, so both paths behave alike.
 *
 * @param root - the directory to read.
 * @param options - `maxBytes` for tests, and `readFileImpl` to observe reads.
 * @returns tree-relative paths to bytes.
 */
export async function readTreeFromDisk(root, options = {}) {
  const files = new Map()
  const maxBytes = options.maxBytes ?? MAX_TREE_BYTES
  const readImpl = options.readFileImpl ?? readFile
  let total = 0
  let aborted = false

  /**
   * Walk one directory.
   * @param dir - the absolute directory.
   * @param prefix - the tree-relative prefix of that directory.
   * @param depth - how deep the walk already is.
   * @returns whether the whole walk must stop.
   */
  const walk = async (dir, prefix, depth) => {
    if (aborted || depth > MAX_TREE_DEPTH || files.size >= MAX_TREE_FILES) return aborted
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
    entries.sort((left, right) => left.name.localeCompare(right.name))
    for (const entry of entries) {
      if (aborted || files.size >= MAX_TREE_FILES) return aborted
      if (entry.name.startsWith('.')) continue
      if (entry.isSymbolicLink()) continue
      const relative = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`
      if (entry.isDirectory()) {
        await walk(join(dir, entry.name), relative, depth + 1)
        continue
      }
      if (!entry.isFile()) continue
      const content = await readImpl(join(dir, entry.name)).catch(() => undefined)
      if (content === undefined) continue
      if (content.byteLength > MAX_TREE_FILE_BYTES) continue
      total += content.byteLength
      if (total > maxBytes) {
        aborted = true
        return true
      }
      files.set(relative, content)
    }
    return aborted
  }

  await walk(root, '', 0)
  return files
}

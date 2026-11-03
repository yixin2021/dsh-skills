/**
 * DSH Skills — reading a skill out of a remote repository.
 *
 * A person points the panel at a link and expects a skill to arrive. Which
 * host the repository lives on is the platform's problem, not the person's,
 * so this module is the one place that decides:
 *
 *   - a GitHub link is read from the archive service, which answers with the
 *     whole tree in one request and no rate limit;
 *   - every other git host is read by cloning it, which is the one thing all
 *     of them support.
 *
 * Both paths end in the same tree — a map of repository-relative paths to
 * bytes — and both are handed to the same skill-tree policy, so a skill found
 * in a clone and the same skill found in an archive are the same skill.
 *
 * A link may also name a branch and a directory inside the repository. Which
 * is which is not always knowable from the link, because a branch may contain
 * a slash: the segments are therefore tried as branches from shortest to
 * longest, and the split that yields a tree holding the requested directory
 * is the one that was meant.
 *
 * @module dsh-skills/remote-source
 */

import { parseGitHubUrl, readGitHubArchive } from './github-source.js'
import { cloneRepository, parseGitUrl, removeClone } from './git-source.js'
import { readTreeFromDisk, refAttempts, safeSegments, treeHasPath } from './skill-tree.js'

/** The hosts whose web links name a branch and a directory the same way GitHub does. */
const GITHUB_LIKE_HOSTS = new Set(['gitee.com', 'gitcode.com', 'atomgit.com'])

/** The words a web link uses for the branch-and-directory part of a repository. */
const TREE_WORDS = new Set(['tree', 'blob', 'src'])

/** The marker GitLab puts between the repository and the branch in a link. */
const GITLAB_MARKER = '-'

/**
 * Trees read recently.
 *
 * Choosing one skill out of a repository takes two requests: one to see what
 * the repository holds, and one to install the choice. Without this the
 * repository would be downloaded — or cloned, which costs seconds — twice for
 * one install. The tree is held in memory for a few minutes and thrown away.
 *
 * @type {Map<string, { tree: object, expires: number }>}
 */
const cache = new Map()

/** How long a read tree stays usable. */
const TREE_TTL_MS = 5 * 60 * 1000

/** How many trees are kept at once. */
const MAX_CACHED_TREES = 3

/** Trees above this size are read again rather than kept. */
const MAX_CACHED_BYTES = 4 * 1024 * 1024

/**
 * Read a link that names a repository, and where in it a skill may live.
 *
 * @param input - what the person typed or pasted.
 * @returns the spec, or undefined when the input is not a remote repository.
 */
export function parseRemoteUrl(input) {
  const text = typeof input === 'string' ? input.trim() : ''
  if (text.length === 0) return undefined

  const github = parseGitHubUrl(text)
  if (github !== undefined) {
    return {
      kind: 'github',
      host: 'github.com',
      url: `https://github.com/${github.owner}/${github.repo}`,
      owner: github.owner,
      repo: github.repo,
      ref: github.ref,
      path: github.path,
    }
  }

  const git = parseGitUrl(text)
  if (git === undefined) return undefined

  const url = new URL(git.url)
  const host = url.hostname.toLowerCase()
  const web = parseWebPath(url.pathname, host)
  const ref = git.ref ?? web?.ref
  const path = web?.path
  // A web link names the branch and the directory after the repository; the
  // clone wants the repository alone.
  const clonePath = web === undefined ? url.pathname : `/${web.repoPath}`
  const authority = `${url.username.length > 0 ? `${url.username}@` : ''}${url.host}`
  return {
    kind: 'git',
    host,
    url: `${url.protocol}//${authority}${clonePath}`,
    ref,
    path,
  }
}

/**
 * Read the branch and directory out of a web link.
 *
 * The shapes are the ones the hosts publish:
 *   https://gitee.com/owner/repo/tree/main/skills/foo
 *   https://gitlab.com/owner/repo/-/tree/main/skills/foo
 *   https://bitbucket.org/owner/repo/src/main/skills/foo
 *
 * A host this module does not know is left alone unless its path carries
 * GitLab's `/-/` marker, which is distinctive enough to read on any host.
 *
 * @param pathname - the path of the link.
 * @param host - the host of the link.
 * @returns the ref, the directory and the repository path, or undefined when
 * the link names none of them.
 */
function parseWebPath(pathname, host) {
  const segments = pathname.split('/').filter((segment) => segment.length > 0)
  if (segments.length < 4) return undefined

  const gitlabish = segments.includes(GITLAB_MARKER)
  const known = GITHUB_LIKE_HOSTS.has(host) || host === 'gitlab.com' || host === 'bitbucket.org' || gitlabish
  if (!known) return undefined

  for (let index = 2; index < segments.length; index += 1) {
    const word = segments[index]
    const marker = gitlabish && word === GITLAB_MARKER
    const next = marker ? segments[index + 1] : word
    if (!TREE_WORDS.has(next)) continue
    const ref = segments[marker ? index + 2 : index + 1]
    if (ref === undefined) return undefined
    const rest = segments.slice(marker ? index + 3 : index + 2)
    const path = rest.join('/')
    const safe = safeSegments(path)
    return {
      ref,
      path: safe === undefined ? undefined : safe.join('/'),
      repoPath: segments.slice(0, index).join('/'),
    }
  }
  return undefined
}

/**
 * Forget every tree that was read recently.
 *
 * The cache exists so that choosing one skill out of a repository does not
 * read it twice. A caller that knows the repository has changed — or a test
 * that serves a different repository under the same link — throws the cache
 * away rather than waiting for it to expire.
 */
export function clearTreeCache() {
  cache.clear()
}

/**
 * Read one remote repository and return its tree.
 *
 * @param spec - the spec `parseRemoteUrl` produced.
 * @param options - `fetchImpl`, `execImpl` and `token`.
 * @returns the tree-relative files, the ref that was read and the directory
 * the link named.
 */
export async function readRemoteTree(spec, options) {
  const key = cacheKey(spec, options)
  const hit = cache.get(key)
  if (hit !== undefined && hit.expires > Date.now()) {
    // The most recently read tree is the most likely to be read again.
    cache.delete(key)
    cache.set(key, hit)
    return hit.tree
  }

  const tree = await readTree(spec, options)
  if (treeBytes(tree) <= MAX_CACHED_BYTES) {
    cache.set(key, { tree, expires: Date.now() + TREE_TTL_MS })
    while (cache.size > MAX_CACHED_TREES) {
      const oldest = cache.keys().next().value
      cache.delete(oldest)
    }
  }
  return tree
}

/**
 * Read the tree of one repository, without consulting the cache.
 *
 * @param spec - the spec `parseRemoteUrl` produced.
 * @param options - `fetchImpl`, `execImpl` and `token`.
 * @returns the tree-relative files, the ref that was read and the directory
 * the link named.
 */
async function readTree(spec, options) {
  if (spec.kind === 'github') {
    const tree = await readGitHubArchive(
      { owner: spec.owner, repo: spec.repo, ref: spec.ref, path: spec.path },
      options,
    )
    return { files: tree.files, ref: tree.ref, path: tree.path }
  }

  // A git host is cloned. The branch may be one of several readings of the
  // same link, so the readings are tried in turn until one clones.
  const attempts = refAttempts({ ref: spec.ref, path: spec.path })
  let fallback
  let lastError
  for (const attempt of attempts) {
    let dir
    try {
      dir = await cloneRepository({ url: spec.url, ref: attempt.ref }, options)
    } catch (error) {
      lastError = error
      if (error?.code === 'no-git') throw error
      continue
    }
    try {
      const files = await readTreeFromDisk(dir)
      const found = { files, ref: attempt.ref, path: attempt.path }
      if (fallback === undefined) fallback = found
      if (attempt.path === '' || treeHasPath(files, attempt.path)) return found
    } finally {
      await removeClone(dir)
    }
  }
  if (fallback !== undefined) return fallback
  throw lastError
}

/**
 * The key one read is remembered under.
 *
 * The token is part of it, because two tokens may see two different
 * repositories — but only its hash is kept, so the secret itself is not
 * sitting in a map for five minutes.
 *
 * @param spec - the spec `parseRemoteUrl` produced.
 * @param options - the caller's options.
 * @returns the key.
 */
function cacheKey(spec, options) {
  const token = typeof options?.token === 'string' ? options.token : ''
  let hash = 0x811c9dc5
  for (let index = 0; index < token.length; index += 1) {
    hash ^= token.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return [spec.kind, spec.url, spec.ref ?? '', spec.path ?? '', hash.toString(16)].join('|')
}

/**
 * How many bytes a tree holds.
 *
 * @param tree - the tree to measure.
 * @returns the byte count.
 */
function treeBytes(tree) {
  let total = 0
  for (const content of tree.files.values()) total += content.byteLength
  return total
}

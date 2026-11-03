/**
 * DSH Skills — reading a skill out of a GitHub repository.
 *
 * A skill that lives in a repository is one directory bundle: `<dir>/SKILL.md`
 * plus whatever it references. This module turns a GitHub link into that
 * bundle: parse the link, download the repository archive once, unpack it in
 * memory, and hand the tree to the shared skill-tree policy.
 *
 * The archive route (`codeload.github.com`) is deliberate. It answers with the
 * whole tree in one request and no rate limit, where the REST API would need
 * one request per file and sixty an hour. A token switches the download to the
 * API's tarball endpoint, which is the only way to reach a private repository.
 *
 * The tar reader is small on purpose. Node has gzip (`node:zlib`) but no tar,
 * and a plugin that installs from git must not carry a dependency it cannot
 * resolve offline. What GitHub emits is ustar with pax path records; that is
 * what this reads, and it refuses everything else rather than guessing.
 *
 * @module dsh-skills/github-source
 */

import { gunzipSync } from 'node:zlib'

import { refAttempts, safeSegments, treeHasPath } from './skill-tree.js'

/** Bytes of one repository archive this module will download. */
export const MAX_ARCHIVE_BYTES = 24 * 1024 * 1024

/** Bytes of the unpacked archive, before a single file is looked at. */
export const MAX_UNPACKED_BYTES = 64 * 1024 * 1024

/**
 * Read a NUL-terminated field out of a tar header.
 *
 * @param field - the raw bytes.
 * @returns the text up to the first NUL.
 */
function readField(field) {
  const end = field.indexOf(0)
  return field.subarray(0, end === -1 ? field.length : end).toString('utf8')
}

/**
 * Decode a tar size field, which may be octal text or base-256.
 *
 * @param field - the twelve size bytes.
 * @returns the byte count.
 */
function readSize(field) {
  if ((field[0] & 0x80) !== 0) {
    let value = 0
    for (let index = 1; index < field.length; index += 1) value = value * 256 + field[index]
    return value
  }
  const text = readField(field).trim()
  if (text.length === 0) return 0
  const value = Number.parseInt(text, 8)
  return Number.isFinite(value) && value >= 0 ? value : 0
}

/**
 * Parse one pax extended header into the keys it carries.
 *
 * Records are `<length> <key>=<value>\n`, where the length counts itself.
 *
 * @param data - the header's payload.
 * @returns the decoded records.
 */
function readPax(data) {
  const records = {}
  let offset = 0
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset)
    if (space === -1) break
    const length = Number.parseInt(data.subarray(offset, space).toString('utf8'), 10)
    if (!Number.isFinite(length) || length <= 0 || offset + length > data.length) break
    const record = data.subarray(space + 1, offset + length - 1).toString('utf8')
    const equals = record.indexOf('=')
    if (equals > 0) records[record.slice(0, equals)] = record.slice(equals + 1)
    offset += length
  }
  return records
}

/**
 * Unpack a gzipped tar archive held in memory.
 *
 * Only regular files are returned: directories carry no bytes a skill needs,
 * and links and devices are dropped so an archive cannot point a later write
 * outside the directory it was unpacked into.
 *
 * @param gzip - the bytes as downloaded.
 * @returns the regular files, keyed by archive path.
 * @throws when the archive is not gzip, or unpacks to more than MAX_UNPACKED_BYTES.
 */
export function readArchive(gzip) {
  let tar
  try {
    tar = gunzipSync(gzip, { maxOutputLength: MAX_UNPACKED_BYTES })
  } catch (error) {
    throw new Error(`That archive could not be unpacked (${error instanceof Error ? error.message : String(error)}).`)
  }
  const files = new Map()
  let offset = 0
  let pax = {}
  let longName
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512)
    if (header.every((byte) => byte === 0)) break
    const size = readSize(header.subarray(124, 136))
    const type = header[156] === 0 ? '0' : String.fromCharCode(header[156])
    const prefix = readField(header.subarray(345, 500))
    const base = readField(header.subarray(0, 100))
    const name = prefix.length > 0 ? `${prefix}/${base}` : base
    const start = offset + 512
    const end = start + size
    if (end > tar.length) break
    const data = tar.subarray(start, end)
    offset = start + Math.ceil(size / 512) * 512
    if (type === 'x') {
      pax = readPax(data)
      continue
    }
    if (type === 'g') continue
    if (type === 'L') {
      longName = readField(data)
      continue
    }
    const path = pax.path ?? longName ?? name
    const isFile = type === '0' || type === '7'
    pax = {}
    longName = undefined
    if (!isFile) continue
    const segments = safeSegments(path)
    if (segments === undefined) continue
    files.set(segments.join('/'), data)
  }
  return files
}

/**
 * Split an owner/repo pair off a GitHub link.
 *
 * Accepted forms, all pointing at the same repository:
 *   https://github.com/owner/repo
 *   https://github.com/owner/repo/tree/<ref>/<path>
 *   https://github.com/owner/repo/blob/<ref>/<path>/SKILL.md
 *   https://github.com/owner/repo.git
 *   owner/repo
 *
 * A path that ends in `SKILL.md` names the directory that holds it, because
 * that is what a person means when they copy the link of the file they are
 * reading.
 *
 * @param input - what the person typed or pasted.
 * @returns the repository, the ref (or undefined for the default branch) and
 * the directory inside it; undefined when the input is not a GitHub link.
 */
export function parseGitHubUrl(input) {
  const text = typeof input === 'string' ? input.trim() : ''
  if (text.length === 0) return undefined

  let rest
  const withScheme = /^https?:\/\/(?:www\.)?github\.com\/(.+)$/i.exec(text)
  if (withScheme !== null) {
    rest = withScheme[1]
  } else if (/^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9._-]+(?:\/.*)?$/.test(text) && !text.includes('://')) {
    rest = text
  } else {
    return undefined
  }

  const parts = rest.split(/[?#]/)[0].split('/').filter((part) => part.length > 0)
  if (parts.length < 2) return undefined
  const owner = parts[0]
  const repo = parts[1].replace(/\.git$/i, '')
  if (!/^[A-Za-z0-9][A-Za-z0-9-]*$/.test(owner)) return undefined
  if (!/^[A-Za-z0-9._-]+$/.test(repo) || repo === '.' || repo === '..') return undefined

  let ref
  let path
  if (parts.length > 2) {
    const mode = parts[2]
    if (mode !== 'tree' && mode !== 'blob') return undefined
    if (parts.length < 4) return undefined
    // A branch may contain slashes, so the ref is only known once the path is
    // known to exist. Without the archive in hand, take the first segment and
    // let a failed fetch retry with longer refs (see `refAttempts`).
    ref = parts[3]
    path = parts.slice(4).join('/')
    if (mode === 'blob') {
      const segments = safeSegments(path)
      if (segments === undefined) return undefined
      path = segments.slice(0, -1).join('/')
    }
  }
  if (path !== undefined && path.length === 0) path = undefined
  if (path !== undefined) {
    const segments = safeSegments(path)
    if (segments === undefined) return undefined
    path = segments.join('/')
  }
  return { owner, repo, ref, path }
}

/**
 * The branch names worth trying for a link whose branch contains slashes.
 *
 * `https://github.com/o/r/tree/release/2.0/skills/foo` cannot be split without
 * knowing the branch; `release` alone will 404, so the segments after `tree`
 * are tried as refs from shortest to longest, with the remainder as the path.
 *
 * The common single-segment branch costs one request, and a `release/2.0`
 * branch costs two rather than failing outright.
 *
 * @param parsed - owner, repo, ref and path from the link.
 * @returns candidate `{ ref, path }` pairs, shortest ref first.
 */
export { refAttempts }

/**
 * Download a repository archive.
 *
 * @param spec - owner, repo and ref.
 * @param options - `fetchImpl`, `token`, `maxBytes` and `signal`.
 * @returns the gzip bytes.
 */
export async function downloadArchive(spec, options) {
  const fetchImpl = options?.fetchImpl ?? globalThis.fetch
  if (typeof fetchImpl !== 'function') throw new Error('This runtime has no fetch, so a link cannot be read.')
  const token = typeof options?.token === 'string' && options.token.trim().length > 0 ? options.token.trim() : undefined
  const ref = spec.ref === undefined ? 'HEAD' : spec.ref
  // A public repository is read from codeload, which has no rate limit. A
  // token means a private repository, and only the API can serve one.
  const url =
    token === undefined
      ? `https://codeload.github.com/${spec.owner}/${spec.repo}/tar.gz/${ref}`
      : `https://api.github.com/repos/${spec.owner}/${spec.repo}/tarball/${ref}`
  const headers = { accept: 'application/x-gzip', 'user-agent': 'dsh-skills' }
  if (token !== undefined) headers.authorization = `Bearer ${token}`

  const response = await fetchImpl(url, {
    headers,
    ...(options?.signal === undefined ? {} : { signal: options.signal }),
  })
  if (response.status === 404) {
    const error = new Error(`GitHub has no ${spec.owner}/${spec.repo}${spec.ref === undefined ? '' : ` at ${spec.ref}`}.`)
    error.code = 'not-found'
    throw error
  }
  if (response.status === 401 || response.status === 403) {
    const error = new Error(`GitHub refused the access token for ${spec.owner}/${spec.repo}.`)
    error.code = 'unauthorized'
    throw error
  }
  if (response.ok !== true) {
    const error = new Error(`GitHub answered ${response.status} for ${spec.owner}/${spec.repo}.`)
    error.code = 'http'
    throw error
  }
  const declared = Number(response.headers?.get?.('content-length') ?? Number.NaN)
  const limit = options?.maxBytes ?? MAX_ARCHIVE_BYTES
  if (Number.isFinite(declared) && declared > limit) {
    const error = new Error(`That repository is ${Math.round(declared / 1024)} KB, more than this install will download.`)
    error.code = 'too-large'
    throw error
  }
  const bytes = new Uint8Array(await response.arrayBuffer())
  if (bytes.byteLength > limit) {
    const error = new Error('That repository is larger than this install will download.')
    error.code = 'too-large'
    throw error
  }
  return bytes
}

/**
 * Strip the `<repo>-<ref>/` wrapper GitHub puts around every entry.
 *
 * @param files - paths keyed as they appear in the archive.
 * @returns the same files relative to the repository root.
 */
export function stripArchiveRoot(files) {
  const stripped = new Map()
  let prefix
  for (const path of files.keys()) {
    const slash = path.indexOf('/')
    if (slash === -1) continue
    const head = path.slice(0, slash)
    if (prefix === undefined) prefix = head
    if (head !== prefix) continue
    stripped.set(path.slice(slash + 1), files.get(path))
  }
  return stripped
}

/**
 * @param files - tree-relative paths to bytes.
 * @param path - the directory to look for.
 * @returns whether the tree holds anything under that directory.
 */

/**
 * Download one GitHub repository and return its tree.
 *
 * A branch may contain slashes, and a link cannot say where the branch ends
 * and the path begins. Attempts therefore grow the ref one segment at a time:
 * the common single-segment branch costs one request, and a `release/2.0`
 * branch costs two rather than failing outright. An attempt whose tree does
 * not hold the requested directory is not the split that was meant, so the
 * next, longer ref is tried.
 *
 * @param parsed - owner, repo, ref and path from the link.
 * @param options - `fetchImpl` and `token` for tests and private repositories.
 * @returns the repository-relative files and the split that worked.
 */
export async function readGitHubArchive(parsed, options) {
  const attempts = refAttempts(parsed)
  let fallback
  let lastError
  for (const attempt of attempts) {
    let bytes
    try {
      bytes = await downloadArchive({ owner: parsed.owner, repo: parsed.repo, ref: attempt.ref }, options)
    } catch (error) {
      lastError = error
      if (error?.code !== 'not-found') throw error
      continue
    }
    const files = stripArchiveRoot(readArchive(bytes))
    const found = { files, ref: attempt.ref, path: attempt.path }
    if (fallback === undefined) fallback = found
    if (attempt.path === '') return found
    if (treeHasPath(files, attempt.path)) return found
  }
  if (fallback !== undefined && parsed.path === undefined) return fallback
  if (fallback !== undefined) {
    const missing = new Error(`GitHub repository does not contain "${parsed.path}".`)
    missing.code = 'path-not-found'
    throw missing
  }
  throw lastError
}

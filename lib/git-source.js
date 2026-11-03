/**
 * DSH Skills — reading a skill out of any git repository.
 *
 * GitHub is read from an archive, because that is one request with no rate
 * limit. Every other host — GitLab, Gitee, a self-hosted instance, a plain
 * git server — is read by cloning it, which is the one thing every git host
 * supports. The clone is shallow, temporary, and thrown away as soon as the
 * tree has been read.
 *
 * The transport is restricted on purpose. `git` understands transports beyond
 * HTTP and SSH, and some of them run commands: `ext::` executes a shell
 * command and `file://` reads the machine's own disk. A link pasted into a
 * panel must never reach either, so the URL is checked against an allowlist
 * before `git` ever sees it, and `GIT_ALLOW_PROTOCOL` narrows it again inside
 * the child process. The clone is also told not to prompt: a credential
 * prompt in a background panel is a hang nobody can see.
 *
 * @module dsh-skills/git-source
 */

import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** The transports a link may name. Everything else is refused. */
const ALLOWED_PROTOCOLS = new Set(['https:', 'http:', 'ssh:', 'git:'])

/** The protocols `git` itself is allowed to speak. */
const ALLOWED_GIT_PROTOCOLS = 'https:http:ssh:git'

/** How long a clone may take before it is abandoned. */
const CLONE_TIMEOUT_MS = 120_000

/** The largest amount of output a git command may print. */
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024

/**
 * Read a git URL, refusing anything that is not a remote repository.
 *
 * Accepted forms:
 *   https://gitlab.com/owner/repo
 *   https://gitlab.com/owner/repo.git
 *   git@github.com:owner/repo.git
 *   ssh://git@example.com/owner/repo
 *   git://example.com/owner/repo
 *
 * A ref may be named in the fragment (`#release`) or the query (`?ref=release`).
 *
 * @param input - what the person typed or pasted.
 * @returns the clone URL and the ref, or undefined when the input is not a
 * remote git repository.
 */
export function parseGitUrl(input) {
  const text = typeof input === 'string' ? input.trim() : ''
  if (text.length === 0) return undefined
  if (text.includes('\0')) return undefined
  // A local path is a directory, not a remote repository.
  if (text.startsWith('/') || text.startsWith('.') || text.startsWith('~')) return undefined

  let url
  const scp = /^([A-Za-z0-9._-]+)@([A-Za-z0-9._-]+):(.+)$/.exec(text)
  if (scp !== null) {
    // `git@host:owner/repo.git` is ssh with a path, not a URL with a scheme.
    url = new URL(`ssh://${scp[1]}@${scp[2]}/${scp[3].replace(/^\/+/, '')}`)
  } else {
    try {
      url = new URL(text)
    } catch {
      return undefined
    }
  }

  if (!ALLOWED_PROTOCOLS.has(url.protocol)) return undefined
  if (url.hostname.length === 0) return undefined
  // A password in the link would end up in a process list and in a log line.
  if (url.password.length > 0) return undefined
  const path = url.pathname.replace(/\/+$/, '')
  if (path.length === 0 || path === '/') return undefined
  if (path.split('/').some((segment) => segment === '..' || segment === '.')) return undefined

  // The clone URL carries neither the fragment nor the query: they name the
  // branch, and `git` would read them as part of the repository's name.
  const authority = `${url.username.length > 0 ? `${url.username}@` : ''}${url.host}`
  return { url: `${url.protocol}//${authority}${path}`, ref: refFromUrl(url) }
}

/**
 * The ref a link names, if it names one.
 *
 * @param url - the parsed link.
 * @returns the ref, or undefined.
 */
function refFromUrl(url) {
  const fragment = decodeURIComponent(url.hash.replace(/^#/, '')).trim()
  if (fragment.length > 0) return fragment
  for (const key of ['ref', 'branch', 'tag']) {
    const value = url.searchParams.get(key)
    if (value !== null && value.trim().length > 0) return value.trim()
  }
  return undefined
}

/**
 * The environment a git command runs in.
 *
 * @param options - the options the caller passed on.
 * @returns the environment for the child process.
 */
function gitEnv(options) {
  const env = {
    ...process.env,
    // Never wait for a human: a credential prompt in a background panel is a
    // hang with no way to answer it.
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_LFS_SKIP_SMUDGE: '1',
    GIT_ALLOW_PROTOCOL: ALLOWED_GIT_PROTOCOLS,
    GIT_SSH_COMMAND: 'ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new',
  }
  // An askpass helper would be a second way to wait for a human.
  delete env.GIT_ASKPASS
  delete env.SSH_ASKPASS

  const token = typeof options?.token === 'string' ? options.token.trim() : ''
  if (token.length > 0) {
    // The token travels in the environment rather than in the command line,
    // where it would be visible to every process on the machine.
    env.GIT_CONFIG_COUNT = '1'
    env.GIT_CONFIG_KEY_0 = 'http.extraHeader'
    env.GIT_CONFIG_VALUE_0 = `Authorization: Bearer ${token}`
  }
  return env
}

/**
 * Run one git command.
 *
 * @param run - the `execFile` implementation, or a stand-in for tests.
 * @param args - the arguments, never a shell string.
 * @param options - the caller's options.
 * @returns the command's output.
 */
function runGit(run, args, options) {
  const timeout = typeof options?.timeout === 'number' ? options.timeout : CLONE_TIMEOUT_MS
  const env = gitEnv(options)
  return new Promise((resolve, reject) => {
    run('git', args, { timeout, env, windowsHide: true, maxBuffer: MAX_OUTPUT_BYTES }, (error, stdout, stderr) => {
      if (error) {
        if (error?.code === 'ENOENT') {
          const missing = new Error('This machine has no git, so only GitHub links can be read.')
          missing.code = 'no-git'
          reject(missing)
          return
        }
        const detail = String(stderr ?? '').trim() || (error instanceof Error ? error.message : String(error))
        const failure = new Error(`git could not read that repository: ${detail}`)
        failure.code = 'git-failed'
        reject(failure)
        return
      }
      resolve({ stdout: String(stdout ?? ''), stderr: String(stderr ?? '') })
    })
  })
}

/**
 * Clone a repository into a temporary directory.
 *
 * The clone is shallow, so a repository with a long history costs one commit
 * rather than the whole graph. The caller owns the directory and must remove
 * it.
 *
 * @param spec - the clone URL and the ref, if the link named one.
 * @param options - `execImpl` for tests, plus `token` and `timeout`.
 * @returns the absolute path of the clone.
 */
export async function cloneRepository(spec, options) {
  const run = options?.execImpl ?? execFile
  const dir = await mkdtemp(join(tmpdir(), 'dsh-skills-clone-'))
  const base = ['clone', '--depth', '1', '--single-branch', '--no-tags', '--quiet', '--config', 'core.symlinks=false']
  try {
    if (spec.ref === undefined) {
      await runGit(run, [...base, '--', spec.url, dir], options)
    } else {
      try {
        await runGit(run, [...base, '--branch', spec.ref, '--', spec.url, dir], options)
      } catch {
        // Not a branch and not a tag: fetch the object itself and check it
        // out. A commit id is a legitimate thing to link to.
        await rm(dir, { recursive: true, force: true })
        await runGit(run, [...base, '--', spec.url, dir], options)
        await runGit(run, ['-C', dir, 'fetch', '--depth', '1', 'origin', spec.ref], options)
        await runGit(run, ['-C', dir, 'checkout', 'FETCH_HEAD'], options)
      }
    }
  } catch (error) {
    await rm(dir, { recursive: true, force: true })
    throw error
  }
  return dir
}

/**
 * Remove a clone this module made.
 *
 * @param dir - the directory `cloneRepository` returned.
 */
export async function removeClone(dir) {
  if (typeof dir !== 'string' || dir.length === 0) return
  await rm(dir, { recursive: true, force: true }).catch(() => {})
}

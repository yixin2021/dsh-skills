/**
 * Remote repositories: reading a link, finding the skills inside it and
 * installing one.
 *
 * The fixtures are built here rather than checked in, because the two things
 * worth testing are exactly the two things a fixture would hide: that the tar
 * reader understands what GitHub emits, and that the git reader refuses every
 * transport it must refuse.
 *
 * Run with `node --test test/`.
 */

import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { after, before, describe, test } from 'node:test'

import { dispatch } from '../index.js'
import { parseGitUrl } from '../lib/git-source.js'
import { parseRemoteUrl, readRemoteTree, clearTreeCache } from '../lib/remote-source.js'
import { collectSkillFiles, collectSkillFilesDetailed, findSkillCandidates, readTreeFromDisk, safeSegments } from '../lib/skill-tree.js'

/**
 * One ustar header block.
 *
 * @param name - the entry's path inside the archive.
 * @param size - the entry's size in bytes.
 * @returns the 512-byte header.
 */
function tarHeader(name, size) {
  const header = Buffer.alloc(512)
  header.write(name, 0, 'utf8')
  header.write('0000644\0', 100)
  header.write('0000000\0', 108)
  header.write('0000000\0', 116)
  header.write(`${size.toString(8).padStart(11, '0')}\0`, 124)
  header.write(`${(0).toString(8).padStart(11, '0')}\0`, 136)
  header.write('        ', 148)
  header.write('0', 156)
  header.write('ustar\0', 257)
  header.write('00', 263)
  let sum = 0
  for (const byte of header) sum += byte
  header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148)
  return header
}

/**
 * Build the gzipped tar GitHub serves for a repository.
 *
 * @param entries - paths to text, relative to the repository root.
 * @returns the gzip bytes.
 */
function buildArchive(entries) {
  const blocks = []
  for (const [name, content] of Object.entries(entries)) {
    const data = Buffer.from(content, 'utf8')
    blocks.push(tarHeader(`owner-repo-abc123/${name}`, data.length))
    blocks.push(data)
    const padding = (512 - (data.length % 512)) % 512
    if (padding > 0) blocks.push(Buffer.alloc(padding))
  }
  blocks.push(Buffer.alloc(1024))
  return gzipSync(Buffer.concat(blocks))
}

const ALPHA = `---
name: alpha
description: Does the alpha thing.
---

# Alpha

Body text.
`

const BETA = `---
name: beta
description: Does the beta thing.
---

# Beta
`

/** The repository the fixtures describe. */
const REPO = {
  'README.md': '# A repository\n',
  'skills/alpha/SKILL.md': ALPHA,
  'skills/alpha/references/usage.md': '# Usage\n',
  'skills/beta/SKILL.md': BETA,
}

/**
 * A fetch that serves one repository archive.
 *
 * @param entries - the repository's files.
 * @param options - `status` to answer with a failure instead.
 * @returns the fetch implementation and the URLs it was asked for.
 */
function archiveFetch(entries, options = {}) {
  const asked = []
  const bytes = buildArchive(entries)
  const impl = async (url) => {
    asked.push(String(url))
    const status = typeof options.status === 'function' ? options.status(String(url), asked.length) : options.status ?? 200
    return {
      status,
      ok: status >= 200 && status < 300,
      headers: { get: () => String(bytes.length) },
      arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    }
  }
  return { impl, asked }
}

/** A Host context whose only service is the workspace registry. */
function fakeContext(workspaces) {
  return {
    get(name) {
      if (name !== 'workspaceRegistry') return undefined
      return { list: () => workspaces.map((path) => ({ path, title: path.split('/').pop() })) }
    },
  }
}

describe('reading a link', () => {
  test('a GitHub link names the repository, the branch and the directory', () => {
    const spec = parseRemoteUrl('https://github.com/owner/repo/tree/main/skills/foo')
    assert.equal(spec.kind, 'github')
    assert.equal(spec.owner, 'owner')
    assert.equal(spec.repo, 'repo')
    assert.equal(spec.ref, 'main')
    assert.equal(spec.path, 'skills/foo')
  })

  test('a link to a SKILL.md names the directory that holds it', () => {
    const spec = parseRemoteUrl('https://github.com/owner/repo/blob/main/skills/foo/SKILL.md')
    assert.equal(spec.path, 'skills/foo')
  })

  test('owner/repo is read as a GitHub repository', () => {
    const spec = parseRemoteUrl('owner/repo')
    assert.equal(spec.kind, 'github')
    assert.equal(spec.url, 'https://github.com/owner/repo')
  })

  test('another host is read by cloning the repository, not the web path', () => {
    const gitlab = parseRemoteUrl('https://gitlab.com/owner/repo/-/tree/main/skills/foo')
    assert.equal(gitlab.kind, 'git')
    assert.equal(gitlab.url, 'https://gitlab.com/owner/repo')
    assert.equal(gitlab.ref, 'main')
    assert.equal(gitlab.path, 'skills/foo')

    const subgroup = parseRemoteUrl('https://gitlab.com/group/sub/repo/-/tree/main/skills/foo')
    assert.equal(subgroup.url, 'https://gitlab.com/group/sub/repo')

    const gitee = parseRemoteUrl('https://gitee.com/owner/repo/tree/main/skills/foo')
    assert.equal(gitee.url, 'https://gitee.com/owner/repo')
    assert.equal(gitee.path, 'skills/foo')
  })

  test('a link may name the branch in its fragment or its query', () => {
    assert.equal(parseRemoteUrl('https://example.com/owner/repo.git#release').ref, 'release')
    assert.equal(parseRemoteUrl('https://example.com/owner/repo?ref=v2').ref, 'v2')
  })

  test('an scp-style link is read as ssh', () => {
    const spec = parseRemoteUrl('git@github.com:owner/repo.git')
    assert.equal(spec.kind, 'git')
    assert.equal(spec.url, 'ssh://git@github.com/owner/repo.git')
  })

  test('a local path, a file URL and a shell command are not repositories', () => {
    for (const bad of [
      '/Users/someone/repo',
      './repo',
      '~/repo',
      'file:///etc/passwd',
      'ext::sh -c whoami',
      'https://user:pass@example.com/owner/repo',
      'not a link',
      '',
    ]) {
      assert.equal(parseRemoteUrl(bad), undefined, bad)
    }
  })

  test('the git reader refuses a transport outside the allowlist', () => {
    assert.equal(parseGitUrl('ftp://example.com/owner/repo'), undefined)
    assert.equal(parseGitUrl('rsync://example.com/owner/repo'), undefined)
    assert.equal(parseGitUrl('file:///tmp/repo'), undefined)
    assert.equal(parseGitUrl('/tmp/repo'), undefined)
    assert.ok(parseGitUrl('https://example.com/owner/repo'))
  })
})

describe('the tree policy', () => {
  test('a path that could leave a directory is refused', () => {
    assert.deepEqual(safeSegments('a/b'), ['a', 'b'])
    assert.equal(safeSegments('../escape'), undefined)
    assert.equal(safeSegments('/absolute'), undefined)
    assert.equal(safeSegments('a\\b'), undefined)
    assert.equal(safeSegments(''), undefined)
  })

  test('every directory holding a SKILL.md is a candidate', () => {
    const files = new Map([
      ['skills/alpha/SKILL.md', Buffer.from(ALPHA)],
      ['skills/beta/SKILL.md', Buffer.from(BETA)],
      ['README.md', Buffer.from('# readme')],
    ])
    const candidates = findSkillCandidates(files)
    assert.deepEqual(candidates.map((candidate) => candidate.path), ['skills/alpha', 'skills/beta'])
    assert.equal(candidates[0].name, 'alpha')
    assert.equal(candidates[0].description, 'Does the alpha thing.')
  })

  test('a skill directory is collected whole, and nothing above it', () => {
    const files = new Map(Object.entries(REPO).map(([path, content]) => [path, Buffer.from(content)]))
    assert.deepEqual(collectSkillFiles(files, 'skills/alpha').map((file) => file.path).sort(), ['SKILL.md', 'references/usage.md'])
  })

  test('collecting a skill reports file and byte-limit truncation', () => {
    const files = new Map([
      ['bundle/SKILL.md', Buffer.from(ALPHA)],
      ...Array.from({ length: 201 }, (_, index) => [`bundle/file-${index}.md`, Buffer.from('x')]),
    ])
    const collected = collectSkillFilesDetailed(files, 'bundle')
    assert.equal(collected.truncated, true)
    assert.equal(collected.files.length, 200)
    assert.equal(collectSkillFiles(files, 'bundle').length, 200)
  })
})

describe('the disk tree reader', () => {
  test('a byte-limit breach stops every directory, not just the current one', async () => {
    const base = await mkdtemp(join(tmpdir(), 'dsh-skills-tree-'))
    try {
      // Three sibling directories, each with one 1 KiB payload: a reader that
      // only aborts the current recursion would keep going after the first.
      for (const name of ['aa', 'bb', 'cc']) {
        await mkdir(join(base, name), { recursive: true })
        await writeFile(join(base, name, 'payload.bin'), Buffer.alloc(1024, 0x61))
      }
      const reads = []
      const files = await readTreeFromDisk(base, {
        maxBytes: 1500,
        readFileImpl: async (path) => {
          reads.push(path)
          return readFile(path)
        },
      })
      assert.equal(reads.length, 2, 'the third sibling is never read once the budget is spent')
      assert.equal(files.size, 1, 'only files that fit under the limit are kept')
      assert.ok(files.has('aa/payload.bin'))
    } finally {
      await rm(base, { recursive: true, force: true })
    }
  })
})

describe('installing from a repository', () => {
  let base
  let project
  let ctx

  before(async () => {
    base = await mkdtemp(join(tmpdir(), 'dsh-skills-remote-'))
    project = join(base, 'project')
    await mkdir(join(project, '.dsh', 'skills'), { recursive: true })
    process.env.DSH_HOME = base
    process.env.DSH_AGENTS_HOME = join(base, '.agents')
    ctx = fakeContext([project])
    // Each test serves a different repository under the same link, so the
    // tree cache must not carry one into the next.
    clearTreeCache()
  })

  after(async () => {
    delete process.env.DSH_HOME
    delete process.env.DSH_AGENTS_HOME
    await rm(base, { recursive: true, force: true })
  })

  const rootKey = () => `project-dsh:${project}`

  test('a repository with one skill installs it', async () => {
    const { impl, asked } = archiveFetch({ 'SKILL.md': ALPHA.replace('alpha', 'gamma') })
    const answer = await dispatch(ctx, {
      action: 'install-from-remote',
      rootKey: rootKey(),
      url: 'https://github.com/owner/single',
      fetchImpl: impl,
    })
    assert.equal(answer.ok, true)
    assert.equal(answer.entryName, 'gamma')
    assert.equal(answer.source.repo, 'owner/single')
    // A repository read at its default branch still gets a link that opens.
    assert.equal(answer.source.url, 'https://github.com/owner/single/tree/HEAD')
    assert.match(asked[0], /^https:\/\/codeload\.github\.com\/owner\/single\/tar\.gz\/HEAD$/)
    assert.ok(await readFile(join(project, '.dsh', 'skills', 'gamma', 'SKILL.md'), 'utf8'))
  })

  test('a repository with several skills asks which one', async () => {
    const { impl } = archiveFetch(REPO)
    const answer = await dispatch(ctx, {
      action: 'install-from-remote',
      rootKey: rootKey(),
      url: 'https://github.com/owner/many',
      fetchImpl: impl,
    })
    assert.equal(answer.ok, false)
    assert.equal(answer.code, 'choose-skill')
    assert.deepEqual(answer.candidates.map((candidate) => candidate.path), ['skills/alpha', 'skills/beta'])
    assert.equal(answer.source.url, 'https://github.com/owner/many')
  })

  test('several skills import together from one GitHub archive', async () => {
    const batchRepo = {
      'skills/delta/SKILL.md': ALPHA.replace(/alpha/g, 'delta'),
      'skills/delta/references/usage.md': '# Delta reference\n',
      'skills/epsilon/SKILL.md': BETA.replace(/beta/g, 'epsilon'),
    }
    const { impl, asked } = archiveFetch(batchRepo)
    const answer = await dispatch(ctx, {
      action: 'install-from-remote',
      rootKey: rootKey(),
      url: 'https://github.com/owner/batch-ok',
      paths: ['skills/delta', 'skills/epsilon'],
      fetchImpl: impl,
    })
    assert.equal(answer.ok, true)
    assert.deepEqual(answer.entries.map((entry) => entry.entryName), ['delta', 'epsilon'])
    assert.equal(asked.length, 1, 'the archive is fetched once for the batch')
    assert.ok(await readFile(join(project, '.dsh', 'skills', 'delta', 'references', 'usage.md'), 'utf8'))
    assert.ok(await readFile(join(project, '.dsh', 'skills', 'epsilon', 'SKILL.md'), 'utf8'))
    await rm(join(project, '.dsh', 'skills', 'delta'), { recursive: true, force: true })
    await rm(join(project, '.dsh', 'skills', 'epsilon'), { recursive: true, force: true })
  })

  test('a conflict refuses the whole batch without creating earlier skills', async () => {
    const existing = join(project, '.dsh', 'skills', 'beta')
    await mkdir(existing, { recursive: true })
    await writeFile(join(existing, 'SKILL.md'), BETA, 'utf8')
    try {
      const { impl } = archiveFetch(REPO)
      const answer = await dispatch(ctx, {
        action: 'install-from-remote',
        rootKey: rootKey(),
        url: 'https://github.com/owner/batch-conflict',
        paths: ['skills/alpha', 'skills/beta'],
        fetchImpl: impl,
      })
      assert.equal(answer.code, 'conflict')
      await assert.rejects(readFile(join(project, '.dsh', 'skills', 'alpha', 'SKILL.md'), 'utf8'), { code: 'ENOENT' })
    } finally {
      await rm(existing, { recursive: true, force: true })
    }
  })

  test('an explicit GitHub directory that does not exist is not downgraded to another skill', async () => {
    const { impl } = archiveFetch({ 'skills/only/SKILL.md': ALPHA }, { status: (url) => url.includes('/tar.gz/main/no-such-dir') ? 404 : 200 })
    const answer = await dispatch(ctx, {
      action: 'install-from-remote',
      rootKey: rootKey(),
      url: 'https://github.com/owner/missing/tree/main/no-such-dir',
      fetchImpl: impl,
    })
    assert.equal(answer.ok, false)
    assert.equal(answer.code, 'path-not-found')
  })

  test('invalid or duplicate selections never install a fallback skill', async () => {
    const { impl } = archiveFetch(REPO)
    for (const paths of [[], ['skills/alpha', 'skills/alpha'], ['../escape'], [null], ['skills/missing']]) {
      const answer = await dispatch(ctx, {
        action: 'install-from-remote', rootKey: rootKey(),
        url: 'https://github.com/owner/invalid-selection', paths, fetchImpl: impl,
      })
      assert.equal(answer.code, 'bad-request', JSON.stringify(paths))
    }
    await assert.rejects(readFile(join(project, '.dsh', 'skills', 'alpha', 'SKILL.md')), { code: 'ENOENT' })
  })

  test('duplicate installed names reject the batch before writing', async () => {
    const { impl } = archiveFetch({ 'one/SKILL.md': ALPHA, 'two/SKILL.md': ALPHA })
    const answer = await dispatch(ctx, {
      action: 'install-from-remote', rootKey: rootKey(),
      url: 'https://github.com/owner/duplicate-names', paths: ['one', 'two'], fetchImpl: impl,
    })
    assert.equal(answer.code, 'conflict')
    await assert.rejects(readFile(join(project, '.dsh', 'skills', 'alpha', 'SKILL.md')), { code: 'ENOENT' })
  })

  test('oversized bundles reject the batch rather than installing truncated files', async () => {
    const repo = {
      'one/SKILL.md': ALPHA.replace(/alpha/g, 'limit-first'),
      'two/SKILL.md': BETA.replace(/beta/g, 'limit-second'),
      ...Object.fromEntries(Array.from({ length: 201 }, (_, index) => [`two/file-${index}.txt`, 'x'])),
    }
    const { impl } = archiveFetch(repo)
    const answer = await dispatch(ctx, {
      action: 'install-from-remote', rootKey: rootKey(),
      url: 'https://github.com/owner/oversized', paths: ['one', 'two'], fetchImpl: impl,
    })
    assert.equal(answer.code, 'too-large')
    const entries = await readdir(join(project, '.dsh', 'skills'))
    assert.ok(!entries.includes('limit-first'))
    assert.ok(!entries.includes('limit-second'))
  })

  test('a write failure rolls back every directory created by the batch', async () => {
    const { impl } = archiveFetch({
      'one/SKILL.md': ALPHA.replace(/alpha/g, 'rollback-first'),
      'two/SKILL.md': BETA.replace(/beta/g, 'rollback-second'),
      'two/collision': 'regular file',
      'two/collision/nested.txt': 'cannot be created beneath a file',
    })
    await assert.rejects(dispatch(ctx, {
      action: 'install-from-remote', rootKey: rootKey(),
      url: 'https://github.com/owner/write-failure', paths: ['one', 'two'], fetchImpl: impl,
    }))
    const entries = await readdir(join(project, '.dsh', 'skills'))
    assert.ok(!entries.includes('rollback-first'))
    assert.ok(!entries.includes('rollback-second'))
  })

  test('a GitHub collection link only offers and imports skills beneath that path', async () => {
    const { impl } = archiveFetch({
      'collection/one/SKILL.md': ALPHA.replace(/alpha/g, 'scoped-one'),
      'collection/two/SKILL.md': BETA.replace(/beta/g, 'scoped-two'),
      'outside/SKILL.md': ALPHA.replace(/alpha/g, 'scoped-outside'),
    })
    const request = {
      action: 'install-from-remote', rootKey: rootKey(),
      url: 'https://github.com/owner/scoped/tree/main/collection', fetchImpl: impl,
    }
    const preview = await dispatch(ctx, request)
    assert.equal(preview.code, 'choose-skill')
    assert.deepEqual(preview.candidates.map((candidate) => candidate.path), ['collection/one', 'collection/two'])
    const bad = await dispatch(ctx, { ...request, paths: ['outside'] })
    assert.equal(bad.code, 'bad-request')
    const imported = await dispatch(ctx, { ...request, paths: ['collection/one', 'collection/two'] })
    assert.equal(imported.ok, true)
    assert.equal(imported.entries.length, 2)
  })

  test('names that collide only on a case-insensitive disk are refused in preflight', async () => {
    const { impl } = archiveFetch({
      'x/SKILL.md': '---\nname: Foo\ndescription: Upper.\n---\n',
      'y/SKILL.md': '---\nname: foo\ndescription: Lower.\n---\n',
    })
    const answer = await dispatch(ctx, {
      action: 'install-from-remote', rootKey: rootKey(),
      url: 'https://github.com/owner/case-collision', paths: ['x', 'y'], fetchImpl: impl,
    })
    if (process.platform === 'darwin' || process.platform === 'win32') {
      assert.equal(answer.code, 'conflict', JSON.stringify(answer))
    } else {
      assert.equal(answer.ok, true, JSON.stringify(answer))
      await rm(join(project, '.dsh', 'skills', 'Foo'), { recursive: true, force: true })
      await rm(join(project, '.dsh', 'skills', 'foo'), { recursive: true, force: true })
    }
  })

  test('the chosen skill arrives with the files it references', async () => {
    const { impl } = archiveFetch(REPO)
    const answer = await dispatch(ctx, {
      action: 'install-from-remote',
      rootKey: rootKey(),
      url: 'https://github.com/owner/many',
      path: 'skills/beta',
      fetchImpl: impl,
    })
    assert.equal(answer.ok, true)
    assert.equal(answer.entryName, 'beta')
    assert.ok(await readFile(join(project, '.dsh', 'skills', 'beta', 'SKILL.md'), 'utf8'))
  })

  test('a link that names the directory installs that directory', async () => {
    const { impl } = archiveFetch(REPO)
    const answer = await dispatch(ctx, {
      action: 'install-from-remote',
      rootKey: rootKey(),
      url: 'https://github.com/owner/named/tree/main/skills/alpha',
      fetchImpl: impl,
    })
    assert.equal(answer.ok, true, `named directory import failed: ${JSON.stringify(answer)}`)
    assert.equal(answer.entryName, 'alpha')
    assert.equal(answer.source.url, 'https://github.com/owner/named/tree/main/skills/alpha')
    assert.ok(await readFile(join(project, '.dsh', 'skills', 'alpha', 'references', 'usage.md'), 'utf8'))
  })

  test('a link that is not a repository is refused', async () => {
    const answer = await dispatch(ctx, { action: 'install-from-remote', rootKey: rootKey(), url: 'not a link' })
    assert.equal(answer.ok, false)
    assert.equal(answer.code, 'bad-url')
  })

  test('a repository without a skill is refused', async () => {
    const { impl } = archiveFetch({ 'README.md': '# nothing here\n' })
    const answer = await dispatch(ctx, {
      action: 'install-from-remote',
      rootKey: rootKey(),
      url: 'https://github.com/owner/empty',
      fetchImpl: impl,
    })
    assert.equal(answer.code, 'not-a-skill')
  })

  test('a repository that cannot be read reports the failure', async () => {
    const { impl } = archiveFetch(REPO, { status: 500 })
    const answer = await dispatch(ctx, {
      action: 'install-from-remote',
      rootKey: rootKey(),
      url: 'https://github.com/owner/broken',
      fetchImpl: impl,
    })
    assert.equal(answer.ok, false)
    assert.equal(answer.code, 'http')
  })

  test('a name that already exists is refused rather than overwritten', async () => {
    const { impl } = archiveFetch({ 'SKILL.md': ALPHA.replace('alpha', 'gamma') })
    const answer = await dispatch(ctx, {
      action: 'install-from-remote',
      rootKey: rootKey(),
      url: 'https://github.com/owner/single',
      fetchImpl: impl,
    })
    assert.equal(answer.code, 'conflict')
  })

  test('a read-only root is refused', async () => {
    const answer = await dispatch(ctx, {
      action: 'install-from-remote',
      rootKey: 'custom:0badc0de',
      url: 'https://github.com/owner/read-only',
    })
    assert.equal(answer.code, 'unknown-root')
  })

  test('a token switches the download to the API, and never reaches the URL', async () => {
    const { impl, asked } = archiveFetch({ 'SKILL.md': ALPHA.replace('alpha', 'tokenised') })
    const answer = await dispatch(ctx, {
      action: 'install-from-remote',
      rootKey: rootKey(),
      url: 'https://github.com/owner/private',
      token: 'ghp_secret',
      fetchImpl: impl,
    })
    assert.equal(answer.ok, true)
    assert.match(asked[0], /^https:\/\/api\.github\.com\/repos\/owner\/private\/tarball\//)
    assert.ok(!asked.some((url) => url.includes('ghp_secret')), 'the token is not in the URL')
  })

  test('choosing one skill out of a repository reads it once', async () => {
    const once = {
      'skills/one/SKILL.md': ALPHA.replace('alpha', 'one'),
      'skills/two/SKILL.md': BETA.replace('beta', 'two'),
    }
    const { impl, asked } = archiveFetch(once)
    const listed = await dispatch(ctx, {
      action: 'install-from-remote',
      rootKey: rootKey(),
      url: 'https://github.com/owner/once',
      fetchImpl: impl,
    })
    assert.equal(listed.code, 'choose-skill')
    assert.equal(asked.length, 1, 'the repository is read once to see what it holds')

    const installed = await dispatch(ctx, {
      action: 'install-from-remote',
      rootKey: rootKey(),
      url: 'https://github.com/owner/once',
      path: 'skills/two',
      fetchImpl: impl,
    })
    assert.equal(installed.ok, true)
    assert.equal(installed.entryName, 'two')
    assert.equal(asked.length, 1, 'the choice is installed from the tree already in hand')
  })
})

describe('installing from a git host', () => {
  let base
  let project
  let ctx

  before(async () => {
    base = await mkdtemp(join(tmpdir(), 'dsh-skills-git-'))
    project = join(base, 'project')
    await mkdir(join(project, '.dsh', 'skills'), { recursive: true })
    process.env.DSH_HOME = base
    process.env.DSH_AGENTS_HOME = join(base, '.agents')
    ctx = fakeContext([project])
    clearTreeCache()
  })

  after(async () => {
    delete process.env.DSH_HOME
    delete process.env.DSH_AGENTS_HOME
    await rm(base, { recursive: true, force: true })
  })

  const rootKey = () => `project-dsh:${project}`

  /**
   * A git that clones the fixture instead of talking to a server.
   *
   * @param entries - the files the "clone" produces.
   * @returns the exec stand-in and the commands it was asked to run.
   */
  function fakeGit(entries) {
    const commands = []
    const impl = (file, args, options, callback) => {
      commands.push(args)
      const clone = args[0] === 'clone'
      if (clone) {
        const target = args[args.length - 1]
        const write = async (dir, prefix) => {
          await mkdir(dir, { recursive: true })
          for (const [name, content] of Object.entries(entries)) {
            const path = join(dir, name)
            await mkdir(join(path, '..'), { recursive: true })
            await writeFile(path, content, 'utf8')
            void prefix
          }
        }
        write(target, '').then(
          () => callback(null, '', ''),
          (error) => callback(error, '', ''),
        )
        return
      }
      callback(null, '', '')
    }
    return { impl, commands }
  }

  test('another host is cloned and its skill is installed', async () => {
    const { impl, commands } = fakeGit({ 'skills/alpha/SKILL.md': ALPHA })
    const answer = await dispatch(ctx, {
      action: 'install-from-remote',
      rootKey: rootKey(),
      url: 'https://gitlab.com/owner/one',
      execImpl: impl,
    })
    assert.equal(answer.ok, true)
    assert.equal(answer.entryName, 'alpha')
    assert.ok(commands.some((args) => args[0] === 'clone'))
    assert.ok(await readFile(join(project, '.dsh', 'skills', 'alpha', 'SKILL.md'), 'utf8'))
  })

  test('the clone is shallow, and the branch is not guessed from the path', async () => {
    const { impl, commands } = fakeGit({ 'skills/alpha/SKILL.md': ALPHA })
    await dispatch(ctx, {
      action: 'install-from-remote',
      rootKey: rootKey(),
      url: 'https://gitlab.com/owner/two/-/tree/main/skills/alpha',
      execImpl: impl,
    })
    const clone = commands.find((args) => args[0] === 'clone')
    assert.ok(clone.includes('--depth'))
    assert.ok(clone.includes('1'))
    assert.ok(clone.includes('--branch'))
    assert.ok(clone.includes('main'))
    assert.ok(clone.includes('--'), 'the URL is passed after a separator, never as an option')
  })

  test('a token travels in the environment, never in the command line', async () => {
    const commands = []
    const impl = (file, args, options, callback) => {
      commands.push({ args, env: options.env })
      const target = args[args.length - 1]
      mkdir(join(target, 'skills', 'delta'), { recursive: true })
        .then(() => writeFile(join(target, 'skills', 'delta', 'SKILL.md'), ALPHA.replace('alpha', 'delta'), 'utf8'))
        .then(
          () => callback(null, '', ''),
          (error) => callback(error, '', ''),
        )
    }
    const answer = await dispatch(ctx, {
      action: 'install-from-remote',
      rootKey: rootKey(),
      url: 'https://gitlab.com/owner/three',
      token: 'glpat_secret',
      execImpl: impl,
    })
    assert.equal(answer.ok, true)
    assert.equal(answer.entryName, 'delta')
    const clone = commands.find((entry) => entry.args[0] === 'clone')
    assert.ok(!clone.args.includes('glpat_secret'), 'the token is not in the arguments')
    assert.match(clone.env.GIT_CONFIG_VALUE_0, /glpat_secret/)
  })

  test('a machine without git says so instead of failing obscurely', async () => {
    const impl = (file, args, options, callback) => {
      const error = new Error('spawn git ENOENT')
      error.code = 'ENOENT'
      callback(error, '', '')
    }
    const answer = await dispatch(ctx, {
      action: 'install-from-remote',
      rootKey: rootKey(),
      url: 'https://gitlab.com/owner/four',
      execImpl: impl,
    })
    assert.equal(answer.ok, false)
    assert.equal(answer.code, 'no-git')
  })
})

describe('the tree a clone produces', () => {
  test('a directory on disk reads as a tree', async () => {
    const base = await mkdtemp(join(tmpdir(), 'dsh-skills-tree-'))
    try {
      await mkdir(join(base, 'skills', 'alpha', 'references'), { recursive: true })
      await writeFile(join(base, 'skills', 'alpha', 'SKILL.md'), ALPHA, 'utf8')
      await writeFile(join(base, 'skills', 'alpha', 'references', 'usage.md'), '# Usage\n', 'utf8')
      await mkdir(join(base, '.git'), { recursive: true })
      await writeFile(join(base, '.git', 'config'), '[core]\n', 'utf8')

      const tree = await readRemoteTree(
        { kind: 'git', url: 'https://example.com/owner/repo' },
        {
          execImpl: (file, args, options, callback) => {
            const target = args[args.length - 1]
            cpInto(base, target).then(
              () => callback(null, '', ''),
              (error) => callback(error, '', ''),
            )
          },
        },
      )
      assert.deepEqual([...tree.files.keys()].sort(), ['skills/alpha/SKILL.md', 'skills/alpha/references/usage.md'])
    } finally {
      await rm(base, { recursive: true, force: true })
    }
  })
})

/**
 * Copy a directory tree.
 * @param from - the source directory.
 * @param to - the destination directory.
 */
async function cpInto(from, to) {
  await mkdir(to, { recursive: true })
  for (const entry of await readdir(from, { withFileTypes: true })) {
    const source = join(from, entry.name)
    const target = join(to, entry.name)
    if (entry.isDirectory()) await cpInto(source, target)
    else await writeFile(target, await readFile(source))
  }
}

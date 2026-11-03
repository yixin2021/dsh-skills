/**
 * Extra directories: a person may point the panel at another agent's skill
 * library.
 *
 * These tests run the real dispatcher against real directories, because the
 * interesting parts are the ones a mock would skip: what happens to the
 * bookkeeping file, what the page is allowed to change, and whether a skill can
 * be copied out of a directory DSH never scans.
 */

import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'

import { apply, dispatch } from '../index.js'

const SKILL = '---\nname: alpha\ndescription: Does the alpha thing.\n---\n\n# Alpha\n'
const OTHER = '---\nname: beta\ndescription: Does the beta thing.\n---\n\n# Beta\n'

/** A Host context with no workspaces. */
const ctx = { get: () => undefined }

describe('added directories', () => {
  let base
  let library
  let second

  before(async () => {
    base = await mkdtemp(join(tmpdir(), 'dsh-skills-custom-'))
    // An "other agent" library: not one of the roots DSH scans itself.
    library = join(base, 'other-agent', 'skills')
    await mkdir(join(library, 'alpha'), { recursive: true })
    await writeFile(join(library, 'alpha', 'SKILL.md'), SKILL, 'utf8')
    second = join(base, 'second-agent', 'skills')
    await mkdir(join(second, 'beta'), { recursive: true })
    await writeFile(join(second, 'beta', 'SKILL.md'), OTHER, 'utf8')
    process.env.DSH_HOME = join(base, 'home')
    process.env.DSH_AGENTS_HOME = join(base, 'agents')
    await mkdir(join(process.env.DSH_HOME, 'skills'), { recursive: true })
  })

  after(async () => {
    delete process.env.DSH_HOME
    delete process.env.DSH_AGENTS_HOME
    await rm(base, { recursive: true, force: true })
  })

  test('refuses a path that is not an existing directory', async () => {
    const relative = await dispatch(ctx, { action: 'add-root', path: 'relative/dir' })
    assert.equal(relative.ok, false)
    assert.equal(relative.code, 'bad-path')

    const missing = await dispatch(ctx, { action: 'add-root', path: join(base, 'nowhere') })
    assert.equal(missing.ok, false)
    assert.equal(missing.code, 'missing')

    // A managed root is not something a person adds: it is already listed.
    const duplicate = await dispatch(ctx, { action: 'add-root', path: join(process.env.DSH_HOME, 'skills') })
    assert.equal(duplicate.ok, false)
    assert.equal(duplicate.code, 'duplicate')
  })

  test('lists an added directory as read-only with its skills', async () => {
    const added = await dispatch(ctx, { action: 'add-root', path: library })
    assert.equal(added.ok, true)
    assert.match(added.key, /^custom:[0-9a-f]{8}$/)

    const listed = await dispatch(ctx, { action: 'list' })
    const root = listed.roots.find((entry) => entry.path === library)
    assert.ok(root, 'the directory is listed')
    assert.equal(root.kind, 'custom')
    assert.equal(root.readOnly, true)
    assert.deepEqual(root.skills.map((skill) => skill.name), ['alpha'])
    // The managed DSH roots are still there, unchanged.
    assert.ok(listed.roots.some((entry) => entry.key === 'user-dsh'))
  })

  test('refuses to change anything inside an added directory', async () => {
    const listed = await dispatch(ctx, { action: 'list' })
    const root = listed.roots.find((entry) => entry.path === library)

    const disable = await dispatch(ctx, { action: 'set-disabled', rootKey: root.key, entryName: 'alpha', disabled: true })
    assert.equal(disable.ok, false)
    assert.equal(disable.code, 'read-only')

    const trash = await dispatch(ctx, { action: 'trash', rootKey: root.key, entryName: 'alpha' })
    assert.equal(trash.ok, false)
    assert.equal(trash.code, 'read-only')

    const create = await dispatch(ctx, { action: 'create', rootKey: root.key, name: 'gamma', description: 'x' })
    assert.equal(create.ok, false)
    assert.equal(create.code, 'read-only')

    // The other agent's library is byte-for-byte as it was.
    assert.deepEqual(await readdir(library), ['alpha'])
    assert.match(await readFile(join(library, 'alpha', 'SKILL.md'), 'utf8'), /^---\nname: alpha\n/m)
  })

  test('copies a skill out of an added directory into one DSH scans', async () => {
    const listed = await dispatch(ctx, { action: 'list' })
    const root = listed.roots.find((entry) => entry.path === library)
    const skill = root.skills.find((entry) => entry.name === 'alpha')

    const copied = await dispatch(ctx, { action: 'import-directory', rootKey: 'user-dsh', sourcePath: skill.path })
    assert.equal(copied.ok, true)
    assert.equal(copied.entryName, 'alpha')

    const after = await dispatch(ctx, { action: 'list' })
    const userRoot = after.roots.find((entry) => entry.key === 'user-dsh')
    assert.deepEqual(userRoot.skills.map((entry) => entry.name), ['alpha'])
    // Copied, not moved: the source library keeps its skill.
    assert.deepEqual(await readdir(library), ['alpha'])
  })

  test('keys follow the directory, not its position', async () => {
    await dispatch(ctx, { action: 'add-root', path: second })
    const before = await dispatch(ctx, { action: 'list' })
    const firstKey = before.roots.find((entry) => entry.path === library).key
    const secondKey = before.roots.find((entry) => entry.path === second).key
    assert.notEqual(firstKey, secondKey)

    // Removing an earlier directory must not re-point the later key.
    const removed = await dispatch(ctx, { action: 'remove-root', path: library })
    assert.equal(removed.ok, true)
    assert.equal(removed.removed, 1)

    const after = await dispatch(ctx, { action: 'list' })
    assert.equal(after.roots.find((entry) => entry.path === library), undefined)
    assert.equal(after.roots.find((entry) => entry.path === second).key, secondKey)
  })

  test('removing a directory forgets it in the bookkeeping file', async () => {
    const stored = JSON.parse(await readFile(join(process.env.DSH_HOME, 'skills-roots.json'), 'utf8'))
    assert.deepEqual(stored.paths, [second])

    const unknown = await dispatch(ctx, { action: 'remove-root', path: library })
    assert.equal(unknown.ok, false)
    assert.equal(unknown.code, 'unknown-root')
  })

  test('expands a leading ~ so a typed path behaves like a shell path', async () => {
    const realHome = process.env.HOME
    process.env.HOME = base
    try {
      // Spelled through `~`, this is the directory that is already listed.
      // Without expansion it would not be absolute and would be rejected as
      // `bad-path` instead, so the refusal itself proves the expansion ran.
      const added = await dispatch(ctx, { action: 'add-root', path: '~/second-agent/skills' })
      assert.equal(added.ok, false)
      assert.equal(added.code, 'duplicate')
    } finally {
      process.env.HOME = realHome
    }
  })

test('a symlinked bundle is a skill, not an unknown entry', async () => {
  // Claude Code and stow both link a bundle into a skills directory; readdir
  // reports the link as neither a file nor a directory.
  const linked = join(base, 'linked-library')
  await mkdir(linked, { recursive: true })
  const target = join(base, 'shared-skill')
  await mkdir(target, { recursive: true })
  await writeFile(join(target, 'SKILL.md'), SKILL, 'utf8')
  await symlink(target, join(linked, 'alpha'), 'dir')

  await dispatch(ctx, { action: 'add-root', path: linked })
  const listed = await dispatch(ctx, { action: 'list' })
  const root = listed.roots.find((entry) => entry.path === linked)
  assert.deepEqual(root.skills.map((skill) => skill.name), ['alpha'])
  assert.equal(root.skills[0].entryKind, 'directory')

  // Leave the list as the next test expects to find it.
  await dispatch(ctx, { action: 'remove-root', path: linked })
})

test('DSH itself can load skills from an added directory', async () => {
  let factory
  const invalidations = []
  const ctxWithSkills = {
    get(name) {
      if (name !== 'skills') return undefined
      return {
        registerProvider(create) {
          factory = create
          return () => {}
        },
      }
    },
    // Cordis runs an effect factory immediately; so does this stand-in.
    effect(fn) {
      fn()
      return () => {}
    },
    connection: { fetch: { register: () => () => {} } },
  }
  apply(ctxWithSkills)
  assert.equal(typeof factory, 'function', 'apply registers a provider when DSH exposes the service')

  const provider = factory({ signal: new AbortController().signal, invalidate: () => invalidations.push(Date.now()) })
  assert.equal(provider.name, 'dsh-skills-custom')

  // The earlier tests left the second library listed; add the first back.
  const added = await dispatch(ctx, { action: 'add-root', path: library })
  assert.equal(added.ok, true)
  assert.equal(invalidations.length, 1, 'adding a directory refreshes the catalog')

  const listed = await provider.list()
  const names = listed.candidates.map((candidate) => candidate.name).sort()
  assert.deepEqual(names, ['alpha', 'beta'])
  for (const candidate of listed.candidates) {
    assert.equal(candidate.source, 'custom')
    assert.equal(candidate.provider, 'dsh-skills-custom')
    assert.equal(candidate.invocation.modelInvocable, true)
  }

  const alpha = listed.candidates.find((candidate) => candidate.name === 'alpha')
  const skill = await provider.get(alpha)
  assert.equal(skill.name, 'alpha')
  assert.match(skill.content, /# Alpha/, 'the body is handed to the model without frontmatter')
  assert.doesNotMatch(skill.content, /^---/, 'frontmatter is not part of the body')
  assert.equal(skill.locator, undefined, 'the locator is not leaked into the definition')

  const removed = await dispatch(ctx, { action: 'remove-root', path: library })
  assert.equal(removed.ok, true)
  assert.equal(invalidations.length, 2, 'removing a directory refreshes the catalog')
  const after = await provider.list()
  assert.deepEqual(after.candidates.map((candidate) => candidate.name), ['beta'])
})
})

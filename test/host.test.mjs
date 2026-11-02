/**
 * Host behaviour: the frontmatter grammar, root discovery and every mutation,
 * exercised against a real temporary directory tree.
 *
 * Run with `node --test test/`.
 */

import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { after, before, describe, test } from 'node:test'

import {
  composeSkillFile,
  describeSkill,
  isSkillName,
  listRoots,
  parseFrontmatter,
  readFlag,
  resolveWithin,
  scanRoot,
} from '../lib/skills-core.js'
import { dispatch } from '../index.js'

/** A Host context whose only service is the workspace registry. */
function fakeContext(workspaces) {
  return {
    get(name) {
      if (name !== 'workspaceRegistry') return undefined
      return { list: () => workspaces.map((path) => ({ path, title: path.split('/').pop() })) }
    },
  }
}

const SKILL = `---
name: alpha
description: Does the alpha thing.
whenToUse: When alpha is needed.
---

# Alpha

Body text.
`

describe('frontmatter', () => {
  test('parses the keys DSH reads', () => {
    const parsed = parseFrontmatter(SKILL)
    assert.equal(parsed.present, true)
    assert.equal(parsed.data.name, 'alpha')
    assert.equal(parsed.data.description, 'Does the alpha thing.')
    assert.equal(parsed.data.whenToUse, 'When alpha is needed.')
    assert.match(parsed.body, /# Alpha/)
  })

  test('reports a file with no frontmatter', () => {
    const parsed = parseFrontmatter('# Just a heading\n')
    assert.equal(parsed.present, false)
    assert.equal(parsed.data.name, undefined)
  })

  test('handles quoted scalars, comments and block scalars', () => {
    const parsed = parseFrontmatter(
      ['---', 'name: "quoted-name"', "description: 'has: colon'", 'whenToUse: plain # note', 'note: |', '  line one', '  line two', '---', ''].join('\n'),
    )
    assert.equal(parsed.data.name, 'quoted-name')
    assert.equal(parsed.data.description, 'has: colon')
    assert.equal(parsed.data.whenToUse, 'plain')
    assert.equal(parsed.data.note, 'line one\nline two')
  })

  test('reads DSH boolean spellings and rejects the rest', () => {
    assert.equal(readFlag('TRUE'), true)
    assert.equal(readFlag('no'), false)
    assert.equal(readFlag(undefined), undefined)
    assert.equal(readFlag('sometimes'), 'invalid')
  })

  test('describeSkill reports the invocation policy and discovery issues', () => {
    const skill = describeSkill({ text: SKILL, entryName: 'alpha', entryKind: 'directory' })
    assert.equal(skill.name, 'alpha')
    assert.equal(skill.modelInvocable, true)
    assert.equal(skill.userInvocable, true)
    assert.deepEqual(skill.issues, [])

    const bare = describeSkill({ text: 'no frontmatter', entryName: 'bare', entryKind: 'file' })
    assert.deepEqual(bare.issues, ['missing-frontmatter', 'missing-name', 'missing-description'])

    const hidden = describeSkill({
      text: '---\nname: x\ndescription: y\ndisable-model-invocation: true\nuser-invocable: false\n---\n',
      entryName: 'x',
      entryKind: 'directory',
    })
    assert.equal(hidden.modelInvocable, false)
    assert.equal(hidden.userInvocable, false)
  })

  test('composeSkillFile round-trips through the parser', () => {
    const text = composeSkillFile({ name: 'made', description: 'Made: by a test # ok', body: '# Made\n' })
    const parsed = parseFrontmatter(text)
    assert.equal(parsed.data.name, 'made')
    assert.equal(parsed.data.description, 'Made: by a test # ok')
  })
})

describe('paths and names', () => {
  test('resolveWithin refuses escapes', () => {
    const base = '/tmp/root'
    assert.equal(resolveWithin(base, 'a/SKILL.md'), '/tmp/root/a/SKILL.md')
    assert.equal(resolveWithin(base, '../escape'), undefined)
    assert.equal(resolveWithin(base, '/etc/passwd'), undefined)
    assert.equal(resolveWithin(base, 'a\\b'), undefined)
    assert.equal(resolveWithin(base, ''), undefined)
    assert.equal(resolveWithin(base, 'a/../../b'), undefined)
  })

  test('isSkillName accepts DSH names and rejects the rest', () => {
    assert.equal(isSkillName('my-skill'), true)
    assert.equal(isSkillName('a.b_c-1'), true)
    for (const bad of ['.hidden', 'has space', '../x', '', '-lead']) assert.equal(isSkillName(bad), false)
  })
})

describe('roots and scanning', () => {
  let base
  let project

  before(async () => {
    base = await mkdtemp(join(tmpdir(), 'dsh-skills-'))
    project = join(base, 'project')
    await mkdir(join(project, '.dsh', 'skills', 'alpha'), { recursive: true })
    await writeFile(join(project, '.dsh', 'skills', 'alpha', 'SKILL.md'), SKILL, 'utf8')
    await writeFile(join(project, '.dsh', 'skills', 'flat.md'), SKILL.replace('alpha', 'flat'), 'utf8')
    await mkdir(join(project, '.dsh', 'skills', 'nested', 'inner'), { recursive: true })
    await writeFile(join(project, '.dsh', 'skills', 'nested', 'inner', 'SKILL.md'), SKILL, 'utf8')
  })

  after(async () => {
    await rm(base, { recursive: true, force: true })
  })

  test('lists the user roots and the project roots that exist', async () => {
    const roots = await listRoots({ dshHome: base, agentsHome: join(base, 'agents-home'), workspaces: [{ path: project, title: 'project' }] })
    const keys = roots.map((root) => root.key)
    assert.deepEqual(keys.slice(0, 2), ['user-dsh', 'user-agents'])
    assert.ok(keys.includes(`project-dsh:${project}`))
    assert.ok(!keys.includes(`project-agents:${project}`), 'a project root appears only when its directory exists')
  })

  test('scans direct children only, and both skill shapes', async () => {
    const roots = await listRoots({ dshHome: base, agentsHome: join(base, 'agents-home'), workspaces: [{ path: project, title: 'project' }] })
    const root = roots.find((entry) => entry.key === `project-dsh:${project}`)
    const scanned = await scanRoot(root)
    assert.equal(scanned.exists, true)
    assert.deepEqual(scanned.skills.map((skill) => skill.name).sort(), ['alpha', 'flat'])
    assert.ok(!scanned.skills.some((skill) => skill.name === 'inner'), 'nested SKILL.md files are not discovered')
  })

  test('a missing root is reported, not thrown', async () => {
    const scanned = await scanRoot({ key: 'user-dsh', path: join(base, 'absent') })
    assert.equal(scanned.exists, false)
    assert.deepEqual(scanned.skills, [])
  })
})

describe('mutations', () => {
  let base
  let project
  let ctx

  before(async () => {
    base = await mkdtemp(join(tmpdir(), 'dsh-skills-mut-'))
    project = join(base, 'project')
    await mkdir(join(project, '.dsh', 'skills', 'alpha'), { recursive: true })
    await writeFile(join(project, '.dsh', 'skills', 'alpha', 'SKILL.md'), SKILL, 'utf8')
    process.env.DSH_HOME = base
    process.env.DSH_AGENTS_HOME = join(base, '.agents')
    ctx = fakeContext([project])
  })

  after(async () => {
    delete process.env.DSH_HOME
    delete process.env.DSH_AGENTS_HOME
    await rm(base, { recursive: true, force: true })
  })

  const rootKey = () => `project-dsh:${project}`

  test('list returns the roots, the skills and the trash', async () => {
    const answer = await dispatch(ctx, { action: 'list' })
    assert.equal(answer.ok, true)
    const root = answer.roots.find((entry) => entry.key === rootKey())
    assert.deepEqual(root.skills.map((skill) => skill.name), ['alpha'])
    assert.deepEqual(root.trash, [])
  })

  test('disable moves the bundle to .disabled and enable moves it back', async () => {
    const disabled = await dispatch(ctx, { action: 'set-disabled', rootKey: rootKey(), entryName: 'alpha', disabled: true })
    assert.equal(disabled.ok, true)
    const listed = await dispatch(ctx, { action: 'list' })
    const root = listed.roots.find((entry) => entry.key === rootKey())
    assert.equal(root.skills.find((skill) => skill.entryName === 'alpha').disabled, true)
    const onDisk = await readdir(join(project, '.dsh', 'skills', '.disabled'))
    assert.deepEqual(onDisk, ['alpha'])

    const enabled = await dispatch(ctx, { action: 'set-disabled', rootKey: rootKey(), entryName: 'alpha', disabled: false })
    assert.equal(enabled.ok, true)
    assert.deepEqual(await readdir(join(project, '.dsh', 'skills', '.disabled')), [])
  })

  test('disable refuses an entry that is not where it claims', async () => {
    const answer = await dispatch(ctx, { action: 'set-disabled', rootKey: rootKey(), entryName: 'ghost', disabled: true })
    assert.equal(answer.ok, false)
    assert.equal(answer.code, 'missing')
  })

  test('disable refuses a name that is not a skill name', async () => {
    const answer = await dispatch(ctx, { action: 'set-disabled', rootKey: rootKey(), entryName: '../etc', disabled: true })
    assert.equal(answer.ok, false)
    assert.equal(answer.code, 'bad-name')
  })

  test('an unknown root key is refused', async () => {
    const answer = await dispatch(ctx, { action: 'set-disabled', rootKey: '/etc', entryName: 'alpha', disabled: true })
    assert.equal(answer.code, 'unknown-root')
  })

  test('a DSH_HOME that already names .dsh is not nested again', async () => {
    const answer = await dispatch(ctx, { action: 'list' })
    const dsh = answer.roots.find((entry) => entry.key === 'user-dsh')
    const agents = answer.roots.find((entry) => entry.key === 'user-agents')
    // DSH_HOME is `/…/.dsh` itself; the root is `<that>/skills`.
    assert.equal(dsh.path, join(base, 'skills'))
    assert.ok(!dsh.path.includes(`${sep}.dsh${sep}.dsh${sep}`), dsh.path)
    // The agents root comes from the agents home, not from the DSH home.
    assert.equal(agents.path, join(base, '.agents', 'skills'))
  })

  test('the user root is addressable even before it exists', async () => {
    const answer = await dispatch(ctx, { action: 'list' })
    const userRoot = answer.roots.find((entry) => entry.key === 'user-dsh')
    assert.equal(userRoot.exists, false)
    assert.equal(userRoot.path, join(base, 'skills'))
  })

  test('read returns the body, and refuses an oversized file', async () => {
    const answer = await dispatch(ctx, { action: 'read', rootKey: rootKey(), entryName: 'alpha', disabled: false })
    assert.equal(answer.ok, true)
    assert.match(answer.skill.body, /Body text/)
    assert.equal(answer.rootPath, join(project, '.dsh', 'skills'))
  })

  test('uninstall, restore and purge round-trip', async () => {
    const trashed = await dispatch(ctx, { action: 'trash', rootKey: rootKey(), entryName: 'alpha' })
    assert.equal(trashed.ok, true)
    let listed = await dispatch(ctx, { action: 'list' })
    let root = listed.roots.find((entry) => entry.key === rootKey())
    assert.deepEqual(root.skills, [])
    assert.equal(root.trash.length, 1)

    const restored = await dispatch(ctx, { action: 'restore', rootKey: rootKey(), entryName: 'alpha' })
    assert.equal(restored.ok, true)
    listed = await dispatch(ctx, { action: 'list' })
    root = listed.roots.find((entry) => entry.key === rootKey())
    assert.deepEqual(root.skills.map((skill) => skill.name), ['alpha'])

    await dispatch(ctx, { action: 'trash', rootKey: rootKey(), entryName: 'alpha' })
    const purged = await dispatch(ctx, { action: 'purge', rootKey: rootKey(), entryName: 'alpha' })
    assert.equal(purged.ok, true)
    listed = await dispatch(ctx, { action: 'list' })
    root = listed.roots.find((entry) => entry.key === rootKey())
    assert.deepEqual(root.trash, [])
  })

  test('create writes a bundle that scans back', async () => {
    const created = await dispatch(ctx, {
      action: 'create',
      rootKey: rootKey(),
      name: 'beta',
      description: 'Does beta.',
      whenToUse: 'When beta is needed.',
      body: '# Beta\n',
    })
    assert.equal(created.ok, true)
    const text = await readFile(join(project, '.dsh', 'skills', 'beta', 'SKILL.md'), 'utf8')
    const skill = describeSkill({ text, entryName: 'beta', entryKind: 'directory' })
    assert.equal(skill.name, 'beta')
    assert.deepEqual(skill.issues, [])
  })

  test('create refuses a duplicate and an unusable name', async () => {
    const duplicate = await dispatch(ctx, { action: 'create', rootKey: rootKey(), name: 'beta', description: 'x' })
    assert.equal(duplicate.code, 'conflict')
    const bad = await dispatch(ctx, { action: 'create', rootKey: rootKey(), name: '../escape', description: 'x' })
    assert.equal(bad.code, 'bad-name')
    const noDescription = await dispatch(ctx, { action: 'create', rootKey: rootKey(), name: 'gamma', description: '' })
    assert.equal(noDescription.code, 'bad-description')
  })

  test('install copies a folder and refuses traversal', async () => {
    const source = join(base, 'source-skill')
    await mkdir(source, { recursive: true })
    await writeFile(join(source, 'SKILL.md'), SKILL.replace(/alpha/g, 'copied'), 'utf8')

    const installed = await dispatch(ctx, { action: 'import-directory', rootKey: rootKey(), sourcePath: source })
    assert.equal(installed.ok, true)
    assert.equal(installed.entryName, 'copied')
    assert.ok(await readFile(join(project, '.dsh', 'skills', 'copied', 'SKILL.md'), 'utf8'))
    assert.ok(await readFile(join(source, 'SKILL.md'), 'utf8'), 'the source is copied, never moved')

    const escaped = await dispatch(ctx, {
      action: 'import-files',
      rootKey: rootKey(),
      name: 'sneaky',
      files: [{ path: '../escape/SKILL.md', content: 'x' }],
    })
    assert.equal(escaped.code, 'bad-path')
  })

  test('import-files needs a SKILL.md and writes nested paths', async () => {
    const noSkill = await dispatch(ctx, { action: 'import-files', rootKey: rootKey(), name: 'noskill', files: [{ path: 'README.md', content: 'x' }] })
    assert.equal(noSkill.code, 'not-a-skill')

    const ok = await dispatch(ctx, {
      action: 'import-files',
      rootKey: rootKey(),
      name: 'nested-assets',
      files: [
        { path: 'SKILL.md', content: '---\nname: nested-assets\ndescription: Has a reference.\n---\n' },
        { path: 'references/usage.md', content: '# Usage\n' },
      ],
    })
    assert.equal(ok.ok, true)
    assert.ok(await readFile(join(project, '.dsh', 'skills', 'nested-assets', 'references', 'usage.md'), 'utf8'))
  })

  test('empty-trash removes every entry of one root', async () => {
    await dispatch(ctx, { action: 'trash', rootKey: rootKey(), entryName: 'beta' })
    const emptied = await dispatch(ctx, { action: 'empty-trash', rootKey: rootKey() })
    assert.equal(emptied.ok, true)
    assert.equal(emptied.removed >= 1, true)
    const listed = await dispatch(ctx, { action: 'list' })
    assert.deepEqual(listed.roots.find((entry) => entry.key === rootKey()).trash, [])
  })

  test('an unknown action is a typed failure', async () => {
    const answer = await dispatch(ctx, { action: 'nope' })
    assert.equal(answer.code, 'unknown-action')
    assert.equal((await dispatch(ctx, null)).code, 'bad-request')
  })
})

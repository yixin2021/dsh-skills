/**
 * Agent libraries: the skill directories Codex, CodeBuddy and Claude Code keep
 * are found on their own, so a person does not have to paste a path the app
 * could have discovered.
 *
 * These tests run against a temporary home with the environment variables each
 * agent honours, so the result does not depend on what is installed on the
 * machine running them.
 */

import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'

import { apply, dispatch, internals } from '../index.js'

const SKILL = '---\nname: %NAME%\ndescription: A test skill.\n---\n\n# Body\n'

/** A Host context with no workspaces. */
const ctx = { get: () => undefined }

describe('agent libraries', () => {
  let base

  before(async () => {
    base = await mkdtemp(join(tmpdir(), 'dsh-skills-agents-'))
    process.env.DSH_HOME = join(base, 'home')
    process.env.DSH_AGENTS_HOME = join(base, 'agents')
    process.env.CODEX_HOME = join(base, 'codex')
    process.env.CODEBUDDY_HOME = join(base, 'codebuddy')
    process.env.CLAUDE_CONFIG_DIR = join(base, 'claude')
    for (const [kind, name] of [
      [process.env.CODEX_HOME, 'codex-skill'],
      [process.env.CODEBUDDY_HOME, 'buddy-skill'],
      [process.env.CLAUDE_CONFIG_DIR, 'claude-skill'],
    ]) {
      await mkdir(join(kind, 'skills', name), { recursive: true })
      await writeFile(join(kind, 'skills', name, 'SKILL.md'), SKILL.replace('%NAME%', name), 'utf8')
    }
  })

  after(async () => {
    delete process.env.DSH_HOME
    delete process.env.DSH_AGENTS_HOME
    delete process.env.CODEX_HOME
    delete process.env.CODEBUDDY_HOME
    delete process.env.CLAUDE_CONFIG_DIR
    await rm(base, { recursive: true, force: true })
  })

  test('finds each agent library that exists, and skips the ones that do not', async () => {
    const listed = await dispatch(ctx, { action: 'list' })
    const agents = listed.roots.filter((root) => root.kind === 'agent')
    assert.deepEqual(agents.map((root) => root.agent), ['codex', 'codebuddy', 'claude'])
    assert.deepEqual(agents.map((root) => root.skills.map((skill) => skill.name)), [['codex-skill'], ['buddy-skill'], ['claude-skill']])
    for (const root of agents) {
      assert.equal(root.readOnly, true, 'another agent owns those bytes')
      assert.equal(root.exists, true)
      assert.match(root.key, /^agent:/)
    }

    // DSH's own roots carry the DSH mark.
    const own = listed.roots.find((root) => root.key === 'user-dsh')
    assert.equal(own.agent, 'dsh')
  })

  test('honours the environment variable each agent uses for its home', () => {
    const candidates = internals.agentLibraryCandidates()
    assert.deepEqual(
      candidates.map((entry) => entry.path),
      [join(process.env.CODEX_HOME, 'skills'), join(process.env.CODEBUDDY_HOME, 'skills'), join(process.env.CLAUDE_CONFIG_DIR, 'skills')],
    )
  })

  test('a library that disappears stops being listed', async () => {
    const before = await internals.discoverAgentLibraries()
    assert.equal(before.length, 3)
    await rm(join(process.env.CODEBUDDY_HOME, 'skills'), { recursive: true, force: true })
    const after = await internals.discoverAgentLibraries()
    assert.deepEqual(after.map((entry) => entry.agent), ['codex', 'claude'])
    // Put it back for the tests that follow.
    await mkdir(join(process.env.CODEBUDDY_HOME, 'skills', 'buddy-skill'), { recursive: true })
    await writeFile(join(process.env.CODEBUDDY_HOME, 'skills', 'buddy-skill', 'SKILL.md'), SKILL.replace('%NAME%', 'buddy-skill'), 'utf8')
  })

  test('adding a discovered directory by hand is refused instead of doubled', async () => {
    const added = await dispatch(ctx, { action: 'add-root', path: join(process.env.CODEX_HOME, 'skills') })
    assert.equal(added.ok, false)
    assert.equal(added.code, 'duplicate')
  })

  test('the model sees the agent libraries through the plugin provider', async () => {
    let factory
    const ctxWithSkills = {
      get: (name) => (name === 'skills' ? { registerProvider: (create) => ((factory = create), () => {}) } : undefined),
      effect: (fn) => (fn(), () => {}),
      connection: { fetch: { register: () => () => {} } },
    }
    apply(ctxWithSkills)
    const provider = factory({ signal: new AbortController().signal, invalidate: () => {} })
    const listed = await provider.list()
    assert.deepEqual(listed.candidates.map((candidate) => candidate.name).sort(), ['buddy-skill', 'claude-skill', 'codex-skill'])
    for (const candidate of listed.candidates) assert.equal(candidate.source, 'custom')

    const skill = await provider.get(listed.candidates.find((candidate) => candidate.name === 'codex-skill'))
    assert.match(skill.content, /# Body/)
  })
})

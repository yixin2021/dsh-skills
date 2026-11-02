/**
 * Transport behaviour: `apply` mounts exactly one route, and that route's real
 * handler turns a `Request` into a `Response` with the answer the page expects.
 *
 * The other suite calls `dispatch` directly; this one proves the outer layer —
 * JSON decoding, the 400/500 bodies, the no-store header and route ownership —
 * because a correct dispatcher behind a broken registration still ships a dead
 * panel.
 */

import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'

import { ROUTE, apply } from '../index.js'

const SKILL = '---\nname: alpha\ndescription: Alpha.\n---\n\n# Alpha\n'

/** A Host context that records the route the plugin registers. */
function recordingContext() {
  const routes = []
  const cleanups = []
  const ctx = {
    get(name) {
      return name === 'workspaceRegistry' ? { list: () => [] } : undefined
    },
    effect(factory) {
      cleanups.push(factory())
      return () => {}
    },
    connection: {
      fetch: {
        register(route) {
          routes.push(route)
          return async () => {}
        },
      },
    },
  }
  return { ctx, routes, cleanups }
}

/** Post one body the way the page does. @returns the Response. */
async function post(route, body) {
  return route.fetch(
    new Request(`http://127.0.0.1:1${ROUTE}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
  )
}

describe('route', () => {
  let base
  let project
  let mounted

  before(async () => {
    base = await mkdtemp(join(tmpdir(), 'dsh-skills-route-'))
    project = join(base, 'project')
    await mkdir(join(project, '.dsh', 'skills', 'alpha'), { recursive: true })
    await writeFile(join(project, '.dsh', 'skills', 'alpha', 'SKILL.md'), SKILL, 'utf8')
    process.env.DSH_HOME = base
    const recorded = recordingContext()
    recorded.ctx.get = (name) =>
      name === 'workspaceRegistry' ? { list: () => [{ path: project, title: 'project' }] } : undefined
    apply(recorded.ctx)
    mounted = recorded
  })

  after(async () => {
    delete process.env.DSH_HOME
    await rm(base, { recursive: true, force: true })
  })

  test('mounts exactly one POST route on the documented path', () => {
    assert.equal(mounted.routes.length, 1)
    const [route] = mounted.routes
    assert.equal(route.path, ROUTE)
    assert.equal(ROUTE, '/api/dsh-skills')
    assert.deepEqual(route.methods, ['POST'])
    assert.equal(route.requestBody, 'buffered')
    assert.equal(typeof route.fetch, 'function')
  })

  test('answers list with skills and a no-store cache header', async () => {
    const response = await post(mounted.routes[0], { action: 'list' })
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('cache-control'), 'no-store')
    const body = await response.json()
    assert.equal(body.ok, true)
    const root = body.roots.find((entry) => entry.key === `project-dsh:${project}`)
    assert.deepEqual(root.skills.map((skill) => skill.name), ['alpha'])
  })

  test('drives a full enable/disable cycle through the route', async () => {
    const route = mounted.routes[0]
    const rootKey = `project-dsh:${project}`
    const off = await (await post(route, { action: 'set-disabled', rootKey, entryName: 'alpha', disabled: true })).json()
    assert.equal(off.ok, true)

    const listed = await (await post(route, { action: 'list' })).json()
    const skill = listed.roots.find((entry) => entry.key === rootKey).skills.find((entry) => entry.entryName === 'alpha')
    assert.equal(skill.disabled, true)

    const on = await (await post(route, { action: 'set-disabled', rootKey, entryName: 'alpha', disabled: false })).json()
    assert.equal(on.ok, true)
  })

  test('a malformed body is a 400, and a broken workspace registry degrades quietly', async () => {
    const route = mounted.routes[0]
    const bad = await post(route, 'not json')
    assert.equal(bad.status, 400)
    assert.equal((await bad.json()).code, 'bad-request')

    // `workspaceList` swallows a registry that throws, because a panel that
    // refuses to load over one bad Workspace is worse than one that omits it.
    const broken = recordingContext()
    broken.ctx.get = () => ({
      list: () => {
        throw new Error('registry exploded')
      },
    })
    apply(broken.ctx)
    const response = await post(broken.routes[0], { action: 'list' })
    assert.equal(response.status, 200)
    const body = await response.json()
    assert.equal(body.ok, true)
    assert.deepEqual(body.roots.map((entry) => entry.key), ['user-dsh', 'user-agents'])
  })
})

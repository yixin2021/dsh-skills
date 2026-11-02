/**
 * DSH Skills — Host half.
 *
 * One authenticated JSON route that the Client half calls instead of touching
 * skill roots itself. The route answers the same four questions the shipped
 * filesystem provider answers — which roots exist, which entries each root
 * holds, what an entry's frontmatter says, and what its body contains — and
 * adds the mutations a person needs in front of them: enable, disable,
 * uninstall, restore and install.
 *
 * Every mutation is a rename or a create beneath a root this plugin resolved
 * itself. No request field is ever concatenated into a path without passing
 * `resolveWithin`, so a page cannot address a file outside the roots.
 *
 * @module dsh-skills
 */

import { execFile } from 'node:child_process'
import { cp, mkdir, rename, rm, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'

import {
  DISABLED_DIR,
  MAX_INSTALL_BYTES,
  MAX_INSTALL_FILES,
  MAX_SKILL_BYTES,
  MAX_UPLOAD_BYTES,
  SKILL_FILE,
  TRASH_DIR,
  composeSkillFile,
  describeSkill,
  entryLocations,
  isSkillName,
  listRoots,
  resolveWithin,
  scanRoot,
} from './lib/skills-core.js'

/** The authenticated Fetch route the Client half posts to. */
export const ROUTE = '/api/dsh-skills'

/** Connection owns the transport this plugin answers on. */
export const inject = ['connection']

/** The skills home DSH itself uses. */
function dshHome() {
  return process.env.DSH_HOME || join(homedir(), '.dsh')
}

/** The agents home DSH reads as its lowest-priority user root. */
function agentsHome() {
  return process.env.DSH_AGENTS_HOME || join(homedir(), '.agents')
}

/** @returns whether `value` is a plain JSON object. */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * The registered workspaces, as the root resolver wants them.
 * @param ctx - Host context.
 * @returns path/title pairs, in registry order.
 */
function workspaceList(ctx) {
  const registry = ctx.get('workspaceRegistry')
  if (registry === undefined || typeof registry.list !== 'function') return []
  try {
    return registry
      .list()
      .filter((workspace) => typeof workspace?.path === 'string' && workspace.path.length > 0)
      .map((workspace) => ({ path: workspace.path, title: workspace.title }))
  } catch {
    return []
  }
}

/**
 * Resolve one root key back to a root record.
 *
 * The key embeds a workspace path for project roots, so resolution re-derives
 * the root list rather than trusting a path from the page.
 *
 * @param ctx - Host context.
 * @param key - a root key from a previous `list`.
 * @returns the root record, or undefined when it is not one of ours.
 */
async function findRoot(ctx, key) {
  if (typeof key !== 'string') return undefined
  const roots = await listRoots({ dshHome: dshHome(), agentsHome: agentsHome(), workspaces: workspaceList(ctx) })
  const known = roots.find((root) => root.key === key)
  if (known !== undefined) return known
  // A project root the workspace registry no longer lists cannot be addressed.
  return undefined
}

/**
 * Resolve one skill entry inside a root.
 *
 * @param root - the owning root.
 * @param entryName - the entry's name on disk.
 * @returns the entry's locations plus the live one, or undefined.
 */
function findEntry(root, entryName) {
  if (!isSkillName(entryName)) return undefined
  const locations = entryLocations(root.path, entryName)
  return { ...locations, entryName }
}

/** @returns the absolute path of one skill's instruction file. */
async function locateSkill(root, entryName, disabled) {
  const locations = findEntry(root, entryName)
  if (locations === undefined) return undefined
  const base = disabled ? locations.disabled : locations.enabled
  const file = join(base, SKILL_FILE)
  try {
    const info = await stat(file)
    if (info.isFile()) return { base, file, kind: 'directory' }
  } catch {
    /* Not a bundle; a flat file is the other shape. */
  }
  const flat = disabled ? join(root.path, DISABLED_DIR, entryName) : join(root.path, entryName)
  try {
    const info = await stat(flat)
    if (info.isFile() && flat.toLowerCase().endsWith('.md')) return { base: flat, file: flat, kind: 'file' }
  } catch {
    /* Not there. */
  }
  return undefined
}

/**
 * Read one skill's body for the preview pane.
 * @param request - root key, entry name and disabled flag.
 * @returns the skill with its body, or a typed failure.
 */
async function readSkill(ctx, request) {
  const root = await findRoot(ctx, request.rootKey)
  if (root === undefined) return { ok: false, code: 'unknown-root', message: 'That root is not one this plugin manages.' }
  if (typeof request.entryName !== 'string') {
    return { ok: false, code: 'bad-request', message: 'entryName is required.' }
  }
  const located = await locateSkill(root, request.entryName, request.disabled === true)
  if (located === undefined) return { ok: false, code: 'missing', message: 'That skill is not on disk any more.' }
  const info = await stat(located.file)
  if (info.size > MAX_SKILL_BYTES) {
    return {
      ok: false,
      code: 'too-large',
      message: `That instruction file is ${info.size} bytes; the preview stops at ${MAX_SKILL_BYTES}.`,
    }
  }
  const text = await readFile(located.file, 'utf8')
  const skill = describeSkill({
    text,
    entryName: request.entryName,
    entryKind: located.kind,
    file: located.file,
    path: located.base,
    size: info.size,
    updatedAt: info.mtime.toISOString(),
    disabled: request.disabled === true,
    includeBody: true,
  })
  return { ok: true, rootKey: root.key, rootPath: root.path, skill }
}

/**
 * Move an entry between the root and its hidden `.disabled` directory.
 *
 * @param request - root key, entry name and the desired state.
 * @returns the new state, or a typed failure.
 */
async function setDisabled(ctx, request) {
  const root = await findRoot(ctx, request.rootKey)
  if (root === undefined) return { ok: false, code: 'unknown-root', message: 'That root is not one this plugin manages.' }
  const locations = findEntry(root, request.entryName)
  if (locations === undefined) return { ok: false, code: 'bad-name', message: 'That entry name is not a skill name.' }
  const wantDisabled = request.disabled === true
  const from = wantDisabled ? locations.enabled : locations.disabled
  const to = wantDisabled ? locations.disabled : locations.enabled

  const source = await stat(from).catch(() => undefined)
  if (source === undefined) {
    return { ok: false, code: 'missing', message: `The skill is not in the ${wantDisabled ? 'enabled' : 'disabled'} set.` }
  }
  const occupant = await stat(to).catch(() => undefined)
  if (occupant !== undefined) {
    return { ok: false, code: 'conflict', message: `"${request.entryName}" already exists in the target location.` }
  }
  await mkdir(dirname(to), { recursive: true })
  await rename(from, to)
  return { ok: true, rootKey: root.key, entryName: request.entryName, disabled: wantDisabled }
}

/**
 * Move one entry into the root's trash, or back out of it.
 *
 * Uninstall is reversible until the trash is purged: this is a person's
 * skill library, and a mis-click must not destroy a hand-written skill.
 *
 * @param request - root key, entry name and the direction.
 * @returns the new state, or a typed failure.
 */
async function moveToTrash(ctx, request) {
  const root = await findRoot(ctx, request.rootKey)
  if (root === undefined) return { ok: false, code: 'unknown-root', message: 'That root is not one this plugin manages.' }
  const locations = findEntry(root, request.entryName)
  if (locations === undefined) return { ok: false, code: 'bad-name', message: 'That entry name is not a skill name.' }
  const restore = request.restore === true
  const trashPath = join(root.path, TRASH_DIR, request.entryName)
  const from = restore ? trashPath : await firstExisting([locations.enabled, locations.disabled])
  const to = restore ? locations.enabled : trashPath
  if (from === undefined) return { ok: false, code: 'missing', message: 'The skill is not on disk any more.' }

  const source = await stat(from).catch(() => undefined)
  if (source === undefined) return { ok: false, code: 'missing', message: 'The skill is not on disk any more.' }
  const occupant = await stat(to).catch(() => undefined)
  if (occupant !== undefined) {
    return { ok: false, code: 'conflict', message: `"${request.entryName}" already exists in the target location.` }
  }
  await mkdir(dirname(to), { recursive: true })
  await rename(from, to)
  return { ok: true, rootKey: root.key, entryName: request.entryName, trashed: !restore }
}

/** @returns the first path that exists, if any. */
async function firstExisting(paths) {
  for (const path of paths) {
    const info = await stat(path).catch(() => undefined)
    if (info !== undefined) return path
  }
  return undefined
}

/**
 * Permanently delete one trash entry.
 * @param request - root key and entry name.
 * @returns the removal outcome, or a typed failure.
 */
async function purgeEntry(ctx, request) {
  const root = await findRoot(ctx, request.rootKey)
  if (root === undefined) return { ok: false, code: 'unknown-root', message: 'That root is not one this plugin manages.' }
  if (!isSkillName(request.entryName)) return { ok: false, code: 'bad-name', message: 'That entry name is not a skill name.' }
  const target = resolveWithin(join(root.path, TRASH_DIR), request.entryName)
  if (target === undefined) return { ok: false, code: 'bad-name', message: 'That path leaves the trash.' }
  const info = await stat(target).catch(() => undefined)
  if (info === undefined) return { ok: false, code: 'missing', message: 'That entry is not in the trash.' }
  await rm(target, { recursive: true, force: true })
  return { ok: true, rootKey: root.key, entryName: request.entryName }
}

/**
 * Empty one root's trash.
 * @param request - root key.
 * @returns how many entries were removed.
 */
async function emptyTrash(ctx, request) {
  const root = await findRoot(ctx, request.rootKey)
  if (root === undefined) return { ok: false, code: 'unknown-root', message: 'That root is not one this plugin manages.' }
  const trash = join(root.path, TRASH_DIR)
  const entries = await readdir(trash).catch(() => undefined)
  if (entries === undefined) return { ok: true, rootKey: root.key, removed: 0 }
  for (const entry of entries) await rm(join(trash, entry), { recursive: true, force: true })
  return { ok: true, rootKey: root.key, removed: entries.length }
}

/**
 * Create a new skill bundle from the form fields.
 *
 * A name that already exists as an enabled, disabled or trashed entry is
 * refused instead of overwritten: a create must never act as an import.
 *
 * @param request - root key and the new skill's fields.
 * @returns the created entry, or a typed failure.
 */
async function createSkill(ctx, request) {
  const root = await findRoot(ctx, request.rootKey)
  if (root === undefined) return { ok: false, code: 'unknown-root', message: 'That root is not one this plugin manages.' }
  const name = typeof request.name === 'string' ? request.name.trim() : ''
  if (!isSkillName(name)) {
    return { ok: false, code: 'bad-name', message: 'Use letters, digits, dots, dashes or underscores; start with a letter or digit.' }
  }
  const description = typeof request.description === 'string' ? request.description.trim() : ''
  if (description.length === 0) return { ok: false, code: 'bad-description', message: 'A description is required.' }

  const locations = entryLocations(root.path, name)
  const taken = await firstExisting([locations.enabled, locations.disabled, join(root.path, TRASH_DIR, name)])
  if (taken !== undefined) return { ok: false, code: 'conflict', message: `"${name}" already exists in this root.` }

  await mkdir(locations.enabled, { recursive: true })
  const text = composeSkillFile({
    name,
    description,
    whenToUse: typeof request.whenToUse === 'string' ? request.whenToUse : undefined,
    body: typeof request.body === 'string' ? request.body : undefined,
  })
  await writeFile(join(locations.enabled, SKILL_FILE), text, 'utf8')
  return { ok: true, rootKey: root.key, entryName: name }
}

/**
 * Install a skill from a directory on this machine.
 *
 * The source is copied, never moved: a user who points the picker at a
 * repository keeps the repository intact.
 *
 * @param request - root key, absolute source path and an optional rename.
 * @returns the installed entry, or a typed failure.
 */
async function importDirectory(ctx, request) {
  const root = await findRoot(ctx, request.rootKey)
  if (root === undefined) return { ok: false, code: 'unknown-root', message: 'That root is not one this plugin manages.' }
  if (typeof request.sourcePath !== 'string' || !request.sourcePath.startsWith('/')) {
    return { ok: false, code: 'bad-path', message: 'An absolute source directory is required.' }
  }
  const sourceFile = join(request.sourcePath, SKILL_FILE)
  const sourceInfo = await stat(sourceFile).catch(() => undefined)
  if (sourceInfo === undefined || !sourceInfo.isFile()) {
    return { ok: false, code: 'not-a-skill', message: `That directory has no ${SKILL_FILE}.` }
  }
  const text = await readFile(sourceFile, 'utf8')
  const described = describeSkill({ text, entryName: basename(request.sourcePath), entryKind: 'directory' })
  const name = typeof request.name === 'string' && request.name.trim().length > 0 ? request.name.trim() : described.name
  if (!isSkillName(name)) return { ok: false, code: 'bad-name', message: `"${name}" is not a usable skill name.` }

  const locations = entryLocations(root.path, name)
  const taken = await firstExisting([locations.enabled, locations.disabled, join(root.path, TRASH_DIR, name)])
  if (taken !== undefined) return { ok: false, code: 'conflict', message: `"${name}" already exists in this root.` }

  await mkdir(root.path, { recursive: true })
  await cp(request.sourcePath, locations.enabled, { recursive: true, errorOnExist: true, force: false })
  return { ok: true, rootKey: root.key, entryName: name }
}

/**
 * Install a skill from files the page read out of a folder or drop.
 *
 * Every path is relative to the new bundle; the caller cannot name a path
 * outside it because `resolveWithin` checks the joined result.
 *
 * @param request - root key, entry name and the file list.
 * @returns the installed entry, or a typed failure.
 */
async function importFiles(ctx, request) {
  const root = await findRoot(ctx, request.rootKey)
  if (root === undefined) return { ok: false, code: 'unknown-root', message: 'That root is not one this plugin manages.' }
  const name = typeof request.name === 'string' ? request.name.trim() : ''
  if (!isSkillName(name)) return { ok: false, code: 'bad-name', message: `"${name}" is not a usable skill name.` }
  if (!Array.isArray(request.files) || request.files.length === 0) {
    return { ok: false, code: 'bad-request', message: 'No files were supplied.' }
  }
  if (request.files.length > MAX_INSTALL_FILES) {
    return { ok: false, code: 'too-many-files', message: `At most ${MAX_INSTALL_FILES} files fit in one install.` }
  }

  const locations = entryLocations(root.path, name)
  const taken = await firstExisting([locations.enabled, locations.disabled, join(root.path, TRASH_DIR, name)])
  if (taken !== undefined) return { ok: false, code: 'conflict', message: `"${name}" already exists in this root.` }

  let total = 0
  const staged = []
  let hasSkillFile = false
  for (const file of request.files) {
    if (!isRecord(file) || typeof file.path !== 'string') {
      return { ok: false, code: 'bad-request', message: 'Each file needs a relative path.' }
    }
    const relative = file.path.replace(/^\.\//, '')
    const target = resolveWithin(locations.enabled, relative)
    if (target === undefined) return { ok: false, code: 'bad-path', message: `"${file.path}" leaves the skill directory.` }
    const content = typeof file.content === 'string' ? file.content : ''
    if (content.length > MAX_UPLOAD_BYTES) {
      return { ok: false, code: 'too-large', message: `"${file.path}" is larger than ${MAX_UPLOAD_BYTES} bytes.` }
    }
    total += content.length
    if (total > MAX_INSTALL_BYTES) {
      return { ok: false, code: 'too-large', message: `The payload is larger than ${MAX_INSTALL_BYTES} bytes.` }
    }
    if (relative === SKILL_FILE) hasSkillFile = true
    staged.push({ target, content })
  }
  if (!hasSkillFile) {
    return { ok: false, code: 'not-a-skill', message: `The selection has no ${SKILL_FILE} at its root.` }
  }

  try {
    await mkdir(locations.enabled, { recursive: true })
    for (const file of staged) {
      await mkdir(dirname(file.target), { recursive: true })
      await writeFile(file.target, file.content, 'utf8')
    }
  } catch (error) {
    await rm(locations.enabled, { recursive: true, force: true })
    throw error
  }
  return { ok: true, rootKey: root.key, entryName: name }
}

/**
 * Show one path in the platform file manager.
 * @param path - an absolute path inside a managed root.
 * @returns whether the platform accepted the request.
 */
function revealPath(path) {
  return new Promise((resolve) => {
    const [command, args] =
      process.platform === 'darwin'
        ? ['open', ['-R', path]]
        : process.platform === 'win32'
          ? ['explorer', [`/select,${path}`]]
          : ['xdg-open', [dirname(path)]]
    execFile(command, args, { windowsHide: true, timeout: 5_000 }, (error) => resolve(error === null))
  })
}

/**
 * Compose the answer to one `list` request.
 * @param ctx - Host context.
 * @returns every managed root with its skills and its trash.
 */
async function listEverything(ctx) {
  const workspaces = workspaceList(ctx)
  const roots = await listRoots({ dshHome: dshHome(), agentsHome: agentsHome(), workspaces })
  const answers = []
  const warnings = []
  for (const root of roots) {
    const scanned = await scanRoot(root)
    warnings.push(...(scanned.warnings ?? []))
    const trashEntries = await readdir(join(root.path, TRASH_DIR)).catch(() => [])
    const trash = []
    for (const entryName of trashEntries) {
      if (entryName.startsWith('.') || !isSkillName(entryName)) continue
      const base = join(root.path, TRASH_DIR, entryName)
      const info = await stat(base).catch(() => undefined)
      if (info === undefined) continue
      let name = entryName
      try {
        if (info.isDirectory()) {
          const text = await readFile(join(base, SKILL_FILE), 'utf8')
          name = describeSkill({ text, entryName, entryKind: 'directory' }).name
        }
      } catch {
        /* Keep the on-disk name. */
      }
      trash.push({ entryName, name, kind: info.isDirectory() ? 'directory' : 'file' })
    }
    answers.push({
      key: root.key,
      kind: root.kind,
      source: root.source,
      path: root.path,
      workspacePath: root.workspacePath,
      workspaceTitle: root.workspaceTitle,
      exists: scanned.exists,
      skills: scanned.skills.map((skill) => ({ ...skill, rootKey: root.key })),
      trash,
    })
  }
  return { ok: true, roots: answers, warnings, home: dshHome(), agentsHome: agentsHome() }
}

/**
 * Dispatch one request body.
 * @param ctx - Host context.
 * @param body - the decoded request.
 * @returns the JSON answer.
 */
export async function dispatch(ctx, body) {
  if (!isRecord(body)) return { ok: false, code: 'bad-request', message: 'The body is not a JSON object.' }
  const request = body
  switch (request.action) {
    case 'list':
      return listEverything(ctx)
    case 'read':
      return readSkill(ctx, request)
    case 'set-disabled':
      return setDisabled(ctx, request)
    case 'trash':
      return moveToTrash(ctx, { ...request, restore: false })
    case 'restore':
      return moveToTrash(ctx, { ...request, restore: true })
    case 'purge':
      return purgeEntry(ctx, request)
    case 'empty-trash':
      return emptyTrash(ctx, request)
    case 'create':
      return createSkill(ctx, request)
    case 'import-directory':
      return importDirectory(ctx, request)
    case 'import-files':
      return importFiles(ctx, request)
    case 'reveal': {
      const root = await findRoot(ctx, request.rootKey)
      if (root === undefined) return { ok: false, code: 'unknown-root', message: 'That root is not one this plugin manages.' }
      const entry = typeof request.entryName === 'string' ? findEntry(root, request.entryName) : undefined
      const target = entry === undefined ? root.path : await firstExisting([entry.enabled, entry.disabled, join(root.path, TRASH_DIR, request.entryName)])
      if (target === undefined) return { ok: false, code: 'missing', message: 'That entry is not on disk any more.' }
      return { ok: await revealPath(target), path: target }
    }
    default:
      return { ok: false, code: 'unknown-action', message: `Unknown action "${String(request.action)}".` }
  }
}

/**
 * Mount the route.
 * @param ctx - Host context.
 */
export function apply(ctx) {
  ctx.effect(
    () =>
      ctx.connection.fetch.register({
        path: ROUTE,
        methods: ['POST'],
        requestBody: 'buffered',
        fetch: async (request) => {
          let body
          try {
            body = await request.json()
          } catch {
            return Response.json({ ok: false, code: 'bad-request', message: 'The body is not JSON.' }, { status: 400 })
          }
          try {
            const answer = await dispatch(ctx, body)
            return Response.json(answer, { headers: { 'cache-control': 'no-store' } })
          } catch (error) {
            return Response.json(
              { ok: false, code: 'handler-error', message: error instanceof Error ? error.message : String(error) },
              { status: 500 },
            )
          }
        },
      }),
    'dsh-skills: route',
  )
}

/** Exported for the verification harness; not part of the plugin surface. */
export const internals = { dshHome, agentsHome, workspaceList, findRoot, findEntry, locateSkill }

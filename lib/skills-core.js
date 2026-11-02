/**
 * DSH Skills — filesystem core.
 *
 * Everything this plugin knows about a skill comes from disk: DSH loads a
 * skill as a directory bundle `<name>/SKILL.md` or a flat `<name>.md` at the
 * top level of a scanned root (`dsh-skill-filesystem`). This module owns that
 * grammar — root discovery, frontmatter parsing, entry scanning and the path
 * arithmetic every mutation goes through — so the Host route and the tests
 * share one definition of "a skill".
 *
 * Disabling never edits a skill's bytes. DSH has no per-skill switch, but it
 * only discovers direct children of a root, so a bundle moved into
 * `<root>/.disabled/` disappears from every provider's catalog and moves back
 * unchanged when it is enabled again.
 *
 * @module dsh-skills/core
 */

import { readdir, readFile, stat } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'

/** The instruction file of a directory-bundle skill. */
export const SKILL_FILE = 'SKILL.md'

/** Root-local directory holding disabled entries. Hidden, so never scanned. */
export const DISABLED_DIR = '.disabled'

/** Root-local directory holding uninstalled entries. Hidden, so never scanned. */
export const TRASH_DIR = '.trash'

/** Bytes of one skill body the route is willing to return for preview. */
export const MAX_SKILL_BYTES = 512 * 1024

/** Bytes of one instruction file the scanner is willing to read at all. */
export const MAX_SCAN_BYTES = 2 * 1024 * 1024

/** Bytes of one uploaded skill file accepted by install. */
export const MAX_UPLOAD_BYTES = 1024 * 1024

/** Bytes of one whole install payload accepted by install. */
export const MAX_INSTALL_BYTES = 8 * 1024 * 1024

/** Files one install payload may carry. */
export const MAX_INSTALL_FILES = 200

/** The names DSH accepts for a skill, and the names this plugin will write. */
export const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

/** The four roots `dsh-skill-filesystem` scans, in the provider's rank order. */
export const ROOT_SOURCES = ['project-dsh', 'project-agents', 'user-dsh', 'user-agents']

/** The frontmatter booleans DSH accepts, keyed by their canonical spelling. */
const TRUE_WORDS = new Set(['true', 'yes', 'on', '1'])
const FALSE_WORDS = new Set(['false', 'no', 'off', '0'])

/** @returns whether `value` is a usable skill name for a new or moved entry. */
export function isSkillName(value) {
  return typeof value === 'string' && NAME_PATTERN.test(value)
}

/**
 * Resolve `relative` beneath `base` and refuse anything that escapes it.
 *
 * Every write, rename and delete in this plugin goes through here first, so a
 * crafted `../../` from the page can never address a file outside the root.
 *
 * @param base - the directory that must contain the result.
 * @param relative - a caller-supplied relative path.
 * @returns the absolute path, or undefined when it is not contained.
 */
export function resolveWithin(base, relative) {
  if (typeof relative !== 'string' || relative.length === 0) return undefined
  if (relative.includes('\0') || relative.includes('\\')) return undefined
  const root = resolve(base)
  const target = resolve(root, relative)
  if (target !== root && !target.startsWith(root + sep)) return undefined
  return target
}

/**
 * Read a frontmatter scalar.
 *
 * Handles the two quoted forms and the plain form, and drops a trailing `#`
 * comment only where YAML would treat it as one.
 *
 * @param raw - text after the colon.
 * @returns the scalar value.
 */
function scalar(raw) {
  const value = String(raw ?? '').trim()
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    try {
      return JSON.parse(value)
    } catch {
      return value.slice(1, -1)
    }
  }
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replace(/''/g, "'")
  }
  const comment = /\s#/.exec(value)
  return (comment === null ? value : value.slice(0, comment.index)).trim()
}

/**
 * Split an instruction file into its frontmatter block and body.
 *
 * @param text - the whole file.
 * @returns the frontmatter source (undefined when absent) and the body.
 */
export function splitFrontmatter(text) {
  const normalized = String(text ?? '').replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n')
  const lines = normalized.split('\n')
  if (lines.length === 0 || lines[0].trim() !== '---') return { frontmatter: undefined, body: normalized }
  for (let index = 1; index < lines.length; index += 1) {
    if (lines[index].trim() === '---') {
      return { frontmatter: lines.slice(1, index).join('\n'), body: lines.slice(index + 1).join('\n') }
    }
  }
  return { frontmatter: undefined, body: normalized }
}

/**
 * Parse the frontmatter keys this plugin reports and DSH reads.
 *
 * Nested maps (`metadata:`) and lists are skipped: neither affects discovery,
 * invocation policy or the preview, and inventing a YAML parser here would
 * guess wrong on documents DSH itself accepts.
 *
 * @param text - the whole instruction file.
 * @returns the parsed fields plus the body and whether frontmatter existed.
 */
export function parseFrontmatter(text) {
  const split = splitFrontmatter(text)
  if (split.frontmatter === undefined) return { present: false, data: {}, body: split.body }
  const lines = split.frontmatter.split('\n')
  const data = {}
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    if (line.trim().length === 0 || line.trim().startsWith('#')) continue
    if (/^\s/.test(line)) continue
    const match = /^([A-Za-z0-9_.-]+)\s*:\s*(.*)$/.exec(line)
    if (match === null) continue
    const key = match[1]
    const raw = match[2]
    if (raw === '|' || raw === '>' || raw === '|-' || raw === '>-' || raw === '|+' || raw === '>+') {
      const collected = []
      index += 1
      while (index < lines.length && (lines[index].trim() === '' || /^\s/.test(lines[index]))) {
        collected.push(lines[index].replace(/^ {1,4}/, ''))
        index += 1
      }
      index -= 1
      data[key] = raw.startsWith('|') ? collected.join('\n').trim() : collected.join(' ').replace(/\s+/g, ' ').trim()
      continue
    }
    if (raw.trim().length === 0) {
      // A nested block such as `metadata:`; the keys inside it are not reported.
      data[key] = undefined
      continue
    }
    data[key] = scalar(raw)
  }
  return { present: true, data, body: split.body }
}

/**
 * Read one of DSH's boolean frontmatter flags.
 *
 * The provider rejects a document whose flag is not one of the accepted
 * spellings rather than silently permitting the surface, so an unreadable flag
 * is reported as invalid instead of `false`.
 *
 * @param raw - the raw frontmatter value.
 * @returns the boolean, undefined when absent, or 'invalid'.
 */
export function readFlag(raw) {
  if (raw === undefined || raw === null || raw === '') return undefined
  const word = String(raw).trim().toLowerCase()
  if (TRUE_WORDS.has(word)) return true
  if (FALSE_WORDS.has(word)) return false
  return 'invalid'
}

/**
 * Build the skill record the page renders from one instruction file's text.
 *
 * @param input - the file text, the filesystem entry name, and where it lives.
 * @returns the skill record, including any discovery issue codes.
 */
export function describeSkill(input) {
  const { text, entryName, entryKind, file, path: entryPath, size, updatedAt, disabled, name: fallbackName } = input
  const parsed = parseFrontmatter(text)
  const data = parsed.data
  const issues = []
  if (!parsed.present) issues.push('missing-frontmatter')

  const frontmatterName = typeof data.name === 'string' && data.name.trim().length > 0 ? data.name.trim() : ''
  const name = frontmatterName.length > 0 ? frontmatterName : fallbackName || entryName
  if (frontmatterName.length === 0) issues.push('missing-name')

  const description = typeof data.description === 'string' ? data.description.trim() : ''
  if (description.length === 0) issues.push('missing-description')

  const whenToUse = typeof data.whenToUse === 'string' ? data.whenToUse.trim() : ''
  const disableModel = readFlag(data['disable-model-invocation'] ?? data.disableModelInvocation)
  const userInvocableFlag = readFlag(data['user-invocable'] ?? data.userInvocable)
  if (disableModel === 'invalid' || userInvocableFlag === 'invalid') issues.push('invalid-flag')

  return {
    name,
    entryName,
    entryKind,
    description,
    whenToUse,
    file,
    path: entryPath,
    disabled: disabled === true,
    modelInvocable: disableModel !== true && disableModel !== 'invalid',
    userInvocable: userInvocableFlag !== false && userInvocableFlag !== 'invalid',
    issues,
    size: typeof size === 'number' ? size : 0,
    updatedAt: typeof updatedAt === 'string' ? updatedAt : undefined,
    body: input.includeBody === true ? parsed.body : undefined,
  }
}

/** @returns whether a directory exists. */
async function directoryExists(path) {
  try {
    const info = await stat(path)
    return info.isDirectory()
  } catch {
    return false
  }
}

/** @returns one file's text, capped, or undefined when unreadable. */
async function readSkillText(file) {
  try {
    const info = await stat(file)
    if (!info.isFile() || info.size > MAX_SCAN_BYTES) return undefined
    return { text: await readFile(file, 'utf8'), size: info.size, updatedAt: info.mtime.toISOString() }
  } catch {
    return undefined
  }
}

/**
 * Read one candidate entry (a directory bundle or a flat `.md` file).
 *
 * @param entryPath - absolute path of the entry.
 * @param kind - whether that entry is a directory or a file.
 * @param options - the entry name, the disabled flag and a name fallback.
 * @returns the skill record, or undefined when the entry is not a skill.
 */
async function readEntry(entryPath, kind, options) {
  const file = kind === 'directory' ? join(entryPath, SKILL_FILE) : entryPath
  const read = await readSkillText(file)
  if (read === undefined) return undefined
  const fallbackName = options.entryName.toLowerCase().endsWith('.md')
    ? options.entryName.slice(0, -3)
    : options.entryName
  return describeSkill({
    text: read.text,
    entryName: options.entryName,
    entryKind: kind,
    file,
    path: entryPath,
    size: read.size,
    updatedAt: read.updatedAt,
    disabled: options.disabled,
    name: fallbackName,
  })
}

/**
 * List the skills in one root, enabled and disabled.
 *
 * Only direct children are considered, matching the provider: a nested
 * `**​/SKILL.md` is deliberately invisible, which is also why `.disabled`
 * removes a skill from the catalog.
 *
 * @param root - a root from `listRoots`.
 * @returns the root's existence, its skills and any unreadable entries.
 */
export async function scanRoot(root) {
  let entries
  try {
    entries = await readdir(root.path, { withFileTypes: true })
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return { exists: false, skills: [], warnings: [] }
    throw error
  }

  const skills = []
  const warnings = []
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue
    const kind = entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : undefined
    if (kind === undefined) continue
    if (kind === 'file' && !entry.name.toLowerCase().endsWith('.md')) continue
    try {
      const skill = await readEntry(join(root.path, entry.name), kind, { entryName: entry.name, disabled: false })
      if (skill !== undefined) skills.push(skill)
    } catch (error) {
      warnings.push({ code: 'entry-failed', root: root.key, entry: entry.name, message: String(error?.message ?? error) })
    }
  }

  const disabledPath = join(root.path, DISABLED_DIR)
  let disabledEntries = []
  try {
    disabledEntries = await readdir(disabledPath, { withFileTypes: true })
  } catch {
    disabledEntries = []
  }
  for (const entry of disabledEntries) {
    if (entry.name.startsWith('.')) continue
    const kind = entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : undefined
    if (kind === undefined) continue
    if (kind === 'file' && !entry.name.toLowerCase().endsWith('.md')) continue
    try {
      const skill = await readEntry(join(disabledPath, entry.name), kind, { entryName: entry.name, disabled: true })
      if (skill !== undefined) skills.push(skill)
    } catch (error) {
      warnings.push({ code: 'entry-failed', root: root.key, entry: entry.name, message: String(error?.message ?? error) })
    }
  }

  skills.sort((left, right) => left.name.localeCompare(right.name))
  return { exists: true, skills, warnings }
}

/**
 * The roots this plugin manages, in DSH's provider rank order.
 *
 * The two user roots are the DSH home and the agents home themselves, each
 * plus `skills`. They are NOT derived from `os.homedir()` here: `DSH_HOME`
 * already names the `.dsh` directory, so joining `.dsh` onto it again produced
 * `~/.dsh/.dsh/skills` — a directory DSH never scans, which is how an installed
 * skill could land somewhere invisible.
 *
 * User roots are always listed, so a fresh machine can install into them.
 * Project roots appear only when the workspace already carries that directory:
 * the page is a manager of installed skills, not a scanner of every workspace.
 *
 * @param input - the DSH home, the agents home and the registered workspaces.
 * @returns the root records, without scanning them.
 */
export async function listRoots(input) {
  const { dshHome, agentsHome, workspaces } = input
  const roots = [
    { key: 'user-dsh', kind: 'user', source: 'user-dsh', path: join(dshHome, 'skills') },
    { key: 'user-agents', kind: 'user', source: 'user-agents', path: join(agentsHome, 'skills') },
  ]
  const seen = new Set()
  for (const workspace of workspaces) {
    if (typeof workspace?.path !== 'string' || workspace.path.length === 0) continue
    const candidates = [
      { key: `project-dsh:${workspace.path}`, kind: 'project', source: 'project-dsh', path: join(workspace.path, '.dsh', 'skills'), workspacePath: workspace.path, workspaceTitle: workspace.title },
      { key: `project-agents:${workspace.path}`, kind: 'project', source: 'project-agents', path: join(workspace.path, '.agents', 'skills'), workspacePath: workspace.path, workspaceTitle: workspace.title },
    ]
    for (const candidate of candidates) {
      if (seen.has(candidate.path)) continue
      seen.add(candidate.path)
      if (!(await directoryExists(candidate.path))) continue
      roots.push(candidate)
    }
  }
  return roots
}

/**
 * Compose the `---` block for a skill this plugin creates.
 *
 * @param input - the fields to write.
 * @returns the instruction file text.
 */
export function composeSkillFile(input) {
  const lines = ['---', `name: ${input.name}`, `description: ${frontmatterString(input.description)}`]
  if (typeof input.whenToUse === 'string' && input.whenToUse.trim().length > 0) {
    lines.push(`whenToUse: ${frontmatterString(input.whenToUse)}`)
  }
  lines.push('---', '')
  const body = typeof input.body === 'string' ? input.body.trim() : ''
  lines.push(body.length > 0 ? body : `# ${input.name}`, '')
  return lines.join('\n')
}

/** @returns a frontmatter-safe scalar for the composed file. */
function frontmatterString(value) {
  const text = String(value ?? '').replace(/\r?\n/g, ' ').trim()
  return /^[A-Za-z0-9][^:#]*$/.test(text) && !text.includes(' #') ? text : JSON.stringify(text)
}

/**
 * The two filesystem locations one entry can occupy in a root.
 *
 * @param rootPath - the root directory.
 * @param entryName - the entry name on disk (`SKILL.md` bundles use the folder).
 * @returns the enabled and disabled absolute paths.
 */
export function entryLocations(rootPath, entryName) {
  return {
    enabled: join(rootPath, entryName),
    disabled: join(rootPath, DISABLED_DIR, entryName),
  }
}

---
description: "Skills manager for the DSH Web UI: a Skills panel in the left navigation that lists every installed Agent Skill, previews its instructions, enables or disables it, installs one from a folder, and restores what was uninstalled."
kind: "plugin-readme"
---

# dsh-skills

English | [中文](README.zh.md)

A **技能 / Skills** row in the DeepSeek Harness left navigation, and the page it opens.

DSH discovers Agent Skills from `.dsh/skills` and `.agents/skills` — under your
home and under a project — but ships no surface for seeing what is installed or
for turning one off without editing files. This plugin adds that surface.

## What the panel does

| | |
|---|---|
| **See everything** | Every root DSH scans, with each skill's name, description, instruction path and invocation policy. |
| **Preview** | The full `SKILL.md`, frontmatter and body, without leaving the app. |
| **Enable / disable** | A switch per skill. Disabled skills keep their bytes and stay on disk. |
| **Install** | Copy a folder that has `SKILL.md` at its top level into the root you pick. The original is never moved. |
| **New skill** | Write a bundle with a valid frontmatter block from a form. |
| **Uninstall safely** | Uninstall moves the entry to a root-local `.trash`; restore it later, or delete it for good. |
| **Locate** | Reveal a skill or a root in Finder / Explorer / the desktop file manager. |
| **Known libraries** | Codex, Claude Code, WorkBuddy and CodeBuddy keep their skills in well-known places; those that exist are listed automatically, each with that agent's mark. |
| **Add a directory** | Point the panel at another agent's skill library — `~/.claude/skills`, a colleague's checkout, a shared bundle. Its skills are listed, and DSH loads them too. The directory itself stays read-only. |

## Install

**From GitHub.** This repository is a ready-to-install package: `package.json`
sits at the root and there is no build step, so any npm-compatible git spec
resolves. In the plugin manager (Settings → Plugins), install:

```
github:yixin2021/dsh-skills
```

The same spec works from the CLI — `dsh plugin` forwards its arguments to pnpm
inside the profile:

```sh
dsh plugin --profile desktop add github:yixin2021/dsh-skills
dsh plugin --profile desktop remove dsh-skills
```

`https://github.com/yixin2021/dsh-skills` and
`git+ssh://git@github.com/yixin2021/dsh-skills.git` are equivalent.

**From a local checkout.**

```sh
dsh plugin --profile desktop add /absolute/path/to/dsh-skills
```

The bundle patch inserts one Loader row named `skills`; the client half mounts
the navigation row and the panel. Reload the window after installing.

## How it works

**Host half** (`index.js`) registers one authenticated JSON route,
`POST /api/dsh-skills`, on `ctx.connection.fetch`. It answers `list`, `read`,
`set-disabled`, `trash`, `restore`, `purge`, `empty-trash`, `create`,
`import-directory`, `import-files`, `reveal`, `add-root` and `remove-root`. `ctx.skills.registerProvider` publishes the
discovered libraries and the added directories to the model. `lib/skills-core.js` owns the
skill grammar — frontmatter parsing, root discovery, entry scanning — so the
route and the tests agree on what a skill is.

**Client half** (`client.js`) registers a `sidebar.panellist` icon under the id
`dsh-skills` and the `main` panel keyed by that same id, which is how the layout
addresses a panel. It never reads a skill root itself: every fact arrives
through the route, so the browser has no filesystem authority.

### Disabling without deleting

DSH only discovers *direct children* of a skill root. A disabled skill is moved
to `<root>/.disabled/<name>` — hidden, therefore invisible to every provider —
and moved back untouched when re-enabled. Nothing in `SKILL.md` is rewritten,
so a hand-written skill survives a round trip byte for byte. The same trick
backs `.trash`.

### Known agent libraries

Five libraries are found on their own, so a machine that already runs another
coding agent needs no configuration. This is the order the page lists them in:

| Mark | Library | Path |
|---|---|---|
| DeepSeek | DeepSeek Harness | `$DSH_HOME/skills` (usually `~/.dsh/skills`) |
| DeepSeek | Agents | `$DSH_AGENTS_HOME/skills` (usually `~/.agents/skills`) |
| Codex | Codex | `$CODEX_HOME/skills` (usually `~/.codex/skills`) |
| Claude Code | Claude Code | `$CLAUDE_CONFIG_DIR/skills` (usually `~/.claude/skills`) |
| WorkBuddy | WorkBuddy | `$WORKBUDDY_HOME/skills` (usually `~/.workbuddy/skills`) |
| CodeBuddy | CodeBuddy | `$CODEBUDDY_HOME/skills` (usually `~/.codebuddy/skills`) |

Discovery runs on every read rather than being remembered, so installing
another agent later just works, and deleting a library removes it from the
list. These libraries are read-only for the same reason added directories are:
DSH does not own those bytes.

The marks are the vendors' own, taken from published brand assets rather than
drawn here: the DeepSeek whale (`deepseek.svg` from simple-icons), the OpenAI
knot and the Claude asterisk (`openai.svg`, `claude.svg` from
`@lobehub/icons-static-svg`), and the official `logo.svg` tiles served by
codebuddy.ai and workbuddy.cn. The monochrome ones inherit `currentColor` so
they follow the theme; the two tiles keep their own gradients. Brand marks
belong to their owners and identify the directory the skills came from.

### Added directories

DSH scans four roots and no others, so the plugin registers its own skill
provider (`ctx.skills.registerProvider`) that serves the added directories with
`source: 'custom'` — the label DSH reserves for exactly this. The model sees
those skills in its catalog, with the invocation policy from each frontmatter,
and a symlinked bundle counts as a skill (Claude Code and stow both link rather
than copy). Adding or removing a directory invalidates the catalog, so the next
model step sees the change without a restart.

The directories themselves stay **read-only** in the panel: no enable/disable,
no uninstall, no create, and never an install target. DSH does not own those
bytes, and a switch there would edit another tool's library. "Install…" copies
a skill into a root DSH does own. The Host refuses mutations with
`code: 'read-only'`, so the rule does not depend on the page behaving.

The list lives in `$DSH_HOME/skills-roots.json` — beside the skills rather than
inside a profile, so it survives a profile rebuild and is shared by the web and
desktop apps. A malformed file is read as an empty list; adding a directory
rewrites it. Keys are hashed from the path, so removing one directory never
re-points another's filter.

### Scoping

All writes go through `resolveWithin`, which refuses a path that leaves its
root. Skill names match `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`; a requested entry
must already exist where the request claims it does; a create or install
refuses to overwrite an existing enabled, disabled or trashed entry.

## UI conventions

- Only Host theme tokens (`--dsw-alias-*`) are used — no hard-coded palette, so
  light and dark themes both work.
- Every visible string goes through `ctx.locale.register` / `ctx.locale.bind`
  with a `zh` and an `en` dictionary; the row's label is a locale-aware
  function, not a captured string.
- `React` here is the shell's curated object, which exposes only
  `createElement`, `useState` and `useEffect`. The panel uses exactly those
  three: anything else — `useSyncExternalStore`, `useRef`, `memo` — is
  `undefined` and throws at render, which blanks the panel.
- No Harness Client package is imported. Every control is a plain element
  styled from tokens, so the panel cannot break on a missing primitive module
  or an invented prop name.
- Dialogs are announced as `role="dialog"` / `aria-modal`, close on Escape and
  on a backdrop click, and the enable/disable control is a real checkbox with
  an accessible name.
- No DOM outside the panel is touched, and nothing is appended to
  `document.body` except the transient folder-picker input, which is removed
  as soon as the picker closes.

## Tests

```sh
npm test
```

Runs `node --check` on all three sources, then 25 filesystem tests over a real
temporary tree: frontmatter parsing (quoted scalars, comments, block scalars,
invalid flag spellings), path containment, root discovery, direct-children-only
scanning, and every mutation including the refusals.

## Known limits

- Binaries are not carried by `import-files`, since the route transports text;
  use `import-directory` or copy assets into the bundle afterwards.
- A skill stored outside the four roots DSH scans is not listed, because DSH
  would not load it either.
- The panel shows what a root holds now; it does not watch the filesystem, so
  use the reload control after editing files on disk.

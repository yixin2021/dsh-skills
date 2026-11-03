/**
 * DSH Skills — Client half.
 *
 * Two surfaces over one store:
 *   - a Skills row in the left navigation (`sidebar.panellist`), whose label is
 *     localized and whose selected state comes from the layout owner,
 *   - the page that row opens (`main`, keyed by the same id), listing every
 *     managed root with its skills, enabling and disabling them, previewing an
 *     instruction file, creating a new skill, installing one from disk or from
 *     a remote repository, and restoring or purging what was uninstalled.
 *
 * The page never reads a skill root itself: every fact comes from this
 * package's own Host route, so the browser has no filesystem authority.
 *
 * Two deliberate constraints, both learned from the empty-panel failure:
 *   - No `locale` registration option. The injected `t` seat only exists for
 *     namespaces merged into `LocaleNamespaceMap`, which a third-party plugin is
 *     not, so this half binds its own dictionaries and passes no `locale` key.
 *   - No `useSyncExternalStore`. A store subscription built from `useState` and
 *     `useEffect` works on every React the shell may ship, and a render that
 *     throws here is caught and shown rather than leaving a blank column.
 *
 * @module dsh-skills/client
 */

window.__ModuleLoader__.load({
  id: 'dsh-skills',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /** Authenticated Host route, relative to the page origin. */
    const ROUTE = 'api/dsh-skills'

    /** The one id that ties the navigation row to the panel it opens. */
    const PANEL_ID = 'dsh-skills'

    /** How many rows are painted before search must narrow the list. */
    const RENDER_LIMIT = 80

    /**
     * The mounted scroll region and its fade-out timer.
     *
     * One panel instance exists per page, and the scroll handler must outlive
     * the render that registered it, so the node and timer are module state
     * rather than a hook that would restart on every paint.
     */
    let scrollNode = null
    let scrollTimer = 0

    /** @type {Record<string, string>} */
    const EN = {
      'title': 'Skills',
      'subtitle': '{total} skills across {roots} roots, {enabled} enabled.',
      'search.placeholder': 'Search skills',
      'search.label': 'Search skills',
      'action.create': 'New skill',
      'action.install': 'Install from folder',
      'action.importRemote': 'Import from GitHub',
      'action.reload': 'Reload',
      'action.reloading': 'Reloading…',
      'meta.refreshed': 'Last read {time}',
      'action.reveal': 'Show in file manager',
      'action.revealShort': 'Show',
      'action.revealFolder': 'Open folder',
      'action.uninstall': 'Move to trash',
      'action.uninstallShort': 'Uninstall',
      'action.restore': 'Restore',
      'action.purge': 'Delete',
      'action.emptyTrash': 'Empty trash',
      'action.close': 'Close',
      'action.cancel': 'Cancel',
      'action.preview': 'Preview instructions',
      'filter.all': 'All roots',
      'root.project': 'Project · {name}',
      'root.dsh': 'DeepSeek Harness',
      'root.agents': 'Agents',
      'root.custom': 'Added · {name}',
      'agent.dsh': 'DSH',
      'agent.codex': 'Codex',
      'agent.codebuddy': 'CodeBuddy',
      'agent.claude': 'Claude Code',
      'agent.workbuddy': 'WorkBuddy',
      'chip.auto': 'Auto',
      'chip.readOnly': 'Read only',
      'action.addRoot': 'Add directory',
      'action.remove': 'Remove',
      'action.installTo': 'Install…',
      'addRoot.title': 'Add a skill directory',
      'addRoot.subtitle': 'Point at another agent\'s skill library',
      'addRoot.label': 'Directory path',
      'addRoot.placeholder': '~/.claude/skills',
      'addRoot.hint':
        'DSH loads skills from this directory through this plugin. The directory is not DSH-owned, so there is no switch here; use "Install…" to copy a skill into a root DSH owns.',
      'addRoot.add': 'Add',
      'install.source': 'Source',
      'install.from': 'Copied from {path}',
      'notice.rootAdded': 'Added {path}',
      'notice.rootRemoved': 'Removed {path} from the list',
      'error.rootPath': 'That path is not a directory.',
      'status.enabled': 'Enabled',
      'status.disabled': 'Disabled',
      'chip.disabled': 'off',
      'chip.userOnly': 'user only',
      'chip.invalid': 'invalid flag',
      'field.description': 'Description',
      'field.whenToUse': 'When to use',
      'field.invocation': 'Invocation',
      'field.status': 'Status',
      'invocation.model': 'model may load it',
      'invocation.userOnly': 'model-hidden',
      'invocation.slash': '/name available',
      'invocation.noSlash': 'not in / menu',
      'value.none': '—',
      'value.optional': 'Optional',
      'value.noDescription': 'No description in the frontmatter.',
      'loading.page': 'Reading skill roots…',
      'loading.body': 'Reading the instruction file…',
      'empty.title': 'No skills yet',
      'empty.body': 'Install a folder that contains SKILL.md, import skills from GitHub, or write one with New skill. Disabled skills stay on disk under .disabled and disappear from every catalog.',
      'empty.noMatch': 'No skill matches that search.',
      'empty.rootEmpty': 'This root has no skills yet.',
      'empty.rootMissing': 'This root does not exist yet. Create a skill to create it.',
      'list.limit': 'Showing the first {count} rows. Narrow the search to see the rest.',
      'trash.title': 'Uninstalled ({count})',
      'trash.label': 'in trash',
      'create.title': 'New skill',
      'create.subtitle': 'A bundle with a SKILL.md, created in the root you choose.',
      'create.root': 'Root',
      'create.name': 'Name',
      'create.description': 'Description',
      'create.descriptionPlaceholder': 'What this skill does, in one line.',
      'create.whenToUse': 'When to use',
      'create.body': 'Instructions',
      'create.bodyPlaceholder': 'Markdown instructions the model follows once the skill is loaded.',
      'create.submit': 'Create skill',
      'install.title': 'Install a skill',
      'install.subtitle': 'Pick a folder that contains SKILL.md at its top level.',
      'install.pick': 'Choose folder',
      'install.hint': 'The folder is copied into the root; the original stays where it is. Its name comes from the frontmatter, or from the folder name.',
      'install.noTarget': 'There is no writable root to copy into. Open a workspace, or create ~/.dsh/skills, and try again.',
      'remote.title': 'Import skills from GitHub',
      'remote.subtitle': 'Paste a GitHub repository or skill link.',
      'remote.url': 'GitHub link',
      'remote.urlPlaceholder': 'https://github.com/owner/repo',
      'remote.token': 'Access token',
      'remote.tokenPlaceholder': 'Optional · for a private repository',
      'remote.tokenHint': 'The token is used only to read this source. It is never written to disk or included in the command line.',
      'remote.root': 'Root',
      'remote.submit': 'Scan GitHub',
      'remote.importSelected': 'Import selected ({count})',
      'remote.selectAll': 'Select all',
      'remote.clearSelection': 'Clear selection',
      'remote.reading': 'Reading GitHub…',
      'remote.hint': 'GitHub is read as an archive. Repository contents are read as files; nothing is run.',
      'remote.choose': 'Select the skills to import.',
      'remote.truncated': 'Showing {shown} of {total} skills. Paste a link to a subdirectory to narrow the results.',
      'remote.change': 'Use another link',
      'remote.noTarget': 'There is no writable root to import into. Open a workspace, or create ~/.dsh/skills, and try again.',
      'notice.enabled': '{name} is enabled.',
      'notice.disabled': '{name} is disabled and hidden from every catalog.',
      'notice.trashed': '{name} moved to the trash. Restore it from the root card.',
      'notice.restored': '{name} is restored.',
      'notice.purged': '{name} is permanently deleted.',
      'notice.trashEmptied': 'Removed {count} entries from the trash.',
      'notice.created': '{name} was created.',
      'notice.installed': '{name} was installed.',
      'notice.imported': 'Imported {count} skill(s) from {source}: {name}.',
      'error.generic': 'The Host rejected that request.',
      'error.noSkillFile': 'That folder has no SKILL.md at its top level.',
      'error.revealFailed': 'Could not open that path.',
      'error.render': 'The Skills panel failed to render.',
    }

    /** @type {Record<string, string>} */
    const ZH = {
      'title': '技能',
      'subtitle': '共 {total} 个技能，分布在 {roots} 个根目录，其中 {enabled} 个已启用。',
      'search.placeholder': '搜索技能',
      'search.label': '搜索技能',
      'action.create': '新建技能',
      'action.install': '从文件夹安装',
      'action.importRemote': '从 GitHub 导入',
      'action.reload': '刷新',
      'action.reloading': '刷新中…',
      'meta.refreshed': '最后读取 {time}',
      'action.reveal': '在文件管理器中显示',
      'action.revealShort': '定位',
      'action.revealFolder': '打开目录',
      'action.uninstall': '移入回收站',
      'action.uninstallShort': '卸载',
      'action.restore': '恢复',
      'action.purge': '彻底删除',
      'action.emptyTrash': '清空回收站',
      'action.close': '关闭',
      'action.cancel': '取消',
      'action.preview': '查看技能说明',
      'filter.all': '全部目录',
      'root.project': '项目 · {name}',
      'root.dsh': 'DeepSeek Harness',
      'root.agents': 'Agents',
      'root.custom': '自定义 · {name}',
      'agent.dsh': 'DSH',
      'agent.codex': 'Codex',
      'agent.codebuddy': 'CodeBuddy',
      'agent.claude': 'Claude Code',
      'agent.workbuddy': 'WorkBuddy',
      'chip.auto': '自动',
      'chip.readOnly': '只读',
      'action.addRoot': '添加目录',
      'action.remove': '移除',
      'action.installTo': '安装…',
      'addRoot.title': '添加技能目录',
      'addRoot.subtitle': '指向另一个 agent 的技能库',
      'addRoot.label': '目录路径',
      'addRoot.placeholder': '~/.claude/skills',
      'addRoot.hint':
        'DSH 会通过本插件加载这里面的技能。目录不归 DSH 管，所以这里没有启用/停用开关；点技能上的「安装…」可复制到 DSH 自己的目录。',
      'addRoot.add': '添加',
      'install.source': '来源',
      'install.from': '来自 {path}',
      'notice.rootAdded': '已添加 {path}',
      'notice.rootRemoved': '已从列表移除 {path}',
      'error.rootPath': '该路径不是一个目录。',
      'status.enabled': '已启用',
      'status.disabled': '已停用',
      'chip.disabled': '停用',
      'chip.userOnly': '仅手动',
      'chip.invalid': '标记非法',
      'field.description': '描述',
      'field.whenToUse': '使用时机',
      'field.invocation': '调用方式',
      'field.status': '状态',
      'invocation.model': '模型可自动加载',
      'invocation.userOnly': '模型不可见',
      'invocation.slash': '可用 /名称',
      'invocation.noSlash': '不在 / 菜单',
      'value.none': '—',
      'value.optional': '可选',
      'value.noDescription': 'frontmatter 中没有描述。',
      'loading.page': '正在读取技能目录…',
      'loading.body': '正在读取技能文件…',
      'empty.title': '还没有技能',
      'empty.body': '安装一个包含 SKILL.md 的文件夹，从 GitHub 批量导入技能，或用「新建技能」写一个。停用的技能保留在磁盘的 .disabled 目录里，对所有目录不可见。',
      'empty.noMatch': '没有匹配的技能。',
      'empty.rootEmpty': '该目录还没有技能。',
      'empty.rootMissing': '该目录尚未创建，新建一个技能即可创建它。',
      'list.limit': '仅显示前 {count} 条，请用搜索缩小范围。',
      'trash.title': '已卸载（{count}）',
      'trash.label': '在回收站',
      'create.title': '新建技能',
      'create.subtitle': '在指定根目录中创建包含 SKILL.md 的技能包。',
      'create.root': '根目录',
      'create.name': '名称',
      'create.description': '描述',
      'create.descriptionPlaceholder': '一句话说明这个技能做什么。',
      'create.whenToUse': '使用时机',
      'create.body': '指令正文',
      'create.bodyPlaceholder': '技能加载后模型遵循的 Markdown 指令。',
      'create.submit': '创建技能',
      'install.title': '安装技能',
      'install.subtitle': '选择一个顶层包含 SKILL.md 的文件夹。',
      'install.pick': '选择文件夹',
      'install.hint': '该文件夹会被复制到根目录，原目录保持不动；技能名取自 frontmatter，缺省时用文件夹名。',
      'install.noTarget': '没有可写入的目录：打开一个工作区，或创建 ~/.dsh/skills 后再试。',
      'remote.title': '从 GitHub 导入技能',
      'remote.subtitle': '粘贴 GitHub 仓库或技能链接。',
      'remote.url': 'GitHub 链接',
      'remote.urlPlaceholder': 'https://github.com/owner/repo',
      'remote.token': '访问令牌',
      'remote.tokenPlaceholder': '可选 · 私有仓库需要',
      'remote.tokenHint': '令牌只用于读取当前来源：不会写入磁盘，也不会出现在命令行中。',
      'remote.root': '根目录',
      'remote.submit': '扫描 GitHub',
      'remote.importSelected': '导入已选（{count}）',
      'remote.selectAll': '全选',
      'remote.clearSelection': '清空选择',
      'remote.reading': '正在读取 GitHub…',
      'remote.hint': 'GitHub 仓库以压缩包读取，所有内容只作为文件读取，不会执行。',
      'remote.choose': '选择要导入的技能。',
      'remote.truncated': '当前显示 {shown}/{total} 个技能。可粘贴子目录链接缩小范围。',
      'remote.change': '换一个链接',
      'remote.noTarget': '没有可写入的目录：打开一个工作区，或创建 ~/.dsh/skills 后再试。',
      'notice.enabled': '已启用 {name}。',
      'notice.disabled': '已停用 {name}，它将从所有目录中隐藏。',
      'notice.trashed': '{name} 已移入回收站，可在对应根目录卡片中恢复。',
      'notice.restored': '已恢复 {name}。',
      'notice.purged': '已彻底删除 {name}。',
      'notice.trashEmptied': '已清空回收站中的 {count} 项。',
      'notice.created': '已创建 {name}。',
      'notice.installed': '已安装 {name}。',
      'notice.imported': '已从 {source} 导入 {count} 个技能：{name}。',
      'error.generic': '宿主拒绝了该请求。',
      'error.noSkillFile': '该文件夹顶层没有 SKILL.md。',
      'error.revealFailed': '无法打开该路径。',
      'error.render': '技能面板渲染失败。',
    }

    /** @param {...(string|false|null|undefined)} values @returns a class list. */
    function cx(...values) {
      return values.filter(Boolean).join(' ')
    }

    /** @returns whether `value` is a plain JSON object. */
    function isRecord(value) {
      return typeof value === 'object' && value !== null && !Array.isArray(value)
    }

    /**
     * Fill `{name}` placeholders in one translated line.
     * @param template - the dictionary line.
     * @param params - the values to substitute.
     * @returns the finished line.
     */
    function fill(template, params) {
      if (params === undefined) return template
      return template.replace(/\{(\w+)\}/g, (match, key) => (key in params ? String(params[key]) : match))
    }

    /**
     * Format a timestamp as a wall clock, for the "last read" stamp.
     * @param stamp - the millisecond timestamp.
     * @returns the local `HH:MM:SS`.
     */
    function formatClock(stamp) {
      const at = new Date(Number(stamp))
      // An unusable stamp must print nothing, never `NaN:NaN:NaN`.
      if (!Number.isFinite(at.getTime())) return ''
      const pad = (value) => String(value).padStart(2, '0')
      return `${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}`
    }

    /**
     * Pick the dictionary for the active language.
     *
     * The authority is the Host's own locale snapshot, never
     * `navigator.language`: this page runs inside the desktop shell, whose
     * Chromium locale stays at the OS/system value and does not follow the
     * language the Host actually renders in. Trusting navigator here is what
     * turned the whole panel English while the rest of the shell stayed
     * Chinese.
     *
     * Anything Chinese maps to this package's Chinese dictionary; every other
     * id falls back to English, which is where the Host's own fallback chain
     * terminates.
     *
     * @param locale - the Host locale service.
     * @returns the dictionary for the language the Host is rendering in.
     */
    function dictionaryFor(locale) {
      const read = () => {
        try {
          const active = String(locale?.getSnapshot?.()?.active ?? '')
          if (active.length > 0) return active
        } catch {
          /* fall through to the document, then to Chinese */
        }
        try {
          const declared = typeof document === 'undefined' ? '' : String(document.documentElement?.lang ?? '')
          if (declared.length > 0) return declared
        } catch {
          /* ignore */
        }
        return 'zh'
      }
      return read().toLowerCase().startsWith('zh') ? ZH : EN
    }

    /**
     * Resolve this package's route under the page's own base.
     *
     * DSH can be mounted behind a path prefix; a root-absolute URL would lose
     * it and reach the gateway's 404 instead of the Host.
     *
     * @returns the absolute URL.
     */
    function routeUrl() {
      const base = typeof document === 'undefined' ? undefined : document.baseURI
      if (typeof base !== 'string' || base.length === 0) return `/${ROUTE}`
      try {
        const url = new URL(base)
        if (!url.pathname.endsWith('/')) url.pathname += '/'
        return new URL(ROUTE, url.href).href
      } catch {
        return `/${ROUTE}`
      }
    }

    /**
     * Call the Host route; never throws.
     * @param body - the action and its fields.
     * @returns the decoded answer, or a typed transport failure.
     */
    async function callHost(body) {
      let response
      try {
        response = await fetch(routeUrl(), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        })
      } catch (error) {
        return { ok: false, code: 'network', message: String(error) }
      }
      let decoded
      try {
        decoded = await response.json()
      } catch {
        decoded = undefined
      }
      if (!isRecord(decoded)) {
        return { ok: false, code: 'http', message: `HTTP ${response.status} · ${routeUrl()}` }
      }
      return decoded
    }

    /**
     * The mark: a four-point spark, one silhouette at every size.
     *
     * Drawn in a 16-unit box and scaled, so the navigation glyph, the empty
     * state and `icon.svg` cannot drift apart. The points are long and the
     * waist is narrow, which stays readable at sixteen pixels where a shape
     * with detail turns into a smudge.
     */
    const SPARK = 'M8 1C8.35 1 8.62 1.24 8.7 1.57L9.35 4.2A3.6 3.6 0 0 0 11.8 6.65L14.43 7.3C14.76 7.38 15 7.65 15 8C15 8.35 14.76 8.62 14.43 8.7L11.8 9.35A3.6 3.6 0 0 0 9.35 11.8L8.7 14.43C8.62 14.76 8.35 15 8 15C7.65 15 7.38 14.76 7.3 14.43L6.65 11.8A3.6 3.6 0 0 0 4.2 9.35L1.57 8.7C1.24 8.62 1 8.35 1 8C1 7.65 1.24 7.38 1.57 7.3L4.2 6.65A3.6 3.6 0 0 0 6.65 4.2L7.3 1.57C7.38 1.24 7.65 1 8 1Z'

    /** The navigation glyph. */
    function SkillsGlyph({ size = 16 }) {
      return h(
        'svg',
        {
          viewBox: '0 0 16 16',
          width: size,
          height: size,
          fill: 'currentColor',
          'aria-hidden': true,
          focusable: 'false',
          style: { display: 'block' },
        },
        h('path', { d: SPARK }),
      )
    }

    /** The panel's own mark, used in the empty state. */
    function SkillsMark({ size = 40 }) {
      return h(
        'svg',
        {
          viewBox: '0 0 16 16',
          width: size,
          height: size,
          fill: 'currentColor',
          'aria-hidden': true,
          focusable: 'false',
          style: { display: 'block' },
        },
        h('path', { d: SPARK }),
      )
    }

    /** A small status chip beside a skill name. */
    function Chip({ tone, children }) {
      return h('span', { className: cx('dsm-chip', tone ? `dsm-chip-${tone}` : false) }, children)
    }

    /**
     * The stylesheet. Every colour is a Host theme token, so the page follows
     * the light and dark themes without a palette of its own.
     * @returns the CSS text.
     */
    function stylesheet() {
      return [
        // Scrolling: the shell hangs a panel under `.PIRFFq_centerCol`
        // (`display:flex; flex-direction:column; overflow:hidden`), which clips
        // anything that overflows and scrolls nothing. A panel must therefore be
        // its own scroller, and it must work whether or not the slot renderer
        // leaves a wrapper between the column and the panel:
        //   - `height:100%` fills a definite-height ancestor;
        //   - `max-height:100dvh` still bounds the box when every ancestor is
        //     auto-height (that panel column is the full viewport: the frame's
        //     second grid row carries no content for this panel), so the same
        //     box scrolls either way instead of growing past the clip.
        // `min-height:0` stops a flex parent from flooring the height.
        // The page itself never scrolls: the toolbar and the directory tabs stay
        // put and only the list below them moves. `overflow:hidden` here means
        // the list, not the page, owns the scrolling.
        '.dsm-page{box-sizing:border-box;display:flex;width:100%;min-width:0;max-width:1080px;margin:0 auto;flex-direction:column;gap:16px;padding:24px 28px 0;color:var(--dsw-alias-label-primary);font-family:inherit;font-size:13px;line-height:20px;height:100%;min-height:0;max-height:100vh;max-height:100dvh;overflow:hidden}',
        '.dsm-head{display:flex;flex-direction:column;gap:6px}',
        '.dsm-title{margin:0;font-size:22px;line-height:30px;font-weight:600;letter-spacing:-.2px}',
        '.dsm-subtitle{margin:0;color:var(--dsw-alias-label-secondary);font-size:13px;line-height:20px}',
        '.dsm-toolbar{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
        '.dsm-read-stamp{margin-left:auto;color:var(--dsw-alias-label-secondary);font-size:12px;font-variant-numeric:tabular-nums;white-space:nowrap}',
        '.dsm-grow{flex:1 1 220px;min-width:180px}',
        '.dsm-search{box-sizing:border-box;width:100%;height:32px;padding:0 10px;border:0.5px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px}',
        '.dsm-search::placeholder{color:var(--dsw-alias-label-secondary)}',
        '.dsm-search:focus-visible,.dsm-input:focus-visible,.dsm-textarea:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}',
        '.dsm-button{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;gap:6px;height:32px;padding:0 12px;border:0.5px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;font-weight:500;cursor:pointer;white-space:nowrap}',
        '.dsm-button:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2)}',
        '.dsm-button:disabled{opacity:.5;cursor:default}',
        '.dsm-button-primary{border-color:transparent;background:var(--dsw-alias-brand-primary);color:var(--dsw-alias-bg-base)}',
        '.dsm-button-quiet{border-color:transparent;background:transparent;color:var(--dsw-alias-label-secondary);padding:0 8px}',
        '.dsm-button-quiet:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}',
        '.dsm-button-danger{color:var(--dsw-alias-state-error-primary)}',
        '.dsm-roots{display:flex;align-items:center;gap:6px;flex-wrap:wrap}',
        '.dsm-root-tab{display:inline-flex;align-items:center;gap:6px;height:28px;padding:0 10px;border:0.5px solid var(--dsw-alias-border-l1);border-radius:999px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;cursor:pointer}',
        '.dsm-root-tab:hover{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-border-l2)}',
        '.dsm-root-tab[aria-pressed="true"]{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-1)}',
        '.dsm-mark{display:inline-flex;flex:none;align-items:center;justify-content:center}',
        '.dsm-mark>svg{display:block;width:100%;height:100%}',
        '.dsm-root-count{color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums;font-size:11px}',
        // Cards are flex children of the list. A flex child whose own
        // `overflow` is not `visible` has an automatic minimum size of ZERO, so
        // without this it gets squashed to fit instead of pushing the list into
        // its scrollbar: the list then fits exactly, never scrolls, and the
        // squashed card clips its own rows. `flex:none` keeps every block at its
        // content height; the list, not the cards, does the scrolling.
        '.dsm-page>*{flex:0 0 auto}',
        // The one scrolling region, plus a thumb that only shows while it moves.
        '.dsm-body{position:relative;display:flex;flex-direction:column;flex:1 1 auto;min-height:0}',
        '.dsm-list{display:flex;flex-direction:column;gap:16px;flex:1 1 auto;min-height:0;padding:2px 0 32px;overflow-y:auto;overflow-x:hidden;overscroll-behavior:contain;scrollbar-width:none;-ms-overflow-style:none}',
        // The same rule one level down: the cards are children of the list, and
        // a scroller whose children shrink to fit never overflows. Leaving this
        // out squashes every card to its own header and hides each path line.
        '.dsm-list>*{flex:0 0 auto}',
        '.dsm-list::-webkit-scrollbar{width:0;height:0}',
        '.dsm-thumb{position:absolute;right:-9px;width:6px;border-radius:3px;background:var(--dsw-alias-label-secondary);opacity:0;pointer-events:none;transition:opacity 180ms ease}',
        '.dsm-thumb[data-on="true"]{opacity:.45}',
        '.dsm-card{display:flex;flex-direction:column;overflow:hidden;border:0.5px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-layer-1)}',
        '.dsm-card-head{display:flex;align-items:flex-start;gap:10px;padding:12px 14px;border-bottom:0.5px solid var(--dsw-alias-border-l1)}',
        '.dsm-card-title{display:flex;flex-direction:column;gap:2px;min-width:0;flex:1}',
        // The mark sits inline before the name: the row is a flex line, so the
        // gap applies between the mark, the name and any chips.
        '.dsm-card-name{display:inline-flex;align-items:center;gap:6px;font-size:13px;font-weight:600}',
        '.dsm-card-path{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-secondary);font-size:11px;font-family:ui-monospace,SFMono-Regular,Consolas,monospace}',
        '.dsm-row{display:flex;align-items:center;gap:10px;padding:10px 14px;border-top:0.5px solid var(--dsw-alias-border-l1)}',
        '.dsm-row:hover{background:var(--dsw-alias-bg-layer-2)}',
        '.dsm-row-main{display:flex;flex-direction:column;gap:2px;min-width:0;flex:1;text-align:left;border:0;background:transparent;padding:0;color:inherit;font:inherit;cursor:pointer}',
        '.dsm-row-name{display:flex;align-items:center;gap:6px;min-width:0;font-size:13px;font-weight:550}',
        '.dsm-row-name-text{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
        '.dsm-row-desc{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-secondary);font-size:12px}',
        '.dsm-row-actions{display:flex;align-items:center;gap:4px;flex:none}',
        '.dsm-chip{display:inline-flex;align-items:center;height:18px;padding:0 6px;border-radius:6px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font-size:10px;font-weight:600;letter-spacing:.02em;text-transform:uppercase;white-space:nowrap}',
        '.dsm-chip-muted{background:transparent;color:var(--dsw-alias-label-secondary)}',
        '.dsm-chip-error{background:transparent;color:var(--dsw-alias-state-error-primary)}',
        '.dsm-empty{display:flex;flex-direction:column;align-items:center;gap:8px;padding:44px 16px;color:var(--dsw-alias-label-secondary);text-align:center}',
        '.dsm-empty-title{color:var(--dsw-alias-label-primary);font-size:14px;font-weight:600}',
        '.dsm-empty-body{max-width:420px;font-size:12px;line-height:19px}',
        '.dsm-note{display:flex;align-items:flex-start;gap:8px;padding:9px 12px;border:0.5px solid var(--dsw-alias-border-l1);border-radius:10px;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}',
        '.dsm-note-error{border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}',
        '.dsm-note-success{border-color:var(--dsw-alias-state-success-primary);color:var(--dsw-alias-state-success-primary)}',
        '.dsm-modal-backdrop{position:fixed;inset:0;z-index:60;display:flex;align-items:center;justify-content:center;padding:24px;background:rgba(0,0,0,.42)}',
        '.dsm-modal{display:flex;flex-direction:column;width:min(680px,100%);max-height:min(80vh,720px);overflow:hidden;border:0.5px solid var(--dsw-alias-border-l2);border-radius:16px;background:var(--dsw-alias-bg-overlay,var(--dsw-alias-bg-layer-1));box-shadow:0 24px 64px rgba(0,0,0,.32)}',
        '.dsm-modal-head{display:flex;align-items:flex-start;gap:12px;padding:16px 18px;border-bottom:0.5px solid var(--dsw-alias-border-l1)}',
        '.dsm-modal-title{display:flex;flex-direction:column;gap:2px;min-width:0;flex:1}',
        '.dsm-modal-name{font-size:15px;font-weight:600}',
        '.dsm-modal-body{overflow:auto;padding:16px 18px;display:flex;flex-direction:column;gap:14px}',
        '.dsm-modal-foot{display:flex;align-items:center;justify-content:flex-end;gap:8px;padding:12px 18px;border-top:0.5px solid var(--dsw-alias-border-l1)}',
        '.dsm-field{display:grid;grid-template-columns:96px minmax(0,1fr);gap:10px;align-items:start;font-size:12px}',
        '.dsm-field-label{color:var(--dsw-alias-label-secondary)}',
        '.dsm-field-value{min-width:0;overflow-wrap:anywhere}',
        '.dsm-pre{margin:0;padding:12px;overflow:auto;border:0.5px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:12px;line-height:19px;white-space:pre-wrap;word-break:break-word}',
        '.dsm-form{display:flex;flex-direction:column;gap:12px}',
        '.dsm-col{display:flex;flex-direction:column;gap:6px;min-width:0}',
        '.dsm-label{font-size:12px;color:var(--dsw-alias-label-secondary)}',
        '.dsm-input,.dsm-textarea{box-sizing:border-box;width:100%;padding:7px 10px;border:0.5px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px}',
        '.dsm-textarea{min-height:150px;resize:vertical;font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:12px;line-height:19px}',
        '.dsm-switch{display:inline-flex;align-items:center;gap:6px;font-size:12px;color:var(--dsw-alias-label-secondary);cursor:pointer;user-select:none}',
        '.dsm-switch input{width:14px;height:14px;margin:0;accent-color:var(--dsw-alias-brand-primary);cursor:pointer}',
        // The picker: one row per skill the repository holds. A row is a
        // button, because picking one IS the action — there is no second step.
        '.dsm-picker{display:flex;flex-direction:column;gap:6px;max-height:320px;overflow:auto}',
        '.dsm-picker-item{display:flex;align-items:flex-start;gap:8px;width:100%;box-sizing:border-box;padding:8px 10px;border:0.5px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;text-align:left;cursor:pointer}',
        '.dsm-picker-item:hover{background:var(--dsw-alias-bg-layer-2)}',
        '.dsm-picker-item input{width:14px;height:14px;margin:2px 0 0;flex:none;accent-color:var(--dsw-alias-brand-primary)}',
        '.dsm-picker-copy{display:flex;flex-direction:column;gap:2px;min-width:0}',
        '.dsm-picker-name{font-size:13px;font-weight:600}',
        '.dsm-picker-desc{color:var(--dsw-alias-label-secondary);font-size:12px}',
        '.dsm-picker-path{color:var(--dsw-alias-label-secondary);font-size:11px;font-family:ui-monospace,SFMono-Regular,Consolas,monospace;overflow-wrap:anywhere}',
        '.dsm-picker-actions{display:flex;align-items:center;justify-content:flex-end;gap:6px;flex-wrap:wrap}',
        '.dsm-hint{color:var(--dsw-alias-label-secondary);font-size:11px;line-height:16px}',
        '@media (max-width:640px){.dsm-page{padding:18px 14px 0}.dsm-thumb{right:-6px}.dsm-field{grid-template-columns:1fr}.dsm-row{flex-wrap:wrap}.dsm-row-actions{width:100%;justify-content:flex-end}}',
      ].join('\n')
    }

    /**
     * Read a folder the user picked, as the flat file list `import-files` wants.
     * @returns the chosen files, or undefined when the picker was dismissed.
     */
    function pickFiles() {
      return new Promise((resolve) => {
        if (typeof document === 'undefined') return resolve(undefined)
        const input = document.createElement('input')
        input.type = 'file'
        input.multiple = true
        input.webkitdirectory = true
        input.style.display = 'none'
        const cleanup = () => input.remove()
        input.addEventListener('change', () => {
          const files = Array.from(input.files ?? [])
          cleanup()
          resolve(files)
        })
        input.addEventListener('cancel', () => {
          cleanup()
          resolve(undefined)
        })
        document.body.append(input)
        input.click()
      })
    }

    /**
     * Read the `name` key from a skill file's frontmatter.
     * @param text - the instruction file.
     * @returns the declared name, or an empty string.
     */
    function frontmatterName(text) {
      const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(String(text))
      if (match === null) return ''
      const line = /^name\s*:\s*(.+)$/m.exec(match[1])
      if (line === null) return ''
      return line[1].trim().replace(/^['"]|['"]$/g, '')
    }

    /**
     * Turn a folder name into a name DSH will accept.
     * @param value - the folder name.
     * @returns a lowercase slug starting with a letter or digit.
     */
    function slugify(value) {
      const slug = String(value)
        .toLowerCase()
        .replace(/[^a-z0-9._-]+/g, '-')
        .replace(/^[-._]+|[-._]+$/g, '')
        .slice(0, 64)
      return /^[a-z0-9]/.test(slug) ? slug : `skill-${slug}`.replace(/-+$/g, '')
    }

    /**
     * Convert a picked folder into the payload the Host accepts.
     * @param files - the browser's File list.
     * @returns the entry name and the relative-path file list.
     */
    async function readPickedFolder(files) {
      const paths = files.map((file) => String(file.webkitRelativePath || file.name))
      const rootName = paths[0].split('/')[0]
      const entries = []
      for (let index = 0; index < files.length; index += 1) {
        const relative = paths[index].slice(rootName.length + 1)
        if (relative.length === 0) continue
        // The route carries text; binary assets would need base64 and are not
        // part of an instruction bundle a person hand-writes.
        if (/\.(png|jpe?g|gif|webp|zip|gz|so|dylib|dll|exe|woff2?|ttf)$/i.test(relative)) continue
        entries.push({ path: relative, content: await files[index].text() })
      }
      const instruction = entries.find((file) => file.path === 'SKILL.md')
      const declared = instruction === undefined ? '' : frontmatterName(instruction.content)
      return { name: declared.length > 0 ? declared : slugify(rootName), files: entries }
    }

    /**
     * The page's state, its loading and every mutation.
     *
     * Returned as one object whose methods close over `state`, so a method can
     * call a sibling (`refresh`) without `this` — a plain object literal loses
     * `this` the moment a listener is detached from it.
     *
     * @param t - translator for the active language.
     * @returns the store.
     */
    function createStore(t) {
      let state = {
        loading: true,
        busy: false,
        error: '',
        notice: null,
        data: undefined,
        query: '',
        rootFilter: undefined,
        detail: undefined,
        dialog: undefined,
        /* Bumped when the Host switches language, so the page re-renders. */
        language: 0,
        /* A manual "Reload" is in flight: the toolbar button reports it. */
        refreshing: false,
        /* When the roots were last read, so a reload shows that it happened. */
        refreshedAt: 0,
      }
      const listeners = new Set()
      const emit = () => {
        for (const listener of [...listeners]) listener()
      }
      const set = (patch) => {
        state = { ...state, ...patch }
        emit()
      }

      /** Run one Host action, folding a refusal into visible state. */
      const act = async (body) => {
        const answer = await callHost(body)
        if (answer.ok !== true) {
          set({ error: answer.message || t('error.generic'), notice: null })
          return undefined
        }
        return answer
      }

      const store = {
        subscribe(listener) {
          listeners.add(listener)
          return () => listeners.delete(listener)
        },
        getSnapshot() {
          return state
        },
        /**
         * Reload every root.
         *
         * A reload that finds the same disk changes nothing on screen, which
         * reads as "the button did nothing". The `refreshing` flag and the
         * `refreshedAt` stamp exist so a person can see the read happened even
         * when the result is identical.
         *
         * @param options - `quiet` keeps notices intact; `manual` reports
         * progress and the completion time.
         */
        async refresh(options) {
          const quiet = options?.quiet === true
          const manual = options?.manual === true
          if (!quiet) set({ loading: state.data === undefined })
          if (manual) set({ refreshing: true, error: '', notice: null })
          const answer = await callHost({ action: 'list' })
          if (manual) set({ refreshing: false })
          if (answer.ok !== true) {
            set({ loading: false, error: answer.message || t('error.generic') })
            return
          }
          set({ loading: false, error: '', data: answer, refreshedAt: Date.now() })
        },
        /** @param query - the search text. */
        setQuery(query) {
          set({ query })
        },
        /** @param key - a root key, or undefined for every root. */
        setRootFilter(key) {
          set({ rootFilter: key })
        },
        /** @param dialog - the open dialog, or undefined. */
        setDialog(dialog) {
          set({ dialog })
        },
        /** Repaint after a Host language switch. */
        bumpLanguage() {
          set({ language: state.language + 1 })
        },
        /**
         * Open one skill's preview.
         * @param rootKey - the owning root.
         * @param skill - the row's skill record.
         */
        async openDetail(rootKey, skill) {
          set({ detail: { loading: true, rootKey, skill } })
          const answer = await callHost({ action: 'read', rootKey, entryName: skill.entryName, disabled: skill.disabled })
          if (answer.ok !== true) {
            set({ detail: undefined, error: answer.message || t('error.generic') })
            return
          }
          set({ detail: { loading: false, rootKey, skill: answer.skill, rootPath: answer.rootPath } })
        },
        /** Close the preview. */
        closeDetail() {
          set({ detail: undefined })
        },
        /**
         * Enable or disable one skill.
         * @param rootKey - the owning root.
         * @param skill - the row's skill record.
         * @param disabled - the desired state.
         */
        async setDisabled(rootKey, skill, disabled) {
          if (state.busy) return
          set({ busy: true, error: '', notice: null })
          const answer = await act({ action: 'set-disabled', rootKey, entryName: skill.entryName, disabled })
          set({ busy: false })
          if (answer === undefined) return
          set({
            notice: {
              tone: 'success',
              text: disabled ? fill(t('notice.disabled'), { name: skill.name }) : fill(t('notice.enabled'), { name: skill.name }),
            },
          })
          await store.refresh({ quiet: true })
        },
        /**
         * Move one skill to the trash.
         * @param rootKey - the owning root.
         * @param skill - the row's skill record.
         */
        async uninstall(rootKey, skill) {
          if (state.busy) return
          set({ busy: true, error: '', notice: null })
          const answer = await act({ action: 'trash', rootKey, entryName: skill.entryName })
          set({ busy: false })
          if (answer === undefined) return
          set({ detail: undefined, notice: { tone: 'success', text: fill(t('notice.trashed'), { name: skill.name }) } })
          await store.refresh({ quiet: true })
        },
        /**
         * Restore one trashed entry.
         * @param rootKey - the owning root.
         * @param entryName - the entry name on disk.
         */
        async restore(rootKey, entryName) {
          if (state.busy) return
          set({ busy: true, error: '', notice: null })
          const answer = await act({ action: 'restore', rootKey, entryName })
          set({ busy: false })
          if (answer === undefined) return
          set({ notice: { tone: 'success', text: fill(t('notice.restored'), { name: entryName }) } })
          await store.refresh({ quiet: true })
        },
        /**
         * Delete one trashed entry for good.
         * @param rootKey - the owning root.
         * @param entryName - the entry name on disk.
         */
        async purge(rootKey, entryName) {
          if (state.busy) return
          set({ busy: true, error: '', notice: null })
          const answer = await act({ action: 'purge', rootKey, entryName })
          set({ busy: false })
          if (answer === undefined) return
          set({ notice: { tone: 'success', text: fill(t('notice.purged'), { name: entryName }) } })
          await store.refresh({ quiet: true })
        },
        /**
         * Empty one root's trash.
         * @param rootKey - the root whose trash is emptied.
         */
        async emptyTrash(rootKey) {
          if (state.busy) return
          set({ busy: true, error: '', notice: null })
          const answer = await act({ action: 'empty-trash', rootKey })
          set({ busy: false })
          if (answer === undefined) return
          set({ notice: { tone: 'success', text: fill(t('notice.trashEmptied'), { count: answer.removed ?? 0 }) } })
          await store.refresh({ quiet: true })
        },
        /**
         * Create a new skill bundle.
         * @param form - root key and the new skill's fields.
         * @returns whether it was created.
         */
        async create(form) {
          if (state.busy) return false
          set({ busy: true, error: '', notice: null })
          const answer = await act({ action: 'create', ...form })
          set({ busy: false })
          if (answer === undefined) return false
          set({ dialog: undefined, notice: { tone: 'success', text: fill(t('notice.created'), { name: form.name }) } })
          await store.refresh({ quiet: true })
          return true
        },
        /**
         * Install the skill in a folder the user picks.
         * @param rootKey - the root that receives it.
         */
        /**
         * Remember one extra directory.
         *
         * @param path - what the person typed; the Host expands `~` and checks
         * that the path is a directory.
         */
        async addRoot(path) {
          const typed = typeof path === 'string' ? path.trim() : ''
          if (typed.length === 0 || state.busy) return
          set({ busy: true, error: '', notice: null })
          const answer = await act({ action: 'add-root', path: typed })
          set({ busy: false })
          if (answer === undefined) return
          set({ dialog: undefined, notice: { tone: 'success', text: fill(t('notice.rootAdded'), { path: answer.path }) } })
          await store.refresh({ quiet: true })
        },
        /**
         * Forget one added directory. Nothing on disk moves.
         * @param root - the root record from the last list.
         */
        async removeRoot(root) {
          if (state.busy) return
          set({ busy: true, error: '', notice: null })
          const answer = await act({ action: 'remove-root', rootKey: root.key, path: root.path })
          set({ busy: false })
          if (answer === undefined) return
          set({
            error: '',
            notice: { tone: 'success', text: fill(t('notice.rootRemoved'), { path: root.path }) },
            // Drop a filter that pointed at the directory that just went away.
            rootFilter: state.rootFilter === root.key ? undefined : state.rootFilter,
          })
          await store.refresh({ quiet: true })
        },
        /**
         * Copy one skill out of an added directory into a root DSH scans.
         *
         * @param rootKey - the target root.
         * @param sourcePath - the skill's directory.
         * @param label - the skill name, for the notice.
         */
        async installFromRoot(rootKey, sourcePath, label) {
          if (state.busy) return
          set({ busy: true, error: '', notice: null })
          const answer = await act({ action: 'import-directory', rootKey, sourcePath })
          set({ busy: false })
          if (answer === undefined) return
          set({ dialog: undefined, notice: { tone: 'success', text: fill(t('notice.installed'), { name: answer.entryName ?? label }) } })
          await store.refresh({ quiet: true })
        },
        async installFromFolder(rootKey) {
          if (state.busy) return
          const files = await pickFiles()
          if (files === undefined || files.length === 0) return
          set({ busy: true, error: '', notice: null })
          const payload = await readPickedFolder(files)
          if (!payload.files.some((file) => file.path === 'SKILL.md')) {
            set({ busy: false, error: t('error.noSkillFile') })
            return
          }
          const answer = await act({ action: 'import-files', rootKey, name: payload.name, files: payload.files })
          set({ busy: false })
          if (answer === undefined) return
          set({ dialog: undefined, notice: { tone: 'success', text: fill(t('notice.installed'), { name: payload.name }) } })
          await store.refresh({ quiet: true })
        },
        /**
         * Import a skill from a remote repository.
         *
         * A repository that holds several skills answers `choose-skill`, and
         * the dialog then offers a multi-select list. The token is optional and
         * is only sent when there is one.
         *
         * @param form - the target root, the link, the token and the chosen
         * directory inside the repository.
         * @returns whether the skill was installed.
         */
        async installFromRemote(form) {
          if (state.busy) return false
          const url = typeof form.url === 'string' ? form.url.trim() : ''
          if (url.length === 0) return false
          const token = typeof form.token === 'string' ? form.token.trim() : ''
          set({ busy: true, error: '', notice: null })
          const answer = await callHost({
            action: 'install-from-remote',
            rootKey: form.rootKey,
            url,
            ...(token.length > 0 ? { token } : {}),
            ...(Array.isArray(form.paths) ? { paths: form.paths } : {}),
            ...(typeof form.path === 'string' ? { path: form.path } : {}),
          })
          set({ busy: false })
          if (answer.ok === true) {
            const source = answer.source?.repo ?? answer.source?.url ?? url
            const entries = Array.isArray(answer.entries) ? answer.entries : [{ entryName: answer.entryName }]
            const names = entries.map((entry) => entry.entryName).filter(Boolean).join(', ')
            set({
              dialog: undefined,
              notice: {
                tone: 'success',
                text: fill(t('notice.imported'), { count: entries.length, name: names, source }),
              },
            })
            await store.refresh({ quiet: true })
            return true
          }
          if (answer.code === 'choose-skill') {
            const candidates = Array.isArray(answer.candidates) ? answer.candidates : []
            set({
              dialog: {
                kind: 'remote',
                url,
                rootKey: form.rootKey,
                token,
                candidates,
                total: answer.total ?? candidates.length,
                truncated: answer.truncated === true,
                selectedPaths: candidates.map((candidate) => candidate.path),
              },
            })
            return false
          }
          const message = answer.message || t('error.generic')
          const previous = state.dialog?.kind === 'remote' && state.dialog.url === url ? state.dialog : {}
          set({ error: message, dialog: { ...previous, kind: 'remote', url, rootKey: form.rootKey, token, error: message } })
          return false
        },
        /**
         * Show one entry in the platform file manager.
         * @param rootKey - the owning root.
         * @param entryName - the entry on disk, or undefined for the root.
         */
        async reveal(rootKey, entryName) {
          const answer = await callHost({ action: 'reveal', rootKey, entryName })
          if (answer.ok !== true) set({ error: answer.message || t('error.revealFailed') })
        },
      }
      return store
    }

    /**
     * Build the components.
     * @param store - the page store.
     * @param t - translator for the active language.
     * @returns the components.
     */
    function createUi(store, t) {
      /** A themed button. */
      function Action({ variant, danger, className, children, ...rest }) {
        return h(
          'button',
          {
            type: 'button',
            className: cx(
              'dsm-button',
              variant === 'primary' && 'dsm-button-primary',
              variant === 'quiet' && 'dsm-button-quiet',
              danger && 'dsm-button-danger',
              className,
            ),
            ...rest,
          },
          children,
        )
      }

      /** An accessible enable/disable switch. */
      function Toggle({ checked, onChange, label, disabled }) {
        return h(
          'label',
          { className: 'dsm-switch', title: label },
          h('input', { type: 'checkbox', checked, disabled, onChange: (event) => onChange(event.target.checked) }),
          h('span', null, label),
        )
      }

      /** A modal dialog over the page, dismissed by Escape or the backdrop. */
      function Dialog({ title, subtitle, children, footer, onClose }) {
        React.useEffect(() => {
          const onKey = (event) => {
            if (event.key === 'Escape') onClose()
          }
          if (typeof window !== 'undefined') window.addEventListener('keydown', onKey)
          return () => {
            if (typeof window !== 'undefined') window.removeEventListener('keydown', onKey)
          }
        }, [onClose])
        return h(
          'div',
          {
            className: 'dsm-modal-backdrop',
            role: 'presentation',
            onMouseDown: (event) => {
              if (event.target === event.currentTarget) onClose()
            },
          },
          h(
            'div',
            { className: 'dsm-modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
            h(
              'div',
              { className: 'dsm-modal-head' },
              h('div', { className: 'dsm-modal-title' }, h('span', { className: 'dsm-modal-name' }, title), subtitle ? h('span', { className: 'dsm-card-path' }, subtitle) : null),
            ),
            h('div', { className: 'dsm-modal-body' }, children),
            h('div', { className: 'dsm-modal-foot' }, footer),
          ),
        )
      }

      /**
       * The mark each agent actually uses, at 24×24 (or an official 40×40 tile).
       *
       * Brand marks, not shapes drawn here: the DeepSeek whale, the OpenAI knot
       * for Codex, Claude's asterisk, and the official tiles from
       * codebuddy.ai and workbuddy.cn. Sources are named in the README.
       * Monochrome marks inherit `currentColor`, so they follow the theme; the
       * two tiles keep their own gradient, as their vendors draw them.
       */
      const AGENT_MARKS = {
        dsh: { glyph: "M23.748 4.651c-.254-.124-.364.113-.512.233-.051.04-.094.09-.137.137-.372.397-.806.657-1.373.626-.829-.046-1.537.214-2.163.848-.133-.782-.575-1.248-1.247-1.548-.352-.155-.708-.311-.955-.65-.172-.24-.219-.509-.305-.774-.055-.16-.11-.323-.293-.35-.2-.031-.278.136-.356.276-.313.572-.434 1.202-.422 1.84.027 1.436.633 2.58 1.838 3.393.137.094.172.187.129.323-.082.28-.18.553-.266.833-.055.179-.137.218-.328.14a5.5 5.5 0 0 1-1.737-1.179c-.857-.828-1.631-1.743-2.597-2.46a12 12 0 0 0-.689-.47c-.985-.957.13-1.743.387-1.836.27-.098.094-.433-.778-.428-.872.003-1.67.295-2.687.685a3 3 0 0 1-.465.136 9.6 9.6 0 0 0-2.883-.101c-1.885.21-3.39 1.1-4.497 2.622C.082 8.776-.231 10.854.152 13.02c.403 2.284 1.568 4.175 3.36 5.653 1.857 1.533 3.997 2.284 6.438 2.14 1.482-.085 3.132-.284 4.994-1.86.47.234.962.328 1.78.398.629.058 1.235-.031 1.705-.129.735-.155.684-.836.418-.961-2.155-1.004-1.682-.595-2.112-.926 1.095-1.295 2.768-3.598 3.284-6.733.05-.346.115-.834.108-1.114-.004-.171.035-.238.23-.257a4.2 4.2 0 0 0 1.545-.475c1.397-.763 1.96-2.016 2.093-3.517.02-.23-.004-.467-.247-.588M11.58 18.168c-2.088-1.642-3.101-2.183-3.52-2.16-.39.024-.32.472-.234.763.09.288.207.487.371.74.114.167.192.416-.113.603-.673.416-1.842-.14-1.897-.168-1.361-.801-2.5-1.86-3.301-3.306-.775-1.393-1.225-2.888-1.299-4.482-.02-.385.094-.522.477-.592a4.7 4.7 0 0 1 1.53-.038c2.131.311 3.946 1.264 5.467 2.774.868.86 1.525 1.887 2.202 2.89.72 1.066 1.494 2.082 2.48 2.915.348.291.626.513.892.677-.802.09-2.14.109-3.055-.615zm1.001-6.44a.306.306 0 0 1 .415-.287.3.3 0 0 1 .113.074.3.3 0 0 1 .086.214c0 .17-.136.307-.308.307a.303.303 0 0 1-.306-.307m3.11 1.596c-.2.081-.4.151-.591.16a1.25 1.25 0 0 1-.798-.254c-.274-.23-.47-.358-.551-.758a1.7 1.7 0 0 1 .015-.588c.07-.327-.007-.537-.238-.727-.188-.156-.426-.199-.689-.199a.6.6 0 0 1-.254-.078.253.253 0 0 1-.114-.358 1 1 0 0 1 .192-.21c.356-.202.767-.136 1.146.016.352.144.618.408 1.001.782.392.451.462.576.685.915.176.264.336.536.446.848.066.194-.02.353-.25.45", viewBox: '0 0 24 24', color: '#5786FE' },
        codex: { glyph: "M9.205 8.658v-2.26c0-.19.072-.333.238-.428l4.543-2.616c.619-.357 1.356-.523 2.117-.523 2.854 0 4.662 2.212 4.662 4.566 0 .167 0 .357-.024.547l-4.71-2.759a.797.797 0 00-.856 0l-5.97 3.473zm10.609 8.8V12.06c0-.333-.143-.57-.429-.737l-5.97-3.473 1.95-1.118a.433.433 0 01.476 0l4.543 2.617c1.309.76 2.189 2.378 2.189 3.948 0 1.808-1.07 3.473-2.76 4.163zM7.802 12.703l-1.95-1.142c-.167-.095-.239-.238-.239-.428V5.899c0-2.545 1.95-4.472 4.591-4.472 1 0 1.927.333 2.712.928L8.23 5.067c-.285.166-.428.404-.428.737v6.898zM12 15.128l-2.795-1.57v-3.33L12 8.658l2.795 1.57v3.33L12 15.128zm1.796 7.23c-1 0-1.927-.332-2.712-.927l4.686-2.712c.285-.166.428-.404.428-.737v-6.898l1.974 1.142c.167.095.238.238.238.428v5.233c0 2.545-1.974 4.472-4.614 4.472zm-5.637-5.303l-4.544-2.617c-1.308-.761-2.188-2.378-2.188-3.948A4.482 4.482 0 014.21 6.327v5.423c0 .333.143.571.428.738l5.947 3.449-1.95 1.118a.432.432 0 01-.476 0zm-.262 3.9c-2.688 0-4.662-2.021-4.662-4.519 0-.19.024-.38.047-.57l4.686 2.71c.286.167.571.167.856 0l5.97-3.448v2.26c0 .19-.07.333-.237.428l-4.543 2.616c-.619.357-1.356.523-2.117.523zm5.899 2.83a5.947 5.947 0 005.827-4.756C22.287 18.339 24 15.84 24 13.296c0-1.665-.713-3.282-1.998-4.448.119-.5.19-.999.19-1.498 0-3.401-2.759-5.947-5.946-5.947-.642 0-1.26.095-1.88.31A5.962 5.962 0 0010.205 0a5.947 5.947 0 00-5.827 4.757C1.713 5.447 0 7.945 0 10.49c0 1.666.713 3.283 1.998 4.448-.119.5-.19 1-.19 1.499 0 3.401 2.759 5.946 5.946 5.946.642 0 1.26-.095 1.88-.309a5.96 5.96 0 004.162 1.713z", viewBox: '0 0 24 24', color: 'currentColor' },
        claude: { glyph: "M4.709 15.955l4.72-2.647.08-.23-.08-.128H9.2l-.79-.048-2.698-.073-2.339-.097-2.266-.122-.571-.121L0 11.784l.055-.352.48-.321.686.06 1.52.103 2.278.158 1.652.097 2.449.255h.389l.055-.157-.134-.098-.103-.097-2.358-1.596-2.552-1.688-1.336-.972-.724-.491-.364-.462-.158-1.008.656-.722.881.06.225.061.893.686 1.908 1.476 2.491 1.833.365.304.145-.103.019-.073-.164-.274-1.355-2.446-1.446-2.49-.644-1.032-.17-.619a2.97 2.97 0 01-.104-.729L6.283.134 6.696 0l.996.134.42.364.62 1.414 1.002 2.229 1.555 3.03.456.898.243.832.091.255h.158V9.01l.128-1.706.237-2.095.23-2.695.08-.76.376-.91.747-.492.584.28.48.685-.067.444-.286 1.851-.559 2.903-.364 1.942h.212l.243-.242.985-1.306 1.652-2.064.73-.82.85-.904.547-.431h1.033l.76 1.129-.34 1.166-1.064 1.347-.881 1.142-1.264 1.7-.79 1.36.073.11.188-.02 2.856-.606 1.543-.28 1.841-.315.833.388.091.395-.328.807-1.969.486-2.309.462-3.439.813-.042.03.049.061 1.549.146.662.036h1.622l3.02.225.79.522.474.638-.079.485-1.215.62-1.64-.389-3.829-.91-1.312-.329h-.182v.11l1.093 1.068 2.006 1.81 2.509 2.33.127.578-.322.455-.34-.049-2.205-1.657-.851-.747-1.926-1.62h-.128v.17l.444.649 2.345 3.521.122 1.08-.17.353-.608.213-.668-.122-1.374-1.925-1.415-2.167-1.143-1.943-.14.08-.674 7.254-.316.37-.729.28-.607-.461-.322-.747.322-1.476.389-1.924.315-1.53.286-1.9.17-.632-.012-.042-.14.018-1.434 1.967-2.18 2.945-1.726 1.845-.414.164-.717-.37.067-.662.401-.589 2.388-3.036 1.44-1.882.93-1.086-.006-.158h-.055L4.132 18.56l-1.13.146-.487-.456.061-.746.231-.243 1.908-1.312-.006.006z", viewBox: '0 0 24 24', color: '#D97757' },
        codebuddy: { svg: "<svg width=\"100%\" height=\"100%\" viewBox=\"0 0 40 40\" fill=\"none\" xmlns=\"http://www.w3.org/2000/svg\"><g clip-path=\"url(#cb-clip0_5110_14771)\"><rect width=\"40\" height=\"40\" rx=\"20\" fill=\"url(#cb-paint0_linear_5110_14771)\"/><path d=\"M27.6897 3.3426C28.057 3.01322 28.0795 2.99983 28.3485 2.98366C28.7851 2.95177 29.1858 3.16107 29.8664 3.78072C31.4566 5.22574 33.6703 8.19724 35.047 10.7343L35.5796 11.7191L36.3309 12.0927C37.0562 12.4593 38.2459 13.2111 38.7428 13.614C38.9673 13.7997 38.9992 13.8032 39.2326 13.7124C40.2872 13.3017 41.7982 13.846 43.1307 15.1244C44.3302 16.274 45.479 18.2384 45.9191 19.8778C45.9833 20.1417 46.0683 20.709 46.0994 21.1314C46.1997 22.6144 45.7243 23.7986 44.8085 24.3349C44.6213 24.443 44.6085 24.4725 44.6137 24.939C44.6559 27.1604 44.0571 29.3777 42.8543 31.54C41.4965 33.9678 39.0794 36.4798 35.8073 38.846C34.0502 40.1247 29.8918 42.5469 28.0122 43.3973C23.5096 45.4244 19.8999 46.2022 16.7645 45.8181C14.8943 45.5915 12.7771 44.8611 11.5246 44.0137C11.1951 43.786 11.1428 43.7719 10.8909 43.8439C9.55017 44.2289 7.79442 43.4374 6.30272 41.7817C5.70771 41.1197 4.74709 39.4939 4.43575 38.6241C3.71569 36.5887 3.85859 34.752 4.81783 33.6551C5.0657 33.3725 5.07387 33.3607 5.01972 32.8856C4.93033 32.1079 4.88982 30.9566 4.93066 30.2138L4.96343 29.5205L3.92091 27.6777C2.3078 24.8074 1.28326 22.3968 0.887982 20.5554C0.679402 19.546 0.692781 19.0981 0.949061 18.7667C1.10529 18.5666 1.61622 18.3594 2.23252 18.2455C3.78518 17.9729 7.17203 18.2198 10.9394 18.885L11.3303 18.9525L12.1903 18.1921C13.6179 16.9275 14.5665 16.2176 16.315 15.1274C18.1373 13.9872 20.1943 13.0498 22.5103 12.3071L23.2533 12.0687L23.6615 10.9964C25.1239 7.13587 26.6218 4.28969 27.6897 3.3426ZM15.4393 23.1261C13.7864 24.0804 12.9602 24.5582 12.3529 25.093C9.89364 27.2585 8.9738 30.6888 10.0208 33.7938C10.2794 34.5606 10.7568 35.387 11.7111 37.0398C12.6653 38.6926 13.1424 39.5194 13.6771 40.1267C15.8426 42.5859 19.2732 43.5045 22.3783 42.4574C23.145 42.1989 23.972 41.7223 25.6248 40.768L35.1333 35.2783C36.7862 34.324 37.6124 33.8462 38.2196 33.3114C40.6789 31.1459 41.5988 27.7156 40.5518 24.6105C40.2932 23.8438 39.8157 23.0174 38.8615 21.3646C37.9072 19.7117 37.4302 18.885 36.8955 18.2777C34.7299 15.8185 31.2993 14.8999 28.1943 15.947C27.4275 16.2055 26.6006 16.6821 24.9478 17.6364L15.4393 23.1261Z\" fill=\"url(#cb-paint1_linear_5110_14771)\"/><rect x=\"15.8816\" y=\"30.0273\" width=\"4.00904\" height=\"8.32646\" rx=\"2.00452\" transform=\"rotate(-30 15.8816 30.0273)\" fill=\"white\"/><rect x=\"26.6978\" y=\"23.7812\" width=\"4.00904\" height=\"8.32646\" rx=\"2.00452\" transform=\"rotate(-30 26.6978 23.7812)\" fill=\"white\"/></g><defs><filter id=\"cb-filter0_f_5110_14771\" x=\"-14.9163\" y=\"7.45599\" width=\"55.0468\" height=\"55.047\" filterUnits=\"userSpaceOnUse\" color-interpolation-filters=\"sRGB\"><feFlood flood-opacity=\"0\" result=\"BackgroundImageFix\"/><feBlend mode=\"normal\" in=\"SourceGraphic\" in2=\"BackgroundImageFix\" result=\"shape\"/><feGaussianBlur stdDeviation=\"6.72123\" result=\"effect1_foregroundBlur_5110_14771\"/></filter><filter id=\"cb-filter1_f_5110_14771\" x=\"9.46959\" y=\"19.7477\" width=\"47.7417\" height=\"47.741\" filterUnits=\"userSpaceOnUse\" color-interpolation-filters=\"sRGB\"><feFlood flood-opacity=\"0\" result=\"BackgroundImageFix\"/><feBlend mode=\"normal\" in=\"SourceGraphic\" in2=\"BackgroundImageFix\" result=\"shape\"/><feGaussianBlur stdDeviation=\"5.50019\" result=\"effect1_foregroundBlur_5110_14771\"/></filter><linearGradient id=\"cb-paint0_linear_5110_14771\" x1=\"20\" y1=\"0\" x2=\"20\" y2=\"40\" gradientUnits=\"userSpaceOnUse\"><stop stop-color=\"#6C4DFF\"/><stop offset=\"1\" stop-color=\"#583ED3\"/></linearGradient><linearGradient id=\"cb-paint1_linear_5110_14771\" x1=\"14.639\" y1=\"10.7917\" x2=\"32.1712\" y2=\"41.1585\" gradientUnits=\"userSpaceOnUse\"><stop stop-color=\"white\" stop-opacity=\"0.8\"/><stop offset=\"0.437689\" stop-color=\"white\"/></linearGradient><clipPath id=\"cb-clip0_5110_14771\"><rect width=\"40\" height=\"40\" rx=\"20\" fill=\"white\"/></clipPath></defs></svg>" },
        workbuddy: { svg: "<svg width=\"100%\" height=\"100%\" viewBox=\"0 0 40 40\" fill=\"none\" xmlns=\"http://www.w3.org/2000/svg\"><g clip-path=\"url(#wb-clip0_542_3370)\"><rect width=\"40\" height=\"40\" rx=\"20\" fill=\"url(#wb-paint0_linear_542_3370)\"/><path d=\"M28.5931 3.12762C28.9853 2.77585 29.0091 2.76226 29.2968 2.74499C29.7628 2.71096 30.1894 2.93488 30.916 3.59634C32.6132 5.13875 34.9769 8.30904 36.4462 11.0168L37.0138 12.0682L37.8156 12.4668C38.5896 12.8579 39.8593 13.6593 40.3898 14.0895C40.6297 14.2878 40.6638 14.2925 40.9133 14.1954C42.0388 13.7572 43.6506 14.3382 45.0727 15.7024C46.3529 16.9294 47.5794 19.026 48.0491 20.7757C48.1177 21.0574 48.2087 21.6628 48.2419 22.1134C48.349 23.6964 47.8414 24.9608 46.8637 25.5331C46.664 25.6484 46.6505 25.6795 46.6561 26.1774C46.7011 28.5481 46.0621 30.9144 44.7785 33.2221C43.3293 35.8133 40.7489 38.4945 37.2566 41.0199C35.3813 42.3846 30.9445 44.9701 28.9382 45.8778C24.1324 48.0414 20.2794 48.8709 16.9329 48.4609C14.9368 48.219 12.6769 47.44 11.34 46.5355C10.9885 46.2925 10.9325 46.2774 10.6637 46.3543C9.2327 46.7651 7.35867 45.9207 5.76659 44.1535C5.13165 43.4471 4.1065 41.7127 3.77404 40.7843C3.0054 38.6118 3.15852 36.6506 4.18236 35.4799C4.44671 35.1785 4.45511 35.1658 4.39735 34.6589C4.30195 33.8289 4.25837 32.6008 4.30192 31.808L4.33666 31.0674L3.22502 29.101C1.5033 26.0375 0.409325 23.4645 -0.012563 21.4992C-0.235219 20.4218 -0.221193 19.9436 0.0522186 19.5899C0.21871 19.3763 0.764928 19.1545 1.42322 19.0329C3.08041 18.742 6.69466 19.0056 10.7155 19.7155L11.1329 19.788L12.0511 18.976C13.5747 17.6264 14.587 16.8696 16.4531 15.706C18.3981 14.4891 20.5929 13.4877 23.0648 12.695L23.8577 12.4414L24.2939 11.2964C25.8547 7.17615 27.4533 4.13844 28.5931 3.12762ZM15.5182 24.243C13.7542 25.2615 12.8718 25.7706 12.2236 26.3413C9.59893 28.6526 8.61811 32.3134 9.73545 35.6274C10.0114 36.4457 10.5201 37.3283 11.5386 39.0923C12.5571 40.8564 13.0671 41.7383 13.6378 42.3864C15.9491 45.0112 19.6103 45.9929 22.9243 44.8755C23.7426 44.5995 24.6249 44.0899 26.3888 43.0714L36.5375 37.2121C38.3016 36.1936 39.184 35.6845 39.8321 35.1137C42.4568 32.8024 43.4373 29.1409 42.3198 25.8269C42.0438 25.0086 41.5342 24.1264 40.5158 22.3624C39.4973 20.5983 38.9882 19.7159 38.4175 19.0678C36.1062 16.4432 32.4454 15.4622 29.1314 16.5796C28.3131 16.8556 27.431 17.3651 25.6669 18.3836L15.5182 24.243Z\" fill=\"url(#wb-paint1_linear_542_3370)\"/><rect x=\"16.4961\" y=\"31.3344\" width=\"4.00904\" height=\"8.32646\" rx=\"2.00452\" transform=\"rotate(-30 16.4961 31.3344)\" fill=\"white\"/><rect x=\"27.3125\" y=\"25.0894\" width=\"4.00904\" height=\"8.32646\" rx=\"2.00452\" transform=\"rotate(-30 27.3125 25.0894)\" fill=\"white\"/></g><defs><filter id=\"wb-filter0_f_542_3370\" x=\"7.47033\" y=\"19.7475\" width=\"47.742\" height=\"47.7416\" filterUnits=\"userSpaceOnUse\" color-interpolation-filters=\"sRGB\"><feFlood flood-opacity=\"0\" result=\"BackgroundImageFix\"/><feBlend mode=\"normal\" in=\"SourceGraphic\" in2=\"BackgroundImageFix\" result=\"shape\"/><feGaussianBlur stdDeviation=\"5.50019\" result=\"effect1_foregroundBlur_542_3370\"/></filter><linearGradient id=\"wb-paint0_linear_542_3370\" x1=\"20\" y1=\"0\" x2=\"20\" y2=\"40\" gradientUnits=\"userSpaceOnUse\"><stop stop-color=\"#0EC8A9\"/><stop offset=\"1\" stop-color=\"#01C886\"/></linearGradient><linearGradient id=\"wb-paint1_linear_542_3370\" x1=\"14.6642\" y1=\"11.0783\" x2=\"33.3762\" y2=\"43.4885\" gradientUnits=\"userSpaceOnUse\"><stop stop-color=\"white\" stop-opacity=\"0.8\"/><stop offset=\"0.437689\" stop-color=\"white\"/></linearGradient><clipPath id=\"wb-clip0_542_3370\"><rect width=\"40\" height=\"40\" rx=\"20\" fill=\"white\"/></clipPath></defs></svg>" },
      }

      /**
       * One agent's mark.
       *
       * @param props - `agent` id and an optional size in pixels.
       */
      function AgentIcon({ agent, size }) {
        const box = size ?? 14
        const mark = AGENT_MARKS[agent]
        if (mark === undefined) return null
        if (typeof mark.svg === 'string') {
          // The tile is a small SVG document of its own; it is authored here,
          // never taken from a page or a request.
          return h('span', {
            className: 'dsm-mark',
            style: { width: `${box}px`, height: `${box}px` },
            'aria-hidden': 'true',
            dangerouslySetInnerHTML: { __html: mark.svg },
          })
        }
        return h(
          'svg',
          {
            viewBox: mark.viewBox,
            width: box,
            height: box,
            'aria-hidden': 'true',
            focusable: 'false',
            style: { flex: 'none', display: 'block', color: mark.color },
          },
          h('path', { d: mark.glyph, fill: 'currentColor', fillRule: 'evenodd', clipRule: 'evenodd' }),
        )
      }

      /** @returns the readable name of one root. */
      function rootLabel(root) {
        if (root.agent !== undefined && root.agent !== 'custom' && root.kind === 'agent') {
          return t(`agent.${root.agent}`)
        }
        if (root.kind === 'custom') {
          const name = String(root.path ?? '').split('/').filter(Boolean).pop() || root.path
          return fill(t('root.custom'), { name })
        }
        if (root.kind === 'project') {
          const name = root.workspaceTitle || String(root.workspacePath ?? '').split('/').filter(Boolean).pop() || root.path
          return fill(t('root.project'), { name })
        }
        return root.source === 'user-agents' ? t('root.agents') : t('root.dsh')
      }

      /** @returns whether one skill matches the search text. */
      function matchesQuery(skill, query) {
        const haystack = `${skill.name} ${skill.description} ${skill.whenToUse ?? ''} ${skill.entryName}`.toLowerCase()
        return query
          .toLowerCase()
          .split(/\s+/)
          .filter(Boolean)
          .every((term) => haystack.includes(term))
      }

      /** The skill preview. */
      function DetailDialog({ detail }) {
        const skill = detail.skill
        return h(
          Dialog,
          {
            title: skill.name,
            subtitle: skill.path,
            onClose: store.closeDetail,
            footer: [
              h(Action, { key: 'reveal', onClick: () => store.reveal(detail.rootKey, skill.entryName) }, t('action.reveal')),
              h(Action, { key: 'close', variant: 'primary', onClick: store.closeDetail }, t('action.close')),
            ],
          },
          h(
            'div',
            { className: 'dsm-field' },
            h('span', { className: 'dsm-field-label' }, t('field.description')),
            h('span', { className: 'dsm-field-value' }, skill.description || t('value.none')),
          ),
          skill.whenToUse
            ? h('div', { className: 'dsm-field' }, h('span', { className: 'dsm-field-label' }, t('field.whenToUse')), h('span', { className: 'dsm-field-value' }, skill.whenToUse))
            : null,
          h(
            'div',
            { className: 'dsm-field' },
            h('span', { className: 'dsm-field-label' }, t('field.invocation')),
            h(
              'span',
              { className: 'dsm-field-value' },
              [skill.modelInvocable ? t('invocation.model') : t('invocation.userOnly'), skill.userInvocable ? t('invocation.slash') : t('invocation.noSlash')].join(' · '),
            ),
          ),
          h(
            'div',
            { className: 'dsm-field' },
            h('span', { className: 'dsm-field-label' }, t('field.status')),
            h('span', { className: 'dsm-field-value' }, skill.disabled ? t('status.disabled') : t('status.enabled')),
          ),
          detail.loading ? h('div', { className: 'dsm-note' }, t('loading.body')) : h('pre', { className: 'dsm-pre' }, String(skill.body ?? '')),
        )
      }

      /** The create form. */
      /** Ask for one extra directory to list. */
      function AddRootDialog() {
        const [path, setPath] = React.useState('')
        const ready = path.trim().length > 0
        const submit = () => {
          if (ready) store.addRoot(path)
        }
        return h(
          Dialog,
          {
            title: t('addRoot.title'),
            subtitle: t('addRoot.subtitle'),
            onClose: () => store.setDialog(undefined),
            footer: [
              h(Action, { key: 'cancel', onClick: () => store.setDialog(undefined) }, t('action.cancel')),
              h(Action, { key: 'add', variant: 'primary', onClick: submit, disabled: !ready }, t('addRoot.add')),
            ],
          },
          h(
            'div',
            { className: 'dsm-form' },
            h(
              'div',
              { className: 'dsm-col' },
              h('span', { className: 'dsm-label' }, t('addRoot.label')),
              h('input', {
                className: 'dsm-input',
                value: path,
                placeholder: t('addRoot.placeholder'),
                onChange: (event) => setPath(event.target.value),
                onKeyDown: (event) => {
                  if (event.key === 'Enter') submit()
                },
              }),
            ),
            h('div', { className: 'dsm-note' }, t('addRoot.hint')),
          ),
        )
      }

      function CreateDialog({ roots, defaultRootKey }) {
        const [rootKey, setRootKey] = React.useState(defaultRootKey)
        const [name, setName] = React.useState('')
        const [description, setDescription] = React.useState('')
        const [whenToUse, setWhenToUse] = React.useState('')
        const [body, setBody] = React.useState('')
        const ready = name.trim().length > 0 && description.trim().length > 0
        const submit = () => {
          if (!ready) return
          store.create({ rootKey, name: name.trim(), description: description.trim(), whenToUse: whenToUse.trim(), body })
        }
        return h(
          Dialog,
          {
            title: t('create.title'),
            subtitle: t('create.subtitle'),
            onClose: () => store.setDialog(undefined),
            footer: [
              h(Action, { key: 'cancel', onClick: () => store.setDialog(undefined) }, t('action.cancel')),
              h(Action, { key: 'create', variant: 'primary', onClick: submit, disabled: !ready }, t('create.submit')),
            ],
          },
          h(
            'div',
            { className: 'dsm-form' },
            h(
              'div',
              { className: 'dsm-col' },
              h('span', { className: 'dsm-label' }, t('create.root')),
              h(
                'select',
                { className: 'dsm-input', value: rootKey, onChange: (event) => setRootKey(event.target.value) },
                roots.map((root) => h('option', { key: root.key, value: root.key }, rootLabel(root))),
              ),
            ),
            h(
              'div',
              { className: 'dsm-col' },
              h('span', { className: 'dsm-label' }, t('create.name')),
              h('input', { className: 'dsm-input', value: name, placeholder: 'my-skill', onChange: (event) => setName(event.target.value) }),
            ),
            h(
              'div',
              { className: 'dsm-col' },
              h('span', { className: 'dsm-label' }, t('create.description')),
              h('input', {
                className: 'dsm-input',
                value: description,
                placeholder: t('create.descriptionPlaceholder'),
                onChange: (event) => setDescription(event.target.value),
              }),
            ),
            h(
              'div',
              { className: 'dsm-col' },
              h('span', { className: 'dsm-label' }, t('create.whenToUse')),
              h('input', { className: 'dsm-input', value: whenToUse, placeholder: t('value.optional'), onChange: (event) => setWhenToUse(event.target.value) }),
            ),
            h(
              'div',
              { className: 'dsm-col' },
              h('span', { className: 'dsm-label' }, t('create.body')),
              h('textarea', { className: 'dsm-textarea', value: body, placeholder: t('create.bodyPlaceholder'), onChange: (event) => setBody(event.target.value) }),
            ),
          ),
        )
      }

      /** The install chooser. */
      /**
       * Install a skill into a root DSH scans.
       *
       * Two modes: with `source` set, the skill is already on disk (it came
       * from an added directory) and one click copies it; without it, the
       * person picks a folder.
       *
       * @param props - candidate roots, a default, and an optional source.
       */
      function InstallDialog({ roots, defaultRootKey, source }) {
        const [rootKey, setRootKey] = React.useState(defaultRootKey)
        const copying = source !== undefined
        const blocked = roots.length === 0
        const primary = copying
          ? () => store.installFromRoot(rootKey, source.path, source.name)
          : () => store.installFromFolder(rootKey)
        return h(
          Dialog,
          {
            title: t('install.title'),
            subtitle: copying ? source.name : t('install.subtitle'),
            onClose: () => store.setDialog(undefined),
            footer: [
              h(Action, { key: 'cancel', onClick: () => store.setDialog(undefined) }, t('action.cancel')),
              h(Action, { key: 'pick', variant: 'primary', onClick: primary, disabled: blocked }, copying ? t('action.install') : t('install.pick')),
            ],
          },
          h(
            'div',
            { className: 'dsm-form' },
            copying
              ? h(
                  'div',
                  { className: 'dsm-col' },
                  h('span', { className: 'dsm-label' }, t('install.source')),
                  h('span', { className: 'dsm-card-path', title: source.path }, source.path),
                )
              : null,
            blocked
              ? null
              : h(
                  'div',
                  { className: 'dsm-col' },
                  h('span', { className: 'dsm-label' }, t('create.root')),
                  h(
                    'select',
                    { className: 'dsm-input', value: rootKey, onChange: (event) => setRootKey(event.target.value) },
                    roots.map((root) => h('option', { key: root.key, value: root.key }, rootLabel(root))),
                  ),
                ),
            h('div', { className: 'dsm-note' }, blocked ? t('install.noTarget') : t('install.hint')),
          ),
        )
      }

      /** Import one or more skills from a GitHub repository. */
      function RemoteInstallDialog({ roots, defaultRootKey, dialog, busy }) {
        const [url, setUrl] = React.useState(dialog.url ?? '')
        const [token, setToken] = React.useState(dialog.token ?? '')
        const [rootKey, setRootKey] = React.useState(
          // A remembered root may be read-only (the filter pointed at an agent
          // library). Never preselect something this dialog cannot write to.
          roots.some((root) => root.key === dialog.rootKey)
            ? dialog.rootKey
            : roots.some((root) => root.key === defaultRootKey)
              ? defaultRootKey
              : roots[0]?.key,
        )
        const candidates = Array.isArray(dialog.candidates) ? dialog.candidates : []
        const selectedPaths = Array.isArray(dialog.selectedPaths) ? dialog.selectedPaths : []
        const blocked = roots.length === 0
        const ready = url.trim().length > 0 && !blocked
        const choose = (path, checked) => {
          const next = checked
            ? [...new Set([...selectedPaths, path])]
            : selectedPaths.filter((selected) => selected !== path)
          // The dialog is remounted with a fresh `candidates` prop after a
          // scan, so the batch selection must also travel through the store.
          store.setDialog({ ...dialog, rootKey, selectedPaths: next })
        }
        const submit = (paths) => {
          if (!ready || busy) return
          store.installFromRemote({ rootKey, url: url.trim(), token: token.trim(), paths })
        }

        return h(
          Dialog,
          {
            title: t('remote.title'),
            subtitle: t('remote.subtitle'),
            onClose: () => store.setDialog(undefined),
            footer: [
              h(Action, { key: 'cancel', onClick: () => store.setDialog(undefined) }, t('action.cancel')),
              candidates.length > 0
                ? h(
                    Action,
                    { key: 'submit', variant: 'primary', onClick: () => submit(selectedPaths), disabled: !ready || busy || selectedPaths.length === 0 },
                    busy ? t('remote.reading') : fill(t('remote.importSelected'), { count: selectedPaths.length }),
                  )
                : h(
                    Action,
                    { key: 'submit', variant: 'primary', onClick: () => submit(undefined), disabled: !ready || busy },
                    busy ? t('remote.reading') : t('remote.submit'),
                  ),
            ],
          },
          h(
            'div',
            { className: 'dsm-form' },
            h(
              'div',
              { className: 'dsm-col' },
              h('span', { className: 'dsm-label' }, t('remote.url')),
              h('input', {
                className: 'dsm-input',
                value: url,
                placeholder: t('remote.urlPlaceholder'),
                'aria-label': t('remote.url'),
                disabled: busy,
                onChange: (event) => {
                  setUrl(event.target.value)
                  store.setDialog({ kind: 'remote', url: event.target.value, rootKey, token })
                },
                onKeyDown: (event) => {
                  if (event.key === 'Enter') submit(candidates.length > 0 ? selectedPaths : undefined)
                },
              }),
            ),
            h(
              'div',
              { className: 'dsm-col' },
              h('span', { className: 'dsm-label' }, t('remote.token')),
              h('input', {
                className: 'dsm-input',
                type: 'password',
                value: token,
                placeholder: t('remote.tokenPlaceholder'),
                'aria-label': t('remote.token'),
                disabled: busy,
                onChange: (event) => {
                  setToken(event.target.value)
                  store.setDialog({ kind: 'remote', url, rootKey, token: event.target.value })
                },
              }),
              h('span', { className: 'dsm-hint' }, t('remote.tokenHint')),
            ),
            blocked
              ? null
              : h(
                  'div',
                  { className: 'dsm-col' },
                  h('span', { className: 'dsm-label' }, t('remote.root')),
                  h(
                    'select',
                    { className: 'dsm-input', value: rootKey, disabled: busy, onChange: (event) => setRootKey(event.target.value) },
                    roots.map((root) => h('option', { key: root.key, value: root.key }, rootLabel(root))),
                  ),
                ),
            h('div', { className: 'dsm-note' }, blocked ? t('remote.noTarget') : t('remote.hint')),
            dialog.error ? h('div', { className: 'dsm-note dsm-note-error', role: 'alert' }, dialog.error) : null,
            candidates.length > 0
              ? h(
                  'div',
                  { className: 'dsm-col' },
                  h('span', { className: 'dsm-label' }, t('remote.choose')),
                  dialog.truncated
                    ? h('div', { className: 'dsm-note' }, fill(t('remote.truncated'), { shown: candidates.length, total: dialog.total }))
                    : null,
                  h(
                    'div',
                    { className: 'dsm-picker' },
                    candidates.map((candidate) => {
                      const checked = selectedPaths.includes(candidate.path)
                      return h(
                        'label',
                        { key: candidate.path, className: 'dsm-picker-item' },
                        h('input', {
                          type: 'checkbox',
                          checked,
                          disabled: busy,
                          onChange: (event) => choose(candidate.path, event.target.checked),
                        }),
                        h('span', { className: 'dsm-picker-copy' },
                          h('span', { className: 'dsm-picker-name' }, candidate.name || candidate.path),
                          candidate.description ? h('span', { className: 'dsm-picker-desc' }, candidate.description) : null,
                          h('span', { className: 'dsm-picker-path' }, candidate.path),
                        ),
                      )
                    }),
                  ),
                  h(
                    'div',
                    { className: 'dsm-picker-actions' },
                    h(Action, {
                      variant: 'quiet',
                      disabled: busy || selectedPaths.length === candidates.length,
                      onClick: () => store.setDialog({ ...dialog, rootKey, selectedPaths: candidates.map((candidate) => candidate.path) }),
                    }, t('remote.selectAll')),
                    h(Action, {
                      variant: 'quiet',
                      disabled: busy || selectedPaths.length === 0,
                      onClick: () => store.setDialog({ ...dialog, rootKey, selectedPaths: [] }),
                    }, t('remote.clearSelection')),
                    h(Action, {
                      variant: 'quiet',
                      onClick: () => store.setDialog({ kind: 'remote', url, rootKey, token }),
                    }, t('remote.change')),
                  ),
                )
              : null,
          ),
        )
      }

      /** One skill row. */
      function SkillRow({ rootKey, skill, readOnly }) {
        const issues = skill.issues ?? []
        const copyable = readOnly && skill.entryKind === 'directory'
        return h(
          'div',
          { className: 'dsm-row' },
          h(
            'button',
            { type: 'button', className: 'dsm-row-main', onClick: () => store.openDetail(rootKey, skill), title: t('action.preview') },
            h(
              'span',
              { className: 'dsm-row-name' },
              h('span', { className: 'dsm-row-name-text' }, skill.name),
              skill.disabled ? h(Chip, null, t('chip.disabled')) : null,
              !skill.modelInvocable && !skill.disabled ? h(Chip, { tone: 'muted' }, t('chip.userOnly')) : null,
              issues.includes('invalid-flag') ? h(Chip, { tone: 'error' }, t('chip.invalid')) : null,
            ),
            h('span', { className: 'dsm-row-desc' }, skill.description || t('value.noDescription')),
          ),
          h(
            'div',
            { className: 'dsm-row-actions' },
            // An added directory is not scanned by DSH, so a switch there would
            // change nothing. Offer the one operation that does: copy it out.
            copyable
              ? h(
                  Action,
                  {
                    variant: 'quiet',
                    onClick: () => store.setDialog({ kind: 'install', source: { path: skill.path, name: skill.name } }),
                    title: t('action.installTo'),
                  },
                  t('action.installTo'),
                )
              : null,
            readOnly
              ? null
              : h(Toggle, {
                  checked: !skill.disabled,
                  label: skill.disabled ? t('status.disabled') : t('status.enabled'),
                  onChange: (next) => store.setDisabled(rootKey, skill, !next),
                }),
            h(Action, { variant: 'quiet', onClick: () => store.reveal(rootKey, skill.entryName), title: t('action.reveal') }, t('action.revealShort')),
            readOnly
              ? null
              : h(Action, { variant: 'quiet', onClick: () => store.uninstall(rootKey, skill), title: t('action.uninstall') }, t('action.uninstallShort')),
          ),
        )
      }

      /** One trashed entry. */
      function TrashRow({ rootKey, entry }) {
        return h(
          'div',
          { className: 'dsm-row' },
          h(
            'div',
            { className: 'dsm-row-main', style: { cursor: 'default' } },
            h('span', { className: 'dsm-row-name' }, h('span', { className: 'dsm-row-name-text' }, entry.name)),
            h('span', { className: 'dsm-row-desc' }, `${entry.entryName} · ${t('trash.label')}`),
          ),
          h(
            'div',
            { className: 'dsm-row-actions' },
            h(Action, { onClick: () => store.restore(rootKey, entry.entryName) }, t('action.restore')),
            h(Action, { variant: 'quiet', danger: true, onClick: () => store.purge(rootKey, entry.entryName) }, t('action.purge')),
          ),
        )
      }

      /** One root's card. */
      function RootCard({ root, query }) {
        const skills = root.skills ?? []
        const filtered = query.length === 0 ? skills : skills.filter((skill) => matchesQuery(skill, query))
        const visible = filtered.slice(0, RENDER_LIMIT)
        const hidden = filtered.length - visible.length
        const trash = root.trash ?? []
        const readOnly = root.readOnly === true
        return h(
          'section',
          { className: 'dsm-card' },
          h(
            'div',
            { className: 'dsm-card-head' },
            h(
              'div',
              { className: 'dsm-card-title' },
              h(
                'span',
                { className: 'dsm-card-name' },
                root.agent !== undefined ? h(AgentIcon, { agent: root.agent, size: 15 }) : null,
                rootLabel(root),
                h('span', { className: 'dsm-root-count' }, root.skills.length),
                root.kind === 'agent' ? h(Chip, { tone: 'muted' }, t('chip.auto')) : null,
                readOnly ? h(Chip, { tone: 'muted' }, t('chip.readOnly')) : null,
              ),
              h('span', { className: 'dsm-card-path', title: root.path }, root.path),
            ),
            h(Action, { onClick: () => store.reveal(root.key, undefined) }, t('action.revealFolder')),
            readOnly ? h(Action, { variant: 'quiet', danger: true, onClick: () => store.removeRoot(root) }, t('action.remove')) : null,
          ),
          visible.length === 0
            ? h(
                'div',
                { className: 'dsm-empty' },
                h('span', { className: 'dsm-empty-body' }, query.length > 0 ? t('empty.noMatch') : root.exists ? t('empty.rootEmpty') : t('empty.rootMissing')),
              )
            : visible.map((skill) => h(SkillRow, { key: `${root.key}:${skill.entryName}`, rootKey: root.key, skill, readOnly })),
          hidden > 0 ? h('div', { className: 'dsm-note' }, fill(t('list.limit'), { count: RENDER_LIMIT })) : null,
          !readOnly && trash.length > 0
            ? h(
                'div',
                { className: 'dsm-card-head', style: { borderTop: '0.5px solid var(--dsw-alias-border-l1)' } },
                h('div', { className: 'dsm-card-title' }, h('span', { className: 'dsm-card-name' }, fill(t('trash.title'), { count: trash.length }))),
                h(Action, { variant: 'quiet', onClick: () => store.emptyTrash(root.key) }, t('action.emptyTrash')),
              )
            : null,
          readOnly ? null : trash.map((entry) => h(TrashRow, { key: `${root.key}:trash:${entry.entryName}`, rootKey: root.key, entry })),
        )
      }

      /**
       * Subscribe the page to the store.
       *
       * `useState` over `useSyncExternalStore`: the shell may run any React
       * build, and a missing hook must not be the reason a panel is empty.
       *
       * @returns the current store snapshot.
       */
      function useStore() {
        const [snapshot, setSnapshot] = React.useState(store.getSnapshot)
        React.useEffect(() => store.subscribe(() => setSnapshot(store.getSnapshot())), [])
        return snapshot
      }

      /**
       * The panel's one scrollable list, with a thumb that fades out again.
       *
       * The Host renders a panel at a definite height and never scrolls it, so
       * the list must scroll itself. A native scrollbar would either sit there
       * permanently or (on macOS) be torn between overlay and classic modes, so
       * the native one is hidden and this draws a thumb that follows the list
       * and disappears a moment after the last scroll.
       *
       * @param props - `children` for the list, `revision` to re-measure on.
       * @returns the scrolling region.
       */
      function ScrollArea({ children, revision }) {
        const [bar, setBar] = React.useState({ on: false, top: 0, height: 0 })

        /** Recompute the thumb; `visible` decides whether it shows. */
        const sync = (visible) => {
          const node = scrollNode
          if (node === null) return
          const view = node.clientHeight
          const total = node.scrollHeight
          const height = total > view ? Math.max(26, Math.round((view * view) / total)) : 0
          const travel = view - height
          const ratio = total > view ? node.scrollTop / (total - view) : 0
          const next = {
            on: visible && height > 0,
            top: Math.round(travel * Math.min(1, Math.max(0, ratio))),
            height,
          }
          setBar((previous) =>
            previous.on === next.on && previous.top === next.top && previous.height === next.height ? previous : next,
          )
        }

        React.useEffect(() => {
          const node = scrollNode
          if (node === null) return undefined
          const reveal = () => {
            sync(true)
            if (scrollTimer !== 0) clearTimeout(scrollTimer)
            scrollTimer = setTimeout(() => {
              scrollTimer = 0
              sync(false)
            }, 700)
          }
          sync(false)
          node.addEventListener('scroll', reveal, { passive: true })
          return () => {
            node.removeEventListener('scroll', reveal)
            if (scrollTimer !== 0) {
              clearTimeout(scrollTimer)
              scrollTimer = 0
            }
          }
        }, [])

        // Content can change height without a scroll (a refresh, a filter):
        // re-measure after every render, hidden as it currently is. `sync`
        // returns the previous state unchanged when nothing moved, so this
        // cannot loop.
        React.useEffect(() => {
          sync(bar.on)
        })

        return h(
          'div',
          { className: 'dsm-body', 'data-dsm-scroll': String(revision) },
          h(
            'div',
            {
              className: 'dsm-list',
              ref: (node) => {
                scrollNode = node
              },
            },
            children,
          ),
          h('div', { className: 'dsm-thumb', 'data-on': bar.on ? 'true' : 'false', style: { top: `${bar.top}px`, height: `${bar.height}px` } }),
        )
      }

      /** The page. */
      function SkillsPage() {
        const state = useStore()
        React.useEffect(() => {
          store.refresh()
        }, [])

        const roots = state.data?.roots ?? []
        const visibleRoots = state.rootFilter === undefined ? roots : roots.filter((root) => root.key === state.rootFilter)
        const total = roots.reduce((sum, root) => sum + (root.skills?.length ?? 0), 0)
        const enabled = roots.reduce((sum, root) => sum + (root.skills ?? []).filter((skill) => !skill.disabled).length, 0)
        // A target must be writable: DSH would not scan an added directory, and
        // the Host refuses to change one anyway.
        const manageable = roots.filter((root) => root.readOnly !== true && (root.kind === 'user' || root.exists))
        // The filter may point at a read-only library, which cannot be a target.
        // Falling back to the first writable root keeps the dialogs usable
        // instead of preselecting a root the Host will refuse.
        const defaultRoot = manageable.some((root) => root.key === state.rootFilter) ? state.rootFilter : manageable[0]?.key
        const warnings = state.data?.warnings ?? []

        return h(
          'div',
          { className: 'dsm-page' },
          h('style', null, stylesheet()),
          h(
            'div',
            { className: 'dsm-head' },
            h('h2', { className: 'dsm-title' }, t('title')),
            h('p', { className: 'dsm-subtitle' }, fill(t('subtitle'), { total, roots: roots.length, enabled })),
          ),
          h(
            'div',
            { className: 'dsm-toolbar' },
            h(
              'div',
              { className: 'dsm-grow' },
              h('input', {
                className: 'dsm-search',
                type: 'search',
                value: state.query,
                placeholder: t('search.placeholder'),
                'aria-label': t('search.label'),
                onChange: (event) => store.setQuery(event.target.value),
              }),
            ),
            h(Action, { variant: 'primary', onClick: () => store.setDialog({ kind: 'create' }) }, t('action.create')),
            h(Action, { onClick: () => store.setDialog({ kind: 'install' }) }, t('action.install')),
            h(Action, { onClick: () => store.setDialog({ kind: 'remote' }) }, t('action.importRemote')),
            h(Action, { onClick: () => store.setDialog({ kind: 'add-root' }) }, t('action.addRoot')),
            h(
              Action,
              {
                variant: 'quiet',
                onClick: () => store.refresh({ manual: true }),
                disabled: state.loading || state.refreshing,
              },
              state.refreshing ? t('action.reloading') : t('action.reload'),
            ),
            // A reload that finds the same disk changes nothing on screen. The
            // stamp is the visible proof that the read ran, and `data-dsm-read`
            // lets a test observe it without scraping formatted text.
            h(
              'span',
              { className: 'dsm-read-stamp', 'data-dsm-read': String(state.refreshedAt) },
              formatClock(state.refreshedAt) === ''
                ? ''
                : fill(t('meta.refreshed'), { time: formatClock(state.refreshedAt) }),
            ),
          ),
          roots.length > 1
            ? h(
                'div',
                { className: 'dsm-roots' },
                h(
                  'button',
                  { type: 'button', className: 'dsm-root-tab', 'aria-pressed': state.rootFilter === undefined, onClick: () => store.setRootFilter(undefined) },
                  t('filter.all'),
                  h('span', { className: 'dsm-root-count' }, String(total)),
                ),
                roots.map((root) =>
                  h(
                    'button',
                    {
                      key: root.key,
                      type: 'button',
                      className: 'dsm-root-tab',
                      'aria-pressed': state.rootFilter === root.key,
                      onClick: () => store.setRootFilter(root.key),
                    },
                    root.agent !== undefined ? h(AgentIcon, { agent: root.agent, size: 13 }) : null,
                    rootLabel(root),
                    h('span', { className: 'dsm-root-count' }, String(root.skills?.length ?? 0)),
                  ),
                ),
              )
            : null,
          state.notice ? h('div', { className: cx('dsm-note', state.notice.tone === 'success' && 'dsm-note-success'), role: 'status' }, state.notice.text) : null,
          state.error ? h('div', { className: 'dsm-note dsm-note-error', role: 'alert' }, state.error) : null,
          warnings.length > 0 ? h('div', { className: 'dsm-note' }, warnings.map((warning) => String(warning?.message ?? '')).join(' · ')) : null,
          h(
            ScrollArea,
            { revision: `${total}:${visibleRoots.length}` },
            state.loading && state.data === undefined
              ? h('div', { className: 'dsm-empty' }, h('span', { className: 'dsm-empty-body' }, t('loading.page')))
              : visibleRoots.length === 0
                ? h(
                    'div',
                    { className: 'dsm-empty' },
                    h('span', { style: { color: 'var(--dsw-alias-label-secondary)' } }, h(SkillsMark)),
                    h('span', { className: 'dsm-empty-title' }, t('empty.title')),
                    h('span', { className: 'dsm-empty-body' }, t('empty.body')),
                  )
                : visibleRoots.map((root) => h(RootCard, { key: root.key, root, query: state.query })),
          ),
          state.detail ? h(DetailDialog, { detail: state.detail }) : null,
          state.dialog?.kind === 'create' && manageable.length > 0 ? h(CreateDialog, { roots: manageable, defaultRootKey: defaultRoot }) : null,
          state.dialog?.kind === 'add-root' ? h(AddRootDialog, null) : null,
          state.dialog?.kind === 'install'
            ? h(InstallDialog, { roots: manageable, defaultRootKey: defaultRoot, source: state.dialog.source })
            : null,
          state.dialog?.kind === 'remote'
            ? h(RemoteInstallDialog, {
                roots: manageable,
                defaultRootKey: defaultRoot,
                dialog: state.dialog,
                busy: state.busy,
              })
            : null,
        )
      }

      /**
       * The page wrapped so a render failure is visible instead of blank.
       *
       * An exception thrown while painting a slot makes the shell drop the
       * entry and leave an empty column with no clue; this keeps the message on
       * screen where the person who hit it can read it.
       */
      function SkillsPanel() {
        try {
          return h(SkillsPage, null)
        } catch (error) {
          const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
          return h(
            'div',
            { className: 'dsm-page' },
            h('style', null, stylesheet()),
            h('h2', { className: 'dsm-title' }, t('title')),
            h('div', { className: 'dsm-note dsm-note-error', role: 'alert' }, `${t('error.render')} ${message}`),
          )
        }
      }

      /** The navigation row's icon. */
      function SidebarIcon(props) {
        return h(SkillsGlyph, { size: props?.size ?? 16 })
      }

      return { SkillsPanel, SidebarIcon }
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        const locale = ctx.locale
        const t = (key, params) => fill(dictionaryFor(locale)[key] ?? EN[key] ?? key, params)

        const store = createStore(t)
        const { SkillsPanel, SidebarIcon } = createUi(store, t)

        // The Host notifies every namespace on a language switch; without this
        // the panel would keep the strings it painted with.
        ctx.on('locale/change', () => store.bumpLanguage())

        // The navigation row and the page it opens share one id, which is how
        // the layout addresses a panel: the sidebar owns the button, `main`
        // renders whatever registered under the key it dispatches.
        ctx.slots.inject('sidebar.panellist', () =>
          ctx.slots.register({ name: 'sidebar.panellist', id: PANEL_ID, order: 20, label: () => t('title') }, SidebarIcon),
        )

        ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: PANEL_ID }, SkillsPanel))
      },
    }
  },
})

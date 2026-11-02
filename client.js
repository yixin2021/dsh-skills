/**
 * DSH Skills — Client half.
 *
 * Two surfaces over one store:
 *   - a Skills row in the left navigation (`sidebar.panellist`), whose label is
 *     localized and whose selected state comes from the layout owner,
 *   - the page that row opens (`main`, keyed by the same id), listing every
 *     managed root with its skills, enabling and disabling them, previewing an
 *     instruction file, creating a new skill, installing one from disk, and
 *     restoring or purging what was uninstalled.
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
      'root.dsh': 'Personal · ~/.dsh/skills',
      'root.agents': 'Agents · ~/.agents/skills',
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
      'empty.body': 'Install a folder that contains SKILL.md, or write one with New skill. Disabled skills stay on disk under .disabled and disappear from every catalog.',
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
      'notice.enabled': '{name} is enabled.',
      'notice.disabled': '{name} is disabled and hidden from every catalog.',
      'notice.trashed': '{name} moved to the trash. Restore it from the root card.',
      'notice.restored': '{name} is restored.',
      'notice.purged': '{name} is permanently deleted.',
      'notice.trashEmptied': 'Removed {count} entries from the trash.',
      'notice.created': '{name} was created.',
      'notice.installed': '{name} was installed.',
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
      'root.dsh': '个人 · ~/.dsh/skills',
      'root.agents': 'Agents · ~/.agents/skills',
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
      'empty.body': '安装一个包含 SKILL.md 的文件夹，或用「新建技能」写一个。停用的技能保留在磁盘的 .disabled 目录里，对所有目录不可见。',
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
      'notice.enabled': '已启用 {name}。',
      'notice.disabled': '已停用 {name}，它将从所有目录中隐藏。',
      'notice.trashed': '{name} 已移入回收站，可在对应根目录卡片中恢复。',
      'notice.restored': '已恢复 {name}。',
      'notice.purged': '已彻底删除 {name}。',
      'notice.trashEmptied': '已清空回收站中的 {count} 项。',
      'notice.created': '已创建 {name}。',
      'notice.installed': '已安装 {name}。',
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
     * The hammer: one silhouette at every size.
     *
     * Drawn in a 16-unit box and scaled, so the navigation glyph, the empty
     * state and `icon.svg` cannot drift apart. The head is a wide block, the
     * claw splits its left end, and the handle drops from the head's middle —
     * a plain bar-and-stick reads as a letter T or a chevron instead.
     */
    const HAMMER = {
      head: 'M3.4 3H11.3A1.7 1.7 0 0 1 13 4.7V5.5A1.7 1.7 0 0 1 11.3 7.2H4.8L2 6.5 3.5 5.1 1.7 4.2Z',
      handle: { x: 7.3, y: 6.8, width: 1.7, height: 7.8, rx: 0.85 },
    }

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
        h('g', { transform: 'rotate(-16 8 8)' }, h('path', { d: HAMMER.head }), h('rect', HAMMER.handle)),
      )
    }

    /** The panel's own mark, used in the empty state. */
    function SkillsMark({ size = 40 }) {
      return h(
        'svg',
        {
          viewBox: '0 0 48 48',
          width: size,
          height: size,
          fill: 'currentColor',
          'aria-hidden': true,
          focusable: 'false',
          style: { display: 'block' },
        },
        h(
          'g',
          { transform: 'rotate(-16 24 24) scale(3)' },
          h('path', { d: HAMMER.head }),
          h('rect', HAMMER.handle),
        ),
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
        '.dsm-card-name{font-size:13px;font-weight:600}',
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

      /** @returns the readable name of one root. */
      function rootLabel(root) {
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
      function InstallDialog({ roots, defaultRootKey }) {
        const [rootKey, setRootKey] = React.useState(defaultRootKey)
        return h(
          Dialog,
          {
            title: t('install.title'),
            subtitle: t('install.subtitle'),
            onClose: () => store.setDialog(undefined),
            footer: [
              h(Action, { key: 'cancel', onClick: () => store.setDialog(undefined) }, t('action.cancel')),
              h(Action, { key: 'pick', variant: 'primary', onClick: () => store.installFromFolder(rootKey) }, t('install.pick')),
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
            h('div', { className: 'dsm-note' }, t('install.hint')),
          ),
        )
      }

      /** One skill row. */
      function SkillRow({ rootKey, skill }) {
        const issues = skill.issues ?? []
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
            h(Toggle, {
              checked: !skill.disabled,
              label: skill.disabled ? t('status.disabled') : t('status.enabled'),
              onChange: (next) => store.setDisabled(rootKey, skill, !next),
            }),
            h(Action, { variant: 'quiet', onClick: () => store.reveal(rootKey, skill.entryName), title: t('action.reveal') }, t('action.revealShort')),
            h(Action, { variant: 'quiet', onClick: () => store.uninstall(rootKey, skill), title: t('action.uninstall') }, t('action.uninstallShort')),
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
        return h(
          'section',
          { className: 'dsm-card' },
          h(
            'div',
            { className: 'dsm-card-head' },
            h(
              'div',
              { className: 'dsm-card-title' },
              h('span', { className: 'dsm-card-name' }, rootLabel(root)),
              h('span', { className: 'dsm-card-path', title: root.path }, root.path),
            ),
            h(Action, { onClick: () => store.reveal(root.key, undefined) }, t('action.revealFolder')),
          ),
          visible.length === 0
            ? h(
                'div',
                { className: 'dsm-empty' },
                h('span', { className: 'dsm-empty-body' }, query.length > 0 ? t('empty.noMatch') : root.exists ? t('empty.rootEmpty') : t('empty.rootMissing')),
              )
            : visible.map((skill) => h(SkillRow, { key: `${root.key}:${skill.entryName}`, rootKey: root.key, skill })),
          hidden > 0 ? h('div', { className: 'dsm-note' }, fill(t('list.limit'), { count: RENDER_LIMIT })) : null,
          trash.length > 0
            ? h(
                'div',
                { className: 'dsm-card-head', style: { borderTop: '0.5px solid var(--dsw-alias-border-l1)' } },
                h('div', { className: 'dsm-card-title' }, h('span', { className: 'dsm-card-name' }, fill(t('trash.title'), { count: trash.length }))),
                h(Action, { variant: 'quiet', onClick: () => store.emptyTrash(root.key) }, t('action.emptyTrash')),
              )
            : null,
          trash.map((entry) => h(TrashRow, { key: `${root.key}:trash:${entry.entryName}`, rootKey: root.key, entry })),
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
        const defaultRoot = state.rootFilter ?? roots[0]?.key
        const manageable = roots.filter((root) => root.kind === 'user' || root.exists)
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
          state.dialog?.kind === 'install' && manageable.length > 0 ? h(InstallDialog, { roots: manageable, defaultRootKey: defaultRoot }) : null,
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

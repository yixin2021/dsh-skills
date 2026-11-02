---
description: "DeepSeek Harness 技能管理插件：在左侧导航中提供「技能」入口，列出、预览、启用/停用、安装与卸载 Agent 技能。"
kind: "plugin-readme"
---

# dsh-skills

[English](README.md) | 中文

在 DeepSeek Harness 左侧导航中加入一行 **技能**，以及点击后打开的技能管理页面。

DSH 会从用户目录和项目目录下的 `.dsh/skills`、`.agents/skills` 中发现 Agent 技能，
但本身没有提供查看已安装技能、或在不改文件的前提下临时关掉某个技能的界面。
本插件补上这块。

## 面板能做什么

| | |
|---|---|
| **总览** | DSH 扫描的每一个根目录，以及每个技能的名称、描述、指令文件路径和调用策略。 |
| **预览** | 直接在应用内读完整的 `SKILL.md`——frontmatter 与正文。 |
| **启用 / 停用** | 每个技能一个开关。停用的技能字节不动，仍留在磁盘上。 |
| **安装** | 把顶层含 `SKILL.md` 的文件夹复制进指定根目录。原目录不会被移动。 |
| **新建技能** | 用表单写一个带合法 frontmatter 的技能包。 |
| **安全卸载** | 卸载只是把条目移进根目录下的 `.trash`，之后可恢复，也可彻底删除。 |
| **定位** | 在访达 / 资源管理器 / 桌面文件管理器中显示技能或根目录。 |

## 安装

**从 GitHub 安装。** 本仓库就是一个可直接安装的包：`package.json` 在根部，
没有构建步骤，所以任何 npm 兼容的 git 规格都能解析。在插件管理器
（设置 → 插件）里安装：

```
github:yixin2021/dsh-skills
```

同一条规格也适用于 CLI——`dsh plugin` 会把参数原样转给 profile 里的 pnpm：

```sh
dsh plugin --profile desktop add github:yixin2021/dsh-skills
dsh plugin --profile desktop remove dsh-skills
```

`https://github.com/yixin2021/dsh-skills` 与
`git+ssh://git@github.com/yixin2021/dsh-skills.git` 等价。

**从本地目录安装。**

```sh
dsh plugin --profile desktop add /absolute/path/to/dsh-skills
```

bundle patch 会插入一个名为 `skills` 的 Loader 行；客户端部分负责挂载导航行和面板。
安装后刷新窗口即可。

## 实现方式

**宿主侧**（`index.js`）在 `ctx.connection.fetch` 上注册一个需要鉴权的 JSON 路由
`POST /api/dsh-skills`，处理 `list`、`read`、`set-disabled`、`trash`、`restore`、
`purge`、`empty-trash`、`create`、`import-directory`、`import-files`、`reveal`。
`lib/skills-core.js` 负责技能语法本身——frontmatter 解析、根目录发现、条目扫描——
路由和测试因此共用同一套「什么算一个技能」的定义。

**客户端侧**（`client.js`）在 `sidebar.panellist` 中用 id `dsh-skills` 注册一个图标，
并在 `main` 中注册同一个 id 作为 key 的面板——布局正是靠这个 id 把导航行和面板对上。
它自己从不读技能目录：所有事实都经由路由取得，浏览器没有任何文件系统权限。

### 停用而不删除

DSH 只发现技能根的**直接子项**。被停用的技能会被移到 `<root>/.disabled/<name>`——
隐藏、因此对所有 provider 不可见——重新启用时原样移回。`SKILL.md` 一个字节都不会被改写，
手写的技能可以完整往返。`.trash` 用的是同一套办法。

### 边界

所有写操作都经过 `resolveWithin`，路径一旦离开根目录即被拒绝。技能名需匹配
`^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`；请求的条目必须确实存在于它声称的位置；
新建或安装不会覆盖已存在（含已停用、已在回收站）的同名条目。

## UI 规范

- 只使用宿主主题 token（`--dsw-alias-*`），没有自带调色板，深色与浅色主题都成立。
- 所有可见文案取自由宿主语言快照选中的中英双词典（`inject: ['slots', 'locale']`），
  并订阅 `locale/change` 在切换语言时重绘；导航行 label 是函数，同样跟随切换。
  刻意不读 `navigator.language`：在桌面壳里它反映的是系统 Chromium 语言，
  并不跟随宿主的渲染语言。
- 这里的 `React` 是宿主裁剪过的对象，只暴露 `createElement`、`useState`、`useEffect`。
  面板只用这三个；`useSyncExternalStore`、`useRef`、`memo` 之类都是 `undefined`，
  在渲染时调用会抛错，最终表现为面板空白。
- 不引入任何 Harness 客户端包。所有控件都是普通元素 + 主题 token 样式，
  不会因为缺少原语模块或属性名猜错而挂掉。
- 弹层带 `role="dialog"` / `aria-modal`，支持 Esc 与点击遮罩关闭；
  启用/停用是带可访问名称的真实 checkbox。
- 除面板之外的 DOM 一律不碰；除选择文件夹时临时插入、关闭即移除的 input 外，
  不向 `document.body` 追加任何节点。

## 测试

```sh
npm test
```

先对三个源文件跑 `node --check`，再在真实临时目录上跑 25 项文件系统测试：
frontmatter 解析（引号标量、注释、块标量、非法布尔写法）、路径包含、根目录发现、
仅扫描直接子项、以及包括各种拒绝分支在内的全部变更操作。

## 已知限制

- `import-files` 以文本传输，不携带二进制文件；需要资源文件时用 `import-directory`，
  或安装后再把资源复制进技能包。
- 不在 DSH 扫描的四个根目录内的技能不会列出——DSH 本身也不会加载它。
- 面板显示的是根目录当前的状态，不监听文件系统；在磁盘上改过文件后请点「刷新」。

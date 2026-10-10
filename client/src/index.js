/**
 * client/src/index.js — NPM Manager 的 Settings **独立标签页**（源码）
 *
 * ⚠️ 本文件是 **factory 体**，不是独立模块：
 *    scripts/build-client.mjs 会把它嵌进
 *      window.__ModuleLoader__.load({ id, factory: (require) => { var module = {exports:{}}; ... <本文件> ...; return module.exports } })
 *    因此这里：
 *      - 直接用 require(...)，不写 import
 *      - 赋值到 exports.*，不写 export
 *      - **不要**自己写 `return module.exports`（由 wrapper 负责）
 *
 * 注册面：`settings.section`（Settings 左侧导航里的一整页）。
 * 三个范围：project 本项目 / global 全局 / system 全系统。
 *
 * 加载策略（2026-09-19 起）：
 *   - **流式**：`/packages?stream=1` 逐条推包，前端"识别到几个就先列几个"，
 *     不等全部扫完 —— 否则全系统 200+ 包要几十秒，界面长时间空白会被当成宕机。
 *   - **缓存**：同一 (scope, projectPath) 命中本地缓存时不发任何请求。
 *   - 只有首次访问某组合、或点「刷新缓存」才真正重新扫描。
 *
 * 契约依据（全部来自本机实测，见 dsh-plugin-conformance §17/§22）：
 *   1. `settings.section` 的 `label` 可以是函数；`id` 决定标识，`order` 决定排序。
 *   2. 组件必须是 **React 组件**（渲染器走 jsx(Comp, props)），返回普通对象会抛
 *      "Objects are not valid as a React child"。
 *   3. `locale` 必须是**命名空间字符串**，字典另用 ctx.locale.register 注册。
 *   4. 加载期不得 console.*（会污染宿主 stdout）。
 */

var react = require('react')

var NS = 'npm-manager'
var API = '/plugins/npm-manager'
var CUSTOM = '__custom__'
var ALL_PROJECTS = '__all__'
/** 流式推送时最多多久刷新一次界面（毫秒）—— 避免 200+ 次 setState 造成卡顿 */
var FLUSH_INTERVAL_MS = 120

/* ─────────────────────────── 字典 ─────────────────────────── */

var zh = {
  nav: 'NPM 管理器',
  title: 'NPM 管理器',
  subtitle: '查看本机已安装的 npm 包与可用升级。数据来自各项目的 package.json 与 npm registry。',
  scopeProject: '本项目',
  scopeGlobal: '全局',
  scopeSystem: '全系统',
  scopeLabel: '范围',
  projectLabel: '项目',
  projectCustom: '自定义路径…',
  projectPathPlaceholder: '输入项目目录绝对路径，回车应用',
  apply: '应用',
  filterProject: '项目',
  allProjects: '全部项目',
  search: '搜索包名…',
  onlyOutdated: '仅看可升级',
  refresh: '刷新缓存',
  refreshing: '刷新中…',
  scanning: '正在扫描…',
  loadingMore: '正在加载',
  loaded: '已加载',
  connecting: '正在连接…',
  empty: '没有找到已安装的包。',
  emptyHint: '该目录下没有 package.json，或它没有声明依赖。',
  emptyFiltered: '没有符合筛选条件的包。',
  failed: '加载失败',
  retry: '重试',
  statTotal: '共',
  statUnit: '个包',
  statOutdated: '个可升级',
  statProjects: '个项目',
  upToDate: '全部已是最新',
  dataAt: '数据',
  cachedTag: '缓存',
  refreshHint: '切换范围或项目不会重新扫描，直接用缓存；需要最新数据请点「刷新缓存」。',
  colPackage: '包名',
  colVersion: '当前版本',
  colLatest: '最新版本',
  colProject: '项目',
  colNote: '说明',
  badgeMajor: '主版本',
  badgeMinor: '次版本',
  badgePatch: '补丁',
  badgeDowngrade: '降级',
  unknown: '—',
  dev: 'dev',
  missing: '目录不存在',
  /* ── 配置表单 ── */
  cfg: '配置',
  cfgHint: '改动会写入 ~/.dsh/settings.yaml 并立即生效。',
  cfgUnwritable: '当前宿主不允许写入配置，请改 profile 的 cordis.patch.yml。',
  cfgSave: '保存',
  cfgSaving: '保存中…',
  cfgSaved: '已保存',
  cfgReset: '还原',
  cfgDirty: '有未保存的改动',
  f_scope: '默认范围',
  f_projectScanDepth: '项目扫描深度',
  f_requestTimeoutMs: '请求超时',
  f_listCacheTtlMs: '结果缓存时长',
  f_registryCacheTtlMs: 'registry 缓存时长',
  f_diskCache: '启用磁盘缓存',
  f_diskCacheTtlMs: '磁盘缓存时长',
  f_diskCacheDir: '磁盘缓存目录',
  f_enableChangelog: '拉取 changelog',
  f_npmCommandTimeoutMs: 'npm 命令超时',
  fHint_projectScanDepth: '从每个工作区往下发现 Node 项目的层数',
  fHint_requestTimeoutMs: '单个 registry 请求超时；网络慢时调大',
  fHint_listCacheTtlMs: '切换范围/项目时复用结果的时长',
  fHint_diskCache: '关掉后每次重启都要重新拉全部包（慢）',
  fHint_diskCacheDir: '留空则用 ~/.dsh/npm-manager',
  fHint_enableChangelog: '为单包详情拉取更新日志',
}

var en = {
  nav: 'NPM Manager',
  title: 'NPM Manager',
  subtitle: 'Installed npm packages and available upgrades. Data from each project\'s package.json and the npm registry.',
  scopeProject: 'This project',
  scopeGlobal: 'Global',
  scopeSystem: 'System-wide',
  scopeLabel: 'Scope',
  projectLabel: 'Project',
  projectCustom: 'Custom path…',
  projectPathPlaceholder: 'Enter an absolute project directory, press Enter',
  apply: 'Apply',
  filterProject: 'Project',
  allProjects: 'All projects',
  search: 'Search packages…',
  onlyOutdated: 'Outdated only',
  refresh: 'Refresh cache',
  refreshing: 'Refreshing…',
  scanning: 'Scanning…',
  loadingMore: 'Loading',
  loaded: 'Loaded',
  connecting: 'Connecting…',
  empty: 'No installed packages found.',
  emptyHint: 'That directory has no package.json, or it declares no dependencies.',
  emptyFiltered: 'No packages match the filter.',
  failed: 'Failed to load',
  retry: 'Retry',
  statTotal: 'Total',
  statUnit: 'packages',
  statOutdated: 'outdated',
  statProjects: 'projects',
  upToDate: 'all up to date',
  dataAt: 'Data',
  cachedTag: 'cached',
  refreshHint: 'Switching scope or project reuses the cache instead of rescanning. Click "Refresh cache" for fresh data.',
  colPackage: 'Package',
  colVersion: 'Current',
  colLatest: 'Latest',
  colProject: 'Project',
  colNote: 'Description',
  badgeMajor: 'major',
  badgeMinor: 'minor',
  badgePatch: 'patch',
  badgeDowngrade: 'downgrade',
  unknown: '—',
  dev: 'dev',
  missing: 'directory missing',
  /* ── config form ── */
  cfg: 'Config',
  cfgHint: 'Changes are written to ~/.dsh/settings.yaml and take effect immediately.',
  cfgUnwritable: 'This host does not allow writing settings; edit cordis.patch.yml in the profile instead.',
  cfgSave: 'Save',
  cfgSaving: 'Saving…',
  cfgSaved: 'Saved',
  cfgReset: 'Reset',
  cfgDirty: 'unsaved changes',
  f_scope: 'Default scope',
  f_projectScanDepth: 'Project scan depth',
  f_requestTimeoutMs: 'Request timeout',
  f_listCacheTtlMs: 'Result cache TTL',
  f_registryCacheTtlMs: 'Registry cache TTL',
  f_diskCache: 'Enable disk cache',
  f_diskCacheTtlMs: 'Disk cache TTL',
  f_diskCacheDir: 'Disk cache dir',
  f_enableChangelog: 'Fetch changelog',
  f_npmCommandTimeoutMs: 'npm command timeout',
  fHint_projectScanDepth: 'Levels to descend from each workspace when discovering Node projects',
  fHint_requestTimeoutMs: 'Timeout for a single registry request; raise it on slow networks',
  fHint_listCacheTtlMs: 'How long results are reused when switching scope/project',
  fHint_diskCache: 'When off, every restart refetches all packages (slow)',
  fHint_diskCacheDir: 'Empty means ~/.dsh/npm-manager',
  fHint_enableChangelog: 'Fetch release notes for package detail',
}

/* ─────────────────────────── 样式 ─────────────────────────── */

var CSS = [
  '.npmgr-root{font-size:13px;line-height:1.6}',
  '.npmgr-head{display:flex;align-items:flex-start;gap:16px;margin-bottom:4px}',
  '.npmgr-title{font-size:15px;font-weight:600;margin:0 0 4px}',
  '.npmgr-sub{font-size:12.5px;opacity:.62;margin:0;max-width:660px}',
  '.npmgr-actions{margin-left:auto;display:flex;gap:8px;flex-shrink:0}',
  '.npmgr-btn{padding:4px 12px;font-size:12px;cursor:pointer;border-radius:6px;',
  '  border:1px solid var(--vscode-panel-border,rgba(127,127,127,.32));background:transparent;color:inherit;white-space:nowrap}',
  '.npmgr-btn:hover:not(:disabled){background:rgba(127,127,127,.12)}',
  '.npmgr-btn:disabled{opacity:.55;cursor:default}',
  '.npmgr-bar{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin:16px 0 10px}',
  '.npmgr-seg{display:inline-flex;border:1px solid var(--vscode-panel-border,rgba(127,127,127,.32));border-radius:6px;overflow:hidden;flex-shrink:0}',
  '.npmgr-seg button{padding:3px 12px;font-size:12px;cursor:pointer;border:none;background:transparent;color:inherit;white-space:nowrap}',
  '.npmgr-seg button+button{border-left:1px solid var(--vscode-panel-border,rgba(127,127,127,.22))}',
  '.npmgr-seg button[aria-pressed="true"]{background:rgba(127,127,127,.22);font-weight:600}',
  '.npmgr-field{display:inline-flex;align-items:center;gap:6px;font-size:12px;opacity:.75;flex-shrink:0}',
  '.npmgr-select{max-width:280px;padding:3px 8px;font-size:12.5px;border-radius:6px;',
  '  border:1px solid var(--vscode-panel-border,rgba(127,127,127,.32));background:transparent;color:inherit}',
  '.npmgr-input{flex:1 1 180px;min-width:150px;max-width:260px;padding:4px 10px;font-size:12.5px;border-radius:6px;',
  '  border:1px solid var(--vscode-panel-border,rgba(127,127,127,.32));background:transparent;color:inherit}',
  '.npmgr-input::placeholder{opacity:.5}',
  '.npmgr-path{flex:1 1 320px;max-width:520px;padding:4px 10px;font-size:12px;border-radius:6px;',
  '  border:1px solid var(--vscode-panel-border,rgba(127,127,127,.32));background:transparent;color:inherit;',
  '  font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}',
  '.npmgr-check{display:inline-flex;align-items:center;gap:6px;font-size:12.5px;cursor:pointer;user-select:none;white-space:nowrap}',
  '.npmgr-stats{margin-left:auto;font-size:12.5px;opacity:.72;white-space:nowrap;display:inline-flex;align-items:center}',
  '.npmgr-stats b{font-weight:600}',
  /* 进度条：已知总量走确定性填充，未知走不确定滑动 */
  '.npmgr-track{position:relative;height:2px;border-radius:2px;overflow:hidden;background:rgba(127,127,127,.16);margin:0 0 10px}',
  '.npmgr-fill{position:absolute;top:0;bottom:0;left:0;background:currentColor;opacity:.5;transition:width .25s ease}',
  '.npmgr-slide{position:absolute;top:0;bottom:0;width:34%;background:currentColor;opacity:.45;animation:npmgr-slide 1.15s ease-in-out infinite}',
  '@keyframes npmgr-slide{0%{left:-34%}100%{left:100%}}',
  /* 旋转指示器 */
  '.npmgr-spin{display:inline-block;width:11px;height:11px;border-radius:50%;flex-shrink:0;',
  '  border:2px solid currentColor;border-top-color:transparent;opacity:.75;',
  '  animation:npmgr-rotate .7s linear infinite;vertical-align:-1px;margin-right:6px}',
  '@keyframes npmgr-rotate{to{transform:rotate(360deg)}}',
  '.npmgr-wrap{border:1px solid var(--vscode-panel-border,rgba(127,127,127,.22));border-radius:8px;overflow:auto;max-height:calc(100vh - 340px)}',
  '.npmgr-table{width:100%;table-layout:fixed;border-collapse:collapse;font-size:12.5px}',
  '.npmgr-table th{position:sticky;top:0;z-index:1;text-align:left;font-weight:600;font-size:12px;opacity:.72;',
  '  padding:8px 12px;background:var(--vscode-editor-background,#fff);white-space:nowrap;',
  '  border-bottom:1px solid var(--vscode-panel-border,rgba(127,127,127,.28))}',
  '.npmgr-table td{padding:7px 12px;border-bottom:1px solid rgba(127,127,127,.10);vertical-align:top}',
  '.npmgr-table tbody tr:last-child td{border-bottom:none}',
  '.npmgr-table tbody tr:hover{background:rgba(127,127,127,.07)}',
  '.npmgr-mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;white-space:nowrap;',
  '  overflow:hidden;text-overflow:ellipsis}',
  '.npmgr-mono-name{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;overflow-wrap:anywhere}',
  '.npmgr-name{display:flex;align-items:center;gap:6px;flex-wrap:wrap}',
  '.npmgr-badge{display:inline-block;font-size:10.5px;line-height:15px;padding:0 6px;border-radius:9px;',
  '  border:1px solid currentColor;opacity:.85;white-space:nowrap;flex-shrink:0}',
  '.npmgr-badge-dev{opacity:.5;font-size:10px;border-style:dashed}',
  '.npmgr-proj{font-size:12px;opacity:.8;overflow-wrap:anywhere}',
  '.npmgr-desc{opacity:.6;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
  '.npmgr-old{opacity:.5;text-decoration:line-through}',
  '.npmgr-new{font-weight:600}',
  '.npmgr-msg{padding:34px 4px;text-align:center;font-size:12.5px;opacity:.7}',
  '.npmgr-msg-sub{margin-top:6px;font-size:11.5px;opacity:.6}',
  '.npmgr-err{margin:16px 0;padding:14px 16px;border-radius:8px;font-size:12.5px;',
  '  border:1px solid rgba(220,80,80,.45);background:rgba(220,80,80,.07)}',
  '.npmgr-err .npmgr-btn{margin-top:10px}',
  /* 配置表单 */
  '.npmgr-cfg{margin:18px 0 4px;border-top:1px solid var(--vscode-panel-border,rgba(127,127,127,.22));padding-top:12px}',
  '.npmgr-cfg-toggle{display:inline-flex;align-items:center;gap:6px;font-size:12.5px;cursor:pointer;',
  '  user-select:none;background:none;border:none;color:inherit;padding:0}',
  '.npmgr-cfg-toggle:hover{opacity:.8}',
  '.npmgr-cfg-body{margin-top:12px;display:grid;grid-template-columns:repeat(auto-fill,minmax(270px,1fr));gap:12px 20px}',
  '.npmgr-cfg-item{display:flex;flex-direction:column;gap:3px;min-width:0}',
  '.npmgr-cfg-label{font-size:12.5px;display:flex;align-items:baseline;gap:6px}',
  '.npmgr-cfg-unit{opacity:.5;font-size:11px;font-family:ui-monospace,Menlo,Consolas,monospace}',
  '.npmgr-cfg-hint{font-size:11px;opacity:.5}',
  '.npmgr-cfg-row{display:flex;align-items:center;gap:8px}',
  '.npmgr-cfg-num,.npmgr-cfg-text{padding:3px 8px;font-size:12.5px;border-radius:6px;',
  '  border:1px solid var(--vscode-panel-border,rgba(127,127,127,.32));background:transparent;color:inherit}',
  '.npmgr-cfg-num{width:120px}',
  '.npmgr-cfg-text{width:100%;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12px}',
  '.npmgr-cfg-foot{grid-column:1/-1;display:flex;align-items:center;gap:10px;margin-top:4px;flex-wrap:wrap}',
  '.npmgr-cfg-msg{font-size:12px}',
  '.npmgr-cfg-msg.ok{color:#1e7a4c}',
  '.npmgr-cfg-msg.err{color:#c0392b}',
  '.npmgr-cfg-note{font-size:11.5px;opacity:.5}',
].join('\n')

function ensureStyles() {
  if (typeof document === 'undefined') return
  if (document.getElementById('npm-manager-client-style')) return
  var style = document.createElement('style')
  style.id = 'npm-manager-client-style'
  style.textContent = CSS
  document.head.appendChild(style)
}

/* ─────────────────────────── 小组件 ─────────────────────────── */

function badgeText(t, updateType) {
  if (updateType === 'major') return t('badgeMajor')
  if (updateType === 'minor') return t('badgeMinor')
  if (updateType === 'patch') return t('badgePatch')
  if (updateType === 'downgrade') return t('badgeDowngrade')
  return ''
}

/** 时间戳 → HH:MM（显示"这份数据是什么时候扫的"） */
function fmtTime(ts) {
  if (typeof ts !== 'number' || !isFinite(ts)) return ''
  var d = new Date(ts)
  var h = d.getHours()
  var m = d.getMinutes()
  return (h < 10 ? '0' : '') + h + ':' + (m < 10 ? '0' : '') + m
}

/** 旋转指示器 */
function spinner() {
  return react.createElement('span', { className: 'npmgr-spin', 'aria-hidden': 'true' })
}

/** 一行包记录。返回 React 元素（绝不能返回普通对象）。 */
function PackageRow(props) {
  var t = props.t
  var p = props.pkg
  var showProject = props.showProject === true
  var outdated = p.isOutdated === true
  var badge = outdated ? badgeText(t, p.updateType) : ''
  var latest = p.latestVersion || t('unknown')

  var cells = [
    react.createElement('td', { key: 'name' },
      react.createElement('div', { className: 'npmgr-name' },
        react.createElement('span', { className: 'npmgr-mono-name' }, p.name),
        badge ? react.createElement('span', { className: 'npmgr-badge' }, badge) : null,
        p.isDev ? react.createElement('span', { className: 'npmgr-badge npmgr-badge-dev' }, t('dev')) : null)),
    react.createElement('td', { key: 'cur', className: 'npmgr-mono' + (outdated ? ' npmgr-old' : ''), title: p.currentVersion || '' },
      p.currentVersion || t('unknown')),
    react.createElement('td', { key: 'lat', className: 'npmgr-mono' + (outdated ? ' npmgr-new' : ''), title: latest }, latest),
  ]

  if (showProject) {
    cells.push(react.createElement('td', { key: 'proj' },
      react.createElement('div', { className: 'npmgr-proj', title: p.projectPath || '' }, p.project || t('unknown'))))
  }

  cells.push(react.createElement('td', { key: 'desc' },
    react.createElement('div', { className: 'npmgr-desc', title: p.description || '' }, p.description || '')))

  return react.createElement('tr', null, cells)
}

/** 空状态 —— **只在扫描真正结束后**才显示，加载中绝不显示 */
function emptyState(t) {
  return react.createElement('div', { className: 'npmgr-msg' },
    react.createElement('div', null, t('empty')),
    react.createElement('div', { className: 'npmgr-msg-sub' }, t('emptyHint')))
}

/** 把 SSE 文本解析成事件数组（用于不支持流式 body 的降级路径） */
function parseSseAll(text) {
  var out = []
  var blocks = String(text).split('\n\n')
  for (var i = 0; i < blocks.length; i++) {
    var line = blocks[i].trim()
    if (!line || line.indexOf('data:') !== 0) continue
    try { out.push(JSON.parse(line.slice(5).trim())) } catch (e) { /* 跳过坏帧 */ }
  }
  return out
}

/* ─────────────────────────── 主页面 ─────────────────────────── */

/**
 * Settings → 「NPM 管理器」整页。
 *
 * 渲染器通过 jsx(Comp, {...kit, ...injected, ...ownerProps}) 调用它，
 * kit 提供 t（来自 entry.locale 座位）。t 缺失时退化为原样返回 key。
 */
function NpmManagerSection(props) {
  var t = (props && props.t) || function (k) { return k }

  var scopeState = react.useState('project')
  var scope = scopeState[0]
  var setScope = scopeState[1]

  // 「本项目」用：选中的项目路径（空 = 用 dsh 进程 cwd）
  var projectState = react.useState('')
  var projectPath = projectState[0]
  var setProjectPath = projectState[1]

  var customState = react.useState(false)
  var custom = customState[0]
  var setCustom = customState[1]
  var draftState = react.useState('')
  var draft = draftState[0]
  var setDraft = draftState[1]

  // 「全系统」用：项目筛选（ALL_PROJECTS = 不筛）
  var filterState = react.useState(ALL_PROJECTS)
  var projectFilter = filterState[0]
  var setProjectFilter = filterState[1]

  var queryState = react.useState('')
  var query = queryState[0]
  var setQuery = queryState[1]

  var onlyState = react.useState(false)
  var onlyOutdated = onlyState[0]
  var setOnlyOutdated = onlyState[1]

  var projectsState = react.useState({ list: [], current: '' })
  var projects = projectsState[0]
  var setProjects = projectsState[1]

  /* ── 配置表单状态 ── */
  // settings：服务端下发的 {current, fields, writable}
  var settingsState = react.useState({ loaded: false, current: null, fields: [], writable: false })
  var cfgMeta = settingsState[0]
  var setCfgMeta = settingsState[1]

  var showCfgState = react.useState(false)
  var showCfg = showCfgState[0]
  var setShowCfg = showCfgState[1]

  // 只存被改过的字段（保存时作为 patch 提交）
  var draftState = react.useState({})
  var draft = draftState[0]
  var setDraft = draftState[1]

  var saveState = react.useState({ status: 'idle', error: null })
  var save = saveState[0]
  var setSave = saveState[1]

  /**
   * view.status 的取值：
   *   loading   已发起请求、还没收到任何包（显示"正在扫描" + 旋转动画）
   *   streaming 正在逐条到达（显示已到的行 + 进度条）
   *   ready     扫描结束（**只有此时才允许显示空态**）
   *   error     出错
   */
  var viewState = react.useState({
    status: 'loading', packages: [], totalCount: 0, outdatedCount: 0,
    projectCount: undefined, expected: undefined, scannedAt: undefined,
    cached: false, error: null,
  })
  var view = viewState[0]
  var setView = viewState[1]

  var busyState = react.useState(false)
  var busy = busyState[0]
  var setBusy = busyState[1]

  /**
   * 本地结果缓存：key = `scope\0projectPath`。
   * 切换范围/项目命中缓存时不发任何请求（扫描很慢，切子选项是高频操作）。
   */
  var cacheRef = react.useRef({})

  // 用 ref 承载最新请求参数，避免把 load 绑死在依赖上导致重复请求
  var reqRef = react.useRef({ scope: scope, projectPath: projectPath })
  reqRef.current = { scope: scope, projectPath: projectPath }

  // 已知项目列表（只取一次）
  react.useEffect(function () {
    var cancelled = false
    fetch(API + '/projects', { cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : null })
      .then(function (data) {
        if (cancelled || !data) return
        setProjects({ list: data.projects || [], current: data.current || '' })
      })
      .catch(function () { /* 项目列表拿不到不影响主流程 */ })
    return function () { cancelled = true }
  }, [])

  // 配置元数据（当前值 + 字段描述 + 是否可写）—— 只取一次
  react.useEffect(function () {
    var cancelled = false
    fetch(API + '/settings', { cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : null })
      .then(function (d) {
        if (cancelled || !d) return
        setCfgMeta({
          loaded: true,
          current: d.current || null,
          fields: Array.isArray(d.fields) ? d.fields : [],
          writable: d.writable === true,
        })
      })
      .catch(function () { /* 读不到配置不影响主流程 */ })
    return function () { cancelled = true }
  }, [])

  /** 提交改动 */
  var saveConfig = react.useCallback(function () {
    var patch = {}
    var n = 0
    for (var k in draft) { if (Object.prototype.hasOwnProperty.call(draft, k)) { patch[k] = draft[k]; n++ } }
    if (n === 0) { setSave({ status: 'idle', error: null }); return }
    setSave({ status: 'saving', error: null })
    fetch(API + '/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ patch: patch }),
    })
      .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, body: j } }) })
      .then(function (res) {
        if (!res.ok || !res.body || res.body.ok !== true) {
          throw new Error((res.body && res.body.error) || 'HTTP 写入失败')
        }
        setCfgMeta(function (prev) {
          return { loaded: true, current: res.body.current || prev.current, fields: prev.fields, writable: prev.writable }
        })
        setDraft({})
        setSave({ status: 'saved', error: null })
        // 配置变更已在服务端作废缓存 → 本地也清掉并重新加载
        cacheRef.current = {}
        load(true)
      })
      .catch(function (e) {
        setSave({ status: 'error', error: (e && e.message) ? e.message : String(e) })
      })
  }, [draft, load])

  /**
   * 加载当前 (scope, projectPath)。
   *
   * @param force  true = 忽略本地缓存强制重新扫描（「刷新缓存」用）
   * @param onDone 扫描结束（成功或失败）后调用 —— 用于收回按钮的 busy 状态
   * @returns 清理函数（中止请求）
   */
  var load = react.useCallback(function (force, onDone) {
    var cur = reqRef.current
    var key = cur.scope + '\u0000' + (cur.scope === 'project' ? (cur.projectPath || '') : '')
    var store = cacheRef.current
    var finish = function () { if (typeof onDone === 'function') onDone() }

    // ── 本地缓存命中：直接渲染，一个请求都不发 ──
    if (force !== true && store[key] !== undefined) {
      var hit = store[key].data
      setView({
        status: 'ready',
        packages: hit.packages || [],
        totalCount: hit.totalCount || 0,
        outdatedCount: hit.outdatedCount || 0,
        projectCount: hit.projectCount,
        expected: hit.totalCount || 0,
        scannedAt: hit.scannedAt,
        cached: true,
        error: null,
      })
      finish()
      return function () {}
    }

    var cancelled = false
    var controller = (typeof AbortController !== 'undefined') ? new AbortController() : null
    var acc = []
    var lastFlush = 0
    var expected
    var projectHint

    // 先切到 loading 并**清空上一批行** —— 保留旧行会让人以为已经加载完了
    setView({
      status: 'loading', packages: [], totalCount: 0, outdatedCount: 0,
      projectCount: undefined, expected: undefined, scannedAt: undefined,
      cached: false, error: null,
    })

    // 按 FLUSH_INTERVAL_MS 节流刷新，避免 200+ 次 setState 卡顿
    var flush = function (forceFlush) {
      var now = Date.now()
      if (!forceFlush && now - lastFlush < FLUSH_INTERVAL_MS) return
      lastFlush = now
      var snapshot = acc.slice()
      var outdated = 0
      for (var i = 0; i < snapshot.length; i++) if (snapshot[i].isOutdated === true) outdated++
      setView({
        status: 'streaming',
        packages: snapshot,
        totalCount: snapshot.length,
        outdatedCount: outdated,
        projectCount: projectHint,
        expected: expected,
        scannedAt: undefined,
        cached: false,
        error: null,
      })
    }

    var applyEvent = function (ev) {
      if (ev.type === 'meta') {
        expected = ev.total
        projectHint = ev.projectCount
        setView({
          status: 'loading', packages: [], totalCount: 0, outdatedCount: 0,
          projectCount: ev.projectCount, expected: ev.total, scannedAt: undefined,
          cached: ev.cached === true, error: null,
        })
      } else if (ev.type === 'pkg') {
        acc.push(ev.package)
        flush(false)
      } else if (ev.type === 'done') {
        store[key] = {
          data: {
            packages: acc,
            totalCount: ev.totalCount,
            outdatedCount: ev.outdatedCount,
            projectCount: ev.projectCount,
            scannedAt: ev.scannedAt,
            cached: ev.cached === true,
          },
        }
        setView({
          status: 'ready',
          packages: acc.slice(),
          totalCount: ev.totalCount,
          outdatedCount: ev.outdatedCount,
          projectCount: ev.projectCount,
          expected: ev.totalCount,
          scannedAt: ev.scannedAt,
          cached: ev.cached === true,
          error: null,
        })
        finish()
      } else if (ev.type === 'error') {
        throw new Error(ev.error || 'stream error')
      }
    }

    var url = API + '/packages?stream=1&scope=' + encodeURIComponent(cur.scope)
    if (cur.scope === 'project' && cur.projectPath) {
      url += '&project=' + encodeURIComponent(cur.projectPath)
    }

    fetch(url, { cache: 'no-store', signal: controller ? controller.signal : undefined })
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status)
        // 降级：不支持流式 body 的环境一次性解析
        if (!r.body || typeof r.body.getReader !== 'function') {
          return r.text().then(function (text) {
            var events = parseSseAll(text)
            for (var i = 0; i < events.length; i++) {
              if (cancelled) return
              applyEvent(events[i])
            }
          })
        }
        var reader = r.body.getReader()
        var decoder = new TextDecoder()
        var buffer = ''
        var pump = function () {
          return reader.read().then(function (chunk) {
            if (cancelled) return
            if (chunk.done) {
              var tail = buffer.trim()
              if (tail && tail.indexOf('data:') === 0) {
                try { applyEvent(JSON.parse(tail.slice(5).trim())) } catch (e) { /* ignore */ }
              }
              return
            }
            buffer += decoder.decode(chunk.value, { stream: true })
            var idx
            while ((idx = buffer.indexOf('\n\n')) >= 0) {
              var frame = buffer.slice(0, idx).trim()
              buffer = buffer.slice(idx + 2)
              if (!frame || frame.indexOf('data:') !== 0) continue
              try { applyEvent(JSON.parse(frame.slice(5).trim())) } catch (e) { /* 跳过坏帧 */ }
            }
            return pump()
          })
        }
        return pump()
      })
      .catch(function (e) {
        if (cancelled) return
        if (e && e.name === 'AbortError') return
        setView({
          status: 'error', packages: [], totalCount: 0, outdatedCount: 0,
          projectCount: undefined, expected: undefined, scannedAt: undefined,
          cached: false, error: (e && e.message) ? e.message : String(e),
        })
        finish()
      })

    return function () {
      cancelled = true
      if (controller) { try { controller.abort() } catch (e) { /* ignore */ } }
    }
  }, [])

  react.useEffect(function () {
    return load(false)
  }, [load, scope, projectPath])

  var refresh = react.useCallback(function () {
    setBusy(true)
    fetch(API + '/refresh', { method: 'POST' })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json() })
      .then(function () {
        // 服务端缓存已作废 → 本地也清空，然后强制重扫当前这个组合。
        // ⚠️ 不在这里 setBusy(false) —— 真正的重扫才刚开始，
        //    提前收掉按钮的忙碌态会让界面看起来"点完没反应"。
        cacheRef.current = {}
        load(true, function () { setBusy(false) })
      })
      .catch(function () { setBusy(false) })
  }, [load])

  /* 客户端筛选：项目 → 可升级 → 关键字（纯内存，不发请求） */
  var needle = query.trim().toLowerCase()
  var shown = view.packages.filter(function (p) {
    if (scope === 'system' && projectFilter !== ALL_PROJECTS && p.project !== projectFilter) return false
    if (onlyOutdated && p.isOutdated !== true) return false
    if (needle && String(p.name).toLowerCase().indexOf(needle) === -1) return false
    return true
  })

  var filtered = shown.length !== view.packages.length
  var showProjectColumn = scope === 'system'
  var streaming = view.status === 'loading' || view.status === 'streaming'
  var hasRows = view.packages.length > 0

  /* ── 范围切换 ── */
  var scopeSeg = react.createElement('div', { className: 'npmgr-seg', role: 'group', 'aria-label': t('scopeLabel') },
    [['project', t('scopeProject')], ['global', t('scopeGlobal')], ['system', t('scopeSystem')]].map(function (pair) {
      return react.createElement('button', {
        key: pair[0],
        type: 'button',
        'aria-pressed': pair[0] === scope ? 'true' : 'false',
        onClick: function () { setScope(pair[0]) },
      }, pair[1])
    }))

  /* ── 「本项目」的项目选择器 ── */
  var projectPicker = null
  if (scope === 'project') {
    var known = projects.list || []
    var currentKey = custom ? CUSTOM : projectPath
    var options = [react.createElement('option', { key: '__current__', value: '' },
      (projects.current ? projects.current : t('scopeProject')) + ' (' + t('scopeProject') + ')')]
    for (var i = 0; i < known.length; i++) {
      var pj = known[i]
      var label = (pj.title || pj.path) + (pj.exists === false ? ' — ' + t('missing') : '')
      options.push(react.createElement('option', { key: pj.path, value: pj.path }, label))
    }
    options.push(react.createElement('option', { key: CUSTOM, value: CUSTOM }, t('projectCustom')))

    projectPicker = react.createElement('div', { className: 'npmgr-field' },
      react.createElement('span', null, t('projectLabel') + '：'),
      react.createElement('select', {
        className: 'npmgr-select',
        value: currentKey,
        'aria-label': t('projectLabel'),
        onChange: function (e) {
          var v = e.target.value
          if (v === CUSTOM) setCustom(true)
          else { setCustom(false); setProjectPath(v) }
        },
      }, options))
  }

  /* ── 「本项目」的自定义路径输入 ── */
  var customRow = null
  if (scope === 'project' && custom) {
    customRow = react.createElement('div', { className: 'npmgr-bar', style: { marginTop: '2px' } },
      react.createElement('input', {
        className: 'npmgr-path',
        type: 'text',
        value: draft,
        placeholder: t('projectPathPlaceholder'),
        'aria-label': t('projectPathPlaceholder'),
        onChange: function (e) { setDraft(e.target.value) },
        onKeyDown: function (e) { if (e.key === 'Enter') setProjectPath(draft.trim()) },
      }),
      react.createElement('button', {
        className: 'npmgr-btn',
        onClick: function () { setProjectPath(draft.trim()) },
      }, t('apply')))
  }

  /* ── 「全系统」的项目筛选 ── */
  var projectFilterBox = null
  if (scope === 'system') {
    var names = []
    var seenName = {}
    for (var j = 0; j < view.packages.length; j++) {
      var nm = view.packages[j].project
      if (nm && !seenName[nm]) { seenName[nm] = true; names.push(nm) }
    }
    names.sort()
    var foptions = [react.createElement('option', { key: ALL_PROJECTS, value: ALL_PROJECTS }, t('allProjects'))]
    for (var k = 0; k < names.length; k++) {
      foptions.push(react.createElement('option', { key: names[k], value: names[k] }, names[k]))
    }
    projectFilterBox = react.createElement('div', { className: 'npmgr-field' },
      react.createElement('span', null, t('filterProject') + '：'),
      react.createElement('select', {
        className: 'npmgr-select',
        value: projectFilter,
        'aria-label': t('filterProject'),
        onChange: function (e) { setProjectFilter(e.target.value) },
      }, foptions))
  }

  /* ── 进度条：只在扫描中显示 ── */
  var progressBar = null
  if (streaming) {
    var pct = (typeof view.expected === 'number' && view.expected > 0)
      ? Math.min(100, Math.round((view.packages.length / view.expected) * 100))
      : null
    progressBar = react.createElement('div', { className: 'npmgr-track', role: 'progressbar' },
      pct === null
        ? react.createElement('div', { className: 'npmgr-slide' })
        : react.createElement('div', { className: 'npmgr-fill', style: { width: pct + '%' } }))
  }

  /* ── 主体 ── */
  var body
  if (view.status === 'error') {
    body = react.createElement('div', { className: 'npmgr-err' },
      react.createElement('div', null, t('failed') + '：' + view.error),
      // ⚠️ 不能直接写 onClick: load —— 点击事件会被当成 force 参数传进去
      react.createElement('button', { className: 'npmgr-btn', onClick: function () { load(true) } }, t('retry')))
  } else if (streaming && !hasRows) {
    // 还在扫描、一个包都没到 → 明确的加载态（**绝不显示空态文案**）
    body = react.createElement('div', { className: 'npmgr-msg' },
      react.createElement('div', null, spinner(), t('scanning')),
      react.createElement('div', { className: 'npmgr-msg-sub' },
        (typeof view.expected === 'number' && view.expected > 0)
          ? t('loadingMore') + ' 0 / ' + view.expected
          : t('connecting')))
  } else if (view.status === 'ready' && !hasRows) {
    // 扫描**结束**且确实为空 —— 这才是真的"没有找到"
    body = emptyState(t)
  } else if (shown.length === 0) {
    body = react.createElement('div', { className: 'npmgr-msg' }, t('emptyFiltered'))
  } else {
    var W = showProjectColumn
      ? { name: '26%', cur: '10%', lat: '10%', proj: '20%' }
      : { name: '30%', cur: '13%', lat: '13%' }

    var headCells = [
      react.createElement('th', { key: 'name', style: { width: W.name } }, t('colPackage')),
      react.createElement('th', { key: 'cur', style: { width: W.cur } }, t('colVersion')),
      react.createElement('th', { key: 'lat', style: { width: W.lat } }, t('colLatest')),
    ]
    if (showProjectColumn) headCells.push(react.createElement('th', { key: 'proj', style: { width: W.proj } }, t('colProject')))
    headCells.push(react.createElement('th', { key: 'desc' }, t('colNote')))

    body = react.createElement('div', { className: 'npmgr-wrap' },
      react.createElement('table', { className: 'npmgr-table' },
        react.createElement('thead', null, react.createElement('tr', null, headCells)),
        react.createElement('tbody', null,
          shown.map(function (p, idx) {
            return react.createElement(PackageRow, {
              key: (p.projectPath || '') + '|' + p.name + '|' + idx,
              pkg: p,
              t: t,
              showProject: showProjectColumn,
            })
          }))))
  }

  /* ── 配置表单（默认折叠，避免喧宾夺主）── */
  var cfgSection = null
  if (cfgMeta.loaded && cfgMeta.fields.length > 0) {
    var cfgValueOf = function (key) {
      if (Object.prototype.hasOwnProperty.call(draft, key)) return draft[key]
      return cfgMeta.current ? cfgMeta.current[key] : undefined
    }
    var setField = function (key, value) {
      setDraft(function (prev) {
        var next = {}
        for (var k in prev) if (Object.prototype.hasOwnProperty.call(prev, k)) next[k] = prev[k]
        next[key] = value
        return next
      })
      setSave({ status: 'idle', error: null })
    }
    var dirty = Object.keys(draft).length > 0

    var items = cfgMeta.fields.map(function (f) {
      var v = cfgValueOf(f.key)
      var input
      if (f.type === 'boolean') {
        input = react.createElement('label', { className: 'npmgr-check' },
          react.createElement('input', {
            type: 'checkbox',
            checked: v === true,
            disabled: !cfgMeta.writable,
            onChange: function (e) { setField(f.key, e.target.checked) },
          }))
      } else if (f.type === 'select') {
        input = react.createElement('select', {
          className: 'npmgr-cfg-num',
          value: v === undefined || v === null ? '' : String(v),
          disabled: !cfgMeta.writable,
          onChange: function (e) { setField(f.key, e.target.value) },
        }, (f.options || []).map(function (o) {
          return react.createElement('option', { key: o, value: o }, o)
        }))
      } else if (f.type === 'text') {
        input = react.createElement('input', {
          className: 'npmgr-cfg-text',
          type: 'text',
          value: v === undefined || v === null ? '' : String(v),
          disabled: !cfgMeta.writable,
          placeholder: '~/.dsh/npm-manager',
          onChange: function (e) { setField(f.key, e.target.value) },
        })
      } else {
        input = react.createElement('div', { className: 'npmgr-cfg-row' },
          react.createElement('input', {
            className: 'npmgr-cfg-num',
            type: 'number',
            value: v === undefined || v === null ? '' : String(v),
            min: f.min,
            max: f.max,
            disabled: !cfgMeta.writable,
            onChange: function (e) {
              var raw = e.target.value
              setField(f.key, raw === '' ? null : Number(raw))
            },
          }),
          f.unit ? react.createElement('span', { className: 'npmgr-cfg-unit' }, f.unit) : null)
      }
      var hintKey = 'fHint_' + f.key
      var hint = t(hintKey)
      return react.createElement('div', { className: 'npmgr-cfg-item', key: f.key },
        react.createElement('div', { className: 'npmgr-cfg-label' }, t('f_' + f.key)),
        input,
        hint && hint !== hintKey ? react.createElement('div', { className: 'npmgr-cfg-hint' }, hint) : null)
    })

    items.push(react.createElement('div', { className: 'npmgr-cfg-foot', key: '__foot' },
      react.createElement('button', {
        key: 'save',
        className: 'npmgr-btn',
        disabled: !cfgMeta.writable || !dirty || save.status === 'saving',
        onClick: saveConfig,
      }, save.status === 'saving' ? t('cfgSaving') : t('cfgSave')),
      react.createElement('button', {
        key: 'reset',
        className: 'npmgr-btn',
        disabled: !dirty || save.status === 'saving',
        onClick: function () { setDraft({}); setSave({ status: 'idle', error: null }) },
      }, t('cfgReset')),
      save.status === 'saved' ? react.createElement('span', { key: 'ok', className: 'npmgr-cfg-msg ok' }, '✓ ' + t('cfgSaved')) : null,
      save.status === 'error' ? react.createElement('span', { key: 'err', className: 'npmgr-cfg-msg err' }, save.error) : null,
      dirty && save.status === 'idle' ? react.createElement('span', { key: 'dirty', className: 'npmgr-cfg-msg' }, t('cfgDirty')) : null,
      react.createElement('span', { key: 'note', className: 'npmgr-cfg-note' },
        cfgMeta.writable ? t('cfgHint') : t('cfgUnwritable'))))

    cfgSection = react.createElement('div', { className: 'npmgr-cfg' },
      react.createElement('button', {
        className: 'npmgr-cfg-toggle',
        'aria-expanded': showCfg ? 'true' : 'false',
        onClick: function () { setShowCfg(!showCfg) },
      }, (showCfg ? '▾ ' : '▸ ') + t('cfg')),
      showCfg ? react.createElement('div', { className: 'npmgr-cfg-body' }, items) : null)
  }

  /* ── 统计 ── */
  var statsChildren = []
  if (streaming) {
    statsChildren.push(spinner())
    statsChildren.push(react.createElement('span', { key: 'prog' },
      (typeof view.expected === 'number' && view.expected > 0)
        ? t('loaded') + ' ' + view.packages.length + ' / ' + view.expected
        : t('connecting')))
  } else if (filtered) {
    statsChildren.push(react.createElement('span', { key: 'f' }, shown.length + ' / ' + view.totalCount + ' ' + t('statUnit')))
  } else {
    statsChildren.push(react.createElement('span', { key: 't' },
      t('statTotal') + ' ', react.createElement('b', null, view.totalCount), ' ' + t('statUnit')))
  }

  if (view.outdatedCount > 0) {
    statsChildren.push(react.createElement('span', { key: 's1' }, ' · '))
    statsChildren.push(react.createElement('span', { key: 'o' },
      react.createElement('b', null, view.outdatedCount), ' ' + t('statOutdated')))
  } else if (!streaming) {
    statsChildren.push(react.createElement('span', { key: 's1' }, ' · '))
    statsChildren.push(react.createElement('span', { key: 'o0' }, t('upToDate')))
  }

  if (scope === 'system' && typeof view.projectCount === 'number') {
    statsChildren.push(react.createElement('span', { key: 's2' }, ' · '))
    statsChildren.push(react.createElement('span', { key: 'p' },
      react.createElement('b', null, view.projectCount), ' ' + t('statProjects')))
  }

  // 数据时间：切范围/切项目时这个值不变 → 一眼看出用的是缓存
  var stamp = fmtTime(view.scannedAt)
  if (stamp) {
    statsChildren.push(react.createElement('span', { key: 's3' }, ' · '))
    statsChildren.push(react.createElement('span', { key: 'd', title: t('refreshHint') },
      t('dataAt') + ' ' + stamp + (view.cached ? ' (' + t('cachedTag') + ')' : '')))
  }

  return react.createElement('section', { className: 'npmgr-root', 'data-plugin': NS },
    react.createElement('div', { className: 'npmgr-head' },
      react.createElement('div', null,
        react.createElement('h2', { className: 'npmgr-title' }, t('title')),
        react.createElement('p', { className: 'npmgr-sub' }, t('subtitle'))),
      react.createElement('div', { className: 'npmgr-actions' },
        react.createElement('button', {
          className: 'npmgr-btn',
          onClick: refresh,
          disabled: busy,
        }, busy ? spinner() : null, busy ? t('refreshing') : t('refresh')))),

    react.createElement('div', { className: 'npmgr-bar' },
      scopeSeg,
      projectPicker,
      projectFilterBox,
      react.createElement('input', {
        className: 'npmgr-input',
        type: 'search',
        value: query,
        placeholder: t('search'),
        'aria-label': t('search'),
        onChange: function (e) { setQuery(e.target.value) },
      }),
      react.createElement('label', { className: 'npmgr-check' },
        react.createElement('input', {
          type: 'checkbox',
          checked: onlyOutdated,
          onChange: function (e) { setOnlyOutdated(e.target.checked) },
        }),
        t('onlyOutdated')),
      react.createElement('span', { className: 'npmgr-stats' }, statsChildren)),

    progressBar,
    customRow,
    body,
    cfgSection)
}

/* ─────────────────────────── 插件四件套 ─────────────────────────── */

exports.name = NS
exports.inject = ['slots', 'locale']

exports.apply = function (ctx) {
  ensureStyles()

  // 字典必须走命名空间注册；条目里只写 locale: NS（字符串）
  ctx.effect(function () {
    return ctx.locale.register(NS, { zh: zh, en: en })
  }, NS + ': dictionaries')

  // label 需要能随语言切换，所以用绑定了命名空间的 t
  var t = ctx.locale.bind(NS)

  ctx.slots.inject('settings.section', function () {
    return ctx.slots.register({
      name: 'settings.section',
      id: NS,
      order: 37,
      label: function () { return t('nav') },
      locale: NS,
    }, NpmManagerSection)
  })
}

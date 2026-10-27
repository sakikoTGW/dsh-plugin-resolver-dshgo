const __v = new URL(import.meta.url).searchParams.get('v') ?? ''
const __q = (name) => `./${name}${__v === '' ? '' : `?v=${encodeURIComponent(__v)}`}`
const { stars } = await import(__q('util.js'))
/**
 * dsh-go native cards for the resolver tools.
 *
 * The phone app renders the `dsh-go/view` returned by a tool's
 * `presentationMeta`; the desktop client keeps reading the plain text instead.
 * Cards are declarative, so every builder here stays inside the app's limits:
 * 8 KiB / 40 components / 6 levels, no interactive components, short labels.
 *
 * @module dsh-plugin-resolver/lib/view
 */

/** Stay a little below the app's 8 KiB card budget. */
const MAX_CARD_BYTES = 7600

/** Shorten a one-line string without cutting a surrogate pair. */
function clip(text, limit) {
  const flat = String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim()
  if (flat.length <= limit) return flat
  return `${flat.slice(0, Math.max(0, limit - 1))}…`
}

/** Drop optional children until the card fits, then fall back to a callout. */
export function fitCard(view) {
  if (!view || typeof view !== 'object') return undefined
  let bytes = JSON.stringify(view).length
  while (bytes > MAX_CARD_BYTES && Array.isArray(view.children) && view.children.length > 1) {
    view.children.pop()
    bytes = JSON.stringify(view).length
  }
  if (bytes <= MAX_CARD_BYTES) return view
  return { type: 'callout', tone: 'info', text: '结果太长，展开文字版查看' }
}

/** One-line render of a catalog source state. */
function catalogLine(catalog) {
  const where = catalog?.fromCache ? '缓存' : catalog?.source === 'npm' ? 'npm 载体' : '在线'
  const total = Array.isArray(catalog?.entries) ? catalog.entries.length : 0
  return `目录 ${total} 条 · ${where}`
}

/**
 * `plugin_search` card: the ranked matches with the owner kept visible.
 *
 * @param {string} query
 * @param {Array<{entry: any, installed: boolean}>} matches
 * @param {any} catalog
 * @param {boolean} ambiguous
 */
export function searchCard(query, matches, catalog, ambiguous) {
  const items = matches.slice(0, 8).map(({ entry, installed }) => ({
    title: clip(entry.name, 40),
    subtitle: clip(`${entry.owner || '?'} · ${entry.npm ?? 'GitHub 源码'}`, 60),
    trailing: installed ? '已装' : `★${stars(entry.stars)}`,
  }))
  return fitCard({
    type: 'stack',
    title: `插件目录 · ${clip(query, 16)}`,
    children: [
      { type: 'text', tone: 'muted', text: `${catalogLine(catalog)}${ambiguous ? ' · 有同名，需要指定 owner' : ''}` },
      { type: 'list', items },
      ...(ambiguous
        ? [{ type: 'callout', tone: 'warn', text: '同名插件有多个作者，告诉我 owner 或完整包名再装。' }]
        : []),
    ],
  })
}

/** Card for an install plan (read-only resolve). */
export function resolveCard(plan) {
  if (plan.kind === 'ambiguous') return ambiguousCard(plan)
  const rows = []
  if (plan.name) rows.push(['包', clip(`${plan.name}${plan.version ? `@${plan.version}` : ''}`, 60)])
  if (plan.kind === 'github' && plan.repo) rows.push(['来源', clip(`github.com/${plan.repo}`, 60)])
  if (plan.registry) rows.push(['Registry', clip(plan.registry, 46)])
  rows.push(['当前内核', String(plan.runtime ?? 'unknown')])
  const warning = Array.isArray(plan.notes) ? plan.notes.find((note) => /root|没有沙箱|构建/.test(note)) : undefined
  return fitCard({
    type: 'stack',
    title: plan.kind === 'github' ? '源码安装计划' : '安装计划',
    children: [
      { type: 'keyValue', items: rows },
      ...(plan.kind === 'github'
        ? [{ type: 'callout', tone: 'warn', text: warning ? clip(warning, 180) : '源码会在手机上构建，可能要几分钟。' }]
        : []),
      { type: 'text', tone: 'muted', text: '只解析，还没装。要装就说“装它”。' },
    ],
  })
}

/** Card for a same-name ambiguity. */
export function ambiguousCard(plan) {
  const items = (plan.candidates ?? []).slice(0, 6).map((candidate) => ({
    title: clip(candidate.name, 40),
    subtitle: clip(`owner=${candidate.owner || '?'} · ${candidate.npm ?? 'GitHub 源码'}`, 60),
    trailing: `★${stars(candidate.stars)}`,
  }))
  return fitCard({
    type: 'stack',
    title: '同名插件',
    children: [
      { type: 'text', tone: 'muted', text: `${plan.name} 有 ${(plan.candidates ?? []).length} 个同名作者，不猜。` },
      { type: 'list', items },
      { type: 'callout', tone: 'info', text: '回我 owner，或者完整包名 / github:owner/repo。' },
    ],
  })
}

/**
 * `plugin_install` card: what ran, what landed, and what the phone still needs.
 *
 * @param {{plan: any, packageName?: string, application?: string, stage?: string, steps?: string[], error?: string, warnings?: string[], pendingBuilds?: string[], health?: any, restart?: any}} report
 */
export function installCard(report) {
  const { plan, health, restart } = report
  const failed = report.application === 'failed' || Boolean(report.error)
  const buildNeeded = plan?.kind === 'github'
  const active = health?.entry?.fiberPhase === 'active'
  const entrySteps = [
    { label: '解析', status: 'done', detail: String(plan?.runtime ?? '') },
    {
      label: buildNeeded ? '下载构建' : '安装',
      status: failed ? 'failed' : 'done',
      detail: report.packageName ? clip(report.packageName, 30) : '',
    },
    {
      label: '校验加载',
      status: health?.entry ? (active ? 'done' : health.entry.fiberPhase === 'failed' ? 'failed' : 'current') : failed ? 'failed' : 'current',
      detail: health?.entry ? `fiber ${health.entry.fiberPhase ?? '?'}` : '还没挂载',
    },
    {
      label: '重启',
      status: restart?.required ? 'current' : 'done',
      detail: restart?.required ? '需要' : '无需',
    },
  ].map((step) => (step.detail === '' ? { label: step.label, status: step.status } : step))

  const warnings = Array.isArray(report.warnings) ? report.warnings.filter(Boolean) : []
  const result = failed
    ? '失败'
    : restart?.required
      ? '已装，等重启'
      : active
        ? '已生效'
        : '已装，entry 未找到'
  const children = [
    {
      type: 'keyValue',
      items: [
        ['包', clip(report.packageName ?? plan?.name ?? 'unknown', 60)],
        ['结果', result],
        ['内核', String(plan?.runtime ?? 'unknown')],
      ],
    },
    { type: 'steps', items: entrySteps },
  ]
  if (report.error) children.push({ type: 'callout', tone: 'bad', text: clip(report.error, 220) })
  if (warnings.length > 0) children.push({ type: 'callout', tone: 'warn', text: clip(warnings[0], 220) })
  if (report.deep) {
    children.push({
      type: 'callout',
      tone: report.deep.ok ? 'good' : 'bad',
      text: clip(`深度校验${report.deep.ok ? '通过' : '未通过'}：${report.deep.reason}`, 200),
    })
  }
  if (!failed && !restart?.required) {
    children.push({ type: 'callout', tone: 'good', text: '装好了，可以直接用。' })
  } else if (!failed && restart?.required) {
    children.push({ type: 'callout', tone: 'warn', text: '在「引擎」页重启一次引擎后生效。' })
  }
  return fitCard({ type: 'stack', title: '装插件', children })
}

/**
 * `plugin_status` card.
 *
 * @param {{bundles: any[], entries: any[]}} inventory
 * @param {string} filter
 */
export function statusCard(inventory, filter) {
  const bundles = (inventory.bundles ?? []).filter(
    (bundle) => filter === '' || String(bundle.name).toLowerCase().includes(filter),
  )
  const items = bundles.slice(0, 12).map((bundle) => ({
    title: clip(String(bundle.name), 44),
    subtitle: clip(`${bundle.version ?? '?'} · ${bundle.enabled ? '已启用' : '未启用'}`, 40),
    trailing: bundle.rows?.some?.((row) => row.entryId) ? '已挂载' : '无 entry',
  }))
  const broken = (inventory.entries ?? []).filter((entry) => entry.fiberPhase === 'failed')
  return fitCard({
    type: 'stack',
    title: '已装插件',
    children: [
      {
        type: 'keyValue',
        items: [
          ['第三方 bundle', String(bundles.length)],
          ['loader entry', String((inventory.entries ?? []).length)],
        ],
      },
      ...(items.length > 0 ? [{ type: 'list', items }] : [{ type: 'text', tone: 'muted', text: '还没装第三方插件。' }]),
      ...(broken.length > 0
        ? [{ type: 'callout', tone: 'bad', text: clip(`加载失败：${broken.map((entry) => entry.moduleName).join('、')}`, 200) }]
        : []),
    ],
  })
}

/** Card for a tool-level failure. */
export function failureCard(title, message) {
  return {
    type: 'stack',
    title: clip(title, 24),
    children: [{ type: 'callout', tone: 'bad', text: clip(message, 300) }],
  }
}

/** Card when the catalog cannot be loaded. */
export function catalogFailureCard(message) {
  return {
    type: 'stack',
    title: '插件目录不可用',
    children: [
      { type: 'callout', tone: 'warn', text: clip(message, 240) },
      { type: 'text', tone: 'muted', text: '重试一次；还不行就检查手机网络。' },
    ],
  }
}

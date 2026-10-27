/**
 * Reloadable logic entry: every tool body lives here, behind one cache-busted
 * import. The host shell asks for this module with `?v=<logic mtime>` on each
 * call, so editing any file under `logic/` takes effect on the next tool call
 * without restarting the host.
 *
 * Nothing in here touches the loader or the tool registry; it receives the
 * profile's `pluginManager` and a Cordis context and returns `{ text, view }`:
 * `text` is the model-facing report, `view` is the dsh-go card the phone app
 * draws (desktop clients ignore it).
 *
 * @module dsh-plugin-resolver/logic/api
 */

// Local dependencies carry this module's own `?v=` query, so one cache-busted
// import of `api.js` reloads catalog/resolve/install/util/view together.
const __v = new URL(import.meta.url).searchParams.get('v') ?? ''
const __q = (name) => `./${name}${__v === '' ? '' : `?v=${encodeURIComponent(__v)}`}`
const { baseName, loadCatalog, searchCatalog } = await import(__q('catalog.js'))
const { deepVerify, installGithubSource, installRegistry, verifyInstall, capturePackageRuntime, decideRestart } = await import(__q('install.js'))
const { resolveTarget } = await import(__q('resolve.js'))
const { isDshGo, oneLine, stars } = await import(__q('util.js'))
const { ambiguousCard, catalogFailureCard, failureCard, installCard, resolveCard, searchCard, statusCard } = await import(__q('view.js'))

/** Catalog load honoring the `refresh` flag and config overrides. */
async function catalogFor(options, refresh) {
  try {
    const combined = { ...options }
    if (refresh) return await loadCatalog(combined, { force: true })
    return await loadCatalog(combined)
  } catch (error) {
    return { entries: [], fetchedAt: 0, fromCache: false, source: 'unavailable', error: error?.message ?? String(error) }
  }
}

/** Bundle names already installed in this profile. */
async function installedNames(manager) {
  const set = new Set()
  if (!manager) return set
  try {
    const bundles = await manager.listBundles()
    for (const bundle of bundles) {
      if (bundle?.installed && typeof bundle.name === 'string') set.add(bundle.name)
    }
  } catch {
    // inventory is best-effort
  }
  return set
}

/**
 * `plugin_search`: rank catalog entries and keep same-name ambiguity visible.
 *
 * @param {any} ctx
 * @param {any} manager
 * @param {Record<string, unknown>} options
 * @param {any} args
 * @returns {Promise<{text: string, view?: any}>}
 */
export async function pluginSearch(ctx, manager, options, args) {
  const query = String(args?.query ?? '').trim()
  if (query === '') return { text: 'plugin_search needs a non-empty query.' }
  const installed = await installedNames(manager)
  const catalog = await catalogFor(options, args?.refresh === true)
  if (catalog.entries.length === 0) {
    const message = `Catalog is unavailable right now: ${catalog.error ?? 'empty catalog'}`
    return { text: message, view: catalogFailureCard(message) }
  }
  const { matches, ambiguous } = searchCatalog(catalog.entries, query, {
    limit: Number(args?.limit) || 8,
    installed,
  })
  if (matches.length === 0) {
    return {
      text: `No catalog entry matches "${query}" (${catalog.entries.length} entries, ${catalog.fromCache ? 'cached' : 'fresh'}).`,
    }
  }
  const lines = [
    `${matches.length} match(es) for "${query}" — catalog ${catalog.entries.length} entries, ${catalog.fromCache ? 'cached' : `fresh from ${catalog.source}`}:`,
    '',
  ]
  matches.forEach(({ entry, installed: isInstalled }, index) => {
    lines.push(`${index + 1}. ${entry.name}  ★${stars(entry.stars)}  owner=${entry.owner || '?'}${isInstalled ? '  [installed]' : ''}`)
    if (entry.npm) lines.push(`   npm: ${entry.npm}${entry.version ? `@${entry.version}` : ''}`)
    else lines.push('   npm: (not published — GitHub source)')
    if (entry.install) lines.push(`   install: ${entry.install}`)
    if (entry.description) lines.push(`   ${oneLine(entry.description, 150)}`)
  })
  if (ambiguous) {
    lines.push('', 'Same name has several owners. Disambiguate with owner or a full spec, e.g. owner="wqty123".')
  }
  return { text: lines.join('\n'), view: searchCard(query, matches, catalog, ambiguous) }
}

/**
 * `plugin_resolve`: produce the install plan without mutating anything.
 */
export async function pluginResolve(ctx, manager, options, args) {
  if (!manager) {
    return {
      text: 'The pluginManager service is not mounted in this profile; resolve is unavailable.',
      view: failureCard('解析插件', '当前 profile 没有 pluginManager，解析不可用。'),
    }
  }
  try {
    const catalog = await catalogFor(options, args?.refresh === true)
    const plan = await resolveTarget(ctx, manager, String(args?.target ?? ''), {
      owner: typeof args?.owner === 'string' ? args.owner : undefined,
      version: typeof args?.version === 'string' ? args.version : undefined,
      registry: typeof args?.registry === 'string' && args.registry !== '' ? args.registry : options.registry,
      catalog: catalog.entries,
    })
    return { text: formatPlan(plan, 'resolve'), view: resolveCard(plan) }
  } catch (error) {
    const message = error?.message ?? String(error)
    return { text: `plugin_resolve failed: ${message}`, view: failureCard('解析插件失败', message) }
  }
}

/**
 * `plugin_install`: resolve, install through the manager, verify, and report
 * whether a refresh or restart is needed.
 */
export async function pluginInstall(ctx, manager, options, args) {
  if (!manager) {
    return {
      text: 'The pluginManager service is not mounted in this profile; install is unavailable.',
      view: failureCard('装插件', '当前 profile 没有 pluginManager，装不了。'),
    }
  }
  const go = isDshGo()
  /** @type {{plan: any, packageName?: string, application: string, stage: string, steps: string[], warnings: string[], error?: string, pendingBuilds: string[], health?: any, restart?: any}} */
  const report = { plan: null, application: 'unknown', stage: 'install', steps: [], warnings: [], pendingBuilds: [] }
  try {
    const catalog = await catalogFor(options, args?.refresh === true)
    const plan = await resolveTarget(ctx, manager, String(args?.target ?? ''), {
      owner: typeof args?.owner === 'string' ? args.owner : undefined,
      version: typeof args?.version === 'string' ? args.version : undefined,
      registry: typeof args?.registry === 'string' && args.registry !== '' ? args.registry : options.registry,
      catalog: catalog.entries,
    })
    report.plan = plan
    if (plan.kind === 'ambiguous') return { text: formatPlan(plan, 'install'), view: ambiguousCard(plan) }

    const lines = [
      `plugin: ${plan.name ? `${plan.name}${plan.version ? `@${plan.version}` : ''}` : plan.spec}  kind: ${plan.kind}${
        plan.registry ? `  registry: ${plan.registry}` : ''
      }`,
    ]
    const logLines = []
    let packageName = plan.name
    let steps = []
    let application = 'unknown'
    let beforeRuntime = null
    let bundlesBefore = []
    if (plan.kind === 'npm' && typeof plan.name === 'string' && plan.name !== '') {
      beforeRuntime = await capturePackageRuntime(plan.name).catch(() => null)
    }
    try {
      bundlesBefore = (await manager.listBundles()).map((bundle) => bundle.name)
    } catch {
      bundlesBefore = []
    }

    if (plan.kind === 'github') {
      const result = await installGithubSource(manager, plan, {
        githubProxy: options.githubProxy,
        skipBuild: args?.skipBuild === true,
        log: (line) => {
          logLines.push(line)
          if (logLines.length > 12) logLines.shift()
        },
      })
      packageName = result.packageName
      steps = result.steps
      report.warnings.push(...(result.warnings ?? []))
      application = result.summary.application
      if (result.summary.error) report.error = result.summary.error
      lines.push(`install: ${result.summary.application} (${result.summary.stage})`)
      if (result.summary.error) lines.push(`error: ${result.summary.error}`)
      if (steps.length > 0) lines.push(`steps: ${steps.join(' → ')}`)
    } else {
      const { summary } = await installRegistry(manager, plan)
      const alreadyInstalled = /already-installed/i.test(summary.error ?? '')
      application = alreadyInstalled ? 'applied' : summary.application
      if (packageName === null && summary.bundle) packageName = summary.bundle
      if (summary.error && !alreadyInstalled) report.error = summary.error
      report.pendingBuilds = summary.pendingBuilds
      if (summary.pendingBuilds.length > 0) {
        report.warnings.push(
          `pnpm 等待批准构建脚本：${summary.pendingBuilds.join(', ')}。批准之前依赖的 install 脚本不会执行；必要时在 profile 里运行 pnpm approve-builds 后重装。`,
        )
      }
      lines.push(alreadyInstalled ? 'install: already installed (no change)' : `install: ${summary.application} (${summary.stage})`)
      if (summary.error && !alreadyInstalled) lines.push(`error: ${summary.error}`)
      if (summary.pendingBuilds.length > 0) {
        lines.push(`pending build scripts (needs approval): ${summary.pendingBuilds.join(', ')}`)
      }
    }
    report.packageName = packageName ?? undefined
    report.application = application
    report.stage = 'installed'

    if (packageName) {
      const health = await verifyInstall(ctx, manager, packageName)
      report.health = health
      const phase = health.entry?.fiberPhase ?? 'missing'
      lines.push(
        `verify: fiberPhase=${phase}${health.bundle ? ` bundle=${health.bundle.enabled ? 'enabled' : 'disabled'}` : ''}${
          health.hasClient ? ` client=${health.clientSource}` : ' host-only'
        }`,
      )
      let afterRuntime = null
      let bundlesAfter = []
      try {
        afterRuntime = await capturePackageRuntime(packageName)
        bundlesAfter = (await manager.listBundles()).map((bundle) => bundle.name)
      } catch {
        // keep the manager's own restart decision
      }
      const restart = decideRestart({ before: beforeRuntime, after: afterRuntime, bundlesBefore, bundlesAfter, managerApplication: application })
      report.restart = restart
      lines.push(`restart: ${restart.required ? 'required' : 'not required'} — ${restart.reason}`)
      if (application === 'restart-required' && !restart.required) {
        lines.push('note: manager requested a restart, but runtime files are unchanged')
      } else if (!restart.required && restart.versionChanged) {
        lines.push('note: version label updates after the next restart')
      }
      const next = []
      if (restart.required) {
        next.push(go ? 'restart the engine once from the dsh-go engine page' : `restart DSH fully: ${restart.reason}`)
        if (go) {
          next.push(
            'do not spawn a nested `dsh` run to verify (one-shot boot + plugin load costs 5-30 s here); `dsh --profile <p> --dump-config` costs ~0.3 s',
          )
        }
      }
      if (health.entry?.fiberPhase === 'failed') next.push('host half failed to load; inspect the harness log')
      if (restart.clientChanged) {
        next.push(go ? 'client half changed: reopen the chat page, or restart the engine if the UI does not update' : 'client half changed: refresh the GUI (Ctrl+R)')
      }
      if (health.entry?.fiberPhase === 'active' && !health.hasClient && !restart.required && !restart.codeChanged) {
        next.push(go ? 'already live: no restart and no refresh needed' : 'host-only: no restart or GUI refresh required')
      }
      if (next.length > 0) lines.push(`next: ${next.join('; ')}`)
      if (args?.verify === 'deep') {
        const deep = await deepVerify(ctx, packageName)
        report.deep = deep
        lines.push(`deep verify: ${deep.ok ? 'ok' : 'FAILED'} — ${deep.reason}`)
      }
    }
    if (logLines.length > 0) lines.push(`build log (tail):\n  ${logLines.slice(-6).join('\n  ')}`)
    return { text: lines.join('\n'), view: installCard(report) }
  } catch (error) {
    const message = error?.message ?? String(error)
    report.error = message
    return { text: `plugin_install failed: ${message}`, view: installCard(report) }
  }
}

/**
 * `plugin_status`: third-party bundles and their loader entries.
 */
export async function pluginStatus(ctx, manager, options, args) {
  if (!manager) {
    return {
      text: 'The pluginManager service is not mounted in this profile; status is unavailable.',
      view: failureCard('插件状态', '当前 profile 没有 pluginManager。'),
    }
  }
  const filter = String(args?.query ?? '').trim().toLowerCase()
  const lines = []
  const inventory = { bundles: [], entries: [] }
  try {
    const bundles = await manager.listBundles()
    const installed = bundles.filter((bundle) => bundle.installed && !String(bundle.name).startsWith('@deepseek-ai/'))
    inventory.bundles = installed
    lines.push(`installed third-party bundles: ${installed.length}`)
    for (const bundle of installed) {
      if (filter !== '' && !String(bundle.name).toLowerCase().includes(filter)) continue
      lines.push(`- ${bundle.name}@${bundle.version ?? '?'} enabled=${bundle.enabled} optional=${bundle.optional}`)
      const rows = Array.isArray(bundle.rows) ? bundle.rows.filter((row) => row.entryId) : []
      if (rows.length > 0) lines.push(`  rows: ${rows.map((row) => `${row.entryId}(${row.moduleName})`).join(', ')}`)
    }
  } catch (error) {
    lines.push(`bundle inventory failed: ${error.message}`)
  }
  try {
    const plugins = await manager.listPlugins()
    // `cordis:include` rows and absolute paths are how the host and dsh-app load
    // their own plugins; listing them as third-party is noise on the phone.
    const thirdParty = plugins.filter((plugin) => {
      const name = String(plugin.moduleName ?? '')
      return name !== '' && !name.startsWith('@deepseek-ai/') && !/^([/.]|cordis:|file:|node:)/.test(name)
    })
    inventory.entries = thirdParty
    lines.push('', `third-party loader entries: ${thirdParty.length}`)
    for (const plugin of thirdParty) {
      if (filter !== '' && !String(plugin.moduleName).toLowerCase().includes(filter)) continue
      lines.push(`- ${plugin.entryId}: ${plugin.moduleName} enabled=${plugin.enabled} fiberPhase=${plugin.fiberPhase ?? 'null'}`)
    }
  } catch (error) {
    lines.push(`plugin inventory failed: ${error.message}`)
  }
  return { text: lines.join('\n'), view: statusCard(inventory, filter) }
}

/**
 * Render a resolution plan as compact text.
 *
 * @param {any} plan
 * @param {'resolve' | 'install'} mode
 * @returns {string}
 */
export function formatPlan(plan, mode) {
  if (plan.kind === 'ambiguous') {
    const lines = [`"${plan.name}" is ambiguous: ${plan.candidates.length} catalog entries share this name.`, '']
    plan.candidates.forEach((candidate, index) => {
      lines.push(
        `${index + 1}. owner=${candidate.owner || '?'}  ★${stars(candidate.stars)}  ${
          candidate.npm ? `npm: ${candidate.npm}` : 'npm: (GitHub source)'
        }`,
      )
      if (candidate.install) lines.push(`   install: ${candidate.install}`)
      if (candidate.description) lines.push(`   ${oneLine(candidate.description, 130)}`)
    })
    lines.push('', `Re-run ${mode === 'install' ? 'plugin_install' : 'plugin_resolve'} with owner="<owner>" or a full spec.`)
    return lines.join('\n')
  }
  const lines = []
  const runtime = plan.runtime ?? 'unknown'
  lines.push(`target kind: ${plan.kind}   running DSH: ${runtime}`)
  if (plan.name) lines.push(`package: ${plan.name}${plan.version ? `@${plan.version}` : ''}`)
  if (plan.spec) lines.push(`install spec: ${plan.spec}`)
  if (plan.registry) lines.push(`registry: ${plan.registry}`)
  else lines.push('registry: pnpm default (no first registry named)')
  if (plan.latest && plan.latest !== plan.version) lines.push(`latest published: ${plan.latest} (not used: incompatible or newer)`)
  if (plan.kind === 'github') {
    lines.push(`source: github.com/${plan.repo}${plan.ref ? ` @ ${plan.ref}` : ''}${plan.subpath ? ` (${plan.subpath})` : ''}`)
  }
  if (plan.catalogEntry) {
    lines.push(`catalog: ${plan.catalogEntry.name} by ${plan.catalogEntry.owner || '?'} ★${stars(plan.catalogEntry.stars)}`)
    if (plan.catalogEntry.description) lines.push(`about: ${oneLine(plan.catalogEntry.description, 160)}`)
  }
  if (Array.isArray(plan.rejected) && plan.rejected.length > 0) {
    lines.push('skipped versions:')
    for (const item of plan.rejected) lines.push(`- ${item.version}: ${item.reason}`)
  }
  if (Array.isArray(plan.notes) && plan.notes.length > 0) {
    lines.push('notes:')
    for (const note of plan.notes) lines.push(`- ${note}`)
  }
  if (mode === 'install') lines.push('', 'proceeding with install…')
  return lines.join('\n')
}

export { baseName }

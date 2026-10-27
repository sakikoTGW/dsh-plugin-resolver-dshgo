// Reloadable module: local dependencies carry this module's `?v=` query.
const __v = new URL(import.meta.url).searchParams.get('v') ?? ''
const __q = (name) => `./${name}${__v === '' ? '' : `?v=${encodeURIComponent(__v)}`}`
const { baseName, githubSpecOf, normalizeCatalog, repoSlugOf, searchCatalog } = await import(__q('catalog.js'))
const { compareVersions, satisfies, sortVersionsDesc, parseVersion } = await import(__q('semver.js'))
const { fetchJson, githubProxyFromEnv, isDshGo } = await import(__q('util.js'))
/**
 * Resolution: what a target names, which concrete version is DSH-compatible,
 * which registry to ask, and which install path applies.
 *
 * This is the decision layer the tools call before any mutation. It never
 * touches the profile beyond reading the manager's own inventory.
 *
 * @module dsh-plugin-resolver/lib/resolve
 */


/** A package name, optionally with an explicit version. */
const NPM_TARGET_RE = /^(@[^/@\s]+\/[^@\s]+|[^@/\s#]+)(?:@([^\s]+))?$/

/** Clear hints that the target is already a concrete install spec. */
const EXPLICIT_SPEC_RE = /^(github:|git\+|file:|link:|https?:\/\/|\.{0,2}[\\/])/i

/** Peer ranges the host reads as "the running DSH version" itself. */
const WORKSPACE_RUNTIME_RANGES = new Set(['workspace:^', 'workspace:~', 'workspace:*'])

/**
 * Read the running DSH core version from the manager's own bundle inventory.
 *
 * @param {any} manager the `pluginManager` service
 * @returns {Promise<string | null>}
 */
export async function runtimeVersion(manager) {
  try {
    const bundles = await manager.listBundles()
    const preferred = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@deepseek-ai/dsh']
    for (const name of preferred) {
      const hit = bundles.find((bundle) => bundle.name === name && typeof bundle.version === 'string')
      if (hit) return hit.version
    }
    return null
  } catch {
    return null
  }
}

/**
 * Pick the registry asked first: the Host's own probe when mounted, else the
 * manager's configured registry, else null (pnpm's own configuration).
 *
 * @param {any} ctx cordis context
 * @param {any} manager
 * @returns {Promise<string | null>}
 */
export async function chooseRegistry(ctx, manager) {
  const probe = ctx.get('pluginRegistryProbe')
  if (probe && typeof probe.fastest === 'function') {
    try {
      const fastest = await probe.fastest()
      if (typeof fastest === 'string' && fastest !== '') return fastest
    } catch {
      // fall through to the configured registry
    }
  }
  try {
    const registries = await manager.registries()
    if (registries?.resolved) return registries.resolved
    if (typeof registries?.registry === 'string') return registries.registry
  } catch {
    // fall through
  }
  // The phone runtime already points pnpm at npmmirror; answering "null" here
  // would send the registry read to npmjs.org and cost a timeout on mobile data.
  return isDshGo() ? 'https://registry.npmmirror.com' : null
}

/** A concrete base URL for registry HTTP reads. */
export function registryBase(registry) {
  if (typeof registry === 'string' && /^https?:\/\//i.test(registry)) return registry.replace(/\/+$/, '')
  return isDshGo() ? 'https://registry.npmmirror.com' : 'https://registry.npmjs.org'
}

/** Encode a scoped package name for a registry path. */
export function encodePackageName(name) {
  return name.startsWith('@') ? name.replace('/', '%2f') : name
}

/**
 * Fetch a package document from a registry.
 *
 * @param {string} name
 * @param {string} registry
 * @returns {Promise<{name: string, versions: Record<string, any>, tags: Record<string, string>}>}
 */
/** How long one registry version document stays usable. */
const NPM_DOC_TTL_MS = 10 * 60 * 1000

/** Resolved documents, keyed by registry and package; module state survives tool calls. */
const docCache = new Map()

export async function npmPackage(name, registry) {
  const base = registryBase(registry)
  const key = `${base}|${name}`
  const hit = docCache.get(key)
  if (hit && Date.now() - hit.at < NPM_DOC_TTL_MS) return hit.doc
  const doc = await fetchJson(`${base}/${encodePackageName(name)}`, { timeoutMs: 30_000 })
  if (!doc || typeof doc !== 'object' || typeof doc.versions !== 'object') {
    throw new Error(`registry returned no version document for ${name}`)
  }
  const value = { name, versions: doc.versions ?? {}, tags: doc['dist-tags'] ?? {} }
  docCache.set(key, { at: Date.now(), doc: value })
  return value
}

/**
 * Choose the newest published version that accepts the running DSH version.
 *
 * Runtime constraints follow the host's own rule (see `peerConstraint`): a
 * version's `engines.dsh` range decides alone, otherwise its non-optional
 * `@deepseek-ai/dsh*` peers do — never a caret over a `0.x` prerelease.
 *
 * @param {{versions: Record<string, any>, tags: Record<string, string>}} doc
 * @param {string | null} runtime
 * @returns {{version: string | null, reason: string, rejected: Array<{version: string, reason: string}>}}
 */
export function chooseCompatibleVersion(doc, runtime) {
  const all = Object.keys(doc.versions).filter((version) => parseVersion(version) !== null)
  const rejected = []
  if (all.length === 0) return { version: null, reason: 'no published version', rejected }
  const ordered = sortVersionsDesc(all)
  if (runtime === null) {
    const latest = doc.tags.latest ?? ordered[0]
    return { version: latest, reason: 'DSH runtime version unknown; trusting the registry latest tag', rejected }
  }
  for (const version of ordered) {
    const manifest = doc.versions[version] ?? {}
    if (manifest.deprecated) {
      if (rejected.length < 4) rejected.push({ version, reason: 'deprecated' })
      continue
    }
    const constraint = peerConstraint(manifest, runtime)
    if (constraint.ok) {
      return {
        version,
        reason: `newest of ${all.length} published versions whose DSH constraint accepts ${runtime}`,
        rejected,
      }
    }
    if (rejected.length < 4) rejected.push({ version, reason: constraint.reason })
  }
  return { version: null, reason: `no published version accepts DSH ${runtime}`, rejected }
}

/**
 * Check one published version's runtime constraints against the running DSH.
 *
 * Mirrors the host's own precheck (`dsh-app-boot` `unmetRequirements`):
 * - an own `engines.dsh` range decides alone and peer dependencies are ignored;
 * - otherwise every `@deepseek-ai/dsh` / `@deepseek-ai/dsh-*` peer must accept
 *   the runtime, optional (`peerDependenciesMeta`) or not — the host does not
 *   read that metadata;
 * - `workspace:^`, `workspace:~` and `workspace:*` peer ranges mean the running
 *   host itself; an empty or invalid range is unmet.
 *
 * Sibling libraries such as `@deepseek-ai/cordis` or
 * `@deepseek-ai/schemastery` have their own version numbers and are therefore
 * not runtime constraints.
 *
 * @param {any} manifest
 * @param {string} runtime
 * @returns {{ok: true, reason: string} | {ok: false, reason: string}}
 */
function peerConstraint(manifest, runtime) {
  const engines = manifest.engines
  if ('engines' in manifest) {
    if (engines === null || typeof engines !== 'object' || Array.isArray(engines)) {
      return { ok: false, reason: 'engines is not an object' }
    }
    if (Object.hasOwn(engines, 'dsh')) {
      const range = engines.dsh
      if (typeof range !== 'string') return { ok: false, reason: 'engines.dsh is not a string' }
      if (range.trim() === '' || !satisfies(runtime, range)) {
        return { ok: false, reason: `engines.dsh wants ${range}, host is ${runtime}` }
      }
      return { ok: true, reason: `engines.dsh ${range}` }
    }
  }
  const peers = manifest.peerDependencies
  if (peers === null || typeof peers !== 'object' || Array.isArray(peers)) {
    return { ok: true, reason: 'no DSH constraint' }
  }
  const checked = []
  for (const [name, range] of Object.entries(peers)) {
    if (name !== '@deepseek-ai/dsh' && !name.startsWith('@deepseek-ai/dsh-')) continue
    if (typeof range !== 'string') return { ok: false, reason: `${name} declares a non-string range` }
    checked.push(`${name}@${range}`)
    const effective = WORKSPACE_RUNTIME_RANGES.has(range) ? runtime : range
    if (effective.trim() === '' || !satisfies(runtime, effective)) {
      return { ok: false, reason: `${name} needs ${range}, host is ${runtime}` }
    }
  }
  return { ok: true, reason: checked.length > 0 ? checked.join('; ') : 'no DSH constraint' }
}

/**
 * Split `name@version`, leaving a scoped package intact.
 *
 * @param {string} target
 * @returns {{name: string, version: string | null} | null}
 */
export function parseNpmTarget(target) {
  const match = NPM_TARGET_RE.exec(target.trim())
  if (!match) return null
  return { name: match[1], version: match[2] ?? null }
}

/**
 * Parse a GitHub shorthand into its repository, revision and subpath.
 *
 * @param {string} spec
 * @returns {{repo: string, owner: string, name: string, ref: string | null, subpath: string | null} | null}
 */
export function parseGithubSpec(spec) {
  const match = /^github:([^/\s#]+)\/([^/\s#]+)(?:#([^\s]*))?$/i.exec(spec.trim())
  if (!match) return null
  let ref = null
  let subpath = null
  for (const selector of (match[3] ?? '').split('&')) {
    if (selector === '') continue
    const pathMatch = /^path:\/?(.+)$/.exec(selector)
    if (pathMatch) {
      subpath = pathMatch[1].replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
      continue
    }
    if (/^[0-9a-f]{40}$/i.test(selector)) continue
    if (selector.startsWith('semver:')) {
      ref = null
      continue
    }
    if (selector.trim() !== '') ref = selector.trim()
  }
  return { repo: `${match[1]}/${match[2]}`, owner: match[1], name: match[2], ref, subpath }
}

/**
 * Resolve one target into an actionable plan without mutating anything.
 *
 * @param {any} ctx
 * @param {any} manager
 * @param {string} target user input: catalog name, npm name, name@version, or a spec
 * @param {{owner?: string, version?: string, registry?: string, catalog?: CatalogEntry[]}} [options]
 * @returns {Promise<Resolution>}
 */
export async function resolveTarget(ctx, manager, target, options = {}) {
  const trimmed = String(target ?? '').trim()
  if (trimmed === '') throw new Error('empty target')
  const registry = options.registry ?? (await chooseRegistry(ctx, manager))
  const runtime = await runtimeVersion(manager)
  const notes = []

  if (EXPLICIT_SPEC_RE.test(trimmed)) {
    const gh = parseGithubSpec(trimmed)
    if (gh) return await resolveGithub(manager, gh, { registry, runtime, notes, target: trimmed })
    return {
      kind: 'spec',
      spec: trimmed,
      name: null,
      version: null,
      registry,
      runtime,
      notes: ['installed verbatim through the profile plugin manager'],
    }
  }

  const parsed = parseNpmTarget(trimmed)
  if (!parsed) throw new Error(`cannot parse "${trimmed}" as a package name or spec`)
  const explicitVersion = options.version ?? parsed.version
  let name = parsed.name
  let catalogEntry = null

  const catalog = options.catalog ?? []
  if (catalog.length > 0) {
    const { matches } = searchCatalog(catalog, name, { limit: 12 })
    const exact = matches.filter(({ entry }) => baseName(entry).toLowerCase() === name.toLowerCase())
    const pool = exact.length > 0 ? exact.map(({ entry }) => entry) : []
    if (pool.length > 0) {
      let chosen = pool
      if (options.owner) {
        const wanted = options.owner.toLowerCase()
        chosen = pool.filter((entry) => entry.owner.toLowerCase() === wanted)
        if (chosen.length === 0) {
          throw new Error(
            `catalog has no "${name}" by owner "${options.owner}". Owners: ${pool
              .map((entry) => entry.owner || 'unknown')
              .join(', ')}`,
          )
        }
      }
      if (chosen.length > 1) {
        return {
          kind: 'ambiguous',
          name,
          registry,
          runtime,
          candidates: chosen.map((entry) => ({
            name: baseName(entry),
            owner: entry.owner,
            stars: entry.stars,
            npm: entry.npm,
            install: entry.install,
            url: entry.url,
            description: entry.description,
          })),
          notes: ['several catalog entries share this name; re-run with owner or a full spec'],
        }
      }
      catalogEntry = chosen[0]
      if (catalogEntry.npm) name = catalogEntry.npm
      else {
        const spec = githubSpecOf(catalogEntry)
        if (spec) {
          const gh = parseGithubSpec(spec)
          if (gh) {
            notes.push(`catalog entry ${catalogEntry.name} is GitHub-only (no npm package)`)
            return await resolveGithub(manager, gh, { registry, runtime, notes, target: spec, catalogEntry })
          }
        }
        notes.push(`catalog entry ${catalogEntry.name} has no usable source; falling back to the npm name`)
      }
    }
  }

  if (explicitVersion) {
    return {
      kind: 'npm',
      name,
      spec: `${name}@${explicitVersion}`,
      version: explicitVersion,
      registry,
      runtime,
      catalogEntry,
      notes: [...notes, 'explicit version requested; compatibility not checked'],
    }
  }

  let doc = null
  try {
    doc = await npmPackage(name, registry)
  } catch (error) {
    notes.push(`registry lookup failed (${error.message}); install will resolve the version itself`)
    return { kind: 'npm', name, spec: name, version: null, registry, runtime, catalogEntry, notes }
  }
  const chosen = chooseCompatibleVersion(doc, runtime)
  if (chosen.version === null) {
    throw new Error(
      `${name} has no version compatible with DSH ${runtime ?? 'unknown'}. ` +
        `Nearest rejects: ${chosen.rejected.map((item) => `${item.version} (${item.reason})`).join('; ') || 'none'}`,
    )
  }
  if (chosen.rejected.length > 0) {
    notes.push(
      `skipped newer incompatible versions: ${chosen.rejected.map((item) => `${item.version} (${item.reason})`).join('; ')}`,
    )
  }
  return {
    kind: 'npm',
    name,
    spec: `${name}@${chosen.version}`,
    version: chosen.version,
    latest: doc.tags?.latest ?? null,
    registry,
    runtime,
    catalogEntry,
    notes: [...notes, chosen.reason],
    rejected: chosen.rejected,
  }
}

/**
 * Plan a GitHub-source install.
 *
 * @param {any} manager
 * @param {{repo: string, owner: string, name: string, ref: string | null, subpath: string | null}} gh
 * @param {{registry: string | null, runtime: string | null, notes: string[], target: string, catalogEntry?: any}} context
 * @returns {Promise<Resolution>}
 */
async function resolveGithub(manager, gh, context) {
  const slug = gh.repo
  const label = gh.subpath ? `${slug}/${gh.subpath}` : slug
  const notes = [
    ...context.notes,
    `GitHub source build: ${label}${gh.ref ? ` @ ${gh.ref}` : ''}`,
    'source checkout is built locally (pnpm install + build) and then linked into the profile',
  ]
  if (isDshGo()) {
    const proxy = githubProxyFromEnv()
    notes.push(
      proxy
        ? `dsh-go: 源码包经 ${proxy} 下载`
        : 'dsh-go: 直连 codeload 失败时自动改用 gh-proxy.com / ghfast.top 镜像，可用 DSH_GITHUB_PROXY 指定',
    )
    notes.push('dsh-go: 没有沙箱，构建脚本以 root 运行；只构建可信仓库，大仓库在手机上很慢（超时 10 分钟）')
  }
  return {
    kind: 'github',
    repo: slug,
    owner: gh.owner,
    name: gh.name,
    ref: gh.ref,
    subpath: gh.subpath,
    spec: context.target,
    version: null,
    registry: context.registry,
    runtime: context.runtime,
    catalogEntry: context.catalogEntry ?? null,
    notes,
    label,
  }
}

/**
 * @typedef {object} Resolution
 * @property {'npm' | 'github' | 'spec' | 'ambiguous'} kind
 * @property {string} spec
 * @property {string | null} name
 * @property {string | null} version
 * @property {string | null} registry
 * @property {string | null} runtime
 * @property {string[]} notes
 * @property {Array<{name: string, owner: string, stars: number, npm: string | null, install: string | null, url: string, description: string}>} [candidates]
 * @property {Array<{version: string, reason: string}>} [rejected]
 * @property {any} [catalogEntry]
 * @property {string} [repo]
 * @property {string | null} [ref]
 * @property {string | null} [subpath]
 * @property {string} [latest]
 */

export { normalizeCatalog, compareVersions, repoSlugOf, githubSpecOf }


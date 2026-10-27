// Reloadable module: local dependencies carry this module's `?v=` query.
const __v = new URL(import.meta.url).searchParams.get('v') ?? ''
const __q = (name) => `./${name}${__v === '' ? '' : `?v=${encodeURIComponent(__v)}`}`
const { cacheDir, dshGoRuntime, dshHome, dirExists, githubProxyFromEnv, isDshGo, readJson, runProcess, writeJson } = await import(__q('util.js'))
const { registryBase } = await import(__q('resolve.js'))
/**
 * Installation: drive the profile's plugin manager, build GitHub-only sources,
 * and verify what actually landed.
 *
 * The manager owns `package.json`, the lockfile and the activation lifecycle;
 * this module never edits profile files itself. Registry packages therefore go
 * straight through `installBundle`, and a source checkout is only ever handed
 * to it as a `link:` spec after the build produced the package's main entry.
 *
 * dsh-go adaptation: source downloads remember which GitHub prelude worked on
 * this phone, honour `DSH_GITHUB_PROXY`, fall back to public mirrors, and report
 * build scripts that pnpm 11 refused to run instead of calling the build clean.
 *
 * @module dsh-plugin-resolver/lib/install
 */

import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import path from 'node:path'

/** Longest a source install may run before the tool reports a timeout. */
const BUILD_TIMEOUT_MS = 15 * 60 * 1000
const TARBALL_TIMEOUT_MS = 5 * 60 * 1000
/** On a phone a stalled download must fail over to the next mirror quickly. */
const PHONE_TARBALL_TIMEOUT_MS = 90 * 1000
/** What a source install may take before the tool reports a timeout, on a phone. */
const PHONE_BUILD_TIMEOUT_MS = 10 * 60 * 1000

/** Public GitHub download mirrors tried after a direct codeload attempt. */
const BUILTIN_GITHUB_MIRRORS = ['https://gh-proxy.com', 'https://ghfast.top']

/** How long a remembered prelude stays authoritative. */
const MIRROR_HINT_TTL_MS = 7 * 24 * 60 * 60 * 1000

/**
 * The `pluginManager` service, or a clear failure.
 *
 * @param {any} ctx
 * @returns {any}
 */
export function managerOf(ctx) {
  const manager = ctx.get('pluginManager')
  if (!manager || typeof manager.installBundle !== 'function') {
    throw new Error('the pluginManager service is not mounted in this profile, so installs are unavailable')
  }
  return manager
}

/**
 * Condense one manager ChangeResult for tool output.
 *
 * @param {any} change
 * @returns {{applied: boolean, application: string, stage: string, error?: string, pendingBuilds: string[], logPath?: string, exitCode?: number}}
 */
export function summarizeChange(change) {
  const summary = {
    applied: change?.application === 'applied',
    application: String(change?.application ?? 'failed'),
    stage: String(change?.stage ?? 'install'),
    pendingBuilds: Array.isArray(change?.pendingBuilds) ? change.pendingBuilds : [],
    bundle: typeof change?.bundle === 'string' ? change.bundle : null,
  }
  if (change?.error) {
    const diagnostic = typeof change.error.diagnostic === 'string' ? change.error.diagnostic : ''
    summary.error = `${change.error.code ?? 'error'}${diagnostic ? `: ${tail(diagnostic, 700)}` : ''}`
  }
  if (change?.packageResult) {
    summary.logPath = change.packageResult.logPath
    summary.exitCode = change.packageResult.exitCode
    if (!summary.error && change.packageResult.exitCode !== 0) {
      summary.error = `pnpm exited ${change.packageResult.exitCode}: ${tail(change.packageResult.output, 700)}`
    }
  }
  return summary
}

/** Last `limit` characters, flattened. */
export function tail(text, limit) {
  const flat = String(text ?? '').trim()
  return flat.length <= limit ? flat : `…${flat.slice(-limit)}`
}

/**
 * Install one registry-resolved package spec.
 *
 * @param {any} manager
 * @param {{spec: string, registry?: string | null}} plan
 * @returns {Promise<{change: any, summary: ReturnType<typeof summarizeChange>}>}
 */
export async function installRegistry(manager, plan) {
  const options = { enabled: true }
  if (typeof plan.registry === 'string' && plan.registry !== '') options.registry = plan.registry
  const change = await manager.installBundle(plan.spec, options)
  return { change, summary: summarizeChange(change) }
}

/**
 * Read the installed package manifest through the profile's hoisted
 * `node_modules`, which also tells us whether the package declares a client
 * half. The profile directory comes from the environment when the host exposes
 * it; otherwise the standard `$DSH_HOME/profiles/<name>` layout is tried.
 *
 * @param {string} packageName
 * @returns {Promise<any | undefined>}
 */
export async function installedManifest(packageName) {
  const packageDir = await installedPackageDir(packageName)
  if (packageDir === undefined) return undefined
  try {
    return JSON.parse(await readFile(path.join(packageDir, 'package.json'), 'utf8'))
  } catch {
    return undefined
  }
}

/** Candidate profile directories, most specific first. */
function profileDirs() {
  const dirs = []
  if (process.env.DSH_PROFILE_DIR) dirs.push(process.env.DSH_PROFILE_DIR)
  const home = process.env.DSH_HOME && process.env.DSH_HOME !== '' ? process.env.DSH_HOME : dshHome()
  if (home) {
    const profile = process.env.DSH_PROFILE && process.env.DSH_PROFILE !== '' ? process.env.DSH_PROFILE : isDshGo() ? 'web' : 'desktop'
    // dsh-go only ever mounts the web profile; trying `desktop` first would
    // read another install's manifest and distort the restart decision.
    const fallbacks = isDshGo() ? ['web', 'desktop'] : ['desktop', 'web']
    for (const name of [profile, ...fallbacks]) dirs.push(path.join(home, 'profiles', name))
  }
  return [...new Set(dirs)]
}

/**
 * Locate an installed package directory without assuming one profile layout.
 * @param {string} packageName
 * @returns {Promise<string | undefined>}
 */
export async function installedPackageDir(packageName) {
  for (const profileDir of profileDirs()) {
    const candidate = path.join(profileDir, 'node_modules', packageName)
    if (existsSync(path.join(candidate, 'package.json'))) return candidate
  }
  return undefined
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

/** Runtime files that decide whether the loaded code actually changed. */
async function hashRuntimeFiles(dir) {
  const files = []
  async function walk(current) {
    let entries
    try {
      entries = await readdir(current, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name === 'test' || entry.name === 'tests' || entry.name === 'fixtures' || entry.name === 'examples' || entry.name === '.git' || entry.name === '.github') continue
      if (/^(license|notice|readme)/i.test(entry.name)) continue
      const abs = path.join(current, entry.name)
      if (entry.isDirectory()) {
        await walk(abs)
        continue
      }
      if (!entry.isFile()) continue
      const ext = path.extname(entry.name).toLowerCase()
      if (ext === '.md' || ext === '.markdown' || ext === '.map' || ext === '.d.ts' || ext === '.pdb') continue
      if (entry.name === 'package.json') continue
      try {
        files.push(`${path.relative(dir, abs).split(path.sep).join('/')}:${sha256(await readFile(abs))}`)
      } catch {
        // unreadable runtime file: treating it as absent is safer than crashing
      }
    }
  }
  await walk(dir)
  files.sort()
  return files
}

/**
 * Snapshot the installed package's runtime identity. README/docs and the
 * version field are excluded: those changes do not alter loaded code.
 * @param {string} packageName
 * @returns {Promise<{version: string, hash: string, clientHash: string, hasClient: boolean, dir: string} | null>}
 */
export async function capturePackageRuntime(packageName) {
  const dir = await installedPackageDir(packageName)
  if (dir === undefined) return null
  try {
    const manifest = JSON.parse(await readFile(path.join(dir, 'package.json'), 'utf8'))
    const files = await hashRuntimeFiles(dir)
    const meta = {
      main: manifest.main ?? null,
      exports: manifest.exports ?? null,
      dsh: manifest.dsh ?? null,
      dependencies: manifest.dependencies ?? {},
      peerDependencies: manifest.peerDependencies ?? {},
    }
    const clientFiles = files.filter((line) => /(^|[/\\])[^/\\]*client[^/\\]*\.(?:js|mjs|cjs|ts):/i.test(line))
    return {
      version: String(manifest.version ?? ''),
      hash: sha256(`${JSON.stringify(meta)}\n${files.join('\n')}`),
      clientHash: sha256(clientFiles.join('\n')),
      hasClient: Boolean(manifest.dsh?.client),
      dir,
    }
  } catch {
    return null
  }
}

/**
 * Decide whether install results really require a restart. Changed runtime or
 * client files do; no-op reinstall and metadata-only version bumps do not. A
 * bundle-set change only needs a restart when the manager could not apply it in
 * place — a live profile recomposes and mounts the new bundle itself, in which
 * case an added client half asks for a GUI refresh instead.
 * @param {{before: any, after: any, bundlesBefore: string[], bundlesAfter: string[], managerApplication: string}} input
 */
export function decideRestart({ before, after, bundlesBefore, bundlesAfter, managerApplication }) {
  const beforeNames = new Set(bundlesBefore ?? [])
  const afterNames = new Set(bundlesAfter ?? [])
  const added = [...afterNames].filter((name) => !beforeNames.has(name))
  const removed = [...beforeNames].filter((name) => !afterNames.has(name))
  if (added.length > 0 || removed.length > 0) {
    const changed = [...added, ...removed].join(', ')
    if (managerApplication === 'applied') {
      return { required: false, reason: `manager applied the bundle set change in place (${changed})`, bundleChanged: true, codeChanged: true, clientChanged: Boolean(added.length > 0 && after?.hasClient), versionChanged: false }
    }
    return { required: true, reason: `bundle set changed (${changed})`, bundleChanged: true, codeChanged: true, clientChanged: false, versionChanged: false }
  }
  if (!before || !after) {
    const required = managerApplication === 'restart-required'
    return { required, reason: required ? 'manager requested a restart (no runtime snapshot)' : 'manager applied it in place', bundleChanged: false, codeChanged: false, clientChanged: false, versionChanged: false }
  }
  const versionChanged = before.version !== after.version
  const codeChanged = before.hash !== after.hash
  const clientChanged = Boolean(before.hasClient && after.hasClient && before.clientHash !== after.clientHash)
  if (!codeChanged) {
    return { required: false, reason: versionChanged ? 'runtime files are unchanged (version label only)' : 'runtime files are unchanged', bundleChanged: false, codeChanged: false, clientChanged: false, versionChanged }
  }
  if (managerApplication === 'applied') {
    return { required: false, reason: 'manager applied the change in place', bundleChanged: false, codeChanged: true, clientChanged, versionChanged }
  }
  return { required: true, reason: clientChanged ? 'client half changed' : 'runtime code changed', bundleChanged: false, codeChanged: true, clientChanged, versionChanged }
}

/**
 * Verify a package after installation: loader entry, bundle selection, and
 * whether a client half exists (asked of the live client module table first,
 * because that is what actually decides whether a refresh will show it).
 *
 * @param {any} ctx
 * @param {any} manager
 * @param {string} packageName
 * @returns {Promise<{entry?: any, bundle?: any, manifest?: any, hasClient: boolean, clientSource: string}>}
 */
export async function verifyInstall(ctx, manager, packageName) {
  let entry
  let bundle
  try {
    const plugins = await manager.listPlugins()
    entry = plugins.find(
      (plugin) =>
        plugin.moduleName === packageName ||
        (typeof plugin.moduleName === 'string' && plugin.moduleName.endsWith(`/${packageName}`)),
    )
  } catch {
    entry = undefined
  }
  try {
    const bundles = await manager.listBundles()
    bundle = bundles.find((item) => item.name === packageName)
  } catch {
    bundle = undefined
  }
  let hasClient = false
  let clientSource = 'none'
  const clientModules = ctx.get('clientModules')
  if (clientModules && typeof clientModules.clientPath === 'function') {
    try {
      hasClient = Boolean(clientModules.clientPath(packageName))
      if (hasClient) clientSource = 'client table'
    } catch {
      // fall through to the manifest
    }
  }
  const manifest = await installedManifest(packageName)
  if (!hasClient && manifest?.dsh?.client) {
    hasClient = true
    clientSource = 'manifest'
  }
  return { entry, bundle, manifest, hasClient, clientSource }
}

/** The `dsh` executable a deep verification boot would run. */
function dshBinary() {
  const explicit = process.env.DSH_BIN
  if (typeof explicit === 'string' && explicit !== '' && existsSync(explicit)) return explicit
  return process.platform === 'win32' ? 'dsh.cmd' : 'dsh'
}

/** The profile this host runs, as `dsh --profile` names it. */
export function profileName(ctx, packageName) {
  const manager = ctx?.get?.('pluginManager')
  const fromManager = manager?.profile?.name
  if (typeof fromManager === 'string' && fromManager !== '') return fromManager
  if (typeof process.env.DSH_PROFILE === 'string' && process.env.DSH_PROFILE !== '') return process.env.DSH_PROFILE
  if (typeof process.env.DSH_PROFILE_DIR === 'string' && process.env.DSH_PROFILE_DIR !== '') return path.basename(process.env.DSH_PROFILE_DIR)
  // Last resort: the only profile whose bundle list names this package.
  if (typeof packageName === 'string' && packageName !== '') {
    const root = path.join(dshHome(), 'profiles')
    try {
      const matches = readdirSync(root, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .filter((name) => {
          try {
            const manifest = JSON.parse(readFileSync(path.join(root, name, 'package.json'), 'utf8'))
            return Array.isArray(manifest?.dsh?.profile?.bundles) && manifest.dsh.profile.bundles.includes(packageName)
          } catch {
            return false
          }
        })
      if (matches.length === 1) return matches[0]
    } catch {
      // no readable profile root
    }
  }
  return 'web'
}

/**
 * Optional deep verification (`verify: "deep"`): prove the package is part of
 * the composed profile and, when this host has no live HMR to apply it in
 * place, boot the profile once to see whether every entry activates.
 *
 * The boot is the honest-but-slow path a phone should only take when the user
 * asks for certainty: one `dsh --profile <p> --help` mounts the whole tree and
 * costs roughly 4 s clean, up to ~30 s with heavy plugins.
 *
 * @param {any} ctx
 * @param {string} packageName
 * @returns {Promise<{profile: string, composed: boolean, booted: boolean, bootMs?: number, ok: boolean, reason: string, problems?: string[]}>}
 */
export async function deepVerify(ctx, packageName) {
  const profile = profileName(ctx, packageName)
  const dsh = dshBinary()
  const dump = await runProcess(dsh, ['--profile', profile, '--dump-config'], { timeoutMs: 90_000 })
  const composed = dump.code === 0 && String(dump.output ?? '').includes(packageName)
  const hmr = ctx.get('hmr')
  // Never boot a second copy of the app that owns the port: a live HMR host
  // applies the install itself, and the `web` profile is the running app.
  if ((hmr !== undefined && hmr !== null) || profile === 'web') {
    return {
      profile,
      composed,
      booted: false,
      ok: composed,
      reason: composed
        ? hmr !== undefined && hmr !== null
          ? 'the composed profile names the package; the live host applies it in place'
          : 'the composed profile names the package; restart the web engine to load it'
        : 'the composed profile does not name the package',
    }
  }
  const started = Date.now()
  const boot = await runProcess(dsh, ['--profile', profile, '--help'], { timeoutMs: 180_000 })
  const bootMs = Date.now() - started
  const problems = String(boot.output ?? '')
    .split(/\r?\n/)
    .filter((line) => /did not activate|failed to (?:load|activate|mount)|^error:/i.test(line.trim()))
    .slice(0, 3)
  const ok = composed && boot.code === 0 && problems.length === 0
  const reason = !composed
    ? 'the composed profile does not name the package'
    : boot.code !== 0
      ? `boot exited ${boot.code}`
      : problems.length > 0
        ? problems.join('; ')
        : `booted in ${(bootMs / 1000).toFixed(1)} s with every entry active`
  return { profile, composed, booted: true, bootMs, ok, reason, problems }
}

/** Locate a pnpm executable usable for a source build. */
export function resolvePnpm() {
  const explicit = process.env.DSH_PNPM_PATH ?? process.env.DSH_GO_PNPM_PATH
  if (typeof explicit === 'string' && explicit !== '' && existsSync(explicit)) return explicit
  for (const candidate of ['/usr/local/bin/pnpm', '/usr/bin/pnpm', '/opt/pnpm/bin/pnpm']) {
    if (existsSync(candidate)) return candidate
  }
  return process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
}

/** Timeout for one source build step on this host. */
function buildTimeoutMs() {
  return isDshGo() ? PHONE_BUILD_TIMEOUT_MS : BUILD_TIMEOUT_MS
}

/** Timeout for one tarball download on this host. */
function tarballTimeoutMs() {
  return isDshGo() ? PHONE_TARBALL_TIMEOUT_MS : TARBALL_TIMEOUT_MS
}

/** Where the working GitHub prelude for this host is remembered. */
function mirrorHintFile() {
  return path.join(cacheDir(), 'github-mirror.json')
}

/**
 * The last GitHub prelude that worked, when recent enough to trust.
 *
 * @returns {Promise<{prelude: string, at: number} | undefined>}
 */
async function readMirrorHint() {
  const stored = await readJson(mirrorHintFile())
  if (!stored || typeof stored.prelude !== 'string' || !Number.isFinite(stored.at)) return undefined
  if (Date.now() - stored.at > MIRROR_HINT_TTL_MS) return undefined
  return { prelude: stored.prelude, at: stored.at }
}

/** Remember which prelude (empty string = direct) served a download. */
async function writeMirrorHint(prelude) {
  await writeJson(mirrorHintFile(), { prelude, at: Date.now() }).catch(() => {})
}

/**
 * Download preludes in the order this host should try them: the one that worked
 * last time, an explicitly configured mirror, the direct URL, then public
 * mirrors. `''` means "no prelude, talk to codeload directly".
 *
 * @param {{githubProxy?: string}} options
 * @returns {Promise<string[]>}
 */
async function githubPreludes(options) {
  const ordered = []
  const push = (value) => {
    const prelude = typeof value === 'string' ? value.replace(/\/+$/, '') : ''
    if (!ordered.includes(prelude)) ordered.push(prelude)
  }
  const hint = await readMirrorHint()
  if (hint) push(hint.prelude)
  const explicit = options.githubProxy ?? githubProxyFromEnv()
  if (explicit) push(explicit)
  // A blocked codeload would otherwise burn the whole download timeout before
  // the first mirror is even tried; probe it once and skip the direct attempt.
  if (await directCodeloadReachable()) push('')
  for (const mirror of BUILTIN_GITHUB_MIRRORS) push(mirror)
  return ordered
}

/** Cached verdict on whether codeload is reachable from this network. */
let directProbe

/** Probe codeload once per ten minutes with a short timeout. */
async function directCodeloadReachable() {
  if (directProbe !== undefined && Date.now() - directProbe.at < 10 * 60 * 1000) return directProbe.ok
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), isDshGo() ? 5_000 : 10_000)
  let ok = false
  try {
    const response = await fetch('https://codeload.github.com/', { method: 'HEAD', signal: controller.signal, redirect: 'manual' })
    ok = response.status < 500
  } catch {
    ok = false
  } finally {
    clearTimeout(timer)
  }
  directProbe = { at: Date.now(), ok }
  return ok
}

/**
 * Ensure the GitHub checkout exists, downloading the repository tarball once.
 *
 * @param {{repo: string, ref: string | null}} plan
 * @param {{githubProxy?: string}} options
 * @returns {Promise<{dir: string, from: 'checkout' | 'download', prelude?: string}>}
 */
export async function ensureCheckout(plan, options = {}) {
  const slug = plan.repo
  const safe = slug.replace(/[^A-Za-z0-9._-]+/g, '__')
  const root = path.join(dshHome(), 'plugin-sources', safe)
  if (dirExists(path.join(root, 'package.json')) || dirExists(path.join(root, '.git'))) {
    return { dir: root, from: 'checkout' }
  }
  const refs = plan.ref ? [plan.ref] : ['main', 'master']
  const preludes = await githubPreludes(options)
  const attempts = []
  for (const ref of refs) {
    const direct = `https://codeload.github.com/${slug}/tar.gz/refs/heads/${ref}`
    for (const prelude of preludes) {
      const url = prelude === '' ? direct : `${prelude}/${direct}`
      try {
        const bytes = await download(url, tarballTimeoutMs())
        const temp = path.join(dshHome(), 'cache', 'plugin-resolver', `src-${safe}-${Date.now()}`)
        await rm(temp, { recursive: true, force: true })
        await mkdir(temp, { recursive: true })
        const tarball = path.join(temp, 'repo.tar.gz')
        await writeFile(tarball, bytes)
        const extractDir = path.join(temp, 'extract')
        await mkdir(extractDir, { recursive: true })
        const tar = process.platform === 'win32' ? 'tar.exe' : 'tar'
        const extracted = await runProcess(tar, ['-xzf', tarball, '-C', extractDir], { timeoutMs: 120_000 })
        if (extracted.code !== 0) throw new Error(`tar exited ${extracted.code}`)
        const children = (await readdir(extractDir, { withFileTypes: true })).filter((item) => item.isDirectory())
        if (children.length !== 1) throw new Error('unexpected tarball layout')
        await rm(root, { recursive: true, force: true })
        await mkdir(path.dirname(root), { recursive: true })
        await rename(path.join(extractDir, children[0].name), root)
        await rm(temp, { recursive: true, force: true })
        await writeMirrorHint(prelude)
        return { dir: root, from: 'download', ...(prelude === '' ? {} : { prelude }) }
      } catch (error) {
        attempts.push(`${url} -> ${error.message}`)
      }
    }
  }
  throw new Error(`could not download ${slug}: ${attempts.join(' | ')}`)
}

/** Download a URL into memory with a bounded timeout. */
async function download(url, timeoutMs = TARBALL_TIMEOUT_MS) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url, { signal: controller.signal, redirect: 'follow' })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    return Buffer.from(await response.arrayBuffer())
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Build-script names pnpm 11 reported as skipped, from its install output.
 *
 * pnpm 10+ blocks dependency lifecycle scripts unless the profile approves
 * them. A build that "succeeded" with skipped scripts may still have produced no
 * usable output, so the caller reports these instead of staying silent.
 *
 * @param {string} output
 * @returns {string[]}
 */
export function ignoredBuildScripts(output) {
  const text = String(output ?? '')
  const names = []
  const match = /Ignored build scripts:([^\n]*)/i.exec(text)
  if (match) {
    for (const part of match[1].split(',')) {
      const name = part.trim().replace(/[\s.]+$/, '')
      if (name !== '' && !names.includes(name)) names.push(name)
    }
  }
  return names
}

/**
 * Build a GitHub-only plugin from its checkout when the package ships no
 * built output, then install it as a `link:` package.
 *
 * @param {any} manager
 * @param {any} plan a resolution of kind `github`
 * @param {{githubProxy?: string, skipBuild?: boolean, log?: (line: string) => void}} options
 * @returns {Promise<{packageName: string, packageDir: string, built: boolean, steps: string[], change: any, summary: ReturnType<typeof summarizeChange>}>}
 */
export async function installGithubSource(manager, plan, options = {}) {
  const log = options.log ?? (() => {})
  const steps = []
  const warnings = []
  const checkout = await ensureCheckout(plan, options)
  steps.push(`checkout: ${checkout.dir} (${checkout.from}${checkout.prelude ? ` via ${checkout.prelude}` : ''})`)
  log(`${checkout.from === 'download' ? 'download' : 'reuse'} ${plan.repo}${checkout.prelude ? ` via ${checkout.prelude}` : ''}`)

  const packageDir = plan.subpath ? path.join(checkout.dir, plan.subpath) : checkout.dir
  if (!dirExists(packageDir)) throw new Error(`subpath "${plan.subpath}" does not exist in ${plan.repo}`)
  const manifestPath = path.join(packageDir, 'package.json')
  if (!existsSync(manifestPath)) throw new Error(`${packageDir} has no package.json`)
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  const packageName = typeof manifest.name === 'string' ? manifest.name : null
  if (!packageName) throw new Error(`${manifestPath} has no package name`)

  const mainEntry = typeof manifest.main === 'string' && manifest.main !== '' ? manifest.main : 'index.js'
  const builtPath = path.join(packageDir, mainEntry)
  let built = existsSync(builtPath)
  if (!built && options.skipBuild === true) {
    throw new Error(`${packageName} ships no build output (${mainEntry} missing) and building was disabled`)
  }
  if (!built) {
    if (!manifest.scripts || typeof manifest.scripts.build !== 'string') {
      throw new Error(
        `${packageName} ships no build output and declares no "build" script; nothing this plugin can build automatically`,
      )
    }
    if (isDshGo()) {
      warnings.push('dsh-go: 构建脚本以 root 在手机宿主上执行，第三方 install/build 脚本能读到 ~/.dsh 下的凭据；只构建你信任的仓库。')
    }
    const pnpm = resolvePnpm()
    const registry = registryBase(plan.registry)
    const env = { npm_config_registry: registry, npm_config_fund: 'false', npm_config_audit: 'false', CI: '1' }
    const timeoutMs = buildTimeoutMs()
    const install = await runProcess(pnpm, ['install', '--no-frozen-lockfile', '--reporter=append-only'], {
      cwd: checkout.dir,
      env,
      timeoutMs,
      onLine: log,
    })
    if (install.code !== 0) {
      throw new Error(`dependency install failed (exit ${install.code}): ${tail(install.output, 900)}`)
    }
    steps.push(`deps: pnpm install in ${checkout.dir}`)
    const skipped = ignoredBuildScripts(install.output)
    const build = await runProcess(pnpm, ['run', 'build'], {
      cwd: packageDir,
      env,
      timeoutMs,
      onLine: log,
    })
    if (build.code !== 0) {
      throw new Error(`build failed (exit ${build.code}): ${tail(build.output, 900)}`)
    }
    steps.push(`build: pnpm run build in ${packageDir}`)
    for (const name of ignoredBuildScripts(build.output)) {
      if (!skipped.includes(name)) skipped.push(name)
    }
    if (skipped.length > 0) {
      warnings.push(
        `pnpm 11 跳过了依赖的构建脚本：${skipped.join(', ')}。产物可能不完整；需要时在 checkout 里运行 pnpm approve-builds 后重试。`,
      )
    }
    built = existsSync(builtPath)
    if (!built) throw new Error(`build finished but ${mainEntry} still does not exist`)
  }
  log(`install link:${packageDir}`)
  const change = await manager.installBundle(`link:${packageDir}`, { enabled: true })
  steps.push(`install: link:${packageDir}`)
  return { packageName, packageDir, built, steps, warnings, change, summary: summarizeChange(change) }
}


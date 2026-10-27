/**
 * Host shell: tool schemas, the profile's plugin manager, and one cache-busted
 * import of the reloadable logic entry.
 *
 * This file is the only part that needs a host restart to change. Everything
 * under `logic/` is imported with `?v=<newest logic mtime>` on every tool call,
 * so logic edits are live on the next call — Node caches ES modules by full
 * URL, and a changed query string is a new URL.
 *
 * @module dsh-plugin-resolver/host/register
 */

import { statSync } from 'node:fs'

/** Logic directory, resolved next to this file. */
const LOGIC_DIR = new URL('../logic/', import.meta.url)

/** Files whose mtimes make up the logic version. */
const LOGIC_FILES = ['api.js', 'catalog.js', 'resolve.js', 'semver.js', 'install.js', 'util.js', 'view.js']

const SEARCH_TIMEOUT_MS = 120_000
const INSTALL_TIMEOUT_MS = 20 * 60 * 1000

/**
 * A version string that changes whenever any logic file changes.
 *
 * @returns {string}
 */
export function logicVersion() {
  let newest = 0
  for (const file of LOGIC_FILES) {
    try {
      const stat = statSync(new URL(file, LOGIC_DIR))
      if (stat.mtimeMs > newest) newest = stat.mtimeMs
    } catch {
      // a missing file cannot raise the version
    }
  }
  return String(Math.round(newest))
}

/**
 * Import the logic entry fresh whenever its files changed.
 *
 * @returns {Promise<any>}
 */
export async function loadLogic() {
  const url = new URL('api.js', LOGIC_DIR)
  url.searchParams.set('v', logicVersion())
  return await import(url.href)
}

/**
 * Register the resolver tool set on `ctx.tools`.
 *
 * @param {any} ctx Cordis context
 * @param {{catalogUrl?: string, catalogTtlMs?: number, registry?: string, githubProxy?: string, hotMount?: boolean}} options
 * @returns {Array<() => void>} disposers owned by the caller's effect
 */
export function registerTools(ctx, options) {
  const disposers = []
  /** @param {any} definition */
  const add = (definition) => {
    const dispose = ctx.tools.register({
      ...definition,
      output: {
        // `text` is what the model receives; `view` is a dsh-go card the phone
        // app draws from presentationMeta. Desktop clients ignore both the card
        // and the extra field, so one tool output serves both hosts.
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            text: { type: 'string' },
            view: { type: 'object' },
          },
          required: ['text'],
        },
        render: (_args, value) => [{ type: 'text', text: typeof value?.text === 'string' ? value.text : '' }],
        presentationMeta: (_args, value) => (value?.view && typeof value.view === 'object' ? { 'dsh-go/view': value.view } : {}),
      },
    })
    if (typeof dispose === 'function') disposers.push(dispose)
  }

  /** Run one logic entry point with the shell-owned context and options. */
  const run = async (method, args) => {
    try {
      const logic = await loadLogic()
      const fn = logic[method]
      if (typeof fn !== 'function') throw new Error(`logic entry does not export ${method}`)
      return await fn(ctx, ctx.get('pluginManager'), options, args)
    } catch (error) {
      return { text: `${method} failed: ${error?.message ?? String(error)}` }
    }
  }

  add({
    name: 'plugin_search',
    description:
      'Search the DSH community plugin catalog. Returns ranked entries with owner, stars, npm package and the documented install command, and flags same-name ambiguity so a bare name is never guessed. Read-only.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        query: { type: 'string', description: 'Name, keyword, owner, or a partial description fragment.' },
        limit: { type: 'number', description: 'Maximum results, 1-25. Defaults to 8.' },
        refresh: { type: 'boolean', description: 'Ignore the cached catalog and refetch it.' },
      },
      required: ['query'],
    },
    timeoutMs: SEARCH_TIMEOUT_MS,
    execute: (args) => run('pluginSearch', args),
  })

  add({
    name: 'plugin_resolve',
    description:
      'Resolve a plugin name, name@version or install spec into a concrete plan WITHOUT installing: which catalog entry, which published version accepts the running DSH version, which registry is used, and whether a GitHub source build is required. Use before plugin_install when the target is ambiguous.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        target: { type: 'string', description: 'Catalog name, npm name, name@version, or a github:/link: spec.' },
        owner: { type: 'string', description: 'Repository owner, when several catalog entries share the name.' },
        version: { type: 'string', description: 'Pin an exact version instead of resolving a compatible one.' },
        registry: { type: 'string', description: 'Registry URL to ask first.' },
        refresh: { type: 'boolean', description: 'Refetch the catalog instead of using the cache.' },
      },
      required: ['target'],
    },
    timeoutMs: SEARCH_TIMEOUT_MS,
    execute: (args) => run('pluginResolve', args),
  })

  add({
    name: 'plugin_install',
    description:
      'Install a DSH plugin end to end: resolve a DSH-compatible version, install through the profile plugin manager (registry mirror included), build GitHub-only sources when they ship no build output, then verify the loader entry and report whether a GUI refresh or restart is needed. Call this directly with the package name; plugin_resolve is only needed for an ambiguous name or when the user asks for a plan first. Use verify="deep" only when the user explicitly asks to prove the plugin loads.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        target: { type: 'string', description: 'Catalog name, npm name, name@version, or a github:/link: spec.' },
        owner: { type: 'string', description: 'Repository owner, when several catalog entries share the name.' },
        version: { type: 'string', description: 'Pin an exact version instead of resolving a compatible one.' },
        registry: { type: 'string', description: 'Registry URL to ask first, e.g. https://registry.npmmirror.com.' },
        skipBuild: { type: 'boolean', description: 'Refuse rather than build when a GitHub source has no build output.' },
        verify: {
          type: 'string',
          enum: ['quick', 'deep'],
          description:
            'quick (default) reads the live loader state only. deep additionally boots the profile once to prove every entry activates; it costs about 4-30 s and no model tokens, so choose it only on an explicit request.',
        },
        refresh: { type: 'boolean', description: 'Refetch the catalog instead of using the cache.' },
      },
      required: ['target'],
    },
    timeoutMs: INSTALL_TIMEOUT_MS,
    execute: (args) => run('pluginInstall', args),
  })

  add({
    name: 'plugin_status',
    description:
      'Report third-party plugins in this profile: installed bundles with versions, their loader entries, enablement and fiber phase. Use it to check whether an earlier install actually mounted, or what is currently active.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        query: { type: 'string', description: 'Optional substring filter over bundle and entry names.' },
      },
    },
    timeoutMs: 60_000,
    execute: (args) => run('pluginStatus', args),
  })

  return disposers
}

/**
 * dsh-plugin-resolver — host half.
 *
 * Adds four model-facing tools that turn "install this plugin for me" into a
 * deterministic flow instead of manual trial and error:
 *
 * - `plugin_search`   search the community catalog, disambiguating same names
 * - `plugin_resolve`  pick a concrete install spec and a DSH-compatible version
 * - `plugin_install`  install through the profile's plugin manager, building
 *                     GitHub-only sources when they ship no build output
 * - `plugin_status`   report installed bundles, entries and their fiber phase
 *
 * The plugin owns no service of its own. Tool schemas and the plugin-manager
 * bridge live in `host/register.js` (stable, needs a restart to change); the
 * actual decision logic lives under `logic/` and is re-imported with a
 * cache-busted URL on every call, so logic edits take effect without a host
 * restart.
 *
 * @module dsh-plugin-resolver
 */

import { registerTools } from './host/register.js'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'plugin-resolver'

/** Services required by this plugin; the rest are read through `ctx.get`. */
export const inject = ['tools']

/**
 * Mount the resolver tools.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {Record<string, unknown> | undefined} config plugin config
 * @returns {void}
 */
export function apply(ctx, config) {
  const options = normalizeConfig(config)
  ctx.effect(() => {
    const disposers = registerTools(ctx, options)
    return () => {
      for (const dispose of disposers) dispose()
    }
  }, 'plugin-resolver: tools')
}

/**
 * Read the plugin config defensively: patch rows may omit every field.
 *
 * @param {Record<string, unknown> | undefined} config
 * @returns {{catalogUrl?: string, catalogTtlMs?: number, registry?: string, githubProxy?: string}}
 */
function normalizeConfig(config) {
  const value = config ?? {}
  /** @type {{catalogUrl?: string, catalogTtlMs?: number, registry?: string, githubProxy?: string}} */
  const options = {}
  if (typeof value.catalogUrl === 'string' && value.catalogUrl !== '') options.catalogUrl = value.catalogUrl
  if (Number.isFinite(value.catalogTtlMs) && value.catalogTtlMs > 0) options.catalogTtlMs = Number(value.catalogTtlMs)
  if (typeof value.registry === 'string' && value.registry !== '') options.registry = value.registry
  if (typeof value.githubProxy === 'string' && value.githubProxy !== '') options.githubProxy = value.githubProxy
  return options
}

// Reloadable module: every local dependency is imported with this module's own
// `?v=` query, so a cache-busted entry import reloads the whole graph together.
const __v = new URL(import.meta.url).searchParams.get('v') ?? ''
const __q = (name) => `./${name}${__v === '' ? '' : `?v=${encodeURIComponent(__v)}`}`
const { cacheDir, dirExists, fetchBuffer, fetchJson, oneLine, readJson, writeJson } = await import(__q('util.js'))
/**
 * The community plugin catalog: fetch, normalize, cache, and search it.
 *
 * The curated list is the same one the in-app market reads. Its home is a
 * GitHub Pages URL, which is slow and sometimes unreachable from mainland
 * China, so the primary source is the `dsh-plugin-catalog` npm package: every
 * npm mirror carries it, and the `dist.tarball` field keeps the download on
 * whichever registry answered. The origin URL stays as the last fallback for
 * deployments that cannot reach a registry.
 *
 * Same display names repeat across owners, which is why search keeps the owner
 * in view and reports ambiguity instead of guessing.
 *
 * @module dsh-plugin-resolver/lib/catalog
 */

import { gunzipSync } from 'node:zlib'
import path from 'node:path'

const DEFAULT_CATALOG_URL = 'https://awesome-dsh-plugin.com/plugins.json'
const DEFAULT_TTL_MS = 12 * 60 * 60 * 1000
const CATALOG_PACKAGE = 'dsh-plugin-catalog'
const DEFAULT_CATALOG_REGISTRIES = ['https://registry.npmmirror.com', 'https://registry.npmjs.org']

/**
 * Load the catalog: fresh cache first, then the npm carrier, then the origin.
 *
 * @param {{catalogUrl?: string, catalogTtlMs?: number, catalogRegistries?: string[], registry?: string}} options
 * @param {{force?: boolean}} [control]
 * @returns {Promise<{entries: CatalogEntry[], fetchedAt: number, fromCache: boolean, source: string, version?: string, error?: string}>}
 */
export async function loadCatalog(options, control = {}) {
  const file = path.join(cacheDir(), 'catalog.json')
  const ttl = options.catalogTtlMs ?? DEFAULT_TTL_MS
  if (!control.force) {
    const cached = await readJson(file)
    if (cached && Array.isArray(cached.entries) && Number.isFinite(cached.fetchedAt)) {
      if (Date.now() - cached.fetchedAt < ttl) {
        return {
          entries: cached.entries,
          fetchedAt: cached.fetchedAt,
          fromCache: true,
          source: typeof cached.source === 'string' ? cached.source : 'cache',
          version: cached.version,
        }
      }
    }
  }

  const attempts = []
  const registries = [
    ...(Array.isArray(options.catalogRegistries) ? options.catalogRegistries : []),
    options.registry,
    ...DEFAULT_CATALOG_REGISTRIES,
  ].filter((value, index, list) => typeof value === 'string' && value !== '' && list.indexOf(value) === index)

  for (const registry of registries) {
    try {
      const carried = await catalogFromPackage(registry)
      const entries = normalizeCatalog(carried.raw)
      const fetchedAt = Date.now()
      await writeJson(file, { fetchedAt, source: 'npm', version: carried.version, entries })
      return { entries, fetchedAt, fromCache: false, source: 'npm', version: carried.version }
    } catch (error) {
      attempts.push(`${registry}: ${error.message}`)
    }
  }

  const urls = [options.catalogUrl, DEFAULT_CATALOG_URL].filter(
    (value, index, list) => typeof value === 'string' && value !== '' && list.indexOf(value) === index,
  )
  for (const url of urls) {
    try {
      const raw = await fetchJson(url, { timeoutMs: 180_000 })
      const entries = normalizeCatalog(raw)
      const fetchedAt = Date.now()
      await writeJson(file, { fetchedAt, source: 'url', entries })
      return { entries, fetchedAt, fromCache: false, source: 'url' }
    } catch (error) {
      attempts.push(`${url}: ${error.message}`)
    }
  }

  return {
    entries: [],
    fetchedAt: 0,
    fromCache: false,
    source: 'unavailable',
    error: `catalog unavailable (${attempts.join(' | ')})`,
  }
}

/**
 * Read `plugins.json` out of the published catalog package via one registry.
 *
 * @param {string} registry
 * @returns {Promise<{raw: any, version: string | null}>}
 */
async function catalogFromPackage(registry) {
  const base = registry.replace(/\/+$/, '')
  const meta = await fetchJson(`${base}/${CATALOG_PACKAGE}/latest`, { timeoutMs: 20_000 })
  const version = typeof meta?.version === 'string' ? meta.version : null
  const tarball = typeof meta?.dist?.tarball === 'string' ? meta.dist.tarball : null
  if (tarball === null) throw new Error('package metadata names no tarball')
  const bytes = await fetchBuffer(tarball, { timeoutMs: 90_000 })
  const file = fileFromTarball(bytes, 'package/plugins.json')
  if (file === null) throw new Error('catalog package carries no package/plugins.json')
  return { raw: JSON.parse(file.toString('utf8')), version }
}

/**
 * Extract one regular file from a gzipped tar.
 *
 * @param {Buffer} gz
 * @param {string} wanted
 * @returns {Buffer | null}
 */
export function fileFromTarball(gz, wanted) {
  const buffer = gunzipSync(gz)
  const BLOCK = 512
  let offset = 0
  while (offset + BLOCK <= buffer.length) {
    const name = buffer
      .toString('utf8', offset, offset + 100)
      .replace(/\0[\s\S]*$/, '')
    if (name === '') break
    const rawSize = buffer
      .toString('ascii', offset + 124, offset + 136)
      .replace(/\0[\s\S]*$/, '')
      .trim()
    const size = Number.parseInt(rawSize, 8)
    if (!Number.isFinite(size) || size < 0) break
    const type = String.fromCharCode(buffer[offset + 156] ?? 0)
    offset += BLOCK
    if ((type === '0' || type === '\0') && name === wanted) {
      return buffer.subarray(offset, offset + size)
    }
    offset += Math.ceil(size / BLOCK) * BLOCK
  }
  return null
}

/**
 * Normalize one raw catalog payload.
 *
 * @typedef {object} CatalogEntry
 * @property {string} name display name, possibly `name#subpath`
 * @property {string} owner repository owner
 * @property {string} url repository URL
 * @property {string | null} npm published npm package name
 * @property {string | null} version catalogued version
 * @property {number} stars
 * @property {string | null} install the documented install command
 * @property {string} description one-line, English preferred
 * @property {string} category
 * @property {string} added
 *
 * @param {any} raw
 * @returns {CatalogEntry[]}
 */
export function normalizeCatalog(raw) {
  const list = Array.isArray(raw) ? raw : raw?.plugins ?? raw?.entries ?? []
  const entries = []
  for (const item of list) {
    if (!item || typeof item.name !== 'string' || item.name === '') continue
    entries.push({
      name: item.name,
      owner: typeof item.owner === 'string' ? item.owner : '',
      url: typeof item.url === 'string' ? item.url : '',
      npm: typeof item.npm === 'string' && item.npm !== '' ? item.npm : null,
      version: typeof item.version === 'string' && item.version !== '' ? item.version : null,
      stars: Number(item.stars) || 0,
      install: typeof item.install === 'string' ? item.install : null,
      description: oneLine(item.description?.en ?? item.description?.zh ?? '', 160),
      category: typeof item.category === 'string' ? item.category : '',
      added: typeof item.added === 'string' ? item.added : '',
    })
  }
  return entries
}

/** Base display name without the monorepo subpath suffix. */
export function baseName(entry) {
  const at = entry.name.indexOf('#')
  return at === -1 ? entry.name : entry.name.slice(0, at)
}

/**
 * Rank catalog entries for one query.
 *
 * Scoring prefers an exact display name, then a shared prefix, then tokens in
 * the name/owner/description; star count only breaks ties. Same-name results
 * are all returned so the caller can present the ambiguity instead of guessing.
 *
 * @param {CatalogEntry[]} entries
 * @param {string} query
 * @param {{limit?: number, installed?: Set<string>}} [options]
 * @returns {{matches: Array<{entry: CatalogEntry, score: number, installed: boolean}>, ambiguous: boolean}}
 */
export function searchCatalog(entries, query, options = {}) {
  const limit = Math.max(1, Math.min(options.limit ?? 8, 25))
  const raw = String(query ?? '').trim().toLowerCase()
  if (raw === '') return { matches: [], ambiguous: false }
  const tokens = raw.split(/[\s/]+/).filter(Boolean)
  const matches = []
  for (const entry of entries) {
    const name = entry.name.toLowerCase()
    const base = baseName(entry).toLowerCase()
    const owner = entry.owner.toLowerCase()
    const npmName = (entry.npm ?? '').toLowerCase()
    const description = entry.description.toLowerCase()
    let score = 0
    if (base === raw) score = 1000
    else if (name === raw) score = 990
    else if (base.startsWith(raw)) score = 700
    else if (name.startsWith(raw)) score = 690
    else if (npmName !== '' && npmName === raw) score = 800
    else if (name.includes(raw)) score = 400
    else if (owner === raw) score = 350
    else if (description.includes(raw)) score = 120
    else {
      let tokenHits = 0
      for (const token of tokens) {
        if (name.includes(token)) tokenHits += 1
        else if (owner.includes(token)) tokenHits += 0.5
        else if (description.includes(token)) tokenHits += 0.25
      }
      if (tokenHits === 0) continue
      score = 200 + tokenHits * 20
    }
    score += Math.min(entry.stars, 10_000) / 100_000
    if (entry.npm && options.installed?.has(entry.npm)) score += 0.5
    matches.push({ entry, score, installed: Boolean(entry.npm && options.installed?.has(entry.npm)) })
  }
  matches.sort((a, b) => b.score - a.score || b.entry.stars - a.entry.stars)
  const limited = matches.slice(0, limit)
  const names = new Map()
  for (const { entry } of limited) {
    const key = baseName(entry).toLowerCase()
    names.set(key, (names.get(key) ?? 0) + 1)
  }
  const ambiguous = [...names.values()].some((count) => count > 1)
  return { matches: limited, ambiguous }
}

/** Extract `github:owner/repo#...` from a documented install command. */
export function githubSpecOf(entry) {
  if (entry.install) {
    const match = /github:[^\s"']+/.exec(entry.install)
    if (match) return match[0]
  }
  const urlMatch = /^https:\/\/github\.com\/([^/]+)\/([^/]+)(?:\/tree\/[^/]+\/(.+))?/.exec(entry.url)
  if (!urlMatch) return null
  const subpath = urlMatch[3] ? `#path:/${urlMatch[3]}` : ''
  return `github:${urlMatch[1]}/${urlMatch[2]}${subpath}`
}

/** Extract the repository slug (`owner/repo`) for a catalog entry. */
export function repoSlugOf(entry) {
  const match = /github\.com\/([^/]+)\/([^/]+)/.exec(entry.url ?? '')
  if (!match) return null
  return `${match[1]}/${match[2].replace(/\.git$/, '')}`
}

/** Repository checkout directory for a GitHub source build. */
export function sourceDirOf(repoSlug) {
  const safe = repoSlug.replace(/[^A-Za-z0-9._-]+/g, '__')
  const home = process.env.DSH_HOME && process.env.DSH_HOME !== '' ? process.env.DSH_HOME : ''
  return path.join(home, 'plugin-sources', safe)
}

/** Whether a repository checkout already exists. */
export function hasSourceCheckout(dir) {
  return dir !== '' && dirExists(dir)
}


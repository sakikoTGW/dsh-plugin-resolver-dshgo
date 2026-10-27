/**
 * The slice of semver this plugin needs: parse versions, compare them, and
 * decide whether a version satisfies a range.
 *
 * Semantics intentionally match the Host's own compatibility preflight, which
 * compares with `includePrerelease: true`: prerelease versions are ordinary
 * values, so `0.2.0-rc.2` satisfies `^0.2.0-rc.2` but not `^0.2.1-rc.1`.
 *
 * @module dsh-plugin-resolver/lib/semver
 */

const VERSION_RE = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/

/**
 * Parse a full semver version.
 *
 * @param {unknown} value
 * @returns {{major: number, minor: number, patch: number, pre: string[]} | null}
 */
export function parseVersion(value) {
  const match = VERSION_RE.exec(String(value ?? '').trim())
  if (!match) return null
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    pre: match[4] ? match[4].split('.') : [],
  }
}

/**
 * Compare two parsed versions.
 *
 * @param {{major: number, minor: number, patch: number, pre: string[]}} left
 * @param {{major: number, minor: number, patch: number, pre: string[]}} right
 * @returns {number} -1, 0, or 1
 */
export function compareParsed(left, right) {
  for (const key of ['major', 'minor', 'patch']) {
    if (left[key] !== right[key]) return left[key] < right[key] ? -1 : 1
  }
  if (left.pre.length === 0 && right.pre.length === 0) return 0
  if (left.pre.length === 0) return 1
  if (right.pre.length === 0) return -1
  const length = Math.max(left.pre.length, right.pre.length)
  for (let index = 0; index < length; index += 1) {
    const a = left.pre[index]
    const b = right.pre[index]
    if (a === undefined) return -1
    if (b === undefined) return 1
    const aNumeric = /^\d+$/.test(a)
    const bNumeric = /^\d+$/.test(b)
    if (aNumeric && bNumeric) {
      const delta = Number(a) - Number(b)
      if (delta !== 0) return delta < 0 ? -1 : 1
    } else if (aNumeric) return -1
    else if (bNumeric) return 1
    else if (a !== b) return a < b ? -1 : 1
  }
  return 0
}

/**
 * Compare two version strings.
 *
 * @param {string} left
 * @param {string} right
 * @returns {number}
 */
export function compareVersions(left, right) {
  const a = parseVersion(left)
  const b = parseVersion(right)
  if (!a || !b) return 0
  return compareParsed(a, b)
}

/**
 * Parse a possibly partial version such as `1`, `1.2`, `^1.2.3-rc.1`.
 *
 * @param {string} raw
 * @returns {{major: number, minor: number, patch: number, pre: string[], minorGiven: boolean, patchGiven: boolean} | null}
 */
function parsePartial(raw) {
  const text = raw.trim().replace(/^v/, '')
  const match = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(text)
  if (!match) return null
  return {
    major: Number(match[1]),
    minor: match[2] === undefined ? 0 : Number(match[2]),
    patch: match[3] === undefined ? 0 : Number(match[3]),
    pre: match[4] ? match[4].split('.') : [],
    minorGiven: match[2] !== undefined,
    patchGiven: match[3] !== undefined,
  }
}

const LOWER = { major: 0, minor: 0, patch: 0, pre: [] }

/** Full parse of a version-like token, or null when it is a wildcard. */
function asVersion(partial) {
  if (!partial) return null
  return { major: partial.major, minor: partial.minor, patch: partial.patch, pre: partial.pre }
}

/**
 * Upper bound of a caret range. The `-0` prerelease mirrors node-semver's
 * `includePrerelease: true` desugaring: it excludes prereleases of the next
 * minor/major, which is exactly the trap that silently disables a plugin whose
 * caret range was written against the previous support line.
 */
function caretUpper(partial) {
  if (partial.major > 0 || !partial.minorGiven) {
    return { major: partial.major + 1, minor: 0, patch: 0, pre: ['0'] }
  }
  if (partial.minor > 0 || !partial.patchGiven) {
    return { major: 0, minor: partial.minor + 1, patch: 0, pre: ['0'] }
  }
  return { major: 0, minor: 0, patch: partial.patch + 1, pre: ['0'] }
}

/** Upper bound of a tilde range, with the same prerelease ceiling. */
function tildeUpper(partial) {
  return partial.minorGiven
    ? { major: partial.major, minor: partial.minor + 1, patch: 0, pre: ['0'] }
    : { major: partial.major + 1, minor: 0, patch: 0, pre: ['0'] }
}

/** Upper bound of a bare partial range: `1.2` means `>=1.2.0 <1.3.0`. */
function partialUpper(partial) {
  if (partial.minorGiven && partial.patchGiven) return null
  return partial.minorGiven
    ? { major: partial.major, minor: partial.minor + 1, patch: 0, pre: ['0'] }
    : { major: partial.major + 1, minor: 0, patch: 0, pre: ['0'] }
}

/**
 * Whether one whitespace-separated comparator set matches.
 *
 * @param {{major: number, minor: number, patch: number, pre: string[]}} version
 * @param {string} set
 * @returns {boolean}
 */
function matchesSet(version, set) {
  const hyphen = /^(\S+)\s+-\s+(\S+)$/.exec(set.trim())
  if (hyphen) {
    const lower = asVersion(parsePartial(hyphen[1]))
    const upperPartial = parsePartial(hyphen[2])
    const upper = asVersion(upperPartial)
    if (!lower || !upper) return false
    return compareParsed(version, lower) >= 0 && compareParsed(version, upper) <= 0
  }
  const tokens = set.trim().split(/\s+/).filter(Boolean)
  if (tokens.length === 0) return true
  for (const token of tokens) {
    if (token === '*' || token === 'x' || token === 'X') continue
    const operatorMatch = /^(\^|~|>=|<=|>|<|=)?\s*(.*)$/.exec(token)
    if (!operatorMatch) return false
    const operator = operatorMatch[1] ?? ''
    const raw = operatorMatch[2]
    if (raw === '' || raw === '*' || raw === 'x' || raw === 'X') continue
    const partial = parsePartial(raw)
    if (!partial) return false
    const point = asVersion(partial)
    if (operator === '^') {
      if (compareParsed(version, point) < 0) return false
      if (compareParsed(version, caretUpper(partial)) >= 0) return false
    } else if (operator === '~') {
      if (compareParsed(version, point) < 0) return false
      if (compareParsed(version, tildeUpper(partial)) >= 0) return false
    } else if (operator === '>=') {
      if (compareParsed(version, point) < 0) return false
    } else if (operator === '>') {
      if (compareParsed(version, point) <= 0) return false
    } else if (operator === '<=') {
      if (compareParsed(version, point) > 0) return false
    } else if (operator === '<') {
      if (compareParsed(version, point) >= 0) return false
    } else if (operator === '=') {
      if (compareParsed(version, point) !== 0) return false
    } else {
      // Bare token: an exact version, or a partial range such as `1.2`.
      const upper = partialUpper(partial)
      if (upper === null) {
        if (compareParsed(version, point) !== 0) return false
      } else {
        if (compareParsed(version, point) < 0) return false
        if (compareParsed(version, upper) >= 0) return false
      }
    }
  }
  return true
}

/**
 * Whether `version` satisfies `range`.
 *
 * @param {string} version
 * @param {string} range
 * @returns {boolean}
 */
export function satisfies(version, range) {
  const parsed = parseVersion(version)
  if (!parsed) return false
  const text = String(range ?? '').trim()
  if (text === '' || text === '*' || text === 'x') return true
  for (const alternative of text.split('||')) {
    if (matchesSet(parsed, alternative.trim())) return true
  }
  return false
}

/**
 * Sort version strings newest first.
 *
 * @param {string[]} versions
 * @returns {string[]}
 */
export function sortVersionsDesc(versions) {
  return [...versions].sort((a, b) => compareVersions(b, a))
}

/** Lowest version above another, used only for error messages. */
export function isValidVersion(value) {
  return parseVersion(value) !== null
}

export { LOWER }

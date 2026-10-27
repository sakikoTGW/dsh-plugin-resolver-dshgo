/**
 * Small host-side utilities: DSH home discovery, cached JSON, HTTP JSON, and a
 * Windows-aware child-process runner. No host package imports on purpose.
 *
 * @module dsh-plugin-resolver/lib/util
 */

import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'

/** Absolute DSH home for the running host. */
export function dshHome() {
  return process.env.DSH_HOME && process.env.DSH_HOME !== ''
    ? process.env.DSH_HOME
    : path.join(homedir(), '.dsh')
}

/** Cache directory owned by this plugin. */
export function cacheDir() {
  return path.join(dshHome(), 'cache', 'plugin-resolver')
}

/**
 * Runtime facts of the dsh-app phone harness, or undefined on a desktop host.
 *
 * The app writes `/etc/dsh-app/runtime.json` into the proot image and starts
 * `dsh web` with `--patch /etc/dsh-app/dsh-web.patch.yml`; neither exists on a
 * desktop install. `DSH_GO=1` lets any remote host opt in explicitly.
 *
 * @returns {{dshVersion?: string, nodeVersion?: string, pnpmVersion?: string, abi?: string, ubuntuVersion?: string} | undefined}
 */
export function dshGoRuntime() {
  if (process.env.DSH_GO === '1' || /^(1|true|yes)$/i.test(process.env.DSH_GO ?? '')) return {}
  try {
    return JSON.parse(readFileSync('/etc/dsh-app/runtime.json', 'utf8'))
  } catch {
    return undefined
  }
}

/** True while running inside the dsh-go phone harness. */
export function isDshGo() {
  return dshGoRuntime() !== undefined
}

/**
 * A GitHub download prelude configured through the environment.
 *
 * A phone network usually cannot reach codeload.github.com directly. dsh-go
 * deployments therefore pin a mirror with `DSH_GITHUB_PROXY` instead of editing
 * the profile patch layer; an explicit `githubProxy` config still wins.
 *
 * @returns {string | undefined}
 */
export function githubProxyFromEnv() {
  const value = process.env.DSH_GITHUB_PROXY
  return typeof value === 'string' && value.trim() !== '' ? value.trim().replace(/\/+$/, '') : undefined
}

/**
 * Read a JSON file, returning undefined when absent or unparsable.
 *
 * @param {string} file
 * @returns {Promise<any>}
 */
export async function readJson(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'))
  } catch {
    return undefined
  }
}

/**
 * Write a JSON file, creating parent directories.
 *
 * @param {string} file
 * @param {unknown} value
 * @returns {Promise<void>}
 */
export async function writeJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, JSON.stringify(value), 'utf8')
}

/**
 * Fetch and parse JSON with a hard timeout.
 *
 * @param {string} url
 * @param {{timeoutMs?: number, headers?: Record<string, string>}} [options]
 * @returns {Promise<any>}
 */
export async function fetchJson(url, options = {}) {
  const timeoutMs = options.timeoutMs ?? 30_000
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { accept: 'application/json', 'user-agent': 'dsh-plugin-resolver', ...(options.headers ?? {}) },
    })
    if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`)
    return await response.json()
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Fetch raw bytes with a hard timeout.
 *
 * @param {string} url
 * @param {{timeoutMs?: number}} [options]
 * @returns {Promise<Buffer>}
 */
export async function fetchBuffer(url, options = {}) {
  const timeoutMs = options.timeoutMs ?? 60_000
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: { 'user-agent': 'dsh-plugin-resolver' },
    })
    if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`)
    return Buffer.from(await response.arrayBuffer())
  } finally {
    clearTimeout(timer)
  }
}

/** Trim a one-line description for compact tool output. */
export function oneLine(text, limit = 120) {
  if (typeof text !== 'string') return ''
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length <= limit ? flat : `${flat.slice(0, limit - 1)}…`
}

/** Format a star count compactly. */
export function stars(value) {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return 'new'
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n)
}

/**
 * Run a child process and collect its output.
 *
 * `.cmd`/`.bat` shims on Windows go through `cmd.exe`, because Node cannot
 * spawn them directly; every other executable is spawned without a shell so
 * arguments keep their exact boundaries.
 *
 * @param {string} command
 * @param {string[]} args
 * @param {{cwd?: string, env?: Record<string, string>, timeoutMs?: number, onLine?: (line: string) => void}} [options]
 * @returns {Promise<{code: number, output: string, timedOut: boolean}>}
 */
export function runProcess(command, args, options = {}) {
  const isShim = process.platform === 'win32' && /\.(cmd|bat)$/i.test(command)
  const file = isShim ? process.env.COMSPEC || 'cmd.exe' : command
  const argv = isShim
    ? ['/d', '/s', '/c', quoteCommandLine([command, ...args])]
    : args
  return new Promise((resolve) => {
    let output = ''
    let settled = false
    let timedOut = false
    const child = spawn(file, argv, {
      cwd: options.cwd,
      env: { ...process.env, ...(options.env ?? {}) },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const timer = options.timeoutMs
      ? setTimeout(() => {
          timedOut = true
          child.kill()
        }, options.timeoutMs)
      : undefined
    const append = (chunk) => {
      const text = String(chunk)
      output += text
      if (options.onLine) {
        for (const line of text.split(/\r?\n/)) {
          if (line.trim() !== '') options.onLine(line.trimEnd())
        }
      }
      if (output.length > 400_000) output = output.slice(-200_000)
    }
    child.stdout?.on('data', append)
    child.stderr?.on('data', append)
    child.on('error', (error) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      resolve({ code: 127, output: `${output}\n${error.message}`.trim(), timedOut })
    })
    child.on('close', (code) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      resolve({ code: code ?? 1, output, timedOut })
    })
  })
}

/** Quote an argv for the Windows `cmd.exe /s /c` fallback. */
function quoteCommandLine(argv) {
  return argv
    .map((part) => {
      const value = String(part)
      if (value === '') return '""'
      if (!/[\s"&|<>^]/.test(value)) return value
      return `"${value.replace(/"/g, '""')}"`
    })
    .join(' ')
}

/** True when a directory exists. */
export function dirExists(target) {
  try {
    return existsSync(target)
  } catch {
    return false
  }
}

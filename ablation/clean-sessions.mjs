#!/usr/bin/env node
/**
 * Delete sessions that this ablation created, across every workspace.
 *
 * Titles are useless as a signal: the app names a session when it is opened
 * (`session-title-first-prompt-llm`), so an experiment session becomes
 * "Browser Tool Restriction Test" the moment you tap it. This script looks at
 * the first user message instead, which is written when the run starts.
 *
 *   node clean-sessions.mjs            # dry run: list what would go
 *   node clean-sessions.mjs --apply    # delete them
 *
 * Keep list: sessions whose directory name is in KEEP (comma separated), plus
 * the session that contains explicit user approvals (real conversations).
 */
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

const apply = process.argv.includes('--apply')
const home = process.env.DSH_HOME || path.join(process.env.HOME || '/root', '.dsh')
const sessionsRoot = path.join(home, 'sessions')
const KEEP = new Set((process.env.KEEP || '').split(',').filter(Boolean))

/** First user prompt of one session, or '' when unreadable. */
function firstPrompt(dir) {
  const file = path.join(dir, 'session.v4.jsonl.zstd')
  let events
  try {
    events = zlib
      .zstdDecompressSync(fs.readFileSync(file))
      .toString('utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line))
  } catch {
    return ''
  }
  for (const event of events) {
    if (event.type !== 'user/message') continue
    const content = event.data?.content ?? event.data?.message?.content
    const text = Array.isArray(content) ? content.map((part) => part.text ?? '').join(' ') : String(content ?? '')
    const flat = text.replace(/\s+/g, ' ').trim()
    if (flat !== '') return flat
  }
  return ''
}

/** Prompts only this ablation produces. */
const PATTERNS = [
  /^Reply with exactly/i,
  /^headless 只回复/,
  /^Without doing anything else: list every tool name/i,
  /安装插件 dsh-builtin-browser/,
  /^你在本机跑一次消融实验/,
  /^请调研 sakikoTGW\/dsh-plugin-resolver/,
]

let removed = 0
for (const workspace of fs.existsSync(sessionsRoot) ? fs.readdirSync(sessionsRoot) : []) {
  const workspaceDir = path.join(sessionsRoot, workspace)
  if (!fs.statSync(workspaceDir).isDirectory()) continue
  for (const name of fs.readdirSync(workspaceDir)) {
    const dir = path.join(workspaceDir, name)
    if (!fs.statSync(dir).isDirectory() || KEEP.has(name)) continue
    const prompt = firstPrompt(dir)
    if (prompt === '' || !PATTERNS.some((pattern) => pattern.test(prompt))) continue
    console.log(`${apply ? 'remove' : 'would remove'} ${workspace}/${name}  ← ${prompt.slice(0, 60)}`)
    if (apply) fs.rmSync(dir, { recursive: true, force: true })
    removed += 1
  }
}
if (apply) {
  // The projection cache outlives a session file removed from outside the app;
  // prune entries whose session no longer exists in any workspace.
  const live = new Set()
  for (const workspace of fs.existsSync(sessionsRoot) ? fs.readdirSync(sessionsRoot) : []) {
    for (const name of fs.readdirSync(path.join(sessionsRoot, workspace))) live.add(name)
  }
  const cacheDir = path.join(home, 'storages', 'session_projcache', 'sessions')
  let pruned = 0
  for (const file of fs.existsSync(cacheDir) ? fs.readdirSync(cacheDir) : []) {
    if (!file.endsWith('.json') || live.has(file.slice(0, -5))) continue
    fs.rmSync(path.join(cacheDir, file), { force: true })
    pruned += 1
  }
  console.log(`pruned ${pruned} stale projection cache entr${pruned === 1 ? 'y' : 'ies'}`)
}
console.log(`${apply ? 'removed' : 'matched'} ${removed} session(s)${apply ? '' : '; add --apply to delete'}`)

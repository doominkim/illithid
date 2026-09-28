/**
 * Apply preview: the current sync plan (planSyncAll) summarized per tool for the confirm dialog.
 * Read-only. No file contents leave this module — names, actions and display paths (~) only.
 */
import { basename } from 'node:path'
import {
  ALL_TARGETS,
  importedChangedOf,
  isEnabled,
  readManifest,
  keepImportedOriginal as keepOriginal,
  libraryExists,
  planFingerprint,
  planSyncAll,
  tilde,
  type Env,
  type SyncPlan,
  type ToolId
} from '../engine'
import { editedRules } from '../engine/editedRules'
import { toolsInUse } from '../engine/config'
import { parseJsonObject } from '../engine/text'
import type { ApplyPreviewItem, ApplyPreviewView, ImportedKeepRequest, LibraryDirectItem } from '../shared/api'
import { notInitializedOf } from './writes'

const TARGET_TOOL = new Map(ALL_TARGETS.map((t) => [t.id, t.tool]))

type PlanItem = { kind: 'rule' | 'skill' | 'agent'; tool: ToolId; name: string; action: string; path: string; reason?: string }

function planItems(p: SyncPlan): PlanItem[] {
  return [
    ...p.rules.map((x) => ({ kind: 'rule' as const, tool: x.tool ?? ('claude' as const), name: x.name, action: x.action, path: x.path, reason: x.reason })),
    ...p.skills.map((x) => ({ kind: 'skill' as const, tool: x.tool, name: x.name, action: x.action, path: x.path, reason: x.reason })),
    ...p.agents.map((x) => ({ kind: 'agent' as const, tool: x.tool, name: x.name, action: x.action, path: x.path, reason: x.reason }))
  ]
}

export function applyPreview(home: string, env: Env): ApplyPreviewView {
  const inUse = toolsInUse(home)
  if (!libraryExists(home))
    return { items: [], importedChanged: [], errors: [], notInitialized: [], libraryDirect: [], edited: [], libraryMissing: true, inUse }
  const p = planSyncAll(home, env)
  const items: ApplyPreviewItem[] = []

  // Config files: several targets can write one file (opencode.json) — one row per file
  const files = new Map<string, ApplyPreviewItem>()
  const errors = [...p.errors]
  for (const c of p.targets) {
    if (c.error) {
      errors.push(`${c.label}: ${c.error}`)
      continue
    }
    if (!c.changed) continue
    const tool = TARGET_TOOL.get(c.id)
    if (!tool) continue
    const prev = files.get(c.path)
    const action = c.before === '' ? 'add' : 'update'
    if (prev) {
      if (action === 'add') prev.action = 'add'
    } else files.set(c.path, { tool, kind: 'config', action, name: c.label, path: c.label })
  }
  for (const [abs, f] of files) {
    items.push(f)
    // opencode.json instructions: which rules enter or leave (the file row alone does not say)
    const c = p.targets.find((x) => x.id === 'opencodeRules' && x.path === abs && x.changed && !x.error)
    if (c) items.push(...instructionDiff(home, c.before, c.after, f.path))
    // MCP servers entering, changing or leaving the file (names only)
    for (const m of p.targets.filter((x) => x.path === abs && x.changed && !x.error && x.servers?.length))
      for (const s of m.servers!) items.push({ tool: f.tool, kind: 'mcp', action: s.action, name: s.name, path: s.name, parent: f.path })
  }

  // Rules, skills, agents. An imported original moved aside next to a copy of the same item reads as one "replace"
  const all = planItems(p)
  const key = (x: PlanItem): string => `${x.kind}:${x.tool}:${x.name}`
  const retiring = new Map<string, PlanItem>()
  for (const x of all) if (x.action === 'retireImported') retiring.set(key(x), x)
  const merged = new Set<string>()
  for (const x of all) {
    const k = key(x)
    const shown = { tool: x.tool, kind: x.kind, name: x.name }
    switch (x.action) {
      case 'copy':
      case 'update':
      case 'replaceLink':
      case 'migrateLegacyDir': {
        const r = retiring.get(k)
        if (r) {
          merged.add(k)
          items.push({ ...shown, action: 'replace', path: tilde(home, r.path) })
        } else items.push({ ...shown, action: x.action === 'copy' ? 'add' : 'update', path: tilde(home, x.path) })
        break
      }
      case 'replaceImported':
        items.push({ ...shown, action: 'replace', path: tilde(home, x.path) })
        break
      case 'deleteCandidate':
        items.push({ ...shown, action: 'remove', path: tilde(home, x.path) })
        break
    }
  }
  for (const [k, r] of retiring)
    if (!merged.has(k)) items.push({ tool: r.tool, kind: r.kind, name: r.name, action: 'retire', path: tilde(home, r.path) })

  const importedChanged = importedChangedOf(p).map((x) => ({ ...x, path: tilde(home, x.path) }))
  return {
    items,
    importedChanged,
    errors,
    notInitialized: notInitializedOf(p.targets),
    libraryDirect: libraryDirect(home, inUse, items),
    edited: editedRules(home, env).map((e) => ({ tool: e.tool, name: e.name, path: tilde(home, e.path), where: e.where })),
    inUse,
    fingerprint: planFingerprint(p)
  }
}

function instructionList(text: string): string[] {
  try {
    const list = parseJsonObject(text || '{}').instructions
    return Array.isArray(list) ? list.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

/** Entries added to / removed from opencode.json instructions, as rule rows under the file row */
function instructionDiff(home: string, before: string, after: string, parent: string): ApplyPreviewItem[] {
  const a = instructionList(before)
  const b = instructionList(after)
  const row = (entry: string, action: 'add' | 'remove'): ApplyPreviewItem => ({
    tool: 'opencode',
    kind: 'rule',
    action,
    name: basename(entry),
    path: entry.startsWith('/') ? tilde(home, entry) : entry,
    parent
  })
  return [...b.filter((x) => !a.includes(x)).map((x) => row(x, 'add')), ...a.filter((x) => !b.includes(x)).map((x) => row(x, 'remove'))]
}

/**
 * Rules and skills changing in this apply that OpenCode (in use, item on) reads straight from the library — nothing is
 * written for OpenCode, so without this the preview looks like OpenCode was left out
 */
function libraryDirect(home: string, inUse: ToolId[], items: ApplyPreviewItem[]): LibraryDirectItem[] {
  if (!inUse.includes('opencode')) return []
  const mf = readManifest(home)
  if (mf.error) return []
  const listed = new Set(items.filter((x) => x.tool === 'opencode').map((x) => `${x.kind}:${x.name}`))
  const out = new Map<string, LibraryDirectItem>()
  for (const x of items) {
    if (x.tool === 'opencode' || x.parent || (x.kind !== 'rule' && x.kind !== 'skill')) continue
    if (x.action !== 'add' && x.action !== 'update' && x.action !== 'replace') continue
    const k = `${x.kind}:${x.name}`
    if (listed.has(k) || out.has(k)) continue
    if (!isEnabled(mf.manifest, x.kind === 'rule' ? 'rules' : 'skills', x.name, 'opencode')) continue
    out.set(k, { tool: 'opencode', kind: x.kind, name: x.name })
  }
  return [...out.values()]
}

/**
 * Keep an imported original that changed since import (engine keepImportedOriginal: drops its record, switches the library item
 * off for that tool where the original lives beside the app copy). Only originals the current plan lists as changed are accepted
 */
export function keepImportedOriginal(home: string, env: Env, req: ImportedKeepRequest): void {
  const abs = req.path.startsWith('~/') ? `${home}/${req.path.slice(2)}` : req.path
  const listed = importedChangedOf(planSyncAll(home, env)).find((x) => x.kind === req.kind && x.tool === req.tool && x.path === abs)
  if (!listed) throw Object.assign(new Error('Not an imported original awaiting replacement'), { code: 'notFound' })
  keepOriginal(home, { kind: listed.kind, tool: listed.tool, path: abs })
}

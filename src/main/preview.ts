/**
 * Apply preview: the current sync plan (planSyncAll) summarized per tool for the confirm dialog.
 * Read-only. No file contents leave this module — names, actions and display paths (~) only.
 */
import {
  ALL_TARGETS,
  importedChangedOf,
  keepImportedOriginal as keepOriginal,
  libraryExists,
  planSyncAll,
  tilde,
  type Env,
  type SyncPlan,
  type ToolId
} from '../engine'
import { toolsInUse } from '../engine/config'
import type { ApplyPreviewItem, ApplyPreviewView, ImportedKeepRequest } from '../shared/api'
import { notInitializedOf } from './writes'

const TARGET_TOOL = new Map(ALL_TARGETS.map((t) => [t.id, t.tool]))

type PlanItem = { kind: 'rule' | 'skill' | 'agent'; tool: ToolId; name: string; action: string; path: string; reason?: string }

function planItems(p: SyncPlan): PlanItem[] {
  return [
    ...p.rules.map((x) => ({ kind: 'rule' as const, tool: 'claude' as const, name: x.name, action: x.action, path: x.path, reason: x.reason })),
    ...p.skills.map((x) => ({ kind: 'skill' as const, tool: x.tool, name: x.name, action: x.action, path: x.path, reason: x.reason })),
    ...p.agents.map((x) => ({ kind: 'agent' as const, tool: x.tool, name: x.name, action: x.action, path: x.path, reason: x.reason }))
  ]
}

export function applyPreview(home: string, env: Env): ApplyPreviewView {
  const inUse = toolsInUse(home)
  if (!libraryExists(home)) return { items: [], importedChanged: [], errors: [], notInitialized: [], libraryMissing: true, inUse }
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
  items.push(...files.values())

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
  return { items, importedChanged, errors, notInitialized: notInitializedOf(p.targets), inUse }
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

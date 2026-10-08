import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { artifactSources, listArtifactSources } from '../src/engine/scan/artifacts'

/** A HOME with the default workspace library and one standard tool plan folder */
function homeWith(sources?: unknown): string {
  const home = mkdtempSync(join(tmpdir(), 'illithid-artifact-sources-'))
  mkdirSync(join(home, '.illithid/workspaces/default/artifacts'), { recursive: true })
  mkdirSync(join(home, '.claude/plans'), { recursive: true })
  mkdirSync(join(home, '.config/illithid'), { recursive: true })
  writeFileSync(
    join(home, '.config/illithid/config.json'),
    JSON.stringify({ version: 1, ...(sources !== undefined ? { artifactSources: sources } : {}) })
  )
  return home
}

test('a configured location is added to the default ones instead of replacing them', () => {
  const home = homeWith([{ root: '~/Playground/reports', project: 'first-segment' }])
  mkdirSync(join(home, 'Playground/reports'), { recursive: true })
  const roots = artifactSources(home).map((s) => s.root)
  assert.ok(roots.includes(join(home, '.claude/plans')), roots.join('\n'))
  assert.ok(roots.includes(join(home, '.illithid/workspaces/default/artifacts')), roots.join('\n'))
  assert.equal(roots.at(-1), join(home, 'Playground/reports'))
  const extra = artifactSources(home).at(-1)!
  assert.equal(extra.project, 'first-segment')
  assert.equal(extra.label, '~/Playground/reports')
})

test('a configured location that repeats a default one or itself is listed once', () => {
  const home = homeWith([
    { root: '~/.claude/plans' },
    { root: '~/Playground/reports' },
    { root: '~/Playground/reports/' }
  ])
  mkdirSync(join(home, 'Playground/reports'), { recursive: true })
  const roots = artifactSources(home).map((s) => s.root)
  assert.equal(roots.filter((r) => r === join(home, '.claude/plans')).length, 1)
  assert.equal(roots.filter((r) => r === join(home, 'Playground/reports')).length, 1)
})

test('the settings list marks default locations as built in and keeps added ones even when missing', () => {
  const home = homeWith([{ root: '~/Playground/reports' }])
  const list = listArtifactSources(home)
  assert.deepEqual(
    list.map((s) => [s.root, s.builtin, s.exists]),
    [
      ['~/.claude/plans', true, true],
      ['~/.illithid/workspaces/default/artifacts', true, true],
      ['~/Playground/reports', false, false]
    ]
  )
})

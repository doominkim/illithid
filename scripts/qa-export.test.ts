import assert from 'node:assert/strict'
import { test } from 'node:test'
import { chmodSync, mkdirSync, mkdtempSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { zipSync } from 'fflate'
import {
  exportWorkspace,
  importWorkspace,
  initLibrary,
  libraryRoot,
  planImportWorkspace,
  switchWorkspace
} from '../src/engine'

test(
  'exported executable skill files remain runnable after importing the workspace',
  {
    skip:
      process.platform === 'win32' ? 'POSIX executable modes are not supported on Windows' : false
  },
  () => {
    const home = mkdtempSync(join(tmpdir(), 'illithid-qa-export-mode-'))
    initLibrary(home)
    const skill = join(libraryRoot(home), 'skills', 'executable-fixture')
    mkdirSync(skill, { recursive: true })
    writeFileSync(
      join(skill, 'SKILL.md'),
      '---\nname: executable-fixture\ndescription: Fixture\n---\n'
    )
    const script = join(skill, 'run.sh')
    writeFileSync(script, '#!/bin/sh\nprintf fixture\n', { mode: 0o755 })
    chmodSync(script, 0o755)
    const restored = importWorkspace(home, exportWorkspace(home).data)
    switchWorkspace(home, restored.id)
    const imported = join(libraryRoot(home), 'skills', 'executable-fixture')
    assert.equal(statSync(join(imported, 'run.sh')).mode & 0o7777, 0o755)
    assert.equal(execFileSync(join(imported, 'run.sh'), { encoding: 'utf8' }), 'fixture')
    assert.equal(statSync(join(imported, 'SKILL.md')).mode & 0o7777, 0o644)
    const metadata = importWorkspace(
      home,
      zipSync({
        'workspace.json': new TextEncoder().encode(JSON.stringify({ name: 'mode-fixture' })),
        'skills/mode-fixture/run.sh': [
          new TextEncoder().encode('#!/bin/sh\nprintf fixture\n'),
          { os: 3, attrs: 0o104755 << 16 }
        ],
        'rules/mode-fixture.md': [
          new TextEncoder().encode('# Fixture\n'),
          { os: 3, attrs: 0o102644 << 16 }
        ]
      })
    )
    switchWorkspace(home, metadata.id)
    assert.equal(
      statSync(join(libraryRoot(home), 'skills/mode-fixture/run.sh')).mode & 0o7777,
      0o755
    )
    assert.equal(statSync(join(libraryRoot(home), 'rules/mode-fixture.md')).mode & 0o7777, 0o644)
  }
)

test('export accepts 50 MiB uncompressed and rejects the first byte above the import limit', () => {
  const home = mkdtempSync(join(tmpdir(), 'illithid-qa-export-bytes-'))
  initLibrary(home)
  const baseBytes = planImportWorkspace(exportWorkspace(home).data).bytes
  const rules = join(libraryRoot(home), 'rules')
  writeFileSync(join(rules, 'large.md'), Buffer.alloc(50 * 1024 * 1024 - baseBytes))
  assert.equal(planImportWorkspace(exportWorkspace(home).data).bytes, 52428800)
  writeFileSync(join(rules, 'first-excess.md'), 'x')
  assert.throws(() => exportWorkspace(home), { code: 'tooLarge' })
})

test('export accepts 5000 files and refuses the first archive its importer cannot accept', () => {
  const home = mkdtempSync(join(tmpdir(), 'illithid-qa-export-count-'))
  initLibrary(home)
  const base = exportWorkspace(home).files
  const rules = join(libraryRoot(home), 'rules')
  for (let i = 0; i < 5000 - base; i++) writeFileSync(join(rules, `fixture-${i}.md`), '')
  const accepted = exportWorkspace(home)
  assert.equal(accepted.files, 5000)
  assert.equal(planImportWorkspace(accepted.data).ok, true)
  writeFileSync(join(rules, 'first-excess.md'), '')
  assert.throws(() => exportWorkspace(home), { code: 'tooLarge' })
})

import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  convertHookToLibraryScript,
  createHook,
  createFolderScript,
  createScript,
  deleteScript,
  deleteScriptFile,
  importScriptFolder,
  readScript,
  readScriptFile,
  saveScriptInfo,
  scriptToFolder,
  writeScriptFile,
  keepHookCopy,
  readHook,
  readScripts,
  renderUniversalScript,
  saveScript,
  scriptUsers,
  syncAll
} from '../src/engine'
import { scripts as scriptsView } from '../src/main/reads'
import { lib } from '../src/main/writes'
import { baseEnv, buildDemoHome } from './readme-shots'

const LIB = '.illithid/workspaces/default'

function demoHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'illithid-scripts-'))
  buildDemoHome(home, { tools: 'all' })
  const cfg = join(home, '.config/illithid/config.json')
  writeFileSync(
    cfg,
    JSON.stringify({ ...JSON.parse(readFileSync(cfg, 'utf8')), toolsInUse: ['claude', 'gemini'] })
  )
  return home
}

const sync = (home: string, approvedOnce = false): void => {
  const r = syncAll(home, baseEnv(home), { allowReal: true, approvedOnce })
  assert.equal(r.refused, undefined)
  assert.deepEqual(r.plan.errors, [])
}

const LINT = '#!/bin/sh\n# description: Lint the edited file\nnpx eslint "$1"\n'

test('REQ-SCRIPTS-1 a library script is a .sh file with its description in a comment', () => {
  const home = demoHome()
  createScript(home, 'lint', LINT)
  const file = join(home, LIB, 'scripts/lint.sh')
  assert.equal(readFileSync(file, 'utf8'), LINT)
  assert.equal(statSync(file).mode & 0o777, 0o755)
  assert.deepEqual(readScripts(home), [
    { name: 'lint', kind: 'file', description: 'Lint the edited file', content: LINT }
  ])
  assert.throws(() => createScript(home, 'lint', ''), { code: 'exists' })
  assert.throws(() => createScript(home, 'Bad Name', ''), { code: 'invalidName' })
  // A new script with no content starts from a template
  createScript(home, 'blank')
  assert.match(
    readFileSync(join(home, LIB, 'scripts/blank.sh'), 'utf8'),
    /^#!\/bin\/sh\n# description: /
  )
})

test('REQ-SCRIPTS-2 hooks can run a library script; editing it updates every tool copy of every hook using it', () => {
  const home = demoHome()
  createScript(home, 'lint', LINT)
  for (const name of ['lint-edits', 'lint-start'])
    createHook(home, name, {
      description: '',
      when: name === 'lint-edits' ? 'after-tool' : 'session-start',
      action: 'script',
      options: { use: 'lint' }
    })
  // No script of its own
  assert.equal(existsSync(join(home, LIB, 'hooks/lint-edits/run.sh')), false)
  assert.deepEqual(scriptUsers(home, 'lint'), ['lint-edits', 'lint-start'])
  sync(home)
  const copies = ['claude', 'gemini'].flatMap((tool) =>
    ['lint-edits', 'lint-start'].map((h) => join(home, `.${tool}/hooks/illithid/${h}/run.sh`))
  )
  for (const c of copies) assert.equal(readFileSync(c, 'utf8'), LINT)
  const v2 = LINT.replace('eslint', 'eslint --fix')
  saveScript(home, 'lint', v2)
  sync(home)
  for (const c of copies) assert.equal(readFileSync(c, 'utf8'), v2)
  // A copy edited in a tool and kept goes back into the library script
  writeFileSync(copies[0], 'edited in Claude\n')
  keepHookCopy(home, 'claude', 'lint-edits', 'run.sh')
  assert.equal(readFileSync(join(home, LIB, 'scripts/lint.sh'), 'utf8'), 'edited in Claude\n')
  assert.equal(existsSync(join(home, LIB, 'hooks/lint-edits/run.sh')), false)
  // A hook pointing at a missing script is refused
  assert.throws(
    () =>
      createHook(home, 'broken', {
        description: '',
        when: 'stop',
        action: 'script',
        options: { use: 'nope' }
      }),
    { code: 'notFound' }
  )
})

test('REQ-SCRIPTS-3 deleting a script in use gives each hook its own copy, so the hooks keep working', () => {
  const home = demoHome()
  createScript(home, 'lint', LINT)
  createHook(home, 'lint-edits', {
    description: '',
    when: 'after-tool',
    action: 'script',
    options: { use: 'lint' }
  })
  deleteScript(home, 'lint')
  assert.equal(existsSync(join(home, LIB, 'scripts/lint.sh')), false)
  const h = readHook(home, 'lint-edits')
  assert.equal(h.doc.options.use, '')
  assert.equal(h.scripts['run.sh'], LINT)
  sync(home)
})

test('REQ-SCRIPTS-4 a generated hook script can be saved to the library and the hook then runs it', () => {
  const home = demoHome()
  createHook(home, 'done', { description: '', when: 'stop', action: 'notify', options: {} })
  convertHookToLibraryScript(home, 'done', 'notify-me', '#!/bin/sh\necho done\n')
  const h = readHook(home, 'done')
  assert.equal(h.doc.action, 'script')
  assert.equal(h.doc.options.use, 'notify-me')
  assert.equal(
    readFileSync(join(home, LIB, 'scripts/notify-me.sh'), 'utf8'),
    '#!/bin/sh\necho done\n'
  )
  sync(home)
  assert.equal(
    readFileSync(join(home, '.claude/hooks/illithid/done/run.sh'), 'utf8'),
    '#!/bin/sh\necho done\n'
  )
})

test("REQ-SCRIPTS-5 saving a recipe hook's script to the library keeps one script that works in every tool", () => {
  const home = demoHome()
  createHook(home, 'guard', { description: '', when: 'before-tool', action: 'guard', options: {} })
  const before = readHook(home, 'guard').doc
  lib.hookConvert(home, 'guard', 'claude', 'guard-all')
  const content = readFileSync(join(home, LIB, 'scripts/guard-all.sh'), 'utf8')
  assert.equal(content, renderUniversalScript('guard', before))
  assert.match(content, /case "\$1" in/)
  assert.equal(readHook(home, 'guard').doc.options.use, 'guard-all')
})

test('REQ-SCRIPTS-6 the scripts menu holds only my scripts, not copies of the recipes hooks run', () => {
  const home = demoHome()
  createHook(home, 'verify-stop', { description: '', when: 'stop', action: 'verify', options: {} })
  createScript(home, 'lint', LINT)
  const data = scriptsView(home)
  assert.deepEqual(
    data.scripts.map((s) => s.name),
    ['lint']
  )
  assert.equal('builtins' in data, false)
  assert.equal('scriptFromRecipe' in lib, false)
})

const RUN = '#!/bin/sh\n. "$(dirname "$0")/lib/util.sh"\nsay_done\n'
const mode = (p: string): number => statSync(p).mode & 0o777

test('REQ-SCRIPTS-7 a folder script keeps several files: SCRIPT.md names the entry, the files can be read, written and removed', () => {
  const home = demoHome()
  createFolderScript(home, 'fmt', { description: 'Format the edited file', content: RUN })
  const dir = join(home, LIB, 'scripts/fmt')
  assert.equal(readFileSync(join(dir, 'run.sh'), 'utf8'), RUN)
  assert.equal(mode(join(dir, 'run.sh')), 0o755)
  assert.match(readFileSync(join(dir, 'SCRIPT.md'), 'utf8'), /entry: "run.sh"/)
  // One name across both kinds
  assert.throws(() => createScript(home, 'fmt'), { code: 'exists' })
  assert.throws(() => createFolderScript(home, 'fmt', {}), { code: 'exists' })

  writeScriptFile(home, 'fmt', 'lib/util.sh', 'say_done() { echo done; }\n')
  writeScriptFile(home, 'fmt', 'bin/tool', '#!/bin/sh\necho tool\n')
  assert.equal(mode(join(dir, 'lib/util.sh')), 0o644)
  // A new file starting with #! can run
  assert.equal(mode(join(dir, 'bin/tool')), 0o755)
  assert.equal(readScriptFile(home, 'fmt', 'lib/util.sh'), 'say_done() { echo done; }\n')
  assert.deepEqual(readScript(home, 'fmt'), {
    name: 'fmt',
    kind: 'folder',
    description: 'Format the edited file',
    entry: 'run.sh',
    files: ['SCRIPT.md', 'bin/tool', 'lib/util.sh', 'run.sh'],
    content: RUN
  })
  // Saving the script saves its entry
  saveScript(home, 'fmt', RUN + '# v2\n')
  assert.equal(readFileSync(join(dir, 'run.sh'), 'utf8'), RUN + '# v2\n')
  // The entry can move to another file in the folder; a missing one is refused
  saveScriptInfo(home, 'fmt', { description: 'Format', entry: 'bin/tool' })
  assert.equal(readScript(home, 'fmt')!.entry, 'bin/tool')
  assert.equal(readScript(home, 'fmt')!.content, '#!/bin/sh\necho tool\n')
  assert.throws(() => saveScriptInfo(home, 'fmt', { entry: 'nope.sh' }), { code: 'notFound' })
  // Paths stay inside the folder; the entry and SCRIPT.md can't be removed
  assert.throws(() => writeScriptFile(home, 'fmt', '../x.sh', ''), { code: 'outsideLibrary' })
  assert.throws(() => readScriptFile(home, 'fmt', '/etc/passwd'), { code: 'outsideLibrary' })
  assert.throws(() => deleteScriptFile(home, 'fmt', 'bin/tool'), { code: 'invalidSchema' })
  assert.throws(() => deleteScriptFile(home, 'fmt', 'SCRIPT.md'), { code: 'invalidSchema' })
  deleteScriptFile(home, 'fmt', 'lib/util.sh')
  assert.equal(existsSync(join(dir, 'lib/util.sh')), false)
  // A file script has no files to manage
  createScript(home, 'lint', LINT)
  assert.throws(() => writeScriptFile(home, 'lint', 'x.sh', ''), { code: 'invalidSchema' })
})

test('REQ-SCRIPTS-8 a folder the tools should not get is listed with the reason', () => {
  const home = demoHome()
  const make = (name: string, extra: (dir: string) => void): void => {
    createFolderScript(home, name, { content: '#!/bin/sh\n' })
    extra(join(home, LIB, 'scripts', name))
  }
  make('deps', (d) => {
    mkdirSync(join(d, 'node_modules/x'), { recursive: true })
    writeFileSync(join(d, 'node_modules/x/index.js'), '')
  })
  make('linked', (d) => symlinkSync('/etc/hosts', join(d, 'hosts')))
  make('big', (d) => {
    for (let i = 0; i < 200; i++) writeFileSync(join(d, `f${i}.txt`), '')
  })
  make('noentry', (d) => writeFileSync(join(d, 'SCRIPT.md'), '---\nentry: "gone.sh"\n---\n'))
  make('outside', (d) => writeFileSync(join(d, 'SCRIPT.md'), '---\nentry: "../x.sh"\n---\n'))
  const problems = Object.fromEntries(readScripts(home).map((s) => [s.name, s.problem]))
  assert.deepEqual(problems, {
    big: 'tooLarge',
    deps: 'ignoredFolder',
    linked: 'symlink',
    noentry: 'noEntry',
    outside: 'noEntry'
  })
})

test('REQ-SCRIPTS-9 a file script turns into a folder script and the hooks using it keep it', () => {
  const home = demoHome()
  createScript(home, 'lint', LINT)
  createHook(home, 'lint-edits', {
    description: '',
    when: 'after-tool',
    action: 'script',
    options: { use: 'lint' }
  })
  scriptToFolder(home, 'lint')
  assert.equal(existsSync(join(home, LIB, 'scripts/lint.sh')), false)
  const run = join(home, LIB, 'scripts/lint/run.sh')
  assert.equal(readFileSync(run, 'utf8'), LINT)
  assert.equal(mode(run), 0o755)
  const s = readScript(home, 'lint')!
  assert.equal(s.kind, 'folder')
  assert.equal(s.description, 'Lint the edited file')
  assert.equal(readHook(home, 'lint-edits').doc.options.use, 'lint')
  assert.throws(() => scriptToFolder(home, 'lint'), { code: 'invalidSchema' })
})

test('REQ-SCRIPTS-10 a folder comes in as a folder script; a folder script in use is not deleted', () => {
  const home = demoHome()
  const src = mkdtempSync(join(tmpdir(), 'illithid-script-src-'))
  writeFileSync(join(src, 'main.sh'), '#!/bin/sh\n. "$(dirname "$0")/helper.sh"\n', { mode: 0o755 })
  writeFileSync(join(src, 'helper.sh'), 'echo helped\n')
  importScriptFolder(home, 'tool', src, 'main.sh')
  const s = readScript(home, 'tool')!
  assert.equal(s.kind, 'folder')
  assert.equal(s.entry, 'main.sh')
  assert.deepEqual(s.files, ['SCRIPT.md', 'helper.sh', 'main.sh'])
  assert.equal(mode(join(home, LIB, 'scripts/tool/main.sh')), 0o755)
  // The source folder is left as it was
  assert.equal(existsSync(join(src, 'SCRIPT.md')), false)
  // A folder that already has SCRIPT.md keeps its entry
  const src2 = mkdtempSync(join(tmpdir(), 'illithid-script-src-'))
  writeFileSync(join(src2, 'SCRIPT.md'), '---\ndescription: "Mine"\nentry: "go.sh"\n---\n')
  writeFileSync(join(src2, 'go.sh'), '#!/bin/sh\n')
  importScriptFolder(home, 'mine', src2)
  assert.equal(readScript(home, 'mine')!.entry, 'go.sh')
  assert.equal(readScript(home, 'mine')!.description, 'Mine')
  // A folder the tools should not get is refused and nothing is written
  mkdirSync(join(src, '.git'))
  assert.throws(() => importScriptFolder(home, 'bad', src, 'main.sh'), { code: 'invalidSchema' })
  assert.equal(existsSync(join(home, LIB, 'scripts/bad')), false)
  assert.throws(() => importScriptFolder(home, 'tool', src2), { code: 'exists' })

  createHook(home, 'use-tool', {
    description: '',
    when: 'stop',
    action: 'script',
    options: { use: 'tool' }
  })
  assert.throws(() => deleteScript(home, 'tool'), { code: 'inUse' })
  deleteScript(home, 'mine')
  assert.equal(existsSync(join(home, LIB, 'scripts/mine')), false)
})

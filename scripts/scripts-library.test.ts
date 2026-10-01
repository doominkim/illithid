import assert from 'node:assert/strict'
import { test } from 'node:test'
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  convertHookToLibraryScript,
  createHook,
  createScript,
  deleteScript,
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
    { name: 'lint', description: 'Lint the edited file', content: LINT }
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

test("REQ-SCRIPTS-6 the scripts menu lists Illithid's recipe scripts with the hooks using them; one can be copied to edit", () => {
  const home = demoHome()
  createHook(home, 'verify-stop', { description: '', when: 'stop', action: 'verify', options: {} })
  const data = scriptsView(home)
  assert.deepEqual(
    data.builtins.map((b) => b.action),
    ['notify', 'verify', 'format', 'protect', 'context', 'checkpoint', 'guard', 'ask']
  )
  const verify = data.builtins.find((b) => b.action === 'verify')!
  assert.deepEqual(verify.users, ['verify-stop'])
  assert.match(verify.universal, /case "\$1" in/)
  assert.match(verify.perTool.claude!, /^#!\/bin\/sh\n# Generated by Illithid for claude/)
  // protect has no Codex or Copilot version
  const protect = data.builtins.find((b) => b.action === 'protect')!
  assert.equal(protect.perTool.codex, undefined)
  assert.ok(protect.perTool.claude)
  // Copy to edit: a library script with the all-tools version
  lib.scriptFromRecipe(home, 'verify', 'my-check')
  const mine = readFileSync(join(home, LIB, 'scripts/my-check.sh'), 'utf8')
  assert.match(mine, /case "\$1" in/)
  assert.match(mine, /npm test --silent/)
  assert.throws(() => lib.scriptFromRecipe(home, 'log', 'nope'), { code: 'invalidSchema' })
})

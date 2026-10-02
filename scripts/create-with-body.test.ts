import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAgent, createSkill } from '../src/engine'
import { lib } from '../src/main/writes'
import { buildDemoHome } from './readme-shots'

const LIB = '.illithid/workspaces/default'

function demoHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'illithid-create-body-'))
  buildDemoHome(home, { tools: 'all' })
  return home
}

test('REQ-CREATE-BODY-1 a new rule, skill, agent or script takes its body at once', () => {
  const home = demoHome()
  lib.ruleCreate(home, 'zz-tone.md', '# Tone\n\nBe brief.\n', 'How replies sound')
  assert.equal(readFileSync(join(home, LIB, 'rules/zz-tone.md'), 'utf8'), '# Tone\n\nBe brief.\n')

  createSkill(home, 'release', 'Cut a release', '# Release\n\n1. Tag\n2. Push\n')
  assert.equal(
    readFileSync(join(home, LIB, 'skills/release/SKILL.md'), 'utf8'),
    '---\nname: release\ndescription: "Cut a release"\n---\n\n# Release\n\n1. Tag\n2. Push\n'
  )
  // Left out: the old starter
  createSkill(home, 'plain', 'Plain')
  assert.match(readFileSync(join(home, LIB, 'skills/plain/SKILL.md'), 'utf8'), /\n# plain\n/)

  createAgent(home, 'checker', 'Checks things', 'Review the diff and list risks.\n')
  const agent = readFileSync(join(home, LIB, 'agents/checker.md'), 'utf8')
  assert.match(agent, /^---\nname: checker\n/)
  assert.ok(agent.endsWith('---\n\nReview the diff and list risks.\n'), agent)

  lib.scriptCreateFolder(home, 'fmt', 'Format', '#!/bin/sh\necho fmt\n')
  assert.equal(readFileSync(join(home, LIB, 'scripts/fmt/run.sh'), 'utf8'), '#!/bin/sh\necho fmt\n')
})

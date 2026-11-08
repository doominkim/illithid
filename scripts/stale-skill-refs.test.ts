import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { findStaleSkillRefs } from '../src/engine/staleRefs'
import { memorySecretBackend } from '../src/engine'
import { applyPreview } from '../src/main/preview'
import { baseEnv, buildDemoHome } from './readme-shots'

const known = new Set(['using-kaneo', 'tdd', 'agent-browser'])
const doc = (text: string): { file: string; text: string }[] => [
  { file: 'rules/80-memory.md', text }
]

test('a skill named next to the word skill that is not in the library is stale', () => {
  const refs = findStaleSkillRefs(
    doc('# Memory\n\n- 쓸 때는 `memory-curation` 스킬을 따른다.'),
    known,
    new Set()
  )
  assert.deepEqual(refs, [{ name: 'memory-curation', file: 'rules/80-memory.md', line: 3 }])
})

test('English wording counts too: "Call the Skill tool with `x`" and "the `x` skill"', () => {
  const refs = findStaleSkillRefs(
    doc('1. Call the Skill tool with `writing-guide` first.\n2. Then follow the `ghost` skill.'),
    known,
    new Set()
  )
  assert.deepEqual(
    refs.map((r) => r.name),
    ['writing-guide', 'ghost']
  )
})

test('a list of skills before the word skill is checked as a whole', () => {
  const refs = findStaleSkillRefs(
    doc('`to-spec`·`tdd`·`to-tickets` 스킬이 요구하는 설정'),
    known,
    new Set()
  )
  assert.deepEqual(
    refs.map((r) => r.name),
    ['to-spec', 'to-tickets']
  )
})

test('a skill the sync is about to delete is stale wherever it appears in backticks', () => {
  const refs = findStaleSkillRefs(
    doc('`to-spec`·`to-tickets` 등이 요구하는 이슈 트래커 설정'),
    known,
    new Set(['to-spec'])
  )
  assert.deepEqual(refs, [{ name: 'to-spec', file: 'rules/80-memory.md', line: 1 }])
})

test('a deleted single-word skill counts only next to the word skill, not as a plain word', () => {
  const removed = new Set(['implement'])
  assert.deepEqual(
    findStaleSkillRefs(doc('Roles: `design`, `implement`, `review`.'), known, removed),
    []
  )
  assert.deepEqual(
    findStaleSkillRefs(doc('Hand off to the `implement` skill.'), known, removed).map(
      (r) => r.name
    ),
    ['implement']
  )
})

test('skill bodies are checked only for skills the sync deletes', () => {
  const body = (text: string): { file: string; text: string; nearSkill: boolean }[] => [
    { file: 'skills/tdd/SKILL.md', text, nearSkill: false }
  ]
  assert.deepEqual(
    findStaleSkillRefs(
      body('It belongs to review (see the `code-review` skill).'),
      known,
      new Set()
    ),
    []
  )
  assert.deepEqual(
    findStaleSkillRefs(
      body('Search stays governed by lookup rules and `ast-grep`.'),
      known,
      new Set(['ast-grep'])
    ),
    [{ name: 'ast-grep', file: 'skills/tdd/SKILL.md', line: 1 }]
  )
})

test('library skills and code tokens away from the word skill are not stale', () => {
  const refs = findStaleSkillRefs(
    doc(
      [
        '- `using-kaneo` 스킬을 따른다.',
        '- 스킬이 `ready-for-agent` 등 라벨을 붙이라고 해도 건너뛴다.',
        '- `git push --force-with-lease` 는 허용한다.'
      ].join('\n')
    ),
    known,
    new Set()
  )
  assert.deepEqual(refs, [])
})

test('examples inside fenced code blocks are not references', () => {
  const refs = findStaleSkillRefs(
    doc('```md\n`example-thing` 스킬을 따른다.\n```'),
    known,
    new Set()
  )
  assert.deepEqual(refs, [])
})

test('apply preview lists a library rule that names a skill the library no longer has', () => {
  const h = mkdtempSync(join(tmpdir(), 'illithid-stale-refs-'))
  buildDemoHome(h, { tools: 'all' })
  const cfg = join(h, '.config/illithid/config.json')
  writeFileSync(
    cfg,
    JSON.stringify({ ...JSON.parse(readFileSync(cfg, 'utf8')), toolsInUse: ['claude'] })
  )
  const rules = join(h, '.illithid/workspaces/default/rules')
  mkdirSync(rules, { recursive: true })
  writeFileSync(
    join(rules, '99-ghost.md'),
    '# Ghost\n\n공용 메모리는 `ghost-curation` 스킬을 따른다.\n'
  )
  const view = applyPreview(h, baseEnv(h), memorySecretBackend())
  assert.deepEqual(view.staleRefs, [{ name: 'ghost-curation', file: 'rules/99-ghost.md', line: 3 }])
})

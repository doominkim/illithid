import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import i18next from 'i18next'
import { lastSyncFailedText, problemText } from '../src/renderer/src/lib/problemReason'

const lang = (l: string): Record<string, unknown> =>
  JSON.parse(readFileSync(`src/renderer/src/i18n/${l}.json`, 'utf8'))

test('REQ-TOOL-PROBLEM-REASONS-5 known reason codes read as sentences in every language; anything else stays as is', async () => {
  const keys = (l: string): string[] =>
    Object.keys((lang(l).sync as { why: Record<string, string> }).why).sort()
  for (const l of ['ko', 'ja', 'zh']) assert.deepEqual(keys(l), keys('en'), l)
  const i18n = i18next.createInstance()
  await i18n.init({
    lng: 'ko',
    resources: { ko: { translation: lang('ko') } },
    interpolation: { escapeValue: false }
  })
  const t = i18n.t.bind(i18n)
  assert.equal(problemText(t, 'hashMismatch'), '앱이 마지막으로 쓴 뒤 파일이 바뀜')
  assert.equal(problemText(t, 'someNewCode'), 'someNewCode')
  assert.equal(
    problemText(t, 'opencode.json: Unexpected token } at 3:1'),
    'opencode.json: Unexpected token } at 3:1'
  )
  assert.equal(problemText(t, undefined), undefined)
  assert.equal(
    lastSyncFailedText(t, 'userOwned'),
    '마지막 동기화 실패: 같은 이름의 사용자 파일이 있어 그대로 둠'
  )
})

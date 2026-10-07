import assert from 'node:assert/strict'
import { test } from 'node:test'
import { credentialStoreBackend, SECRET_SERVICE, SecretError } from '../src/engine/secrets'

/** Stand-in for @napi-rs/keyring's Entry, keyed by service + account */
function fakeEntry(
  store: Map<string, string>,
  failOn?: string
): new (
  s: string,
  a: string
) => {
  getPassword(): string | null
  setPassword(v: string): void
  deleteCredential(): boolean
} {
  return class {
    private key: string
    constructor(service: string, account: string) {
      this.key = `${service}|${account}`
      if (failOn && account === failOn) throw new Error(`store locked for ${account}: s3cr3t`)
    }
    getPassword(): string | null {
      return store.get(this.key) ?? null
    }
    setPassword(v: string): void {
      store.set(this.key, v)
    }
    deleteCredential(): boolean {
      return store.delete(this.key)
    }
  }
}

test('credential store backend keeps values under the Illithid service', () => {
  const store = new Map<string, string>()
  const b = credentialStoreBackend({ Entry: fakeEntry(store) })
  assert.equal(b.get('demo/env/TOKEN'), null)
  b.set('demo/env/TOKEN', 'abc')
  assert.equal(store.get(`${SECRET_SERVICE}|demo/env/TOKEN`), 'abc')
  assert.equal(b.get('demo/env/TOKEN'), 'abc')
  assert.equal(b.delete('demo/env/TOKEN'), true)
  assert.equal(b.delete('demo/env/TOKEN'), false)
})

test('credential store failures name the account only, never a value', () => {
  const b = credentialStoreBackend({ Entry: fakeEntry(new Map(), 'demo/env/TOKEN') })
  assert.throws(
    () => b.get('demo/env/TOKEN'),
    (e: unknown) =>
      e instanceof SecretError &&
      e.code === 'backendFailed' &&
      e.message.includes('demo/env/TOKEN') &&
      !e.message.includes('s3cr3t')
  )
  assert.throws(() => b.set('demo/env/OTHER', 'bad\nvalue'), { code: 'invalidValue' })
})

test(
  'Windows Credential Manager round-trip',
  { skip: process.platform !== 'win32' && 'needs Windows Credential Manager' },
  () => {
    const b = credentialStoreBackend({ service: `${SECRET_SERVICE}-test-${process.pid}` })
    const account = 'ci/env/ROUND_TRIP'
    try {
      b.set(account, 'value-123')
      assert.equal(b.get(account), 'value-123')
    } finally {
      b.delete(account)
    }
    assert.equal(b.get(account), null)
  }
)

import assert from 'node:assert/strict'
import { listPackage } from '@electron/asar'

/** The distributed app needs only compiled code, runtime dependencies, resources, and its package metadata. */
const archive = process.argv[2]
if (!archive) throw new Error('usage: tsx scripts/check-packaged-content.ts <app.asar>')
const entries = listPackage(archive, { isPack: false }).map((path) => path.replaceAll('\\', '/'))
const allowedRoots = new Set(['out', 'resources', 'node_modules', 'package.json'])
const unexpected = entries.filter((path) => {
  const root = path.replace(/^\/+/, '').split('/')[0]
  return !allowedRoots.has(root)
})
assert.deepEqual(
  unexpected,
  [],
  'the app archive must exclude local settings, QA artifacts, and source-only files'
)
assert.ok(entries.includes('/out/main/index.js'), 'the compiled app entry point must be present')
assert.ok(entries.includes('/package.json'), 'app metadata must be present')
console.log(`Package contents verified: ${entries.length} entries, runtime files only`)

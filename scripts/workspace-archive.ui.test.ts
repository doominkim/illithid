import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { _electron as electron } from 'playwright-core'
import { exportWorkspace, initLibrary, libraryRoot, planImportWorkspace } from '../src/engine'
import type { Api } from '../src/shared/api'
import { baseEnv } from './readme-shots'

declare global {
  interface Window {
    api: Api
  }
}

test(
  'the app imports its own 50 MiB workspace even when ZIP overhead makes the archive larger',
  { timeout: 120_000 },
  async (context) => {
    const home = mkdtempSync(join(tmpdir(), 'illithid-workspace-archive-ui-'))
    initLibrary(home)
    const skill = join(libraryRoot(home), 'skills/archive-fixture')
    mkdirSync(skill, { recursive: true })
    const skillDoc =
      '---\nname: archive-fixture\ndescription: Synthetic workspace archive fixture\n---\n'
    writeFileSync(join(skill, 'SKILL.md'), skillDoc)
    const baseBytes = planImportWorkspace(exportWorkspace(home).data).bytes
    const payload = randomBytes(52_428_800 - baseBytes)
    writeFileSync(join(skill, 'payload.bin'), payload)
    const archive = exportWorkspace(home)
    const plan = planImportWorkspace(archive.data)
    assert.equal(plan.ok, true, 'the export must satisfy the public import validation')
    assert.equal(plan.bytes, 52_428_800, '50 MiB uncompressed is the last accepted payload size')
    assert.ok(
      archive.data.byteLength > 52_428_800,
      'incompressible data plus ZIP overhead must exceed 50 MiB on disk'
    )
    context.diagnostic(
      JSON.stringify({
        uncompressedBytes: plan.bytes,
        archiveBytes: archive.data.byteLength,
        payloadBytes: payload.byteLength,
        files: plan.files
      })
    )
    const zip = join(home, 'archive-fixture.illithid.zip')
    writeFileSync(zip, archive.data, { mode: 0o600 })
    const configDir = join(home, '.config/illithid')
    mkdirSync(configDir, { recursive: true })
    writeFileSync(
      join(configDir, 'config.json'),
      JSON.stringify({
        version: 1,
        activeWorkspace: 'default',
        toolsInUse: [],
        allowRealApply: false,
        updateCheck: false,
        marketEnabled: false,
        autoBackup: false,
        ui: { language: 'en' }
      })
    )
    const app = await electron.launch({
      args: [resolve(process.env.ILLITHID_UI_ENTRY ?? 'out/main/index.js')],
      env: {
        ...baseEnv(home),
        NODE_PATH: resolve('node_modules'),
        ILLITHID_HOME: home,
        ILLITHID_TEST: '1',
        ILLITHID_USER_DATA: mkdtempSync(join(tmpdir(), 'illithid-workspace-archive-ud-'))
      },
      timeout: 30_000
    })
    try {
      const page = await app.firstWindow()
      await page.waitForFunction(() => Boolean(window.api))
      // Replace only the native file picker; the preload, IPC and importer remain real.
      await app.evaluate(({ dialog }, file) => {
        dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] })
      }, zip)
      const imported = await page.evaluate(() => window.api.workspaceImport())
      assert.equal(imported.ok, true, JSON.stringify(imported))
      if (!imported.ok || !imported.value) assert.fail('the selected ZIP must create a workspace')
      assert.equal(imported.value.files, plan.files)
      assert.deepEqual(imported.value.missingSecrets, [])
      const workspaces = await page.evaluate(() => window.api.workspaces())
      assert.ok(workspaces.some((workspace) => workspace.id === imported.value?.id))
      const switched = await page.evaluate(
        (id) => window.api.workspaceSwitch(id, false),
        imported.value.id
      )
      assert.equal(switched.ok, true, JSON.stringify(switched))
      const files = await page.evaluate(() => window.api.skillFiles('archive-fixture'))
      assert.deepEqual(files.ok && files.value, ['SKILL.md', 'payload.bin'])
      const restoredDoc = await page.evaluate(() =>
        window.api.skillFileRead('archive-fixture', 'SKILL.md')
      )
      assert.equal(restoredDoc.ok && restoredDoc.value, skillDoc)
    } finally {
      await app.close()
    }
  }
)

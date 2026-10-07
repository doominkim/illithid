import assert from 'node:assert/strict'
import { test } from 'node:test'
import { popoverPosition } from '../src/main/trayPosition'

const size = { width: 380, height: 480 }

test('the tray popover opens below a top menu bar icon (macOS)', () => {
  const area = { x: 0, y: 25, width: 1440, height: 875 }
  assert.deepEqual(popoverPosition({ x: 1300, y: 0, width: 24, height: 24 }, area, size), {
    x: 944,
    y: 28
  })
})

test('the tray popover opens above a bottom taskbar icon (Windows) and stays on screen', () => {
  const area = { x: 0, y: 0, width: 1920, height: 1040 }
  assert.deepEqual(popoverPosition({ x: 1800, y: 1044, width: 24, height: 32 }, area, size), {
    x: 1444,
    y: 552
  })
  // Icon near the left edge: kept 8px inside the work area
  assert.deepEqual(popoverPosition({ x: 10, y: 1044, width: 24, height: 32 }, area, size), {
    x: 8,
    y: 552
  })
})

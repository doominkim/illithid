interface Rect {
  x: number
  y: number
  width: number
  height: number
}

/**
 * Where the tray popover opens: its right edge under the icon's right edge, below a menu bar at the top of the screen (macOS)
 * or above a taskbar at the bottom (Windows), kept 8px inside the display's work area
 */
export function popoverPosition(
  icon: Rect,
  area: Rect,
  size: { width: number; height: number }
): { x: number; y: number } {
  const x = Math.min(
    Math.max(icon.x + icon.width - size.width, area.x + 8),
    area.x + area.width - size.width - 8
  )
  const iconBelowMiddle = icon.y > area.y + area.height / 2
  const y = iconBelowMiddle ? icon.y - size.height - 4 : icon.y + icon.height + 4
  const top = Math.min(Math.max(y, area.y + 8), area.y + area.height - size.height - 8)
  return { x: Math.round(x), y: Math.round(iconBelowMiddle ? top : y) }
}

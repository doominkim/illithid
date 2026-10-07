/** Files the default app would run rather than show — opening them from the app is the same as double-click running them */
const EXECUTABLE: Readonly<Partial<Record<NodeJS.Platform, RegExp>>> = {
  darwin: /\.(command|app|sh|tool|terminal|scpt|workflow|pkg|dmg)$/i,
  win32:
    /\.(exe|com|bat|cmd|ps1|psm1|vbs|vbe|js|jse|wsf|wsh|hta|lnk|msi|msp|scr|cpl|pif|reg|appx|msix|url)$/i,
  linux: /\.(sh|run|appimage|desktop)$/i
}

export function isExecutablePath(
  path: string,
  platform: NodeJS.Platform = process.platform
): boolean {
  return (EXECUTABLE[platform] ?? EXECUTABLE.linux!).test(path)
}

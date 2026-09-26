/** If the new localStorage key is missing, copy the first value found among keys from previous app names. Old keys are not deleted */
export function migrateStorageKey(key: string, legacyKeys: readonly string[]): void {
  try {
    if (localStorage.getItem(key) !== null) return
    for (const old of legacyKeys) {
      const v = localStorage.getItem(old)
      if (v !== null) {
        localStorage.setItem(key, v)
        return
      }
    }
  } catch {
    // Fall back to the default if storage is unavailable
  }
}

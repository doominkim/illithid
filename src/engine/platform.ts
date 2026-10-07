/**
 * The platform the app runs on. Tests stand in for another one with ILLITHID_TEST_PLATFORM (the engine reads it in process).
 */
export function hostPlatform(): NodeJS.Platform {
  return (process.env.ILLITHID_TEST_PLATFORM as NodeJS.Platform | undefined) || process.platform
}

/** Hooks are generated as POSIX shell scripts; Windows gets none until they have a Windows form */
export function hooksSupported(): boolean {
  return hostPlatform() !== 'win32'
}

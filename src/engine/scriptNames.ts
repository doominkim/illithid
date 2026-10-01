/** Library script name rule and starting content. Dependency-free so the renderer can use it too */
export const LIBRARY_SCRIPT_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/

export const SCRIPT_TEMPLATE =
  '#!/bin/sh\n# description: \n# $1 is the tool that ran the hook (claude, codex, gemini, copilot, grok).\n# The tool sends its event as JSON on stdin.\nexit 0\n'

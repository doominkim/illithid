/**
 * Per-tool model and effort choices for agent details (built into the app). Shared by renderer and engine — no dependencies.
 * Sources as of 2026-09-24: Claude = current lineup from the claude-api skill (aliases; Haiku 4.5 has no effort support) ·
 * Codex = ~/.codex/models_cache.json (codex 0.156.0, visibility=list, supported_reasoning_levels) ·
 * OpenCode = openai provider in ~/.cache/opencode/models.json + model/small_model in ~/.config/opencode/opencode.json ·
 * Gemini CLI = aliases and model ids in the gemini-cli 0.60.0 bundle (2026-09-27; no effort setting) ·
 * GitHub Copilot = agent `model` ids from the Copilot CLI changelog and the VS Code Copilot extension bundle (2026-09-27; efforts
 * low/medium/high). Only used for agent files — the default model is not managed.
 */
import type { ToolId } from '../engine/agents'

export interface ModelOption {
  value: string
  label: string
  /** Efforts this model accepts. If absent, the tool's default list */
  efforts?: string[]
}

export interface ToolModelCatalog {
  models: ModelOption[]
  /** When no model is set (default) or the model has no efforts */
  efforts: string[]
}

const CODEX_FULL = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra']
const CODEX_MAX = ['low', 'medium', 'high', 'xhigh', 'max']
const CODEX_XHIGH = ['low', 'medium', 'high', 'xhigh']

export const MODEL_CATALOG: Readonly<Record<ToolId, ToolModelCatalog>> = {
  claude: {
    models: [
      { value: 'fable', label: 'Fable 5.1' },
      { value: 'opus', label: 'Opus 5.5' },
      { value: 'sonnet', label: 'Sonnet 5' },
      { value: 'haiku', label: 'Haiku 4.5', efforts: [] },
      { value: 'inherit', label: 'inherit' }
    ],
    efforts: ['low', 'medium', 'high', 'xhigh', 'max']
  },
  codex: {
    models: [
      { value: 'gpt-6-astra', label: 'GPT-6-Astra', efforts: CODEX_FULL },
      { value: 'gpt-6-sol', label: 'GPT-6-Sol', efforts: CODEX_FULL },
      { value: 'gpt-6-luna', label: 'GPT-6-Luna', efforts: CODEX_MAX },
      { value: 'gpt-5.6-sol', label: 'GPT-5.6-Sol', efforts: CODEX_FULL },
      { value: 'gpt-5.6-terra', label: 'GPT-5.6-Terra', efforts: CODEX_FULL },
      { value: 'gpt-5.6-luna', label: 'GPT-5.6-Luna', efforts: CODEX_MAX },
      { value: 'gpt-5.5', label: 'GPT-5.5', efforts: CODEX_XHIGH }
    ],
    efforts: CODEX_XHIGH
  },
  opencode: {
    models: [
      { value: 'openai/gpt-6-astra', label: 'openai/gpt-6-astra' },
      { value: 'openai/gpt-5.6-sol', label: 'openai/gpt-5.6-sol' },
      { value: 'openai/gpt-5.6-terra', label: 'openai/gpt-5.6-terra' },
      { value: 'openai/gpt-5.6-luna', label: 'openai/gpt-5.6-luna' },
      { value: 'openai/gpt-5.5', label: 'openai/gpt-5.5' },
      { value: 'openai/gpt-5.3-codex-spark', label: 'openai/gpt-5.3-codex-spark' }
    ],
    efforts: ['low', 'medium', 'high', 'xhigh']
  },
  gemini: {
    models: [
      { value: 'auto', label: 'auto' },
      { value: 'pro', label: 'pro' },
      { value: 'flash', label: 'flash' },
      { value: 'flash-lite', label: 'flash-lite' },
      { value: 'gemini-3.1-pro-preview', label: 'gemini-3.1-pro-preview' },
      { value: 'gemini-3-flash-preview', label: 'gemini-3-flash-preview' },
      { value: 'gemini-2.5-pro', label: 'gemini-2.5-pro' },
      { value: 'inherit', label: 'inherit' }
    ],
    efforts: []
  },
  copilot: {
    models: [
      { value: 'auto', label: 'auto' },
      { value: 'claude-sonnet-4.6', label: 'claude-sonnet-4.6' },
      { value: 'claude-opus-4.8', label: 'claude-opus-4.8' },
      { value: 'gpt-5.5', label: 'gpt-5.5' },
      { value: 'gpt-5.4', label: 'gpt-5.4' },
      { value: 'gpt-5.3-codex', label: 'gpt-5.3-codex' }
    ],
    efforts: ['low', 'medium', 'high']
  }
}

/** Effort list for the model. The tool's default list for unknown or unset models */
export function effortsFor(tool: ToolId, model: string | undefined): string[] {
  const c = MODEL_CATALOG[tool]
  const m = model ? c.models.find((x) => x.value === model) : undefined
  return m?.efforts ?? c.efforts
}

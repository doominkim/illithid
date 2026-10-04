import type { TFunction } from 'i18next'
import type { McpRuleSummary } from '../../../shared/api'

/** An MCP server's tool rules in one line: the default its tools get, then how many tools each decision has */
export function mcpRuleText(t: TFunction, r: McpRuleSummary): string {
  const decision = (d: string): string => t(`permissions.decision.${d}`)
  return [
    r.default
      ? t(r.viaAll ? 'permissions.mcpDefaultAll' : 'permissions.mcpDefault', {
          decision: decision(r.default)
        })
      : t('permissions.mcpToolDefault'),
    ...(['deny', 'ask', 'allow'] as const)
      .filter((d) => r[d] > 0)
      .map((d) => `${decision(d)} ${r[d]}`)
  ].join(' · ')
}

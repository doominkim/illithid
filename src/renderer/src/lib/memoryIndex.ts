import type { IndexStat } from '../../../shared/api'

/** Share of the MEMORY.md limit at which the index meter turns amber */
export const NEAR_LIMIT = 0.8

/** True once either index measure (lines or bytes) reaches NEAR_LIMIT of its limit */
export const nearLimit = (s: IndexStat, l: IndexStat): boolean => s.lines >= l.lines * NEAR_LIMIT || s.bytes >= l.bytes * NEAR_LIMIT

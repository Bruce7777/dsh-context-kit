/** Configuration and complete-result budgets for current-session recall. */
import z from '@deepseek-ai/schemastery'

/** Limits applied independently to every history recall call. */
export interface Config {
  /** Maximum heuristic tokens of the rendered tool-result message. Defaults to 2048. */
  maxOutputTokens?: number
  /** Maximum UTF-8 bytes of the complete rendered result. Defaults to 8192. */
  maxOutputBytes?: number
  /** Maximum raw events inspected by one page. Defaults to 256. */
  maxScanEvents?: number
  /** Maximum text code units inspected by one search page. Defaults to 65536. */
  maxScanCharacters?: number
  /** Maximum literal search query length in code units. Defaults to 256. */
  maxQueryCharacters?: number
  /** Maximum code units in one search snippet. Defaults to 240. */
  snippetCharacters?: number
}

/** Schemastery defaults used by the Loader. */
export const Config: z<Config> = z.object({
  maxOutputTokens: z.number().step(1).min(256).default(2048),
  maxOutputBytes: z.number().step(1).min(1024).default(8192),
  maxScanEvents: z.number().step(1).min(1).default(256),
  maxScanCharacters: z.number().step(1).min(1024).default(65536),
  maxQueryCharacters: z.number().step(1).min(1).default(256),
  snippetCharacters: z.number().step(1).min(1).default(240),
})

/** Fully specified limits shared by the two tools. */
export type RecallConfig = Required<Config>

/**
 * Validate deployment limits before registering tools.
 * @param input - optional Loader-normalized limits.
 * @returns immutable resolved limits.
 */
export function resolveConfig(input: Config): Readonly<RecallConfig> {
  const resolved = {
    maxOutputTokens: input.maxOutputTokens ?? 2048,
    maxOutputBytes: input.maxOutputBytes ?? 8192,
    maxScanEvents: input.maxScanEvents ?? 256,
    maxScanCharacters: input.maxScanCharacters ?? 65536,
    maxQueryCharacters: input.maxQueryCharacters ?? 256,
    snippetCharacters: input.snippetCharacters ?? 240,
  }
  const keys = new Set(Object.keys(resolved))
  for (const key of Object.keys(input)) {
    if (!keys.has(key)) throw new TypeError(`context recall: unknown configuration key ${key}`)
  }
  for (const [key, value] of Object.entries(resolved)) {
    const minimum = key === 'maxOutputTokens' ? 256
      : key === 'maxOutputBytes' || key === 'maxScanCharacters' ? 1024 : 1
    if (!Number.isSafeInteger(value) || value < minimum) {
      throw new TypeError(`context recall: ${key} must be a safe integer at least ${minimum}`)
    }
  }
  if (resolved.maxQueryCharacters > resolved.maxScanCharacters) {
    throw new TypeError('context recall: maxQueryCharacters must not exceed maxScanCharacters')
  }
  return Object.freeze(resolved)
}

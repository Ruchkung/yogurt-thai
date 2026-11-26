/**
 * AI servers the person runs (whisper.cpp's whisper-server, llama.cpp's llama-server), on this computer or another, used instead of Yogurt's
 * own models when set in Settings. Each is one address; nothing goes anywhere until the person types one.
 */
export type LocalServers = {
  /** whisper-server: its address, with the inference path when it isn't /inference (e.g. http://127.0.0.1:8178/v1/audio/transcriptions) */
  asr?: string
  /** an OpenAI-compatible chat server such as llama-server (e.g. http://127.0.0.1:8081) */
  llm?: string
}

/** an http(s) address as typed, without a trailing slash, query or fragment; undefined when it isn't one */
export function cleanServerUrl(v: unknown): string | undefined {
  if (typeof v !== 'string' || !v.trim()) return undefined
  let raw = v.trim()
  if (!/^[a-z][a-z\d+.-]*:\/\//i.test(raw)) raw = `http://${raw}`
  let u: URL
  try { u = new URL(raw) } catch { return undefined }
  if ((u.protocol !== 'http:' && u.protocol !== 'https:') || u.username || u.password) return undefined
  return `${u.origin}${u.pathname.replace(/\/+$/, '')}`
}

/** Both addresses cleaned; anything that isn't one is left out */
export function cleanLocalServers(v: unknown): LocalServers {
  const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>
  const asr = cleanServerUrl(o.asr), llm = cleanServerUrl(o.llm)
  return { ...(asr ? { asr } : {}), ...(llm ? { llm } : {}) }
}

/** where whisper-server is, and the path chunks are posted to (/inference unless the address names another) */
export function asrEndpoint(url: string): { base: string; path: string } {
  const u = new URL(url)
  const path = u.pathname.replace(/\/+$/, '')
  return { base: u.origin, path: path || '/inference' }
}

/** the chat server's base, without a /v1 the person may have typed */
export const llmBase = (url: string): string => url.replace(/\/v1(\/chat\/completions)?$/, '')

/**
 * Whether a server answers at an address: whisper-server's page at its root, a chat server's /v1/models. Only that it
 * is there; a wrong path still shows up on the first chunk.
 */
export async function serverAnswers(kind: 'asr' | 'llm', url: string, fetchFn: typeof fetch = fetch): Promise<boolean> {
  const at = kind === 'asr' ? `${asrEndpoint(url).base}/` : `${llmBase(url)}/v1/models`
  try { return (await fetchFn(at, { signal: AbortSignal.timeout(5000) })).ok } catch { return false }
}

/** whether an address is this computer itself (localhost, 127.x.x.x, ::1): anything else is another machine, and what Yogurt sends there leaves this one */
export function onThisComputer(url: string): boolean {
  let host: string
  try { host = new URL(url).hostname.toLowerCase() } catch { return false }
  return host === 'localhost' || host.endsWith('.localhost') || /^127(\.\d{1,3}){3}$/.test(host) || host === '[::1]'
}

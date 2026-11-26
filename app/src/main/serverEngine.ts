import type { EngineMessage } from '../shared/engine-protocol'
import { llmBase } from '../shared/localServers'
import type { ChatRequest, Engine } from './engine'

/** the model path a notes model is "loaded" from when it is the person's own server: never a file */
export const SERVER_MODEL = 'server:'
export const serverModelPath = (url: string): string => `${SERVER_MODEL}${url}`
export const isServerModel = (path: string | undefined): boolean => !!path?.startsWith(SERVER_MODEL)

/** when /props doesn't say: llama-server's own default */
const FALLBACK_CONTEXT = 4096

/** thinking between <think> tags, for a server that leaves it in the answer (llama-server --reasoning-format none) */
function withoutThinking(onToken: (t: string) => void) {
  let inside = false, carry = ''
  return (piece: string): string => {
    let text = carry + piece, out = ''
    carry = ''
    while (text) {
      const tag = inside ? '</think>' : '<think>'
      const at = text.indexOf(tag)
      if (at >= 0) { if (!inside) out += text.slice(0, at); text = text.slice(at + tag.length); inside = !inside; continue }
      // a tag cut in two between pieces: its start waits for the next one
      let keep = 0
      for (let n = Math.min(tag.length - 1, text.length); n > 0; n--) if (tag.startsWith(text.slice(-n))) { keep = n; break }
      if (!inside) out += text.slice(0, text.length - keep)
      carry = text.slice(text.length - keep)
      text = ''
    }
    if (out) onToken(out)
    return out
  }
}

/**
 * The notes model as an OpenAI-compatible chat server the person already runs (llama.cpp's llama-server): nothing is
 * loaded here, the server holds the model. Counting uses llama-server's /tokenize, falling back to an estimate.
 * Embeddings stay with Yogurt's own engine (`local`), since the meaning index is built with its model.
 */
export class ServerEngine implements Engine {
  /** the server the model was last "loaded" from: what plain count and chat calls go to */
  private pinned: string | undefined
  /** servers whose /tokenize failed or stalled: counted by estimate from then on, so no job waits on it again */
  private noTokenize = new Set<string>()
  constructor(private local: Engine, private fetchFn: typeof fetch = fetch, private limits = { propsMs: 10_000, tokenizeMs: 10_000, answerMs: 5 * 60_000 }) {}

  /** the server a model path names (serverModelPath), never what Settings say now: a job stays on the server it started with */
  private static urlOf(modelPath: string) {
    if (!isServerModel(modelPath)) throw new Error('Not a notes server')
    return llmBase(modelPath.slice(SERVER_MODEL.length))
  }
  private current() {
    if (!this.pinned) throw new Error('No notes server loaded')
    return this.pinned
  }

  /** count, chat and preload against the server this model path names, whatever is loaded later */
  at(modelPath: string): Pick<Engine, 'count' | 'chat' | 'preload'> {
    const base = ServerEngine.urlOf(modelPath)
    return { count: (texts) => this.countAt(base, texts), chat: (req, onToken, signal) => this.chatAt(base, req, onToken, signal), preload: async () => 0 }
  }

  async load(modelPath: string): Promise<{ contextSize: number }> {
    const base = ServerEngine.urlOf(modelPath)
    this.pinned = base
    const res = await this.fetchFn(`${base}/props`, { signal: AbortSignal.timeout(this.limits.propsMs) }).catch((e: unknown) => {
      throw new Error(`The notes server at ${base} can't be reached (${e instanceof Error ? e.message : String(e)})`)
    })
    // an OpenAI-compatible server that isn't llama-server has no /props: its context is unknown, so the smallest guess
    if (!res.ok) return { contextSize: FALLBACK_CONTEXT }
    const p = (await res.json().catch(() => ({}))) as { n_ctx?: number; default_generation_settings?: { n_ctx?: number } }
    const n = p.default_generation_settings?.n_ctx ?? p.n_ctx
    console.info('NOTES', `using the notes server at ${base}: context ${n ?? 'unknown'}`)
    return { contextSize: typeof n === 'number' && n > 0 ? n : FALLBACK_CONTEXT }
  }
  async unload() {}

  count(texts: string[]) { return this.countAt(this.current(), texts) }
  chat(req: ChatRequest, onToken: (text: string) => void, signal?: AbortSignal) { return this.chatAt(this.current(), req, onToken, signal) }

  private async countAt(base: string, texts: string[]): Promise<number[]> {
    // about 3 characters a token, a little over for English so a long meeting is split before it overflows
    const estimate = (content: string) => Math.ceil(content.length / 3)
    if (this.noTokenize.has(base)) return texts.map(estimate)
    return Promise.all(texts.map(async (content) => {
      try {
        const res = await this.fetchFn(`${base}/tokenize`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content }), signal: AbortSignal.timeout(this.limits.tokenizeMs) })
        if (res.ok) { const r = (await res.json()) as { tokens?: unknown[] }; if (Array.isArray(r.tokens)) return r.tokens.length }
      } catch { /* estimated below */ }
      if (!this.noTokenize.has(base)) console.warn('NOTES', `the notes server at ${base} gave no token count: estimating from here on`)
      this.noTokenize.add(base)
      return estimate(content)
    }))
  }

  private async chatAt(base: string, req: ChatRequest, onToken: (text: string) => void, signal?: AbortSignal): Promise<string> {
    if (signal?.aborted) throw new Error('Stopped')
    const think = (req.thoughtBudget ?? 0) > 0
    const body = {
      messages: req.messages, stream: true,
      ...(req.maxTokens ? { max_tokens: req.maxTokens } : {}),
      ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
      // Qwen3 and other thinking templates: no thinking unless asked for, as with Yogurt's own engine
      chat_template_kwargs: { enable_thinking: think },
      ...(think ? { thinking_budget_tokens: req.thoughtBudget } : {}),
    }
    // a server that never starts answering would hold the queue: the answer's first bytes must come within answerMs
    const started = new AbortController()
    const timer = setTimeout(() => started.abort(new Error(`The notes server at ${base} didn't answer within ${Math.round(this.limits.answerMs / 1000)} s`)), this.limits.answerMs)
    const res = await this.fetchFn(`${base}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: signal ? AbortSignal.any([signal, started.signal]) : started.signal })
      .catch((e: unknown) => { if (signal?.aborted) throw new Error('Stopped'); throw started.signal.aborted ? started.signal.reason : e })
      .finally(() => clearTimeout(timer))
    if (!res.ok || !res.body) throw new Error(`The notes server answered ${res.status}${await res.text().then((t) => (t ? `: ${t.slice(0, 200)}` : ''), () => '')}`)
    const shown = withoutThinking(onToken)
    let answer = '', pending = ''
    const decoder = new TextDecoder()
    const reader = res.body.getReader()
    const line = (l: string) => {
      const data = l.startsWith('data:') ? l.slice(5).trim() : ''
      if (!data || data === '[DONE]') return
      let e: { choices?: Array<{ delta?: { content?: string | null } }>; error?: { message?: string } }
      try { e = JSON.parse(data) } catch { return }
      if (e.error) throw new Error(`The notes server failed: ${e.error.message ?? 'unknown error'}`)
      const piece = e.choices?.[0]?.delta?.content
      if (piece) answer += shown(piece)
    }
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        pending += decoder.decode(value, { stream: true })
        const lines = pending.split('\n')
        pending = lines.pop() ?? ''
        lines.forEach(line)
      }
      if (pending) line(pending)
    } catch (e) {
      if (signal?.aborted) throw new Error('Stopped')
      throw e
    }
    return answer.trim()
  }

  /** llama-server keeps the last prompt it read on its own (cache_prompt), so there is nothing to read ahead */
  async preload(_messages: EngineMessage[]): Promise<number> { return 0 }
  embed(modelPath: string, texts: string[]) { return this.local.embed(modelPath, texts) }
  unloadEmbed() { return this.local.unloadEmbed() }
  onExit(cb: () => void) { this.local.onExit(cb) }
  dispose() {}
}

/**
 * Yogurt's own engine, or the person's notes server when one is set: each call goes to the one the model path names,
 * so changing Settings takes effect from the next notes or question (the notes model loads again on a new path).
 */
export class RoutedEngine implements Engine {
  private on: Engine
  constructor(private local: Engine, private server: ServerEngine) { this.on = local }
  /** what a job uses: the engine its model path names, so a Settings change mid-job doesn't move it to another server */
  forModel(modelPath: string): Pick<Engine, 'count' | 'chat' | 'preload'> {
    return isServerModel(modelPath) ? this.server.at(modelPath) : this.local
  }
  load(modelPath: string, contextSize: number, minContext: number) {
    const next = isServerModel(modelPath) ? this.server : this.local
    // leaving Yogurt's own model for the server: its memory goes back (the server's stays with the server)
    if (this.on === this.local && next === this.server) void this.local.unload().catch(() => {})
    this.on = next
    return next.load(modelPath, contextSize, minContext)
  }
  unload() { return this.on.unload() }
  count(texts: string[]) { return this.on.count(texts) }
  chat(req: ChatRequest, onToken: (text: string) => void, signal?: AbortSignal) { return this.on.chat(req, onToken, signal) }
  preload(messages: EngineMessage[], signal?: AbortSignal) { return this.on.preload(messages, signal) }
  embed(modelPath: string, texts: string[]) { return this.local.embed(modelPath, texts) }
  unloadEmbed() { return this.local.unloadEmbed() }
  onExit(cb: () => void) { this.local.onExit(cb) }
  dispose() { this.local.dispose() }
}

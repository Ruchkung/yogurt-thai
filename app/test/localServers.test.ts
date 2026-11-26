import { describe, expect, it } from 'vitest'
import { asrEndpoint, cleanLocalServers, cleanServerUrl, llmBase, onThisComputer, serverAnswers } from '../src/shared/localServers'
import { isServerModel, RoutedEngine, ServerEngine, serverModelPath } from '../src/main/serverEngine'
import { createTranscriber } from '../src/main/asr/transcribe'
import type { Engine } from '../src/main/engine'

const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } })
const sse = (events: unknown[]) => new Response(events.map((e) => `data: ${typeof e === 'string' ? e : JSON.stringify(e)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } })
const delta = (content: string) => ({ choices: [{ delta: { content } }] })

/** a stand-in fetch that records what was asked and answers from a table of paths */
function fakeFetch(routes: Record<string, (body: unknown) => Response>) {
  const calls: Array<{ url: string; body: unknown }> = []
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : init?.body
    calls.push({ url, body })
    const path = new URL(url).pathname
    const route = routes[path]
    if (!route) return new Response('not found', { status: 404 })
    return route(body)
  }) as typeof fetch
  return { f, calls }
}

const own = (): Engine & { loads: string[]; unloads: number } => {
  const e = {
    loads: [] as string[], unloads: 0,
    async load(p: string) { e.loads.push(p); return { contextSize: 8192 } },
    async unload() { e.unloads++ },
    async count(texts: string[]) { return texts.map(() => 1) },
    async chat() { return 'own model' },
    async preload() { return 0 },
    async embed(_p: string, texts: string[]) { return texts.map(() => [1, 0]) },
    async unloadEmbed() {},
    onExit() {}, dispose() {},
  }
  return e
}

describe('local server addresses', () => {
  it('keeps http(s) addresses as typed and drops anything else', () => {
    expect(cleanServerUrl('127.0.0.1:8081/')).toBe('http://127.0.0.1:8081')
    expect(cleanServerUrl(' http://localhost:8178/v1/audio/transcriptions ')).toBe('http://localhost:8178/v1/audio/transcriptions')
    expect(cleanServerUrl('ftp://example.test')).toBeUndefined()
    expect(cleanServerUrl('http://user:pw@example.test')).toBeUndefined()
    expect(cleanServerUrl('')).toBeUndefined()
    expect(cleanLocalServers({ asr: 'http://127.0.0.1:8178', llm: 'nope://x', other: 1 })).toEqual({ asr: 'http://127.0.0.1:8178' })
  })
  it("posts to whisper-server's /inference unless the address names another path", () => {
    expect(asrEndpoint('http://127.0.0.1:8178')).toEqual({ base: 'http://127.0.0.1:8178', path: '/inference' })
    expect(asrEndpoint('http://127.0.0.1:8178/v1/audio/transcriptions')).toEqual({ base: 'http://127.0.0.1:8178', path: '/v1/audio/transcriptions' })
    expect(llmBase('http://127.0.0.1:8081/v1')).toBe('http://127.0.0.1:8081')
  })
  it('tells an address on this computer from another computer, where what Yogurt sends leaves this one', () => {
    for (const u of ['http://127.0.0.1:8178', 'http://localhost:8081', 'http://[::1]:8081', 'http://yogurt.localhost']) expect(onThisComputer(u)).toBe(true)
    for (const u of ['http://192.168.1.20:8081', 'https://api.example.test', 'http://127.0.0.1.example.test']) expect(onThisComputer(u)).toBe(false)
  })
  it('says whether a server answers', async () => {
    const { f, calls } = fakeFetch({ '/': () => new Response('ok'), '/v1/models': () => json({ data: [] }) })
    expect(await serverAnswers('asr', 'http://127.0.0.1:8178/v1/audio/transcriptions', f)).toBe(true)
    expect(await serverAnswers('llm', 'http://127.0.0.1:8081', f)).toBe(true)
    expect(calls.map((c) => c.url)).toEqual(['http://127.0.0.1:8178/', 'http://127.0.0.1:8081/v1/models'])
    const down = (async () => { throw new TypeError('fetch failed') }) as typeof fetch
    expect(await serverAnswers('llm', 'http://127.0.0.1:9', down)).toBe(false)
  })
})

describe("the person's own whisper-server", () => {
  it('sends chunks to the path it was started with, in Thai', async () => {
    const asked: string[] = []
    let language: FormDataEntryValue | null = null
    const fetchFn = (async (url: string, init?: RequestInit) => {
      asked.push(url)
      language = (init?.body as FormData).get('language')
      return json({ language: 'th', segments: [{ start: 0, end: 1, text: ' สวัสดีครับ' }] })
    }) as typeof fetch
    const transcribe = createTranscriber({ url: async () => 'http://127.0.0.1:8178', path: '/v1/audio/transcriptions', fetchFn, language: () => 'th' })
    const lines = await transcribe({ track: 'them', startMs: 0, samples: new Float32Array(16000) } as never)
    expect(asked).toEqual(['http://127.0.0.1:8178/v1/audio/transcriptions'])
    expect(language).toBe('th')
    expect(lines.map((l) => l.text)).toEqual(['สวัสดีครับ'])
  })
})

describe('the notes server', () => {
  const server = (routes: Record<string, (body: unknown) => Response>) => {
    const { f, calls } = fakeFetch(routes)
    const engine = new ServerEngine(own(), f, { propsMs: 1000, tokenizeMs: 50, answerMs: 50 })
    return { engine, calls, ready: () => engine.load(serverModelPath('http://127.0.0.1:8081')).catch(() => undefined) }
  }
  const path = serverModelPath('http://127.0.0.1:8081')

  it("takes its context from llama-server's /props", async () => {
    expect(await server({ '/props': () => json({ default_generation_settings: { n_ctx: 65536 } }) }).engine.load(path)).toEqual({ contextSize: 65536 })
    // not llama-server: the smallest guess
    expect((await server({}).engine.load(path)).contextSize).toBe(4096)
  })

  it('counts with /tokenize, and estimates when it has none', async () => {
    const s = server({ '/tokenize': (b) => json({ tokens: Array((b as { content: string }).content.length).fill(1) }) })
    await s.ready()
    expect(await s.engine.count(['abc', 'สวัสดี'])).toEqual([3, 6])
    const none = server({}); await none.ready()
    expect(await none.engine.count(['abcdef'])).toEqual([2])
  })

  it("doesn't wait on a tokenizer that stalls, and estimates from then on", async () => {
    let asked = 0
    const { f } = fakeFetch({})
    const stalls = (async (url: string, init?: RequestInit) => {
      if (!String(url).endsWith('/tokenize')) return f(url, init)
      asked++
      return new Promise<Response>((_, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal!.reason)))
    }) as typeof fetch
    const engine = new ServerEngine(own(), stalls, { propsMs: 1000, tokenizeMs: 30, answerMs: 1000 })
    await engine.load(path)
    const t0 = Date.now()
    expect(await engine.count(['abcdef', 'abc'])).toEqual([2, 1])
    expect(Date.now() - t0).toBeLessThan(1000)
    expect(await engine.count(['abcdef'])).toEqual([2])
    expect(asked).toBe(2)
  })

  it('gives up on a server that never starts answering', async () => {
    const hangs = (async (_url: string, init?: RequestInit) => new Promise<Response>((_, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal!.reason)))) as typeof fetch
    const engine = new ServerEngine(own(), hangs, { propsMs: 1000, tokenizeMs: 30, answerMs: 30 })
    await expect(engine.at(path).chat({ messages: [] }, () => {})).rejects.toThrow("didn't answer within")
  })

  it('keeps a job on the server it started with when Settings change', async () => {
    const a = fakeFetch({ '/props': () => json({ n_ctx: 8192 }), '/v1/chat/completions': () => sse([delta('from A')]) })
    const engine = new ServerEngine(own(), (async (url: string, init?: RequestInit) => {
      if (String(url).startsWith('http://b.localhost')) return sse([delta('from B')])
      return a.f(url, init)
    }) as typeof fetch)
    await engine.load(path)
    const job = engine.at(path)
    // Settings now name another server, and something loads it
    await engine.load(serverModelPath('http://b.localhost:8081')).catch(() => {})
    expect(await job.chat({ messages: [] }, () => {})).toBe('from A')
  })

  it('streams the answer without thinking, and asks for none unless given a budget', async () => {
    const { engine, calls, ready } = server({ '/v1/chat/completions': () => sse([delta('<thi'), delta('nk>hmm</think>'), delta('สรุป: '), delta('ตกลงราคา'), '[DONE]']) })
    await ready()
    const shown: string[] = []
    const answer = await engine.chat({ messages: [{ role: 'user', content: 'สรุปการประชุม' }], maxTokens: 500, temperature: 0.2 }, (t) => shown.push(t))
    expect(answer).toBe('สรุป: ตกลงราคา')
    expect(shown.join('')).toBe('สรุป: ตกลงราคา')
    expect(calls.find((c) => c.url.endsWith('/v1/chat/completions'))?.body).toMatchObject({ stream: true, max_tokens: 500, temperature: 0.2, chat_template_kwargs: { enable_thinking: false }, messages: [{ role: 'user', content: 'สรุปการประชุม' }] })
  })

  it('says what the server answered when it fails', async () => {
    const { engine, ready } = server({ '/v1/chat/completions': () => new Response('model is loading', { status: 503 }) })
    await ready()
    await expect(engine.chat({ messages: [{ role: 'user', content: 'x' }] }, () => {})).rejects.toThrow('The notes server answered 503: model is loading')
  })
})

describe('choosing between Yogurt’s model and the notes server', () => {
  it('follows the model path, lets go of the own model when moving to the server, and keeps embeddings local', async () => {
    const local = own()
    const { f } = fakeFetch({ '/props': () => json({ n_ctx: 32768 }), '/v1/chat/completions': () => sse([delta('from server')]) })
    const engine = new RoutedEngine(local, new ServerEngine(local, f))
    await engine.load('/models/gemma.gguf', 8192, 4096)
    expect(await engine.chat({ messages: [] }, () => {})).toBe('own model')
    const path = serverModelPath('http://127.0.0.1:8081')
    expect(isServerModel(path)).toBe(true)
    expect(await engine.load(path, 8192, 4096)).toEqual({ contextSize: 32768 })
    expect(local.unloads).toBe(1)
    expect(await engine.chat({ messages: [] }, () => {})).toBe('from server')
    expect(await engine.embed('/models/embed.gguf', ['a'])).toEqual([[1, 0]])
    expect(await engine.forModel('/models/gemma.gguf').chat({ messages: [] }, () => {})).toBe('own model')
  })
})

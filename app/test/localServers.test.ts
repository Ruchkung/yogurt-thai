import { describe, expect, it } from 'vitest'
import { asrEndpoint, cleanLocalServers, cleanServerUrl, llmBase, serverAnswers } from '../src/shared/localServers'
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
    return { engine: new ServerEngine(() => 'http://127.0.0.1:8081', own(), f), calls }
  }

  it("takes its context from llama-server's /props", async () => {
    expect(await server({ '/props': () => json({ default_generation_settings: { n_ctx: 65536 } }) }).engine.load()).toEqual({ contextSize: 65536 })
    // not llama-server: the smallest guess
    expect((await server({}).engine.load()).contextSize).toBe(4096)
  })

  it('counts with /tokenize, and estimates when it has none', async () => {
    expect(await server({ '/tokenize': (b) => json({ tokens: Array((b as { content: string }).content.length).fill(1) }) }).engine.count(['abc', 'สวัสดี'])).toEqual([3, 6])
    expect(await server({}).engine.count(['abcdef'])).toEqual([2])
  })

  it('streams the answer without thinking, and asks for none unless given a budget', async () => {
    const { engine, calls } = server({ '/v1/chat/completions': () => sse([delta('<thi'), delta('nk>hmm</think>'), delta('สรุป: '), delta('ตกลงราคา'), '[DONE]']) })
    const shown: string[] = []
    const answer = await engine.chat({ messages: [{ role: 'user', content: 'สรุปการประชุม' }], maxTokens: 500, temperature: 0.2 }, (t) => shown.push(t))
    expect(answer).toBe('สรุป: ตกลงราคา')
    expect(shown.join('')).toBe('สรุป: ตกลงราคา')
    expect(calls[0].body).toMatchObject({ stream: true, max_tokens: 500, temperature: 0.2, chat_template_kwargs: { enable_thinking: false }, messages: [{ role: 'user', content: 'สรุปการประชุม' }] })
  })

  it('says what the server answered when it fails', async () => {
    const { engine } = server({ '/v1/chat/completions': () => new Response('model is loading', { status: 503 }) })
    await expect(engine.chat({ messages: [{ role: 'user', content: 'x' }] }, () => {})).rejects.toThrow('The notes server answered 503: model is loading')
  })
})

describe('choosing between Yogurt’s model and the notes server', () => {
  it('follows the model path, lets go of the own model when moving to the server, and keeps embeddings local', async () => {
    const local = own()
    const { f } = fakeFetch({ '/props': () => json({ n_ctx: 32768 }), '/v1/chat/completions': () => sse([delta('from server')]) })
    const engine = new RoutedEngine(local, new ServerEngine(() => 'http://127.0.0.1:8081', local, f))
    await engine.load('/models/gemma.gguf', 8192, 4096)
    expect(await engine.chat({ messages: [] }, () => {})).toBe('own model')
    const path = serverModelPath('http://127.0.0.1:8081')
    expect(isServerModel(path)).toBe(true)
    expect(await engine.load(path, 8192, 4096)).toEqual({ contextSize: 32768 })
    expect(local.unloads).toBe(1)
    expect(await engine.chat({ messages: [] }, () => {})).toBe('from server')
    expect(await engine.embed('/models/embed.gguf', ['a'])).toEqual([[1, 0]])
  })
})

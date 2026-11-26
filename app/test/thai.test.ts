import { afterEach, describe, expect, it } from 'vitest'
import { openStore, type Store } from '../src/main/store'
import { Library } from '../src/main/library/store'
import { chunkTranscript, CHUNK_WORDS } from '../src/main/library/chunks'
import { splitThai, thaiWords, wordCount } from '../src/shared/thai'
import { spokenOf, whisperLanguage } from '../src/shared/spoken'
import { speechFits, wantedSpeechLocale } from '../src/main/asr/appleSpeech'
import { tokens } from '../src/main/asr/echo'
import { isSilenceGuess } from '../src/main/asr/hallucination'
import { guessLanguage } from '../src/main/notes/enhance'
import { searchWords } from '../src/shared/searchQuery'

const stores: Store[] = []
afterEach(() => stores.splice(0).forEach((s) => s.close()))
const fresh = () => { const s = openStore(':memory:'); stores.push(s); return s }
const meeting = (s: Store, title: string) =>
  s.createMeeting({ title, startedAt: 1000, endedAt: 2000, eventId: null, app: null, attendees: [], state: 'done' })

describe('Thai words', () => {
  it('splits a run of Thai into its words and leaves other scripts whole', () => {
    expect(thaiWords('ราคาสินค้า')).toEqual(['ราคา', 'สินค้า'])
    expect(splitThai(['ตกลงราคา', 'pricing', 'Q3'])).toEqual(['ตกลง', 'ราคา', 'pricing', 'Q3'])
    expect(splitThai(['ราคาQ3'])).toEqual(['ราคา', 'Q3'])
  })
  it('counts Thai words one by one, not each spaced phrase as one', () => {
    expect(wordCount('hello there')).toBe(2)
    expect(wordCount('เราตกลงราคาสินค้า กับลูกค้า')).toBe(6)
  })
  it('keeps Thai vowel and tone marks inside search words', () => {
    expect(searchWords('ราคาสินค้า')).toEqual(['ราคาสินค้า'])
  })
  it('compares Thai lines by their words', () => {
    // the exact cut follows the ICU dictionary; what matters is that the phrase is words, not one token
    expect(tokens('ขอบคุณที่รับชม').slice(0, 2)).toEqual(['ขอบคุณ', 'ที่'])
    expect(isSilenceGuess('ขอบคุณที่รับชมครับ')).toBe(true)
  })
  it('tells a Thai question is Thai', () => {
    expect(guessLanguage('เราตกลงเรื่องราคาว่าอย่างไร', 'English')).toBe('Thai')
  })
})

describe('Thai as the spoken language', () => {
  it('is saved and tells whisper it is Thai', () => {
    expect(spokenOf('th')).toBe('th')
    expect(whisperLanguage('th')).toBe('th')
    expect(whisperLanguage('en')).toBe('en')
    expect(whisperLanguage('multi')).toBeUndefined()
  })
  it("listens in Thai on a Mac that has a Thai model, and leaves the live words to whisper when it hasn't", () => {
    expect(wantedSpeechLocale({ spoken: 'th', supported: ['en_US', 'th_TH'], ui: 'en-US' })).toBe('th_TH')
    expect(wantedSpeechLocale({ spoken: 'th', supported: ['en_US', 'fr_FR'], ui: 'th' })).toBeNull()
    expect(speechFits('th', 'th_TH')).toBe(true)
    expect(speechFits('th', 'en_US')).toBe(false)
  })
})

describe('finding Thai in meetings', () => {
  it('search finds a Thai word inside a transcript line and in a title', () => {
    const s = fresh()
    const a = meeting(s, 'ประชุมทีมขาย'), b = meeting(s, 'Hiring')
    s.addSegments([{ meetingId: a.id, track: 'them', startMs: 0, endMs: 1000, text: 'เราตกลงราคาสินค้ากับลูกค้าแล้ว', speaker: null }])
    s.addSegments([{ meetingId: b.id, track: 'them', startMs: 0, endMs: 1000, text: 'We talked about the budget', speaker: null }])
    const ids = (q: string) => s.search(q, 30, undefined, { now: new Date(2026, 10, 12), locale: 'th-TH' }).map((h) => h.meetingId)
    expect(ids('ราคาสินค้า')).toEqual([a.id])
    expect(ids('ทีมขาย')).toEqual([a.id])
    expect(ids('ราคาพนักงาน')).toEqual([])
  })
  it('a Thai question finds the lines it is about', () => {
    const s = fresh()
    const m = meeting(s, 'A')
    s.addSegments([
      { meetingId: m.id, track: 'me', startMs: 0, endMs: 1, text: 'สวัสดีครับทุกคน', speaker: null },
      { meetingId: m.id, track: 'them', startMs: 2, endMs: 3, text: 'งบประมาณปีหน้าต้องลดลงสิบเปอร์เซ็นต์', speaker: 'A' },
    ])
    const ids = s.segments(m.id).map((x) => x.id)
    expect(s.segmentHits(m.id, 'งบประมาณเป็นอย่างไรบ้าง')).toEqual([ids[1]])
  })
  it('asking across meetings finds chunks by Thai words', () => {
    const s = fresh()
    const lib = new Library(s.db)
    const a = meeting(s, 'A'), b = meeting(s, 'B')
    s.addSegments([{ meetingId: a.id, track: 'them', startMs: 0, endMs: 900, text: 'ลูกค้าขอส่วนลดราคาสินค้า', speaker: null }])
    s.addSegments([{ meetingId: b.id, track: 'them', startMs: 0, endMs: 900, text: 'เรื่องรับคนเพิ่ม', speaker: null }])
    lib.setChunks(a.id, 'x', [], [{ startMs: 0, endMs: 5000, text: 'Them: ลูกค้าขอส่วนลดราคาสินค้า', speakers: ['Them'] }])
    lib.setChunks(b.id, 'y', [], [{ startMs: 0, endMs: 5000, text: 'Them: เรื่องรับคนเพิ่ม', speakers: ['Them'] }])
    expect(lib.chunks(lib.wordHits(['ส่วนลด', 'ราคา'])).map((c) => c.meetingId)).toEqual([a.id])
  })
  it('cuts a long Thai turn into chunks by its words', () => {
    const line = 'เราตกลงราคาสินค้ากับลูกค้า'.repeat(80)
    const chunks = chunkTranscript([{ id: 1, meetingId: 'm', track: 'them', startMs: 0, endMs: 1000, text: line, speaker: 'A' },
      { id: 2, meetingId: 'm', track: 'them', startMs: 1000, endMs: 2000, text: line, speaker: 'A' }] as never)
    expect(wordCount(line)).toBeGreaterThan(CHUNK_WORDS)
    expect(chunks.length).toBe(2)
  })
})

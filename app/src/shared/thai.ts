/**
 * Thai is written without spaces between words, so splitting on spaces or punctuation gives a whole phrase as one
 * "word". These split Thai runs into words with the dictionary Intl.Segmenter carries (Electron's ICU has it), and
 * leave every other script as it was.
 */

export const THAI = /\p{Script=Thai}/u
const THAI_RUN = /\p{Script=Thai}+/gu

let segmenter: Intl.Segmenter | undefined
const thai = () => (segmenter ??= new Intl.Segmenter('th', { granularity: 'word' }))

/** The words of a run of Thai text ("ราคาสินค้า" → ["ราคา", "สินค้า"]); the run itself when it can't be split */
export function thaiWords(run: string): string[] {
  const out = [...thai().segment(run)].filter((s) => s.isWordLike).map((s) => s.segment)
  return out.length ? out : [run]
}

/** Each word with its Thai runs split into words; words in other scripts stay whole */
export function splitThai(words: readonly string[]): string[] {
  return words.flatMap((w) => (THAI.test(w) ? w.split(/(\p{Script=Thai}+)/u).filter(Boolean).flatMap((p) => (THAI.test(p) ? thaiWords(p) : [p])) : [w]))
}

/** How many words a text has, counting Thai words one by one rather than each spaced phrase as one */
export function wordCount(text: string): number {
  const spaced = text.split(/\s+/).filter(Boolean)
  if (!THAI.test(text)) return spaced.length
  return spaced.reduce((n, w) => n + (THAI.test(w) ? (w.replace(THAI_RUN, ' $& ').trim().split(/\s+/).flatMap((p) => (THAI.test(p) ? thaiWords(p) : [p])).length) : 1), 0)
}

/** Thai words that say nothing about what to find: particles, pronouns and question words */
export const THAI_STOP = new Set([
  'ที่', 'ของ', 'และ', 'หรือ', 'กับ', 'ใน', 'ได้', 'มี', 'เป็น', 'คือ', 'ว่า', 'จะ', 'ให้', 'ไป', 'มา', 'แล้ว', 'ก็', 'นี้', 'นั้น',
  'อะไร', 'ไหน', 'ใคร', 'เมื่อไร', 'เมื่อไหร่', 'ยังไง', 'อย่างไร', 'ทำไม', 'ไหม', 'มั้ย', 'บ้าง', 'หรือเปล่า', 'เท่าไร', 'เท่าไหร่',
  'เรา', 'ผม', 'ฉัน', 'ดิฉัน', 'คุณ', 'เขา', 'พวก', 'ครับ', 'ค่ะ', 'คะ', 'นะ', 'จ้ะ', 'จ๊ะ', 'ล่ะ', 'เลย', 'ด้วย', 'อยู่', 'ไว้', 'โดย',
  'การ', 'ความ', 'เรื่อง', 'ประชุม', 'คุย', 'พูด', 'บอก', 'ช่วย', 'หน่อย', 'ขอ',
])

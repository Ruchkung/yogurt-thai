/**
 * Thai is written without spaces between words, so splitting on spaces or punctuation gives a whole phrase as one
 * "word". These split Thai runs into words with the dictionary Intl.Segmenter carries (Electron's ICU has it), and
 * leave every other script as it was.
 */

export const THAI = /\p{Script=Thai}/u
const THAI_RUN = /\p{Script=Thai}+/gu

let segmenter: Intl.Segmenter | undefined
const thai = () => (segmenter ??= new Intl.Segmenter('th', { granularity: 'word' }))

/**
 * Words ICU's dictionary cuts in two that are one word in a meeting: compounds ("งบ|ประมาณ") and loanwords it doesn't
 * know ("เท|ส"). The pieces ICU gives are joined back when together they spell one of these.
 */
const COMPOUNDS = [
  // time
  'วันนี้', 'เมื่อวาน', 'พรุ่งนี้', 'มะรืนนี้', 'เมื่อกี้', 'ตอนนี้', 'เดี๋ยวนี้', 'สัปดาห์หน้า', 'อาทิตย์หน้า', 'เดือนหน้า', 'ปีหน้า', 'ไตรมาสหน้า',
  // work and money
  'งบประมาณ', 'การตลาด', 'การขาย', 'การเงิน', 'การประชุม', 'ที่ประชุม', 'คณะกรรมการ', 'ผู้จัดการ', 'ผู้บริหาร', 'ผู้ใช้', 'ผู้ใช้งาน',
  'ฝ่ายขาย', 'ฝ่ายบัญชี', 'ฝ่ายบุคคล', 'ทรัพยากรบุคคล', 'กำหนดการ', 'กำหนดส่ง', 'ประเด็นสำคัญ', 'ข้อสรุป', 'ข้อเสนอ', 'ข้อตกลง', 'สัญญาจ้าง',
  'ใบเสนอราคา', 'ใบแจ้งหนี้', 'ส่วนลด', 'ยอดขาย', 'รายได้', 'รายจ่าย', 'ค่าใช้จ่าย', 'กำไร', 'ขาดทุน', 'ต้นทุน', 'เป้าหมาย', 'แผนงาน',
  'นักพัฒนา', 'นักออกแบบ', 'นักลงทุน', 'ลูกค้า', 'คู่ค้า', 'พนักงาน', 'สมัครงาน',
  // loanwords
  'เทส', 'เทสต์', 'บัค', 'บั๊ก', 'ฟีเจอร์', 'โปรเจกต์', 'โปรเจค', 'เดดไลน์', 'สปรินต์', 'แอป', 'แอปพลิเคชัน', 'เว็บไซต์', 'ดีไซน์', 'ดีไซเนอร์',
  'มีตติ้ง', 'พรีเซนต์', 'อัปเดต', 'อัพเดท', 'รีวิว', 'เซิร์ฟเวอร์', 'ดาต้า', 'แดชบอร์ด', 'เวิร์กช็อป', 'สตาร์ทอัพ', 'คอนเทนต์', 'แคมเปญ',
]

/** the longest run of ICU pieces joined back into one word */
const MAX_PIECES = 6
let builtIn: Set<string> | undefined
let extraOf: () => readonly string[] = () => []
let extra: { key: string; words: Set<string> } = { key: '', words: new Set() }

/**
 * More words to keep whole: the person's own list (Settings → Language) and names. Read each time it matters, so a
 * word added in Settings counts from the next search on.
 */
export const setThaiWords = (f: () => readonly string[]): void => { extraOf = f }

function dictionary(): { has(w: string): boolean } {
  builtIn ??= new Set(COMPOUNDS)
  const list = extraOf()
  const key = list.join('\n')
  if (key !== extra.key) extra = { key, words: new Set(list.flatMap((w) => w.match(THAI_RUN) ?? [])) }
  const own = extra.words
  return { has: (w) => builtIn!.has(w) || own.has(w) }
}

/** The words of a run of Thai text ("ราคาสินค้า" → ["ราคา", "สินค้า"]); the run itself when it can't be split */
export function thaiWords(run: string): string[] {
  const pieces = [...thai().segment(run)].filter((s) => s.isWordLike).map((s) => s.segment)
  if (!pieces.length) return [run]
  const dict = dictionary()
  const out: string[] = []
  for (let i = 0; i < pieces.length;) {
    // the longest stretch of pieces from here that is one word in the dictionary, else the piece alone
    let j = Math.min(pieces.length, i + MAX_PIECES)
    while (j > i + 1 && !dict.has(pieces.slice(i, j).join(''))) j--
    out.push(pieces.slice(i, j).join(''))
    i = j
  }
  return out
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
  'การ', 'ความ', 'เรื่อง', 'ประชุม', 'การประชุม', 'ที่ประชุม', 'มีตติ้ง', 'คุย', 'พูด', 'บอก', 'ช่วย', 'หน่อย', 'ขอ',
])

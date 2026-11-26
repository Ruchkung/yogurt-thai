/**
 * The language people speak in meetings, picked in the note's footer or Settings → Language. Thai (the default in
 * this Thai-first build) and English only tell whisper and Apple's speech which language it is, so nothing is guessed; Multi-language leaves whisper to
 * hear which it is. Thai is its own choice because whisper left to guess often hears short Thai lines, or Thai mixed with
 * English words, as another language. Not the interface's language, and not the one the notes are written in.
 */
export type Spoken = 'en' | 'th' | 'multi'
export const SPOKEN: readonly Spoken[] = ['th', 'en', 'multi']
/** Thai unless English only or Multi-language was picked */
export const spokenOf = (v: unknown): Spoken => (v === 'multi' || v === 'en' ? v : 'th')
/** what whisper is told for each chunk: the one language picked, or nothing (it detects, then keeps each track's language) */
export const whisperLanguage = (s: Spoken): string | undefined => (s === 'multi' ? undefined : s)
/** how many languages whisper can hear (whisper.cpp's g_lang list less Cantonese, which large-v3 added) */
export const WHISPER_LANGUAGES = 99

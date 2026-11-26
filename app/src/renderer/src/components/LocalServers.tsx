import { useEffect, useState } from 'react'
import { t } from '../../../shared/i18n'
import type { LocalServers as Servers } from '../../../shared/localServers'
import { LoadingContent } from './LoadingContent'

type Kind = 'asr' | 'llm'
type Check = 'checking' | 'ok' | 'off' | undefined

/**
 * Settings → Local servers: a whisper-server and an OpenAI-compatible chat server (llama-server) the person already runs,
 * used instead of Yogurt's own models. Saved when the field is left; blank goes back to Yogurt's model.
 */
export function LocalServers() {
  const [saved, setSaved] = useState<Servers>()
  const [text, setText] = useState<Record<Kind, string>>({ asr: '', llm: '' })
  const [check, setCheck] = useState<Record<Kind, Check>>({ asr: undefined, llm: undefined })
  const probe = (kind: Kind, url?: string) => {
    if (!url) { setCheck((c) => ({ ...c, [kind]: undefined })); return }
    setCheck((c) => ({ ...c, [kind]: 'checking' }))
    void window.yogurt.settings.checkServer(kind, url).then((ok) => setCheck((c) => ({ ...c, [kind]: ok ? 'ok' : 'off' })))
  }
  useEffect(() => {
    void window.yogurt.settings.get().then((p) => {
      setSaved(p.localServers); setText({ asr: p.localServers.asr ?? '', llm: p.localServers.llm ?? '' })
      probe('asr', p.localServers.asr); probe('llm', p.localServers.llm)
    })
  }, [])
  const save = (kind: Kind) => {
    if (!saved || (text[kind].trim() || undefined) === saved[kind]) return
    void window.yogurt.settings.setLocalServers({ ...saved, [kind]: text[kind] }).then((kept) => {
      setSaved(kept); setText({ asr: kept.asr ?? '', llm: kept.llm ?? '' }); probe(kind, kept[kind])
    })
  }
  const row = (kind: Kind, label: string, description: string, placeholder: string) => (
    <div className="settings-row" data-testid={`local-server-${kind}`}>
      <div className="settings-row-copy">
        <label htmlFor={`local-server-${kind}-input`} className="settings-label">{label}</label>
        <p className="settings-description">{description}</p>
        {check[kind] && check[kind] !== 'checking' && <p className="settings-description" role="status">{check[kind] === 'ok' ? t('Connected') : t("Couldn't reach this server. Yogurt will keep trying it.")}</p>}
      </div>
      <input id={`local-server-${kind}-input`} data-testid={`local-server-${kind}-input`} value={text[kind]} placeholder={placeholder} autoComplete="off" spellCheck={false} dir="ltr"
        onChange={(e) => { const v = e.target.value; setText((x) => ({ ...x, [kind]: v })) }} onBlur={() => save(kind)} onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur() }}
        className="settings-name-field" />
    </div>
  )
  return (
    <>
      <h2 className="settings-section-heading">{t('Local servers')}</h2>
      <LoadingContent pending={!saved}><div data-testid="settings-local-servers" className="settings-group">
        <p className="settings-description settings-row">{t("Use AI servers already running on this computer instead of Yogurt's own models. Leave a field blank to use Yogurt's.")}</p>
        {row('asr', t('Speech server'), t('A whisper-server address, with its path if it isn’t /inference.'), 'http://127.0.0.1:8178/v1/audio/transcriptions')}
        {row('llm', t('Notes server'), t('An OpenAI-compatible server such as llama-server. It writes summaries and answers Ask.'), 'http://127.0.0.1:8081')}
      </div></LoadingContent>
    </>
  )
}

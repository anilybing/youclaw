// [XJC] 消息「朗读」按钮（通用能力对齐 · T-A2 底座，已完整实现）
// 自带门控：VOICE_ENABLED 为 false 或 TTS 未配置时不渲染。
// T-A3 子代理只需把 <TtsPlayButton text={...} /> 挂进 AssistantMessage 的 MessageActions。
import { useEffect, useRef, useState } from 'react'
import { Loader2, Square, Volume2 } from 'lucide-react'
import { speakText } from '@/api/client'
import { VOICE_ENABLED } from '@/config/features'
import { isTtsConfigured } from '@/lib/tts-status'
import { useI18n } from '@/i18n'
import { notify } from '@/stores/app-runtime'

const MAX_TTS_CHARS = 2000

export function TtsPlayButton({ text }: { text: string }) {
  const { t } = useI18n()
  const [visible, setVisible] = useState(false)
  const [state, setState] = useState<'idle' | 'loading' | 'playing'>('idle')
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const urlRef = useRef<string | null>(null)

  useEffect(() => {
    if (!VOICE_ENABLED) return
    let mounted = true
    void isTtsConfigured().then((ok) => { if (mounted) setVisible(ok) })
    return () => { mounted = false }
  }, [])

  useEffect(() => () => {
    audioRef.current?.pause()
    if (urlRef.current) URL.revokeObjectURL(urlRef.current)
  }, [])

  if (!VOICE_ENABLED || !visible || !text.trim()) return null

  const stop = () => {
    audioRef.current?.pause()
    audioRef.current = null
    if (urlRef.current) { URL.revokeObjectURL(urlRef.current); urlRef.current = null }
    setState('idle')
  }

  const play = async () => {
    if (state === 'playing') { stop(); return }
    if (state === 'loading') return
    setState('loading')
    try {
      const blob = await speakText(text.slice(0, MAX_TTS_CHARS))
      const url = URL.createObjectURL(blob)
      urlRef.current = url
      const audio = new Audio(url)
      audioRef.current = audio
      audio.onended = stop
      audio.onerror = stop
      await audio.play()
      setState('playing')
    } catch (err) {
      stop()
      notify.error(t.voice.speakFailed, { description: err instanceof Error ? err.message : undefined })
    }
  }

  const label = state === 'playing' ? t.voice.speaking : t.voice.speak

  return (
    <button
      type="button"
      onClick={() => void play()}
      title={label}
      aria-label={label}
      className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-accent/60 transition-colors"
    >
      {state === 'loading' ? <Loader2 size={14} className="animate-spin" /> : state === 'playing' ? <Square size={14} /> : <Volume2 size={14} />}
    </button>
  )
}

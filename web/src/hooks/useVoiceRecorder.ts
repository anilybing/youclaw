// [XJC] 语音输入录音 hook（通用能力对齐 · T-A2）
// getUserMedia + MediaRecorder 录音（优先 webm/opus），上限 60 秒自动停；
// 停止后把录音 Blob 交给 /api/voice/transcribe 转文字，经 onTranscript 回调交给调用方。
import { useCallback, useEffect, useRef, useState } from 'react'
import { getVoiceStatus, transcribeAudio } from '@/api/client'
import { useI18n } from '@/i18n'
import { ApiError } from '@/lib/api-error'
import { notify } from '@/stores/app'

export type VoiceRecorderState = 'idle' | 'recording' | 'transcribing'

const MAX_RECORDING_SECONDS = 60
const PREFERRED_MIME_TYPE = 'audio/webm;codecs=opus'

export interface UseVoiceRecorderResult {
  state: VoiceRecorderState
  /** 录音已进行的秒数（仅 recording 态有意义） */
  seconds: number
  start: () => Promise<void>
  stop: () => void
}

export function useVoiceRecorder(onTranscript: (text: string) => void): UseVoiceRecorderResult {
  const { t } = useI18n()
  const [state, setState] = useState<VoiceRecorderState>('idle')
  const [seconds, setSeconds] = useState(0)
  const recorderRef = useRef<MediaRecorder | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const disposedRef = useRef(false)
  const onTranscriptRef = useRef(onTranscript)
  onTranscriptRef.current = onTranscript

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      clearInterval(timerRef.current)
      timerRef.current = null
    }
  }, [])

  const releaseStream = useCallback(() => {
    streamRef.current?.getTracks().forEach((track) => track.stop())
    streamRef.current = null
  }, [])

  const stop = useCallback(() => {
    clearTimer()
    const recorder = recorderRef.current
    if (recorder && recorder.state !== 'inactive') {
      recorder.stop()
    }
  }, [clearTimer])

  const handleTranscribeError = useCallback((err: unknown) => {
    if (err instanceof ApiError && err.errorCode === 'VOICE_NOT_CONFIGURED') {
      notify.info(t.voice.notConfigured)
      return
    }
    notify.error(t.voice.transcribeFailed, {
      description: err instanceof Error ? err.message : undefined,
    })
  }, [t])

  const startingRef = useRef(false)

  const start = useCallback(async () => {
    if (startingRef.current || recorderRef.current || state !== 'idle') return
    startingRef.current = true
    try {
      await beginRecording()
    } finally {
      startingRef.current = false
    }

    async function beginRecording() {
      // 未配置时先引导去设置，避免让用户白说一段话；状态探测失败（如 sidecar 短暂不可达）不拦录音，
      // 转写阶段自会报错。
      try {
        const status = await getVoiceStatus()
        if (!status.asrConfigured) {
          notify.info(t.voice.notConfigured)
          return
        }
      } catch {
        // ignore: 交给 transcribe 阶段报错
      }

      let stream: MediaStream
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      } catch (err) {
        if (err instanceof DOMException && err.name === 'NotAllowedError') {
          notify.error(t.voice.micDenied)
        } else {
          notify.error(t.voice.transcribeFailed, {
            description: err instanceof Error ? err.message : undefined,
          })
        }
        return
      }
      if (disposedRef.current) {
        stream.getTracks().forEach((track) => track.stop())
        return
      }
      streamRef.current = stream

      const options = typeof MediaRecorder.isTypeSupported === 'function'
        && MediaRecorder.isTypeSupported(PREFERRED_MIME_TYPE)
        ? { mimeType: PREFERRED_MIME_TYPE }
        : undefined
      const recorder = new MediaRecorder(stream, options)
      recorderRef.current = recorder
      const chunks: Blob[] = []

      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunks.push(event.data)
      }

      recorder.onstop = async () => {
        recorderRef.current = null
        clearTimer()
        releaseStream()
        if (disposedRef.current) return

        const blob = new Blob(chunks, { type: recorder.mimeType || 'audio/webm' })
        if (blob.size === 0) {
          setState('idle')
          return
        }

        setState('transcribing')
        try {
          const { text } = await transcribeAudio(blob, 'recording.webm')
          if (!disposedRef.current && text.trim()) {
            onTranscriptRef.current(text)
          }
        } catch (err) {
          if (!disposedRef.current) handleTranscribeError(err)
        } finally {
          if (!disposedRef.current) setState('idle')
        }
      }

      recorder.onerror = () => {
        recorderRef.current = null
        clearTimer()
        releaseStream()
        if (disposedRef.current) return
        setState('idle')
        notify.error(t.voice.transcribeFailed)
      }

      recorder.start()
      setState('recording')
      setSeconds(0)
      const startedAt = Date.now()
      timerRef.current = setInterval(() => {
        const elapsed = Math.floor((Date.now() - startedAt) / 1000)
        setSeconds(elapsed)
        if (elapsed >= MAX_RECORDING_SECONDS) {
          stop()
        }
      }, 500)
    }
  }, [state, t, clearTimer, releaseStream, stop, handleTranscribeError])

  useEffect(() => () => {
    disposedRef.current = true
    clearTimer()
    const recorder = recorderRef.current
    if (recorder && recorder.state !== 'inactive') {
      recorder.stop()
    }
    recorderRef.current = null
    streamRef.current?.getTracks().forEach((track) => track.stop())
    streamRef.current = null
  }, [clearTimer])

  return { state, seconds, start, stop }
}

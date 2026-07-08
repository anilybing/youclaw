// [XJC] 设置 → 语音 面板（通用能力对齐 · T-A2）
// ASR/TTS 两组 OpenAI 兼容服务配置（provider/baseUrl/apiKey/model(/voice)）。
// apiKey 回显后端 ****打码值，用户不改则原样传回（后端 PATCH 已处理保留原 key）。
// placeholder 里的硅基流动示例仅为文案提示，禁止把任何厂商域名写进逻辑（离线红线）。
import { useEffect, useRef, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import {
  getSettings,
  getVoiceStatus,
  speakText,
  updateSettings,
  type VoiceEndpointConfigDTO,
  type VoiceSettingsDTO,
} from '@/api/client'
import { ApiError } from '@/lib/api-error'
import { useI18n } from '@/i18n'
import { notify } from '@/stores/app'
import { invalidateTtsStatusCache } from '@/lib/tts-status'

type VoiceProvider = VoiceEndpointConfigDTO['provider']
type AsrForm = VoiceEndpointConfigDTO
type TtsForm = VoiceSettingsDTO['tts']

const EMPTY_ASR: AsrForm = { provider: 'off', baseUrl: '', apiKey: '', model: '' }
const EMPTY_TTS: TtsForm = { provider: 'off', baseUrl: '', apiKey: '', model: '', voice: '' }

/** TTS 测试播报文案（小橘为本产品自有昵称） */
const TTS_TEST_TEXT = '你好，我是小橘'

export function VoicePanel() {
  const { t } = useI18n()
  const [asr, setAsr] = useState<AsrForm>(EMPTY_ASR)
  const [tts, setTts] = useState<TtsForm>(EMPTY_TTS)
  const [loaded, setLoaded] = useState(false)
  const [saving, setSaving] = useState(false)
  const [testingAsr, setTestingAsr] = useState(false)
  const [testingTts, setTestingTts] = useState(false)
  const testAudioRef = useRef<HTMLAudioElement | null>(null)

  useEffect(() => {
    let mounted = true
    getSettings()
      .then((settings) => {
        if (!mounted) return
        setAsr(settings.voice.asr)
        setTts(settings.voice.tts)
        setLoaded(true)
      })
      .catch(() => { if (mounted) setLoaded(true) })
    return () => { mounted = false }
  }, [])

  useEffect(() => () => {
    testAudioRef.current?.pause()
    testAudioRef.current = null
  }, [])

  const handleSave = async () => {
    setSaving(true)
    try {
      const updated = await updateSettings({ voice: { asr, tts } })
      setAsr(updated.voice.asr)
      setTts(updated.voice.tts)
      invalidateTtsStatusCache()
      notify.success(t.voice.saved)
    } catch (err) {
      notify.error(t.voice.saveFailed, {
        description: err instanceof Error ? err.message : undefined,
      })
    } finally {
      setSaving(false)
    }
  }

  const handleTestAsr = async () => {
    setTestingAsr(true)
    try {
      const status = await getVoiceStatus()
      if (status.asrConfigured) {
        notify.success(t.voice.testAsrOk)
      } else {
        notify.info(t.voice.notConfigured)
      }
    } catch (err) {
      notify.error(t.voice.testFailed, {
        description: err instanceof Error ? err.message : undefined,
      })
    } finally {
      setTestingAsr(false)
    }
  }

  const handleTestTts = async () => {
    setTestingTts(true)
    try {
      const blob = await speakText(TTS_TEST_TEXT)
      const url = URL.createObjectURL(blob)
      const audio = new Audio(url)
      testAudioRef.current = audio
      const release = () => URL.revokeObjectURL(url)
      audio.onended = release
      audio.onerror = release
      await audio.play()
      notify.success(t.voice.testTtsOk)
    } catch (err) {
      if (err instanceof ApiError && err.errorCode === 'VOICE_NOT_CONFIGURED') {
        notify.info(t.voice.notConfigured)
      } else {
        notify.error(t.voice.testFailed, {
          description: err instanceof Error ? err.message : undefined,
        })
      }
    } finally {
      setTestingTts(false)
    }
  }

  if (!loaded) {
    return (
      <div className="h-full flex items-center justify-center">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    )
  }

  return (
    <div className="space-y-8">
      <p className="text-xs text-muted-foreground">{t.voice.settingsSubtitle}</p>

      {/* ASR 语音识别 */}
      <div>
        <div className="flex items-center justify-between mb-4">
          <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-widest">
            {t.voice.asrSection}
          </h4>
          <Button
            variant="outline"
            size="sm"
            className="h-7 rounded-lg text-xs"
            onClick={handleTestAsr}
            disabled={testingAsr}
          >
            {testingAsr ? t.voice.testing : t.voice.test}
          </Button>
        </div>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label>{t.voice.provider}</Label>
            <Select
              value={asr.provider}
              onValueChange={(value) => setAsr((prev) => ({ ...prev, provider: value as VoiceProvider }))}
            >
              <SelectTrigger className="rounded-xl">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="off">{t.voice.providerOff}</SelectItem>
                <SelectItem value="openai-compatible">{t.voice.providerOpenAICompatible}</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label>{t.voice.baseUrl}</Label>
            <Input
              value={asr.baseUrl}
              onChange={(e) => setAsr((prev) => ({ ...prev, baseUrl: e.target.value }))}
              placeholder="https://api.siliconflow.cn/v1"
              disabled={asr.provider === 'off'}
              className="rounded-xl"
            />
          </div>
          <div className="space-y-1.5">
            <Label>{t.voice.apiKey}</Label>
            <Input
              type="password"
              value={asr.apiKey}
              onChange={(e) => setAsr((prev) => ({ ...prev, apiKey: e.target.value }))}
              placeholder="sk-..."
              disabled={asr.provider === 'off'}
              className="rounded-xl"
            />
          </div>
          <div className="space-y-1.5">
            <Label>{t.voice.model}</Label>
            <Input
              value={asr.model}
              onChange={(e) => setAsr((prev) => ({ ...prev, model: e.target.value }))}
              placeholder="FunAudioLLM/SenseVoiceSmall"
              disabled={asr.provider === 'off'}
              className="rounded-xl"
            />
          </div>
        </div>
      </div>

      {/* TTS 语音合成 */}
      <div>
        <div className="flex items-center justify-between mb-4">
          <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-widest">
            {t.voice.ttsSection}
          </h4>
          <Button
            variant="outline"
            size="sm"
            className="h-7 rounded-lg text-xs"
            onClick={handleTestTts}
            disabled={testingTts}
          >
            {testingTts ? t.voice.testing : t.voice.test}
          </Button>
        </div>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label>{t.voice.provider}</Label>
            <Select
              value={tts.provider}
              onValueChange={(value) => setTts((prev) => ({ ...prev, provider: value as VoiceProvider }))}
            >
              <SelectTrigger className="rounded-xl">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="off">{t.voice.providerOff}</SelectItem>
                <SelectItem value="openai-compatible">{t.voice.providerOpenAICompatible}</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label>{t.voice.baseUrl}</Label>
            <Input
              value={tts.baseUrl}
              onChange={(e) => setTts((prev) => ({ ...prev, baseUrl: e.target.value }))}
              placeholder="https://api.siliconflow.cn/v1"
              disabled={tts.provider === 'off'}
              className="rounded-xl"
            />
          </div>
          <div className="space-y-1.5">
            <Label>{t.voice.apiKey}</Label>
            <Input
              type="password"
              value={tts.apiKey}
              onChange={(e) => setTts((prev) => ({ ...prev, apiKey: e.target.value }))}
              placeholder="sk-..."
              disabled={tts.provider === 'off'}
              className="rounded-xl"
            />
          </div>
          <div className="space-y-1.5">
            <Label>{t.voice.model}</Label>
            <Input
              value={tts.model}
              onChange={(e) => setTts((prev) => ({ ...prev, model: e.target.value }))}
              placeholder="FunAudioLLM/CosyVoice2-0.5B"
              disabled={tts.provider === 'off'}
              className="rounded-xl"
            />
          </div>
          <div className="space-y-1.5">
            <Label>{t.voice.ttsVoice}</Label>
            <Input
              value={tts.voice}
              onChange={(e) => setTts((prev) => ({ ...prev, voice: e.target.value }))}
              placeholder="FunAudioLLM/CosyVoice2-0.5B:alex"
              disabled={tts.provider === 'off'}
              className="rounded-xl"
            />
          </div>
        </div>
      </div>

      <div className="flex justify-end">
        <Button onClick={handleSave} disabled={saving} className="rounded-xl">
          {saving ? <Loader2 className="mr-1 size-4 animate-spin" /> : null}
          {t.common.save}
        </Button>
      </div>
    </div>
  )
}

// [XJC] 设置 → 语音与媒体 面板（T-A2 语音 + T-B7 媒体生成）
// 顶部「服务商快速配置」：一次填 baseUrl+key，勾选能力一键分发到 ASR/TTS/图像/视频四组
// （已有凭据可复用——打码 key 由后端还原明文，前端不接触明文）。
// 四组能力底层独立存储，可分别展开覆盖（混搭不同厂商）。
// apiKey 回显 ****打码值，用户不改则原样传回（后端保留原 key）。
// placeholder 与推荐模型名仅为文案/默认值，禁止把厂商域名写进逻辑（离线红线）。
import { useEffect, useRef, useState } from 'react'
import { Loader2, Zap } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import {
  applyMediaProvider,
  getMediaStatus,
  getSettings,
  getVoiceStatus,
  speakText,
  updateSettings,
  type MediaSettingsDTO,
  type VoiceEndpointConfigDTO,
  type VoiceSettingsDTO,
} from '@/api/client'
import { ApiError } from '@/lib/api-error'
import { useI18n } from '@/i18n'
import { notify } from '@/stores/app'
import { invalidateTtsStatusCache } from '@/lib/tts-status'
import { cn } from '@/lib/utils'

type VoiceProvider = VoiceEndpointConfigDTO['provider']
type AsrForm = VoiceEndpointConfigDTO
type TtsForm = VoiceSettingsDTO['tts']
type ImageForm = MediaSettingsDTO['image']
type VideoForm = MediaSettingsDTO['video']
type Capability = 'asr' | 'tts' | 'image' | 'video'

const EMPTY_ASR: AsrForm = { provider: 'off', baseUrl: '', apiKey: '', model: '' }
const EMPTY_TTS: TtsForm = { provider: 'off', baseUrl: '', apiKey: '', model: '', voice: '' }
const EMPTY_IMAGE: ImageForm = { provider: 'off', baseUrl: '', apiKey: '', model: '', editModel: '' }
const EMPTY_VIDEO: VideoForm = { provider: 'off', baseUrl: '', apiKey: '', model: '' }

/** TTS 测试播报文案（小橘为本产品自有昵称） */
const TTS_TEST_TEXT = '你好，我是小橘'

// 一键应用时写入的推荐模型默认值（用户可见、可改；仅作为默认值传给后端，不进判断逻辑）
const RECOMMENDED_MODELS: Record<Capability, string> = {
  asr: 'FunAudioLLM/SenseVoiceSmall',
  tts: 'FunAudioLLM/CosyVoice2-0.5B',
  image: 'Qwen/Qwen-Image',
  video: 'Wan-AI/Wan2.2-T2V-A14B',
}
const RECOMMENDED_TTS_VOICE = 'FunAudioLLM/CosyVoice2-0.5B:alex'
const RECOMMENDED_EDIT_MODEL = 'Qwen/Qwen-Image-Edit-2509'

type ImageProviderStyle = 'openai-compatible' | 'dashscope'
type QuickPresetId = 'siliconflow' | 'dashscope' | 'custom'

// 服务商预设（仅 UI 默认值：baseUrl/模型名可见可改，禁止写进后端判断逻辑——离线红线）。
// 硅基流动：四项能力都走 OpenAI 兼容，国产模型（Qwen-Image / 万相 / SenseVoice / CosyVoice）。
// 阿里百炼：图像走原生 multimodal-generation（qwen-image / 通义万相），语音/视频此预设不覆盖。
interface QuickPreset {
  baseUrl: string
  imageProviderStyle: ImageProviderStyle
  caps: Capability[]
  models: Partial<Record<Capability, string>>
  ttsVoice?: string
  imageEditModel?: string
}
const QUICK_PRESETS: Record<Exclude<QuickPresetId, 'custom'>, QuickPreset> = {
  siliconflow: {
    baseUrl: 'https://api.siliconflow.cn/v1',
    imageProviderStyle: 'openai-compatible',
    caps: ['asr', 'tts', 'image', 'video'],
    models: RECOMMENDED_MODELS,
    ttsVoice: RECOMMENDED_TTS_VOICE,
    imageEditModel: RECOMMENDED_EDIT_MODEL,
  },
  dashscope: {
    baseUrl: 'https://dashscope.aliyuncs.com/api/v1',
    imageProviderStyle: 'dashscope',
    caps: ['image'],
    models: { image: 'qwen-image-2.0-pro' },
    imageEditModel: 'qwen-image-edit-plus',
  },
}

export function VoicePanel() {
  const { t } = useI18n()
  const [asr, setAsr] = useState<AsrForm>(EMPTY_ASR)
  const [tts, setTts] = useState<TtsForm>(EMPTY_TTS)
  const [image, setImage] = useState<ImageForm>(EMPTY_IMAGE)
  const [video, setVideo] = useState<VideoForm>(EMPTY_VIDEO)
  const [loaded, setLoaded] = useState(false)
  const [saving, setSaving] = useState(false)
  const [testingAsr, setTestingAsr] = useState(false)
  const [testingTts, setTestingTts] = useState(false)
  const [testingMedia, setTestingMedia] = useState(false)
  const testAudioRef = useRef<HTMLAudioElement | null>(null)

  // 服务商快速配置块
  const [quickPreset, setQuickPreset] = useState<QuickPresetId>('siliconflow')
  const [quickBaseUrl, setQuickBaseUrl] = useState('')
  const [quickApiKey, setQuickApiKey] = useState('')
  const [quickCaps, setQuickCaps] = useState<Record<Capability, boolean>>({ asr: true, tts: true, image: true, video: true })
  const [applying, setApplying] = useState(false)
  const [hasReusableKey, setHasReusableKey] = useState(false)

  const handlePresetChange = (preset: QuickPresetId) => {
    setQuickPreset(preset)
    if (preset === 'custom') return
    const def = QUICK_PRESETS[preset]
    setQuickBaseUrl(def.baseUrl)
    setQuickCaps({
      asr: def.caps.includes('asr'),
      tts: def.caps.includes('tts'),
      image: def.caps.includes('image'),
      video: def.caps.includes('video'),
    })
  }

  const applyLoadedSettings = (settings: { voice: VoiceSettingsDTO; media: MediaSettingsDTO }) => {
    setAsr(settings.voice.asr)
    setTts(settings.voice.tts)
    setImage(settings.media.image)
    setVideo(settings.media.video)
    // 检测可复用凭据：任一组已配置（打码 key 非空）即可复用，预填其 baseUrl
    const groups = [settings.voice.asr, settings.voice.tts, settings.media.image, settings.media.video]
    const configured = groups.find((g) => g.apiKey && g.baseUrl)
    setHasReusableKey(!!configured)
    // 已配置 dashscope 图像组则默认选中阿里百炼预设，避免二次一键把图像切回 OpenAI 兼容
    if (settings.media.image.provider === 'dashscope') setQuickPreset('dashscope')
    if (configured) {
      if (!quickBaseUrl) setQuickBaseUrl(configured.baseUrl)
    } else if (!quickBaseUrl) {
      setQuickBaseUrl(QUICK_PRESETS.siliconflow.baseUrl)
    }
  }

  useEffect(() => {
    let mounted = true
    getSettings()
      .then((settings) => {
        if (!mounted) return
        applyLoadedSettings(settings)
        setLoaded(true)
      })
      .catch(() => { if (mounted) setLoaded(true) })
    return () => { mounted = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => () => {
    testAudioRef.current?.pause()
    testAudioRef.current = null
  }, [])

  const handleApplyProvider = async () => {
    const capabilities = (Object.keys(quickCaps) as Capability[]).filter((c) => quickCaps[c])
    if (!quickBaseUrl.trim() || capabilities.length === 0) return
    // 预设决定图像组服务风格与默认模型名；自定义时按 OpenAI 兼容 + 硅基流动默认模型
    const preset = quickPreset === 'custom' ? null : QUICK_PRESETS[quickPreset]
    setApplying(true)
    try {
      await applyMediaProvider({
        baseUrl: quickBaseUrl.trim(),
        apiKey: quickApiKey.trim() || undefined, // 留空 = 复用已有明文 key（后端处理）
        capabilities,
        models: preset?.models ?? RECOMMENDED_MODELS,
        ttsVoice: preset?.ttsVoice ?? RECOMMENDED_TTS_VOICE,
        imageEditModel: preset?.imageEditModel ?? RECOMMENDED_EDIT_MODEL,
        imageProviderStyle: preset?.imageProviderStyle ?? 'openai-compatible',
      })
      const settings = await getSettings()
      applyLoadedSettings(settings)
      setQuickApiKey('')
      invalidateTtsStatusCache()
      notify.success(t.media.applied)
    } catch (err) {
      if (err instanceof ApiError && err.errorCode === 'NO_REUSABLE_KEY') {
        notify.info(t.media.needApiKey)
      } else {
        notify.error(t.media.applyFailed, { description: err instanceof Error ? err.message : undefined })
      }
    } finally {
      setApplying(false)
    }
  }

  const handleSave = async () => {
    setSaving(true)
    try {
      const updated = await updateSettings({ voice: { asr, tts }, media: { image, video } })
      applyLoadedSettings(updated)
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
      if (status.asrConfigured) notify.success(t.voice.testAsrOk)
      else notify.info(t.voice.notConfigured)
    } catch (err) {
      notify.error(t.voice.testFailed, { description: err instanceof Error ? err.message : undefined })
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
        notify.error(t.voice.testFailed, { description: err instanceof Error ? err.message : undefined })
      }
    } finally {
      setTestingTts(false)
    }
  }

  // 媒体测试只做配置完整性检查（真实生图/视频会产生 API 费用，由 agent 按需调用）
  const handleTestMedia = async () => {
    setTestingMedia(true)
    try {
      const status = await getMediaStatus()
      const parts = [
        `${t.media.imageSection}: ${status.imageConfigured ? '✓' : '✗'}`,
        `${t.media.editModel}: ${status.imageEditConfigured ? '✓' : '✗'}`,
        `${t.media.videoSection}: ${status.videoConfigured ? '✓' : '✗'}`,
      ]
      notify.info(t.media.statusResult, { description: parts.join(' · ') })
    } catch (err) {
      notify.error(t.voice.testFailed, { description: err instanceof Error ? err.message : undefined })
    } finally {
      setTestingMedia(false)
    }
  }

  if (!loaded) {
    return (
      <div className="h-full flex items-center justify-center">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    )
  }

  const providerField = (value: VoiceProvider, onChange: (v: VoiceProvider) => void) => (
    <div className="space-y-1.5">
      <Label>{t.voice.provider}</Label>
      <Select value={value} onValueChange={(v) => onChange(v as VoiceProvider)}>
        <SelectTrigger className="rounded-xl">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="off">{t.voice.providerOff}</SelectItem>
          <SelectItem value="openai-compatible">{t.voice.providerOpenAICompatible}</SelectItem>
        </SelectContent>
      </Select>
    </div>
  )

  // 图像组独有：额外提供「阿里百炼原生」选项（dashscope）
  const imageProviderField = (value: ImageForm['provider'], onChange: (v: ImageForm['provider']) => void) => (
    <div className="space-y-1.5">
      <Label>{t.voice.provider}</Label>
      <Select value={value} onValueChange={(v) => onChange(v as ImageForm['provider'])}>
        <SelectTrigger className="rounded-xl">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="off">{t.voice.providerOff}</SelectItem>
          <SelectItem value="openai-compatible">{t.voice.providerOpenAICompatible}</SelectItem>
          <SelectItem value="dashscope">{t.media.providerDashscope}</SelectItem>
        </SelectContent>
      </Select>
    </div>
  )

  const textField = (label: string, value: string, onChange: (v: string) => void, placeholder: string, disabled: boolean, password = false) => (
    <div className="space-y-1.5">
      <Label>{label}</Label>
      <Input
        type={password ? 'password' : 'text'}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        disabled={disabled}
        className="rounded-xl"
      />
    </div>
  )

  const capLabels: Record<Capability, string> = {
    asr: t.voice.asrSection,
    tts: t.voice.ttsSection,
    image: t.media.imageSection,
    video: t.media.videoSection,
  }

  return (
    <div className="space-y-8">
      <p className="text-xs text-muted-foreground">{t.voice.settingsSubtitle}</p>

      {/* 服务商快速配置：一次填写，按能力分发 */}
      <div className="rounded-2xl border-2 border-primary/30 bg-primary/5 p-4 space-y-4">
        <div className="flex items-center gap-2">
          <Zap size={14} className="text-primary shrink-0" />
          <h4 className="text-xs font-semibold uppercase tracking-widest">{t.media.quickTitle}</h4>
        </div>
        <p className="text-xs text-muted-foreground">{t.media.quickDesc}</p>
        <div className="space-y-1.5">
          <Label>{t.media.presetLabel}</Label>
          <Select value={quickPreset} onValueChange={(v) => handlePresetChange(v as QuickPresetId)}>
            <SelectTrigger className="rounded-xl">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="siliconflow">{t.media.presetSiliconflow}</SelectItem>
              <SelectItem value="dashscope">{t.media.presetDashscope}</SelectItem>
              <SelectItem value="custom">{t.media.presetCustom}</SelectItem>
            </SelectContent>
          </Select>
          {quickPreset === 'dashscope' && (
            <p className="text-[11px] text-muted-foreground">{t.media.presetDashscopeHint}</p>
          )}
        </div>
        {textField(t.voice.baseUrl, quickBaseUrl, setQuickBaseUrl, 'https://api.siliconflow.cn/v1', false)}
        {textField(t.voice.apiKey, quickApiKey, setQuickApiKey, hasReusableKey ? t.media.reuseKeyPlaceholder : 'sk-...', false, true)}
        <div className="flex flex-wrap gap-3">
          {(Object.keys(capLabels) as Capability[]).map((cap) => {
            // 阿里百炼预设仅原生支持图像组，其余能力禁用勾选避免误配
            const capDisabled = quickPreset === 'dashscope' && cap !== 'image'
            return (
              <label
                key={cap}
                className={cn(
                  'flex items-center gap-1.5 text-xs select-none',
                  capDisabled ? 'opacity-40 cursor-not-allowed' : 'cursor-pointer',
                )}
              >
                <input
                  type="checkbox"
                  checked={quickCaps[cap] && !capDisabled}
                  disabled={capDisabled}
                  onChange={(e) => setQuickCaps((prev) => ({ ...prev, [cap]: e.target.checked }))}
                  className="accent-[var(--primary)]"
                />
                {capLabels[cap]}
              </label>
            )
          })}
        </div>
        <div className="flex items-center justify-between gap-3">
          <p className="text-[11px] text-muted-foreground">{t.media.quickModelsNote}</p>
          <Button
            size="sm"
            className="rounded-xl shrink-0"
            onClick={handleApplyProvider}
            disabled={applying || !quickBaseUrl.trim()}
          >
            {applying ? <Loader2 className="mr-1 size-4 animate-spin" /> : null}
            {t.media.apply}
          </Button>
        </div>
      </div>

      {/* ASR 语音识别 */}
      <div>
        <div className="flex items-center justify-between mb-4">
          <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-widest">
            {t.voice.asrSection}
          </h4>
          <Button variant="outline" size="sm" className="h-7 rounded-lg text-xs" onClick={handleTestAsr} disabled={testingAsr}>
            {testingAsr ? t.voice.testing : t.voice.test}
          </Button>
        </div>
        <div className="space-y-4">
          {providerField(asr.provider, (v) => setAsr((prev) => ({ ...prev, provider: v })))}
          {textField(t.voice.baseUrl, asr.baseUrl, (v) => setAsr((p) => ({ ...p, baseUrl: v })), 'https://api.siliconflow.cn/v1', asr.provider === 'off')}
          {textField(t.voice.apiKey, asr.apiKey, (v) => setAsr((p) => ({ ...p, apiKey: v })), 'sk-...', asr.provider === 'off', true)}
          {textField(t.voice.model, asr.model, (v) => setAsr((p) => ({ ...p, model: v })), 'FunAudioLLM/SenseVoiceSmall', asr.provider === 'off')}
        </div>
      </div>

      {/* TTS 语音合成 */}
      <div>
        <div className="flex items-center justify-between mb-4">
          <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-widest">
            {t.voice.ttsSection}
          </h4>
          <Button variant="outline" size="sm" className="h-7 rounded-lg text-xs" onClick={handleTestTts} disabled={testingTts}>
            {testingTts ? t.voice.testing : t.voice.test}
          </Button>
        </div>
        <div className="space-y-4">
          {providerField(tts.provider, (v) => setTts((prev) => ({ ...prev, provider: v })))}
          {textField(t.voice.baseUrl, tts.baseUrl, (v) => setTts((p) => ({ ...p, baseUrl: v })), 'https://api.siliconflow.cn/v1', tts.provider === 'off')}
          {textField(t.voice.apiKey, tts.apiKey, (v) => setTts((p) => ({ ...p, apiKey: v })), 'sk-...', tts.provider === 'off', true)}
          {textField(t.voice.model, tts.model, (v) => setTts((p) => ({ ...p, model: v })), 'FunAudioLLM/CosyVoice2-0.5B', tts.provider === 'off')}
          {textField(t.voice.ttsVoice, tts.voice, (v) => setTts((p) => ({ ...p, voice: v })), 'FunAudioLLM/CosyVoice2-0.5B:alex', tts.provider === 'off')}
        </div>
      </div>

      {/* 图像生成 / 改图 */}
      <div>
        <div className="flex items-center justify-between mb-4">
          <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-widest">
            {t.media.imageSection}
          </h4>
          <Button variant="outline" size="sm" className="h-7 rounded-lg text-xs" onClick={handleTestMedia} disabled={testingMedia}>
            {testingMedia ? t.voice.testing : t.voice.test}
          </Button>
        </div>
        <div className="space-y-4">
          {imageProviderField(image.provider, (v) => setImage((prev) => ({ ...prev, provider: v })))}
          {textField(t.voice.baseUrl, image.baseUrl, (v) => setImage((p) => ({ ...p, baseUrl: v })), image.provider === 'dashscope' ? 'https://dashscope.aliyuncs.com/api/v1' : 'https://api.siliconflow.cn/v1', image.provider === 'off')}
          {textField(t.voice.apiKey, image.apiKey, (v) => setImage((p) => ({ ...p, apiKey: v })), 'sk-...', image.provider === 'off', true)}
          {textField(t.media.imageModel, image.model, (v) => setImage((p) => ({ ...p, model: v })), image.provider === 'dashscope' ? 'qwen-image-2.0-pro' : 'Qwen/Qwen-Image', image.provider === 'off')}
          {textField(t.media.editModel, image.editModel, (v) => setImage((p) => ({ ...p, editModel: v })), image.provider === 'dashscope' ? 'qwen-image-edit-plus' : 'Qwen/Qwen-Image-Edit-2509', image.provider === 'off')}
        </div>
      </div>

      {/* 视频生成 */}
      <div>
        <div className="flex items-center justify-between mb-4">
          <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-widest">
            {t.media.videoSection}
          </h4>
        </div>
        <div className="space-y-4">
          {providerField(video.provider, (v) => setVideo((prev) => ({ ...prev, provider: v })))}
          {textField(t.voice.baseUrl, video.baseUrl, (v) => setVideo((p) => ({ ...p, baseUrl: v })), 'https://api.siliconflow.cn/v1', video.provider === 'off')}
          {textField(t.voice.apiKey, video.apiKey, (v) => setVideo((p) => ({ ...p, apiKey: v })), 'sk-...', video.provider === 'off', true)}
          {textField(t.media.videoModel, video.model, (v) => setVideo((p) => ({ ...p, model: v })), 'Wan-AI/Wan2.2-T2V-A14B', video.provider === 'off')}
          <p className="text-[11px] text-muted-foreground">{t.media.costNote}</p>
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

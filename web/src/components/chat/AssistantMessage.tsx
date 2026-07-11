// [XJC-PATCH] modified from upstream v0.0.178 — 详见 doc/侵入点清单.md
import { useState } from 'react'
import { Copy, Check, Coins, RotateCcw, ThumbsUp, ThumbsDown } from 'lucide-react'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import {
  Message as AIMessage,
  MessageContent,
  MessageResponse,
  MessageActions,
  MessageAction,
} from '@/components/ai-elements/message'
import { ToolUseBlock } from './ToolUseBlock'
import { TtsPlayButton } from './TtsPlayButton'
import {
  Attachments,
  Attachment,
  AttachmentPreview,
  AttachmentInfo,
} from '@/components/ai-elements/attachments'
import { localAssetUrl } from '@/api/transport'
import { useI18n } from '@/i18n'
import { useAppRuntimeStore } from '@/stores/app'
import { notify } from '@/stores/app'
import { useChatContext } from '@/hooks/chatCtx'
import { useChatActions } from '@/hooks/useChat'
import type { Message } from '@/hooks/useChat'
import { submitMessageFeedback } from '@/api/client'

function InsufficientCreditsMessage() {
  const { t } = useI18n()
  const { openPayPage, creditBalance } = useAppRuntimeStore()

  return (
    <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 text-sm">
      <Coins size={18} className="text-amber-500 mt-0.5 shrink-0" />
      <div className="space-y-1">
        <p className="text-foreground">{t.insufficientCredits.description}</p>
        {creditBalance != null && (
          <p className="text-muted-foreground text-xs">{t.insufficientCredits.currentBalance}{creditBalance.toLocaleString()}</p>
        )}
        <button
          onClick={() => openPayPage()}
          className="inline-flex items-center gap-1 text-primary hover:underline font-medium cursor-pointer"
        >
          {t.insufficientCredits.topUp} →
        </button>
      </div>
    </div>
  )
}

// [XJC] T-A3：isLast = 是否最后一条 assistant 消息（由 ChatMessages 计算传入），控制「重新生成」按钮显隐
export function AssistantMessage({ message, isLast = false }: { message: Message; isLast?: boolean }) {
  const { t } = useI18n()
  const { agentId, currentChatAgentId, chatId, isProcessing } = useChatContext()
  const { regenerate } = useChatActions(agentId)
  const [copied, setCopied] = useState(false)
  // [XJC] 用户反馈信号：null=未评 / 'up' / 'down'（乐观置位，失败回滚）
  const [feedback, setFeedback] = useState<'up' | 'down' | null>(null)
  // [XJC] 点踩后可选填原因（教训会注入该员工后续对话，见 src/feedback/lessons.ts）
  const [reasonOpen, setReasonOpen] = useState(false)
  const [reason, setReason] = useState('')
  const timestamp = new Date(message.timestamp).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  })

  const handleCopy = async () => {
    await navigator.clipboard.writeText(message.content)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  const handleFeedback = async (rating: 'up' | 'down') => {
    if (!chatId) return
    const next = feedback === rating ? null : rating // 再次点击取消（本地）
    setFeedback(next)
    if (next !== 'down') setReasonOpen(false)
    if (!next) return // 取消评价不回传（保持简单：只上报有效评价）
    try {
      await submitMessageFeedback({
        chatId,
        messageId: message.id,
        agentId: currentChatAgentId ?? agentId ?? undefined,
        rating: next,
      })
      if (next === 'down') {
        setReasonOpen(true) // 邀请补充原因（可选），教训会影响该员工后续回答
      } else {
        notify.success(t.chat.feedbackThanksUp)
      }
    } catch {
      setFeedback(feedback) // 回滚
      setReasonOpen(false)
      notify.error(t.chat.feedbackFailed)
    }
  }

  const handleSubmitReason = async () => {
    const trimmed = reason.trim()
    if (!chatId || !trimmed) {
      setReasonOpen(false)
      return
    }
    try {
      // 同键 upsert：保持 rating=down，补写 comment
      await submitMessageFeedback({
        chatId,
        messageId: message.id,
        agentId: currentChatAgentId ?? agentId ?? undefined,
        rating: 'down',
        comment: trimmed,
      })
      setReasonOpen(false)
      setReason('')
      notify.success(t.chat.feedbackReasonThanks)
    } catch {
      notify.error(t.chat.feedbackFailed)
    }
  }

  const attachments = message.attachments ?? []
  const isInsufficientCredits = message.errorCode === 'INSUFFICIENT_CREDITS'

  return (
    <AIMessage from="assistant" data-testid="message-assistant">
      <div className="group flex gap-3 py-3">
        <Avatar className="h-8 w-8">
          <AvatarImage src="/icon.svg" alt="XiaoJuClaw" />

          <AvatarFallback className="bg-gradient-to-br from-violet-500/20 to-purple-500/20 text-[10px] font-semibold">
            AI
          </AvatarFallback>
        </Avatar>
        <div className="flex-1 min-w-0">
          <div className="relative">
            <div className="pointer-events-none absolute bottom-full left-0 mb-1 text-xs font-medium text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
              {t.chat.assistant}
              <span className="ml-2 text-[10px] opacity-60">{timestamp}</span>
            </div>
            {message.toolUse && message.toolUse.length > 0 && (
              <ToolUseBlock items={message.toolUse} />
            )}
            <div className="relative">
              {isInsufficientCredits ? (
                <InsufficientCreditsMessage />
              ) : (
                <>
                  <MessageContent>
                    <MessageResponse className="chat-prose">{message.content}</MessageResponse>
                  </MessageContent>
                  {attachments.length > 0 && (
                    <Attachments variant="grid" className="mt-2 ml-0">
                      {attachments.map((a, i) => (
                        <Attachment
                          key={i}
                          data={{
                            id: String(i),
                            type: 'file' as const,
                            filename: a.filename,
                            mediaType: a.mediaType,
                            url: a.filePath ? localAssetUrl(a.filePath) : '',
                            filePath: a.filePath,
                          }}
                        >
                          <AttachmentPreview />
                          <AttachmentInfo />
                        </Attachment>
                      ))}
                    </Attachments>
                  )}
                  <MessageActions className="mt-1 opacity-0 group-hover:opacity-100 transition-opacity">
                    <MessageAction
                      tooltip={copied ? t.chat.copied : t.chat.copyCode}
                      onClick={handleCopy}
                    >
                      {copied ? <Check className="h-3.5 w-3.5 text-green-500" /> : <Copy className="h-3.5 w-3.5" />}
                    </MessageAction>
                    {isLast && (
                      <MessageAction
                        tooltip={t.chat.regenerate}
                        onClick={() => void regenerate()}
                        disabled={isProcessing}
                      >
                        <RotateCcw className="h-3.5 w-3.5" />
                      </MessageAction>
                    )}
                    <MessageAction
                      tooltip={t.chat.feedbackGood}
                      onClick={() => void handleFeedback('up')}
                    >
                      <ThumbsUp className={`h-3.5 w-3.5 ${feedback === 'up' ? 'text-green-500 fill-green-500/20' : ''}`} />
                    </MessageAction>
                    <MessageAction
                      tooltip={t.chat.feedbackBad}
                      onClick={() => void handleFeedback('down')}
                    >
                      <ThumbsDown className={`h-3.5 w-3.5 ${feedback === 'down' ? 'text-red-500 fill-red-500/20' : ''}`} />
                    </MessageAction>
                    <TtsPlayButton text={message.content} />
                  </MessageActions>
                  {reasonOpen && (
                    <div className="mt-2 flex items-center gap-2">
                      <input
                        type="text"
                        value={reason}
                        onChange={(e) => setReason(e.target.value)}
                        onKeyDown={(e) => { if (e.key === 'Enter') void handleSubmitReason(); if (e.key === 'Escape') setReasonOpen(false) }}
                        placeholder={t.chat.feedbackReasonPlaceholder}
                        maxLength={500}
                        autoFocus
                        className="flex-1 max-w-md rounded-lg border border-[var(--subtle-border)] bg-background px-2.5 py-1.5 text-xs outline-none focus:border-[var(--ring)]"
                      />
                      <button
                        type="button"
                        onClick={() => void handleSubmitReason()}
                        className="shrink-0 rounded-lg bg-primary px-2.5 py-1.5 text-xs text-primary-foreground hover:opacity-90"
                      >
                        {t.chat.feedbackReasonSubmit}
                      </button>
                      <button
                        type="button"
                        onClick={() => setReasonOpen(false)}
                        className="shrink-0 rounded-lg px-2 py-1.5 text-xs text-muted-foreground hover:text-foreground"
                      >
                        {t.chat.feedbackReasonSkip}
                      </button>
                    </div>
                  )}
                </>
              )}
            </div>
          </div>
        </div>
      </div>
    </AIMessage>
  )
}

// [XJC-PATCH] modified from upstream v0.0.178 — 详见 doc/侵入点清单.md
import { useState } from 'react'
import { Copy, Check, Coins, RotateCcw } from 'lucide-react'
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
import { useI18n } from '@/i18n'
import { useAppRuntimeStore } from '@/stores/app'
import { useChatContext } from '@/hooks/chatCtx'
import { useChatActions } from '@/hooks/useChat'
import type { Message } from '@/hooks/useChat'

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
  const { agentId, isProcessing } = useChatContext()
  const { regenerate } = useChatActions(agentId)
  const [copied, setCopied] = useState(false)
  const timestamp = new Date(message.timestamp).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  })

  const handleCopy = async () => {
    await navigator.clipboard.writeText(message.content)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

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
                    <TtsPlayButton text={message.content} />
                  </MessageActions>
                </>
              )}
            </div>
          </div>
        </div>
      </div>
    </AIMessage>
  )
}

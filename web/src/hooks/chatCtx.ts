import { createContext, useContext } from 'react'
import type { Message, TimelineItem, ToolUseItem } from './useChat'
import type { ChatItem } from '../lib/chat-utils'
import type { Attachment } from '../types/attachment'
import type { BrowserProfileDTO } from '../api/client'

type Agent = { id: string; name: string }

export interface ChatContextType {
  chatId: string | null
  currentChatAgentId: string | null
  canChangeAgent: boolean
  messages: Message[]
  timelineItems: TimelineItem[]
  streamingText: string
  isProcessing: boolean
  pendingToolUse: ToolUseItem[]
  documentStatuses: Record<string, { filename: string; status: 'parsing' | 'parsed' | 'failed'; error?: string }>
  chatStatus: 'submitted' | 'streaming' | 'ready' | 'error'
  send: (prompt: string, attachments?: Attachment[], modelOverride?: { providerAccountId: string; modelId: string } | null) => Promise<void>
  loadChat: (chatId: string, agentId?: string) => Promise<void>
  newChat: () => void
  stop: () => void
  showInsufficientCredits: boolean
  setShowInsufficientCredits: (show: boolean) => void

  chatList: ChatItem[]
  refreshChats: () => void
  searchQuery: string
  setSearchQuery: (q: string) => void
  deleteChat: (chatId: string) => Promise<void>
  updateChat: (chatId: string, data: { name?: string; avatar?: string }) => Promise<void>

  agentId: string
  setAgentId: (id: string) => void
  agents: Agent[]
  refreshAgents: () => void

  /** Current chat (or draft) model override from provider remote list. */
  modelOverride: { providerAccountId: string; modelId: string } | null
  setModelOverride: (override: { providerAccountId: string; modelId: string } | null) => void

  browserProfiles: BrowserProfileDTO[]
  refreshBrowserProfiles: () => void
}

export const ChatContext = createContext<ChatContextType | null>(null)

export function useChatContext() {
  const ctx = useContext(ChatContext)
  if (!ctx) throw new Error('useChatContext must be used within ChatProvider')
  return ctx
}

// [XJC-PATCH] modified from upstream v0.0.178 — 详见 doc/侵入点清单.md（T-A2 语音输入麦克风按钮）
import { useCallback, useEffect, useRef } from "react";
import {
  Attachment,
  AttachmentInfo,
  AttachmentPreview,
  AttachmentRemove,
  Attachments,
} from "@/components/ai-elements/attachments";
import {
  PromptInput,
  PromptInputButton,
  PromptInputFooter,
  PromptInputHeader,
  PromptInputSelect,
  PromptInputSelectContent,
  PromptInputSelectItem,
  PromptInputSelectTrigger,
  PromptInputSelectValue,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputTools,
  usePromptInputAttachments,
  type PromptInputMessage,
} from "@/components/ai-elements/prompt-input";
import { uploadChatAttachment } from "@/api/client";
import { VOICE_ENABLED } from "@/config/features";
import { useChatContext } from "@/hooks/chatCtx";
import { useVoiceRecorder } from "@/hooks/useVoiceRecorder";
import { useI18n } from "@/i18n";
import { resolveChatAttachments } from "@/lib/chat-attachments";
import { notify, useAppRuntimeStore } from "@/stores/app";
import { Bot, Loader2, Mic, PlusIcon } from "lucide-react";

const MAX_FILES = 10;

function AddAttachmentButton() {
  const attachments = usePromptInputAttachments();
  const isFull = attachments.files.length >= MAX_FILES;
  return (
    <PromptInputButton
      size="sm"
      disabled={isFull}
      onClick={() => attachments.openFileDialog()}
    >
      <PlusIcon className="size-4" />
    </PromptInputButton>
  );
}

// [XJC] T-A2 语音输入按钮：空闲=麦克风；录音中=红色脉冲+秒数（点击停止）；识别中=Loader
function VoiceInputButton({ onTranscript }: { onTranscript: (text: string) => void }) {
  const { t } = useI18n();
  const { state, seconds, start, stop } = useVoiceRecorder(onTranscript);

  if (state === "recording") {
    return (
      <PromptInputButton
        size="sm"
        onClick={stop}
        tooltip={t.voice.stopRecording}
        aria-label={t.voice.stopRecording}
        className="text-red-500 hover:text-red-500"
      >
        <span className="relative flex size-2">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-red-500 opacity-75" />
          <span className="relative inline-flex size-2 rounded-full bg-red-500" />
        </span>
        <span className="text-xs tabular-nums">{seconds}s</span>
      </PromptInputButton>
    );
  }

  if (state === "transcribing") {
    return (
      <PromptInputButton
        size="sm"
        disabled
        tooltip={t.voice.transcribing}
        aria-label={t.voice.transcribing}
      >
        <Loader2 className="size-4 animate-spin" />
      </PromptInputButton>
    );
  }

  return (
    <PromptInputButton
      size="sm"
      onClick={() => void start()}
      tooltip={t.voice.startRecording}
      aria-label={t.voice.startRecording}
    >
      <Mic className="size-4" />
    </PromptInputButton>
  );
}

function AttachmentPreviews() {
  const attachments = usePromptInputAttachments();
  if (attachments.files.length === 0) return null;

  return (
    <PromptInputHeader>
      <Attachments variant="grid" className="p-2 ml-0 w-full">
        {attachments.files.map((file) => (
          <Attachment
            key={file.id}
            data={{ ...file, id: file.id }}
            onRemove={() => attachments.remove(file.id)}
          >
            <AttachmentPreview />
            <AttachmentInfo />
            <AttachmentRemove />
          </Attachment>
        ))}
      </Attachments>
    </PromptInputHeader>
  );
}

export function ChatInput() {
  const { t } = useI18n();
  const {
    chatId,
    send,
    chatStatus,
    stop,
    agentId,
    currentChatAgentId,
    canChangeAgent,
    setAgentId,
    agents,
  } = useChatContext();
  const modelReady = useAppRuntimeStore((s) => s.modelReady);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const effectiveAgentId = currentChatAgentId ?? agentId;

  useEffect(() => {
    if (chatStatus === "submitted" || chatStatus === "streaming") return;

    const frameId = requestAnimationFrame(() => {
      textareaRef.current?.focus();
    });

    return () => cancelAnimationFrame(frameId);
  }, [chatId, chatStatus]);

  // [XJC] T-A2 语音识别文本追加到输入框现有内容（不自动发送）。
  // 该输入框是非受控组件（表单提交经 FormData 读值），直接写 DOM value 即可。
  const appendTranscript = useCallback((text: string) => {
    const el = textareaRef.current;
    if (!el) return;
    el.value = el.value ? el.value + text : text;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, []);

  const handleSubmit = async (msg: PromptInputMessage) => {
    const text = msg.text.trim();
    if (!text && msg.files.length === 0) return;

    if (!modelReady) {
      notify.error(t.settings.modelNotConfigured, {
        durationMs: 6000,
      });
      return;
    }

    const attachments = await resolveChatAttachments(
      msg.files,
      uploadChatAttachment,
    ).catch((error) => {
      notify.error(error instanceof Error ? error.message : String(error), {
        durationMs: 6000,
      });
      throw error;
    });

    send(text, attachments.length > 0 ? attachments : undefined);
  };

  return (
    <div className="bg-background px-5 py-3">
      <PromptInput
        onSubmit={handleSubmit}
        accept="image/jpeg,image/png,image/gif,image/webp,application/pdf,text/plain,text/markdown,text/csv,text/html,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        maxFiles={MAX_FILES}
        maxFileSize={10 * 1024 * 1024}
      >
        <AttachmentPreviews />
        <PromptInputTextarea
          ref={textareaRef}
          placeholder={t.chat.placeholder}
          data-testid="chat-input"
        />
        <PromptInputFooter>
          <PromptInputTools>
            <AddAttachmentButton />
            {VOICE_ENABLED && <VoiceInputButton onTranscript={appendTranscript} />}
            {agents.length > 1 && (
              <PromptInputSelect
                value={effectiveAgentId}
                onValueChange={setAgentId}
                disabled={!canChangeAgent}
              >
                <PromptInputSelectTrigger
                  className="h-7 text-xs gap-1"
                  data-testid="agent-selector"
                  disabled={!canChangeAgent}
                >
                  <Bot className="h-3.5 w-3.5" />
                  <PromptInputSelectValue />
                </PromptInputSelectTrigger>
                <PromptInputSelectContent>
                  {agents.map((a) => (
                    <PromptInputSelectItem
                      key={a.id}
                      value={a.id}
                      data-testid={`agent-option-${a.id}`}
                    >
                      {a.name}
                    </PromptInputSelectItem>
                  ))}
                </PromptInputSelectContent>
              </PromptInputSelect>
            )}
          </PromptInputTools>
          <PromptInputSubmit
            status={chatStatus}
            onStop={stop}
            data-testid="chat-send"
          />
        </PromptInputFooter>
      </PromptInput>
    </div>
  );
}

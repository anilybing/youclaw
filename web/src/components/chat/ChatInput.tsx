// [XJC-PATCH] modified from upstream v0.0.178 — 详见 doc/侵入点清单.md（T-A2 语音输入麦克风按钮）
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import {
  getSettings,
  listProviderRemoteModels,
  uploadChatAttachment,
  type CustomProviderAccountDTO,
  type RemoteModelInfoDTO,
} from "@/api/client";
import { VOICE_ENABLED } from "@/config/features";
import { useChatContext } from "@/hooks/chatCtx";
import { useVoiceRecorder } from "@/hooks/useVoiceRecorder";
import { useI18n } from "@/i18n";
import { resolveChatAttachments } from "@/lib/chat-attachments";
import { notify, useAppRuntimeStore } from "@/stores/app";
import { Bot, Cpu, Loader2, Mic, PlusIcon, RefreshCw } from "lucide-react";

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

function ModelSwitcher() {
  const { t } = useI18n();
  const { modelOverride, setModelOverride, chatStatus } = useChatContext();
  const [providers, setProviders] = useState<CustomProviderAccountDTO[]>([]);
  const [providerId, setProviderId] = useState("");
  const [models, setModels] = useState<RemoteModelInfoDTO[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busy = chatStatus === "submitted" || chatStatus === "streaming";

  useEffect(() => {
    getSettings()
      .then((settings) => {
        const list = settings.customProviders ?? [];
        setProviders(list);
        const preferred =
          modelOverride?.providerAccountId
          || settings.customModels.find((m) => m.id === settings.activeModel.id)?.providerAccountId
          || list[0]?.id
          || "";
        setProviderId((current) => current || preferred);
      })
      .catch(() => {});
  }, [modelOverride?.providerAccountId]);

  const refreshModels = useCallback(async (accountId: string, autoSelect = false) => {
    if (!accountId) {
      setModels([]);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const result = await listProviderRemoteModels(accountId);
      setModels(result.models);
      if (autoSelect && result.models[0]) {
        setModelOverride({ providerAccountId: accountId, modelId: result.models[0].id });
      }
    } catch (err) {
      setModels([]);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [setModelOverride]);

  useEffect(() => {
    if (!providerId) return;
    void refreshModels(providerId, !modelOverride);
    // Only re-fetch when provider changes; modelOverride auto-select runs once per provider switch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [providerId]);

  const selectedValue = modelOverride?.modelId || "";
  const providerLabel = useMemo(
    () => providers.find((p) => p.id === providerId)?.name || t.chat.modelProvider,
    [providers, providerId, t.chat.modelProvider],
  );

  if (providers.length === 0) return null;

  return (
    <div className="flex items-center gap-1">
      {providers.length > 1 && (
        <PromptInputSelect
          value={providerId}
          onValueChange={(id) => {
            setProviderId(id);
            setModelOverride(null);
          }}
          disabled={busy || loading}
        >
          <PromptInputSelectTrigger className="h-7 max-w-[140px] text-xs gap-1" disabled={busy || loading}>
            <PromptInputSelectValue placeholder={t.chat.modelProvider} />
          </PromptInputSelectTrigger>
          <PromptInputSelectContent>
            {providers.map((account) => (
              <PromptInputSelectItem key={account.id} value={account.id}>
                {account.name}
              </PromptInputSelectItem>
            ))}
          </PromptInputSelectContent>
        </PromptInputSelect>
      )}
      <PromptInputSelect
        value={selectedValue}
        onValueChange={(modelId) => {
          if (!providerId || !modelId) return;
          setModelOverride({ providerAccountId: providerId, modelId });
        }}
        disabled={busy || loading || models.length === 0}
      >
        <PromptInputSelectTrigger
          className="h-7 max-w-[220px] text-xs gap-1"
          data-testid="model-selector"
          disabled={busy || loading || models.length === 0}
          title={error || providerLabel}
        >
          {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Cpu className="h-3.5 w-3.5" />}
          <PromptInputSelectValue placeholder={loading ? t.chat.loadingModels : t.chat.selectModel} />
        </PromptInputSelectTrigger>
        <PromptInputSelectContent className="max-h-72">
          {models.map((model) => (
            <PromptInputSelectItem key={model.id} value={model.id} data-testid={`model-option-${model.id}`}>
              {model.name || model.id}
            </PromptInputSelectItem>
          ))}
        </PromptInputSelectContent>
      </PromptInputSelect>
      <PromptInputButton
        size="sm"
        disabled={busy || loading || !providerId}
        onClick={() => void refreshModels(providerId)}
        tooltip={t.chat.refreshModels}
        aria-label={t.chat.refreshModels}
      >
        <RefreshCw className={`size-3.5 ${loading ? "animate-spin" : ""}`} />
      </PromptInputButton>
    </div>
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
            <ModelSwitcher />
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

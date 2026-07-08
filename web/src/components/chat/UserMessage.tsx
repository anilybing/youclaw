// [XJC-PATCH] modified from upstream v0.0.178 — 详见 doc/侵入点清单.md
import { useState } from "react";
import { Check, Copy, User } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  Message as AIMessage,
  MessageAction,
  MessageActions,
  MessageResponse,
} from "@/components/ai-elements/message";
import {
  Attachments,
  Attachment,
  AttachmentPreview,
  AttachmentInfo,
} from "@/components/ai-elements/attachments";
import { localAssetUrl } from "@/api/transport";
import { formatUserMessageForDisplay } from "@/lib/user-message-format";
import { applyMarkdownHardBreaks } from "./user-message-markdown";
import { useI18n } from "@/i18n";
import { useAppRuntimeStore } from "@/stores/app";
import type { Message } from "@/hooks/useChat";

function UserAvatar() {
  const { user, isLoggedIn } = useAppRuntimeStore();
  const sizeClass = "w-8 h-8 text-xs";

  if (isLoggedIn && user?.avatar) {
    return (
      <img
        src={user.avatar}
        alt={user.name}
        className={cn("rounded-full object-cover", sizeClass)}
      />
    );
  }
  if (isLoggedIn && user) {
    return (
      <div
        className={cn(
          "rounded-full bg-gradient-to-br from-primary to-primary/60 flex items-center justify-center text-primary-foreground font-bold",
          sizeClass,
        )}
      >
        {user.name?.[0]?.toUpperCase() ?? "?"}
      </div>
    );
  }
  return (
    <div
      className={cn(
        "rounded-full bg-muted flex items-center justify-center text-muted-foreground",
        sizeClass,
      )}
    >
      <User className="h-4 w-4" />
    </div>
  );
}

export function UserMessage({ message }: { message: Message }) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  const attachments = message.attachments ?? [];
  const formattedContent = applyMarkdownHardBreaks(
    formatUserMessageForDisplay(message.content),
  );
  const hasContent = formattedContent.trim().length > 0;
  const timestamp = new Date(message.timestamp).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });

  const handleCopy = async () => {
    await navigator.clipboard.writeText(message.content);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <AIMessage from="user" data-testid="message-user">
      <div className="group flex gap-3 py-3 flex-row-reverse">
        <div>
          <UserAvatar />
        </div>
        <div className="flex-1 min-w-0 flex flex-col items-end">
          <div className="relative flex w-fit max-w-full flex-col items-end">
            <div className="pointer-events-none absolute bottom-full right-0 mb-1 text-[10px] font-medium text-muted-foreground/70 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
              {timestamp}
            </div>
            {attachments.length > 0 && (
              <Attachments variant="grid" className="mb-2">
                {attachments.map((a, i) => {
                  const url =
                    "filePath" in a && a.filePath
                      ? localAssetUrl(a.filePath)
                      : "data" in a && (a as { data?: string }).data
                        ? `data:${a.mediaType};base64,${(a as { data: string }).data}`
                        : "";
                  return (
                    <Attachment
                      key={i}
                      data={{
                        id: String(i),
                        type: "file" as const,
                        filename: a.filename,
                        mediaType: a.mediaType,
                        url,
                        filePath: "filePath" in a ? a.filePath : undefined,
                      }}
                    >
                      <AttachmentPreview />
                      <AttachmentInfo />
                    </Attachment>
                  );
                })}
              </Attachments>
            )}
            {hasContent && (
              <div className="w-fit max-w-[min(38rem,100%)] overflow-hidden rounded-2xl bg-secondary px-4 py-2.5 text-foreground">
                <MessageResponse className="chat-prose chat-user-bubble">
                  {formattedContent}
                </MessageResponse>
              </div>
            )}
            {hasContent && (
              <MessageActions className="mt-1 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
                <MessageAction
                  tooltip={copied ? t.chat.copied : t.chat.copyCode}
                  onClick={handleCopy}
                >
                  {copied ? (
                    <Check className="h-3.5 w-3.5 text-green-500" />
                  ) : (
                    <Copy className="h-3.5 w-3.5" />
                  )}
                </MessageAction>
              </MessageActions>
            )}
          </div>
        </div>
      </div>
    </AIMessage>
  );
}

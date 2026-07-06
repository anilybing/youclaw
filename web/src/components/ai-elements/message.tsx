import type { ComponentProps, HTMLAttributes, ReactElement, ReactNode } from "react";

type MessageRole = "user" | "assistant" | "system";

import { Button } from "@/components/ui/button";
import {
  ButtonGroup,
  ButtonGroupText,
} from "@/components/ui/button-group";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { LinkSafetyModal } from "./link-safety-modal";
import { cjk } from "@streamdown/cjk";
import { ChevronLeftIcon, ChevronRightIcon } from "lucide-react";
import {
  CodeBlock,
  CodeBlockCopyButton,
  CodeBlockDownloadButton,
  type ExtraProps,
  Streamdown,
  useIsCodeFenceIncomplete,
} from "streamdown";
import { useI18n } from "@/i18n";
import { notify } from "@/stores/app";
import {
  createContext,
  memo,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";

export type MessageProps = HTMLAttributes<HTMLDivElement> & {
  from: MessageRole;
};

export const Message = ({ className, from, ...props }: MessageProps) => (
  <div
    className={cn(
      "group flex w-full max-w-[95%] flex-col gap-2",
      from === "user" ? "is-user ml-auto justify-end" : "is-assistant",
      className
    )}
    {...props}
  />
);

export type MessageContentProps = HTMLAttributes<HTMLDivElement>;

export const MessageContent = ({
  children,
  className,
  ...props
}: MessageContentProps) => (
  <div
    className={cn(
      "is-user:dark flex w-fit min-w-0 max-w-full flex-col gap-2 overflow-hidden text-sm",
      "group-[.is-user]:ml-auto group-[.is-user]:rounded-lg group-[.is-user]:bg-secondary group-[.is-user]:px-4 group-[.is-user]:py-3 group-[.is-user]:text-foreground",
      "group-[.is-assistant]:text-foreground",
      className
    )}
    {...props}
  >
    {children}
  </div>
);

export type MessageActionsProps = ComponentProps<"div">;

export const MessageActions = ({
  className,
  children,
  ...props
}: MessageActionsProps) => (
  <div className={cn("flex items-center gap-1", className)} {...props}>
    {children}
  </div>
);

export type MessageActionProps = ComponentProps<typeof Button> & {
  tooltip?: string;
  label?: string;
};

export const MessageAction = ({
  tooltip,
  children,
  label,
  variant = "ghost",
  size = "icon-sm",
  ...props
}: MessageActionProps) => {
  const button = (
    <Button size={size} type="button" variant={variant} {...props}>
      {children}
      <span className="sr-only">{label || tooltip}</span>
    </Button>
  );

  if (tooltip) {
    return (
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>{button}</TooltipTrigger>
          <TooltipContent>
            <p>{tooltip}</p>
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    );
  }

  return button;
};

interface MessageBranchContextType {
  currentBranch: number;
  totalBranches: number;
  goToPrevious: () => void;
  goToNext: () => void;
  branches: ReactElement[];
  setBranches: (branches: ReactElement[]) => void;
}

const MessageBranchContext = createContext<MessageBranchContextType | null>(
  null
);

const useMessageBranch = () => {
  const context = useContext(MessageBranchContext);

  if (!context) {
    throw new Error(
      "MessageBranch components must be used within MessageBranch"
    );
  }

  return context;
};

export type MessageBranchProps = HTMLAttributes<HTMLDivElement> & {
  defaultBranch?: number;
  onBranchChange?: (branchIndex: number) => void;
};

export const MessageBranch = ({
  defaultBranch = 0,
  onBranchChange,
  className,
  ...props
}: MessageBranchProps) => {
  const [currentBranch, setCurrentBranch] = useState(defaultBranch);
  const [branches, setBranches] = useState<ReactElement[]>([]);

  const handleBranchChange = useCallback(
    (newBranch: number) => {
      setCurrentBranch(newBranch);
      onBranchChange?.(newBranch);
    },
    [onBranchChange]
  );

  const goToPrevious = useCallback(() => {
    const newBranch =
      currentBranch > 0 ? currentBranch - 1 : branches.length - 1;
    handleBranchChange(newBranch);
  }, [currentBranch, branches.length, handleBranchChange]);

  const goToNext = useCallback(() => {
    const newBranch =
      currentBranch < branches.length - 1 ? currentBranch + 1 : 0;
    handleBranchChange(newBranch);
  }, [currentBranch, branches.length, handleBranchChange]);

  const contextValue = useMemo<MessageBranchContextType>(
    () => ({
      branches,
      currentBranch,
      goToNext,
      goToPrevious,
      setBranches,
      totalBranches: branches.length,
    }),
    [branches, currentBranch, goToNext, goToPrevious]
  );

  return (
    <MessageBranchContext.Provider value={contextValue}>
      <div
        className={cn("grid w-full gap-2 [&>div]:pb-0", className)}
        {...props}
      />
    </MessageBranchContext.Provider>
  );
};

export type MessageBranchContentProps = HTMLAttributes<HTMLDivElement>;

export const MessageBranchContent = ({
  children,
  ...props
}: MessageBranchContentProps) => {
  const { currentBranch, setBranches, branches } = useMessageBranch();
  const childrenArray = useMemo(
    () => (Array.isArray(children) ? children : [children]),
    [children]
  );

  // Use useEffect to update branches when they change
  useEffect(() => {
    if (branches.length !== childrenArray.length) {
      setBranches(childrenArray);
    }
  }, [childrenArray, branches, setBranches]);

  return childrenArray.map((branch, index) => (
    <div
      className={cn(
        "grid gap-2 overflow-hidden [&>div]:pb-0",
        index === currentBranch ? "block" : "hidden"
      )}
      key={branch.key}
      {...props}
    >
      {branch}
    </div>
  ));
};

export type MessageBranchSelectorProps = ComponentProps<typeof ButtonGroup>;

export const MessageBranchSelector = ({
  className,
  ...props
}: MessageBranchSelectorProps) => {
  const { totalBranches } = useMessageBranch();

  // Don't render if there's only one branch
  if (totalBranches <= 1) {
    return null;
  }

  return (
    <ButtonGroup
      className={cn(
        "[&>*:not(:first-child)]:rounded-l-md [&>*:not(:last-child)]:rounded-r-md",
        className
      )}
      orientation="horizontal"
      {...props}
    />
  );
};

export type MessageBranchPreviousProps = ComponentProps<typeof Button>;

export const MessageBranchPrevious = ({
  children,
  ...props
}: MessageBranchPreviousProps) => {
  const { goToPrevious, totalBranches } = useMessageBranch();

  return (
    <Button
      aria-label="Previous branch"
      disabled={totalBranches <= 1}
      onClick={goToPrevious}
      size="icon-sm"
      type="button"
      variant="ghost"
      {...props}
    >
      {children ?? <ChevronLeftIcon size={14} />}
    </Button>
  );
};

export type MessageBranchNextProps = ComponentProps<typeof Button>;

export const MessageBranchNext = ({
  children,
  ...props
}: MessageBranchNextProps) => {
  const { goToNext, totalBranches } = useMessageBranch();

  return (
    <Button
      aria-label="Next branch"
      disabled={totalBranches <= 1}
      onClick={goToNext}
      size="icon-sm"
      type="button"
      variant="ghost"
      {...props}
    >
      {children ?? <ChevronRightIcon size={14} />}
    </Button>
  );
};

export type MessageBranchPageProps = HTMLAttributes<HTMLSpanElement>;

export const MessageBranchPage = ({
  className,
  ...props
}: MessageBranchPageProps) => {
  const { currentBranch, totalBranches } = useMessageBranch();

  return (
    <ButtonGroupText
      className={cn(
        "border-none bg-transparent text-muted-foreground shadow-none",
        className
      )}
      {...props}
    >
      {currentBranch + 1} of {totalBranches}
    </ButtonGroupText>
  );
};

export type MessageResponseProps = ComponentProps<typeof Streamdown>;

// @streamdown/code statically imports shiki which uses oniguruma-to-es with
// named capture group regex. Older WebKit (macOS < 13.4) throws SyntaxError
// at parse time. Dynamic import isolates the failure gracefully.
type CodePlugin = { code: unknown };
let resolvedCodePlugin: CodePlugin | null = null;
const codePluginPromise = import("@streamdown/code")
  .then((mod) => {
    resolvedCodePlugin = { code: mod.code };
  })
  .catch(() => {
    // Syntax highlighting unavailable on this engine — silent fallback
  });
// Subscribers notified when code plugin becomes available
const codePluginListeners = new Set<() => void>();
codePluginPromise.then(() => {
  for (const fn of codePluginListeners) fn();
  codePluginListeners.clear();
});

function useStreamdownPlugins() {
  const [plugins, setPlugins] = useState(() =>
    resolvedCodePlugin ? { cjk, ...resolvedCodePlugin } : { cjk }
  );

  useEffect(() => {
    if (resolvedCodePlugin) {
      return;
    }
    const listener = () => {
      if (resolvedCodePlugin) setPlugins({ cjk, ...resolvedCodePlugin });
    };
    codePluginListeners.add(listener);
    return () => { codePluginListeners.delete(listener); };
  }, []);

  return resolvedCodePlugin ? { cjk, ...resolvedCodePlugin } : plugins;
}
const codeLanguagePattern = /language-([^\s]+)/;
const startLinePattern = /\{(\d+)\}/;
const tableDownloadTriggerTitle = "Download table";

type MessageResponseCodeProps = ComponentProps<"code"> &
  ExtraProps & {
    "data-block"?: boolean;
  };

function getCodeContent(children: ReactNode): string {
  if (typeof children === "string") return children;
  if (Array.isArray(children)) {
    return children
      .map((child) => (typeof child === "string" ? child : ""))
      .join("");
  }
  return "";
}

const MessageResponseCode = ({
  children,
  className,
  node,
  ["data-block"]: isBlock,
  ...props
}: MessageResponseCodeProps) => {
  const { t } = useI18n();
  const isIncomplete = useIsCodeFenceIncomplete();

  if (!isBlock) {
    return (
      <code
        className={cn("rounded bg-muted px-1.5 py-0.5 font-mono text-sm", className)}
        {...props}
      >
        {children}
      </code>
    );
  }

  const code = getCodeContent(children);
  const language = className?.match(codeLanguagePattern)?.[1] ?? "";
  const metastring =
    typeof node?.properties?.metastring === "string"
      ? node.properties.metastring
      : undefined;
  const startLine = (() => {
    const value = metastring?.match(startLinePattern)?.[1];
    if (!value) return undefined;
    const parsed = Number.parseInt(value, 10);
    return Number.isNaN(parsed) ? undefined : parsed;
  })();

  return (
    <CodeBlock
      className={className}
      code={code}
      isIncomplete={isIncomplete}
      language={language}
      startLine={startLine}
    >
      <CodeBlockDownloadButton
        code={code}
        language={language}
        onDownload={() => {
          notify.success(t.chat.contentExported);
        }}
        onError={(error) => {
          notify.error(error instanceof Error ? error.message : "Export failed");
        }}
      />
      <CodeBlockCopyButton code={code} />
    </CodeBlock>
  );
};

const linkSafetyConfig = {
  enabled: true,
  renderModal: ({ isOpen, onClose, url }: { isOpen: boolean; onClose: () => void; url: string }) => {
    if (!isOpen) return null;
    return <LinkSafetyModal url={url} onClose={onClose} />;
  },
};

export const MessageResponse = memo(
  ({ className, components, ...props }: MessageResponseProps) => {
    const { t } = useI18n();
    const plugins = useStreamdownPlugins();
    const mergedComponents = useMemo(
      () => ({
        ...components,
        code: MessageResponseCode,
      }),
      [components]
    );

    const handleClick = useCallback(
      (event: React.MouseEvent<HTMLDivElement>) => {
        const target = event.target;
        if (!(target instanceof HTMLElement)) return;

        const button = target.closest("button");
        if (!(button instanceof HTMLButtonElement)) return;

        const optionLabel = button.textContent?.trim();
        if (optionLabel !== "CSV" && optionLabel !== "Markdown") return;

        const trigger = button.parentElement?.previousElementSibling;
        if (!(trigger instanceof HTMLButtonElement)) return;
        if (trigger.title !== tableDownloadTriggerTitle) return;

        notify.success(t.chat.contentExported);
      },
      [t.chat.contentExported]
    );

    return (
      <div onClick={handleClick}>
        <Streamdown
          className={cn(
            "size-full [&>*:first-child]:mt-0 [&>*:last-child]:mb-0",
            className
          )}
          components={mergedComponents}
          plugins={plugins}
          linkSafety={linkSafetyConfig}
          {...props}
        />
      </div>
    );
  },
  (prevProps, nextProps) => prevProps.children === nextProps.children
);

MessageResponse.displayName = "MessageResponse";

export type MessageToolbarProps = ComponentProps<"div">;

export const MessageToolbar = ({
  className,
  children,
  ...props
}: MessageToolbarProps) => (
  <div
    className={cn(
      "mt-4 flex w-full items-center justify-between gap-4",
      className
    )}
    {...props}
  >
    {children}
  </div>
);

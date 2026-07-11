// [XJC-PATCH] modified from upstream v0.0.178 — 详见 doc/侵入点清单.md
import { openExternal } from "@/api/transport";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useDragRegion } from "@/hooks/useDragRegion";
import { usePlatform } from "@/hooks/usePlatform";
import { useSidebar } from "@/hooks/useSidebar";
import { useI18n } from "@/i18n";
import { resolveAccountPlanLabel } from "@/lib/account-plan";
import { cn } from "@/lib/utils";
import { useAppRuntimeStore } from "@/stores/app";
import { KNOWLEDGE_ENABLED } from "@/config/features";
import { isFloatingSupported, toggleFloatingWindow } from "@/lib/floating-window";
import { notify } from "@/stores/app-runtime";
import {
  BookOpen,
  Bot,
  Brain,
  BriefcaseBusiness,
  CalendarClock,
  LogIn,
  LogOut,
  Mail,
  PanelLeft,
  PanelLeftClose,
  Puzzle,
  ScrollText,
  Settings2,
  KeyRound,
  LayoutDashboard,
  PictureInPicture2,
  SquarePen,
  Ticket,
  User,
  Workflow,
} from "lucide-react";
import { useState } from "react";
import { NavLink } from "react-router-dom";
import appConfig from "../../../../app.config.ts";

/** Inline horizontal padding, keeps icon centered within 52px when collapsed (8+36+8=52) */
const ROW_PX = "px-2";
// 反馈入口统一指向自有官网（上游的飞书表单已移除；自有反馈表单上线后
// 改 appConfig.siteBase 下的具体页面即可）
const FEEDBACK_URL_ZH = appConfig.siteBase;
const FEEDBACK_URL_EN = appConfig.siteBase;

function AvatarView({
  size = "md",
  user,
  isLoggedIn,
}: {
  size?: "sm" | "md";
  user: { name: string; avatar?: string } | null;
  isLoggedIn: boolean;
}) {
  const sizeClass = size === "sm" ? "w-6 h-6 text-[10px]" : "w-8 h-8 text-xs";

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
      <User className={size === "sm" ? "h-3 w-3" : "h-4 w-4"} />
    </div>
  );
}

import { useUpdateStore } from '@/stores/update'

interface AppSidebarProps {
  onOpenSettings: (tab?: string) => void;
}

export function AppSidebar({ onOpenSettings }: AppSidebarProps) {
  const { isCollapsed, toggle } = useSidebar();
  const { t } = useI18n();
  const updateAvailable = useUpdateStore((s) => s.available);
  const { user, isLoggedIn, authLoading, login, logout, cloudEnabled } =
    useAppRuntimeStore();
  const { isMac } = usePlatform();
  const drag = useDragRegion();
  const [logoutOpen, setLogoutOpen] = useState(false);
  const handleToggleFloating = async () => {
    try {
      const opened = await toggleFloatingWindow();
      notify.info(opened ? t.floating.opened : t.floating.closed);
    } catch {
      notify.error(t.floating.openFailed);
    }
  };
  const feedbackUrl =
    typeof navigator !== "undefined" &&
    navigator.language.toLowerCase().startsWith("zh")
      ? FEEDBACK_URL_ZH
      : FEEDBACK_URL_EN;

  const navItems = [
    { to: "/today", icon: LayoutDashboard, label: t.nav.todayOperations },
    { to: "/workbench", icon: BriefcaseBusiness, label: t.nav.workbench },
    { to: "/chat", icon: SquarePen, label: t.nav.chat },
    { to: "/agents", icon: Bot, label: t.nav.agents },
    { to: "/cron", icon: CalendarClock, label: t.nav.tasks },
    // [XJC] 工作流（扣子对标）：列表/运行/历史/失败续跑
    { to: "/workflows", icon: Workflow, label: t.nav.workflows },
    { to: "/skills", icon: Puzzle, label: t.nav.skills },
    // [XJC] 模板中心暂时隐藏：积分变现方向未定，且与「数字员工」功能重叠。
    // 恢复方法：取消下一行注释，并把 `Sparkles` 加回上面的 lucide-react 导入。
    // { to: "/templates", icon: Sparkles, label: "模板中心" },
    // [XJC] 激活码/设备绑定依赖云端服务，离线模式（cloudEnabled=false）隐藏入口。
    ...(cloudEnabled ? [{ to: "/activation", icon: KeyRound, label: "激活与设备" }] : []),
    { to: "/memory", icon: Brain, label: t.nav.memory },
    // [XJC] 知识库（通用能力对齐 · T-A1）：编译期开关门控，实现完成后启用
    ...(KNOWLEDGE_ENABLED ? [{ to: "/knowledge", icon: BookOpen, label: t.nav.knowledge }] : []),
    // [XJC] 卡密库（闲鱼虚拟商品自动发货）：库存水位 + 发货台账
    { to: "/fulfillment", icon: Ticket, label: t.nav.fulfillment },
    { to: "/logs", icon: ScrollText, label: t.nav.logs },
  ];

  const displayName =
    isLoggedIn && user
      ? user.name
      : cloudEnabled
        ? t.account.notLoggedIn
        : t.account.offlineMode;
  const accountPlanLabel = resolveAccountPlanLabel(user, {
    trial: t.account.planTrial,
    standard: t.account.planStandard,
    premium: t.account.planPremium,
    active: t.account.planActive,
    unactivated: t.account.planUnactivated,
  });
  const displaySub =
    isLoggedIn && user
      ? accountPlanLabel
      : cloudEnabled
        ? t.account.loginHint
        : t.account.offlineModeHint;

  return (
    <aside
      className={cn(
        "shrink-0 flex flex-col overflow-hidden",
        "bg-muted/30 border-r",
        "border-[var(--subtle-border)]",
        "transition-[width] duration-300 ease-[var(--ease-soft)]",
        isCollapsed ? "w-[52px]" : "w-[220px]",
      )}
      aria-expanded={!isCollapsed}
    >
      {/* Top action bar（品牌已上移到窗口标题栏，这里只保留折叠/展开功能件） */}
      {!isMac ? (
        <div className={cn("flex items-center h-[52px] shrink-0", ROW_PX)}>
          {isCollapsed && (
            <button
              type="button"
              onClick={toggle}
              className="w-9 h-9 shrink-0 rounded-[10px] flex items-center justify-center hover:bg-[var(--surface-hover)] transition-all duration-200 ease-[var(--ease-soft)]"
              aria-label={t.sidebar.expand}
            >
              <PanelLeft className="h-4 w-4" />
            </button>
          )}
          <div className="flex-1 min-w-0" />
          <button
            type="button"
            onClick={toggle}
            className={cn(
              "w-9 h-9 shrink-0 rounded-[10px] flex items-center justify-center hover:bg-[var(--surface-hover)] transition-all duration-200 ease-[var(--ease-soft)]",
              isCollapsed ? "opacity-0 pointer-events-none" : "opacity-100",
            )}
            aria-label={t.sidebar.collapse}
            tabIndex={isCollapsed ? -1 : 0}
          >
            <PanelLeftClose className="h-4 w-4" />
          </button>
        </div>
      ) : (
        <div
          className={cn("flex items-center h-10 shrink-0", ROW_PX)}
          {...drag}
        >
          {isCollapsed ? (
            <button
              type="button"
              onClick={toggle}
              className="w-9 h-9 shrink-0 rounded-[10px] flex items-center justify-center hover:bg-[var(--surface-hover)] transition-all duration-200 ease-[var(--ease-soft)]"
              aria-label={t.sidebar.expand}
            >
              <PanelLeft className="h-4 w-4" />
            </button>
          ) : (
            <>
              <div className="flex-1 min-w-0" />
              <button
                type="button"
                onClick={toggle}
                className="w-9 h-9 shrink-0 rounded-[10px] flex items-center justify-center hover:bg-[var(--surface-hover)] transition-all duration-200 ease-[var(--ease-soft)]"
                aria-label={t.sidebar.collapse}
              >
                <PanelLeftClose className="h-4 w-4" />
              </button>
            </>
          )}
        </div>
      )}

      {/* Page navigation */}
      <nav className="space-y-0.5 px-1.5">
        {navItems.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.to === "/"}
            data-testid={`nav-${item.to === "/" ? "chat" : item.to.slice(1)}`}
            className={({ isActive }) =>
              cn(
                "flex items-center h-9 rounded-[10px] whitespace-nowrap overflow-hidden",
                "transition-all duration-200 ease-[var(--ease-soft)]",
                isCollapsed ? "px-0.5" : "px-1",
                isActive
                  ? "bg-primary/10 text-primary font-medium"
                  : "text-muted-foreground hover:text-foreground hover:bg-[var(--surface-hover)]",
              )
            }
            aria-label={item.label}
          >
            <div className="w-9 h-9 shrink-0 flex items-center justify-center">
              <item.icon className="h-4 w-4" />
            </div>
            <span
              className={cn(
                "text-sm transition-opacity duration-200",
                isCollapsed ? "opacity-0" : "opacity-100",
              )}
            >
              {item.label}
            </span>
          </NavLink>
        ))}
        {/* [XJC] 悬浮提醒窗开关（仅桌面端）：常驻置顶小窗即时提示 AI 结果 */}
        {isFloatingSupported && (
          <button
            type="button"
            onClick={handleToggleFloating}
            className={cn(
              "w-full flex items-center h-9 rounded-[10px] whitespace-nowrap overflow-hidden",
              "transition-all duration-200 ease-[var(--ease-soft)]",
              isCollapsed ? "px-0.5" : "px-1",
              "text-muted-foreground hover:text-foreground hover:bg-[var(--surface-hover)]",
            )}
            aria-label={t.floating.toggle}
            title={t.floating.toggle}
          >
            <div className="w-9 h-9 shrink-0 flex items-center justify-center">
              <PictureInPicture2 className="h-4 w-4" />
            </div>
            <span className={cn("text-sm transition-opacity duration-200", isCollapsed ? "opacity-0" : "opacity-100")}>
              {t.floating.toggle}
            </span>
          </button>
        )}
      </nav>

      {/* Spacer — draggable for window movement */}
      <div className="flex-1" {...drag} />

      {/* Bottom actions */}
      <AlertDialog open={logoutOpen} onOpenChange={setLogoutOpen}>
        <div className="border-t border-[var(--subtle-border)] py-2 px-1.5 space-y-2">
          <DropdownMenu>
            <div
              className={cn(
                "flex items-center gap-1",
                isCollapsed && "justify-center",
              )}
            >
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  className={cn(
                    "flex items-center h-9 rounded-[10px] whitespace-nowrap overflow-hidden outline-none",
                    "transition-all duration-200 ease-[var(--ease-soft)]",
                    isCollapsed ? "w-full px-0.5" : "min-w-0 flex-1 px-1",
                    "text-muted-foreground hover:text-foreground hover:bg-[var(--surface-hover)]",
                  )}
                >
                  <div className="relative w-9 h-9 shrink-0 flex items-center justify-center">
                    <AvatarView size="md" user={user} isLoggedIn={isLoggedIn} />
                    {updateAvailable && (
                      <span
                        className="absolute right-0.5 top-0.5 h-2 w-2 rounded-full bg-red-500 ring-2 ring-background"
                        title={t.settings.updateAvailableTitle}
                      />
                    )}
                  </div>
                  <div
                    className={cn(
                      "flex-1 min-w-0 text-left ml-1.5 transition-opacity duration-200",
                      isCollapsed ? "opacity-0" : "opacity-100",
                    )}
                  >
                    <p className="text-xs font-semibold truncate">
                      {isLoggedIn && user
                        ? user.name
                        : cloudEnabled
                          ? t.account.login
                          : t.account.offlineMode}
                    </p>
                    {isLoggedIn && user && (
                      <p className="text-[10px] text-muted-foreground truncate">
                        {accountPlanLabel}
                      </p>
                    )}
                  </div>
                </button>
              </DropdownMenuTrigger>

              {!isCollapsed && (
                <button
                  type="button"
                  onClick={() => void openExternal(feedbackUrl)}
                  className="h-9 shrink-0 rounded-[10px] px-2.5 text-xs font-medium text-muted-foreground hover:bg-[var(--surface-hover)] hover:text-foreground transition-all duration-200 ease-[var(--ease-soft)]"
                  aria-label={t.sidebar.feedback}
                  title={t.sidebar.feedback}
                >
                  <span className="flex items-center gap-1.5">
                    <Mail className="h-4 w-4 shrink-0" />
                    <span>{t.sidebar.feedback}</span>
                  </span>
                </button>
              )}
            </div>

            <DropdownMenuContent
              side="top"
              align="start"
              sideOffset={8}
              className="w-[240px] rounded-xl p-2"
            >
              <div className="flex flex-col items-center py-3 px-2">
                <div className="mb-2">
                  <AvatarView size="md" user={user} isLoggedIn={isLoggedIn} />
                </div>
                <p className="text-sm font-semibold truncate max-w-full">
                  {displayName}
                </p>
                <p className="text-[11px] text-muted-foreground truncate max-w-full">
                  {displaySub}
                </p>
              </div>

              <DropdownMenuSeparator />

              {cloudEnabled && !isLoggedIn && (
                <>
                  <DropdownMenuItem
                    onClick={() => login()}
                    disabled={authLoading}
                    className="gap-3 px-3 py-2.5 rounded-lg cursor-pointer"
                  >
                    <LogIn className="h-4 w-4 text-muted-foreground" />
                    <span className="text-sm">
                      {authLoading ? t.account.loggingIn : t.account.login}
                    </span>
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                </>
              )}

              <DropdownMenuItem
                onClick={() => onOpenSettings()}
                className="gap-3 px-3 py-2.5 rounded-lg cursor-pointer"
              >
                <Settings2 className="h-4 w-4 text-muted-foreground" />
                <span className="text-sm">{t.settings.title}</span>
              </DropdownMenuItem>

              {isLoggedIn && (
                <DropdownMenuItem
                  asChild
                  className="gap-3 px-3 py-2.5 rounded-lg cursor-pointer"
                >
                  <NavLink to="/profile">
                    <User className="h-4 w-4 text-muted-foreground" />
                    <span className="text-sm">个人中心</span>
                  </NavLink>
                </DropdownMenuItem>
              )}

              <DropdownMenuItem
                onClick={() => onOpenSettings("about")}
                className="gap-3 px-3 py-2.5 rounded-lg cursor-pointer"
              >
                <BookOpen className="h-4 w-4 text-muted-foreground" />
                <span className="text-sm">{t.settings.about}</span>
                {updateAvailable && (
                  <span className="ml-auto h-1.5 w-1.5 rounded-full bg-red-500" />
                )}
              </DropdownMenuItem>

              {isLoggedIn && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    onClick={(event) => {
                      event.preventDefault();
                      setLogoutOpen(true);
                    }}
                    className="gap-3 px-3 py-2.5 rounded-lg cursor-pointer text-destructive focus:text-destructive"
                  >
                    <LogOut className="h-4 w-4" />
                    <span className="text-sm">{t.account.logout}</span>
                  </DropdownMenuItem>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t.account.logout}</AlertDialogTitle>
            <AlertDialogDescription>
              {t.account.logoutConfirm}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t.common.cancel}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => logout()}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {t.account.logout}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </aside>
  );
}

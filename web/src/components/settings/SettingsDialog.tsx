// [XJC-PATCH] modified from upstream v0.0.178 — 详见 doc/侵入点清单.md
import { useEffect, useState } from "react"
import { Dialog, DialogContent, DialogClose } from "@/components/ui/dialog"
import { GeneralPanel } from "./GeneralPanel"
import { MarketplacePanel } from "./MarketplacePanel"
import { ModelsPanel } from "./ModelsPanel"
import { AccountPanel } from "./AccountPanel"
import { AboutPanel } from "./AboutPanel"
// InvitationPanel removed — not applicable for USB activation model
import { EnvironmentPanel } from "./EnvironmentPanel"
import { Channels } from "@/pages/Channels"
import { BrowserProfiles } from "@/pages/BrowserProfiles"
import { X, User, Palette, Cpu, Radio, Globe, Info, Store, Terminal } from "lucide-react"
import { cn } from "@/lib/utils"
import { useI18n } from "@/i18n"
import { useAppRuntimeStore } from "@/stores/app"
import { useRemoteConfigStore } from "@/stores/remote-config"

type Tab = "account" | "general" | "marketplace" | "models" | "channels" | "browser" | "environment" | "about"

export type SettingsTab = Tab

const CONTENT_PADDING_TABS: Tab[] = ["account", "general", "marketplace", "models", "environment", "about"]

interface SettingsDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  initialTab?: Tab
  allowedTabs?: Tab[]
}

export function SettingsDialog({ open, onOpenChange, initialTab, allowedTabs }: SettingsDialogProps) {
  const { t } = useI18n()
  const cloudEnabled = useAppRuntimeStore((s) => s.cloudEnabled)
  const flag = useRemoteConfigStore((s) => s.flag)

  // 高级功能入口由远程配置控制（小白用户默认隐藏，运营可按套餐/用户放开）
  const allTabs: { id: Tab; label: string; icon: React.ComponentType<{ size?: number }>; cloud?: boolean; enabled?: boolean }[] = [
    { id: "account", label: t.account.title, icon: User, cloud: true },
    { id: "general", label: t.settings.general, icon: Palette },
    { id: "models", label: t.settings.models, icon: Cpu },
    { id: "marketplace", label: t.settings.marketplaceConfig, icon: Store, enabled: flag("features.skill_market_enabled", true) },
    { id: "channels", label: t.nav.channels, icon: Radio, enabled: flag("features.channels_enabled", false) },
    { id: "browser", label: t.nav.browser, icon: Globe, enabled: flag("features.browser_enabled", false) },
    { id: "environment", label: t.settings.environment, icon: Terminal },
    // Invitation/referral tab hidden — not applicable for USB activation model
    { id: "about", label: t.settings.about, icon: Info },
  ]

  // Hide cloud-dependent tabs in offline mode + feature-flagged tabs
  const tabs = allTabs.filter((tab) => (!tab.cloud || cloudEnabled) && tab.enabled !== false && (!allowedTabs || allowedTabs.includes(tab.id)))
  const fallbackTab = tabs[0]?.id ?? "general"
  const defaultTab = initialTab && tabs.some((tab) => tab.id === initialTab) ? initialTab : fallbackTab
  const [currentTab, setCurrentTab] = useState<Tab>(defaultTab)
  const activeTab = tabs.some((tab) => tab.id === currentTab) ? currentTab : fallbackTab

  // 应用内导航（如账户面板跳激活页）时自动关闭设置弹窗
  useEffect(() => {
    const onNavigate = () => onOpenChange(false)
    window.addEventListener('xjc:navigate', onNavigate)
    return () => window.removeEventListener('xjc:navigate', onNavigate)
  }, [onOpenChange])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[90vw] max-w-5xl h-[85vh] p-0 flex overflow-hidden bg-background rounded-2xl">
        {/* Close button */}
        <DialogClose className="absolute right-4 top-4 z-10 p-1.5 rounded-lg text-muted-foreground hover:text-foreground hover:bg-accent transition-colors">
          <X size={16} />
        </DialogClose>

        {/* Sidebar */}
        <div className="w-[200px] bg-muted/50 border-r border-border p-4 flex flex-col shrink-0">
          <h3 className="text-base font-semibold px-3 mb-4">{t.settings.title}</h3>
          <div className="flex-1 space-y-0.5">
            {tabs.map((tab) => (
              <button
                key={tab.id}
                onClick={() => setCurrentTab(tab.id)}
                className={cn(
                  "w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium transition-all",
                  activeTab === tab.id
                    ? "bg-primary text-primary-foreground shadow-md"
                    : "text-muted-foreground hover:bg-accent/60 hover:text-foreground"
                )}
              >
                <tab.icon size={16} />
                <span className="min-w-0 flex-1 truncate text-left">{tab.label}</span>
              </button>
            ))}
          </div>
        </div>

        {/* Content area */}
        <div className={cn(
          "flex-1 overflow-hidden",
          CONTENT_PADDING_TABS.includes(activeTab)
            ? "p-8 overflow-y-auto"
            : ""
        )}>
          {activeTab === "account" && <AccountPanel />}
          {activeTab === "general" && <GeneralPanel />}
          {activeTab === "marketplace" && <MarketplacePanel />}
          {activeTab === "models" && <ModelsPanel />}
          {activeTab === "channels" && <Channels />}
          {activeTab === "browser" && <BrowserProfiles />}
          {activeTab === "environment" && <EnvironmentPanel />}
          {activeTab === "about" && <AboutPanel />}
        </div>
      </DialogContent>
    </Dialog>
  )
}

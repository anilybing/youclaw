// [XJC] Shared page primitives — the design "base" every screen composes from,
// so headers, containers, sections and empty states stay consistent with the
// warm-tangerine system (tokens live in index.css). Purely presentational.
import type { ReactNode } from "react"
import { cn } from "@/lib/utils"

type ContainerWidth = "3xl" | "4xl" | "5xl" | "6xl" | "7xl" | "full"

const WIDTH_CLASS: Record<ContainerWidth, string> = {
  "3xl": "max-w-3xl",
  "4xl": "max-w-4xl",
  "5xl": "max-w-5xl",
  "6xl": "max-w-6xl",
  "7xl": "max-w-7xl",
  full: "max-w-none",
}

/**
 * Scrollable page shell with a centered, comfortably-padded column.
 * Set `ambient` to add the warm sunrise glow behind the top of the page
 * (use at most once per screen).
 */
export function PageContainer({
  children,
  width = "7xl",
  ambient = false,
  className,
  innerClassName,
}: {
  children: ReactNode
  width?: ContainerWidth
  ambient?: boolean
  className?: string
  innerClassName?: string
}) {
  return (
    <div className={cn("flex-1 overflow-y-auto", className)}>
      <div
        className={cn(
          "mx-auto w-full px-5 py-6 lg:px-8",
          WIDTH_CLASS[width],
          ambient && "app-ambient",
          innerClassName,
        )}
      >
        {children}
      </div>
    </div>
  )
}

/** Consistent page header: optional eyebrow row, tracking-tight title, muted
 *  description, and a right-aligned actions slot. */
export function PageHeader({
  eyebrow,
  title,
  description,
  actions,
  className,
}: {
  eyebrow?: ReactNode
  title: ReactNode
  description?: ReactNode
  actions?: ReactNode
  className?: string
}) {
  return (
    <div
      className={cn(
        "flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between",
        className,
      )}
    >
      <div className="min-w-0">
        {eyebrow && (
          <div className="mb-1.5 flex items-center gap-2 text-sm text-muted-foreground">
            {eyebrow}
          </div>
        )}
        <h1 className="text-2xl font-bold tracking-tight text-foreground">{title}</h1>
        {description && (
          <p className="mt-1.5 text-[15px] leading-relaxed text-muted-foreground">
            {description}
          </p>
        )}
      </div>
      {actions && (
        <div className="flex flex-wrap items-center gap-2 sm:shrink-0">{actions}</div>
      )}
    </div>
  )
}

/** In-page section heading (icon + label + optional trailing action). */
export function SectionHeading({
  icon,
  children,
  action,
  className,
}: {
  icon?: ReactNode
  children: ReactNode
  action?: ReactNode
  className?: string
}) {
  return (
    <div className={cn("flex items-center justify-between gap-2", className)}>
      <h2 className="flex items-center gap-2 text-sm font-semibold tracking-tight text-foreground">
        {icon}
        {children}
      </h2>
      {action}
    </div>
  )
}

/** Empty / zero state with a tinted brand icon chip and optional call to action. */
export function EmptyState({
  icon,
  title,
  description,
  action,
  className,
}: {
  icon?: ReactNode
  title: ReactNode
  description?: ReactNode
  action?: ReactNode
  className?: string
}) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center py-16 text-center",
        className,
      )}
    >
      {icon && (
        <div className="mb-4 grid h-14 w-14 place-items-center rounded-2xl bg-primary/10 text-primary [&_svg]:h-6 [&_svg]:w-6">
          {icon}
        </div>
      )}
      <p className="text-sm font-semibold text-foreground">{title}</p>
      {description && (
        <p className="mt-1.5 max-w-sm text-sm text-muted-foreground">{description}</p>
      )}
      {action && <div className="mt-5">{action}</div>}
    </div>
  )
}

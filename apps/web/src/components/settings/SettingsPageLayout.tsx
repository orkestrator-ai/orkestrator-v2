import type { ComponentProps, ReactNode } from "react";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

/**
 * `default` suits forms and lists. `wide` is for content with columns of its own:
 * tables, charts and card grids. Every width stays against the left edge; nothing
 * centers a page.
 */
const SETTINGS_PAGE_WIDTHS = {
  default: "max-w-3xl",
  wide: "max-w-5xl",
} as const;

/** The default page width, for chrome the shell draws above a page. */
export const SETTINGS_PAGE_DEFAULT_WIDTH_CLASS = SETTINGS_PAGE_WIDTHS.default;

/** The surface of a settings card. Rows inside it add `divide-y divide-zinc-800`. */
export const SETTINGS_CARD_CLASS = "rounded-lg border border-zinc-800 bg-zinc-950/40";

interface SettingsPageHeaderProps {
  title: ReactNode;
  description?: ReactNode;
  /** Page-level controls or status, right of the title; they wrap under it when narrow. */
  actions?: ReactNode;
}

/** The title block every settings page opens with. */
export function SettingsPageHeader({ title, description, actions }: SettingsPageHeaderProps) {
  return (
    <header className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
      <div className="min-w-0 flex-[1_1_20rem]">
        <h2 className="text-xl font-semibold text-foreground">{title}</h2>
        {description ? (
          <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted-foreground">
            {description}
          </p>
        ) : null}
      </div>
      {actions ? (
        <div className="flex max-w-full flex-wrap items-center gap-2">{actions}</div>
      ) : null}
    </header>
  );
}

interface SettingsPageLayoutProps
  extends Omit<ComponentProps<"div">, "title">, Partial<SettingsPageHeaderProps> {
  width?: keyof typeof SETTINGS_PAGE_WIDTHS;
}

/** One settings page: its width, left alignment, section spacing and header. */
export function SettingsPageLayout({
  width = "default",
  title,
  description,
  actions,
  className,
  children,
  ...props
}: SettingsPageLayoutProps) {
  return (
    <div
      className={cn("min-w-0 space-y-8 pb-8", SETTINGS_PAGE_WIDTHS[width], className)}
      {...props}
    >
      {title ? (
        <SettingsPageHeader title={title} description={description} actions={actions} />
      ) : null}
      {children}
    </div>
  );
}

interface SettingsSectionHeaderProps {
  title: ReactNode;
  icon?: ReactNode;
  headingId?: string;
  className?: string;
  /** The section's description. */
  children?: ReactNode;
}

/** The heading of one section inside a settings page. */
export function SettingsSectionHeader({
  title,
  icon,
  headingId,
  className,
  children,
}: SettingsSectionHeaderProps) {
  return (
    <div className={className}>
      <h3
        id={headingId}
        className="flex flex-wrap items-center gap-2 text-sm font-medium text-foreground"
      >
        {icon}
        {title}
      </h3>
      {children ? (
        <p className="mt-1 max-w-2xl text-xs leading-relaxed text-muted-foreground">{children}</p>
      ) : null}
    </div>
  );
}

interface SettingsRowProps {
  label: string;
  /** The control the label names, when there is one. */
  htmlFor?: string;
  description: ReactNode;
  /** The row's controls, right of the text; they wrap under it when narrow. */
  children: ReactNode;
}

/** One label, description and controls row inside a settings card. */
export function SettingsRow({ label, htmlFor, description, children }: SettingsRowProps) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3 p-4">
      <div className="min-w-0 flex-[1_1_16rem]">
        <Label htmlFor={htmlFor} className="text-sm">
          {label}
        </Label>
        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{description}</p>
      </div>
      <div className="flex shrink-0 items-center gap-3">{children}</div>
    </div>
  );
}

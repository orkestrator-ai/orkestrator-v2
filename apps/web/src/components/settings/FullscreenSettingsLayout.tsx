import { useState, useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";

export interface SettingsMenuItem {
  id: string;
  label: string;
  icon: React.ReactNode;
}

interface FullscreenSettingsLayoutProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  menuItems: SettingsMenuItem[];
  defaultSection?: string;
  children: (activeSection: string) => React.ReactNode;
  footer?: React.ReactNode;
}

export function FullscreenSettingsLayout({
  open,
  onOpenChange,
  title,
  menuItems,
  defaultSection,
  children,
  footer,
}: FullscreenSettingsLayoutProps) {
  const defaultId = defaultSection ?? menuItems[0]?.id ?? "";
  const [activeSection, setActiveSection] = useState(defaultId);

  // Reset to default only when transitioning from closed to open
  const prevOpenRef = useRef(open);
  useEffect(() => {
    if (open && !prevOpenRef.current) {
      setActiveSection(defaultId);
    }
    prevOpenRef.current = open;
  }, [open, defaultId]);

  // Handle Escape key
  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onOpenChange(false);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [open, onOpenChange]);

  if (!open) return null;

  const activeMenuItem = menuItems.find((item) => item.id === activeSection);

  const settingsLayout = (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={title}
      className="fixed inset-0 z-[60] flex flex-col bg-black md:top-7 md:flex-row [&_input]:bg-zinc-900 [&_textarea]:bg-zinc-900 [&_[data-slot=select-trigger]]:bg-zinc-900"
    >
      {/* Sidebar */}
      <div className="hidden shrink-0 flex-col border-b border-white/5 md:flex md:w-56 md:border-b-0 md:border-r">
        {/* Sidebar header */}
        <div className="hidden h-12 items-center px-4 bg-zinc-900/80 md:flex">
          <span className="text-sm font-medium text-foreground">{title}</span>
        </div>

        {/* Menu items */}
        <nav aria-label="Settings sections" className="block flex-1 py-2">
          {menuItems.map((item) => (
            <button
              key={item.id}
              onClick={() => setActiveSection(item.id)}
              className={cn(
                "flex min-h-10 w-full shrink-0 items-center gap-3 rounded-none border-l-2 px-4 py-2 text-sm transition-colors",
                activeSection === item.id
                  ? "border-blue-500 bg-zinc-900/80 text-foreground"
                  : "border-transparent text-muted-foreground hover:bg-zinc-900/50 hover:text-foreground"
              )}
            >
              {item.icon}
              {item.label}
            </button>
          ))}
        </nav>
      </div>

      {/* Content area */}
      <div className="flex flex-1 flex-col overflow-hidden">
        {/* Content header */}
        <div className="flex h-12 items-center justify-between bg-zinc-900/80 px-4 md:px-8">
          <Select value={activeSection} onValueChange={setActiveSection}>
            <SelectTrigger
              aria-label="Settings section"
              className="h-10 min-w-0 flex-1 border-0 !bg-transparent px-0 text-foreground shadow-none focus-visible:ring-0 md:hidden"
            >
              <SelectValue>
                <span className="flex min-w-0 items-center gap-2 text-sm font-medium">
                  {activeMenuItem?.icon}
                  <span className="truncate">{activeMenuItem?.label}</span>
                </span>
              </SelectValue>
            </SelectTrigger>
            <SelectContent
              position="popper"
              align="start"
              className="z-[70] w-[min(20rem,calc(100vw-2rem))]"
            >
              {menuItems.map((item) => (
                <SelectItem key={item.id} value={item.id} textValue={item.label} className="min-h-10">
                  <span className="flex items-center gap-2">
                    {item.icon}
                    <span>{item.label}</span>
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <h2 className="hidden text-sm font-medium text-foreground md:block">
            {activeMenuItem?.label}
          </h2>
          <Button
            variant="ghost"
            size="icon"
            className="h-10 w-10 text-muted-foreground hover:text-foreground md:h-7 md:w-7"
            onClick={() => onOpenChange(false)}
            aria-label="Close settings"
          >
            <X className="h-4 w-4" />
          </Button>
        </div>

        {/* Content body */}
        <div className="flex flex-1 flex-col overflow-y-auto px-4 py-4 md:px-8 md:py-6">
          <div className="flex-1">
            {children(activeSection)}
          </div>
          {footer && (
            <div className="flex justify-end gap-2 pt-6 pb-2 border-t border-zinc-800/50 mt-8">
              {footer}
            </div>
          )}
        </div>
      </div>
    </div>
  );

  // Action dialogs can be opened from transformed popovers. Portaling keeps this
  // fixed layer relative to the viewport instead of constraining it to the popover.
  return typeof document === "undefined"
    ? settingsLayout
    : createPortal(settingsLayout, document.body);
}

import { useState, useEffect, useRef } from "react";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
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

  return (
    <div className="fixed inset-0 top-11 z-50 flex flex-col bg-black md:top-7 md:flex-row [&_input]:bg-zinc-900 [&_textarea]:bg-zinc-900 [&_[data-slot=select-trigger]]:bg-zinc-900">
      {/* Sidebar */}
      <div className="flex shrink-0 flex-col border-b border-white/5 md:w-56 md:border-b-0 md:border-r">
        {/* Sidebar header */}
        <div className="hidden h-12 items-center px-4 bg-zinc-900/80 md:flex">
          <span className="text-sm font-medium text-foreground">{title}</span>
        </div>

        {/* Menu items */}
        <nav className="flex max-w-full gap-1 overflow-x-auto p-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden md:block md:flex-1 md:py-2">
          {menuItems.map((item) => (
            <button
              key={item.id}
              onClick={() => setActiveSection(item.id)}
              className={cn(
                "flex min-h-10 shrink-0 items-center gap-2 rounded-md border-b-2 px-3 py-2 text-sm transition-colors md:w-full md:gap-3 md:rounded-none md:border-b-0 md:border-l-2 md:px-4",
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
          <h2 className="text-sm font-medium text-foreground">
            {menuItems.find((m) => m.id === activeSection)?.label}
          </h2>
          <Button
            variant="ghost"
            size="icon"
            className="h-10 w-10 text-muted-foreground hover:text-foreground md:h-7 md:w-7"
            onClick={() => onOpenChange(false)}
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
}

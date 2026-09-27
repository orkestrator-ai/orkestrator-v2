import { Check, ChevronDown, Plus, Server } from "lucide-react";
import type { PreviewServiceSnapshot } from "@orkestrator/protocol/preview-services";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  serviceReadiness,
  serviceTargetLabel,
  type ServiceReadinessTone,
} from "@/lib/preview-service-display";
import { cn } from "@/lib/utils";

const TONE_CLASS: Record<ServiceReadinessTone, string> = {
  ready: "bg-emerald-500",
  starting: "bg-amber-500",
  problem: "bg-destructive",
  unknown: "bg-muted-foreground/60",
};

export function ReadinessDot({
  tone,
  className,
}: {
  tone: ServiceReadinessTone;
  className?: string;
}) {
  return (
    <span
      aria-hidden
      className={cn("inline-block h-2 w-2 shrink-0 rounded-full", TONE_CLASS[tone], className)}
    />
  );
}

export interface PreviewServicePickerProps {
  services: PreviewServiceSnapshot[];
  selectedServiceId: string | null;
  onSelect: (service: PreviewServiceSnapshot) => void;
  onRegister?: () => void;
  onManual?: () => void;
  disabled?: boolean;
}

/**
 * The address field's leading slot: which registered service this tab shows.
 * Environment-scoped; the entry service is listed first.
 */
export function PreviewServicePicker({
  services,
  selectedServiceId,
  onSelect,
  onRegister,
  onManual,
  disabled,
}: PreviewServicePickerProps) {
  const selected =
    services.find((service) => service.definition.serviceId === selectedServiceId) ?? null;
  const readiness = selected ? serviceReadiness(selected) : null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        disabled={disabled}
        aria-label={
          selected ? `Preview service ${selected.definition.label}` : "Choose preview service"
        }
        className="flex h-full max-w-[14rem] shrink-0 items-center gap-1.5 border-r border-border/70 px-2.5 text-[11px] font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:ring-1 focus-visible:ring-primary disabled:opacity-60"
      >
        {readiness ? (
          <ReadinessDot tone={readiness.tone} />
        ) : (
          <Server className="h-3.5 w-3.5 text-primary" />
        )}
        <span className="truncate">{selected ? selected.definition.label : "Choose service"}</span>
        <ChevronDown className="h-3 w-3 shrink-0" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-72">
        <DropdownMenuLabel>Environment services</DropdownMenuLabel>
        {services.length === 0 && (
          <div className="px-2 py-1.5 text-xs text-muted-foreground">
            No services are registered for this environment.
          </div>
        )}
        {services.map((service) => {
          const state = serviceReadiness(service);
          const isSelected = service.definition.serviceId === selectedServiceId;
          return (
            <DropdownMenuItem
              key={service.definition.serviceId}
              onSelect={() => onSelect(service)}
              className="gap-2"
            >
              <ReadinessDot tone={state.tone} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm">
                  {service.definition.label}
                  {service.definition.entry && (
                    <span className="ml-1 text-[10px] uppercase text-muted-foreground">entry</span>
                  )}
                </span>
                <span className="block truncate font-mono text-[11px] text-muted-foreground">
                  {service.definition.scheme} · {serviceTargetLabel(service.definition)} ·{" "}
                  {state.label}
                </span>
              </span>
              {isSelected && <Check className="h-3.5 w-3.5 shrink-0" />}
            </DropdownMenuItem>
          );
        })}
        {(onRegister || onManual) && <DropdownMenuSeparator />}
        {onRegister && (
          <DropdownMenuItem onSelect={onRegister} className="gap-2">
            <Plus className="h-3.5 w-3.5" />
            Register a service…
          </DropdownMenuItem>
        )}
        {onManual && (
          <DropdownMenuItem onSelect={onManual} className="gap-2">
            <Server className="h-3.5 w-3.5" />
            Backend host port (manual)…
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

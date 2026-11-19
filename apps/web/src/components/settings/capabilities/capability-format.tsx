import { useRef, type ReactNode } from "react";

import { AGENT_PLATFORM_LABELS, type AgentPlatform } from "@orkestrator/protocol/agent-platforms";
import {
  CAPABILITY_LIVE_SEMANTICS_LABELS,
  CAPABILITY_TARGET_STATUS_LABELS,
  CAPABILITY_VERIFICATION_LABELS,
  COMPONENT_KIND_LABELS,
  type CapabilityLiveSemantics,
  type CapabilityRisk,
  type CapabilityTargetStatus,
  type CapabilityVerificationLevel,
  type ComponentKind,
} from "@orkestrator/protocol/capability-resources";

import { cn } from "@/lib/utils";

export function providerLabel(provider: string): string {
  return AGENT_PLATFORM_LABELS[provider as AgentPlatform] ?? provider;
}

export function kindLabel(kind: string): string {
  return COMPONENT_KIND_LABELS[kind as ComponentKind] ?? kind;
}

export function statusLabel(status: string): string {
  return CAPABILITY_TARGET_STATUS_LABELS[status as CapabilityTargetStatus] ?? status;
}

export function verificationLabel(level: string): string {
  return (
    CAPABILITY_VERIFICATION_LABELS[level as CapabilityVerificationLevel | "unverified"] ?? level
  );
}

export function liveSemanticsLabel(value: string | undefined): string | undefined {
  return value
    ? (CAPABILITY_LIVE_SEMANTICS_LABELS[value as CapabilityLiveSemantics] ?? value)
    : undefined;
}

const STATUS_TONE: Record<string, string> = {
  ready: "border-emerald-500/40 bg-emerald-500/10 text-emerald-300",
  "installed-next-session": "border-sky-500/40 bg-sky-500/10 text-sky-300",
  "queued-until-idle": "border-sky-500/40 bg-sky-500/10 text-sky-300",
  pending: "border-zinc-600 bg-zinc-800/60 text-zinc-300",
  "outcome-unknown": "border-zinc-600 bg-zinc-800/60 text-zinc-300",
  offline: "border-zinc-600 bg-zinc-800/60 text-zinc-400",
  unsupported: "border-zinc-700 bg-transparent text-zinc-500",
  "needs-auth": "border-amber-500/40 bg-amber-500/10 text-amber-300",
  "needs-approval": "border-amber-500/40 bg-amber-500/10 text-amber-300",
  "restart-required": "border-amber-500/40 bg-amber-500/10 text-amber-300",
  drifted: "border-amber-500/40 bg-amber-500/10 text-amber-300",
  "blocked-policy": "border-rose-500/40 bg-rose-500/10 text-rose-300",
  failed: "border-rose-500/40 bg-rose-500/10 text-rose-300",
};

export function StatusBadge({
  status,
  title,
  label,
}: {
  status: string;
  title?: string;
  label?: string;
}) {
  return (
    <span
      title={title}
      className={cn(
        "inline-flex items-center whitespace-nowrap rounded border px-1.5 py-0.5 text-[11px] font-medium",
        STATUS_TONE[status] ?? STATUS_TONE.pending,
      )}
    >
      {label ?? statusLabel(status)}
    </span>
  );
}

const RISK_TONE: Record<CapabilityRisk, string> = {
  instructions: "text-zinc-400",
  network: "text-sky-300",
  executable: "text-amber-300",
  privileged: "text-rose-300",
};

const RISK_LABEL: Record<CapabilityRisk, string> = {
  instructions: "Instructions only",
  network: "Connects to a service",
  executable: "Runs programs",
  privileged: "Runs on its own trigger",
};

export function RiskLabel({ risk }: { risk: CapabilityRisk }) {
  return <span className={cn("text-xs", RISK_TONE[risk])}>{RISK_LABEL[risk]}</span>;
}

export function Pill({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded border border-zinc-700 px-1.5 py-0.5 text-[11px] text-zinc-300",
        className,
      )}
    >
      {children}
    </span>
  );
}

export function describeError(error: unknown): string {
  return error instanceof Error ? error.message : "The request failed.";
}

export function shortDigest(digest: string | undefined): string {
  if (!digest) return "";
  return digest.replace(/^sha256:/, "").slice(0, 10);
}

/**
 * Focus return for a dialog opened from state rather than a `DialogTrigger`.
 * Radix returns focus only to its trigger, so without one a closed dialog
 * left focus on the page body. Spread the result on `DialogContent`: it
 * remembers what had focus when the dialog opened and focuses it again on
 * close, if it is still on the page.
 */
export function useDialogFocusReturn(): {
  onOpenAutoFocus: () => void;
  onCloseAutoFocus: (event: Event) => void;
} {
  const opener = useRef<HTMLElement | null>(null);
  return {
    onOpenAutoFocus: () => {
      const active = document.activeElement;
      opener.current = active instanceof HTMLElement && active !== document.body ? active : null;
    },
    onCloseAutoFocus: (event) => {
      const target = opener.current;
      opener.current = null;
      if (target?.isConnected) {
        event.preventDefault();
        target.focus();
      }
    },
  };
}

export function newRequestKey(): string {
  return `ui-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Theme mapping for the machine palette. The backend stores a semantic token,
 * never CSS; this is the one place tokens become colours. A token this build
 * does not know renders as the labelled neutral fallback and is never
 * rewritten. Machine colours identify the owning backend only: they never
 * pulse, never turn red on failure and never signal activity.
 */

import {
  FALLBACK_MACHINE_COLOR,
  MACHINE_COLOR_TOKENS,
  machineColorForDisplay,
  type MachineColorToken,
} from "@orkestrator/protocol/backend-profile";

// Full class strings so Tailwind keeps them.
const DOT_CLASSES: Record<MachineColorToken | typeof FALLBACK_MACHINE_COLOR, string> = {
  violet: "bg-violet-500 dark:bg-violet-400",
  blue: "bg-blue-500 dark:bg-blue-400",
  teal: "bg-teal-500 dark:bg-teal-400",
  green: "bg-emerald-500 dark:bg-emerald-400",
  amber: "bg-amber-500 dark:bg-amber-400",
  orange: "bg-orange-500 dark:bg-orange-400",
  rose: "bg-rose-500 dark:bg-rose-400",
  slate: "bg-slate-500 dark:bg-slate-400",
  neutral: "bg-transparent border border-dashed border-muted-foreground",
};

// The same colours as an outline, for a machine shown while it is not connected.
const OUTLINE_CLASSES: Record<MachineColorToken | typeof FALLBACK_MACHINE_COLOR, string> = {
  violet: "border-violet-500 dark:border-violet-400",
  blue: "border-blue-500 dark:border-blue-400",
  teal: "border-teal-500 dark:border-teal-400",
  green: "border-emerald-500 dark:border-emerald-400",
  amber: "border-amber-500 dark:border-amber-400",
  orange: "border-orange-500 dark:border-orange-400",
  rose: "border-rose-500 dark:border-rose-400",
  slate: "border-slate-500 dark:border-slate-400",
  neutral: "border-dashed border-muted-foreground",
};

// The same colours for an icon drawn in the machine's colour.
const TEXT_CLASSES: Record<MachineColorToken | typeof FALLBACK_MACHINE_COLOR, string> = {
  violet: "text-violet-500 dark:text-violet-400",
  blue: "text-blue-500 dark:text-blue-400",
  teal: "text-teal-500 dark:text-teal-400",
  green: "text-emerald-500 dark:text-emerald-400",
  amber: "text-amber-500 dark:text-amber-400",
  orange: "text-orange-500 dark:text-orange-400",
  rose: "text-rose-500 dark:text-rose-400",
  slate: "text-slate-500 dark:text-slate-400",
  neutral: "text-muted-foreground",
};

const LABELS: Record<MachineColorToken | typeof FALLBACK_MACHINE_COLOR, string> = {
  violet: "Violet",
  blue: "Blue",
  teal: "Teal",
  green: "Green",
  amber: "Amber",
  orange: "Orange",
  rose: "Rose",
  slate: "Slate",
  neutral: "Unknown colour",
};

export function machineDotClass(token: string | undefined): string {
  return DOT_CLASSES[machineColorForDisplay(token)];
}

export function machineOutlineClass(token: string | undefined): string {
  return OUTLINE_CLASSES[machineColorForDisplay(token)];
}

export function machineTextClass(token: string | undefined): string {
  return TEXT_CLASSES[machineColorForDisplay(token)];
}

export function machineColorLabel(token: string | undefined): string {
  return LABELS[machineColorForDisplay(token)];
}

export const MACHINE_COLOR_CHOICES: ReadonlyArray<{
  token: MachineColorToken;
  label: string;
}> = MACHINE_COLOR_TOKENS.map((token) => ({ token, label: LABELS[token] }));

import { useState } from "react";
import { Loader2, Plus, Search } from "lucide-react";

import {
  COMPONENT_KINDS,
  type CapabilityPackageSummary,
  type CapabilitySetup,
} from "@orkestrator/protocol/capability-resources";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { capabilitiesApi } from "@/lib/backend/capabilities";

import { kindLabel, Pill, RiskLabel, StatusBadge } from "./capability-format";
import { useCapabilityResource } from "./useCapabilityResource";

const READINESS_STATUS: Record<CapabilityPackageSummary["readiness"], string> = {
  ready: "ready",
  "needs-attention": "failed",
  pending: "pending",
  unassigned: "unsupported",
};

const READINESS_LABEL: Record<CapabilityPackageSummary["readiness"], string> = {
  ready: "Ready",
  "needs-attention": "Needs attention",
  pending: "On its way",
  unassigned: "In library only",
};

/** One row per package, however many agents or machines can see it. */
export function LibraryView({
  setups,
  onOpen,
  onAdd,
}: {
  setups: CapabilitySetup[];
  onOpen: (packageId: string) => void;
  onAdd: () => void;
}) {
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState("");
  const [setupId, setSetupId] = useState("");
  const { state } = useCapabilityResource(
    () =>
      capabilitiesApi.listCapabilityPackages({
        ...(query.trim() ? { query: query.trim() } : {}),
        ...(kind ? { kind } : {}),
        ...(setupId ? { setupId } : {}),
      }),
    [query, kind, setupId],
  );
  const setupNames = Object.fromEntries(setups.map((setup) => [setup.id, setup.name]));
  const packages = state.data?.packages ?? [];

  return (
    <div className="space-y-3" data-testid="capability-library">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[12rem] flex-1">
          <Search className="pointer-events-none absolute top-2.5 left-2.5 h-3.5 w-3.5 text-muted-foreground" />
          <Input
            aria-label="Search capabilities"
            className="pl-8"
            placeholder="Search packages, skills, commands, servers"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
        <NativeSelect
          aria-label="Type"
          value={kind}
          onChange={(event) => setKind(event.target.value)}
        >
          <option value="">All types</option>
          {COMPONENT_KINDS.map((entry) => (
            <option key={entry} value={entry}>
              {kindLabel(entry)}
            </option>
          ))}
        </NativeSelect>
        <NativeSelect
          aria-label="Setup"
          value={setupId}
          onChange={(event) => setSetupId(event.target.value)}
        >
          <option value="">Every setup</option>
          {setups.map((setup) => (
            <option key={setup.id} value={setup.id}>
              {setup.name}
            </option>
          ))}
        </NativeSelect>
        <Button size="sm" onClick={onAdd} data-testid="capability-add">
          <Plus className="h-3.5 w-3.5" /> Add
        </Button>
      </div>
      {state.status === "error" ? (
        <p className="text-sm text-rose-300" role="alert">
          {state.message}
        </p>
      ) : null}
      {state.status === "loading" && packages.length === 0 ? (
        <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
      ) : null}
      {state.status !== "loading" && packages.length === 0 && !query && !kind && !setupId ? (
        <div className="rounded-lg border border-dashed border-zinc-800 p-6 text-center text-sm text-muted-foreground">
          Your library is empty. Add a skill, plugin, MCP server, command or prompt once, and choose
          where to use it.
        </div>
      ) : null}
      <ul className="divide-y divide-zinc-900 rounded-lg border border-zinc-800">
        {packages.map((pkg) => (
          <li key={pkg.id}>
            <button
              type="button"
              onClick={() => onOpen(pkg.id)}
              className="flex w-full flex-wrap items-center gap-x-4 gap-y-1 px-3 py-2.5 text-left hover:bg-zinc-900/60 focus-visible:bg-zinc-900/60 focus-visible:outline-none"
            >
              <div className="min-w-[10rem] flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium text-foreground">{pkg.displayName}</span>
                  {pkg.kinds.map((entry) => (
                    <Pill key={entry}>{kindLabel(entry)}</Pill>
                  ))}
                  {pkg.updateAvailable ? (
                    <Pill className="border-sky-500/40 text-sky-300">Update available</Pill>
                  ) : null}
                  {pkg.pinned ? <Pill>Pinned</Pill> : null}
                  {pkg.paused ? <Pill className="text-amber-300">Paused</Pill> : null}
                </div>
                <div className="mt-0.5 truncate text-xs text-muted-foreground">
                  {pkg.sourceLabel} · {pkg.revision.slice(0, 12)}
                </div>
              </div>
              <RiskLabel risk={pkg.risk} />
              <span className="text-xs text-muted-foreground">
                {pkg.assignedSetupIds.map((id) => setupNames[id] ?? id).join(" + ") || "No setup"}
              </span>
              <span
                title={pkg.attention > 0 ? `${pkg.attention} target(s) need attention` : undefined}
              >
                <StatusBadge
                  status={READINESS_STATUS[pkg.readiness]}
                  label={READINESS_LABEL[pkg.readiness]}
                />
              </span>
            </button>
          </li>
        ))}
      </ul>
      {state.data?.truncated ? (
        <p className="text-xs text-muted-foreground">
          {state.data.truncated} more; narrow the search.
        </p>
      ) : null}
    </div>
  );
}

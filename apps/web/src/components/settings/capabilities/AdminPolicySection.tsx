import { useId, useState } from "react";
import { Loader2, Plus, X } from "lucide-react";

import {
  parseForbiddenComponent,
  parseForbiddenSource,
  type CapabilityAdminPolicyView,
  type CapabilityPolicyEntryResult,
} from "@orkestrator/protocol/capability-admin-policy";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { capabilitiesApi } from "@/lib/backend/capabilities";

import { describeError, StatusBadge } from "./capability-format";
import { useCapabilityResource } from "./useCapabilityResource";

type ListKey = "forbiddenSources" | "forbiddenComponents";

const LISTS: Array<{
  key: ListKey;
  title: string;
  inputLabel: string;
  placeholder: string;
  hint: string;
  empty: string;
  parse: (raw: string) => CapabilityPolicyEntryResult;
}> = [
  {
    key: "forbiddenSources",
    title: "Forbidden sources",
    inputLabel: "Forbid a source",
    placeholder: "git:github.com/example-org/",
    hint: "A package id prefix: git:<host>/<path>, registry:<id>/, marketplace:, local: or managed:. A Git address is accepted.",
    empty: "No source is forbidden.",
    parse: parseForbiddenSource,
  },
  {
    key: "forbiddenComponents",
    title: "Forbidden components",
    inputLabel: "Forbid a component",
    placeholder: "hook",
    hint: "A kind (hook, mcp-server, native-plugin, …), a component id or a package id.",
    empty: "No component is forbidden.",
    parse: parseForbiddenComponent,
  },
];

/**
 * Administrator policy (docs/architecture/agent-capabilities-management.md,
 * "Administrator policy"): forbidden sources and components. Policy wins over
 * every setup, toolkit, assignment and session choice; a package it matches
 * is blocked wherever it is assigned and removed from machines on their next
 * pass. Each edit is compared against the policy revision it was made on.
 */
export function AdminPolicySection() {
  const policy = useCapabilityResource(() => capabilitiesApi.getCapabilityAdminPolicy(), []);
  const [drafts, setDrafts] = useState<Record<ListKey, string>>({
    forbiddenSources: "",
    forbiddenComponents: "",
  });
  const [invalid, setInvalid] = useState<Partial<Record<ListKey, string>>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const baseId = useId();
  const data = policy.state.data;

  const save = async (key: ListKey, next: string[]) => {
    if (!data) return;
    setBusy(true);
    setError(null);
    try {
      await capabilitiesApi.setCapabilityAdminPolicy(data.revision, { [key]: next });
      return true;
    } catch (saveError) {
      setError(describeError(saveError));
      return false;
    } finally {
      // A conflict means someone else changed it: show theirs.
      policy.reload();
      setBusy(false);
    }
  };

  const add = async (list: (typeof LISTS)[number]) => {
    if (!data) return;
    const parsed = list.parse(drafts[list.key]);
    if ("error" in parsed) {
      setInvalid({ ...invalid, [list.key]: parsed.error });
      return;
    }
    setInvalid({ ...invalid, [list.key]: undefined });
    if (data[list.key].includes(parsed.value)) {
      setDrafts({ ...drafts, [list.key]: "" });
      return;
    }
    if (await save(list.key, [...data[list.key], parsed.value])) {
      setDrafts({ ...drafts, [list.key]: "" });
    }
  };

  return (
    <section
      className="space-y-3"
      data-testid="capability-admin-policy"
      aria-labelledby={`${baseId}-heading`}
    >
      <div>
        <h4 id={`${baseId}-heading`} className="text-sm font-medium text-foreground">
          Policy
        </h4>
        <p className="text-xs text-muted-foreground">
          Organisation rules that win over every setup, toolkit and session choice. Nothing they
          match is fetched or delivered; a package already assigned somewhere shows{" "}
          <StatusBadge status="blocked-policy" /> there and is removed from machines on their next
          pass. Changes are recorded in Activity.
        </p>
      </div>
      {policy.state.status === "error" ? (
        <p className="text-xs text-rose-300" role="alert">
          {policy.state.message}
        </p>
      ) : null}
      {data === null ? (
        <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
      ) : (
        <div className="grid gap-3 md:grid-cols-2">
          {LISTS.map((list) => {
            const inputId = `${baseId}-${list.key}`;
            const hintId = `${inputId}-hint`;
            const invalidMessage = invalid[list.key];
            return (
              <div key={list.key} className="space-y-2 rounded-lg border border-zinc-800 p-3">
                <h5 className="text-xs font-medium text-foreground">{list.title}</h5>
                {data[list.key].length === 0 ? (
                  <p className="text-xs text-muted-foreground">{list.empty}</p>
                ) : (
                  <ul className="space-y-1" aria-label={list.title}>
                    {data[list.key].map((entry) => (
                      <li key={entry} className="flex min-w-0 items-center gap-2 text-xs">
                        <code className="min-w-0 flex-1 break-all text-foreground">{entry}</code>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-6 w-6 shrink-0 p-0"
                          disabled={busy}
                          aria-label={`Allow ${entry} again`}
                          title="Remove from the policy"
                          onClick={() =>
                            void save(
                              list.key,
                              data[list.key].filter((value) => value !== entry),
                            )
                          }
                        >
                          <X className="h-3.5 w-3.5" />
                        </Button>
                      </li>
                    ))}
                  </ul>
                )}
                <form
                  className="space-y-1"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void add(list);
                  }}
                >
                  <Label htmlFor={inputId} className="text-xs">
                    {list.inputLabel}
                  </Label>
                  <div className="flex gap-2">
                    <Input
                      id={inputId}
                      className="h-8 min-w-0 font-mono text-xs"
                      placeholder={list.placeholder}
                      value={drafts[list.key]}
                      aria-invalid={invalidMessage ? true : undefined}
                      aria-describedby={hintId}
                      onChange={(event) => {
                        setDrafts({ ...drafts, [list.key]: event.target.value });
                        if (invalidMessage) setInvalid({ ...invalid, [list.key]: undefined });
                      }}
                    />
                    <Button
                      type="submit"
                      size="sm"
                      variant="outline"
                      className="shrink-0"
                      disabled={busy || drafts[list.key].trim().length === 0}
                    >
                      <Plus className="h-3.5 w-3.5" /> Forbid
                    </Button>
                  </div>
                  <p
                    id={hintId}
                    className={
                      invalidMessage
                        ? "text-[11px] text-rose-300"
                        : "text-[11px] text-muted-foreground"
                    }
                  >
                    {invalidMessage ?? list.hint}
                  </p>
                </form>
              </div>
            );
          })}
        </div>
      )}
      {data && data.blocked.length > 0 ? <BlockedPackages data={data} /> : null}
      {error ? (
        <p className="text-xs text-rose-300" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}

function BlockedPackages({ data }: { data: CapabilityAdminPolicyView }) {
  return (
    <div className="space-y-1 rounded-lg border border-rose-500/20 p-3 text-xs">
      <h5 className="font-medium text-foreground">Blocked by policy now</h5>
      <ul className="space-y-1" aria-label="Packages blocked by policy">
        {data.blocked.map((entry) => (
          <li key={entry.packageId} className="flex flex-wrap items-center gap-2">
            <StatusBadge status="blocked-policy" />
            <span className="text-foreground">{entry.displayName}</span>
            <span className="text-muted-foreground">
              matches <code>{entry.entry}</code>
              {entry.assigned ? " · assigned in a setup" : " · in the library only"}
            </span>
          </li>
        ))}
      </ul>
      {data.blockedTruncated > 0 ? (
        <p className="text-muted-foreground">and {data.blockedTruncated} more.</p>
      ) : null}
    </div>
  );
}

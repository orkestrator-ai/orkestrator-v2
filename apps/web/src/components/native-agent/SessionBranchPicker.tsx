import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { GitBranch, Loader2 } from "lucide-react";
import { toast } from "sonner";
import type { NativeAgentSessionBranchList } from "@orkestrator/protocol/native-agent";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type BranchListState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; list: NativeAgentSessionBranchList };

function describeTime(timestamp: string): string {
  const time = Date.parse(timestamp);
  return Number.isFinite(time) ? new Date(time).toLocaleString() : "";
}

/**
 * Pi's other branches of this conversation, and a switch to each.
 *
 * A rewind keeps the turns it removes as a branch of the same Pi session file,
 * but the transcript only ever shows the active branch, so no row names them.
 * The list is read when the picker opens (never polled) and again after a
 * switch, from the bridge's view of Pi's own tree.
 */
export function SessionBranchPicker({
  agentLabel,
  disabled,
  listBranches,
  switchBranch,
}: {
  agentLabel: string;
  disabled: boolean;
  listBranches: () => Promise<NativeAgentSessionBranchList>;
  switchBranch: (entryId: string) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<BranchListState>({ kind: "idle" });
  const [switching, setSwitching] = useState<string | null>(null);
  const readRef = useRef(0);
  // The caller's reader may be a fresh function each render; reading through a
  // ref keeps the open effect from re-reading on every parent render.
  const listBranchesRef = useRef(listBranches);
  useLayoutEffect(() => {
    listBranchesRef.current = listBranches;
  }, [listBranches]);

  const load = useCallback(async () => {
    const read = ++readRef.current;
    setState({ kind: "loading" });
    try {
      const list = await listBranchesRef.current();
      if (read === readRef.current) setState({ kind: "ready", list });
    } catch (error) {
      if (read === readRef.current) {
        setState({
          kind: "error",
          message: error instanceof Error ? error.message : "Branches could not be read",
        });
      }
    }
  }, []);

  const toggle = () => {
    if (open) {
      // A late answer for a closed picker is dropped.
      readRef.current += 1;
      setOpen(false);
      return;
    }
    setOpen(true);
    void load();
  };

  const handleSwitch = async (entryId: string) => {
    setSwitching(entryId);
    try {
      await switchBranch(entryId);
      toast.success(`Switched ${agentLabel} to another branch`);
      await load();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "The branch switch failed");
    } finally {
      setSwitching(null);
    }
  };

  return (
    <>
      <Button
        variant="outline"
        size="sm"
        disabled={disabled}
        aria-expanded={open}
        onClick={toggle}
        className={cn("justify-start gap-2", open && "border-primary/40 bg-primary/5")}
      >
        <GitBranch className="h-3.5 w-3.5" />
        Branches
      </Button>
      {open ? (
        <div
          className="col-span-2 rounded-lg border border-border/70 bg-muted/20 p-2.5"
          data-testid="session-branch-picker"
        >
          {state.kind === "loading" || state.kind === "idle" ? (
            <p className="flex items-center gap-2 text-xs text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              Reading branches…
            </p>
          ) : state.kind === "error" ? (
            <div className="flex items-center justify-between gap-2">
              <p className="text-xs text-destructive">{state.message}</p>
              <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => void load()}>
                Retry
              </Button>
            </div>
          ) : state.list.branches.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              No other branches. Rewinding to an earlier prompt keeps the removed turns here.
            </p>
          ) : (
            <ul className="space-y-1.5" aria-label={`${agentLabel} branches`}>
              {state.list.branches.map((branch) => (
                <li
                  key={branch.entryId}
                  className="flex items-center gap-2 rounded-md border border-border/60 bg-background px-2 py-1.5"
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-xs font-medium" title={branch.prompt}>
                      {branch.prompt || "(no prompt)"}
                    </p>
                    <p className="text-[10px] text-muted-foreground">
                      {branch.entries} {branch.entries === 1 ? "entry" : "entries"}
                      {describeTime(branch.updatedAt) ? ` · ${describeTime(branch.updatedAt)}` : ""}
                    </p>
                  </div>
                  <Button
                    variant="secondary"
                    size="sm"
                    className="h-7 shrink-0 px-2 text-xs"
                    disabled={disabled || switching !== null}
                    aria-label={`Switch to the branch starting "${branch.prompt || "(no prompt)"}"`}
                    onClick={() => void handleSwitch(branch.entryId)}
                  >
                    {switching === branch.entryId ? "Switching…" : "Switch"}
                  </Button>
                </li>
              ))}
              {state.list.truncated ? (
                <li className="text-[10px] text-muted-foreground">
                  Only the newest branches are listed.
                </li>
              ) : null}
            </ul>
          )}
        </div>
      ) : null}
    </>
  );
}

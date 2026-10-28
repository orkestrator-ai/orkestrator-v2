import { useEffect, useState } from "react";
import { COMMAND_HANDOVER_PREVIEW_CHANGED } from "@orkestrator/protocol/command-nodes";
import { Loader2, ShieldAlert } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { reloadAfterConnectionChange } from "@/lib/client-platform";
import {
  loadHandoverPlan,
  onCommandHandoverRequest,
  runHandover,
  type HandoverPlan,
  type HandoverTarget,
} from "@/lib/command-handover";
import { MachineDot } from "./MachineDot";

type Plan = Extract<HandoverPlan, { kind: "plan" }>;

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function finish(target: HandoverTarget): void {
  if (window.orkestrator?.connections) reloadAfterConnectionChange();
  else if (target.address) window.location.assign(target.address);
  else window.location.reload();
}

/**
 * Making another machine the command node, from the machines menu or
 * Settings → Machines. When the new command node lacks machines the current
 * one has, the user chooses which go with it (all by default); otherwise it
 * happens at once. The window then follows the new command node.
 */
export function CommandHandoverDialog() {
  const [target, setTarget] = useState<HandoverTarget | null>(null);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [includeSelf, setIncludeSelf] = useState(true);
  const [busy, setBusy] = useState(false);

  useEffect(
    () =>
      onCommandHandoverRequest((next) => {
        setTarget(next);
        setPlan(null);
        setBusy(true);
      }),
    [],
  );

  const execute = async (
    current: HandoverTarget,
    currentPlan: Plan,
    keys: Set<string>,
    self: boolean,
  ) => {
    setBusy(true);
    try {
      const result = await runHandover(current, currentPlan, { keys, includeSelf: self });
      toast.success(`${currentPlan.preview.targetName} is now the command node`, {
        description: result?.needsCredential
          ? `${result.needsCredential} machine${result.needsCredential === 1 ? " needs" : "s need"} a token there.`
          : undefined,
      });
      finish(current);
    } catch (error) {
      toast.error("Could not change the command node", { description: errorText(error) });
      if (
        errorText(error).includes(COMMAND_HANDOVER_PREVIEW_CHANGED) ||
        errorText(error).includes("Target-side repair changes remain in place")
      ) {
        try {
          const updated = await loadHandoverPlan(current);
          if (updated.kind === "plan") {
            setPlan(updated);
            setChosen(new Set(updated.machines.map((machine) => machine.key)));
            setIncludeSelf(updated.preview.self.reachable);
          }
        } catch (refreshError) {
          toast.error("Could not refresh the handover", { description: errorText(refreshError) });
          setPlan(null);
          setTarget(null);
        }
      }
      setBusy(false);
    }
  };

  useEffect(() => {
    if (!target) return;
    let active = true;
    void loadHandoverPlan(target)
      .then(async (loaded) => {
        if (!active) return;
        if (loaded.kind === "already-command-node") {
          // Nothing to hand over: only the window moves.
          const api = window.orkestrator?.connections;
          if (api && target.connectionId) await api.use(target.connectionId);
          finish(target);
          return;
        }
        const keys = new Set(loaded.machines.map((machine) => machine.key));
        const selfChoice = loaded.preview.self.reachable;
        setPlan(loaded);
        setChosen(keys);
        setIncludeSelf(selfChoice);
        // Nothing to choose or clear: go ahead. A failure leaves the dialog open to retry.
        if (
          loaded.machines.length === 0 &&
          selfChoice &&
          loaded.repairs.length === 0 &&
          loaded.targetInspectionComplete
        ) {
          await execute(target, loaded, keys, true);
          return;
        }
        setBusy(false);
      })
      .catch((error: unknown) => {
        if (!active) return;
        toast.error("Could not change the command node", { description: errorText(error) });
        setTarget(null);
        setBusy(false);
      });
    return () => {
      active = false;
    };
  }, [target]);

  const close = () => {
    if (busy && plan) return;
    // A plan still loading is dropped by the effect's cleanup.
    setTarget(null);
    setPlan(null);
  };

  if (!target) return null;
  if (!plan) {
    return (
      <Dialog open onOpenChange={(open) => (open ? undefined : close())}>
        <DialogContent size="md" data-testid="command-handover-dialog">
          <DialogHeader>
            <DialogTitle>Make {target.name} the command node</DialogTitle>
            <DialogDescription className="flex items-center gap-2">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              Checking which machines it controls…
            </DialogDescription>
          </DialogHeader>
        </DialogContent>
      </Dialog>
    );
  }
  const { preview } = plan;
  const toggle = (key: string, checked: boolean) =>
    setChosen((current) => {
      const next = new Set(current);
      if (checked) next.add(key);
      else next.delete(key);
      return next;
    });

  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : close())}>
      <DialogContent size="md" data-testid="command-handover-dialog">
        <DialogHeader>
          <DialogTitle>Make {preview.targetName} the command node</DialogTitle>
          <DialogDescription>
            {preview.targetName} will control your machines, and this window will open on it.
            {plan.machines.length > 0 ? ` It does not have these yet. Bring them over?` : ""}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-1">
          <label className="flex items-center gap-3 rounded-md px-2 py-1.5 hover:bg-white/[0.04]">
            <Checkbox
              checked={includeSelf}
              disabled={!preview.self.reachable || busy}
              onCheckedChange={(value) => setIncludeSelf(value === true)}
              aria-label={`${preview.self.displayName}, the current command node`}
            />
            <MachineDot
              colorToken={preview.self.colorToken}
              machineName={preview.self.displayName}
            />
            <span className="min-w-0 flex-1 truncate text-sm">
              {preview.self.displayName}
              <span className="ml-2 text-xs text-muted-foreground">current command node</span>
            </span>
          </label>
          {plan.machines.map((machine) => (
            <label
              key={machine.key}
              className="flex items-center gap-3 rounded-md px-2 py-1.5 hover:bg-white/[0.04]"
            >
              <Checkbox
                checked={chosen.has(machine.key)}
                disabled={busy}
                onCheckedChange={(value) => toggle(machine.key, value === true)}
                aria-label={machine.name}
              />
              <MachineDot colorToken={machine.colorToken} machineName={machine.name} />
              <span className="min-w-0 flex-1 truncate text-sm">
                {machine.name}
                {machine.from === "device" ? (
                  <span className="ml-2 text-xs text-muted-foreground">saved on this device</span>
                ) : null}
                {machine.note ? (
                  <span className="ml-2 text-xs text-amber-300/80">{machine.note}</span>
                ) : null}
              </span>
            </label>
          ))}
        </div>

        {plan.repairs.length > 0 ? (
          <div
            className="flex gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 p-2 text-xs text-amber-100"
            data-testid="command-handover-repairs"
          >
            <ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <div className="space-y-1">
              <p>
                These repair changes remain on {preview.targetName} if a later handover step fails.
              </p>
              {plan.repairs.includes("forget-source-on-target") ? (
                <p>
                  {preview.targetName} lists {preview.self.displayName} as one of its own machines,
                  so neither can control the other. That entry on {preview.targetName} is removed
                  first.
                </p>
              ) : null}
              {plan.repairs.includes("allow-source-on-target") ? (
                <p>
                  {preview.self.displayName} was detached on {preview.targetName} earlier. It is
                  allowed again there first.
                </p>
              ) : null}
            </div>
          </div>
        ) : null}
        {!plan.targetInspectionComplete ? (
          <p role="status" className="text-xs text-muted-foreground">
            This device could not fully inspect {preview.targetName}. If repairs are discovered, you
            will review them before continuing.
          </p>
        ) : null}
        {!preview.self.reachable ? (
          <p className="flex gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 p-2 text-xs text-amber-100">
            <ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            {preview.self.displayName} has no web address {preview.targetName} can reach, so it
            cannot follow as one of its machines. Turn on Web client on {preview.self.displayName}{" "}
            to include it.
          </p>
        ) : null}
        <p className="text-xs text-muted-foreground">
          Their access tokens go to {preview.targetName} over the existing secure connection. Any
          command node controlling {preview.targetName} is detached.
        </p>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={close} disabled={busy}>
            Cancel
          </Button>
          <Button
            type="button"
            onClick={() => void execute(target, plan, chosen, includeSelf)}
            disabled={busy}
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            Make command node
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

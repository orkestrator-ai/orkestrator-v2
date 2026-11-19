/**
 * The reset preview: which stored value is removed, from which machine, what
 * becomes effective, which other fields share the stored value, and whether
 * running work is affected. It reads the machine's current settings when it
 * opens, and the reset only goes ahead while the stored value still matches
 * that preview; if it moved, the preview refreshes and asks again.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { AlertTriangle, Loader2 } from "lucide-react";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Z_FULLSCREEN_DIALOG } from "@/constants/z-index";
import * as backend from "@/lib/backend";
import { isSettingsCommandUnsupported } from "@/lib/portal/command-node-config";
import { SETTINGS_CATALOG } from "@/lib/settings-catalog/catalog";
import {
  formatSettingValue,
  presentSetting,
  settingsSharingKey,
} from "@/lib/settings-catalog/provenance";
import { SETTING_TIMING_LABELS, isInheritedSettingKey } from "@/lib/settings-catalog/scope";
import type { SettingDescriptor } from "@/lib/settings-catalog/types";
import type { GlobalConfig } from "@/types";
import { createLogger, formatLogError } from "@orkestrator/protocol/logger";
import { isWindowMachine } from "../account-machine";
import { useSettingsConfig } from "../settings-config";
import {
  draftIsClean,
  useSettingsDraft,
  useSettingsDraftRegistry,
  useSettingsExplain,
} from "./settings-explain";

const log = createLogger("web.settings");

interface Preview {
  /** The stored value the reset expects to remove. */
  readonly current: unknown;
  /** What the field shows now. */
  readonly effectiveNow: unknown;
}

type Phase =
  | { readonly kind: "loading" }
  | { readonly kind: "ready"; readonly preview: Preview; readonly changed: boolean }
  | { readonly kind: "resetting"; readonly preview: Preview }
  | {
      readonly kind: "failed";
      readonly message: string;
      readonly preview: Preview | null;
      /** The machine cannot reset at all; nothing was sent or nothing ran. */
      readonly unsupported?: boolean;
    };

const RUNNING_WORK_NOTE: Record<SettingDescriptor["appliesWhen"], string> = {
  immediately: "The change applies at once, including to work that is already running.",
  "new-sessions": "Agent sessions that are already running keep their current value.",
  "new-environments": "Existing environments keep their current value until they are rebuilt.",
  "new-terminals": "Open terminals keep their current value.",
  restart: "It takes effect after Orkestrator restarts on that machine.",
  "new-windows": "Open windows keep their current value.",
};

export function SettingResetDialog({
  descriptor,
  onClose,
}: {
  descriptor: SettingDescriptor | null;
  onClose: () => void;
}) {
  const explain = useSettingsExplain();
  const { setConfig, ready, config } = useSettingsConfig();
  const draft = useSettingsDraft();
  const draftRegistry = useSettingsDraftRegistry();
  const active = useRef(false);
  const pending = useRef(false);
  const canAdopt = () =>
    active.current && (!draftRegistry || draftIsClean(draftRegistry.getSnapshot()));
  const [phase, setPhase] = useState<Phase>({ kind: "loading" });
  const binding = descriptor?.value ?? null;
  const machine = explain?.machine;

  const readPreview = useCallback(async () => {
    if (!descriptor || !binding) throw new Error("Setting unavailable");
    const [fresh, sources] = await Promise.all([
      backend.getConfig(machine),
      backend.getSettingSources(machine),
    ]);
    const presentation = presentSetting(descriptor, fresh.global, sources);
    if (
      !presentation?.resettable ||
      !presentation.hasOverride ||
      (descriptor.availability &&
        !descriptor.availability.isAvailable({
          global: fresh.global,
          isWindowMachine: isWindowMachine(machine),
        }))
    ) {
      throw new Error("This setting cannot be reset on the selected machine");
    }
    const global = fresh.global as GlobalConfig & Record<string, unknown>;
    return { current: global[binding.key], effectiveNow: presentation.effective };
  }, [binding, descriptor, machine]);

  const fetchPreview = useCallback(
    async (changed: boolean, isCurrent: () => boolean) => {
      try {
        const preview = await readPreview();
        if (isCurrent()) setPhase({ kind: "ready", changed, preview });
      } catch (error) {
        if (isCurrent())
          setPhase({
            kind: "failed",
            message: error instanceof Error ? error.message : String(error),
            preview: null,
          });
      }
    },
    [readPreview],
  );

  useEffect(() => {
    active.current = true;
    let current = true;
    void Promise.resolve().then(() => fetchPreview(false, () => current));
    return () => {
      current = false;
      active.current = false;
    };
  }, [fetchPreview]);

  const loadPreview = (changed: boolean) => {
    setPhase({ kind: "loading" });
    return fetchPreview(changed, () => active.current);
  };

  if (!descriptor || !binding || !explain) return null;
  const owner = isInheritedSettingKey(binding.key)
    ? (explain.names.commandNode ?? explain.names.machine)
    : explain.names.machine;
  const sharing = settingsSharingKey(SETTINGS_CATALOG, descriptor).filter(
    (entry) => entry.id !== descriptor.id,
  );
  const preview = phase.kind === "loading" ? null : phase.preview;

  const available =
    ready &&
    (!descriptor.availability ||
      descriptor.availability.isAvailable({
        global: config.global,
        isWindowMachine: isWindowMachine(machine),
      }));
  const confirm = async () => {
    if (phase.kind !== "ready" || pending.current || !available || !canAdopt()) return;
    pending.current = true;
    const expected = phase.preview.current;
    setPhase({ kind: "resetting", preview: phase.preview });
    try {
      const outcome = await backend.resetGlobalSettings(
        [binding.key],
        [
          expected === undefined
            ? { key: binding.key, present: false }
            : { key: binding.key, present: true, value: expected },
        ],
        machine,
      );
      log.info("reset.finished", { outcome: outcome.status, section: descriptor.section });
      if (!active.current) return;
      if (outcome.status === "conflict") {
        // The stored value moved after the preview: show the new one and ask again.
        if (canAdopt()) setConfig(outcome.config);
        await loadPreview(true);
        return;
      }
      if (canAdopt()) setConfig(outcome.config);
      explain.refreshSources();
      toast.success(`${descriptor.label} reset`, {
        description: `Now ${formatSettingValue(descriptor, binding.read(outcome.config.global))}. ${SETTING_TIMING_LABELS[descriptor.appliesWhen]}.`,
      });
      onClose();
    } catch (error) {
      const unsupported = isSettingsCommandUnsupported(error, "reset_global_settings");
      log.warn("reset.finished", {
        outcome: unsupported ? "unsupported" : "failed",
        error: formatLogError(error),
      });
      if (!active.current) return;
      setPhase({
        kind: "failed",
        message: unsupported
          ? `${owner} runs an older Orkestrator that cannot reset settings from here; nothing was changed. Update it, or set the value in the field`
          : error instanceof Error
            ? error.message
            : String(error),
        preview: phase.preview,
        unsupported,
      });
    } finally {
      pending.current = false;
    }
  };

  return (
    <AlertDialog open onOpenChange={(open) => !open && !pending.current && onClose()}>
      <AlertDialogContent
        className={Z_FULLSCREEN_DIALOG}
        overlayClassName={Z_FULLSCREEN_DIALOG}
        onEscapeKeyDown={(event) => {
          if (pending.current) event.preventDefault();
        }}
      >
        <AlertDialogHeader>
          <AlertDialogTitle>Reset {descriptor.label}?</AlertDialogTitle>
          <AlertDialogDescription>
            This removes the value stored on <strong>{owner}</strong>, so it follows the default
            again.
            {isInheritedSettingKey(binding.key)
              ? " Every machine it controls inherits the result."
              : ""}
          </AlertDialogDescription>
        </AlertDialogHeader>

        {phase.kind === "loading" ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
            Reading the current value…
          </div>
        ) : null}

        {preview ? (
          <dl
            className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm"
            data-testid="reset-preview"
          >
            <dt className="text-muted-foreground">Now</dt>
            <dd>{formatSettingValue(descriptor, preview.effectiveNow)}</dd>
            <dt className="text-muted-foreground">After reset</dt>
            <dd>{formatSettingValue(descriptor, binding.defaultValue)} (default)</dd>
            {sharing.length > 0 ? (
              <>
                <dt className="text-muted-foreground">Also resets</dt>
                <dd>{sharing.map((entry) => entry.label).join(", ")}</dd>
              </>
            ) : null}
            <dt className="text-muted-foreground">Running work</dt>
            <dd>{RUNNING_WORK_NOTE[descriptor.appliesWhen]}</dd>
          </dl>
        ) : null}

        {phase.kind === "ready" && phase.changed ? (
          <p role="alert" className="flex items-start gap-1.5 text-xs text-amber-300">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            The value changed since you opened this preview, so nothing was reset. Check the values
            above and confirm again.
          </p>
        ) : null}
        {phase.kind === "failed" ? (
          <p role="alert" className="text-xs text-failure">
            {phase.unsupported
              ? `${phase.message}.`
              : `Could not confirm the reset: ${phase.message}. It was not retried. Check again to read the current value before deciding.`}
          </p>
        ) : null}

        <AlertDialogFooter>
          <AlertDialogCancel disabled={phase.kind === "resetting"}>Cancel</AlertDialogCancel>
          {phase.kind === "failed" ? (
            <Button type="button" variant="outline" onClick={() => void loadPreview(false)}>
              Check again
            </Button>
          ) : (
            <Button
              type="button"
              variant="destructive"
              disabled={phase.kind !== "ready" || !available || !draftIsClean(draft)}
              onClick={() => void confirm()}
            >
              {phase.kind === "resetting" ? (
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
              ) : null}
              Reset to default
            </Button>
          )}
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

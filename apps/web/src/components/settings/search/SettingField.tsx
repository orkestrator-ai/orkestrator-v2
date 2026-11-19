/**
 * A catalogued setting's place on its page: the anchor search navigates to
 * (`data-setting-anchor`) and, under the field's own controls, the
 * explanation of its effective value. The field keeps its own editor,
 * validation and save; this only wraps it.
 */
import type { ComponentProps, ReactNode } from "react";
import { AlertCircle, Info, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { settingDescriptor } from "@/lib/settings-catalog/catalog";
import {
  describeSource,
  formatSettingValue,
  presentSetting,
} from "@/lib/settings-catalog/provenance";
import { SETTING_TIMING_LABELS, settingScope } from "@/lib/settings-catalog/scope";
import { cn } from "@/lib/utils";
import { isWindowMachine } from "../account-machine";
import { useSettingsConfig } from "../settings-config";
import {
  draftIsClean,
  useSettingsDraft,
  useSettingsDraftRegistry,
  useSettingsExplain,
} from "./settings-explain";

export function SettingField({
  setting,
  children,
  explain = true,
  explanationClassName,
  ...props
}: Omit<ComponentProps<"div">, "children"> & {
  setting: string;
  children: ReactNode;
  /** Off where another field's explanation already covers this one. */
  explain?: boolean;
  /** Aligns the explanation with a padded row, e.g. inside a settings card. */
  explanationClassName?: string;
}) {
  return (
    <div data-setting-anchor={setting} {...props}>
      {children}
      {explain ? <SettingExplanation setting={setting} className={explanationClassName} /> : null}
    </div>
  );
}

/** The anchor's id for a setting, for `aria-describedby`. */
export function settingExplanationId(setting: string): string {
  return `setting-explanation-${setting.replace(/[^a-z0-9-]/gi, "-")}`;
}

/** "Effective: On · Set on Studio · Applies to new agent sessions" and its actions. */
export function SettingExplanation({
  setting,
  className,
}: {
  setting: string;
  className?: string;
}) {
  const descriptor = settingDescriptor(setting);
  const explain = useSettingsExplain();
  const draft = useSettingsDraft();
  const registry = useSettingsDraftRegistry();
  const { config, ready } = useSettingsConfig();
  if (!descriptor || !explain) return null;
  const global = config.global;
  const timing = SETTING_TIMING_LABELS[descriptor.appliesWhen];
  const scope = settingScope(descriptor);
  const key = descriptor.value?.key;
  const dirty = key ? draft.dirtyKeys.includes(key) : false;
  const unconfirmed = !!key && draft.unconfirmedKeys?.includes(key);
  const failed = (dirty || unconfirmed) && draft.errorMessage !== null;
  const presentation = presentSetting(
    descriptor,
    global,
    explain.sources,
    isWindowMachine(explain.machine),
  );

  let summary: ReactNode;
  if (descriptor.sensitive) {
    const configured = descriptor.configured?.(global);
    summary =
      configured === undefined ? (
        <span>Stored securely; never shown here</span>
      ) : (
        <span>{configured ? `Configured on ${explain.names.machine}` : "Not configured"}</span>
      );
  } else if (scope === "window") {
    summary = <span>Kept by this window only</span>;
  } else if (!presentation) {
    summary = (
      <span>
        {scope === "machine"
          ? `Stored on ${explain.names.machine}`
          : `Stored on ${explain.names.commandNode ?? explain.names.machine}`}
      </span>
    );
  } else {
    summary = (
      <>
        <span>
          Effective:{" "}
          <span className="font-medium text-zinc-300">
            {formatSettingValue(descriptor, presentation.effective)}
          </span>
        </span>
        <span aria-hidden="true">·</span>
        <span>{describeSource(presentation.source, explain.names, descriptor)}</span>
        {presentation.hasOverride ? (
          <OverrideBadge differs={presentation.isDifferentFromDefault} />
        ) : presentation.hasOverride === false && presentation.isDifferentFromDefault ? (
          <OverrideBadge differs nothingStored />
        ) : null}
      </>
    );
  }

  const canReset =
    ready &&
    presentation?.resettable === true &&
    presentation.hasOverride === true &&
    !dirty &&
    (!descriptor.availability ||
      descriptor.availability.isAvailable({
        global,
        isWindowMachine: isWindowMachine(explain.machine),
      }));
  const formBusy = !draftIsClean(draft);

  return (
    <div
      id={settingExplanationId(setting)}
      data-setting-explanation={setting}
      className={cn(
        "mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] leading-relaxed text-muted-foreground",
        className,
      )}
    >
      <Info className="h-3 w-3 shrink-0 text-zinc-500" aria-hidden="true" />
      {dirty && !failed ? (
        <span className="text-zinc-300">
          Unsaved change{draft.saving ? " — saving…" : ""}
          {presentation
            ? `; ${formatSettingValue(descriptor, presentation.effective)} applies until it saves`
            : ""}
        </span>
      ) : null}
      {failed ? (
        <span role="alert" className="flex items-center gap-1 text-failure">
          <AlertCircle className="h-3 w-3" aria-hidden="true" />
          {draft.errorMessage} Your edit is kept.
          {registry ? (
            <Button
              type="button"
              variant="link"
              size="sm"
              className="h-auto p-0 text-[11px]"
              onClick={() => registry.retrySave()}
            >
              {unconfirmed ? "Check saved values" : "Retry"}
            </Button>
          ) : null}
          {registry && unconfirmed ? (
            <Button
              type="button"
              variant="link"
              size="sm"
              className="h-auto p-0 text-[11px]"
              onClick={() => registry.retrySave(true)}
            >
              Use saved values
            </Button>
          ) : null}
        </span>
      ) : null}
      {!dirty ? summary : null}
      <span aria-hidden="true">·</span>
      <span>{timing}</span>
      {canReset ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-6 gap-1 px-1.5 text-[11px] text-muted-foreground hover:text-foreground"
          disabled={formBusy}
          title={formBusy ? "Wait until your other changes have saved." : undefined}
          aria-label={`Reset ${descriptor.label} to default`}
          onClick={() => explain.requestReset(descriptor)}
        >
          <RotateCcw className="h-3 w-3" aria-hidden="true" />
          Reset to default…
        </Button>
      ) : null}
    </div>
  );
}

export function OverrideBadge({
  differs,
  nothingStored = false,
}: {
  differs: boolean;
  nothingStored?: boolean;
}) {
  return (
    <span
      className={cn(
        "rounded-full border px-1.5 py-px font-mono text-[10px] uppercase tracking-wider",
        nothingStored
          ? "border-zinc-700 text-muted-foreground"
          : differs
            ? "border-blue-500/40 bg-blue-500/10 text-blue-300"
            : "border-zinc-700 bg-zinc-900 text-zinc-300",
      )}
    >
      {nothingStored ? "Differs from default" : differs ? "Override" : "Override · same as default"}
    </span>
  );
}

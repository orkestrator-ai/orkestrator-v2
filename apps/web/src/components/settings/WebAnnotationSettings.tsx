import { useCallback, useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import {
  WEB_ANNOTATION_COMMANDS,
  WEB_ANNOTATION_ROLLOUT_MODES,
  type WebAnnotationRolloutMode,
  type WebAnnotationRolloutSnapshot,
} from "@orkestrator/protocol/web-annotations";
import { Label } from "@/components/ui/label";
import {
  classifyWebAnnotationError,
  describeWebAnnotationError,
  webAnnotationCommand,
} from "@/lib/web-annotations/client";
import { refreshAllWebAnnotationCapabilities } from "@/lib/web-annotations/sync";

const MODE_LABELS: Record<WebAnnotationRolloutMode, { title: string; detail: string }> = {
  enabled: {
    title: "Enabled",
    detail: "Capture notes, discuss them with agents, and request changes.",
  },
  "read-only": {
    title: "Read-only (recovery)",
    detail:
      "Read and resolve saved notes, keep drafts, and stop or recover requests already sent. Nothing new is captured or sent.",
  },
  disabled: {
    title: "Disabled",
    detail:
      "Hide web annotations everywhere. Saved notes are kept, and requests already sent still settle.",
  },
};

/**
 * Operator switch for the backend web annotation rollout. Changing it never
 * touches saved notes; an environment override on the backend wins.
 */
export function WebAnnotationSettings() {
  const [snapshot, setSnapshot] = useState<WebAnnotationRolloutSnapshot | null>(null);
  const [unsupported, setUnsupported] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setSnapshot(await webAnnotationCommand(WEB_ANNOTATION_COMMANDS.rollout, {}));
    } catch (loadError) {
      if (classifyWebAnnotationError(loadError) === "unsupported") setUnsupported(true);
      else setError(describeWebAnnotationError(loadError));
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const choose = async (mode: WebAnnotationRolloutMode) => {
    setSaving(true);
    setError(null);
    try {
      setSnapshot(await webAnnotationCommand(WEB_ANNOTATION_COMMANDS.rolloutSet, { mode }));
      refreshAllWebAnnotationCapabilities();
    } catch (saveError) {
      setError(describeWebAnnotationError(saveError));
    } finally {
      setSaving(false);
    }
  };

  if (unsupported) return null;
  return (
    <section
      className="space-y-3"
      aria-labelledby="web-annotation-settings-title"
      data-web-annotation-settings
    >
      <div>
        <h3 id="web-annotation-settings-title" className="text-sm font-semibold">
          Web page annotations
        </h3>
        <p className="text-xs text-muted-foreground">
          Notes captured in browser previews, for this backend.
        </p>
      </div>
      {!snapshot && !error ? (
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 motion-safe:animate-spin" aria-hidden /> Loading…
        </p>
      ) : null}
      {snapshot && (
        <div role="radiogroup" aria-label="Web annotation mode" className="space-y-2">
          {WEB_ANNOTATION_ROLLOUT_MODES.map((mode) => (
            <Label key={mode} className="flex cursor-pointer items-start gap-2 text-sm font-normal">
              <input
                type="radio"
                name="web-annotation-mode"
                className="mt-1"
                checked={snapshot.configured === mode}
                disabled={saving}
                onChange={() => void choose(mode)}
              />
              <span>
                <span className="font-medium">{MODE_LABELS[mode].title}</span>
                <span className="block text-xs text-muted-foreground">
                  {MODE_LABELS[mode].detail}
                </span>
              </span>
            </Label>
          ))}
          {snapshot.override && (
            <p className="text-xs text-amber-500" role="status">
              The backend environment forces “{MODE_LABELS[snapshot.override].title}”; this setting
              applies once that override is removed.
            </p>
          )}
        </div>
      )}
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
    </section>
  );
}

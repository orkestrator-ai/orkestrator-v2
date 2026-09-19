import { useEffect, useRef, useState } from "react";
import { Loader2, Play, Volume2 } from "lucide-react";
import { toast } from "sonner";
import {
  normalizeNotificationSoundSettings,
  type NotificationSoundSettings,
} from "@orkestrator/protocol/notification-sounds";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import * as backend from "@/lib/backend";
import { playNotificationSound, type NotificationSoundKind } from "@/lib/notification-sounds";
import { useConfigStore } from "@/stores/configStore";

export function SoundsSettings() {
  const storedSettings = useConfigStore((state) => state.config.global.notificationSounds);
  const setConfig = useConfigStore((state) => state.setConfig);
  const updateGlobalConfig = useConfigStore((state) => state.updateGlobalConfig);
  const [settings, setSettings] = useState<NotificationSoundSettings>(() =>
    normalizeNotificationSoundSettings(storedSettings),
  );
  const [saving, setSaving] = useState(false);
  const saveGenerationRef = useRef(0);
  const saveQueueRef = useRef<Promise<void>>(Promise.resolve());

  useEffect(() => {
    if (!saving) setSettings(normalizeNotificationSoundSettings(storedSettings));
  }, [saving, storedSettings]);

  const updateSettings = (next: NotificationSoundSettings) => {
    const generation = ++saveGenerationRef.current;
    setSettings(next);
    setSaving(true);
    // Keep root-level notification services in sync immediately. Persistence
    // is serialized below so fast toggles cannot land at the backend out of order.
    updateGlobalConfig({ notificationSounds: next });
    saveQueueRef.current = saveQueueRef.current
      .catch(() => undefined)
      .then(async () => {
        const global = useConfigStore.getState().config.global;
        const savedConfig = await backend.updateGlobalConfig({
          ...global,
          notificationSounds: next,
        });
        if (generation === saveGenerationRef.current) setConfig(savedConfig);
      })
      .catch(async (error) => {
        if (generation !== saveGenerationRef.current) return;
        toast.error("Sound settings were not saved", {
          description: error instanceof Error ? error.message : String(error),
        });
        try {
          const config = await backend.getConfig();
          setConfig(config);
          setSettings(normalizeNotificationSoundSettings(config.global.notificationSounds));
        } catch {
          // The config resource stream will reconcile the optimistic state.
        }
      })
      .finally(() => {
        if (generation === saveGenerationRef.current) setSaving(false);
      });
  };

  const preview = async (kind: NotificationSoundKind) => {
    const played = await playNotificationSound(kind);
    if (!played) {
      toast.error("Sound could not be played", {
        description: "Check this device's audio output and browser playback permissions.",
      });
    }
  };

  return (
    <div className="mx-auto max-w-2xl space-y-8 pb-8">
      <div>
        <div className="flex items-center gap-2">
          <div className="flex h-8 w-8 items-center justify-center rounded-md bg-cyan-400/10 text-cyan-400">
            <Volume2 className="h-4 w-4" aria-hidden="true" />
          </div>
          <h2 className="text-xl font-semibold">Sounds</h2>
        </div>
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
          Play distinct cues for work that finishes in the background. Existing notifications are
          not replayed when Orkestrator starts or reconnects.
        </p>
      </div>

      <div className="divide-y divide-zinc-800 rounded-lg border border-zinc-800 bg-zinc-950/40">
        <SoundRow
          label="Agent stopped"
          description="Play a cue when an environment raises the same completed-activity indicator as the bell icon."
          enabled={settings.agentStopped}
          onEnabledChange={(agentStopped) => updateSettings({ ...settings, agentStopped })}
          onPreview={() => void preview("agent-stopped")}
        />
        <SoundRow
          label="Pull request merged"
          description="Play a different cue when GitHub confirms that a monitored pull request was merged."
          enabled={settings.prMerged}
          onEnabledChange={(prMerged) => updateSettings({ ...settings, prMerged })}
          onPreview={() => void preview("pr-merged")}
        />
      </div>

      <div className="flex h-5 items-center gap-2 text-xs text-muted-foreground" aria-live="polite">
        {saving && (
          <>
            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
            Saving…
          </>
        )}
      </div>
    </div>
  );
}

function SoundRow({
  label,
  description,
  enabled,
  onEnabledChange,
  onPreview,
}: {
  label: string;
  description: string;
  enabled: boolean;
  onEnabledChange: (enabled: boolean) => void;
  onPreview: () => void;
}) {
  return (
    <div className="flex flex-col gap-4 p-4 sm:flex-row sm:items-center sm:justify-between sm:gap-6">
      <div>
        <Label className="text-sm">{label}</Label>
        <p className="mt-1 max-w-md text-xs leading-relaxed text-muted-foreground">{description}</p>
      </div>
      <div className="flex shrink-0 items-center gap-3">
        <Button variant="outline" size="sm" onClick={onPreview} aria-label={`Preview ${label}`}>
          <Play className="h-3.5 w-3.5" aria-hidden="true" />
          Preview
        </Button>
        <Switch checked={enabled} onCheckedChange={onEnabledChange} aria-label={`${label} sound`} />
      </div>
    </div>
  );
}

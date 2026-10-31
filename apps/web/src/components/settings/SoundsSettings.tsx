import { useEffect, useMemo, useRef, useState } from "react";
import { Loader2, Play } from "lucide-react";
import { toast } from "sonner";
import {
  normalizeNotificationSoundSettings,
  type NotificationSoundSettings,
} from "@orkestrator/protocol/notification-sounds";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import * as backend from "@/lib/backend";
import { playNotificationSound, type NotificationSoundKind } from "@/lib/notification-sounds";
import { useConfigStore } from "@/stores/configStore";
import { isWindowMachine, useAccountMachine } from "./account-machine";
import { useSettingsConfig } from "./settings-config";
import { SETTINGS_CARD_CLASS, SettingsPageLayout, SettingsRow } from "./SettingsPageLayout";
import { cn } from "@/lib/utils";

export function SoundsSettings() {
  const { machine } = useAccountMachine();
  const { config: settingsConfig, setConfig } = useSettingsConfig();
  const storedSettings = settingsConfig.global.notificationSounds;
  const updateGlobalConfig = useConfigStore((state) => state.updateGlobalConfig);
  const savedSettings = useMemo(
    () => normalizeNotificationSoundSettings(storedSettings),
    [storedSettings],
  );
  // The optimistic value while a save is in flight; otherwise the stored config wins.
  const [pendingSettings, setSettings] = useState<NotificationSoundSettings>(savedSettings);
  const [saving, setSaving] = useState(false);
  const settings = saving ? pendingSettings : savedSettings;
  const settingsRef = useRef(settings);
  const saveGenerationRef = useRef(0);
  const saveQueueRef = useRef<Promise<void>>(Promise.resolve());

  useEffect(() => {
    if (!saving) settingsRef.current = savedSettings;
  }, [saving, savedSettings]);

  const updateSettings = (updates: Partial<NotificationSoundSettings>) => {
    const next = { ...settingsRef.current, ...updates };
    settingsRef.current = next;
    const generation = ++saveGenerationRef.current;
    setSettings(next);
    setSaving(true);
    // Keep root-level notification services in sync immediately. Persistence
    // is serialized below so fast toggles cannot land at the backend out of order.
    // Another machine's preference is not this window's.
    if (isWindowMachine(machine)) updateGlobalConfig({ notificationSounds: next });
    const previousSave = saveQueueRef.current;
    const queuedSave = (async () => {
      try {
        await previousSave;
      } catch {
        // A failed older generation must not block the latest preference.
      }
      try {
        const savedConfig = await backend.updateNotificationSoundSettings(next, machine);
        if (generation === saveGenerationRef.current) setConfig(savedConfig);
      } catch (error) {
        if (generation !== saveGenerationRef.current) return;
        toast.error("Sound settings were not saved", {
          description: error instanceof Error ? error.message : String(error),
        });
        try {
          const config = await backend.getConfig(machine);
          setConfig(config);
          const restored = normalizeNotificationSoundSettings(config.global.notificationSounds);
          settingsRef.current = restored;
          setSettings(restored);
        } catch {
          // The config resource stream will reconcile the optimistic state.
        }
      } finally {
        if (generation === saveGenerationRef.current) setSaving(false);
      }
    })();
    saveQueueRef.current = queuedSave;
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
    <SettingsPageLayout
      title="Sounds"
      description="Play distinct cues for work that finishes in the background. Existing notifications are not replayed when Orkestrator starts or reconnects."
    >
      <div className={cn(SETTINGS_CARD_CLASS, "divide-y divide-zinc-800")}>
        <SoundRow
          label="Agent stopped"
          description="Play a cue when an environment raises the same completed-activity indicator as the bell icon."
          enabled={settings.agentStopped}
          onEnabledChange={(agentStopped) => updateSettings({ agentStopped })}
          onPreview={() => void preview("agent-stopped")}
        />
        <SoundRow
          label="Pull request merged"
          description="Play a different cue when GitHub confirms that a monitored pull request was merged."
          enabled={settings.prMerged}
          onEnabledChange={(prMerged) => updateSettings({ prMerged })}
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
    </SettingsPageLayout>
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
    <SettingsRow label={label} description={description}>
      <Button variant="outline" size="sm" onClick={onPreview} aria-label={`Preview ${label}`}>
        <Play className="h-3.5 w-3.5" aria-hidden="true" />
        Preview
      </Button>
      <Switch checked={enabled} onCheckedChange={onEnabledChange} aria-label={`${label} sound`} />
    </SettingsRow>
  );
}

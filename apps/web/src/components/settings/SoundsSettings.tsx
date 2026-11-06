import { useEffect, useMemo, useRef, useState } from "react";
import { BellRing, Loader2, Play } from "lucide-react";
import { toast } from "sonner";
import {
  normalizeNotificationSoundSettings,
  type NotificationSoundSettings,
} from "@orkestrator/protocol/notification-sounds";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import * as backend from "@/lib/backend";
import { playNotificationSound, type NotificationSoundKind } from "@/lib/notification-sounds";
import {
  desktopNotificationPermission,
  requestDesktopNotificationPermission,
  type DesktopNotificationPermission,
} from "@/lib/question-desktop-notification";
import { useConfigStore } from "@/stores/configStore";
import { isWindowMachine, useAccountMachine } from "./account-machine";
import { useSettingsConfig } from "./settings-config";
import {
  SETTINGS_CARD_CLASS,
  SettingsPageLayout,
  SettingsRow,
  SettingsSectionHeader,
} from "./SettingsPageLayout";
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
  // This device's own grant: the setting syncs, the browser permission does not.
  const [permission, setPermission] = useState<DesktopNotificationPermission>(() =>
    desktopNotificationPermission(),
  );
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

  const allowNotifications = async () => {
    const result = await requestDesktopNotificationPermission();
    setPermission(result);
    if (result === "denied") {
      toast.error("Desktop notifications are blocked", {
        description: "Allow notifications for this site in the browser's settings.",
      });
    }
  };

  const updateQuestionNotification = (questionDesktopNotification: boolean) => {
    updateSettings({ questionDesktopNotification });
    // Turning it on is the gesture a browser needs before it will ask.
    if (questionDesktopNotification && permission === "default") void allowNotifications();
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
      description="Play distinct cues for work that finishes in the background, and alert you when an agent needs your answer. Existing notifications are not replayed when Orkestrator starts or reconnects."
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
          label="Agent question"
          description="Play a different, more urgent cue when an agent asks a question or stops for your approval, unless you are looking at that environment."
          enabled={settings.agentQuestion}
          onEnabledChange={(agentQuestion) => updateSettings({ agentQuestion })}
          onPreview={() => void preview("agent-question")}
        />
        <SoundRow
          label="Pull request merged"
          description="Play a different cue when GitHub confirms that a monitored pull request was merged."
          enabled={settings.prMerged}
          onEnabledChange={(prMerged) => updateSettings({ prMerged })}
          onPreview={() => void preview("pr-merged")}
        />
        <SoundRow
          label="Coordinator report"
          description="Play a cue when a coordinator is woken by a worker it was waiting on, unless that coordinator is on screen."
          enabled={settings.coordinatorReport}
          onEnabledChange={(coordinatorReport) => updateSettings({ coordinatorReport })}
          onPreview={() => void preview("coordinator-report")}
        />
      </div>

      <section aria-labelledby="desktop-notifications-heading" className="space-y-3">
        <SettingsSectionHeader
          headingId="desktop-notifications-heading"
          title="Desktop notifications"
          icon={<BellRing className="h-4 w-4 text-muted-foreground" aria-hidden="true" />}
        >
          Questions block an agent until you answer, so they can also raise a notification outside
          Orkestrator. Clicking it opens the environment.
        </SettingsSectionHeader>
        <div className={SETTINGS_CARD_CLASS}>
          <SettingsRow
            label="Agent questions"
            description={
              <>
                Show a desktop notification when an agent asks a question or waits for your
                approval, unless that environment is on screen and this window has focus.
                <NotificationPermissionNote permission={permission} />
              </>
            }
          >
            {settings.questionDesktopNotification && permission === "default" ? (
              <Button variant="outline" size="sm" onClick={() => void allowNotifications()}>
                Allow notifications
              </Button>
            ) : null}
            <Switch
              checked={settings.questionDesktopNotification}
              onCheckedChange={updateQuestionNotification}
              aria-label="Agent questions desktop notification"
            />
          </SettingsRow>
        </div>
      </section>

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

function NotificationPermissionNote({ permission }: { permission: DesktopNotificationPermission }) {
  if (permission === "granted") return null;
  const note =
    permission === "unsupported"
      ? "This browser cannot show desktop notifications."
      : permission === "denied"
        ? "This browser has blocked notifications for Orkestrator; allow them in its site settings."
        : "This browser has not been allowed to show notifications yet.";
  return <span className="mt-1 block text-amber-400/90">{note}</span>;
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

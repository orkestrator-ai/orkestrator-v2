import { useEffect, useMemo, useState } from "react";
import { useFederation } from "@/components/federation/FederationProvider";
import { MachineDot } from "@/components/federation/MachineDot";
import { useCommandNode } from "@/components/federation/useCommandNode";
import { useConfigStore } from "@/stores";
import * as backend from "@/lib/backend";
import { cn } from "@/lib/utils";
import {
  Loader2,
  Settings2,
  Terminal,
  Shield,
  Container,
  Bug,
  FlaskConical,
  Globe2,
  Eye,
  Sparkles,
  Boxes,
  SlidersHorizontal,
  Cable,
  CalendarClock,
  ShieldCheck,
  KeyRound,
  MessagesSquare,
  Network,
  MonitorPlay,
  Volume2,
  Server,
  HardDrive,
  ChartArea,
  GitBranch,
  Workflow,
  TrendingUp,
} from "lucide-react";
import { AgentPlatformIcon, DockerIcon } from "@/components/icons/AgentIcons";
import { DockerSettings } from "@/components/docker";
import { GlobalSettings } from "./GlobalSettings";
import { SkillsSettings } from "./SkillsSettings";
import { DiskUsageSettings } from "./DiskUsageSettings";
import { UsageSettings } from "./usage/UsageSettings";
import { McpSettings } from "./McpSettings";
import { ProviderMcpSettings } from "./mcp-servers/ProviderMcpSettings";
import { FullscreenSettingsLayout, type SettingsMenuItem } from "./FullscreenSettingsLayout";
import { MessagingSettings } from "./MessagingSettings";
import { MachinesSettings } from "./machines/MachinesSettings";
import { SoundsSettings } from "./SoundsSettings";
import { SchedulesSettings } from "./SchedulesSettings";
import { SelfImprovementSettings } from "./SelfImprovementSettings";
import { PermissionsSettings } from "./PermissionsSettings";
import { CredentialsSettings } from "./CredentialsSettings";
import { SETTINGS_PAGE_DEFAULT_WIDTH_CLASS } from "./SettingsPageLayout";
import {
  AccountMachineProvider,
  useAccountMachineStore,
  useResolvedAccountMachine,
} from "./account-machine";
import { MachineConfigProvider } from "./settings-config";
import { SettingsMachineStrip } from "./SettingsMachineStrip";
import type { GlobalSettingsSection } from "@/lib/settings-navigation";
import {
  globalSettingsLabel,
  isCommandNodeSettingsSection,
  isGlobalSettingsSectionEnabled,
} from "@/lib/settings-catalog";
import { createLogger, formatLogError } from "@orkestrator/protocol/logger";

const log = createLogger("web.settings");

const MENU_ITEMS: SettingsMenuItem<GlobalSettingsSection>[] = [
  { id: "general", label: globalSettingsLabel("general"), icon: <Settings2 className="h-4 w-4" /> },
  {
    id: "version-control",
    label: globalSettingsLabel("version-control"),
    icon: <GitBranch className="h-4 w-4" />,
  },
  { id: "machines", label: globalSettingsLabel("machines"), icon: <Network className="h-4 w-4" /> },
  {
    id: "disk-usage",
    label: globalSettingsLabel("disk-usage"),
    icon: <HardDrive className="h-4 w-4" />,
  },
  { id: "usage", label: globalSettingsLabel("usage"), icon: <ChartArea className="h-4 w-4" /> },
  {
    id: "defaults",
    label: globalSettingsLabel("defaults"),
    icon: <SlidersHorizontal className="h-4 w-4" />,
  },
  { id: "platforms", label: globalSettingsLabel("platforms"), icon: <Boxes className="h-4 w-4" /> },
  {
    id: "coordinator",
    label: globalSettingsLabel("coordinator"),
    icon: <Workflow className="h-4 w-4" />,
  },
  { id: "review", label: globalSettingsLabel("review"), icon: <Eye className="h-4 w-4" /> },
  {
    id: "claude",
    label: globalSettingsLabel("claude"),
    icon: <AgentPlatformIcon platform="claude" accent className="h-4 w-4" />,
  },
  {
    id: "codex",
    label: globalSettingsLabel("codex"),
    icon: <AgentPlatformIcon platform="codex" accent className="h-4 w-4" />,
  },
  {
    id: "cursor",
    label: globalSettingsLabel("cursor"),
    icon: <AgentPlatformIcon platform="cursor" accent className="h-4 w-4" />,
  },
  {
    id: "grok",
    label: globalSettingsLabel("grok"),
    icon: <AgentPlatformIcon platform="grok" accent className="h-4 w-4" />,
  },
  {
    id: "opencode",
    label: globalSettingsLabel("opencode"),
    icon: <AgentPlatformIcon platform="opencode" accent className="h-4 w-4" />,
  },
  {
    id: "pi",
    label: globalSettingsLabel("pi"),
    icon: <AgentPlatformIcon platform="pi" accent className="h-4 w-4" />,
  },
  { id: "skills", label: globalSettingsLabel("skills"), icon: <Sparkles className="h-4 w-4" /> },
  {
    id: "terminal",
    label: globalSettingsLabel("terminal"),
    icon: <Terminal className="h-4 w-4" />,
  },
  { id: "network", label: globalSettingsLabel("network"), icon: <Shield className="h-4 w-4" /> },
  {
    id: "web-client",
    label: globalSettingsLabel("web-client"),
    icon: <Globe2 className="h-4 w-4" />,
  },
  {
    id: "previews",
    label: globalSettingsLabel("previews"),
    icon: <MonitorPlay className="h-4 w-4" />,
  },
  {
    id: "mcp-servers",
    label: globalSettingsLabel("mcp-servers"),
    icon: <Server className="h-4 w-4" />,
  },
  { id: "mcp", label: globalSettingsLabel("mcp"), icon: <Cable className="h-4 w-4" /> },
  {
    id: "messaging",
    label: globalSettingsLabel("messaging"),
    icon: <MessagesSquare className="h-4 w-4" />,
  },
  {
    id: "schedules",
    label: globalSettingsLabel("schedules"),
    icon: <CalendarClock className="h-4 w-4" />,
  },
  {
    id: "self-improvement",
    label: globalSettingsLabel("self-improvement"),
    icon: <TrendingUp className="h-4 w-4" />,
  },
  {
    id: "permissions",
    label: globalSettingsLabel("permissions"),
    icon: <ShieldCheck className="h-4 w-4" />,
  },
  {
    id: "credentials",
    label: globalSettingsLabel("credentials"),
    icon: <KeyRound className="h-4 w-4" />,
  },
  { id: "sounds", label: globalSettingsLabel("sounds"), icon: <Volume2 className="h-4 w-4" /> },
  { id: "docker", label: globalSettingsLabel("docker"), icon: <DockerIcon className="h-4 w-4" /> },
  {
    id: "container",
    label: globalSettingsLabel("container"),
    icon: <Container className="h-4 w-4" />,
  },
  {
    id: "experimental",
    label: globalSettingsLabel("experimental"),
    icon: <FlaskConical className="h-4 w-4" />,
  },
  { id: "debug", label: globalSettingsLabel("debug"), icon: <Bug className="h-4 w-4" /> },
];

interface SettingsPageProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  defaultSection?: GlobalSettingsSection;
  /** Changes on every section request; see FullscreenSettingsLayout. */
  sectionRequest?: number;
}

/** Names the owner of the settings and machine tools shown in this section. */
export function SettingsScopeBanner({
  section,
  machine,
}: {
  section: GlobalSettingsSection | "";
  /** The machine picked in the header; without one, the machine on screen. */
  machine?: { name: string; colorToken: string } | null;
}) {
  const { enabled, boundMachine } = useFederation();
  const commandNode = useCommandNode();
  if (!commandNode || !section || (!enabled && section !== "machines")) return null;
  const shownMachine = machine ?? boundMachine;
  const workspaceName = shownMachine?.name ?? commandNode.name;
  const inherited = section === "review" || section === "messaging";
  const mixed = [
    "general",
    "defaults",
    "terminal",
    "previews",
    "claude",
    "codex",
    "cursor",
    "grok",
    "opencode",
    "pi",
  ].includes(section);
  const ownerName = section === "machines" || inherited ? commandNode.name : workspaceName;
  return (
    <div
      className={cn(
        "mb-5 flex items-start gap-2 rounded-md border border-zinc-800 bg-zinc-950/40 px-3 py-2 text-xs text-zinc-400",
        SETTINGS_PAGE_DEFAULT_WIDTH_CLASS,
      )}
      data-testid="settings-scope"
    >
      <MachineDot
        colorToken={
          section === "machines" || inherited
            ? commandNode.colorToken
            : (shownMachine?.colorToken ?? commandNode.colorToken)
        }
        machineName={ownerName}
        className="mt-1"
      />
      <span>
        {section === "machines" ? (
          enabled ? (
            <>
              Command node: <strong>{commandNode.name}</strong>. These are the machines it controls.
            </>
          ) : (
            <>
              This window is on <strong>{commandNode.name}</strong>.
            </>
          )
        ) : inherited ? (
          <>
            Preferences for <strong>{commandNode.name}</strong>, inherited by work on every machine
            it controls.
          </>
        ) : mixed ? (
          <>
            Preferences come from <strong>{commandNode.name}</strong>. Machine-specific settings,
            accounts and tools belong to <strong>{workspaceName}</strong>.
          </>
        ) : (
          <>
            Machine settings for <strong>{workspaceName}</strong>. Changes apply to this machine.
          </>
        )}
      </span>
    </div>
  );
}

export function SettingsPage({
  open,
  onOpenChange,
  defaultSection,
  sectionRequest,
}: SettingsPageProps) {
  const setConfig = useConfigStore((state) => state.setConfig);
  const schedulingEnabled = useConfigStore(
    (state) => state.config.global.experimentalScheduling === true,
  );
  const selfImprovementEnabled = useConfigStore(
    (state) => state.config.global.experimentalSelfImprovement === true,
  );
  // Scheduling and self-improvement are experimental: each section exists only while it is on.
  const menuItems = useMemo(
    () =>
      MENU_ITEMS.filter((item) =>
        isGlobalSettingsSectionEnabled(item.id, {
          experimentalScheduling: schedulingEnabled,
          experimentalSelfImprovement: selfImprovementEnabled,
        }),
      ),
    [schedulingEnabled, selfImprovementEnabled],
  );
  const isLoading = useConfigStore((state) => state.isLoading);
  const setLoading = useConfigStore((state) => state.setLoading);
  const [initialLoadDone, setInitialLoadDone] = useState(false);
  const resolved = useResolvedAccountMachine();
  const choose = useAccountMachineStore((state) => state.choose);

  // Load config when page opens
  useEffect(() => {
    if (open && !initialLoadDone) {
      const loadConfig = async () => {
        setLoading(true);
        try {
          const config = await backend.getConfig();
          setConfig(config);
          setInitialLoadDone(true);
        } catch (err) {
          log.error("config.load-failed", { error: formatLogError(err) });
        } finally {
          setLoading(false);
        }
      };
      loadConfig();
    }
  }, [open, initialLoadDone, setConfig, setLoading]);

  return (
    <FullscreenSettingsLayout
      open={open}
      onOpenChange={onOpenChange}
      title="Settings"
      menuItems={menuItems}
      defaultSection={defaultSection}
      sectionRequest={sectionRequest}
      headerStart={
        resolved.options.length > 1
          ? (activeSection) => (
              <SettingsMachineStrip
                options={resolved.options}
                selected={resolved.machine}
                locked={isCommandNodeSettingsSection(activeSection)}
                onSelect={choose}
              />
            )
          : undefined
      }
    >
      {(activeSection) => {
        const locked = isCommandNodeSettingsSection(activeSection);
        const machine = locked ? null : resolved.machine;
        const option = resolved.options.find((candidate) => candidate.nodeId === machine);
        if (machine && !option) {
          return (
            <p className="p-5 text-sm text-muted-foreground" role="status">
              The selected machine is no longer available.
            </p>
          );
        }
        return (
          <MachineSettings key={machine ?? "command-node"} machine={machine} option={option}>
            <SettingsScopeBanner section={activeSection} machine={option} />
            {
              // Skills is a read-only browser of the host's skill directories, not a
              // config form, so it bypasses the auto-saving settings form.
              activeSection === "machines" ? (
                <MachinesSettings />
              ) : activeSection === "disk-usage" ? (
                <DiskUsageSettings />
              ) : activeSection === "usage" ? (
                <UsageSettings />
              ) : activeSection === "skills" ? (
                <SkillsSettings />
              ) : activeSection === "mcp" ? (
                <McpSettings />
              ) : activeSection === "mcp-servers" ? (
                <ProviderMcpSettings />
              ) : activeSection === "messaging" ? (
                <MessagingSettings />
              ) : activeSection === "schedules" && schedulingEnabled ? (
                <SchedulesSettings />
              ) : activeSection === "self-improvement" && selfImprovementEnabled ? (
                <SelfImprovementSettings />
              ) : activeSection === "permissions" ? (
                <PermissionsSettings />
              ) : activeSection === "credentials" ? (
                <CredentialsSettings />
              ) : activeSection === "docker" ? (
                <DockerSettings />
              ) : isLoading && !initialLoadDone ? (
                <div className="flex items-center justify-center py-12">
                  <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
                </div>
              ) : activeSection === "sounds" ? (
                <SoundsSettings />
              ) : (
                <GlobalSettings activeSection={activeSection} />
              )
            }
          </MachineSettings>
        );
      }}
    </FullscreenSettingsLayout>
  );
}

/**
 * Everything inside acts on `machine`. Its key remounts the sections per
 * machine, so nothing read from one machine stays on screen for another.
 */
export function MachineSettings({
  machine,
  option,
  children,
}: {
  machine: string | null;
  option: { name: string } | undefined;
  children: React.ReactNode;
}) {
  const value = useMemo(() => ({ machine, name: option?.name ?? null }), [machine, option?.name]);
  return (
    <AccountMachineProvider value={value}>
      <MachineConfigProvider machine={machine}>{children}</MachineConfigProvider>
    </AccountMachineProvider>
  );
}

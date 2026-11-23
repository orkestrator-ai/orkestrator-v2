import { Button } from "@/components/ui/button";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import { CapabilitiesSettings } from "./capabilities/CapabilitiesSettings";
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
  type AccountMachineOption,
  useAccountMachineStore,
  useResolvedAccountMachine,
} from "./account-machine";
import { MachineConfigProvider, useSettingsConfig } from "./settings-config";
import { SettingsMachineStrip } from "./SettingsMachineStrip";
import type { GlobalSettingsSection } from "@/lib/settings-navigation";
import { createLogger, formatLogError } from "@orkestrator/protocol/logger";
import {
  globalSettingsLabel,
  isCommandNodeSettingsSection,
  isGlobalSettingsSectionEnabled,
} from "@/lib/settings-catalog";
import { SETTINGS_CATALOG } from "@/lib/settings-catalog/catalog";
import type { SettingDescriptor } from "@/lib/settings-catalog/types";
import {
  draftIsClean,
  useSettingsExplain,
  SettingsDraftProvider,
  SettingsDraftRegistry,
  SettingsExplainProvider,
} from "./search/settings-explain";
import {
  SettingsSearchField,
  SettingsSearchResults,
  openWouldDiscardDraft,
  useSettingsSearchResults,
  type PendingOpen,
  type SettingsSearchTarget,
} from "./search/SettingsSearch";
import { SettingResetDialog } from "./search/SettingResetDialog";
import { SettingFieldNavigator, type PendingField } from "./search/SettingFieldNavigator";

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
  {
    id: "antigravity",
    label: globalSettingsLabel("antigravity"),
    icon: <AgentPlatformIcon platform="antigravity" accent className="h-4 w-4" />,
  },
  {
    id: "capabilities",
    label: globalSettingsLabel("capabilities"),
    icon: <Sparkles className="h-4 w-4" />,
  },
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
    "antigravity",
  ].includes(section);
  const fleet = section === "capabilities";
  const ownerName = section === "machines" || inherited || fleet ? commandNode.name : workspaceName;
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
          section === "machines" || inherited || fleet
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
        ) : fleet ? (
          <>
            Capabilities are managed by <strong>{commandNode.name}</strong> for every machine
            enrolled in My setup.
          </>
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

  // --- Search ---------------------------------------------------------------
  const [query, setQuery] = useState("");
  const [modifiedView, setModifiedView] = useState(false);
  const [navigation, setNavigation] = useState<{
    section: GlobalSettingsSection;
    seq: number;
  } | null>(null);
  const [pendingField, setPendingField] = useState<PendingField | null>(null);
  const [pendingConflict, setPendingConflict] = useState<PendingOpen | null>(null);
  const [resetTarget, setResetTarget] = useState<{
    descriptor: SettingDescriptor;
    machine: string | null;
  } | null>(null);
  const [draftRegistry] = useState(() => new SettingsDraftRegistry());
  const resultsRef = useRef<HTMLDivElement | null>(null);
  const navigationSeqRef = useRef(0);
  const searchStartedAtRef = useRef<number | null>(null);
  const results = useSettingsSearchResults(query);
  const searchActive = query.trim() !== "" || modifiedView;
  const menuSections = useMemo(
    () => new Set<string>(menuItems.map((item) => item.id)),
    [menuItems],
  );

  // A new request from elsewhere in the app, or closing Settings, ends a search.
  const [seenRequest, setSeenRequest] = useState({ open, defaultSection, sectionRequest });
  if (
    seenRequest.open !== open ||
    seenRequest.defaultSection !== defaultSection ||
    seenRequest.sectionRequest !== sectionRequest
  ) {
    setSeenRequest({ open, defaultSection, sectionRequest });
    setQuery("");
    setModifiedView(false);
    setPendingConflict(null);
    setPendingField(null);
    setResetTarget(null);
  }

  const changeQuery = useCallback((next: string) => {
    if (next.trim() && searchStartedAtRef.current === null) {
      searchStartedAtRef.current = performance.now();
    }
    if (!next.trim()) searchStartedAtRef.current = null;
    setQuery(next);
    setPendingConflict(null);
  }, []);

  const focusSearchField = useCallback(() => {
    for (const id of ["settings-search-sidebar", "settings-search-header"]) {
      const input = document.getElementById(id);
      if (input && input.getClientRects().length > 0) {
        input.focus();
        return;
      }
    }
  }, []);

  const performOpen = useCallback(
    (open: PendingOpen) => {
      const startedAt = searchStartedAtRef.current;
      log.info("search.result-opened", {
        section: open.descriptor.section,
        rank: open.rank,
        mode: query.trim() ? "search" : "modified",
        redirected: open.original !== undefined,
        elapsedMs: startedAt === null ? null : Math.round(performance.now() - startedAt),
      });
      searchStartedAtRef.current = null;
      const seq = ++navigationSeqRef.current;
      setNavigation({ section: open.descriptor.section, seq });
      setPendingField({ ...open, seq });
      setQuery("");
      setModifiedView(false);
      setPendingConflict(null);
    },
    [query],
  );

  const requestOpen = useCallback(
    (open: PendingOpen, activeSection: GlobalSettingsSection | "") => {
      if (
        openWouldDiscardDraft(
          open.descriptor,
          activeSection,
          !draftIsClean(draftRegistry.getSnapshot()),
          (isCommandNodeSettingsSection(activeSection) ? null : resolved.machine) !==
            (isCommandNodeSettingsSection(open.descriptor.section) ? null : resolved.machine),
        )
      ) {
        setPendingConflict(open);
        return;
      }
      performOpen(open);
    },
    [draftRegistry, performOpen, resolved.machine],
  );

  const requestReset = useCallback((descriptor: SettingDescriptor, machine: string | null) => {
    setResetTarget({ descriptor, machine });
  }, []);

  const search = (placement: "sidebar" | "header") => (
    <SettingsSearchField
      id={`settings-search-${placement}`}
      query={query}
      onQueryChange={changeQuery}
      modifiedView={modifiedView}
      onModifiedViewChange={(on) => {
        setModifiedView(on);
        setPendingConflict(null);
        if (on && searchStartedAtRef.current === null) {
          searchStartedAtRef.current = performance.now();
        }
      }}
      onOpenFirst={() =>
        resultsRef.current?.querySelector<HTMLElement>("[data-result-open]")?.click()
      }
      resultsRef={resultsRef}
    />
  );

  return (
    <SettingsDraftProvider registry={draftRegistry}>
      <FullscreenSettingsLayout
        open={open}
        onOpenChange={onOpenChange}
        title="Settings"
        menuItems={menuItems}
        defaultSection={defaultSection === "skills" ? "capabilities" : defaultSection}
        sectionRequest={sectionRequest}
        navigation={navigation}
        onSectionSelect={() => {
          // Picking a section from the menu ends a search.
          changeQuery("");
          setModifiedView(false);
          setPendingField(null);
        }}
        search={search}
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
          const resetDialog = resetTarget ? (
            <SettingResetDialog
              key={resetTarget.descriptor.id}
              descriptor={resetTarget.descriptor}
              onClose={() =>
                setResetTarget((current) => (current === resetTarget ? null : current))
              }
            />
          ) : null;
          const selected = resolved.options.find(
            (candidate) => candidate.nodeId === resolved.machine,
          );
          return (
            <>
              {searchActive ? (
                <SettingsResultTargets
                  selected={selected}
                  selectedMachine={resolved.machine}
                  requestReset={requestReset}
                >
                  {(commandTarget, selectedTarget) => (
                    <SettingsSearchResults
                      commandTarget={commandTarget}
                      selectedTarget={selectedTarget}
                      mode={modifiedView ? "modified" : "search"}
                      queryActive={query.trim() !== ""}
                      results={results}
                      menuSections={menuSections}
                      activeSection={activeSection}
                      pendingConflict={pendingConflict}
                      onOpen={(open) => requestOpen(open, activeSection)}
                      onConfirmOpen={() => {
                        if (!pendingConflict || draftRegistry.getSnapshot().saving) return;
                        draftRegistry.discardOnLeave();
                        performOpen(pendingConflict);
                      }}
                      onCancelOpen={() => setPendingConflict(null)}
                      onFixBlocker={() => {
                        changeQuery("");
                        setModifiedView(false);
                        const draft = draftRegistry.getSnapshot();
                        const section = (draft.blocker?.section ??
                          activeSection) as GlobalSettingsSection;
                        if (!section) return;
                        const seq = ++navigationSeqRef.current;
                        setNavigation({ section, seq });
                        setPendingField({
                          descriptor: SETTINGS_CATALOG.find(
                            (entry) =>
                              entry.section === section &&
                              entry.value &&
                              draft.dirtyKeys.includes(entry.value.key),
                          ) ?? {
                            id: `section:${section}`,
                            section,
                            label: globalSettingsLabel(section),
                            description: "",
                            appliesWhen: "immediately",
                          },
                          seq,
                          rank: -1,
                        });
                      }}
                      onBackToField={focusSearchField}
                      onEscape={() => {
                        changeQuery("");
                        setModifiedView(false);
                        focusSearchField();
                      }}
                      resultsRef={resultsRef}
                    />
                  )}
                </SettingsResultTargets>
              ) : null}
              <div hidden={searchActive} className="h-full">
                {machine && !option ? (
                  <div className="space-y-3 p-5">
                    <p className="text-sm text-muted-foreground" role="status">
                      The selected machine is no longer available.
                    </p>
                    <Button type="button" variant="outline" size="sm" onClick={() => choose(null)}>
                      Use the command machine
                    </Button>
                  </div>
                ) : (
                  <MachineSettings
                    key={machine ?? "command-node"}
                    machine={machine}
                    option={option}
                  >
                    <SettingsExplainScope
                      machine={machine}
                      machineName={option?.name ?? null}
                      requestReset={requestReset}
                    >
                      <SettingFieldNavigator
                        activeSection={activeSection}
                        pending={searchActive ? null : pendingField}
                        onSettled={() => setPendingField(null)}
                      />
                      <SettingsScopeBanner section={activeSection} machine={option} />
                      {
                        // Capabilities uses its own commands and bypasses the auto-saving settings form.
                        activeSection === "machines" ? (
                          <MachinesSettings />
                        ) : activeSection === "disk-usage" ? (
                          <DiskUsageSettings />
                        ) : activeSection === "usage" ? (
                          <UsageSettings />
                        ) : activeSection === "capabilities" ? (
                          <CapabilitiesSettings
                            key={`${sectionRequest ?? 0}-${defaultSection === "skills" ? "installed" : "library"}`}
                            initialTab={defaultSection === "skills" ? "installed" : "library"}
                          />
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
                      {resetTarget && resetTarget.machine === machine ? resetDialog : null}
                    </SettingsExplainScope>
                  </MachineSettings>
                )}
              </div>
              {resetTarget && resetTarget.machine !== machine ? (
                <MachineSettings
                  machine={resetTarget.machine}
                  option={resetTarget.machine === selected?.nodeId ? selected : undefined}
                  includeUnavailable
                >
                  <SettingsExplainScope
                    machine={resetTarget.machine}
                    machineName={
                      resetTarget.machine === selected?.nodeId ? (selected?.name ?? null) : null
                    }
                    requestReset={requestReset}
                  >
                    {resetDialog}
                  </SettingsExplainScope>
                </MachineSettings>
              ) : null}
            </>
          );
        }}
      </FullscreenSettingsLayout>
    </SettingsDraftProvider>
  );
}

/** Search resolves each row using the configuration for its destination section. */
function SettingsResultTargets({
  selected,
  selectedMachine,
  requestReset,
  children,
}: {
  selected: AccountMachineOption | undefined;
  selectedMachine: string | null;
  requestReset: (descriptor: SettingDescriptor, machine: string | null) => void;
  children: (command: SettingsSearchTarget, selected: SettingsSearchTarget) => React.ReactNode;
}) {
  return (
    <SettingsExplainScope machine={null} machineName={null} requestReset={requestReset}>
      <SettingsResultTarget>
        {(command) =>
          selected?.nodeId ? (
            <MachineSettings machine={selected.nodeId} option={selected} includeUnavailable>
              <SettingsExplainScope
                key={selected.nodeId}
                machine={selected.nodeId}
                machineName={selected.name}
                requestReset={requestReset}
              >
                <SettingsResultTarget>{(target) => children(command, target)}</SettingsResultTarget>
              </SettingsExplainScope>
            </MachineSettings>
          ) : (
            children(
              command,
              selectedMachine
                ? { view: { ...command.view, ready: false }, explain: null }
                : command,
            )
          )
        }
      </SettingsResultTarget>
    </SettingsExplainScope>
  );
}

function SettingsResultTarget({
  children,
}: {
  children: (target: SettingsSearchTarget) => React.ReactNode;
}) {
  const view = useSettingsConfig();
  const explain = useSettingsExplain();
  return children({ view, explain });
}

/** Names the machine on screen and its command node for the field explanations. */
function SettingsExplainScope({
  machine,
  machineName,
  requestReset,
  children,
}: {
  machine: string | null;
  machineName: string | null;
  requestReset: (descriptor: SettingDescriptor, machine: string | null) => void;
  children: React.ReactNode;
}) {
  const commandNode = useCommandNode();
  const { enabled: federated } = useFederation();
  const { config, ready } = useSettingsConfig();
  const resetHere = useCallback(
    (descriptor: SettingDescriptor) => requestReset(descriptor, machine),
    [requestReset, machine],
  );
  const commandNodeName = commandNode?.name ?? null;
  const names = useMemo(
    () => ({
      machine: machineName ?? commandNodeName ?? "this machine",
      commandNode: commandNodeName,
      federated,
    }),
    [machineName, commandNodeName, federated],
  );
  return (
    <SettingsExplainProvider
      machine={machine}
      names={names}
      configRevision={config.global}
      ready={ready}
      requestReset={resetHere}
    >
      {children}
    </SettingsExplainProvider>
  );
}

/**
 * Everything inside acts on `machine`. Its key remounts the sections per
 * machine, so nothing read from one machine stays on screen for another.
 */
export function MachineSettings({
  machine,
  option,
  includeUnavailable,
  children,
}: {
  machine: string | null;
  option: { name: string; connected?: boolean } | undefined;
  includeUnavailable?: boolean;
  children: React.ReactNode;
}) {
  const value = useMemo(() => ({ machine, name: option?.name ?? null }), [machine, option?.name]);
  return (
    <AccountMachineProvider value={value}>
      <MachineConfigProvider
        machine={machine}
        connected={option?.connected}
        includeUnavailable={includeUnavailable}
      >
        {children}
      </MachineConfigProvider>
    </AccountMachineProvider>
  );
}

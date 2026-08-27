// Context for sharing terminal functionality across components
import { createContext, useContext, useCallback, useMemo, useState, ReactNode } from "react";
import { MAX_TABS_PER_ENVIRONMENT } from "@orkestrator/protocol/pane-layout";

// Terminal-specific tab types
export type TerminalTabType =
  | "plain"
  | "claude"
  | "opencode"
  | "codex"
  | "cursor"
  | "grok"
  | "pi"
  | "root";
export type CreatableTabType =
  | TerminalTabType
  | "agent-native"
  | "browser"
  | "looped-review"
  | "multi-review";
export type AgentLaunchModeOverride = "cli" | "native" | "tmux";

// All tab types including file viewer and native agent tabs
export type TabType =
  | TerminalTabType
  | "browser"
  | "file"
  | "agent-native"
  | "claude-tmux"
  | "claude-build"
  | "looped-review"
  | "multi-review";

// Maximum number of tabs allowed (matches Ctrl+1-9 shortcuts)
export const MAX_TABS = MAX_TABS_PER_ENVIRONMENT;

// Options for creating a tab
export interface CreateTabOptions {
  /** Caller-owned ID used to bind durable backend work to the tab before it mounts. */
  tabId?: string;
  /** Focus an existing caller-owned tab instead of treating its id as a collision. */
  activateExistingTab?: boolean;
  /** Initial prompt to send to agent (only for claude/opencode tabs) */
  initialPrompt?: string;
  /** Initial commands to execute (only for plain terminal tabs) */
  initialCommands?: string[];
  /** Optional tab chrome title; the tab number is appended by the tab bar. */
  displayTitle?: string;
  /** True when the tab was launched from the review workflow. */
  isReviewTab?: boolean;
  /** Optional one-shot agent launch mode that overrides repository/global defaults. */
  agentLaunchMode?: AgentLaunchModeOverride;
  /** Optional one-shot model selection for this agent tab. */
  initialAgentModel?: string;
  /** Optional one-shot reasoning effort or provider variant for this agent tab. */
  initialReasoningEffort?: string;
  /** One-shot Build/Plan selection applied when the agent tab is locked. */
  initialConversationMode?: "build" | "plan";
  /** Initial backend-local address for browser tabs. */
  initialUrl?: string;
  /** Existing authoritative workflow opened by a looped-review tab. */
  loopedReviewId?: string;
  /** Existing authoritative workflow opened by a Multi Review tab. */
  multiReviewId?: string;
  /** Reviewer transcript opened inside an existing Multi Review workflow. */
  multiReviewReviewerId?: string;
  /** Existing native provider session opened from a backend-owned workflow. */
  resumeSessionId?: string;
  /** Refuse to replace a missing resume target with a fresh empty session. */
  requireExistingResumeSession?: boolean;
}

// Options for creating a file tab
export interface CreateFileTabOptions {
  /** Whether to show diff view instead of regular file view */
  isDiff?: boolean;
  /** Git status of the file (M=modified, A=added, D=deleted, ?=untracked) */
  gitStatus?: string;
}

interface TerminalContextValue {
  // Terminal write function
  terminalWrite: ((data: string) => Promise<void>) | null;
  setTerminalWrite: (write: ((data: string) => Promise<void>) | null) => void;

  // PR URL detection from terminal output
  lastPrUrl: string | null;
  setLastPrUrl: (url: string | null) => void;

  // Tab management
  /**
   * Attempts to present a tab and reports whether it was created or an allowed
   * existing tab was activated. Callers that create durable state for a new tab
   * use `false` to roll that state back when presentation is unavailable.
   */
  createTab: ((type: CreatableTabType, options?: CreateTabOptions) => boolean) | null;
  setCreateTab: (
    fn: ((type: CreatableTabType, options?: CreateTabOptions) => boolean) | null,
  ) => void;
  selectTab: ((index: number) => void) | null;
  setSelectTab: (fn: ((index: number) => void) | null) => void;
  closeActiveTab: (() => void) | null;
  setCloseActiveTab: (fn: (() => void) | null) => void;
  tabCount: number;
  setTabCount: (count: number) => void;

  // File tab management
  createFileTab: ((filePath: string, options?: CreateFileTabOptions) => void) | null;
  setCreateFileTab: (
    fn: ((filePath: string, options?: CreateFileTabOptions) => void) | null,
  ) => void;
  openFilePaths: string[];
  setOpenFilePaths: (paths: string[]) => void;
}

const TerminalContext = createContext<TerminalContextValue | null>(null);

interface TerminalProviderProps {
  children: ReactNode;
}

export function TerminalProvider({ children }: TerminalProviderProps) {
  const [terminalWrite, setTerminalWriteState] = useState<((data: string) => Promise<void>) | null>(
    null,
  );
  const [lastPrUrl, setLastPrUrl] = useState<string | null>(null);
  const [createTabFn, setCreateTabFn] = useState<
    ((type: CreatableTabType, options?: CreateTabOptions) => boolean) | null
  >(null);
  const [selectTabFn, setSelectTabFn] = useState<((index: number) => void) | null>(null);
  const [closeActiveTabFn, setCloseActiveTabFn] = useState<(() => void) | null>(null);
  const [tabCount, setTabCount] = useState(0);
  const [createFileTabFn, setCreateFileTabFn] = useState<
    ((filePath: string, options?: CreateFileTabOptions) => void) | null
  >(null);
  const [openFilePaths, setOpenFilePaths] = useState<string[]>([]);

  // Note: The setters below use the pattern `setState(() => fn)` instead of `setState(fn)`.
  // This is intentional - when storing functions in React state, passing the function directly
  // to setState would cause React to interpret it as a state updater function (like setState(prev => ...)).
  // Wrapping it in an arrow function `() => fn` ensures React treats it as the new state value.
  const setTerminalWrite = useCallback((write: ((data: string) => Promise<void>) | null) => {
    setTerminalWriteState(() => write);
  }, []);

  const setCreateTab = useCallback(
    (fn: ((type: CreatableTabType, options?: CreateTabOptions) => boolean) | null) => {
      setCreateTabFn(() => fn);
    },
    [],
  );

  const setSelectTab = useCallback((fn: ((index: number) => void) | null) => {
    setSelectTabFn(() => fn);
  }, []);

  const setCloseActiveTab = useCallback((fn: (() => void) | null) => {
    setCloseActiveTabFn(() => fn);
  }, []);

  const setCreateFileTab = useCallback(
    (fn: ((filePath: string, options?: CreateFileTabOptions) => void) | null) => {
      setCreateFileTabFn(() => fn);
    },
    [],
  );

  // Memoized so a re-render of the provider's parent (App re-renders on every
  // environment-store write) does not hand consumers a brand-new context value
  // when none of the terminal state actually changed. The registered functions
  // and state values are the dependencies; the setters are all stable.
  const value = useMemo<TerminalContextValue>(
    () => ({
      terminalWrite,
      setTerminalWrite,
      lastPrUrl,
      setLastPrUrl,
      createTab: createTabFn,
      setCreateTab,
      selectTab: selectTabFn,
      setSelectTab,
      closeActiveTab: closeActiveTabFn,
      setCloseActiveTab,
      tabCount,
      setTabCount,
      createFileTab: createFileTabFn,
      setCreateFileTab,
      openFilePaths,
      setOpenFilePaths,
    }),
    [
      terminalWrite,
      setTerminalWrite,
      lastPrUrl,
      createTabFn,
      setCreateTab,
      selectTabFn,
      setSelectTab,
      closeActiveTabFn,
      setCloseActiveTab,
      tabCount,
      createFileTabFn,
      setCreateFileTab,
      openFilePaths,
    ],
  );

  return <TerminalContext.Provider value={value}>{children}</TerminalContext.Provider>;
}

export function useTerminalContext(): TerminalContextValue {
  const context = useContext(TerminalContext);
  if (!context) {
    throw new Error("useTerminalContext must be used within a TerminalProvider");
  }
  return context;
}

export function useOptionalTerminalContext(): TerminalContextValue | null {
  return useContext(TerminalContext);
}

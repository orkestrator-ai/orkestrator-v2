# Load the composer file tree on demand

## Task analysis

Analysed 2026-11-18 against `main` at `583da944e`. Payload measurement from the performance review at `259e88d90`.

### Tasks

1. Start loading the file index when someone opens file mentions and share the result across eligible tabs for the same workspace. Status: open.

### 1. Start loading the file index when someone opens file mentions and share the result across eligible tabs for the same workspace

**Problem.** Eligible native agent composers request the full workspace tree on mount and each flattens its own copy, even when the file-mention menu stays closed.

**Context.** The assigned native tab and the unassigned composer both use `useFileSearch`. A backend cache can save a tree walk, but these calls request the full response without a digest. The Files panel already uses conditional snapshots. [Native tab](../../../apps/web/src/components/native-agent/AgentNativeTab.controller.tsx) · [Unassigned composer](../../../apps/web/src/components/native-agent/AgentNativeTab.helpers.tsx) · [File search hook](../../../apps/web/src/hooks/useFileSearch.ts)

**Investigation.** A synthetic local workspace tree at the 5,000-node cap serialized to 516,491 bytes of uncompressed JSON. The figure is the payload for one full tree and excludes transport compression, parsing, and indexing.

**Decisions.**

- **Fetch on the first file mention and share a bounded read and result within the owning node and workspace (recommended).** Pros include eliminating requests for unused menus and avoiding duplicate transfers and flattening across tabs. A cold menu needs a loading state and reused data needs a freshness rule.
- **Keep a shared eager read on tab mount.** Pros include instant results once preloading finishes. Every newly visited workspace still incurs work even if nobody searches.

## Needs verification

- Count requests when opening assigned and unassigned composers without typing `@`, then open a file mention and repeat it in another tab for the same workspace. Compare response bytes and indexing work.
- Check results, keyboard selection, loading and error recovery, and file changes between uses. Switch workspaces or nodes during a read and verify each menu only receives its own workspace's paths. Cover local and container-backed workspaces and preserve the Open File dialog's behavior.

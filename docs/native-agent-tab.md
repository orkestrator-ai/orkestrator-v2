# Native agent tab architecture

Every native provider enters the pane renderer through `NativeAgentTab`.
Provider selection, capabilities, lazy controller loading, and wire-message
normalization live in the native-agent adapter registry below that component.

```text
PaneLeafContainer
  -> NativeAgentTab
    -> NativeAgentAdapter
      -> provider controller and bridge client
      -> NativeMessage[]
    -> NativeChatShell
```

## Boundaries

- Pane layout stores `NativeAgentTabData`: platform, environment, container,
  and provider-session identity. Provider-specific pane fields remain as a
  compatibility projection for layouts written before this consolidation.
- `NativeAgentTab` does not import provider clients or switch over provider
  message/event payloads.
- Each adapter publishes capabilities and converts its provider transcript to
  `NativeMessage[]` before shared presentation sees it.
- Provider controllers retain transport-specific reconciliation. Codex sparse
  revision patches, OpenCode child-session hydration, Claude background-task
  snapshots, and ACP message windows must be settled against their respective
  authoritative bridge snapshots before normalization.
- A tab unmount never represents cancellation. Environment subscriptions and
  bridge/backend state continue to outlive the visible React tree.

## Adding a provider

1. Add the platform to the shared agent-platform protocol.
2. Register one `NativeAgentAdapter` with a label, capability set, message
   normalizer, and lazily loaded headless/provider controller.
3. Supply authoritative snapshot recovery and gap detection in the adapter's
   transport layer.
4. Add the platform to the adapter contract tests. No pane renderer or shared
   chat-shell branch should be added.

Claude tmux remains separate: it is a terminal/tmux surface rather than a
native bridge session.

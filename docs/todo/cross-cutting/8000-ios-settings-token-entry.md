# Take the token natively in the iOS app's Settings → Machines forms

## Task analysis

Analysed 2026-11-13 against `main` at `17d28238c`. A follow-up from to-do 5600 (retired 2026-11-13; `git show 17d28238c:docs/todo/cross-cutting/5600-ios-bridge-user-consent.md`), which moved the mobile sidebar's New connection into the app's own editor and put a native confirmation in front of every `connect`, `use` and `forget` a page sends.

### Tasks

1. **Route the Settings → Machines token forms to the native editor on iOS**: three web forms still take a gateway token in the page and pass it to the bridge's `connect`. Status: open.

### 1. Route the Settings → Machines token forms to the native editor on iOS

**Problem.** In the iOS app, three forms in Settings → Machines ask for a gateway token in the page of the server the app is showing and hand it to `connect`: the HTTPS route of **Add machine** (`addToDevice`, `apps/web/src/components/settings/machines/AddMachineDialog.tsx`), **Add an HTTPS address** for a verified machine (`AddHttpsRouteDialog`, `DeviceConnectionSection.tsx`) and **Save on this device** (`SaveOnDeviceForm`, same file). A compromised current server can read a token typed there, and that token belongs to another machine. Since 5600 each of these saves asks natively before anything is saved or contacted, so a page can no longer save a server silently, but the token itself still passes through the page.

**Context.** The sidebar's New connection now calls `addInNativeEditor` (bridge action `open-editor`, `RemoteWebView.swift`), which opens `ConnectionEditorView` and resolves at once; the app saves and opens the server itself (`ConnectionModel.connectDraft`, which always selects the new server). The three forms differ from that flow: they save with `select: false`, may pass a `nickname`, and two of them use the returned list (`publishConnections`, and Add machine goes on to add the machine to the command node). The rules for the bridge are in [renderer security, iOS app](../../architecture/renderer-security.md#ios-app). The bridge contract only changes additively ([version compatibility](../../architecture/version-compatibility.md)): an older iOS app has only `connect`, so the forms must keep working without the new action.

**Investigation.** Read from the code on 2026-11-13. `open-editor` takes no input and answers before the user has typed anything; the native editor has no prefilled-address, keep-current-server or nickname mode, and nothing reports back to the page when it saves or is cancelled. The Electron desktop client keeps its own forms: its `connections` API has no `addInNativeEditor`, and the token there is typed into the desktop's own renderer.

**Decisions.**

- **How should these forms take the token on iOS?**
  - **Extend the native editor and the bridge: `addInNativeEditor({ address?, select?, nickname? })` opens the editor prefilled with the address, saves with that `select` and nickname, and answers with the saved list when the user saves, or with an error when they cancel (recommended).**
    - Pros: the token never enters a page on any iOS form; the forms keep their flow (the returned list feeds `publishConnections` and Add machine's command-node step); additive, so older apps keep the in-page form with its native confirmation.
    - Cons: the coordinator has to hold one pending editor request and answer it exactly once (save, cancel, dismissal, teardown), and the editor gains a keep-current-server mode.
  - **Hide the token field on iOS and tell the user to add the server from the sidebar first.**
    - Pros: almost no native work.
    - Cons: two steps for the user, and Add machine's command-node step needs the saved connection's id, which it would then have to find itself.
  - **Leave it: every save already asks natively.**
    - Pros: no work.
    - Cons: the token for another machine is still readable by the page it is typed into, which is the threat 5600 task 2 was about.

## Current state

The sidebar takes a new server's token natively; the three Settings → Machines forms take it in the page and ask natively before saving.

## Constraints and rationale

- A saved token must never reach a page, and must only ever be sent to its own saved address.
- An editor request that is cancelled, dismissed or torn down must answer as refused, never as saved.
- The bridge changes only additively; a web client served to an older iOS app keeps its in-page form.

## Related

- [Renderer security, iOS app](../../architecture/renderer-security.md#ios-app)
- [`apps/ios/README.md`](../../../apps/ios/README.md)
- 5600 (retired 2026-11-13): native consent for the bridge and the sidebar's native token entry; its device check is in the [manual-test checklist](../manual-test/7568-manual-test-checklist.md).

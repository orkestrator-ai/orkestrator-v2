# Ask the user before a web page changes the iOS app's saved servers

## Task analysis

Analysed 2026-11-05 against `main` at `69a3b4ca5`.

### Tasks

1. **Confirm bridge changes natively**: a page can add, switch to and forget saved servers without the user seeing anything from the app. Status: open.
2. **Take the token for another server natively**: adding a server from the mobile sidebar types its token into the current server's page. Status: open.

### 1. Confirm bridge changes natively

**Problem.** The connection bridge obeys any script running in the main frame at the active server's origin. Such a script can call `connect` with an address it chose (saved and made active, so the app then loads that server), `use` another saved server, or `forget` every saved server. Nothing native asks the user first. A script on one saved machine can also read the address and nickname of every other saved machine through `list`.

**Context.** The bridge is `RemoteWebView.Coordinator.handleBridgeRequest` (`apps/ios/OrkestratorMobile/Views/RemoteWebView.swift`). Its callers are the web client's server switcher and machines settings (`apps/web/src/components/sidebar/ServerConnectionSwitcher.tsx`, `apps/web/src/components/settings/machines/useMachines.ts`, `apps/web/src/components/federation/CommandNodeMenu.tsx`). The threat is a compromised saved machine or script injected at a gateway origin; the gateway's CSP (finding M6) makes the second harder.

**Investigation.** From the 2026-11-05 review (security report 0270). What holds: no bridge action returns a token (`ConnectionListPayload.Summary` has no such field), and a saved token only ever goes to its own saved address, so a page cannot steer one elsewhere. The gate is the main frame at the saved origin. A throwaway WebKit probe on the iOS 18.2 simulator confirmed subframes are refused, including an `allow-same-origin` frame at the saved origin, and so is a CSP-sandboxed main frame (after the fix to its crash in this same work). So the remaining power belongs only to a script the gateway's own origin runs, and what it gains is persistence: `connect` keeps a server of its choosing in the Keychain list and switches the app to it, where it can show a look-alike sign-in screen. Whether a saved-machine compromise is realistic enough to justify the extra prompt is a judgement call, which is why this was recorded instead of changed.

**Decisions.**

- **How should the app gate these actions?**
  - **Show a native confirmation for `connect` and `forget`, and for `use` when the target was not chosen in native UI (recommended).**
    - Pros: a script cannot silently add a server or wipe the list; the prompt comes from the app, so the page cannot forge it; `list`, `probe` and `rename` keep working.
    - Cons: one extra tap on a deliberate switch from the sidebar; needs a pending-request state in the coordinator and a timeout that refuses, per the repository's rule that an unanswered approval denies.
  - **Remove `connect` and `forget` from the bridge and open the native editor instead.**
    - Pros: the smallest bridge; also settles task 2.
    - Cons: changes the web client's mobile flows; the bridge contract only changes additively (`docs/architecture/version-compatibility.md`), so older web clients served by an older backend must still be answered.
  - **Leave it as it is.**
    - Pros: no work; a script at the gateway origin already holds that machine's whole session.
    - Cons: the reach beyond that machine remains: other saved servers can be forgotten, and an attacker's server can be kept in the list.

### 2. Take the token for another server natively

**Problem.** When a user adds a server through the mobile sidebar, they type its token into the page of the server they are currently on (`api.connect({ address, token })` in `ServerConnectionSwitcher.tsx`). A compromised current server can read that token, which belongs to a different machine.

**Context.** Saved tokens never reach JavaScript; only a token typed into the web UI does. `apps/ios/README.md` claimed the token is never written to JavaScript. It now states this exception. The native editor (`ConnectionEditorView`) already collects the same two fields in a `SecureField`.

**Investigation.** Read from the code on 2026-11-05. `connect` on the bridge takes the token as a string from the page, and the iOS app has no way to know the user typed it elsewhere. The app already has `showConnectionEditor()` for this.

**Decisions.**

- **Where should the token be entered?**
  - **On iOS, have the sidebar's add action call a new bridge action that opens the native editor (recommended).**
    - Pros: the token never enters a page; reuses the existing editor; additive, so older clients keep working until `connect` can be retired.
    - Cons: a web client change as well as a native one, and a client-platform branch in the sidebar.
  - **Keep typing it in the page and warn the user in the form.**
    - Pros: almost no work.
    - Cons: a warning does not protect the token, and it asks the user to judge whether their own machine is compromised.

## Current state

A script at the active server's origin can add, switch and forget saved servers without a prompt, and a token typed into the sidebar passes through that page. No token can be read back from the app, and none goes to a server other than its own.

## Constraints and rationale

- A saved token must never reach a page, and must only ever be sent to its own saved address.
- A prompt that times out or is dismissed must refuse the action.
- The status probe and cookie sign-in change only additively (`docs/architecture/version-compatibility.md`).

## Related

- To-do 5601 (retired 2026-11-10): the same origin gate on a real device, now in the [manual-test checklist](../manual-test/7568-manual-test-checklist.md); the gate itself is in [renderer security, iOS app](../../architecture/renderer-security.md#ios-app)
- `5602-ios-session-and-privacy-hardening.md` (deleted 2026-11-06): smaller findings from the same review

## Replaces

Part of the iOS review, security report part `0270` (batch S-0270). Its file was deleted when the review was done; it is in the history, ending with the outcome table, at the commit before the deletion.

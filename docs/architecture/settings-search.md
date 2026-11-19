# Settings search and effective values

Settings has a search field at the top (in the sidebar on a wide screen, in
its own row on a narrow one), a **Modified** view, and under each catalogued
field a line that says what value is in effect, where it comes from, whether
it is stored explicitly and when a change applies. A stored value that can be
removed has a **Reset to default…** action with a preview.

## The catalog

`apps/web/src/lib/settings-catalog/` describes every user-editable setting
Settings shows, one `SettingDescriptor` each (`types.ts`): a stable id (also
the field's anchor), section, label, description, curated aliases, when a
change applies (`appliesWhen`), whether it is a credential (`sensitive`), and
for settings stored in the global config a `value` binding (the stored key,
how to read the effective value, and its default, taken from
`createDefaultGlobalConfig`). Conditional settings stay catalogued with an
`availability` rule, so search can say why one is hidden and open the setting
that shows it.

The catalog describes settings; it does not store or resolve them. Each field
keeps its own editor, validation and save. Scope comes from the layering rules
themselves (`scope.ts` reads `INHERITED_GLOBAL_SETTING_KEYS`), so the catalog
cannot claim a different owner than the one a save goes to.

When a section gains a setting:

1. Add a descriptor to `catalog.ts`.
2. Wrap the field in `SettingField` with the descriptor's id
   (`components/settings/search/SettingField.tsx`), which adds the anchor and
   the explanation line. A field drawn by a component that cannot import it
   (for example `SettingsPageLayout`, which `settings-config` imports) takes a
   `data-setting-anchor` attribute, or the descriptor gets a `locate` fallback
   (an element id, an accessible name or a heading).
3. `components/settings/search/catalog-coverage.test.ts` fails when a key the
   shared form saves has no entry, a section has none, or an entry can no
   longer be found in the settings source.

## Search and navigation

`search.ts` matches every word of the query against the label, aliases,
section name and description, in that order of weight, and never against a
value. Results show the label, section, scope and, where it can be shown,
the effective value and its source. Selecting one opens its section, scrolls
the field into view, highlights it for two seconds and focuses its control
without activating it (`field-navigation.ts`, `SettingFieldNavigator.tsx`);
a live region says what happened, including when the field is not on screen.

While a search is open the section underneath stays mounted and hidden, so an
unsaved edit survives it. Search asks before opening a result that changes
the form's machine or unmounts the shared form while it holds a draft.
Returning to the draft focuses its field when one is identified. Each result
uses its destination's configuration and remains searchable while that
configuration is loading or unavailable. Modified filters the current query
when both controls are active.

Keyboard: ArrowDown from the field moves into the results, ArrowUp from the
first result returns, Enter in the field opens the first result, Escape
clears the search instead of closing Settings.

## Where a value comes from

`get_global_setting_sources` (config domain) answers which top-level keys a
machine explicitly stores and which it takes from the command node it
follows. The backend records override intent in the config file under the same
lock as the setting itself. Equal-to-default keys in older files can be
ambiguous and are reported as unknown. Shared sound and agent settings can
identify individual fields. Replies contain key names and exclude credentials.
Remote configuration is refreshed from its resource feed and on reconnect.
The value on screen controls which revision of source metadata is shown.
Settings reads it for the machine on screen and for the command node
(`readSettingSourcesLayers` in `lib/portal/command-node-config.ts`) and
resolves each field (`provenance.ts`):

| Source | Shown as |
| --- | --- |
| Stored on the machine on screen | Set on *machine* |
| Inherited preference stored on the command node | Inherited from *command node* |
| The machine on screen is the command node | Set on *machine*; machines it controls inherit it |
| Nothing stored | Default; nothing stored on *owner* |
| Node predates the read, or the read failed | Source unknown, with the reason |

An explicit override equal to today's default is still an override ("Override
· same as default"). The Modified view lists stored values; when sources are
unknown it says so and lists values that differ from their defaults instead.

## Reset

`reset_global_settings` removes stored keys under the config lock, only while
each still holds the value the client previewed (`expect`); otherwise nothing
is removed and the answer is a `conflict` with the current settings. The
dialog then shows the new value and asks again. A reset removes the override;
it never copies the parent value into the child. Inherited preferences are
reset on the command node, machine settings on the machine
(`runResetGlobalSettings`). One request affects one owner. Overrides parked
under an external controller are unavailable for reset while the controller
supplies the effective value.

Only `RESETTABLE_GLOBAL_SETTING_KEYS` (`packages/protocol/src/setting-sources.ts`)
qualify: keys whose absence the backend keeps through later saves.
`storage-config-setting-sources.test.ts` proves that per key. Keys that
normalisation or validation writes back (terminal appearance, scrollback,
enabled platforms, the agent settings block) are explained but not offered for
reset. Allow web access uses its dedicated service control and is outside
the generic reset allowlist. Reset is disabled while the shared form has
unsaved changes. The preview stays open during the request and its response
is applied only while the current form can accept it.

An outcome the client cannot confirm (a transport error) is not retried; the
dialog offers to read the current value again.

## Save feedback and failures

The shared form reports its unsaved keys, saving state, blocking validation
and last error to a page-level registry (`settings-explain.tsx`). A field with
an unsaved edit says so. After an unconfirmed save, **Check saved values**
reads the current values from their owners. If those values differ from the
draft, the edit is kept for review and **Use saved values** explicitly loads
the authoritative state. After a save the status line names settings that apply later ("Session titles applies to new agent sessions.").

## Measurement

Content-free `web.settings` log events: `search.result-opened` (section,
rank, mode, whether it redirected, elapsed time since the search began),
`search.field-missing`, `sources.read-failed` and `reset.finished` (outcome).
No query, value, credential presence or machine name is logged.

## Not built

There is no app-wide command palette to reuse the catalog in yet; the catalog
and `searchSettings` are ready for one.

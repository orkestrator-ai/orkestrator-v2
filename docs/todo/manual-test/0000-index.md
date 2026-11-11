# Manual test

Everything in the to-dos that needs the user: manual tests and live checks,
real or billed logins, the user's real install and data, hardware and accounts
the fleet lacks, and decisions, approvals and outward actions. Area to-dos
hold only work an agent can build or work that is blocked
([human-only work](../../README.md#human-only-work)).

This folder holds exactly one file, the checklist. Its row is the only one in
`docs/todo/` with Status **requires user input**
([choosing a status](../../README.md#choosing-a-status)).

| Rank | File | Criticality | Status | Needs you | Covers | Why this rating |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | [7568-manual-test-checklist.md](7568-manual-test-checklist.md) | Very high | requires user input | Work through the checklist: run each manual test or live check and record its result, then make each decision or outward action at the end. | Every human-only item from the area to-dos as a `- [ ]` checkbox, grouped by area, naming its source to-do and task: 299 manual tests and live checks, then 53 decisions, approvals and outward actions. | It holds the items that most often gate shipped behaviour: applying the required-checks ruleset that stops a red lint job merging, security checks in shipping Safari and on devices, and live qualification of features on by default. |

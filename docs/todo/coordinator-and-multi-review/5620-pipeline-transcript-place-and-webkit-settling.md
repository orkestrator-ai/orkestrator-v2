# Pipeline transcript: a reader's place behind other stages, and a brief offset under WebKit

Two things found while checking the Build Pipeline and Graph Run inspector transcripts across a hide under WebKit. That check found no scroll loss; both items here are smaller. Returning to a stage sends a reader to the newest message although the code comments say their place is kept, and in WebKit a follower briefly sits short of the end when a review report is in the transcript.

## Task analysis

Analysed 2026-11-05 against `main` at `69a3b4ca`.

### Tasks

1. **Decide what returning to a stage does with a reader's place**: the comments and the behaviour disagree, in both engines. Status: open.
2. **Decide whether WebKit's brief offset with a review report needs work**: it settles by itself. Status: open.

### 1. Decide what returning to a stage does with a reader's place

**Problem.** A reader scrolls up in a stage's transcript, selects another node such as Ticket, and selects the stage again. They land on the newest message, not where they were.

**Context.** `apps/web/src/components/build-pipeline/PipelineFlowView.tsx:734` says the transcript is kept mounted "so returning to a stage keeps the reader's place", and `PipelineSessionTranscript.tsx:157` says the same. `PipelineSessionTranscript.tsx:166` passes `isActive: isActive && visible` with `activation: "latest"` to `useVirtuosoScrollState`, so every return to `visible` counts as an activation and goes to the newest message. The comment on `activation` gives its reason as returning to the tab. [transcript-scroll.md](../../architecture/transcript-scroll.md#activation-and-persistence) lists the policy but does not separate a tab switch from an inspector view switch.

**Investigation.** Measured 2026-11-05 with `/pipeline-flow?scenario=building&longTranscript&paneControls` at 700 px tall. Chromium and Playwright WebKit behave the same:

| Layout | Rows on screen before | Rows on screen after selecting Ticket, then the stage |
| --- | --- | --- |
| Phone, 390 px | 39 to 40 | 42 |
| Desktop, 1024 px | 35 to 38 | 40 to 42 |

The first frame after returning was at the reader's old offset, then it moved to the end. So the place is kept long enough to show that it could be, and the `latest` activation replaces it. Not measured: the Prepare node's Tests view, which sets `visible` the same way. Graph Run has no equivalent case, because its Details view unmounts the transcript rather than hiding it.

**Decisions.**

- **What should returning to a stage do?**
  - **Keep the reader's place when only `visible` changed, and keep `latest` for a pane or tab switch (recommended).**
    - Pros: matches both comments and the reason given for `latest`; a reader can check the ticket and come back.
    - Cons: `useVirtuosoScrollState` takes one policy per view, so it needs a way to tell the two kinds of activation apart, and tests for both.
  - **Keep the behaviour and correct the two comments.**
    - Pros: one line each; the stage always shows what is happening now.
    - Cons: the reader keeps losing their place inside one tab, and the kept-mounted list then earns little.

### 2. Decide whether WebKit's brief offset with a review report needs work

**Problem.** In Playwright WebKit, a follower whose transcript has a review report in its footer starts short of the end after a pane switch, with "Scroll down" showing, then settles on the end. Chromium starts at the end.

**Context.** `StructuredReviewReportView` is a `@container` and renders in the footer of `VirtualizedMessageList`, inside the scroller. In the fixtures it is the only container query container in a transcript's scroller; text rows hold none. 0860 found that WebKit resets a hidden scroller holding one.

**Investigation.** Measured 2026-11-05, four rounds per layout, with `/pipeline-flow?scenario=fanout&longTranscript=report&paneControls` at 700 px tall. This is not the reset to 0 that 0860 found. A reader further from the end kept their exact offset in the same fixture. The cause was not traced. The first offset is below the shrunken scroll range, so it is not a simple clamp either.

| Layout | Offset at the end | First offset after show | Scroll height, settled and at first | Time from first offset to settled |
| --- | --- | --- | --- | --- |
| Phone, 390 px | 12946 | 12464 | 13208, 13122 | 50 to 56 ms |
| Desktop, 1024 px | 12443 | 11977 | 12773, 12573 | 73 to 94 ms |

The first round of each layout started from a slightly higher measured height (13294 and 12973), and settled in the same time. An earlier run on a busier host took up to 119 ms.

**Decisions.**

- **Does this need a fix?**
  - **Leave it until real Safari shows the same thing (recommended).**
    - Pros: the end state is right, and `e2e/InspectorTranscriptHide.spec.ts` guards it; no work for something only seen in one test engine.
    - Cons: if Safari does the same, a reader of a finished review sees a short jump on each pane switch.
  - **Trace it now and hold the offset through the show.**
    - Pros: removes the jump in WebKit.
    - Cons: needs a cause first, and it would change code shared by every native transcript for a brief effect.

## Needs verification

Real Safari, in the session that runs [0860](0860-multi-review-inspector-webkit-divergences.md) task 4. Serve the fixture the same way, then open `/pipeline-flow?scenario=building&longTranscript&paneControls`, `/pipeline-flow?scenario=fanout&longTranscript=report&paneControls` and `/graph-run-flow?longTranscript`. Scroll the transcript up, press Activate other pane, then Activate build pane or Activate graph pane: the transcript must land on the newest message and the page around it must not move. On the report fixture, also note whether a follower's view jumps on the show.

## Related

- [0860-multi-review-inspector-webkit-divergences.md](0860-multi-review-inspector-webkit-divergences.md): the WebKit reset and `useScrollOffsetAcrossHide`.
- [transcript-scroll.md](../../architecture/transcript-scroll.md#activation-and-persistence): the activation policies and the measurements of the inspector transcripts.

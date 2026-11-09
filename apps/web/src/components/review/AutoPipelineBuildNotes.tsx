import type { KeyInformationPatch } from "@orkestrator/protocol/build-pipeline-key-information";

export function AutoPipelineBuildNotes({ notes }: { notes: KeyInformationPatch }) {
  return (
    <div className="space-y-3 text-sm">
      <p className="whitespace-pre-wrap">{notes.summary}</p>
      {notes.workDone?.length ? (
        <section>
          <h4 className="font-semibold">Work completed and files touched</h4>
          <ul className="list-disc pl-5">
            {notes.workDone.map((text, index) => (
              <li key={index}>{text}</li>
            ))}
          </ul>
        </section>
      ) : null}
      {notes.decisions?.length ? (
        <section>
          <h4 className="font-semibold">Decisions</h4>
          {notes.decisions.map((decision, index) => (
            <p key={index}>
              {decision.decision}: {decision.chosen}. {decision.rationale}
            </p>
          ))}
        </section>
      ) : null}
      {notes.tests?.length ? (
        <section>
          <h4 className="font-semibold">Checks</h4>
          <ul className="list-disc pl-5">
            {notes.tests.map((check, index) => (
              <li key={index}>
                {check.name}: {check.result}. {check.details}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {notes.notDone?.length ? (
        <section>
          <h4 className="font-semibold">Still to do</h4>
          <ul className="list-disc pl-5">
            {notes.notDone.map((text, index) => (
              <li key={index}>{text}</li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

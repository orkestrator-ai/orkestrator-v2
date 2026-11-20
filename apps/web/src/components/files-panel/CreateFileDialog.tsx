import { CreateEntryDialog, type CreateEntryDialogProps } from "./CreateEntryDialog";

/** Asks for the name of a new, empty file. An existing name is refused, never replaced. */
export function CreateFileDialog(props: CreateEntryDialogProps) {
  return <CreateEntryDialog kind="file" {...props} />;
}

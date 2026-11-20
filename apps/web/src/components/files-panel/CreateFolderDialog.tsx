import { CreateEntryDialog, type CreateEntryDialogProps } from "./CreateEntryDialog";

/** Asks for the name of a new, empty folder. */
export function CreateFolderDialog(props: CreateEntryDialogProps) {
  return <CreateEntryDialog kind="folder" {...props} />;
}

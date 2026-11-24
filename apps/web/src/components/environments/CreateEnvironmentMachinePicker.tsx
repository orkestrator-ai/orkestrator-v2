import { MachineColorDot } from "@/components/federation/MachineDot";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { CreateEnvironmentMachine } from "./create-environment-machines";

/** The dialog's machine when the offered machines do not list it. */
const UNLISTED_MACHINE = "current";

interface CreateEnvironmentMachinePickerProps {
  /** The machine the dialog creates on now, as its header names it. */
  current: { name: string; colorToken: string };
  /**
   * Every machine the environment can be created on, the one the dialog
   * opened on (`current`) included; see `useCreateEnvironmentMachines`.
   */
  machines: readonly CreateEnvironmentMachine[];
  /** The machine picked: the dialog's own by default. */
  selectedKey?: string | null;
  /** Aims the dialog at another machine. */
  onSelect?: (machine: CreateEnvironmentMachine) => void;
  disabled?: boolean;
}

/**
 * The dialog header's machine dropdown, beside its close button. It lists
 * only machines that can take the environment: this one and the reachable
 * machines with a project for the same repository. With nothing else to
 * offer it still names the machine, disabled.
 */
export function CreateEnvironmentMachinePicker({
  current,
  machines,
  selectedKey,
  onSelect,
  disabled = false,
}: CreateEnvironmentMachinePickerProps) {
  const value = selectedKey ?? machines.find((machine) => machine.current)?.key ?? UNLISTED_MACHINE;
  // A picked machine that has since left the list still names itself.
  const options = machines.some((machine) => machine.key === value)
    ? machines
    : [{ key: value, ...current }, ...machines];
  const choosable = Boolean(onSelect) && machines.some((machine) => machine.key !== value);
  return (
    <div className="flex shrink-0 items-center gap-2" data-testid="create-environment-machine">
      <span className="hidden text-sm text-muted-foreground sm:inline" aria-hidden="true">
        Machine
      </span>
      <Select
        value={value}
        onValueChange={(key) => {
          const machine = machines.find((candidate) => candidate.key === key);
          if (machine) onSelect?.(machine);
        }}
        disabled={disabled || !choosable}
      >
        <SelectTrigger
          size="sm"
          aria-label="Machine"
          title={
            choosable
              ? "Create this environment on another machine"
              : "No other machine can create this environment"
          }
          data-testid="create-environment-machine-select"
          className="max-w-44 bg-background"
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent position="popper" align="end">
          {options.map((machine) => (
            <SelectItem
              key={machine.key}
              value={machine.key}
              data-create-environment-machine={machine.key}
            >
              <MachineColorDot colorToken={machine.colorToken} />
              <span className="truncate">{machine.name}</span>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

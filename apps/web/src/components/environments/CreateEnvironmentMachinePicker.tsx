import { MachineColorDot } from "@/components/federation/MachineDot";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { CreateEnvironmentMachine } from "./create-environment-machines";

const CURRENT_MACHINE = "current";

interface CreateEnvironmentMachinePickerProps {
  /** The machine the dialog creates on now, as its header names it. */
  current: { name: string; colorToken: string };
  /**
   * Every machine the environment can be created on, the dialog's own
   * (`current`) included; see `useCreateEnvironmentMachines`.
   */
  machines: readonly CreateEnvironmentMachine[];
  /** Moves the dialog to another machine. */
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
  onSelect,
  disabled = false,
}: CreateEnvironmentMachinePickerProps) {
  const others = machines.filter((machine) => !machine.current);
  const choosable = others.length > 0 && Boolean(onSelect);
  return (
    <div className="flex shrink-0 items-center gap-2" data-testid="create-environment-machine">
      <span className="hidden text-sm text-muted-foreground sm:inline" aria-hidden="true">
        Machine
      </span>
      <Select
        value={CURRENT_MACHINE}
        onValueChange={(key) => {
          const machine = others.find((candidate) => candidate.key === key);
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
          <SelectItem value={CURRENT_MACHINE} data-create-environment-machine="current">
            <MachineColorDot colorToken={current.colorToken} />
            <span className="truncate">{current.name}</span>
          </SelectItem>
          {others.map((machine) => (
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

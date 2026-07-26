import { mock } from "bun:test";

/*
 * Typed to accept the arguments sonner is actually called with, so a test can
 * assert on the message it received (`mock.calls[0]?.[0]`). Declaring these as
 * zero-arg made `calls` an empty tuple, so indexing into it was a type error
 * and the only assertion available was "was it called at all".
 */
type ToastArgs = [message?: unknown, options?: unknown];

export const mockToast = mock((..._args: ToastArgs) => "toast-id");
export const mockToastSuccess = mock((..._args: ToastArgs) => "toast-id");
export const mockToastError = mock((..._args: ToastArgs) => "toast-id");
export const mockToastInfo = mock((..._args: ToastArgs) => "toast-id");
export const mockToastWarning = mock((..._args: ToastArgs) => "toast-id");
export const mockToastLoading = mock((..._args: ToastArgs) => "toast-id");
export const mockToastCustom = mock((..._args: ToastArgs) => "toast-id");
export const mockToastPromise = mock((..._args: ToastArgs) => "toast-id");
export const mockToastDismiss = mock((..._args: ToastArgs) => undefined);

export function resetSonnerMocks(): void {
  mockToast.mockClear();
  mockToastSuccess.mockClear();
  mockToastError.mockClear();
  mockToastInfo.mockClear();
  mockToastWarning.mockClear();
  mockToastLoading.mockClear();
  mockToastCustom.mockClear();
  mockToastPromise.mockClear();
  mockToastDismiss.mockClear();
}

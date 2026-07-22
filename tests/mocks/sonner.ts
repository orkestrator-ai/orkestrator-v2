import { mock } from "bun:test";

export const mockToast = mock(() => "toast-id");
export const mockToastSuccess = mock(() => "toast-id");
export const mockToastError = mock(() => "toast-id");
export const mockToastInfo = mock(() => "toast-id");
export const mockToastWarning = mock(() => "toast-id");
export const mockToastLoading = mock(() => "toast-id");
export const mockToastCustom = mock(() => "toast-id");
export const mockToastPromise = mock(() => "toast-id");
export const mockToastDismiss = mock(() => undefined);

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

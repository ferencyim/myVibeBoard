/** @vitest-environment jsdom */
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";

vi.mock("@/components/ui/button", () => ({
  Button: ({
    children,
    onPress,
    disabled,
  }: {
    children: React.ReactNode;
    onPress(): void;
    disabled: boolean;
  }) => (
    <button type="button" onClick={onPress} disabled={disabled}>
      {children}
    </button>
  ),
}));

import { RefreshModelsButton } from "./refresh-models-button";

it("only offers refresh when available and blocks repeated refresh while loading", () => {
  const container = document.createElement("div");
  const root = createRoot(container);
  const refresh = vi.fn();
  act(() => root.render(<RefreshModelsButton isLoading={false} />));
  expect(container.querySelector("button")).toBeNull();
  act(() => root.render(<RefreshModelsButton onRefresh={refresh} isLoading={false} />));
  const button = container.querySelector("button")!;
  expect(button.textContent).toBe("刷新模型列表");
  act(() => button.click());
  expect(refresh).toHaveBeenCalledTimes(1);
  act(() => root.render(<RefreshModelsButton onRefresh={refresh} isLoading />));
  act(() => button.click());
  expect(refresh).toHaveBeenCalledTimes(1);
  act(() => root.unmount());
});

import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it } from "vitest";
import { SettingsNavigationScrollView } from "./navigation-scroll-view";

const contentStyle = { height: 800 };
const wideStyle = { height: 200, width: 240 };
const narrowStyle = { height: 200, width: 180 };

it("preserves a real web scroll offset across native and plugin route remounts", async () => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const renderRoute = async (route: string, width: number) => {
    await act(async () => {
      root.render(
        <SettingsNavigationScrollView
          key={route}
          style={width === 240 ? wideStyle : narrowStyle}
          testID="nav"
        >
          <div style={contentStyle}>{route}</div>
        </SettingsNavigationScrollView>,
      );
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 100));
    });
    return container.querySelector('[data-testid="nav"]') as HTMLElement;
  };
  try {
    let nav = await renderRoute("general", 240);
    nav.scrollTop = 395;
    nav.dispatchEvent(new Event("scroll"));
    nav = await renderRoute("/settings/hosts/h/plugins/vibe-board/task-default-models", 240);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(nav.scrollTop).toBe(395);
    nav = await renderRoute("/settings/hosts/h/plugins/vibe-context/compression", 180);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(nav.scrollTop).toBe(395);
    nav = await renderRoute("connections", 180);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(nav.scrollTop).toBe(395);
  } finally {
    act(() => root.unmount());
    container.remove();
  }
});

it("ignores hidden screens and restores the latest offset when a retained screen regains focus", async () => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const setFocus = async (focused: "first" | "second") => {
    await act(async () => {
      root.render(
        <>
          <SettingsNavigationScrollView
            focused={focused === "first"}
            style={wideStyle}
            testID="first"
          >
            <div style={contentStyle} />
          </SettingsNavigationScrollView>
          <SettingsNavigationScrollView
            focused={focused === "second"}
            style={wideStyle}
            testID="second"
          >
            <div style={contentStyle} />
          </SettingsNavigationScrollView>
        </>,
      );
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 100));
    });
  };
  try {
    await setFocus("first");
    const first = container.querySelector('[data-testid="first"]') as HTMLElement;
    const second = container.querySelector('[data-testid="second"]') as HTMLElement;
    first.scrollTop = 350;
    first.dispatchEvent(new Event("scroll"));
    await setFocus("second");
    expect(second.scrollTop).toBe(350);
    first.scrollTop = 0;
    first.dispatchEvent(new Event("scroll"));
    second.scrollTop = 210;
    second.dispatchEvent(new Event("scroll"));
    await setFocus("first");
    expect(first.scrollTop).toBe(210);
  } finally {
    act(() => root.unmount());
    container.remove();
  }
});

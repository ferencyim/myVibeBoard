/** @vitest-environment jsdom */
import React from "react";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SettingsNavigationScrollView } from "./navigation-scroll-view";

interface MockProps {
  children?: React.ReactNode;
  onLayout(event: { nativeEvent: { layout: { height: number } } }): void;
  onContentSizeChange(width: number, height: number): void;
  onScroll(event: { nativeEvent: { contentOffset: { y: number } } }): void;
  onScrollBeginDrag(event: { nativeEvent: { contentOffset: { y: number } } }): void;
}
const scroll = vi.hoisted(() => ({ props: null as unknown as MockProps, scrollTo: vi.fn() }));
vi.mock("react-native", async () => {
  const ReactModule = await import("react");
  return {
    ScrollView: ReactModule.forwardRef((props: MockProps, ref) => {
      scroll.props = props;
      ReactModule.useImperativeHandle(ref, () => ({ scrollTo: scroll.scrollTo }));
      return <div>{props.children}</div>;
    }),
  };
});

const offset = (y: number) => ({ nativeEvent: { contentOffset: { y } } });
const layout = () => scroll.props.onLayout({ nativeEvent: { layout: { height: 400 } } });
afterEach(() => {
  cleanup();
  scroll.scrollTo.mockClear();
});

describe("settings navigation scrolling", () => {
  it("restores after route remounts, waits for plugins, and respects user scrolling", () => {
    const first = render(
      <SettingsNavigationScrollView>
        <span>原生设置</span>
      </SettingsNavigationScrollView>,
    );
    act(() => {
      layout();
      scroll.props.onContentSizeChange(200, 1200);
      scroll.props.onScroll(offset(420));
    });
    first.unmount();
    scroll.scrollTo.mockClear();

    const plugin = render(
      <SettingsNavigationScrollView>
        <span>插件设置</span>
      </SettingsNavigationScrollView>,
    );
    act(() => {
      layout();
      scroll.props.onContentSizeChange(200, 500);
      scroll.props.onScroll(offset(0));
    });
    expect(scroll.scrollTo).not.toHaveBeenCalled();
    act(() => scroll.props.onContentSizeChange(200, 1200));
    expect(scroll.scrollTo).toHaveBeenLastCalledWith({ y: 420, animated: false });
    act(() => scroll.props.onScroll(offset(300)));
    plugin.unmount();
    scroll.scrollTo.mockClear();

    const compact = render(
      <SettingsNavigationScrollView>
        <span>窄屏导航</span>
      </SettingsNavigationScrollView>,
    );
    act(() => {
      layout();
      scroll.props.onContentSizeChange(200, 500);
      scroll.props.onScroll(offset(60));
    });
    act(() => scroll.props.onContentSizeChange(200, 1200));
    expect(scroll.scrollTo).not.toHaveBeenCalled();
    compact.unmount();

    render(
      <SettingsNavigationScrollView>
        <span>返回导航</span>
      </SettingsNavigationScrollView>,
    );
    act(() => {
      layout();
      scroll.props.onContentSizeChange(200, 1200);
    });
    expect(scroll.scrollTo).toHaveBeenLastCalledWith({ y: 60, animated: false });
  });
});

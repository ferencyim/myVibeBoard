import { useCallback, useLayoutEffect, useRef } from "react";
import {
  ScrollView,
  type LayoutChangeEvent,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  type ScrollViewProps,
} from "react-native";

// Each settings route owns a screen, so its navigation scroll view is remounted.
let navigationOffset = 0;
let activeNavigation = 0;
let nextNavigation = 0;

export function SettingsNavigationScrollView({
  onScroll,
  onScrollBeginDrag,
  onContentSizeChange,
  onLayout,
  focused = true,
  ...props
}: ScrollViewProps & { focused?: boolean }) {
  const scrollRef = useRef<ScrollView>(null);
  const instance = useRef(++nextNavigation);
  const mounted = useRef(false);
  const initialOffset = useRef(navigationOffset);
  const restored = useRef(false);
  const viewportHeight = useRef(0);
  const contentHeight = useRef(0);
  const focusedRef = useRef(focused);

  const restore = useCallback(() => {
    if (
      focusedRef.current &&
      !restored.current &&
      viewportHeight.current > 0 &&
      contentHeight.current + 1 >= viewportHeight.current + initialOffset.current
    ) {
      restored.current = true;
      scrollRef.current?.scrollTo({ y: initialOffset.current, animated: false });
    }
  }, []);
  useLayoutEffect(() => {
    focusedRef.current = focused;
    if (!focused) return;
    initialOffset.current = navigationOffset;
    restored.current = false;
    activeNavigation = instance.current;
    mounted.current = true;
    const node = scrollRef.current?.getScrollableNode?.() as unknown as
      | { scrollTop?: number }
      | undefined;
    restore();
    return () => {
      mounted.current = false;
      // React Native Web emits a final, delayed scroll event even after unmount.
      if (activeNavigation === instance.current) {
        if (typeof node?.scrollTop === "number") navigationOffset = Math.max(0, node.scrollTop);
        activeNavigation = 0;
      }
    };
  }, [focused, restore]);
  const handleLayout = useCallback(
    (event: LayoutChangeEvent) => {
      viewportHeight.current = event.nativeEvent.layout.height;
      restore();
      onLayout?.(event);
    },
    [onLayout, restore],
  );
  const handleContentSizeChange = useCallback(
    (width: number, height: number) => {
      contentHeight.current = height;
      restore();
      onContentSizeChange?.(width, height);
    },
    [onContentSizeChange, restore],
  );
  const handleScroll = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      const offset = Math.max(0, event.nativeEvent.contentOffset.y);
      // A retained settings screen can become visible again after the newer screen unmounts.
      if (mounted.current && activeNavigation === 0) activeNavigation = instance.current;
      // A nonzero scroll before restoration is user input, not an initial layout event.
      if (activeNavigation === instance.current && (restored.current || offset > 0)) {
        restored.current = true;
        navigationOffset = offset;
      }
      onScroll?.(event);
    },
    [onScroll],
  );
  const handleScrollBeginDrag = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      if (mounted.current && activeNavigation === 0) activeNavigation = instance.current;
      if (activeNavigation === instance.current) {
        restored.current = true;
        navigationOffset = Math.max(0, event.nativeEvent.contentOffset.y);
      }
      onScrollBeginDrag?.(event);
    },
    [onScrollBeginDrag],
  );

  return (
    <ScrollView
      {...props}
      ref={scrollRef}
      onLayout={handleLayout}
      onContentSizeChange={handleContentSizeChange}
      onScroll={handleScroll}
      onScrollBeginDrag={handleScrollBeginDrag}
      scrollEventThrottle={16}
    />
  );
}

import { useCallback, useRef } from "react";
import {
  ScrollView,
  type LayoutChangeEvent,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  type ScrollViewProps,
} from "react-native";

// Each settings route owns a screen, so its navigation scroll view is remounted.
let navigationOffset = 0;

export function SettingsNavigationScrollView({
  onScroll,
  onScrollBeginDrag,
  onContentSizeChange,
  onLayout,
  ...props
}: ScrollViewProps) {
  const scrollRef = useRef<ScrollView>(null);
  const initialOffset = useRef(navigationOffset);
  const restored = useRef(false);
  const viewportHeight = useRef(0);
  const contentHeight = useRef(0);

  const restore = useCallback(() => {
    if (
      !restored.current &&
      viewportHeight.current > 0 &&
      contentHeight.current >= viewportHeight.current + initialOffset.current
    ) {
      restored.current = true;
      scrollRef.current?.scrollTo({ y: initialOffset.current, animated: false });
    }
  }, []);
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
      // A nonzero scroll before restoration is user input, not an initial layout event.
      if (restored.current || offset > 0) {
        restored.current = true;
        navigationOffset = offset;
      }
      onScroll?.(event);
    },
    [onScroll],
  );
  const handleScrollBeginDrag = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      restored.current = true;
      navigationOffset = Math.max(0, event.nativeEvent.contentOffset.y);
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

import {
  Children,
  cloneElement,
  isValidElement,
  type ComponentProps,
  type ReactElement,
} from "react";
import { PressHighlight } from "@/components/ui/press-highlight";
import type {
  Tooltip as WebTooltip,
  TooltipTrigger as WebTooltipTrigger,
  TooltipContent as WebTooltipContent,
} from "./tooltip";

/** Touch interfaces expose actions directly; the tooltip adds no native surface. */
export function Tooltip({ children }: ComponentProps<typeof WebTooltip>) {
  return children;
}

function composeHandlers(original: unknown, injected: unknown) {
  return (event: unknown) => {
    if (typeof original === "function") original(event);
    if (typeof injected === "function") injected(event);
  };
}

export function TooltipTrigger({
  children,
  asChild = false,
  triggerRefProp: _triggerRefProp,
  disabled,
  ...props
}: ComponentProps<typeof WebTooltipTrigger>): ReactElement {
  if (!asChild) {
    return (
      <PressHighlight {...props} disabled={disabled}>
        {children}
      </PressHighlight>
    );
  }
  const child = Children.only(children);
  if (!isValidElement(child)) {
    throw new Error("TooltipTrigger with asChild expects a single React element child");
  }
  const rawProps: unknown = child.props;
  if (typeof rawProps !== "object" || rawProps === null) {
    throw new Error("TooltipTrigger asChild child must have props object");
  }
  const mergedProps: Record<string, unknown> = {
    ...props,
    disabled: Reflect.get(rawProps, "disabled") || disabled,
  };
  for (const event of ["onPress", "onPressIn", "onPressOut", "onLongPress", "onFocus", "onBlur"]) {
    mergedProps[event] = composeHandlers(Reflect.get(rawProps, event), Reflect.get(props, event));
  }
  return cloneElement(child, mergedProps);
}

export function TooltipContent(_props: ComponentProps<typeof WebTooltipContent>) {
  return null;
}

import { forwardRef } from "react";
import { StyleSheet } from "react-native-unistyles";
import { Input, type InputProps, type InputHandle } from "./input";

export type TextareaProps = Omit<InputProps, "multiline">;
export const Textarea = forwardRef<InputHandle, TextareaProps>(function Textarea(
  { style, ...props },
  ref,
) {
  return <Input {...props} ref={ref} multiline style={[styles.textarea, style]} />;
});

const styles = StyleSheet.create({
  textarea: { minHeight: 96, textAlignVertical: "top" },
});

import { Redirect } from "expo-router";
import { VisualFoundationPreview } from "@/ui/preview";

export default function UiPreviewRoute() {
  if (!__DEV__) return <Redirect href="/" />;
  return <VisualFoundationPreview />;
}

export function conversationControlsPlacement(
  compact: boolean,
  fullscreen: boolean,
  runtimeOpen: boolean,
) {
  if (fullscreen) return "composer";
  if (!compact) return "header";
  return runtimeOpen ? "runtime" : "registration";
}

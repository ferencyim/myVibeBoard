import { describe, expect, it, vi } from "vitest";
import { runPluginClientBundle, type PluginClientRuntime } from "./evaluate";
// Registration does not render UI or read settings; avoid native module initialization.
vi.mock("./react-native/ui", () => ({}));
vi.mock("./settings/use-settings", () => ({ useSettings() {} }));
vi.mock("@/utils/open-external-url", () => ({ openExternalUrl() {} }));
vi.mock("react-native", () => ({}));
vi.mock("@getpaseo/plugin/client", () => ({}));
vi.mock("@/hooks/use-revealed-text", () => ({ useRevealedText() {} }));
vi.mock("@getpaseo/plugin", () => ({}));
vi.mock("./icons", () => ({ parsePluginIcon() {}, parseSerializablePluginIcon() {} }));
vi.mock("./themes", () => ({ parsePluginThemeContribution() {} }));
const runtime = {} as PluginClientRuntime;
function sidebar(order: string) {
  return runPluginClientBundle(
    "example",
    "(function() { return { default(plugin) { plugin.addSidebarHeaderItem({ id: 'library', title: 'Library', order: " +
      order +
      ", Component() { return null; } }); return () => {}; } }; })",
    runtime,
  );
}
describe("sidebar contribution order", () => {
  it("preserves an explicit order in evaluated registrations", () => {
    expect(sidebar("-20").sidebarItems.header[0]?.order).toBe(-20);
  });
  it.each(["NaN", "Infinity", "'first'"])("rejects invalid order %s", (order) => {
    expect(() => sidebar(order)).toThrow("Sidebar item library has invalid order");
  });
});

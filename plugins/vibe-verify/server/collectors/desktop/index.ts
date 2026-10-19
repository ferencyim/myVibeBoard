export { createDesktopCollector, type DesktopCollectorOptions } from "./collector";
export { createNodeAppLauncher, type AppLauncher, type AppProcess } from "./launcher";
export {
  createWindowsCapturer,
  createMacCapturer,
  defaultWindowCapturer,
  buildWindowsCaptureScript,
  type WindowCapturer,
  type WindowTarget,
} from "./window";
export { createPlaywrightElectronDriver, type ElectronDriver, type ElectronSession } from "./electron";
export * from "./config";

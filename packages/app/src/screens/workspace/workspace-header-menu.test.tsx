/** @vitest-environment jsdom */
import React from "react";
import { render, fireEvent, cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkspaceHeaderMenuDesktop } from "./workspace-header-menu";

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("expo-router", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("lucide-react-native", () => {
  const Icon = () => null;
  return {
    Columns2: Icon,
    Copy: Icon,
    Ellipsis: Icon,
    Globe: Icon,
    Import: Icon,
    Rows2: Icon,
    Settings: Icon,
  };
});
vi.mock("react-native-unistyles", () => ({
  StyleSheet: { create: () => ({}) },
  withUnistyles: (component: unknown) => component,
}));
vi.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuTrigger: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuLabel: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuSeparator: () => <hr />,
  DropdownMenuItem: ({
    children,
    testID,
    onSelect,
  }: {
    children: React.ReactNode;
    testID?: string;
    onSelect?: () => void;
  }) => (
    <button type="button" data-testid={testID} onClick={onSelect}>
      {children}
    </button>
  ),
}));
vi.mock("@/components/ui/icon-button-chrome", () => ({
  extraMutedIconColorMapping: () => ({}),
  iconButtonChromeGlyphSize: () => 16,
  iconButtonChromeStyle: () => ({}),
  useIconButtonChromeStyle: () => ({}),
}));
vi.mock("@/components/terminal-profile-icon", () => ({ TerminalProfileIcon: () => null }));
vi.mock("@/hooks/use-daemon-config", () => ({ useDaemonConfig: () => ({}) }));
vi.mock("@/screens/workspace/scripts", () => ({
  useWorkspaceScriptsMenuPages: () => ({ pages: [] }),
}));
vi.mock("@/plugins", () => ({ usePluginWorkspaceMenu: () => ({ pages: [], rows: [] }) }));

afterEach(cleanup);

describe("workspace header menu", () => {
  const actions = {
    currentBranchName: null,
    showWorkspaceSetup: false,
    importAgentDisabled: false,
    copyPathDisabled: false,
    onOpenImportSheet: vi.fn(),
    onCopyWorkspacePath: vi.fn(),
    onCopyBranchName: vi.fn(),
    onOpenSetupTab: vi.fn(),
  };
  it("keeps workspace actions and invokes both merged split actions", () => {
    const right = vi.fn();
    const down = vi.fn();
    const view = render(
      <WorkspaceHeaderMenuDesktop {...actions} onSplitRight={right} onSplitDown={down} />,
    );
    fireEvent.click(view.getByTestId("workspace-split-pane-right"));
    fireEvent.click(view.getByTestId("workspace-split-pane-down"));
    expect(right).toHaveBeenCalledOnce();
    expect(down).toHaveBeenCalledOnce();
    expect(view.getByTestId("workspace-header-copy-path")).toBeTruthy();
  });
  it("does not offer split actions when unavailable", () => {
    const view = render(<WorkspaceHeaderMenuDesktop {...actions} />);
    expect(view.queryByTestId("workspace-split-pane-right")).toBeNull();
    expect(view.queryByTestId("workspace-split-pane-down")).toBeNull();
  });
});

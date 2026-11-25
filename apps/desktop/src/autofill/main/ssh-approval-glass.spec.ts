import { createRequire } from "node:module";

import { BrowserWindow } from "electron";
import { mock } from "jest-mock-extended";

import { LogService } from "@bitwarden/common/platform/abstractions/log.service";

import { applySshApprovalGlass } from "./ssh-approval-glass";

jest.mock("node:module", () => ({ createRequire: jest.fn() }));

describe("SSH approval glass", () => {
  const originalPlatform = process.platform;
  const apply = jest.fn();
  const window = mock<BrowserWindow>();
  const log = mock<LogService>();

  beforeEach(() => {
    jest.clearAllMocks();
    Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
    (createRequire as jest.Mock).mockReturnValue(() => ({ apply }));
    window.getNativeWindowHandle.mockReturnValue(Buffer.alloc(8));
  });

  afterEach(() => {
    Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
  });

  it("applies native glass without layering vibrancy over it", () => {
    apply.mockReturnValue(true);
    applySshApprovalGlass(window, log);
    expect(apply).toHaveBeenCalledWith(window.getNativeWindowHandle());
    expect(window.setVibrancy).not.toHaveBeenCalled();
  });

  it("falls back to native vibrancy on older macOS", () => {
    apply.mockReturnValue(false);
    applySshApprovalGlass(window, log);
    expect(window.setVibrancy).toHaveBeenCalledWith("popover");
  });

  it("keeps approval usable if the native module cannot load", () => {
    (createRequire as jest.Mock).mockImplementation(() => {
      throw new Error("unavailable");
    });
    applySshApprovalGlass(window, log);
    expect(log.warning).toHaveBeenCalled();
    expect(window.setVibrancy).toHaveBeenCalledWith("popover");
  });

  it("does not load native code on other platforms", () => {
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    applySshApprovalGlass(window, log);
    expect(createRequire).not.toHaveBeenCalled();
    expect(window.setVibrancy).not.toHaveBeenCalled();
  });
});

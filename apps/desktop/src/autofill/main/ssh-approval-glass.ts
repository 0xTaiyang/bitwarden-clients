import { createRequire } from "node:module";
import * as path from "path";

import { BrowserWindow } from "electron";

import { LogService } from "@bitwarden/common/platform/abstractions/log.service";

/** Keep native view ownership inside the SSH panel; the vault window is never modified. */
export function applySshApprovalGlass(window: BrowserWindow, log: LogService): void {
  if (process.platform !== "darwin") {
    return;
  }
  try {
    const nativeRequire = createRequire(path.join(__dirname, "main.js"));
    const glass = nativeRequire(path.join(__dirname, "ssh-glass.node")) as {
      apply: (handle: Buffer) => boolean;
    };
    if (glass.apply(window.getNativeWindowHandle())) {
      return;
    }
  } catch (error) {
    log.warning("SSH panel Liquid Glass unavailable; using native vibrancy", error);
  }
  window.setVibrancy("popover");
}

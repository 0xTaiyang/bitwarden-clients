import * as fs from "fs";
import { EventEmitter } from "node:events";
import { pathToFileURL } from "node:url";
import * as path from "path";

import { app, BrowserWindow, ipcMain, session } from "electron";
import { mock, MockProxy } from "jest-mock-extended";
import { BehaviorSubject, NEVER, of } from "rxjs";

import { LogService } from "@bitwarden/common/platform/abstractions/log.service";
import { AbstractStorageService } from "@bitwarden/common/platform/abstractions/storage.service";
import { BiometricStateService } from "@bitwarden/key-management";

import { applySshApprovalGlass } from "../autofill/main/ssh-approval-glass";
import { SafeShell } from "../platform/main/safe-shell.main";
import { ModalModeState } from "../platform/models/domain/window-state";
import { DesktopSettingsService } from "../platform/services/desktop-settings.service";

jest.mock("../autofill/main/ssh-approval-glass", () => ({
  applySshApprovalGlass: jest.fn(),
}));

// window.main.ts registers a privileged scheme at module load time, which
// requires the electron runtime. Mock the surface the module touches on
// import so it can be loaded in Jest.
jest.mock("electron", () => ({
  app: {},
  BrowserWindow: jest.fn(),
  ipcMain: { on: jest.fn(), handle: jest.fn() },
  nativeTheme: {},
  powerMonitor: { on: jest.fn() },
  screen: {
    getCursorScreenPoint: jest.fn().mockReturnValue({ x: 400, y: 300 }),
    getDisplayNearestPoint: jest.fn().mockReturnValue({
      workArea: { x: 0, y: 0, width: 1440, height: 900 },
    }),
  },
  session: {},
  protocol: { registerSchemesAsPrivileged: jest.fn() },
  net: {},
}));

// window.main.ts imports processisolations, which loads a native .node
// module at import time.
jest.mock("@bitwarden/desktop-napi", () => ({
  processisolations: {
    isolateProcess: jest.fn(),
    isCoreDumpingDisabled: jest.fn(),
    disableCoredumps: jest.fn(),
  },
}));

import { isSnapStore } from "./platform-utils.main";
import { isConfinedSnap, WindowMain } from "./window.main";

describe("WindowMain", () => {
  describe("isLocalBundleUrl", () => {
    let sut: WindowMain;
    // Access the private method under test without widening its visibility
    // in production code.
    let isLocalBundleUrl: (url: string) => boolean;

    // The `file:` branch accepts only the app's own bundle, derived from
    // __dirname the same way the production code does. __dirname here is
    // this spec's directory, which is also the directory the code under test
    // resolves against, so this is the real bundle URL for the running test.
    const bundleUrl = pathToFileURL(path.join(__dirname, "/index.html")).toString();

    beforeEach(() => {
      sut = new WindowMain(
        mock<BiometricStateService>(),
        mock<LogService>(),
        mock<AbstractStorageService>(),
        mock<DesktopSettingsService>(),
        mock<SafeShell>(),
        null,
        () => {},
        null,
      );

      isLocalBundleUrl = (url: string) => (sut as any).isLocalBundleUrl(url);
    });

    it("returns true for the app's own file:// bundle URL", () => {
      expect(isLocalBundleUrl(bundleUrl)).toBe(true);
    });

    it("returns true for the app's own bundle URL with a hash", () => {
      expect(isLocalBundleUrl(`${bundleUrl}#/passkeys`)).toBe(true);
    });

    it("returns true for the app's own bundle URL with a query", () => {
      expect(isLocalBundleUrl(`${bundleUrl}?redirectUrl=/passkeys`)).toBe(true);
    });

    it("returns false for a file:// URL with a foreign host", () => {
      expect(isLocalBundleUrl("file://attacker.com/index.html")).toBe(false);
    });

    it("returns false for a file:// URL in a foreign directory", () => {
      expect(isLocalBundleUrl("file:///tmp/evil/index.html")).toBe(false);
    });

    it("returns false for a file:// URL that traverses outside the bundle dir", () => {
      // The `../` segments normalize (via the URL parser) to
      // /tmp/evil/index.html, outside the bundle.
      expect(isLocalBundleUrl(`${bundleUrl}/../../../tmp/evil/index.html`)).toBe(false);
    });

    it("returns true for a bw-desktop-file://bundle/index.html URL", () => {
      expect(isLocalBundleUrl("bw-desktop-file://bundle/index.html")).toBe(true);
    });

    it("returns false for an external https URL", () => {
      expect(isLocalBundleUrl("https://evil.com")).toBe(false);
    });

    it("returns false for a bw-desktop-file URL with the wrong host", () => {
      expect(isLocalBundleUrl("bw-desktop-file://evil/index.html")).toBe(false);
    });

    it("returns false for an unparseable string without throwing", () => {
      expect(isLocalBundleUrl("not a url")).toBe(false);
    });
  });

  describe("SSH approval window", () => {
    const originalPlatform = process.platform;
    let sut: WindowMain;
    let approvalWindow: Record<string, any>;
    let powerHandlers: Map<string, () => void>;
    let closedHandler: () => void = () => {};

    beforeEach(() => {
      powerHandlers = new Map();
      jest.requireMock("electron").powerMonitor.on.mockImplementation((event, handler) => {
        powerHandlers.set(event, handler);
      });
      Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
      sut = new WindowMain(
        mock<BiometricStateService>(),
        mock<LogService>(),
        mock<AbstractStorageService>(),
        mock<DesktopSettingsService>(),
        mock<SafeShell>(),
        null,
        () => {},
        null,
      );
      approvalWindow = {
        isDestroyed: jest.fn().mockReturnValue(false),
        webContents: { id: 42 },
        setVisibleOnAllWorkspaces: jest.fn(),
        setAlwaysOnTop: jest.fn(),
        setContentProtection: jest.fn(),
        loadURL: jest.fn().mockResolvedValue(undefined),
        show: jest.fn(),
        focus: jest.fn(),
        destroy: jest.fn(),
        once: jest.fn((_event: string, handler: () => void) => handler()),
        on: jest.fn((event: string, handler: () => void) => {
          if (event === "closed") {
            closedHandler = handler;
          }
        }),
      };
      (jest.requireMock("electron").BrowserWindow as jest.Mock).mockReturnValue(approvalWindow);
      (sut as any).session = {};
    });

    afterEach(() => {
      Object.defineProperty(process, "platform", {
        value: originalPlatform,
        configurable: true,
      });
    });

    it("creates a separate panel on the current full-screen Space", async () => {
      const result = (sut as any).showSshApprovalWindow({
        title: "Confirm SSH key usage",
        message: "Terminal is requesting access to Work key.",
        authorizeLabel: "Authorize",
        denyLabel: "Deny",
      });

      expect(jest.requireMock("electron").BrowserWindow).toHaveBeenCalledWith(
        expect.objectContaining({
          width: 440,
          height: 230,
          show: false,
          type: "panel",
          skipTaskbar: true,
          transparent: true,
          backgroundColor: "#00000000",
        }),
      );
      expect(approvalWindow.setVisibleOnAllWorkspaces).toHaveBeenCalledWith(true, {
        visibleOnFullScreen: true,
      });
      expect(approvalWindow.setAlwaysOnTop).toHaveBeenLastCalledWith(true, "floating");
      expect(approvalWindow.loadURL).toHaveBeenCalledWith(
        "bw-desktop-file://bundle/ssh-approval.html",
      );
      expect(approvalWindow.show).toHaveBeenCalled();
      expect(jest.mocked(applySshApprovalGlass).mock.calls.at(-1)?.[0]).toBe(approvalWindow);
      expect(approvalWindow.focus).toHaveBeenCalled();

      closedHandler();
      await expect(result).resolves.toBe(false);
    });

    it("denies cleanly when Electron has already destroyed webContents before closed", async () => {
      const result = (sut as any).showSshApprovalWindow({
        title: "Confirm SSH key usage",
        message: "Terminal is requesting access to Work key.",
        authorizeLabel: "Authorize",
        denyLabel: "Deny",
      });

      Object.defineProperty(approvalWindow, "webContents", {
        get: () => {
          throw new TypeError("Object has been destroyed");
        },
      });
      approvalWindow.isDestroyed.mockReturnValue(true);

      expect(() => closedHandler()).not.toThrow();
      await expect(result).resolves.toBe(false);
      expect(approvalWindow.destroy).not.toHaveBeenCalled();
      expect((sut as any).pendingSshApprovals.size).toBe(0);
    });

    it("routes a remote answer through the desktop decision and revokes the link", async () => {
      const cancel = jest.fn();
      const notify = jest.spyOn((sut as any).remoteSshApproval, "notify").mockResolvedValue(cancel);
      const result = (sut as any).showSshApprovalWindow(
        {
          title: "Confirm SSH key usage",
          message: "Work key.",
          authorizeLabel: "Authorize",
          denyLabel: "Deny",
          expiresAt: Date.now() + 59_000,
        },
        "https://api.day.app/test-key",
      );
      await Promise.resolve();
      const finish = notify.mock.calls[0][2] as (accepted: boolean) => void;
      finish(true);
      await expect(result).resolves.toBe(true);
      expect(cancel).toHaveBeenCalled();
      expect(approvalWindow.destroy).toHaveBeenCalled();
      expect((sut as any).pendingSshApprovals.size).toBe(0);
    });

    it("waits 10 seconds before Bark and preserves the original expiry", async () => {
      jest.useFakeTimers();
      try {
        const notify = jest
          .spyOn((sut as any).remoteSshApproval, "notify")
          .mockResolvedValue(jest.fn());
        const expiresAt = Date.now() + 59_000;
        const prompt = {
          title: "SSH",
          message: "Test key",
          authorizeLabel: "Approve",
          denyLabel: "Deny",
          expiresAt,
        };
        const result = (sut as any).showSshApprovalWindow(prompt, "https://api.day.app/test", true);
        jest.advanceTimersByTime(9_999);
        expect(notify).not.toHaveBeenCalled();
        jest.advanceTimersByTime(1);
        expect(notify).toHaveBeenCalledTimes(1);
        expect((notify.mock.calls[0][1] as any).expiresAt).toBe(expiresAt);
        closedHandler();
        await expect(result).resolves.toBe(false);
      } finally {
        jest.useRealTimers();
      }
    });

    it.each(["approve", "deny", "sleep", "expire"])(
      "cancels delayed Bark when the Mac request ends: %s",
      async (action) => {
        jest.useFakeTimers();
        try {
          const notify = jest
            .spyOn((sut as any).remoteSshApproval, "notify")
            .mockResolvedValue(jest.fn());
          const prompt = {
            title: "SSH",
            message: "Test key",
            authorizeLabel: "Approve",
            denyLabel: "Deny",
            expiresAt: Date.now() + (action === "expire" ? 5_000 : 59_000),
          };
          const result = (sut as any).showSshApprovalWindow(
            prompt,
            "https://api.day.app/test",
            true,
          );
          jest.advanceTimersByTime(4_000);
          if (action === "sleep") {
            powerHandlers.get("suspend")!();
          } else if (action !== "expire") {
            (sut as any).pendingSshApprovals.get(42).finish(action === "approve");
          }
          jest.advanceTimersByTime(10_000);
          expect(notify).not.toHaveBeenCalled();
          await expect(result).resolves.toBe(action === "approve");
        } finally {
          jest.useRealTimers();
        }
      },
    );

    it("rejects a second approval instead of stacking another panel", async () => {
      const browserWindowMock = jest.requireMock("electron").BrowserWindow as jest.Mock;
      const initialWindowCount = browserWindowMock.mock.calls.length;
      const firstResult = (sut as any).showSshApprovalWindow({
        title: "Confirm SSH key usage",
        message: "Terminal is requesting access to Work key.",
        authorizeLabel: "Authorize",
        denyLabel: "Deny",
      });

      const secondResult = (sut as any).showSshApprovalWindow({
        title: "Confirm SSH key usage",
        message: "Terminal is requesting access to Work key.",
        authorizeLabel: "Authorize",
        denyLabel: "Deny",
      });

      await expect(secondResult).resolves.toBe(false);
      expect(browserWindowMock).toHaveBeenCalledTimes(initialWindowCount + 1);

      closedHandler();
      await expect(firstResult).resolves.toBe(false);
    });

    it("closes an approval panel when its SSH request expires", async () => {
      jest.useFakeTimers();
      try {
        const result = (sut as any).showSshApprovalWindow({
          title: "Confirm SSH key usage",
          message: "Terminal is requesting access to Work key.",
          authorizeLabel: "Authorize",
          denyLabel: "Deny",
          expiresAt: Date.now() + 1_000,
        });

        jest.advanceTimersByTime(1_000);

        await expect(result).resolves.toBe(false);
        expect(approvalWindow.destroy).toHaveBeenCalledTimes(1);
        expect((sut as any).pendingSshApprovals.size).toBe(0);
      } finally {
        jest.useRealTimers();
      }
    });

    it("discards an expired panel before ready-to-show even if its timer has not fired", async () => {
      jest.useFakeTimers();
      try {
        let ready: () => void;
        approvalWindow.once.mockImplementation((_event, handler) => {
          ready = handler;
        });
        const result = (sut as any).showSshApprovalWindow({
          title: "SSH",
          message: "Request",
          authorizeLabel: "Authorize",
          denyLabel: "Deny",
          expiresAt: Date.now() + 1_000,
        });
        jest.setSystemTime(Date.now() + 2_000);
        ready!();
        await expect(result).resolves.toBe(false);
        expect(approvalWindow.show).not.toHaveBeenCalled();
        expect(approvalWindow.destroy).toHaveBeenCalledTimes(1);
      } finally {
        jest.useRealTimers();
      }
    });

    it("destroys a sleeping panel and refuses queued approvals after wake", async () => {
      jest.useFakeTimers();
      try {
        let ready: () => void;
        approvalWindow.once.mockImplementation((_event, handler) => {
          ready = handler;
        });
        const prompt = {
          title: "SSH",
          message: "Request",
          authorizeLabel: "Authorize",
          denyLabel: "Deny",
          requestedAt: Date.now(),
          expiresAt: Date.now() + 59_000,
        };
        const result = (sut as any).showSshApprovalWindow(prompt);
        powerHandlers.get("suspend")!();
        await expect(result).resolves.toBe(false);
        ready!();
        expect(approvalWindow.show).not.toHaveBeenCalled();
        expect(approvalWindow.destroy).toHaveBeenCalledTimes(1);
        powerHandlers.get("resume")!();
        await expect((sut as any).showSshApprovalWindow(prompt)).resolves.toBe(false);
        jest.advanceTimersByTime(3_000);
        await expect((sut as any).showSshApprovalWindow(prompt)).resolves.toBe(false);
        const fresh = (sut as any).showSshApprovalWindow({ ...prompt, requestedAt: Date.now() });
        ready!();
        expect(approvalWindow.show).toHaveBeenCalledTimes(1);
        closedHandler();
        await expect(fresh).resolves.toBe(false);
      } finally {
        jest.useRealTimers();
      }
    });
  });

  describe("init", () => {
    let sut: WindowMain;
    let createWindow: jest.SpyInstance;

    beforeEach(() => {
      // Development mode skips process isolation, which is not under test here.
      (global as any).BIT_ENVIRONMENT = "development";

      // `on` never emits, so `ready` behaves as if it fired before `init()` was called.
      Object.assign(app, {
        requestSingleInstanceLock: jest.fn().mockReturnValue(true),
        on: jest.fn(),
        whenReady: jest.fn().mockResolvedValue(undefined),
      });
      Object.assign(session, {
        fromPartition: jest.fn().mockReturnValue({ clearCache: jest.fn() }),
      });

      const desktopSettingsService = mock<DesktopSettingsService>();
      Object.assign(desktopSettingsService, { modalMode$: NEVER, preventScreenshots$: NEVER });

      sut = new WindowMain(
        mock<BiometricStateService>(),
        mock<LogService>(),
        mock<AbstractStorageService>(),
        desktopSettingsService,
        mock<SafeShell>(),
        null,
        () => {},
        null,
      );

      jest.spyOn(sut as any, "setupAppProtocol").mockImplementation(() => {});
      createWindow = jest.spyOn(sut, "createWindow").mockResolvedValue(undefined);
    });

    afterEach(() => {
      jest.restoreAllMocks();
      delete (global as any).BIT_ENVIRONMENT;
      delete (global as any).setImmediate;
    });

    const setUpReload = async () => {
      await sut.init(true);
      // Reloads are skipped in development mode.
      (global as any).BIT_ENVIRONMENT = "production";
      // jsdom has no setImmediate, which the reload uses to yield a tick.
      (global as any).setImmediate = (fn: () => void) => setTimeout(fn, 0);
      jest.spyOn(sut, "getBackgroundColor").mockResolvedValue("#000000");
      (sut as any).enableRendererProcessForceCrashReload = true;

      return jest
        .mocked(ipcMain.on)
        .mock.calls.findLast(([channel]) => channel === "reload-process")[1] as () => Promise<void>;
    };

    it("creates the window when the ready event has already fired", async () => {
      await sut.init(true);

      expect(createWindow).toHaveBeenCalledWith("full-app", true);
    });

    describe("while the startup window is still being created", () => {
      let finishStartupWindow: () => void;
      let initDone: Promise<void>;

      const appHandler = (event: string) =>
        jest.mocked(app.on).mock.calls.find(([name]) => name === event)[1] as (
          ...args: unknown[]
        ) => Promise<void>;

      beforeEach(async () => {
        createWindow.mockReturnValueOnce(
          new Promise<void>((resolve) => (finishStartupWindow = resolve)),
        );
        initDone = sut.init(true);
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(createWindow).toHaveBeenCalledTimes(1);
      });

      it("does not create a second window on activate", async () => {
        const activateDone = appHandler("activate")();
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(createWindow).toHaveBeenCalledTimes(1);

        const win = mock<BrowserWindow>();
        sut.win = win;
        finishStartupWindow();
        await initDone;
        await activateDone;

        expect(createWindow).toHaveBeenCalledTimes(1);
        expect(win.show).toHaveBeenCalled();
      });

      it("focuses the startup window on second-instance", async () => {
        const secondInstanceDone = appHandler("second-instance")({}, [], "");

        const win = mock<BrowserWindow>();
        win.isDestroyed.mockReturnValue(false);
        sut.win = win;
        finishStartupWindow();
        await initDone;
        await secondInstanceDone;

        expect(win.focus).toHaveBeenCalled();
      });
    });

    it("leaves no crash listeners behind after a reload", async () => {
      const reloadProcess = await setUpReload();
      const webContents = Object.assign(new EventEmitter(), {
        forcefullyCrashRenderer: jest.fn(() => webContents.emit("render-process-gone")),
        reloadIgnoringCache: jest.fn(),
      });
      sut.win = {
        webContents,
        setBackgroundColor: jest.fn(),
        isDestroyed: () => false,
      } as any;

      await reloadProcess();
      await reloadProcess();

      expect(webContents.reloadIgnoringCache).toHaveBeenCalledTimes(2);
      expect(webContents.listenerCount("render-process-gone")).toBe(0);
      expect(webContents.listenerCount("destroyed")).toBe(0);
      expect(webContents.listenerCount("error")).toBe(0);
    });

    it("finishes a reload when the window is destroyed during the renderer crash", async () => {
      const reloadProcess = await setUpReload();
      let destroyed = false;
      const webContents = Object.assign(new EventEmitter(), {
        forcefullyCrashRenderer: jest.fn(() => {
          destroyed = true;
          webContents.emit("destroyed");
        }),
        reloadIgnoringCache: jest.fn(),
      });
      sut.win = {
        webContents,
        setBackgroundColor: jest.fn(),
        isDestroyed: () => destroyed,
      } as any;

      await reloadProcess();

      expect(webContents.reloadIgnoringCache).not.toHaveBeenCalled();

      // A stuck reload would skip this one as a duplicate.
      destroyed = false;
      await reloadProcess();

      expect(webContents.forcefullyCrashRenderer).toHaveBeenCalledTimes(2);
    });
  });

  describe("createWindow", () => {
    let sut: WindowMain;
    let modalMode$: BehaviorSubject<ModalModeState>;

    const fakeWindow = () =>
      Object.assign(new EventEmitter(), {
        webContents: {
          on: jest.fn(),
          send: jest.fn(),
          setWindowOpenHandler: jest.fn(),
          userAgent: "",
        },
        isDestroyed: jest.fn().mockReturnValue(false),
        loadURL: jest.fn().mockResolvedValue(undefined),
        show: jest.fn(),
        setContentProtection: jest.fn(),
        setMinimumSize: jest.fn(),
        setResizable: jest.fn(),
        setAlwaysOnTop: jest.fn(),
      });

    beforeEach(() => {
      (global as any).BIT_ENVIRONMENT = "production";

      const desktopSettingsService = mock<DesktopSettingsService>();
      modalMode$ = new BehaviorSubject<ModalModeState>({ isModalModeActive: false });
      Object.assign(desktopSettingsService, {
        alwaysOnTop$: of(false),
        preventScreenshots$: of(false),
        modalMode$,
      });

      sut = new WindowMain(
        mock<BiometricStateService>(),
        mock<LogService>(),
        mock<AbstractStorageService>(),
        desktopSettingsService,
        mock<SafeShell>(),
        null,
        () => {},
        null,
      );

      jest.spyOn(sut as any, "getWindowState").mockResolvedValue({});
      jest.spyOn(sut, "getBackgroundColor").mockResolvedValue("#000000");
    });

    afterEach(() => {
      jest.restoreAllMocks();
      delete (global as any).BIT_ENVIRONMENT;
    });

    it("keeps the newer window when an older window closes", async () => {
      const first = fakeWindow();
      const second = fakeWindow();
      jest.mocked(BrowserWindow).mockImplementationOnce(() => first as any);
      jest.mocked(BrowserWindow).mockImplementationOnce(() => second as any);

      await sut.createWindow();
      await sut.createWindow();
      first.emit("closed");

      expect(sut.win).toBe(second);
    });

    it("handles focus on the remaining window after another window closes", async () => {
      const first = fakeWindow();
      const second = fakeWindow();
      jest.mocked(BrowserWindow).mockImplementationOnce(() => first as any);
      jest.mocked(BrowserWindow).mockImplementationOnce(() => second as any);

      await sut.createWindow();
      await sut.createWindow();
      first.emit("closed");
      second.emit("focus");

      expect(second.webContents.send).toHaveBeenCalledWith("messagingService", {
        command: "windowIsFocused",
        windowIsFocused: true,
      });
    });

    it("tells the renderer when the user closes the window in modal mode", async () => {
      const win = fakeWindow();
      jest.mocked(BrowserWindow).mockImplementationOnce(() => win as any);
      await sut.createWindow();
      modalMode$.next({ isModalModeActive: true });

      win.emit("close");
      await new Promise(process.nextTick);

      expect(win.webContents.send).toHaveBeenCalledWith("messagingService", {
        command: "modalWindowClosed",
      });
    });

    it("does not tell the renderer when the user closes the window outside modal mode", async () => {
      const win = fakeWindow();
      jest.mocked(BrowserWindow).mockImplementationOnce(() => win as any);
      await sut.createWindow();

      win.emit("close");
      await new Promise(process.nextTick);

      expect(win.webContents.send).not.toHaveBeenCalledWith("messagingService", {
        command: "modalWindowClosed",
      });
    });

    it("clears the window reference when the current window closes", async () => {
      const win = fakeWindow();
      jest.mocked(BrowserWindow).mockImplementationOnce(() => win as any);

      await sut.createWindow();
      win.emit("closed");

      expect(sut.win).toBeNull();
    });
  });

  describe("withWindow", () => {
    let sut: WindowMain;
    let desktopSettingsService: MockProxy<DesktopSettingsService>;

    beforeEach(() => {
      desktopSettingsService = mock<DesktopSettingsService>();
      sut = new WindowMain(
        mock<BiometricStateService>(),
        mock<LogService>(),
        mock<AbstractStorageService>(),
        desktopSettingsService,
        mock<SafeShell>(),
        null,
        () => {},
        null,
      );
    });

    it("skips the callback when the window is destroyed", () => {
      const win = mock<BrowserWindow>();
      win.isDestroyed.mockReturnValue(true);
      sut.win = win;
      const fn = jest.fn();

      expect(sut.withWindow(fn)).toBeUndefined();
      expect(fn).not.toHaveBeenCalled();
    });

    it("skips toggling always on top when there is no window", async () => {
      sut.win = null;

      await sut.toggleAlwaysOnTop();

      expect(desktopSettingsService.setAlwaysOnTop).not.toHaveBeenCalled();
    });
  });
});

describe("isConfinedSnap", () => {
  const originalPlatform = process.platform;
  const originalExecPath = process.execPath;
  const originalSnap = process.env.SNAP;
  const originalSnapName = process.env.SNAP_NAME;

  const setPlatform = (platform: NodeJS.Platform) => {
    Object.defineProperty(process, "platform", { value: platform, configurable: true });
  };

  const setExecPath = (execPath: string) => {
    Object.defineProperty(process, "execPath", { value: execPath, configurable: true });
  };

  // Spied rather than module-mocked: this spec's import graph reaches the SDK, which reads its
  // WASM binary through fs at import time, so `jest.mock("fs")` breaks the whole suite.
  let readFileSync: jest.SpyInstance;

  const setCgroup = (contents: string) => {
    readFileSync.mockReturnValue(contents);
  };

  const setCgroupUnreadable = () => {
    readFileSync.mockImplementation(() => {
      throw new Error("ENOENT: no such file or directory, open '/proc/self/cgroup'");
    });
  };

  // A confined snap's cgroup path contains snap.<snap-name>.<app-name>
  const confinedCgroup = (snapName: string) =>
    `0::/user.slice/user-1000.slice/user@1000.service/app.slice/snap.${snapName}.${snapName}.f0e1d2c3.scope\n`;

  beforeEach(() => {
    readFileSync = jest.spyOn(fs, "readFileSync");
    setPlatform("linux");
    // Only the stable snap path is a valid default; each test sets what it needs.
    setExecPath("/snap/bitwarden/x1/opt/Bitwarden/bitwarden");
    setCgroup(confinedCgroup("bitwarden"));
  });

  afterEach(() => {
    jest.restoreAllMocks();
    Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
    Object.defineProperty(process, "execPath", { value: originalExecPath, configurable: true });
    if (originalSnap === undefined) {
      delete process.env.SNAP;
    } else {
      process.env.SNAP = originalSnap;
    }
    if (originalSnapName === undefined) {
      delete process.env.SNAP_NAME;
    } else {
      process.env.SNAP_NAME = originalSnapName;
    }
  });

  it("returns true for the stable snap", () => {
    setExecPath("/snap/bitwarden/x1/opt/Bitwarden/bitwarden");
    setCgroup(confinedCgroup("bitwarden"));
    expect(isConfinedSnap()).toBe(true);
  });

  it("returns true for the beta snap", () => {
    setExecPath("/snap/bitwarden-beta/x1/opt/Bitwarden Beta/bitwarden");
    setCgroup(confinedCgroup("bitwarden-beta"));
    expect(isConfinedSnap()).toBe(true);
  });

  // Fedora, Arch and openSUSE mount snaps at /var/lib/snapd/snap; execPath is canonicalized, so
  // it carries that root rather than the /snap compatibility symlink.
  it("returns true on distros that mount snaps outside /snap", () => {
    setExecPath("/var/lib/snapd/snap/bitwarden/x1/opt/Bitwarden/bitwarden");
    setCgroup(confinedCgroup("bitwarden"));
    expect(isConfinedSnap()).toBe(true);
  });

  it("returns false when execPath is outside a snap mount", () => {
    setExecPath("/opt/Bitwarden/bitwarden");
    expect(isConfinedSnap()).toBe(false);
  });

  // snapd's per-user data dir is user-writable, so a copy planted there must not pass as confined.
  it("returns false for a snap-lookalike path under the user's home", () => {
    setExecPath("/home/user/snap/bitwarden/current/opt/Bitwarden/bitwarden");
    setCgroup(confinedCgroup("bitwarden"));
    expect(isConfinedSnap()).toBe(false);
  });

  it("returns false when execPath belongs to another snap", () => {
    setExecPath("/snap/some-terminal/x1/usr/bin/some-terminal");
    setCgroup(confinedCgroup("some-terminal"));
    expect(isConfinedSnap()).toBe(false);
  });

  it("does not read the cgroup when execPath already rules out a snap", () => {
    setExecPath("/opt/Bitwarden/bitwarden");
    isConfinedSnap();
    expect(readFileSync).not.toHaveBeenCalled();
  });

  it("returns false when the cgroup does not name a bitwarden snap", () => {
    setCgroup("0::/user.slice/user-1000.slice/session-2.scope\n");
    expect(isConfinedSnap()).toBe(false);
  });

  it("returns false when the cgroup cannot be read", () => {
    setCgroupUnreadable();
    expect(isConfinedSnap()).toBe(false);
  });

  it("returns false on non-Linux platforms", () => {
    setPlatform("darwin");
    expect(isConfinedSnap()).toBe(false);
  });

  it("is not fooled by snap env vars alone, unlike isSnapStore", () => {
    setExecPath("/opt/Bitwarden/bitwarden");
    process.env.SNAP = "/snap/bitwarden/x1";
    process.env.SNAP_NAME = "bitwarden";

    expect(isConfinedSnap()).toBe(false);
    expect(isSnapStore()).toBe(true);
  });
});

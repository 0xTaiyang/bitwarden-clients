// FIXME: Update this file to be type safe and remove this and next line
// @ts-strict-ignore
import { ipcMain, powerMonitor } from "electron";

import { LogService } from "@bitwarden/common/platform/abstractions/log.service";
import { MessagingService } from "@bitwarden/common/platform/abstractions/messaging.service";
import { sshagent } from "@bitwarden/desktop-napi";

import { SSH_AGENT_IPC_CHANNELS } from "../models/ipc-channels";

export class MainSshAgentService {
  // The native bridge gives approval callbacks 60 seconds. Expire the Electron side slightly
  // earlier so a timed-out request cannot remain queued and surface as a stale prompt after wake.
  private static readonly SIGN_REQUEST_TIMEOUT_MS = 59_000;

  // The napi callback requestSign() is awaited directly by the Rust agent,
  // so it must return a Promise that resolves with the user's decision.
  // The approval dialog lives in the renderer (a separate process), so bridging a callback
  // to a user decision requires a round-trip: main fires a message to the renderer, the
  // renderer responds via a separate IPC call. Because multiple SSH clients can connect
  // simultaneously, multiple callbacks can be in-flight at once. pendingRequests holds the
  // resolve function for each in-flight callback, keyed by requestId, so the IPC response
  // can be matched back to the correct waiting Promise. Electron has no native
  // main→renderer request-response mechanism, making this correlation map necessary.
  private pendingRequests = new Map<number, (accepted: boolean) => void>();
  private activeSignRequestId: number | null = null;
  private requestId = 0;
  private agentState: sshagent.SshAgentState;
  private suspended = false;
  private resumeAfter = 0;

  constructor(
    private logService: LogService,
    private messagingService: MessagingService,
  ) {
    this.registerIpcHandlers();
    powerMonitor.on("suspend", () => {
      this.suspended = true;
      this.denyPendingRequests();
    });
    powerMonitor.on("resume", () => {
      this.suspended = false;
      // Drain callbacks queued by the native bridge before accepting new work after wake.
      this.resumeAfter = Date.now() + 3_000;
      this.denyPendingRequests();
    });
  }

  private denyPendingRequests() {
    for (const finish of this.pendingRequests.values()) {
      finish(false);
    }
    this.pendingRequests.clear();
  }

  private registerIpcHandlers() {
    ipcMain.handle(SSH_AGENT_IPC_CHANNELS.INIT, async () => {
      await this.init();
    });

    ipcMain.handle(SSH_AGENT_IPC_CHANNELS.IS_LOADED, async () => {
      return this.agentState?.isRunning() ?? false;
    });

    ipcMain.handle(
      SSH_AGENT_IPC_CHANNELS.REPLACE,
      async (_, keys: { name: string; privateKey: string; cipherId: string }[]) => {
        if (this.agentState != null && this.agentState.isRunning()) {
          this.agentState.replace(keys);
        }
      },
    );

    ipcMain.handle(
      SSH_AGENT_IPC_CHANNELS.SIGN_REQUEST_RESPONSE,
      async (_, { requestId, accepted }: { requestId: number; accepted: boolean }) => {
        this.pendingRequests.get(requestId)?.(accepted);
        this.pendingRequests.delete(requestId);
      },
    );

    ipcMain.handle(SSH_AGENT_IPC_CHANNELS.STOP, async () => {
      if (this.agentState != null) {
        this.agentState.stop();
        this.agentState = null;
      }
    });

    ipcMain.handle(
      SSH_AGENT_IPC_CHANNELS.LIST_KEYS_RESPONSE,
      async (_, { requestId, accepted }: { requestId: number; accepted: boolean }) => {
        this.pendingRequests.get(requestId)?.(accepted);
        this.pendingRequests.delete(requestId);
      },
    );
  }

  // Starts the Agent.
  // @pre: The agent must not be running. The caller may utilize `is_running()` and `stop()`.
  private async init() {
    const signCb = (_err: Error | null, data: sshagent.SignRequestData) => this.requestSign(data);
    const listCb = (_err: Error | null) => this.requestListKeys();
    try {
      this.agentState = await sshagent.SshAgentState.serve(signCb, listCb);
      this.logService.info("SSH agent started");
    } catch (e: unknown) {
      this.logService.error("SSH agent encountered an error: ", e);
    }
  }

  private requestListKeys(): Promise<boolean> {
    if (this.suspended || Date.now() < this.resumeAfter) {
      return Promise.resolve(false);
    }
    const id = ++this.requestId;
    return new Promise((resolve) => {
      this.pendingRequests.set(id, resolve);
      this.messagingService.send(SSH_AGENT_IPC_CHANNELS.LIST_KEYS_REQUEST, { requestId: id });
    });
  }

  private requestSign(data: sshagent.SignRequestData): Promise<boolean> {
    if (this.suspended || Date.now() < this.resumeAfter) {
      return Promise.resolve(false);
    }
    // A reconnecting SSH client can deliver a burst of callbacks when macOS wakes. The renderer
    // displays approvals serially, so accepting every callback here creates a backlog of panels
    // that appears endless. Keep at most one actionable sign request and fail closed for the rest.
    if (this.activeSignRequestId != null) {
      this.logService.debug("Rejecting concurrent SSH sign request while approval is pending");
      return Promise.resolve(false);
    }

    const id = ++this.requestId;
    this.activeSignRequestId = id;
    const expiresAt = Date.now() + MainSshAgentService.SIGN_REQUEST_TIMEOUT_MS;
    return new Promise((resolve) => {
      const finish = (accepted: boolean) => {
        global.clearTimeout(timeout);
        this.pendingRequests.delete(id);
        if (this.activeSignRequestId === id) {
          this.activeSignRequestId = null;
        }
        resolve(accepted);
      };
      const timeout = global.setTimeout(() => {
        if (this.pendingRequests.has(id)) {
          finish(false);
        }
      }, MainSshAgentService.SIGN_REQUEST_TIMEOUT_MS);
      this.pendingRequests.set(id, finish);
      this.messagingService.send(SSH_AGENT_IPC_CHANNELS.SIGN_REQUEST, {
        cipherId: data.cipherId,
        requestId: id,
        expiresAt,
        requestedAt: Date.now(),
        processName: data.signRequest.processName,
        isAgentForwarding: data.signRequest.isForwarding,
        namespace: data.signRequest.namespace,
        hostFingerprint: data.signRequest.hostFingerprint,
      });
    });
  }
}

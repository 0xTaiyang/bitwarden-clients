import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, IncomingMessage, Server, ServerResponse } from "node:http";

import { net } from "electron";

import { SshApprovalPrompt } from "../models/ssh-approval-prompt";

import { sshRemoteApprovalPage } from "./ssh-remote-approval-page";

export const SSH_APPROVAL_PORT = 52763;
export const SSH_APPROVAL_ORIGIN = `http://taiyang-air.sgponte:${SSH_APPROVAL_PORT}`;

interface PendingRemoteApproval {
  token: string;
  request: SshApprovalPrompt;
  finish: (approved: boolean) => void;
  isCurrent: () => boolean;
}

/** Loopback-only HTTP is carried to the phone by the encrypted Surge Ponte connection. */
export class SshRemoteApprovalService {
  private server?: Server;
  private starting?: Promise<void>;
  private pending?: PendingRemoteApproval;

  constructor(
    private readonly port = SSH_APPROVAL_PORT,
    private readonly origin = SSH_APPROVAL_ORIGIN,
  ) {}

  async notify(
    barkUrl: string,
    request: SshApprovalPrompt,
    finish: (approved: boolean) => void,
    isCurrent: () => boolean,
  ): Promise<() => void> {
    await this.start();
    if (!isCurrent() || request.expiresAt == null || request.expiresAt <= Date.now()) {
      return () => {};
    }
    const token = randomBytes(32).toString("hex");
    const pending = { token, request, finish, isCurrent };
    this.pending = pending;
    const cancel = () => {
      if (this.pending === pending) {
        this.pending = undefined;
      }
    };
    try {
      await this.push(
        barkUrl,
        "SSH approval requested",
        "Tap to review and approve or deny on your Mac.",
        `${this.origin}/#${token}`,
      );
    } catch {
      cancel();
      throw new Error("Bark notification could not be delivered");
    }
    if (!isCurrent()) {
      cancel();
    }
    return cancel;
  }

  async test(barkUrl: string): Promise<void> {
    await this.start();
    await this.push(
      barkUrl,
      "SSH approval connection test",
      "Tap to check that your iPhone can reach this Mac through Surge Ponte.",
      `${this.origin}/`,
    );
  }

  cancel(): void {
    this.pending = undefined;
  }

  async close(): Promise<void> {
    this.cancel();
    await this.starting?.catch(() => {});
    const server = this.server;
    this.server = undefined;
    if (server) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }

  private async push(barkUrl: string, title: string, body: string, link: string): Promise<void> {
    const url = new URL(barkUrl.trim());
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.hash ||
      url.pathname === "/"
    ) {
      throw new Error("Invalid Bark URL");
    }
    // The configured URL is the server and device-key endpoint, not a prefilled notification.
    url.search = "";
    const controller = new AbortController();
    const timeout = global.setTimeout(() => controller.abort(), 8_000);
    try {
      const response = await net.fetch(url.toString(), {
        method: "POST",
        redirect: "error",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title,
          body,
          url: link,
          group: "ssh-approval",
          icon: "https://raw.githubusercontent.com/bitwarden/clients/main/apps/desktop/resources/icons/128x128.png",
          level: "active",
          sound: "silence",
          isArchive: 0,
        }),
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error("Bark push failed");
      }
      const result = (await response.json()) as { code?: number };
      if (result.code !== 200) {
        throw new Error("Bark rejected the push");
      }
    } finally {
      global.clearTimeout(timeout);
    }
  }

  private start(): Promise<void> {
    if (this.starting != null) {
      return this.starting;
    }
    if (this.server?.listening) {
      return Promise.resolve();
    }
    this.starting = new Promise<void>((resolve, reject) => {
      const server = createServer((request, response) => {
        void this.handle(request, response).catch(() => {
          if (!response.headersSent) {
            response.writeHead(400);
          }
          response.end();
        });
      });
      server.requestTimeout = 5_000;
      server.headersTimeout = 5_000;
      server.on("error", () => {
        this.cancel();
        reject(new Error("SSH approval listener could not start"));
      });
      server.listen(this.port, "127.0.0.1", () => {
        this.server = server;
        resolve();
      });
    }).finally(() => {
      this.starting = undefined;
    });
    return this.starting;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    const expectedHost = new URL(this.origin).host;
    // Restrict the Host header to prevent DNS rebinding to this loopback listener.
    if (req.headers.host !== expectedHost) {
      res.writeHead(403).end();
      return;
    }
    if (req.url === "/" && req.method === "GET") {
      const nonce = randomBytes(16).toString("hex");
      res.setHeader(
        "Content-Security-Policy",
        `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'`,
      );
      res
        .writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
        .end(sshRemoteApprovalPage(nonce));
      return;
    }
    if (req.url !== "/api/ssh-approval" || !["GET", "POST"].includes(req.method ?? "")) {
      res.writeHead(404).end();
      return;
    }
    const token = req.headers.authorization?.replace(/^Bearer /, "") ?? "";
    const pending = this.pending;
    if (
      !pending ||
      !/^[a-f0-9]{64}$/.test(token) ||
      !timingSafeEqual(Buffer.from(token), Buffer.from(pending.token)) ||
      !pending.isCurrent() ||
      (pending.request.expiresAt ?? 0) <= Date.now()
    ) {
      res.writeHead(410).end();
      return;
    }
    if (req.method === "GET") {
      // Return only display metadata; never include the device key or a private SSH key.
      const { title, message, warningMessage, hostFingerprint, expiresAt } = pending.request;
      res
        .writeHead(200, { "Content-Type": "application/json" })
        .end(JSON.stringify({ title, message, warningMessage, hostFingerprint, expiresAt }));
      return;
    }
    if (req.headers.origin !== this.origin || req.headers["content-type"] !== "application/json") {
      res.writeHead(403).end();
      return;
    }
    let body = "";
    for await (const chunk of req) {
      body += chunk.toString();
      if (body.length > 128) {
        res.writeHead(413).end();
        return;
      }
    }
    const decision = JSON.parse(body) as { approved?: unknown };
    if (typeof decision.approved !== "boolean") {
      res.writeHead(400).end();
      return;
    }
    // Revalidate after reading the body, before consuming the single-use capability.
    if (
      this.pending !== pending ||
      !pending.isCurrent() ||
      (pending.request.expiresAt ?? 0) <= Date.now()
    ) {
      res.writeHead(410).end();
      return;
    }
    this.pending = undefined;
    pending.finish(decision.approved);
    res.writeHead(200, { "Content-Type": "application/json" }).end('{"answered":true}');
  }
}

import { request as httpRequest } from "node:http";

jest.mock("electron", () => ({ net: { fetch: jest.fn() } }));

import { net } from "electron";

import { SshApprovalPrompt } from "../models/ssh-approval-prompt";

import { SshRemoteApprovalService } from "./ssh-remote-approval.service";

describe("SSH remote approval over Ponte", () => {
  let service: SshRemoteApprovalService;
  let port: number;
  const origin = "http://taiyang-air.sgponte:52763";
  const push = net.fetch as jest.Mock;
  let prompt: SshApprovalPrompt;
  let finish: jest.Mock;
  let current: boolean;
  let token: string;

  function call(
    method: string,
    authorization = token,
    body?: unknown,
    requestOrigin = origin,
    host = new URL(origin).host,
  ) {
    return new Promise<{ status: number; body: string; headers: Record<string, unknown> }>(
      (resolve, reject) => {
        const req = httpRequest(
          {
            hostname: "127.0.0.1",
            port,
            path: "/api/ssh-approval",
            method,
            headers: {
              Host: host,
              Authorization: `Bearer ${authorization}`,
              Origin: requestOrigin,
              "Content-Type": "application/json",
            },
          },
          (response) => {
            let data = "";
            response.on("data", (chunk) => {
              data += chunk.toString();
            });
            response.on("end", () =>
              resolve({ status: response.statusCode!, body: data, headers: response.headers }),
            );
          },
        );
        req.on("error", reject);
        req.end(body == null ? undefined : JSON.stringify(body));
      },
    );
  }

  async function notify() {
    const cancel = await service.notify(
      "https://api.day.app/test-device-key",
      prompt,
      finish,
      () => current,
    );
    if (push.mock.calls.length) {
      const payload = JSON.parse(push.mock.calls.at(-1)![1].body);
      token = new URL(payload.url).hash.slice(1);
    }
    return cancel;
  }

  beforeEach(() => {
    push.mockReset().mockResolvedValue({ ok: true, json: async () => ({ code: 200 }) });
    service = new SshRemoteApprovalService(0, origin);
    prompt = {
      title: "SSH",
      message: "Test key use",
      authorizeLabel: "Approve",
      denyLabel: "Deny",
      expiresAt: Date.now() + 59_000,
      hostFingerprint: "SHA256:host",
    };
    finish = jest.fn();
    current = true;
    token = "";
  });

  afterEach(async () => {
    await service.close();
  });

  async function setup() {
    const cancel = await notify();
    port = (service as any).server.address().port;
    return cancel;
  }

  it("shows metadata without approving on GET, then consumes a POST exactly once", async () => {
    await setup();
    const view = await call("GET");
    expect(view.status).toBe(200);
    expect(JSON.parse(view.body)).toMatchObject({
      message: "Test key use",
      hostFingerprint: "SHA256:host",
    });
    expect(view.body).not.toContain("test-device-key");
    expect(view.headers["cache-control"]).toBe("no-store");
    expect(finish).not.toHaveBeenCalled();
    expect((await call("POST", token, { approved: true })).status).toBe(200);
    expect(finish).toHaveBeenCalledWith(true);
    expect((await call("POST", token, { approved: true })).status).toBe(410);
    expect((await call("GET")).status).toBe(410);
    expect(finish).toHaveBeenCalledTimes(1);
  });

  it("rejects guessed tokens, foreign origins, and rebound Host headers", async () => {
    await setup();
    expect((await call("GET", "0".repeat(64))).status).toBe(410);
    expect((await call("POST", token, { approved: true }, "http://attacker.test")).status).toBe(
      403,
    );
    expect((await call("POST", token, { approved: true }, origin, "attacker.test")).status).toBe(
      403,
    );
    expect(finish).not.toHaveBeenCalled();
  });

  it("expires the link by server time for both viewing and approval", async () => {
    await setup();
    prompt.expiresAt = Date.now() - 1;
    expect((await call("GET")).status).toBe(410);
    expect((await call("POST", token, { approved: true })).status).toBe(410);
    expect(finish).not.toHaveBeenCalled();
  });

  it("revokes the link on desktop completion, lock, or sleep", async () => {
    const cancel = await setup();
    cancel();
    expect((await call("GET")).status).toBe(410);
    await notify();
    current = false;
    expect((await call("POST", token, { approved: true })).status).toBe(410);
    expect(finish).not.toHaveBeenCalled();
  });

  it("requires a boolean decision and supports explicit denial", async () => {
    await setup();
    expect((await call("POST", token, { approved: "true" })).status).toBe(400);
    expect((await call("POST", token, { approved: false })).status).toBe(200);
    expect(finish).toHaveBeenCalledWith(false);
  });

  it("removes remote approval on push failure without resolving the desktop request", async () => {
    push.mockResolvedValue({ ok: false });
    await expect(notify()).rejects.toThrow("Bark notification could not be delivered");
    port = (service as any).server.address().port;
    expect((await call("GET", "0".repeat(64))).status).toBe(410);
    expect(finish).not.toHaveBeenCalled();
  });

  it("does not send an expired or cancelled request and keeps request details out of the push", async () => {
    current = false;
    await notify();
    expect(push).not.toHaveBeenCalled();
  });
});

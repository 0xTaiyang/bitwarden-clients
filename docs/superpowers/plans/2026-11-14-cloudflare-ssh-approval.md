# Cloudflare SSH Approval Implementation Plan

> **For agentic workers:** Follow this plan task by task. Do not deploy or publish until the owner has reviewed the finished implementation and explicitly requests deployment.

**Goal:** Serve the SSH approval page from Cloudflare Pages and keep pending requests and decisions in Cloudflare, so the Mac runs no public web server.

**Architecture:** Cloudflare Pages serves the static page and Pages Functions provide the API. A Durable Object stores one pending request and its single-use decision with strong consistency and expiry. The desktop app creates a request and polls for its answer using outbound HTTPS; the Bark link opens the Pages URL with a random approval token in the URL fragment.

**Tech Stack:** Cloudflare Pages, Pages Functions, Durable Objects, Wrangler configuration, TypeScript, the existing Electron desktop app.

**Spec:** Scope and design captured in this plan; there is no separate approved design document yet.

## Global Constraints

- Do not run a public web server or tunnel on the Mac; the desktop app makes outbound HTTPS requests only.
- Do not put private SSH keys, device keys, or other credentials in Cloudflare request data or responses.
- Approval tokens are random, single use, expire with the request, and are never logged.
- Only approved display metadata is returned to the page.
- Approval and denial must be idempotent from the user's perspective; expired, cancelled, or already answered requests cannot be reused.
- Deploying or publishing is out of scope until the owner explicitly requests it.

## Review Focus

- A request expires or the desktop app cancels it while the page is open: the API rejects further reads/answers.
- Two answers arrive close together: at most one consumes the request and the desktop app receives one decision.
- The approval token is missing, malformed, guessed, or replayed: no request data or decision is exposed.
- The Cloudflare API is unreachable: the SSH flow fails closed and does not approve by default.
- Request data is logged or cached: sensitive approval metadata and bearer tokens stay out of logs and caches.

## Files and Responsibilities

- Create `apps/desktop/cloudflare/pages/` for the Pages static page and Functions API.
- Create `apps/desktop/cloudflare/wrangler.toml` (or the repo's chosen Wrangler JSON format) for Pages and Durable Object bindings/migrations.
- Modify `apps/desktop/src/autofill/main/ssh-remote-approval.service.ts` to create and poll remote requests instead of listening on `127.0.0.1`.
- Modify `apps/desktop/src/autofill/main/ssh-remote-approval-page.ts` and/or the existing approval HTML to move the hosted UI to Pages while preserving the approved green check state.
- Modify desktop settings/configuration and translations only if needed to provide the Pages URL and the Mac-to-Cloudflare authentication credential.
- Update `apps/desktop/webpack.base.js` and packaging configuration only if needed to remove the old page asset or local listener from the shipped build.

## Tasks

### Task 1: Add Cloudflare Pages project and request API

**Files:**

- Create `apps/desktop/cloudflare/pages/index.html` (or the project's static asset directory equivalent).
- Create `apps/desktop/cloudflare/pages/functions/api/ssh-approval.ts`.
- Create the Durable Object class and its storage/expiry logic under `apps/desktop/cloudflare/pages/`.
- Create `apps/desktop/cloudflare/wrangler.toml`.

**Interfaces:**

- `POST /api/ssh-approval` from the desktop app creates a request and returns an opaque `requestId`, random `approvalToken`, and expiry.
- `GET /api/ssh-approval/:requestId` with the approval token returns only title, message, warning, host fingerprint, and expiry.
- `POST /api/ssh-approval/:requestId` with the approval token and `{ "approved": boolean }` records one answer.
- `GET /api/ssh-approval/:requestId/result` with desktop authentication returns `pending`, `approved`, `denied`, or `expired`.
- The Bark link opens `/approve/:requestId#<approvalToken>`; the page sends the token in an Authorization header, never in the API URL.

- [ ] Implement the Durable Object as the source of truth for one request lifecycle: create, read, answer once, poll result, expire, cancel.
- [ ] Bind the Pages Functions to the Durable Object and add a migration for the class.
- [ ] Require separate desktop authentication for creating requests and polling results; do not use the user-facing approval token as desktop authentication.
- [ ] Use a cryptographically random, high-entropy approval token; store only a hash of it where practical. Keep it in the URL fragment so it is not sent in HTTP requests or referrers.
- [ ] Set `Cache-Control: no-store`, a restrictive Content Security Policy, and security headers on page and API responses.
- [ ] Validate request shape, body size, expiry, request ownership, and single-use answer semantics.

### Task 2: Host the approval UI on Pages

**Files:**

- Create or modify the Pages static HTML and browser script in `apps/desktop/cloudflare/pages/`.
- Use `apps/desktop/src/autofill/main/ssh-remote-approval-page.ts` as the behavior reference.

**Interfaces:**

- The page reads the token from the URL fragment, removes it from the visible address, and calls the same-origin Pages API.
- On approve, the page shows a large green check and “Request approved.” On deny, it shows a clear denial result.

- [ ] Port the current approval details, warning, countdown, approve/deny controls, and retry/expiry states to the Pages UI.
- [ ] Keep the API responses and DOM rendering text-only for request-supplied values.
- [ ] On successful approval, replace the controls with the existing green-check success treatment.
- [ ] Ensure the page never displays a success state until the API confirms the answer was stored.

### Task 3: Connect the desktop app to Cloudflare

**Files:**

- Modify `apps/desktop/src/autofill/main/ssh-remote-approval.service.ts`.
- Modify related service specs and settings/configuration files if needed.
- Retire the local HTTP listener and `127.0.0.1` approval URL when the remote flow is ready.

**Interfaces:**

- `notify(...)` sends the request metadata to `POST /api/ssh-approval`, pushes the returned Pages URL plus approval token to Bark, then polls the result endpoint until answered, cancelled, expired, or unreachable.
- The existing `finish(approved)` callback receives `true` only for an explicit approved result; every other terminal/error path fails closed.

- [ ] Store the Cloudflare API base URL and desktop authentication secret using the app's established settings and secure storage patterns.
- [ ] Send only the required display metadata and request expiry to Cloudflare.
- [ ] Poll at a bounded interval with a request timeout; stop polling immediately on cancellation, completion, or expiry.
- [ ] Handle Cloudflare/Bark network errors without converting them into approval.
- [ ] Update the Bark link to the Pages hostname and preserve the token in the URL fragment.
- [ ] Remove dead local-server code and user-facing copy that implies the phone must reach the Mac over Surge Ponte.

### Task 4: Verify behavior and document operations

**Files:**

- Update focused specs for the desktop service and page/API behavior.
- Add a short setup note beside the Cloudflare project describing required bindings, secret names, and deployment commands.

- [ ] Verify create → read → approve → desktop receives approval.
- [ ] Verify deny, expiry, cancellation, duplicate answers, malformed tokens, and unavailable Cloudflare all fail safely.
- [ ] Verify logs and browser URLs do not contain approval tokens or desktop credentials.
- [ ] Build the Pages project locally and the desktop app using the repository's existing build targets.
- [ ] Provide the exact manual Cloudflare setup/deploy steps to the owner; do not deploy as part of implementation.

## Self-review

- The plan covers the page, API, storage, desktop integration, and operational setup.
- Durable Objects are selected over KV because the desktop app needs to observe a just-written approval immediately; eventual consistency would make the approval wait unreliable.
- This plan assumes the existing Bark notification remains the delivery mechanism and that a Cloudflare Pages hostname is available.
- Before implementation, confirm the desktop authentication setup: the Mac needs a securely stored credential to create and poll requests. It must not be shipped as a shared secret in the app bundle.

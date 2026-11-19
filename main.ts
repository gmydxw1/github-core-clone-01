// github-core-clone-01: process entrypoint.
//
// The harness (the "env") starts next to this process and tells it where it
// lives through MAKEFUN_ENV_URL. This file's job is only the handshake:
//   1. boot the forge on a kernel-chosen port,
//   2. tell the env that port,
//   3. sit still until the env reports the run is over,
//   4. shut down cleanly.
// Everything the forge itself does lives in app.ts.

import { createApp } from "./app.ts";
import type { AddressInfo } from "node:net";

// How long a single register/done HTTP call may hang before we give up on it.
const CALL_TIMEOUT_MS = 5_000;
// First pause between retries; doubles after every failed attempt.
const FIRST_RETRY_MS = 100;
// Longest pause between retries, so a long outage stays responsive.
const MAX_RETRY_MS = 2_000;

const envBase = (process.env.MAKEFUN_ENV_URL ?? "").replace(/\/+$/, "");

// A single bad request, a dropped socket or a bug in one handler must never
// take the whole forge down with it: log it and keep serving. Exiting here
// would fail the entire trial (Works=0), while one failed check costs one check.
process.on("uncaughtException", (err: unknown) => {
  process.stderr.write(
    `[main] uncaught exception (continuing): ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
  );
});
process.on("unhandledRejection", (reason: unknown) => {
  process.stderr.write(
    `[main] unhandled rejection (continuing): ${reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)}\n`,
  );
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function fatal(message: string): never {
  process.stderr.write(`[main] ${message}\n`);
  process.exit(1);
}

// Run fn, retrying on any failure, with exponential backoff. fn returns true
// when the caller should stop retrying and treat the step as done, false to
// keep trying. A thrown error means the failure was fatal, not retryable.
async function retryUntil(
  step: string,
  fn: () => Promise<boolean>,
): Promise<void> {
  let delay = FIRST_RETRY_MS;
  for (;;) {
    try {
      if (await fn()) return;
    } catch (err) {
      if (err instanceof Error && err.message.startsWith("fatal:")) throw err;
      process.stderr.write(
        `[main] ${step} failed (${err instanceof Error ? err.message : err}); retrying in ${delay}ms\n`,
      );
    }
    await sleep(delay);
    delay = Math.min(delay * 2, MAX_RETRY_MS);
  }
}

// Tell the env which port we bound. 200 means accepted; 409 means another
// entry registered first, so our port is not the base URL, but the run is
// still ours to wait out. 400/405 mean the request itself was wrong.
async function announce(port: number): Promise<void> {
  await retryUntil("register", async () => {
    const res = await fetch(`${envBase}/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ port }),
      signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
    });
    if (res.status === 200 || res.status === 409) return true;
    // Any other status (400/405/500/...) is retried, never fatal: the env may
    // still be booting when we first announce, and exiting on the first odd
    // answer would fail the whole trial for a transient.
    process.stderr.write(
      `[main] register answered HTTP ${res.status}; retrying\n`,
    );
    return false;
  });
}

// Ask the env, over and over, whether the suite is done. Each call returns
// immediately; we never hold a request open.
async function waitUntilDone(): Promise<void> {
  await retryUntil("done", async () => {
    const res = await fetch(`${envBase}/done`, {
      signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
    });
    if (!res.ok) return false;
    const body = (await res.json()) as { done?: unknown };
    return body.done === true;
  });
}

async function run(): Promise<void> {
  if (!envBase) {
    fatal("MAKEFUN_ENV_URL is not set, so there is no env to register with");
  }

  const server = createApp();
  // Port 0: the kernel picks an ephemeral port. Never 8080 -- that is the
  // env's own port. Bind all interfaces (no host argument): the env dials the
  // address our register request came from, which on a split trial network is
  // this container's own IP, not loopback -- a 127.0.0.1-only listener would
  // refuse it and fail boot. Binding port 0 all but never fails, but a
  // transient failure (e.g. file descriptors briefly exhausted) must not end
  // the trial: retry with backoff instead of exiting.
  await retryUntil("listen", async () => {
    return await new Promise<boolean>((resolve) => {
      server.once("error", () => resolve(false));
      server.listen(0, () => resolve(true));
    });
  });
  const bound = server.address() as AddressInfo;
  process.stdout.write(`[main] listening on ${bound.port}\n`);

  await announce(bound.port);
  process.stdout.write("[main] registered; waiting for done\n");
  await waitUntilDone();

  // Shut down: drop idle keep-alive sockets first, then close. A client that
  // still holds a connection open must not keep the process alive forever:
  // if close has not finished in 5 s, force-close everything and exit anyway.
  server.closeIdleConnections();
  await Promise.race([
    new Promise<void>((resolve) => server.close(() => resolve())),
    sleep(5_000),
  ]);
  server.closeAllConnections();
  // Exit explicitly once the line is flushed: the 5 s sleep above may still
  // be pending when close() finished early, and Node would otherwise wait out
  // the whole timer before exiting (~5 s of dead time after "done").
  process.stdout.write("[main] done; exiting 0\n", () => process.exit(0));
}

run().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  fatal(message.replace(/^fatal: /, ""));
});

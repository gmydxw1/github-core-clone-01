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
    if (res.status === 400 || res.status === 405) {
      throw new Error(
        `fatal: register answered HTTP ${res.status}: ${await res.text()}`,
      );
    }
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
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    // Port 0: the kernel picks an ephemeral port. Never 8080 -- that is the
    // env's own port on the shared loopback.
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const bound = server.address() as AddressInfo;
  process.stdout.write(`[main] listening on ${bound.port}\n`);

  await announce(bound.port);
  process.stdout.write("[main] registered; waiting for done\n");
  await waitUntilDone();

  await new Promise<void>((resolve) => server.close(() => resolve()));
  process.stdout.write("[main] done; exiting 0\n");
}

run().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  fatal(message.replace(/^fatal: /, ""));
});

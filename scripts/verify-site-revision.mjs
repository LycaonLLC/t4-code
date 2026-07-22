import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { readBoundedResponseBytes } from "./read-bounded-response.mjs";

const COMMIT_PATTERN = /^[0-9a-f]{40}$/u;
const MAX_RESPONSE_BYTES = 1024;

export const SITE_REVISION_URLS = Object.freeze({
  origin: "https://t4-site.tailb18de3.ts.net/revision.json",
  public: "https://t4code.com/revision.json",
});

export const DEFAULT_REVISION_WAIT = Object.freeze({
  timeoutMs: 15 * 60 * 1000,
  intervalMs: 10_000,
  requestTimeoutMs: 5_000,
});

function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return value;
}

export function requireSourceRevision(revision) {
  if (typeof revision !== "string" || !COMMIT_PATTERN.test(revision)) {
    throw new Error("expected revision must be an exact lowercase 40-character commit SHA");
  }
  return revision;
}

export function revisionUrl(target) {
  if (!Object.hasOwn(SITE_REVISION_URLS, target)) {
    throw new Error("target must be public or origin");
  }
  const url = new URL(SITE_REVISION_URLS[target]);
  if (url.protocol !== "https:") throw new Error(`${target} revision URL must use HTTPS`);
  if (target === "public" && url.hostname !== "t4code.com") {
    throw new Error("public revision URL must use t4code.com");
  }
  return url.href;
}

export async function fetchSiteRevision({
  target,
  requestTimeoutMs = DEFAULT_REVISION_WAIT.requestTimeoutMs,
  fetchImpl = fetch,
}) {
  positiveInteger(requestTimeoutMs, "requestTimeoutMs");
  const url = revisionUrl(target);
  const response = await fetchImpl(url, {
    cache: "no-store",
    headers: { Accept: "application/json" },
    redirect: "error",
    signal: AbortSignal.timeout(requestTimeoutMs),
  });
  if (response.status !== 200) {
    await response.body?.cancel?.();
    throw new Error(`${target} revision endpoint returned HTTP ${response.status}`);
  }
  const contentType = response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
  if (contentType !== "application/json") {
    await response.body?.cancel?.();
    throw new Error(`${target} revision endpoint did not return application/json`);
  }

  const bytes = await readBoundedResponseBytes(response, {
    maxBytes: MAX_RESPONSE_BYTES,
    label: `${target} revision response`,
  });
  let document;
  try {
    document = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error(`${target} revision endpoint returned invalid JSON`);
  }
  if (
    !document ||
    typeof document !== "object" ||
    Array.isArray(document) ||
    Object.keys(document).length !== 1 ||
    !COMMIT_PATTERN.test(document.revision)
  ) {
    throw new Error(`${target} revision endpoint returned an invalid revision document`);
  }
  return document.revision;
}

export async function waitForSiteRevision({
  expectedRevision,
  target = "public",
  timeoutMs = DEFAULT_REVISION_WAIT.timeoutMs,
  intervalMs = DEFAULT_REVISION_WAIT.intervalMs,
  requestTimeoutMs = DEFAULT_REVISION_WAIT.requestTimeoutMs,
  fetchImpl = fetch,
  now = Date.now,
  sleep = (milliseconds) => new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds)),
  logger = console,
}) {
  const expected = requireSourceRevision(expectedRevision);
  revisionUrl(target);
  positiveInteger(timeoutMs, "timeoutMs");
  positiveInteger(intervalMs, "intervalMs");
  positiveInteger(requestTimeoutMs, "requestTimeoutMs");

  const startedAt = now();
  let attempts = 0;
  let lastObservation = "not checked";
  while (true) {
    attempts += 1;
    try {
      const actual = await fetchSiteRevision({ target, requestTimeoutMs, fetchImpl });
      lastObservation = `revision ${actual}`;
      if (actual === expected) {
        const elapsedMs = now() - startedAt;
        logger.log(`${target} revision ${expected} verified after ${attempts} check${attempts === 1 ? "" : "s"}.`);
        return { target, url: revisionUrl(target), revision: actual, attempts, elapsedMs };
      }
    } catch (error) {
      lastObservation = error instanceof Error ? error.message : String(error);
    }

    const elapsedMs = now() - startedAt;
    if (elapsedMs >= timeoutMs) {
      throw new Error(
        `Timed out after ${elapsedMs} ms waiting for ${target} revision ${expected}; last observation: ${lastObservation}`,
      );
    }
    const delayMs = Math.min(intervalMs, timeoutMs - elapsedMs);
    logger.log(
      `${target} has not published revision ${expected} (${lastObservation}); checking again in ${delayMs} ms.`,
    );
    await sleep(delayMs);
  }
}

function parseArguments(argv) {
  const options = { target: "public", ...DEFAULT_REVISION_WAIT };
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!value) throw new Error(`${name ?? "argument"} requires a value`);
    if (name === "--expected") options.expectedRevision = value;
    else if (name === "--target") options.target = value;
    else if (name === "--timeout-ms") options.timeoutMs = Number(value);
    else if (name === "--interval-ms") options.intervalMs = Number(value);
    else if (name === "--request-timeout-ms") options.requestTimeoutMs = Number(value);
    else throw new Error(`unknown argument: ${name}`);
  }
  if (!options.expectedRevision) throw new Error("--expected is required");
  return options;
}

const isMain =
  process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) {
  try {
    await waitForSiteRevision(parseArguments(process.argv.slice(2)));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

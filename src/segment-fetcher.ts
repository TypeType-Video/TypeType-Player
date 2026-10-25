import type { HttpClient, HttpExchange } from "./http-client";
import {
  isPlaybackSessionExpiryStatus,
  playbackSegmentTimeoutError,
  playbackSessionExpiredError,
  SegmentGenerationConflictError,
} from "./playback-window-error";
import { parseRetryAfterMs } from "./retry-backoff";
import { type RetryTiming, SYSTEM_RETRY_TIMING } from "./retry-timing";
import { isTransientSegmentStatus, SegmentRetryPolicy } from "./segment-retry-policy";

const MIN_POLL_DELAY_MS = 250;
const DEFAULT_POLL_DELAY_MS = 500;

export async function fetchSegmentBytes(
  http: Pick<HttpClient, "once">,
  url: string,
  pollLimit: number,
  signal?: AbortSignal,
  timing: RetryTiming = SYSTEM_RETRY_TIMING,
): Promise<ArrayBuffer> {
  const retries = new SegmentRetryPolicy(timing);
  let polls = 0;
  while (true) {
    if (signal?.aborted) throw new DOMException("Operation aborted", "AbortError");
    let exchange: HttpExchange;
    try {
      exchange = await http.once(url, signal ? { signal } : undefined);
    } catch (error) {
      if (isAbortError(error)) throw error;
      await retries.retry(null, signal);
      continue;
    }
    if (exchange.status === 200) return exchange.body;
    if (isPlaybackSessionExpiryStatus(exchange.status)) throw playbackSessionExpiredError();
    if (exchange.status === 409) throw new SegmentGenerationConflictError();
    if (isTransientSegmentStatus(exchange.status)) {
      await retries.retry(retryAfterHeaderMs(exchange, timing), signal);
      continue;
    }
    if (exchange.status !== 202) throw new Error(`Segment failed with ${exchange.status}`);
    polls += 1;
    if (polls >= pollLimit) throw playbackSegmentTimeoutError();
    await timing.sleep(pollDelayMs(exchange, timing), signal);
  }
}

function retryAfterHeaderMs(exchange: HttpExchange, timing: RetryTiming): number | null {
  return parseRetryAfterMs(exchange.headers.get("retry-after"), timing.now());
}

function pollDelayMs(exchange: HttpExchange, timing: RetryTiming): number {
  const headerMs = retryAfterHeaderMs(exchange, timing);
  const requestedMs = headerMs !== null && headerMs > 0 ? headerMs : bodyRetryAfterMs(exchange);
  return Math.max(MIN_POLL_DELAY_MS, requestedMs ?? DEFAULT_POLL_DELAY_MS);
}

function bodyRetryAfterMs(exchange: HttpExchange): number | null {
  const body = parseJson(exchange.body);
  if (!body || typeof body !== "object") return null;
  const retryAfter = Reflect.get(body, "retryAfterMs");
  return typeof retryAfter === "number" && Number.isFinite(retryAfter) ? retryAfter : null;
}

function parseJson(body: ArrayBuffer): unknown {
  try {
    return JSON.parse(new TextDecoder().decode(body));
  } catch {
    return null;
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

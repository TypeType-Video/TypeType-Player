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

/** A segment whose response stopped after part of it was already handed on: the receiver must start it over. */
export class PartialSegmentError extends Error {
  constructor(cause: unknown) {
    super("Segment stopped part way", { cause });
    this.name = "PartialSegmentError";
  }
}

/**
 * Downloads a segment, waiting through 202 and transient answers. With onChunk, its bytes go to onChunk as they
 * arrive; a response that stops after some of them is not retried here but ends in PartialSegmentError.
 */
export async function fetchSegmentBytes(
  http: Pick<HttpClient, "once">,
  url: string,
  pollLimit: number,
  signal?: AbortSignal,
  timing: RetryTiming = SYSTEM_RETRY_TIMING,
  onChunk?: (chunk: ArrayBuffer) => Promise<void>,
): Promise<ArrayBuffer> {
  const retries = new SegmentRetryPolicy(timing);
  let polls = 0;
  let handedOn = false;
  const forward = onChunk
    ? async (chunk: ArrayBuffer) => {
        handedOn = true;
        await onChunk(chunk);
      }
    : undefined;
  while (true) {
    if (signal?.aborted) throw new DOMException("Operation aborted", "AbortError");
    let exchange: HttpExchange;
    try {
      exchange = await http.once(url, signal ? { signal } : undefined, forward);
    } catch (error) {
      if (isAbortError(error)) throw error;
      if (handedOn) throw new PartialSegmentError(error);
      await retries.retry(null, signal);
      continue;
    }
    if (exchange.status === 200) {
      if (forward && exchange.body.byteLength > 0) {
        try {
          await forward(exchange.body);
        } catch (error) {
          if (isAbortError(error)) throw error;
          throw new PartialSegmentError(error);
        }
      }
      return exchange.body;
    }
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

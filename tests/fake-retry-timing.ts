import type { RetryTiming } from "../src/retry-timing";

export type FakeRetryTiming = RetryTiming & { delays: number[] };

export function fakeRetryTiming(startMs = 1_000_000, random = 0): FakeRetryTiming {
  let nowMs = startMs;
  const delays: number[] = [];
  return {
    delays,
    now: () => nowMs,
    random: () => random,
    sleep: async (delayMs, signal) => {
      if (signal?.aborted) throw new DOMException("Operation aborted", "AbortError");
      delays.push(delayMs);
      nowMs += delayMs;
    },
  };
}

export async function skipRecoveryDelay(): Promise<void> {}

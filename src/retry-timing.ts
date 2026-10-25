export type RetryTiming = {
  now: () => number;
  random: () => number;
  sleep: (delayMs: number, signal?: AbortSignal | null) => Promise<void>;
};

export const SYSTEM_RETRY_TIMING: RetryTiming = {
  now: () => Date.now(),
  random: () => Math.random(),
  sleep: abortableSleep,
};

export function abortableSleep(delayMs: number, signal?: AbortSignal | null): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortReason(signal));
      return;
    }
    const timer = setTimeout(finish, Math.max(0, delayMs));
    signal?.addEventListener("abort", abort, { once: true });
    function finish(): void {
      signal?.removeEventListener("abort", abort);
      resolve();
    }
    function abort(): void {
      clearTimeout(timer);
      reject(abortReason(signal));
    }
  });
}

function abortReason(signal: AbortSignal | null | undefined): unknown {
  const reason: unknown = signal?.reason;
  return reason instanceof DOMException && reason.name === "AbortError"
    ? reason
    : new DOMException("Operation aborted", "AbortError");
}

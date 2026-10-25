import { PlaybackWindowRecoveryError } from "./playback-window-error";
import { DEFAULT_RETRY_BUDGET_MS, RetryBudget } from "./retry-backoff";
import type { RetryTiming } from "./retry-timing";

export class SegmentRetryPolicy {
  private readonly budget: RetryBudget;
  private lastRetryAfterMs: number | null = null;

  constructor(timing: RetryTiming, budgetMs = DEFAULT_RETRY_BUDGET_MS) {
    this.budget = new RetryBudget(timing, budgetMs);
  }

  async retry(retryAfterMs: number | null, signal?: AbortSignal): Promise<void> {
    if (retryAfterMs !== null) this.lastRetryAfterMs = retryAfterMs;
    if (await this.budget.wait(retryAfterMs, signal)) return;
    throw new PlaybackWindowRecoveryError(
      "SABR segment kept failing",
      "retry_fresh_session",
      [],
      this.lastRetryAfterMs,
    );
  }
}

export function isTransientSegmentStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status <= 599);
}

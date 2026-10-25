import type { RetryTiming } from "./retry-timing";

const MIN_RETRY_DELAY_MS = 250;
const MAX_RETRY_DELAY_MS = 60_000;
const BACKOFF_BASE_MS = 500;
const MAX_BACKOFF_MS = 8_000;
const JITTER_RATIO = 0.2;
export const DEFAULT_RETRY_BUDGET_MS = 60_000;

export function retryDelayMs(attempt: number, retryAfterMs: number | null, random: number): number {
  const backoffMs = Math.min(MAX_BACKOFF_MS, BACKOFF_BASE_MS * 2 ** Math.max(0, attempt));
  const baseMs = Math.max(backoffMs, retryAfterMs ?? 0);
  const jitteredMs = baseMs + baseMs * JITTER_RATIO * random;
  return Math.round(Math.min(MAX_RETRY_DELAY_MS, Math.max(MIN_RETRY_DELAY_MS, jitteredMs)));
}

export function parseRetryAfterMs(value: string | null, nowMs: number): number | null {
  const trimmed = value?.trim() ?? "";
  if (trimmed.length === 0) return null;
  if (/^\d+(\.\d+)?$/.test(trimmed)) return Math.round(Number(trimmed) * 1000);
  if (!/[a-z]/i.test(trimmed)) return null;
  const dateMs = Date.parse(trimmed);
  return Number.isFinite(dateMs) ? Math.max(0, Math.round(dateMs - nowMs)) : null;
}

export class RetryBudget {
  private readonly deadlineMs: number;
  private attempt = 0;

  constructor(
    private readonly timing: RetryTiming,
    budgetMs = DEFAULT_RETRY_BUDGET_MS,
  ) {
    this.deadlineMs = timing.now() + budgetMs;
  }

  async wait(retryAfterMs: number | null, signal?: AbortSignal | null): Promise<boolean> {
    const delayMs = retryDelayMs(this.attempt, retryAfterMs, this.timing.random());
    if (this.timing.now() + delayMs > this.deadlineMs) return false;
    this.attempt += 1;
    await this.timing.sleep(delayMs, signal);
    return true;
  }
}

/** Retry budgets for manifest and media transport requests. */
export type PlaybackRetryPolicy = {
  manifestAttempts: number;
  mediaAttempts: number;
  retryIntervalMs: number;
};

/** Transport-independent buffering, live-edge, and retry policy. */
export type PlaybackPolicy = PlaybackRetryPolicy & {
  startupBufferMs: number;
  steadyBufferMs: number;
  maxBufferMs: number;
  backBufferMs: number;
  manifestRefreshMs: number;
  liveTargetLatencyMs: number;
  liveMaxLatencyMs: number;
  liveCatchupMinRate: number;
  liveCatchupMaxRate: number;
};

/** Optional overrides applied to the default TypeType playback policy. */
export type PlaybackPolicyInput = Partial<PlaybackPolicy>;

const DEFAULT_POLICY: PlaybackPolicy = {
  startupBufferMs: 2_000,
  steadyBufferMs: 24_000,
  maxBufferMs: 50_000,
  backBufferMs: 30_000,
  manifestRefreshMs: 1_000,
  manifestAttempts: 5,
  mediaAttempts: 3,
  retryIntervalMs: 500,
  liveTargetLatencyMs: 5_000,
  liveMaxLatencyMs: 15_000,
  liveCatchupMinRate: 1,
  liveCatchupMaxRate: 1.25,
};

/** Resolve a transport policy with bounded, internally consistent values. */
export function resolvePlaybackPolicy(input: PlaybackPolicyInput = {}): PlaybackPolicy {
  const policy = {
    startupBufferMs: positiveMs(input.startupBufferMs, DEFAULT_POLICY.startupBufferMs),
    steadyBufferMs: positiveMs(input.steadyBufferMs, DEFAULT_POLICY.steadyBufferMs),
    maxBufferMs: positiveMs(input.maxBufferMs, DEFAULT_POLICY.maxBufferMs),
    backBufferMs: positiveMs(input.backBufferMs, DEFAULT_POLICY.backBufferMs),
    manifestRefreshMs: positiveMs(input.manifestRefreshMs, DEFAULT_POLICY.manifestRefreshMs),
    manifestAttempts: positiveInteger(input.manifestAttempts, DEFAULT_POLICY.manifestAttempts),
    mediaAttempts: positiveInteger(input.mediaAttempts, DEFAULT_POLICY.mediaAttempts),
    retryIntervalMs: positiveMs(input.retryIntervalMs, DEFAULT_POLICY.retryIntervalMs),
    liveTargetLatencyMs: positiveMs(input.liveTargetLatencyMs, DEFAULT_POLICY.liveTargetLatencyMs),
    liveMaxLatencyMs: positiveMs(input.liveMaxLatencyMs, DEFAULT_POLICY.liveMaxLatencyMs),
    liveCatchupMinRate: playbackRate(input.liveCatchupMinRate, DEFAULT_POLICY.liveCatchupMinRate),
    liveCatchupMaxRate: playbackRate(input.liveCatchupMaxRate, DEFAULT_POLICY.liveCatchupMaxRate),
  };

  policy.steadyBufferMs = Math.min(policy.steadyBufferMs, policy.maxBufferMs);
  policy.liveTargetLatencyMs = Math.min(policy.liveTargetLatencyMs, policy.liveMaxLatencyMs);
  policy.liveCatchupMaxRate = Math.max(policy.liveCatchupMaxRate, policy.liveCatchupMinRate);
  return policy;
}

/** Convert a policy duration from milliseconds to seconds. */
export function bufferSeconds(valueMs: number): number {
  return valueMs / 1_000;
}

function positiveMs(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.round(value)
    : fallback;
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : fallback;
}

function playbackRate(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 1 ? value : fallback;
}

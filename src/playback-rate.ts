const MIN_PLAYBACK_RATE = 0.25;
const MAX_PLAYBACK_RATE = 4;
const MAX_RATE_AWARE_BUFFER_GOAL_MS = 60_000;

type PlaybackRateSource = {
  playbackRate: number;
};

export class StablePlaybackRate {
  private stableRate: number;

  constructor(private readonly source: PlaybackRateSource) {
    this.stableRate = supportedPlaybackRate(source.playbackRate) ?? 1;
  }

  current(): number {
    const rate = supportedPlaybackRate(this.source.playbackRate);
    if (rate !== null) this.stableRate = rate;
    return this.stableRate;
  }
}

export function rateAwareBufferGoalMs(bufferGoalMs: number, playbackRate: number): number {
  const rate = supportedPlaybackRate(playbackRate) ?? 1;
  const scaledGoalMs = Math.round(bufferGoalMs * Math.max(1, rate));
  return Math.min(scaledGoalMs, Math.max(bufferGoalMs, MAX_RATE_AWARE_BUFFER_GOAL_MS));
}

export function refreshThresholdMs(bufferGoalMs: number): number {
  return Math.min(bufferGoalMs, Math.max(5_000, Math.round((bufferGoalMs * 2) / 3)));
}

function supportedPlaybackRate(rate: number): number | null {
  return Number.isFinite(rate) && rate >= MIN_PLAYBACK_RATE && rate <= MAX_PLAYBACK_RATE
    ? rate
    : null;
}

const HAVE_FUTURE_DATA = 3;
const EDGE_TOLERANCE_SECONDS = 0.05;
const MAX_JUMPED_GAP_SECONDS = 1;
const GAP_ENTRY_OFFSET_SECONDS = 0.01;
const STUCK_PLAYBACK_MS = 3_000;
const NUDGE_SECONDS = 0.1;
const MIN_NUDGE_BUFFER_SECONDS = 0.5;
const CHECK_INTERVAL_MS = 500;

type StallMedia = Pick<
  HTMLVideoElement,
  | "addEventListener"
  | "buffered"
  | "currentTime"
  | "ended"
  | "paused"
  | "readyState"
  | "removeEventListener"
  | "seeking"
>;

export type PlaybackStallWatchdogArgs = {
  video: StallMedia;
  busy: () => boolean;
  now?: () => number;
  every?: (callback: () => void, delayMs: number) => () => void;
};

export class PlaybackStallWatchdog {
  private lastPositionSeconds = Number.NaN;
  private positionSinceMs = 0;
  private stopTimer: (() => void) | null = null;
  private readonly now: () => number;
  private readonly every: (callback: () => void, delayMs: number) => () => void;

  constructor(private readonly args: PlaybackStallWatchdogArgs) {
    this.now = args.now ?? (() => performance.now());
    this.every = args.every ?? repeatEvery;
  }

  start(): void {
    this.stop();
    this.args.video.addEventListener("waiting", this.waiting);
    this.stopTimer = this.every(this.check, CHECK_INTERVAL_MS);
  }

  stop(): void {
    this.args.video.removeEventListener("waiting", this.waiting);
    this.stopTimer?.();
    this.stopTimer = null;
  }

  private readonly waiting = (): void => {
    if (this.args.video.readyState < HAVE_FUTURE_DATA && this.canAct()) this.jumpSmallGap();
  };

  private readonly check = (): void => {
    const video = this.args.video;
    const nowMs = this.now();
    if (!this.canAct() || video.currentTime !== this.lastPositionSeconds) {
      this.lastPositionSeconds = video.currentTime;
      this.positionSinceMs = nowMs;
      return;
    }
    if (nowMs - this.positionSinceMs < STUCK_PLAYBACK_MS) return;
    this.positionSinceMs = nowMs;
    if (this.jumpSmallGap()) return;
    if (bufferedAheadSeconds(video) >= MIN_NUDGE_BUFFER_SECONDS) {
      video.currentTime += NUDGE_SECONDS;
    }
  };

  private canAct(): boolean {
    const video = this.args.video;
    return !video.paused && !video.seeking && !video.ended && !this.args.busy();
  }

  private jumpSmallGap(): boolean {
    const video = this.args.video;
    const current = video.currentTime;
    for (let index = 0; index < video.buffered.length; index += 1) {
      const start = video.buffered.start(index);
      const end = video.buffered.end(index);
      if (current >= start - EDGE_TOLERANCE_SECONDS && current < end - EDGE_TOLERANCE_SECONDS) {
        return false;
      }
      const gap = start - current;
      if (gap <= 0) continue;
      if (gap > MAX_JUMPED_GAP_SECONDS) return false;
      video.currentTime = Math.min(start + GAP_ENTRY_OFFSET_SECONDS, end);
      return true;
    }
    return false;
  }
}

function bufferedAheadSeconds(video: Pick<HTMLVideoElement, "buffered" | "currentTime">): number {
  const current = video.currentTime;
  for (let index = 0; index < video.buffered.length; index += 1) {
    const start = video.buffered.start(index);
    const end = video.buffered.end(index);
    if (current >= start - EDGE_TOLERANCE_SECONDS && current < end) return end - current;
  }
  return 0;
}

function repeatEvery(callback: () => void, delayMs: number): () => void {
  const timer = setInterval(callback, delayMs);
  return () => clearInterval(timer);
}

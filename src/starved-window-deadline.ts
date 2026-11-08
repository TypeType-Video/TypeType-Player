import type { MediaBufferedRange } from "./media-source-controller";

const STARVED_AHEAD_MS = 1_500;
const STARVED_WINDOW_LIMIT_MS = 6_000;

export type StarvedWindowDeadlineArgs = {
  bufferedRanges: () => MediaBufferedRange[];
  playerTimeMs: () => number;
  audioOnly: boolean;
  now?: () => number;
};

export class StarvedWindowDeadline {
  private starvedSinceMs: number | null = null;
  private lastEdgeMs: number | null = null;
  private readonly now: () => number;

  constructor(private readonly args: StarvedWindowDeadlineArgs) {
    this.now = args.now ?? (() => performance.now());
  }

  expired(bufferedEdgeMs: number | null): boolean {
    const nowMs = this.now();
    const edgeMoved = bufferedEdgeMs !== this.lastEdgeMs;
    this.lastEdgeMs = bufferedEdgeMs;
    if (edgeMoved || !this.starved()) {
      this.starvedSinceMs = null;
      return false;
    }
    this.starvedSinceMs ??= nowMs;
    return nowMs - this.starvedSinceMs >= STARVED_WINDOW_LIMIT_MS;
  }

  private starved(): boolean {
    const playerMs = this.args.playerTimeMs();
    const ranges = this.args.bufferedRanges();
    const kinds = this.args.audioOnly ? (["audio"] as const) : (["audio", "video"] as const);
    return kinds.some((kind) => aheadMs(ranges, kind, playerMs) < STARVED_AHEAD_MS);
  }
}

function aheadMs(
  ranges: MediaBufferedRange[],
  kind: MediaBufferedRange["kind"],
  playerMs: number,
): number {
  const range = ranges.find(
    (candidate) =>
      candidate.kind === kind && candidate.startMs <= playerMs && playerMs < candidate.endMs,
  );
  return range ? range.endMs - playerMs : 0;
}

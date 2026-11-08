import type { PlaybackManifest } from "../manifest";
import type { TransientMediaState } from "../transient-media-state";
import type { PlayerSeekMode } from "../types";

/** Context passed to align media position before session playback begins. */
export type SeekAlignmentContext = {
  /** The HTML video element being positioned. */
  video: HTMLVideoElement;
  /** The target playback timestamp in milliseconds. */
  resolvedStartTimeMs: number;
  /** Current playback manifest providing segment and keyframe timelines. */
  manifest: PlaybackManifest;
  /** Whether a paused seek is being finalized. */
  finalizePausedSeek: boolean;
  /** Whether playback intent indicates playback should resume. */
  shouldResume: boolean;
  /** Transient media state controlling opacity masking and audio muting. */
  transientMediaState: TransientMediaState;
};

/** Context passed to execute session seek positioning and preroll catchup. */
export type SeekExecutionContext = {
  /** The HTML video element being positioned. */
  video: HTMLVideoElement;
  /** The target playback timestamp in milliseconds. */
  resolvedStartTimeMs: number;
  /** Current playback manifest providing segment and keyframe timelines. */
  manifest: PlaybackManifest;
  /** Abort signal cancelling active seek operations. */
  signal: AbortSignal;
  /** Whether a paused seek is being finalized. */
  finalizePausedSeek: boolean;
  /** Whether playback intent indicates playback should resume. */
  shouldResume: boolean;
  /** Whether this session transition is a handoff from an existing session. */
  handoff?: boolean;
  /** Transient media state controlling opacity masking and audio muting. */
  transientMediaState: TransientMediaState;
  /** Callback to trigger an immediate buffer refill when needed. */
  fillBuffer: () => Promise<void>;
};

/** Modular strategy governing how MSE session seeks align the media element and handle GOP decode catchup. */
export interface SeekStrategy {
  /** The seek mode identifier implemented by this strategy. */
  readonly mode: PlayerSeekMode;

  /** Positions the media element playhead prior to attaching buffered media. */
  alignSessionPosition(ctx: SeekAlignmentContext): void;

  /** Executes preroll or native positioning to land at the target playback position. */
  executeSessionSeek(ctx: SeekExecutionContext): Promise<number | null>;
}

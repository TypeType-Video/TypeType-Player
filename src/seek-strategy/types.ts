import type { PlaybackManifest } from "../manifest";
import type { TransientMediaState } from "../transient-media-state";
import type { PlayerSeekMode } from "../types";

export type SeekAlignmentContext = {
  video: HTMLVideoElement;
  resolvedStartTimeMs: number;
  manifest: PlaybackManifest;
  finalizePausedSeek: boolean;
  shouldResume: boolean;
  transientMediaState: TransientMediaState;
};

export type SeekExecutionContext = {
  video: HTMLVideoElement;
  resolvedStartTimeMs: number;
  manifest: PlaybackManifest;
  signal: AbortSignal;
  finalizePausedSeek: boolean;
  shouldResume: boolean;
  handoff?: boolean;
  transientMediaState: TransientMediaState;
  fillBuffer: () => Promise<void>;
};

export interface SeekStrategy {
  readonly mode: PlayerSeekMode;

  alignSessionPosition(ctx: SeekAlignmentContext): void;

  executeSessionSeek(ctx: SeekExecutionContext): Promise<number | null>;
}

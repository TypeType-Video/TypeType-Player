import type { BufferPolicy } from "./buffer-policy";
import type { EventEmitter } from "./event-emitter";
import type { MediaSourceController } from "./media-source-controller";
import type { PlaybackClient } from "./playback-client";
import type { SegmentScheduler } from "./segment-scheduler";
import type { LoadedSession } from "./session-loader";

export type PlaybackLoopFailureContext = {
  sessionId: string | null;
  signal: AbortSignal;
};

export type PlaybackLoopArgs = {
  video: { currentTime: number; paused: boolean; readyState: number };
  playback: Pick<PlaybackClient, "position" | "prefetch" | "segments">;
  media: Pick<MediaSourceController, "bufferedRanges" | "endOfStream" | "trim">;
  scheduler: Pick<SegmentScheduler, "fill">;
  emitter: Pick<EventEmitter, "emit">;
  policy: BufferPolicy;
  playbackRate?: () => number;
  session: () => LoadedSession | null;
  signal: () => AbortSignal;
  bufferedEndMs: () => number;
  error: (error: Error, context: PlaybackLoopFailureContext) => void;
};

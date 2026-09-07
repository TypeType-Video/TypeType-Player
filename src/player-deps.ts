import { type BufferPolicy, resolveBufferPolicy } from "./buffer-policy";
import type { EventEmitter } from "./event-emitter";
import { HttpClient } from "./http-client";
import { bufferedEndAtCurrentTrackRanges } from "./media-buffer";
import { MediaElementObserver } from "./media-element-observer";
import { MediaSourceController } from "./media-source-controller";
import { PlaybackClient } from "./playback-client";
import { PlaybackLoop, type PlaybackLoopFailureContext } from "./playback-loop";
import { StablePlaybackRate } from "./playback-rate";
import { bufferedEndMs } from "./player-snapshot";
import { SegmentScheduler } from "./segment-scheduler";
import type { LoadedSession } from "./session-loader";
import type { TypeTypeMseConfig, TypeTypeMseState } from "./types";

export type PlayerDeps = {
  http: HttpClient;
  playback: PlaybackClient;
  mediaEvents: MediaElementObserver;
  media: MediaSourceController;
  scheduler: SegmentScheduler;
  loop: PlaybackLoop;
  policy: BufferPolicy;
  playbackRate: () => number;
  destroy: () => void;
};

type Args = {
  video: HTMLVideoElement;
  config: TypeTypeMseConfig;
  emitter: EventEmitter;
  session: () => LoadedSession | null;
  signal: () => AbortSignal;
  state: (state: TypeTypeMseState) => void;
  error: (error: Error) => boolean;
  progress: (positionMs: number) => void;
  loopError: (error: Error, context: PlaybackLoopFailureContext) => void;
};

export function createPlayerDeps(args: Args): PlayerDeps {
  const http = new HttpClient(
    args.config.headers
      ? { endpoint: args.config.endpoint, headers: args.config.headers }
      : { endpoint: args.config.endpoint },
  );
  const playback = new PlaybackClient(http);
  const policy = resolveBufferPolicy(args.config);
  const stablePlaybackRate = new StablePlaybackRate(args.video);
  const playbackRate = () => stablePlaybackRate.current();
  const mediaEvents = new MediaElementObserver({
    video: args.video,
    state: args.state,
    error: args.error,
    progress: args.progress,
  });
  const media = new MediaSourceController(args.video);
  const scheduler = new SegmentScheduler(http, media, args.emitter, policy.segmentPollLimit);
  const currentBufferedEndMs = () => {
    const elementBufferedEndMs = bufferedEndMs(args.video);
    if (elementBufferedEndMs > 0) return elementBufferedEndMs;
    const session = args.session();
    if (!session) return elementBufferedEndMs;
    return bufferedEndAtCurrentTrackRanges(
      media.bufferedRanges(),
      Math.max(0, Math.round(args.video.currentTime * 1000)),
      session.manifest.video !== null,
    );
  };
  const loop = new PlaybackLoop({
    video: args.video,
    playback,
    media,
    scheduler,
    emitter: args.emitter,
    policy,
    playbackRate,
    session: args.session,
    signal: args.signal,
    bufferedEndMs: currentBufferedEndMs,
    error: args.loopError,
  });
  const destroy = () => {
    loop.stop();
    mediaEvents.stop();
    media.detach();
  };
  return { http, playback, mediaEvents, media, scheduler, loop, policy, playbackRate, destroy };
}

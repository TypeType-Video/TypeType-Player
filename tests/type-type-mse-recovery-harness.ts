import type { PlaybackManifest } from "../src/manifest";
import type { CreatePlaybackRequest, PlaybackResponse } from "../src/playback-client";
import { PlaybackIntent } from "../src/playback-intent";
import type { PlaybackLoopFailureContext } from "../src/playback-loop";
import { PlayerOperation } from "../src/player-operation";
import { PlaybackRecovery } from "../src/player-recovery";
import { type LoadedSession, PlaybackWindowRecoveryError } from "../src/session-loader";
import { TypeTypeMsePlayer } from "../src/type-type-mse-player";
import type { TypeTypeMseConfig, TypeTypeMseState } from "../src/types";

const manifest: PlaybackManifest = {
  durationMs: 600_000,
  endOfStream: false,
  audio: { kind: "audio", mime: "audio/mp4", initUrl: "/audio/init", segments: [] },
  video: { kind: "video", mime: "video/mp4", initUrl: "/video/init", segments: [] },
};

type RecoveryHarness = {
  destroyed: boolean;
  session: LoadedSession | null;
  operation: PlayerOperation;
  playbackRecovery: PlaybackRecovery;
  playbackIntent: PlaybackIntent;
  recoveryPositionMs: number;
  loadTask: Promise<void> | null;
  emitter: { emit: (event: { type: string; videoItag?: number }) => void };
  playerState: {
    value: TypeTypeMseState;
    set: (state: TypeTypeMseState) => void;
    fail: (error: Error, recoveryPositionMs: number) => void;
  };
  deps: {
    loop: { stop: () => void };
    playback: {
      create: (request: CreatePlaybackRequest, signal?: AbortSignal) => Promise<PlaybackResponse>;
    };
  };
  video: { paused: boolean; currentTime: number };
  config: TypeTypeMseConfig;
  switchSession: (...args: unknown[]) => Promise<LoadedSession>;
  handlePlaybackLoopError: (error: Error, context: PlaybackLoopFailureContext) => void;
  reportPlaybackFailure: (error: Error) => void;
  loadInitialSession: () => Promise<void>;
  load: () => Promise<void>;
  enqueueSessionTransition: <T>(work: () => Promise<T>) => Promise<T>;
  sessionTransition: Promise<void>;
};

function loaded(sessionId: string, videoItag = 137): LoadedSession {
  return {
    response: {
      sessionId,
      videoId: "nt1TGErpc0Q",
      generation: 0,
      ready: true,
      retryAfterMs: null,
    },
    manifest,
    videoItag,
    audioItag: 140,
    audioTrackId: "en-US.4",
    audioOnly: false,
  };
}

export function recoveryError(
  action: "retry_fresh_session" | "retry_fresh_session_lower_video_itag" = "retry_fresh_session",
  retryVideoItags: number[] = [],
): PlaybackWindowRecoveryError {
  return new PlaybackWindowRecoveryError("SABR demand stalled", action, retryVideoItags);
}

export function harness(create: RecoveryHarness["deps"]["playback"]["create"], paused = false) {
  const player = Object.create(TypeTypeMsePlayer.prototype) as RecoveryHarness;
  const requests: CreatePlaybackRequest[] = [];
  const failures: Error[] = [];
  const failurePositions: number[] = [];
  const qualities: number[] = [];
  player.destroyed = false;
  player.loadTask = null;
  player.sessionTransition = Promise.resolve();
  player.session = loaded("source");
  player.operation = new PlayerOperation();
  player.playbackRecovery = new PlaybackRecovery();
  player.playbackIntent = new PlaybackIntent();
  player.playerState = {
    value: "playing",
    set: (state) => (player.playerState.value = state),
    fail: (error, positionMs) => {
      failures.push(error);
      failurePositions.push(positionMs);
    },
  };
  player.deps = {
    loop: { stop: () => undefined },
    playback: {
      create: async (request, signal) => {
        requests.push(request);
        return create(request, signal);
      },
    },
  };
  player.emitter = {
    emit: (event) => {
      if (event.type === "quality" && event.videoItag !== undefined) {
        qualities.push(event.videoItag);
      }
    },
  };
  player.video = { paused, currentTime: 379.441 };
  player.recoveryPositionMs = 379_441;
  player.config = {
    endpoint: "https://beta.typetype.video/api",
    videoId: "nt1TGErpc0Q",
    videoItag: 137,
    audioItag: 140,
    audioTrackId: "en-US.4",
  };
  player.switchSession = async (...args) => {
    const playback = args[0] as PlaybackResponse;
    const quality = args[4] as { videoItag: number };
    const next = loaded(playback.sessionId, quality.videoItag);
    player.session = next;
    return next;
  };
  return { player, requests, failures, failurePositions, qualities };
}

export function response(sessionId: string): PlaybackResponse {
  return {
    sessionId,
    videoId: "nt1TGErpc0Q",
    generation: 0,
    ready: false,
    retryAfterMs: null,
  };
}

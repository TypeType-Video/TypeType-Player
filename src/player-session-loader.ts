import { decodeStartMs } from "./decode-preroll";
import { rateAwareBufferGoalMs } from "./playback-rate";
import type { PlayerDeps } from "./player-deps";
import type { PlaybackRecovery } from "./player-recovery";
import {
  type LoadedSession,
  loadPlaybackSession,
  PlaybackWindowRecoveryError,
} from "./session-loader";
import type { TypeTypeMseConfig, TypeTypeMseQuality } from "./types";

type Args = {
  deps: PlayerSessionDeps;
  config: TypeTypeMseConfig;
  video: { currentTime: number; paused?: boolean };
  response: LoadedSession["response"];
  current: LoadedSession | null;
  quality: TypeTypeMseQuality | undefined;
  startTimeMs: number;
  signal: AbortSignal;
  recovery: PlaybackRecovery;
  beforeAttach?: () => Promise<void>;
};

type PlayerSessionDeps = {
  playback: Pick<PlayerDeps["playback"], "create" | "position" | "prefetch" | "segments">;
  media: Pick<PlayerDeps["media"], "attach" | "bufferedRanges">;
  scheduler: Pick<PlayerDeps["scheduler"], "appendInit" | "fill" | "reset">;
  policy: PlayerDeps["policy"];
  playbackRate?: PlayerDeps["playbackRate"];
};

type TrackSelection = {
  videoItag: number;
  audioItag: number;
  audioTrackId: string | null;
};

export async function loadPlayerSession(args: Args): Promise<LoadedSession> {
  const selection = resolveSelection(args);
  try {
    return await loadSelectedSession(args, args.response, selection);
  } catch (error) {
    if (!(error instanceof PlaybackWindowRecoveryError)) throw error;
    return recoverInitialSession(args, selection, error);
  }
}

export function loadPlayerSessionOnce(args: Args): Promise<LoadedSession> {
  const selection = resolveSelection(args);
  return loadSelectedSession(args, args.response, selection);
}

function resolveSelection(args: Args): TrackSelection {
  return {
    videoItag:
      args.response.videoItag ??
      args.quality?.videoItag ??
      args.current?.videoItag ??
      args.config.videoItag,
    audioItag:
      args.response.audioItag ??
      args.quality?.audioItag ??
      args.current?.audioItag ??
      args.config.audioItag,
    audioTrackId:
      args.response.audioTrackId !== undefined
        ? args.response.audioTrackId
        : (args.quality?.audioTrackId ?? args.current?.audioTrackId ?? args.config.audioTrackId),
  };
}

async function loadSelectedSession(
  args: Args,
  response: LoadedSession["response"],
  selection: TrackSelection,
): Promise<LoadedSession> {
  const requestedStartTimeMs = response.startTimeMs ?? args.startTimeMs;
  const session = await loadPlaybackSession({
    playback: args.deps.playback,
    media: args.deps.media,
    scheduler: args.deps.scheduler,
    video: args.video,
    response,
    videoItag: selection.videoItag,
    audioItag: selection.audioItag,
    audioTrackId: selection.audioTrackId,
    audioOnly: args.config.audioOnly === true,
    startTimeMs: requestedStartTimeMs,
    playbackRate: args.deps.playbackRate,
    policy: args.deps.policy,
    signal: args.signal,
    ...(args.quality && args.video.paused === false
      ? {
          playerTimeMs: () => Math.max(args.startTimeMs, Math.round(args.video.currentTime * 1000)),
        }
      : {}),
    ...(args.beforeAttach ? { beforeAttach: args.beforeAttach } : {}),
  });
  const startTimeMs =
    session.response.startTimeMs ?? session.manifest.startTimeMs ?? requestedStartTimeMs;
  const fillStartMs = decodeStartMs(session.manifest, startTimeMs);
  await args.deps.scheduler.fill(
    session.manifest,
    fillStartMs,
    startTimeMs +
      rateAwareBufferGoalMs(args.deps.policy.bufferGoalMs, args.deps.playbackRate?.() ?? 1),
    args.signal,
  );
  if (args.signal.aborted) throw new DOMException("Operation aborted", "AbortError");
  return session;
}

async function recoverInitialSession(
  args: Args,
  selection: TrackSelection,
  initialError: PlaybackWindowRecoveryError,
): Promise<LoadedSession> {
  const videoItag = selection.videoItag;
  let lastError: unknown = initialError;
  while (true) {
    if (!args.recovery.takeAttempt(videoItag)) throw lastError;
    try {
      const response = await args.deps.playback.create(
        {
          videoId: args.config.videoId,
          videoItag,
          audioItag: selection.audioItag,
          audioTrackId: selection.audioTrackId,
          startTimeMs: args.startTimeMs,
          audioOnly: args.config.audioOnly === true,
          ...(args.config.isLive ? { isLive: true } : {}),
        },
        args.signal,
      );
      const session = await loadSelectedSession(args, response, { ...selection, videoItag });
      return session;
    } catch (error) {
      if (isAbortError(error)) throw error;
      lastError = error;
    }
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

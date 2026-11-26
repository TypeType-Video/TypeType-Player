import { decodeStartMs } from "./decode-preroll";
import type { PlaybackManifest } from "./manifest";
import { bufferedEndAtCurrentTrackRanges } from "./media-buffer";
import { rateAwareBufferGoalMs } from "./playback-rate";
import type { PlayerDeps } from "./player-deps";
import type { PlaybackRecovery } from "./player-recovery";
import {
  type LoadedSession,
  loadPlaybackSession,
  PlaybackWindowRecoveryError,
} from "./session-loader";
import type { TypeTypeMseConfig, TypeTypeMseQuality } from "./types";

const STARTUP_BUFFER_MS = 2_500;
// Playback starts once this much is buffered after the start on every track, while the rest of the startup fill
// keeps coming: YouTube can take seconds to send a first segment whose first part already plays.
const PLAYABLE_START_MS = 1_000;
const PLAYABLE_POLL_MS = 25;

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
  handoff?: (manifest: PlaybackManifest) => Promise<number>;
  startupBufferMs?: number;
  keepBufferedMedia?: boolean;
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
    bufferGoalMs: Math.min(startupBufferMs(args), args.deps.policy.bufferGoalMs),
    policy: args.deps.policy,
    signal: args.signal,
    ...(args.quality && args.video.paused === false
      ? {
          playerTimeMs: () => Math.max(args.startTimeMs, Math.round(args.video.currentTime * 1000)),
        }
      : {}),
    ...(args.beforeAttach ? { beforeAttach: args.beforeAttach } : {}),
    ...(args.handoff ? { handoff: args.handoff } : {}),
    ...(args.keepBufferedMedia ? { keepBufferedMedia: true } : {}),
  });
  const startTimeMs =
    session.response.startTimeMs ?? session.manifest.startTimeMs ?? requestedStartTimeMs;
  const fillStartMs = decodeStartMs(session.manifest, startTimeMs);
  const playbackRate = args.deps.playbackRate?.() ?? 1;
  await fillUntilPlayable(
    args,
    session.manifest,
    fillStartMs,
    startTimeMs,
    startTimeMs +
      Math.min(
        rateAwareBufferGoalMs(startupBufferMs(args), playbackRate),
        rateAwareBufferGoalMs(args.deps.policy.bufferGoalMs, playbackRate),
      ),
  );
  if (args.signal.aborted) throw new DOMException("Operation aborted", "AbortError");
  return session;
}

/**
 * Runs the startup fill and returns when it ends or as soon as every track holds PLAYABLE_START_MS after the start,
 * whichever comes first. A fill still running goes on: the playback loop asks for the same segments and joins it,
 * so its failures come back through the loop.
 */
async function fillUntilPlayable(
  args: Args,
  manifest: PlaybackManifest,
  fillStartMs: number,
  startTimeMs: number,
  goalMs: number,
): Promise<void> {
  let settled = false;
  const fill = args.deps.scheduler.fill(manifest, fillStartMs, goalMs, args.signal).finally(() => {
    settled = true;
  });
  const playableEndMs = Math.min(goalMs, startTimeMs + PLAYABLE_START_MS);
  const playable = async () => {
    while (!settled && !args.signal.aborted) {
      const ranges = args.deps.media.bufferedRanges();
      if (
        bufferedEndAtCurrentTrackRanges(ranges, startTimeMs, manifest.video !== null) >=
        playableEndMs
      )
        return;
      await new Promise((resolve) => setTimeout(resolve, PLAYABLE_POLL_MS));
    }
    await fill;
  };
  await Promise.race([fill, playable()]);
  fill.catch(() => undefined);
}

function startupBufferMs(args: Args): number {
  return args.startupBufferMs ?? STARTUP_BUFFER_MS;
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
      await args.recovery.waitBeforeAttempt(lastError, args.signal);
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

import type { BufferPolicy } from "./buffer-policy";
import type { PlaybackManifest } from "./manifest";
import { MediaSourceController } from "./media-source-controller";
import type { PlaybackClient, PlaybackResponse } from "./playback-client";
import type { PlaybackWindowRequest } from "./playback-window";
import {
  PlaybackWindowRecoveryError,
  PlaybackWindowTerminalError,
  PlaybackWindowTimeoutError,
} from "./playback-window-error";
import { createPlaybackWindowRequest } from "./playback-window-request";
import type { SegmentScheduler } from "./segment-scheduler";

export { PlaybackWindowRecoveryError } from "./playback-window-error";

export type LoadedSession = {
  response: PlaybackResponse;
  manifest: PlaybackManifest;
  videoItag: number;
  audioItag: number;
  audioTrackId: string | null;
  audioOnly: boolean;
};

type LoadSessionArgs = {
  playback: Pick<PlaybackClient, "position" | "prefetch" | "segments">;
  media: Pick<MediaSourceController, "attach" | "bufferedRanges">;
  scheduler: Pick<SegmentScheduler, "appendInit" | "reset">;
  video: { currentTime: number };
  response: PlaybackResponse;
  videoItag: number;
  audioItag: number;
  audioTrackId: string | null;
  audioOnly: boolean;
  startTimeMs: number;
  playerTimeMs?: () => number;
  playbackRate?: (() => number) | undefined;
  policy: BufferPolicy;
  signal: AbortSignal;
  beforeAttach?: () => Promise<void>;
};

export async function loadPlaybackSession(args: LoadSessionArgs): Promise<LoadedSession> {
  const request = () => ({
    ...createPlaybackWindowRequest(args, requestedStartTimeMs(args)),
    bufferedRanges: [],
  });
  const window = await waitForWindow(args, args.response.sessionId, request);
  if (!window.manifest) throw new Error("Playback window is not ready");
  const resolvedStartTimeMs =
    window.startTimeMs ?? window.manifest.startTimeMs ?? requestedStartTimeMs(args);
  const live = window.live ?? window.manifest.live ?? args.response.live ?? null;
  const response = {
    ...args.response,
    generation: window.generation,
    startTimeMs: resolvedStartTimeMs,
    live,
  };
  const manifest = { ...window.manifest, startTimeMs: resolvedStartTimeMs, live };
  return attachSession(args, response, manifest);
}

function requestedStartTimeMs(args: LoadSessionArgs): number {
  return args.playerTimeMs?.() ?? args.response.startTimeMs ?? args.startTimeMs;
}

async function attachSession(
  args: LoadSessionArgs,
  response: PlaybackResponse,
  manifest: PlaybackManifest,
): Promise<LoadedSession> {
  if (!MediaSourceController.supported(manifest)) throw new Error("MSE codecs are not supported");
  ensureNotAborted(args.signal);
  await args.beforeAttach?.();
  ensureNotAborted(args.signal);
  args.scheduler.reset();
  await args.media.attach(manifest);
  ensureNotAborted(args.signal);
  await args.scheduler.appendInit(manifest, args.signal);
  return {
    response,
    manifest,
    videoItag: args.videoItag,
    audioItag: args.audioItag,
    audioTrackId: args.audioTrackId,
    audioOnly: args.audioOnly,
  };
}

function ensureNotAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new DOMException("Operation aborted", "AbortError");
}

export async function refreshPlaybackWindow(
  playback: Pick<PlaybackClient, "position" | "prefetch" | "segments">,
  media: Pick<MediaSourceController, "bufferedRanges"> &
    Partial<Pick<MediaSourceController, "updateTiming">>,
  session: LoadedSession,
  policy: BufferPolicy,
  playerTimeMs: () => number,
  signal: AbortSignal,
  playbackRate?: () => number,
): Promise<void> {
  const window = await pollSegments({ playback, policy, signal }, session.response.sessionId, () =>
    createPlaybackWindowRequest({ ...session, media, policy, playbackRate }, playerTimeMs()),
  );
  if (!window?.manifest) return;
  ensureNotAborted(signal);
  const startTimeMs =
    window.startTimeMs ??
    window.manifest.startTimeMs ??
    session.response.startTimeMs ??
    playerTimeMs();
  const live = window.live ?? window.manifest.live ?? session.response.live ?? null;
  session.response = { ...session.response, generation: window.generation, startTimeMs, live };
  session.manifest = { ...window.manifest, startTimeMs, live };
  media.updateTiming?.(session.manifest);
}

async function waitForWindow(
  args: Pick<LoadSessionArgs, "playback" | "policy" | "signal">,
  sessionId: string,
  request: () => PlaybackWindowRequest,
) {
  return pollSegments(args, sessionId, request);
}

async function pollSegments(
  args: Pick<LoadSessionArgs, "playback" | "policy" | "signal">,
  sessionId: string,
  request: () => PlaybackWindowRequest,
) {
  handleWindow(await args.playback.position(sessionId, request(), args.signal));
  let previousEdgeMs: number | null = null;
  let stagnantAttempts = 0;
  for (let attempt = 0; attempt < args.policy.manifestPollLimit; attempt += 1) {
    if (args.signal.aborted) throw new DOMException("Operation aborted", "AbortError");
    const prefetch = handleWindow(await args.playback.prefetch(sessionId, request(), args.signal));
    if (!prefetch.ready) {
      stagnantAttempts = prefetch.bufferedEdgeMs === previousEdgeMs ? stagnantAttempts + 1 : 0;
      previousEdgeMs = prefetch.bufferedEdgeMs;
      await retryDelay(prefetch.retryAfterMs, stagnantAttempts, args.signal);
      continue;
    }
    const window = handleWindow(await args.playback.segments(sessionId, request(), args.signal));
    if (window.ready && window.manifest) return window;
    stagnantAttempts = window.bufferedEdgeMs === previousEdgeMs ? stagnantAttempts + 1 : 0;
    previousEdgeMs = window.bufferedEdgeMs;
    await retryDelay(window.retryAfterMs, stagnantAttempts, args.signal);
  }
  throw new PlaybackWindowTimeoutError();
}

function retryDelay(
  retryAfterMs: number | null,
  stagnantAttempts: number,
  signal: AbortSignal,
): Promise<void> {
  const requestedMs = Math.max(250, retryAfterMs ?? 500);
  const multiplier = 2 ** Math.min(3, Math.floor(stagnantAttempts / 4));
  const delayMs = Math.min(2_000, requestedMs * multiplier);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(finish, delayMs);
    signal.addEventListener("abort", abort, { once: true });
    function finish(): void {
      signal.removeEventListener("abort", abort);
      resolve();
    }
    function abort(): void {
      clearTimeout(timer);
      reject(new DOMException("Operation aborted", "AbortError"));
    }
  });
}

function handleWindow(window: Awaited<ReturnType<PlaybackClient["segments"]>>) {
  if (!window.terminalError) return window;
  if (window.recoveryAction) {
    throw new PlaybackWindowRecoveryError(
      window.terminalError,
      window.recoveryAction,
      window.retryVideoItags,
    );
  }
  throw new PlaybackWindowTerminalError(window.terminalError);
}

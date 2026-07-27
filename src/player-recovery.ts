import type { CreatePlaybackRequest, PlaybackResponse } from "./playback-client";
import type { LoadedSession, PlaybackWindowRecoveryError } from "./session-loader";

export const MAX_FRESH_SESSION_RECOVERIES = 2;
const STABLE_PLAYBACK_RESET_MS = 30_000;
const MAX_PROGRESS_GAP_MS = 2_000;
const MAX_PROGRESS_RATE = 4;
const PROGRESS_TOLERANCE_MS = 500;

export type PlaybackRecoveryDecision = "recover" | "exhausted" | "ignore";

export class PlaybackRecovery {
  private recoveringSessionId: string | null = null;
  private attempts = 0;
  private stableStartedAtMs: number | null = null;
  private lastProgressAtMs: number | null = null;
  private lastPositionMs: number | null = null;
  private readonly handledSessionIds = new Set<string>();
  private failureReported = false;

  begin(sessionId: string): PlaybackRecoveryDecision {
    if (this.recoveringSessionId === sessionId || this.handledSessionIds.has(sessionId)) {
      return "ignore";
    }
    this.handledSessionIds.add(sessionId);
    if (this.attempts >= MAX_FRESH_SESSION_RECOVERIES) return "exhausted";
    this.recoveringSessionId = sessionId;
    return "recover";
  }

  takeAttempt(_videoItag: number): boolean {
    if (this.attempts >= MAX_FRESH_SESSION_RECOVERIES) return false;
    this.attempts += 1;
    return true;
  }

  complete(positionMs: number, nowMs = performance.now()): void {
    this.stableStartedAtMs = nowMs;
    this.lastProgressAtMs = nowMs;
    this.lastPositionMs = positionMs;
  }

  observeProgress(positionMs: number, nowMs = performance.now()): void {
    if (this.lastProgressAtMs === null || this.lastPositionMs === null) {
      return;
    }
    const elapsedMs = nowMs - this.lastProgressAtMs;
    const advancedMs = positionMs - this.lastPositionMs;
    const continuous =
      elapsedMs > 0 &&
      elapsedMs <= MAX_PROGRESS_GAP_MS &&
      advancedMs > 0 &&
      advancedMs <= elapsedMs * MAX_PROGRESS_RATE + PROGRESS_TOLERANCE_MS;
    if (continuous) {
      this.stableStartedAtMs ??= nowMs;
    } else {
      this.stableStartedAtMs = advancedMs > 0 ? nowMs : null;
    }
    this.lastProgressAtMs = nowMs;
    this.lastPositionMs = positionMs;
    if (
      this.recoveringSessionId === null &&
      this.stableStartedAtMs !== null &&
      nowMs - this.stableStartedAtMs >= STABLE_PLAYBACK_RESET_MS
    ) {
      this.reset();
    }
  }

  finish(sessionId: string): void {
    if (this.recoveringSessionId === sessionId) this.recoveringSessionId = null;
  }

  reportOnce(error: Error, report: (error: Error) => void): void {
    if (this.failureReported) return;
    this.failureReported = true;
    report(error);
  }

  reset(): void {
    this.recoveringSessionId = null;
    this.attempts = 0;
    this.stableStartedAtMs = null;
    this.lastProgressAtMs = null;
    this.lastPositionMs = null;
    this.handledSessionIds.clear();
    this.failureReported = false;
  }
}

type RecoverySelection = {
  videoItag: number;
  audioItag: number;
  audioTrackId: string | null;
};

type RecoverArgs = {
  recovery: PlaybackRecovery;
  current: LoadedSession;
  error: PlaybackWindowRecoveryError;
  videoId: string;
  isLive?: boolean;
  startTimeMs: number;
  signal: AbortSignal;
  create: (request: CreatePlaybackRequest, signal: AbortSignal) => Promise<PlaybackResponse>;
  ensureCurrent: () => void;
  switchSession: (
    response: PlaybackResponse,
    selection: RecoverySelection,
  ) => Promise<LoadedSession>;
};

export async function recoverPlaybackSession(args: RecoverArgs): Promise<LoadedSession> {
  const videoItag = args.current.videoItag;
  let lastError: unknown = args.error;
  while (args.recovery.takeAttempt(videoItag)) {
    try {
      const response = await args.create(
        {
          videoId: args.videoId,
          videoItag,
          audioItag: args.current.audioItag,
          audioTrackId: args.current.audioTrackId,
          startTimeMs: args.startTimeMs,
          audioOnly: args.current.audioOnly,
          ...(args.isLive ? { isLive: true } : {}),
        },
        args.signal,
      );
      args.ensureCurrent();
      const session = await args.switchSession(response, {
        videoItag,
        audioItag: args.current.audioItag,
        audioTrackId: args.current.audioTrackId,
      });
      return session;
    } catch (error) {
      if (isAbortError(error)) throw error;
      lastError = error;
    }
  }
  throw lastError;
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

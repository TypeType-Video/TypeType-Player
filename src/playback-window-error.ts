import type { PlaybackWindowRecoveryAction } from "./playback-window";

export class PlaybackWindowTerminalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlaybackWindowTerminalError";
  }
}

export class PlaybackWindowRecoveryError extends PlaybackWindowTerminalError {
  constructor(
    message: string,
    readonly recoveryAction: PlaybackWindowRecoveryAction,
    readonly retryVideoItags: number[],
  ) {
    super(message);
    this.name = "PlaybackWindowRecoveryError";
  }
}

export class PlaybackWindowTimeoutError extends Error {
  constructor() {
    super("Playback window was not ready in time");
    this.name = "PlaybackWindowTimeoutError";
  }
}

export function playbackSessionExpiredError(): PlaybackWindowRecoveryError {
  return new PlaybackWindowRecoveryError("Playback session expired", "retry_fresh_session", []);
}

export function isPlaybackSessionExpiryStatus(status: number): boolean {
  return status === 404 || status === 410;
}

import { expect, test } from "bun:test";
import type { MediaBufferedRange } from "../src/media-source-controller";
import type { PlaybackWindow, PlaybackWindowRequest } from "../src/playback-window";
import { PlaybackWindowTimeoutError } from "../src/playback-window-error";
import type { LoadedSession } from "../src/session-loader";
import { refreshPlaybackWindow } from "../src/session-loader";
import { StarvedWindowDeadline } from "../src/starved-window-deadline";

const PLAYER_MS = 50_000;

test("expires once the player starves while the server edge stays put", () => {
  const clock = steppingClock(2_000);
  const deadline = new StarvedWindowDeadline(args(starvedRanges(), clock));

  const expired = [1, 2, 3, 4, 5].map(() => deadline.expired(50_366));

  expect(expired).toEqual([false, false, false, false, true]);
});

test("keeps waiting while the server edge moves", () => {
  const clock = steppingClock(2_000);
  const deadline = new StarvedWindowDeadline(args(starvedRanges(), clock));

  const expired = [50_366, 52_000, 54_000, 56_000, 58_000].map((edge) => deadline.expired(edge));

  expect(expired.some(Boolean)).toBe(false);
});

test("keeps waiting while the player still has media ahead", () => {
  const clock = steppingClock(2_000);
  const ranges: MediaBufferedRange[] = [
    { kind: "audio", startMs: 0, endMs: PLAYER_MS + 9_000 },
    { kind: "video", startMs: 0, endMs: PLAYER_MS + 4_000 },
  ];
  const deadline = new StarvedWindowDeadline(args(ranges, clock));

  const expired = [1, 2, 3, 4, 5, 6].map(() => deadline.expired(50_366));

  expect(expired.some(Boolean)).toBe(false);
});

test("an audio-only session ignores the missing video track", () => {
  const clock = steppingClock(2_000);
  const ranges: MediaBufferedRange[] = [{ kind: "audio", startMs: 0, endMs: PLAYER_MS + 9_000 }];
  const deadline = new StarvedWindowDeadline({ ...args(ranges, clock), audioOnly: true });

  const expired = [1, 2, 3, 4, 5, 6].map(() => deadline.expired(50_366));

  expect(expired.some(Boolean)).toBe(false);
});

test("a starved refresh gives up on a stuck server so the player opens a fresh session", async () => {
  const clock = steppingClock(2_000);
  const notReady = (sessionId: string, request: PlaybackWindowRequest): PlaybackWindow => ({
    sessionId,
    generation: request.generation,
    ready: false,
    retryAfterMs: 250,
    terminalError: null,
    recoveryAction: null,
    retryVideoItags: [],
    manifest: null,
    bufferedEdgeMs: 50_366,
  });
  let prefetches = 0;
  const reply = async (sessionId: string, request: PlaybackWindowRequest) =>
    notReady(sessionId, request);
  const playback = {
    position: reply,
    prefetch: async (sessionId: string, request: PlaybackWindowRequest) => {
      prefetches += 1;
      return notReady(sessionId, request);
    },
    segments: reply,
  };

  const refresh = refreshPlaybackWindow(
    playback,
    { bufferedRanges: starvedRanges },
    session(),
    {
      bufferGoalMs: 10_000,
      backBufferMs: 30_000,
      pollIntervalMs: 500,
      manifestRefreshMs: 8_000,
      manifestPollLimit: 12,
      segmentPollLimit: 8,
    },
    () => PLAYER_MS,
    new AbortController().signal,
    undefined,
    clock,
  );

  await expect(refresh).rejects.toBeInstanceOf(PlaybackWindowTimeoutError);
  expect(prefetches).toBe(5);
});

function args(ranges: MediaBufferedRange[], now: () => number) {
  return { bufferedRanges: () => ranges, playerTimeMs: () => PLAYER_MS, audioOnly: false, now };
}

function starvedRanges(): MediaBufferedRange[] {
  return [
    { kind: "audio", startMs: 0, endMs: PLAYER_MS + 9_000 },
    { kind: "video", startMs: 0, endMs: PLAYER_MS + 366 },
  ];
}

function steppingClock(stepMs: number): () => number {
  let nowMs = 0;
  return () => {
    nowMs += stepMs;
    return nowMs;
  };
}

function session(): LoadedSession {
  return {
    response: {
      sessionId: "stuck",
      videoId: "video",
      generation: 0,
      startTimeMs: 0,
      ready: true,
      retryAfterMs: null,
    },
    manifest: {} as LoadedSession["manifest"],
    videoItag: 299,
    audioItag: 140,
    audioTrackId: null,
    audioOnly: false,
  };
}

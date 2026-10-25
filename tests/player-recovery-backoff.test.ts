import { expect, test } from "bun:test";
import { TypeTypeHttpError } from "../src/http-client";
import type { PlaybackManifest } from "../src/manifest";
import type { PlaybackResponse } from "../src/playback-client";
import { PlaybackRecovery, recoverPlaybackSession } from "../src/player-recovery";
import { loadPlayerSession } from "../src/player-session-loader";
import { type LoadedSession, PlaybackWindowRecoveryError } from "../src/session-loader";

const manifest: PlaybackManifest = {
  durationMs: 600_000,
  endOfStream: false,
  audio: { kind: "audio", mime: "audio/mp4", initUrl: "/audio/init", segments: [] },
  video: null,
};

function response(sessionId: string): PlaybackResponse {
  return { sessionId, videoId: "video", generation: 0, ready: false, retryAfterMs: null };
}

function loaded(sessionId: string): LoadedSession {
  return {
    response: response(sessionId),
    manifest,
    videoItag: 137,
    audioItag: 140,
    audioTrackId: null,
    audioOnly: false,
  };
}

function recordingRecovery() {
  const delays: number[] = [];
  const recovery = new PlaybackRecovery(async (delayMs) => {
    delays.push(delayMs);
  });
  return { recovery, delays };
}

test("backs off one then two seconds between fresh session attempts", async () => {
  const { recovery, delays } = recordingRecovery();

  const error = await recoverPlaybackSession({
    recovery,
    current: loaded("source"),
    error: new PlaybackWindowRecoveryError("stalled", "retry_fresh_session", []),
    videoId: "video",
    startTimeMs: 90_000,
    signal: new AbortController().signal,
    create: async () => {
      throw new PlaybackWindowRecoveryError("stalled again", "retry_fresh_session", []);
    },
    ensureCurrent: () => undefined,
    switchSession: async () => loaded("unused"),
  }).catch((reason: unknown) => reason);

  expect(error).toMatchObject({ message: "stalled again" });
  expect(delays).toEqual([1_000, 2_000]);
});

test("adds the delay requested by an overloaded server before recreating the session", async () => {
  const { recovery, delays } = recordingRecovery();
  let creates = 0;

  await recoverPlaybackSession({
    recovery,
    current: loaded("source"),
    error: new TypeTypeHttpError("Service Unavailable", 503, 15_000),
    videoId: "video",
    startTimeMs: 90_000,
    signal: new AbortController().signal,
    create: async () => {
      creates += 1;
      return response("fresh");
    },
    ensureCurrent: () => undefined,
    switchSession: async (playback) => loaded(playback.sessionId),
  });

  expect(creates).toBe(1);
  expect(delays).toEqual([16_000]);
});

test("backs off before recreating an initial session that failed to load", async () => {
  const { recovery, delays } = recordingRecovery();
  const created: string[] = [];

  const session = await loadPlayerSession({
    deps: {
      playback: {
        create: async () => {
          created.push("fresh");
          return { ...response("fresh"), startTimeMs: 0 };
        },
        position: async () => {
          throw new PlaybackWindowRecoveryError("stalled", "retry_fresh_session", [], 4_000);
        },
        prefetch: async () => {
          throw new Error("unused");
        },
        segments: async () => {
          throw new Error("unused");
        },
      },
      media: { attach: async () => undefined, bufferedRanges: () => [] },
      scheduler: { appendInit: async () => undefined, fill: async () => "filled", reset: () => {} },
      policy: {
        bufferGoalMs: 10_000,
        backBufferMs: 30_000,
        pollIntervalMs: 500,
        manifestRefreshMs: 8_000,
        manifestPollLimit: 2,
        segmentPollLimit: 2,
      },
    },
    config: {
      endpoint: "https://example.test/api",
      videoId: "video",
      videoItag: 137,
      audioItag: 140,
      audioTrackId: null,
    },
    video: { currentTime: 0 },
    response: response("initial"),
    current: null,
    quality: undefined,
    startTimeMs: 0,
    signal: new AbortController().signal,
    recovery,
  }).catch((reason: unknown) => reason);

  expect(session).toBeInstanceOf(PlaybackWindowRecoveryError);
  expect(created).toEqual(["fresh", "fresh"]);
  expect(delays).toEqual([5_000, 6_000]);
});

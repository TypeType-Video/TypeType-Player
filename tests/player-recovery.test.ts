import { expect, test } from "bun:test";
import type { PlaybackManifest } from "../src/manifest";
import type { CreatePlaybackRequest, PlaybackResponse } from "../src/playback-client";
import { PlaybackRecovery, recoverPlaybackSession } from "../src/player-recovery";
import { type LoadedSession, PlaybackWindowRecoveryError } from "../src/session-loader";

const manifest: PlaybackManifest = {
  durationMs: 600_000,
  endOfStream: false,
  audio: { kind: "audio", mime: "audio/mp4", initUrl: "/audio/init", segments: [] },
  video: { kind: "video", mime: "video/mp4", initUrl: "/video/init", segments: [] },
};

function loaded(sessionId: string, videoItag = 137): LoadedSession {
  return {
    response: response(sessionId),
    manifest,
    videoItag,
    audioItag: 140,
    audioTrackId: "en-US.4",
    audioOnly: false,
  };
}

function response(sessionId: string): PlaybackResponse {
  return {
    sessionId,
    videoId: "nt1TGErpc0Q",
    generation: 0,
    ready: false,
    retryAfterMs: null,
  };
}

function recoveryError(
  action: "retry_fresh_session" | "retry_fresh_session_lower_video_itag" = "retry_fresh_session",
  retryVideoItags: number[] = [],
): PlaybackWindowRecoveryError {
  return new PlaybackWindowRecoveryError("SABR demand stalled for 140:39", action, retryVideoItags);
}

test("bounds one recovery chain and resets it after stable progress", () => {
  const recovery = new PlaybackRecovery();

  expect(recovery.begin("source")).toBe("recover");
  expect(recovery.begin("source")).toBe("ignore");
  expect(recovery.takeAttempt(137)).toBe(true);
  recovery.finish("source");
  expect(recovery.begin("fresh-1")).toBe("recover");
  expect(recovery.takeAttempt(137)).toBe(true);
  recovery.complete(100_000, 0);
  recovery.finish("fresh-1");
  expect(recovery.begin("fresh-2")).toBe("exhausted");
  expect(recovery.begin("fresh-2")).toBe("ignore");
  for (let second = 1; second <= 30; second += 1) {
    recovery.observeProgress(100_000 + second * 1_000, second * 1_000);
  }
  expect(recovery.begin("later-session")).toBe("recover");
  expect(recovery.takeAttempt(137)).toBe(true);
});

test("does not reset recovery across a playback stall", () => {
  const recovery = new PlaybackRecovery();
  expect(recovery.takeAttempt(137)).toBe(true);
  expect(recovery.takeAttempt(137)).toBe(true);
  recovery.complete(100_000, 0);
  for (let second = 1; second <= 15; second += 1) {
    recovery.observeProgress(100_000 + second * 1_000, second * 1_000);
  }
  recovery.observeProgress(116_000, 20_000);
  for (let second = 21; second <= 35; second += 1) {
    recovery.observeProgress(96_000 + second * 1_000, second * 1_000);
  }

  expect(recovery.begin("after-stall")).toBe("exhausted");
});

test("restarts stable progress after a duplicate media timeupdate", () => {
  const recovery = new PlaybackRecovery();
  expect(recovery.takeAttempt(137)).toBe(true);
  expect(recovery.takeAttempt(137)).toBe(true);
  recovery.complete(100_000, 0);
  recovery.observeProgress(100_000, 1_000);
  for (let second = 2; second <= 32; second += 1) {
    recovery.observeProgress(99_000 + second * 1_000, second * 1_000);
  }

  expect(recovery.begin("after-stable-progress")).toBe("recover");
});

test("does not reset the attempt budget during active recovery", () => {
  const recovery = new PlaybackRecovery();
  expect(recovery.takeAttempt(137)).toBe(true);
  recovery.complete(100_000, 0);
  for (let second = 1; second <= 29; second += 1) {
    recovery.observeProgress(100_000 + second * 1_000, second * 1_000);
  }
  expect(recovery.begin("recovering-session")).toBe("recover");
  expect(recovery.takeAttempt(137)).toBe(true);
  recovery.observeProgress(130_000, 30_000);
  recovery.finish("recovering-session");

  expect(recovery.begin("after-recovery")).toBe("exhausted");
});

test("reports only one final failure per recovery chain", () => {
  const recovery = new PlaybackRecovery();
  const failures: string[] = [];

  recovery.reportOnce(new Error("first"), (error) => failures.push(error.message));
  recovery.reportOnce(new Error("duplicate"), (error) => failures.push(error.message));
  recovery.reset();
  recovery.reportOnce(new Error("later"), (error) => failures.push(error.message));

  expect(failures).toEqual(["first", "later"]);
});

test("uses two fresh sessions with the exact playback selection and position", async () => {
  const recovery = new PlaybackRecovery();
  const requests: CreatePlaybackRequest[] = [];
  const switched: number[] = [];

  const session = await recoverPlaybackSession({
    recovery,
    current: loaded("source"),
    error: recoveryError(),
    videoId: "nt1TGErpc0Q",
    startTimeMs: 379_441,
    signal: new AbortController().signal,
    create: async (request) => {
      requests.push(request);
      return response(`fresh-${requests.length}`);
    },
    ensureCurrent: () => undefined,
    switchSession: async (playback, selection) => {
      switched.push(selection.videoItag);
      if (playback.sessionId === "fresh-1") throw recoveryError();
      return loaded(playback.sessionId, selection.videoItag);
    },
  });

  expect(requests).toEqual([
    {
      videoId: "nt1TGErpc0Q",
      videoItag: 137,
      audioItag: 140,
      audioTrackId: "en-US.4",
      startTimeMs: 379_441,
      audioOnly: false,
    },
    {
      videoId: "nt1TGErpc0Q",
      videoItag: 137,
      audioItag: 140,
      audioTrackId: "en-US.4",
      startTimeMs: 379_441,
      audioOnly: false,
    },
  ]);
  expect(switched).toEqual([137, 137]);
  expect(session.response.sessionId).toBe("fresh-2");
});

test("keeps the exact video format when a legacy backend requests a lower itag", async () => {
  const recovery = new PlaybackRecovery();
  const requests: CreatePlaybackRequest[] = [];

  const session = await recoverPlaybackSession({
    recovery,
    current: loaded("source"),
    error: recoveryError("retry_fresh_session_lower_video_itag", [136, 135]),
    videoId: "nt1TGErpc0Q",
    startTimeMs: 42_000,
    signal: new AbortController().signal,
    create: async (request) => {
      requests.push(request);
      return response(`fresh-${requests.length}`);
    },
    ensureCurrent: () => undefined,
    switchSession: async (playback, selection) => {
      if (playback.sessionId === "fresh-1") {
        throw recoveryError("retry_fresh_session_lower_video_itag", [136, 135]);
      }
      return loaded(playback.sessionId, selection.videoItag);
    },
  });

  expect(requests.map((request) => request.videoItag)).toEqual([137, 137]);
  expect(session.videoItag).toBe(137);
});

test("stops recovery immediately when its operation is aborted", async () => {
  const recovery = new PlaybackRecovery();
  let creates = 0;

  await expect(
    recoverPlaybackSession({
      recovery,
      current: loaded("source"),
      error: recoveryError(),
      videoId: "nt1TGErpc0Q",
      startTimeMs: 10_000,
      signal: new AbortController().signal,
      create: async () => {
        creates += 1;
        throw new DOMException("Operation aborted", "AbortError");
      },
      ensureCurrent: () => undefined,
      switchSession: async () => loaded("unused"),
    }),
  ).rejects.toHaveProperty("name", "AbortError");
  expect(creates).toBe(1);
});

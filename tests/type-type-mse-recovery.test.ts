import { expect, test } from "bun:test";
import type { PlaybackResponse } from "../src/playback-client";
import { harness, recoveryError, response } from "./type-type-mse-recovery-harness";

test("recovers two consecutive active sessions before one final error", async () => {
  let nextSession = 0;
  const { player, requests, failures } = harness(async () => {
    nextSession += 1;
    return response(`fresh-${nextSession}`);
  });

  player.handlePlaybackLoopError(recoveryError(), {
    sessionId: "source",
    signal: player.operation.signal,
  });
  await Bun.sleep(0);
  player.handlePlaybackLoopError(recoveryError(), {
    sessionId: "fresh-1",
    signal: player.operation.signal,
  });
  await Bun.sleep(0);
  const finalContext = { sessionId: "fresh-2", signal: player.operation.signal };
  player.handlePlaybackLoopError(recoveryError(), finalContext);
  player.handlePlaybackLoopError(recoveryError(), finalContext);
  await Bun.sleep(0);

  expect(requests.map((request) => request.startTimeMs)).toEqual([379_441, 379_441]);
  expect(requests.map((request) => request.audioTrackId)).toEqual(["en-US.4", "en-US.4"]);
  expect(failures.map((error) => error.message)).toEqual(["SABR demand stalled"]);
});

test("preserves explicit playback intent when stalled media reports paused", async () => {
  const { player } = harness(async () => response("fresh"), true);
  player.playbackIntent.play();

  player.handlePlaybackLoopError(recoveryError(), {
    sessionId: "source",
    signal: player.operation.signal,
  });
  await Bun.sleep(0);

  expect(player.playbackIntent.shouldResume).toBe(true);
});

test("ignores duplicate old-session events while recovery is pending", async () => {
  let release: ((value: PlaybackResponse) => void) | null = null;
  const pending = new Promise<PlaybackResponse>((resolve) => {
    release = resolve;
  });
  const { player, requests, failures } = harness(async () => pending);
  const first = { sessionId: "source", signal: new AbortController().signal };

  player.handlePlaybackLoopError(recoveryError(), first);
  player.handlePlaybackLoopError(recoveryError(), first);
  if (!release) throw new Error("Deferred response was not initialized");
  release(response("fresh-1"));
  await Bun.sleep(0);
  player.handlePlaybackLoopError(recoveryError(), first);

  expect(requests).toHaveLength(1);
  expect(failures).toHaveLength(0);
});

test("keeps the selected format when a legacy backend requests a lower itag", async () => {
  const { player, requests, qualities } = harness(async () => response("lower"));

  player.handlePlaybackLoopError(
    recoveryError("retry_fresh_session_lower_video_itag", [136, 135]),
    { sessionId: "source", signal: player.operation.signal },
  );
  await Bun.sleep(0);

  expect(requests[0]?.videoItag).toBe(137);
  expect(qualities).toEqual([]);
});

test("does not report a failure after a newer operation supersedes recovery", async () => {
  let rejectCreate: ((error: Error) => void) | null = null;
  const pending = new Promise<PlaybackResponse>((_resolve, reject) => {
    rejectCreate = reject;
  });
  const { player, failures } = harness(async () => pending, true);

  player.handlePlaybackLoopError(recoveryError(), {
    sessionId: "source",
    signal: new AbortController().signal,
  });
  player.operation.next();
  if (!rejectCreate) throw new Error("Deferred rejection was not initialized");
  rejectCreate(new Error("superseded recovery failed"));
  await Bun.sleep(0);

  expect(failures).toHaveLength(0);
  expect(player.playbackIntent.shouldResume).toBe(false);
});

test("serializes media source session transitions", async () => {
  const { player } = harness(async () => response("unused"));
  let active = 0;
  let maximumActive = 0;
  let releaseFirst: (() => void) | null = null;
  const firstPending = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const order: string[] = [];
  const first = player.enqueueSessionTransition(async () => {
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    order.push("first-start");
    await firstPending;
    order.push("first-end");
    active -= 1;
  });
  const second = player.enqueueSessionTransition(async () => {
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    order.push("second-start");
    active -= 1;
  });

  await Bun.sleep(0);
  expect(order).toEqual(["first-start"]);
  if (!releaseFirst) throw new Error("Deferred transition was not initialized");
  releaseFirst();
  await Promise.all([first, second]);

  expect(maximumActive).toBe(1);
  expect(order).toEqual(["first-start", "first-end", "second-start"]);
});

test("a generic failure aborts pending recovery and is reported once", async () => {
  const { player, failures, failurePositions } = harness(
    async (_request, signal) =>
      new Promise<PlaybackResponse>((_resolve, reject) => {
        signal?.addEventListener(
          "abort",
          () => reject(new DOMException("Operation aborted", "AbortError")),
          { once: true },
        );
      }),
  );
  player.handlePlaybackLoopError(recoveryError(), {
    sessionId: "source",
    signal: player.operation.signal,
  });
  const generic = new Error("media append failed");
  player.video.currentTime = 0;

  player.handlePlaybackLoopError(generic, {
    sessionId: "source",
    signal: player.operation.signal,
  });
  player.reportPlaybackFailure(new Error("duplicate media failure"));
  await Bun.sleep(0);

  expect(failures).toEqual([generic]);
  expect(failurePositions).toEqual([379_441]);
  expect(player.operation.signal.aborted).toBe(true);
});

test("an initial load failure reports its configured recovery position", async () => {
  const { player, failures, failurePositions } = harness(async () => response("unused"));
  const failure = new Error("gateway unavailable");
  player.video.currentTime = 0;
  player.loadInitialSession = () => Promise.reject(failure);

  await expect(player.load()).rejects.toBe(failure);

  expect(failures).toEqual([failure]);
  expect(failurePositions).toEqual([379_441]);
});

test("an old generic failure cannot replace an active recovery", async () => {
  let release: ((value: PlaybackResponse) => void) | null = null;
  const pending = new Promise<PlaybackResponse>((resolve) => {
    release = resolve;
  });
  const { player, failures } = harness(async () => pending);
  const oldSignal = player.operation.signal;
  player.handlePlaybackLoopError(recoveryError(), { sessionId: "source", signal: oldSignal });

  player.handlePlaybackLoopError(new Error("old loop failed"), {
    sessionId: "source",
    signal: oldSignal,
  });
  if (!release) throw new Error("Deferred response was not initialized");
  release(response("fresh-1"));
  await Bun.sleep(0);

  expect(failures).toHaveLength(0);
  expect(player.session?.response.sessionId).toBe("fresh-1");
});

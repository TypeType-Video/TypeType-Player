import { expect, test } from "bun:test";
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

function recoveryError(
  action: "retry_fresh_session" | "retry_fresh_session_lower_video_itag" = "retry_fresh_session",
  retryVideoItags: number[] = [],
): PlaybackWindowRecoveryError {
  return new PlaybackWindowRecoveryError("SABR demand stalled", action, retryVideoItags);
}

function harness(
  create: RecoveryHarness["deps"]["playback"]["create"],
  paused = false,
): {
  player: RecoveryHarness;
  requests: CreatePlaybackRequest[];
  failures: Error[];
  failurePositions: number[];
  qualities: number[];
} {
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
    const response = args[0] as PlaybackResponse;
    const quality = args[4] as { videoItag: number };
    const next = loaded(response.sessionId, quality.videoItag);
    player.session = next;
    return next;
  };
  return { player, requests, failures, failurePositions, qualities };
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

test("uses a backend-provided lower format and emits the quality change", async () => {
  const { player, requests, qualities } = harness(async () => response("lower"));

  player.handlePlaybackLoopError(
    recoveryError("retry_fresh_session_lower_video_itag", [136, 135]),
    { sessionId: "source", signal: player.operation.signal },
  );
  await Bun.sleep(0);

  expect(requests[0]?.videoItag).toBe(136);
  expect(qualities).toEqual([136]);
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

import { expect, test } from "bun:test";
import { BufferedSeekRecovery } from "../src/buffered-seek-recovery";
import { LiveEdgeFollower } from "../src/live-edge-follower";
import type { PlaybackManifest } from "../src/manifest";
import type { CreatePlaybackRequest, PlaybackResponse } from "../src/playback-client";
import { PlaybackIntent } from "../src/playback-intent";
import { PlaybackWindowRecoveryError } from "../src/playback-window-error";
import { PlayerOperation } from "../src/player-operation";
import { PlaybackRecovery } from "../src/player-recovery";
import { SeekController } from "../src/seek-controller";
import type { LoadedSession } from "../src/session-loader";
import { SessionTransitionQueue } from "../src/session-transition-queue";
import { TypeTypeMsePlayer } from "../src/type-type-mse-player";
import type { PlaybackLoopFailureContext, TypeTypeMseState } from "../src/types";
import { skipRecoveryDelay } from "./fake-retry-timing";

const manifest: PlaybackManifest = {
  durationMs: 600_000,
  endOfStream: false,
  audio: { kind: "audio", mime: "audio/mp4", initUrl: "/audio/init", segments: [] },
  video: { kind: "video", mime: "video/mp4", initUrl: "/video/init", segments: [] },
};

type SeekRecoveryHarness = {
  destroyed: boolean;
  audioOnly: boolean;
  playbackLifecycleActive: boolean;
  loadTask: Promise<void> | null;
  session: LoadedSession | null;
  operation: PlayerOperation;
  playbackRecovery: PlaybackRecovery;
  playbackIntent: PlaybackIntent;
  seekController: SeekController;
  bufferedSeekRecovery: BufferedSeekRecovery;
  liveEdgeFollower: LiveEdgeFollower;
  sessionTransitions: SessionTransitionQueue;
  recoveryPositionMs: number;
  preserveRecoveryPosition: boolean;
  video: HTMLVideoElement & { paused: boolean; currentTime: number };
  config: {
    endpoint: string;
    videoId: string;
    videoItag: number;
    audioItag: number;
    audioTrackId: string;
  };
  emitter: { emit: (event: unknown) => void };
  playerState: {
    value: TypeTypeMseState;
    set: (state: TypeTypeMseState) => void;
    fail: (error: Error, recoveryPositionMs: number) => void;
  };
  deps: {
    loop: { stop: () => void; quiesce: () => Promise<void>; start: () => void; wake: () => void };
    media: { requireFreshAttachment: () => void };
    playback: {
      seek: (
        sessionId: string,
        startTimeMs: number,
        options: unknown,
        signal?: AbortSignal,
      ) => Promise<PlaybackResponse>;
      create: (request: CreatePlaybackRequest, signal?: AbortSignal) => Promise<PlaybackResponse>;
    };
  };
  switchSession: (playback: PlaybackResponse) => Promise<LoadedSession>;
  performSeek: (
    positionMs: number,
    quality?: unknown,
    audioOnly?: boolean,
    userInitiated?: boolean,
  ) => Promise<void>;
  handlePlaybackLoopError: (
    error: Error,
    context: PlaybackLoopFailureContext,
    recoveryPositionMs?: number,
  ) => Promise<boolean>;
  seek: (positionMs: number) => Promise<void>;
};

function loaded(sessionId: string): LoadedSession {
  return {
    response: response(sessionId),
    manifest,
    videoItag: 137,
    audioItag: 140,
    audioTrackId: "en-US.4",
    audioOnly: false,
  };
}

function response(sessionId: string): PlaybackResponse {
  return {
    sessionId,
    videoId: "3T0ayXcUAhE",
    generation: 0,
    ready: true,
    retryAfterMs: null,
  };
}

function seekRecoveryError(): PlaybackWindowRecoveryError {
  return new PlaybackWindowRecoveryError("SABR demand stalled", "retry_fresh_session", []);
}

function createHarness(args: {
  seek: SeekRecoveryHarness["deps"]["playback"]["seek"];
  create: SeekRecoveryHarness["deps"]["playback"]["create"];
  currentTime?: number;
}) {
  const player = Object.create(TypeTypeMsePlayer.prototype) as SeekRecoveryHarness;
  const requests: CreatePlaybackRequest[] = [];
  const failures: Error[] = [];
  const failurePositions: number[] = [];
  let loopRunning = true;
  const buffered = { length: 0 } as TimeRanges;
  player.destroyed = false;
  player.audioOnly = false;
  player.playbackLifecycleActive = true;
  player.loadTask = null;
  player.session = loaded("source");
  player.operation = new PlayerOperation();
  player.playbackRecovery = new PlaybackRecovery(skipRecoveryDelay);
  player.playbackIntent = new PlaybackIntent();
  player.seekController = new SeekController();
  player.bufferedSeekRecovery = new BufferedSeekRecovery(() => () => undefined);
  player.liveEdgeFollower = new LiveEdgeFollower(false);
  player.sessionTransitions = new SessionTransitionQueue();
  player.recoveryPositionMs = Math.round((args.currentTime ?? 44.18) * 1000);
  player.preserveRecoveryPosition = false;
  player.video = {
    paused: false,
    pause: () => {
      player.video.paused = true;
    },
    currentTime: args.currentTime ?? 44.18,
    buffered,
  } as SeekRecoveryHarness["video"];
  player.config = {
    endpoint: "https://beta.typetype.video/api",
    videoId: "3T0ayXcUAhE",
    videoItag: 137,
    audioItag: 140,
    audioTrackId: "en-US.4",
  };
  player.emitter = { emit: () => undefined };
  player.playerState = {
    value: "playing",
    set: (state) => (player.playerState.value = state),
    fail: (error, positionMs) => {
      player.playerState.value = "failed";
      failures.push(error);
      failurePositions.push(positionMs);
    },
  };
  player.deps = {
    loop: {
      stop: () => {
        loopRunning = false;
      },
      quiesce: async () => undefined,
      start: () => {
        loopRunning = true;
      },
      wake: () => undefined,
    },
    media: { requireFreshAttachment: () => undefined },
    playback: {
      seek: args.seek,
      create: async (request, signal) => {
        requests.push(request);
        return args.create(request, signal);
      },
    },
  };
  player.switchSession = async (playback) => {
    const next = loaded(playback.sessionId);
    player.session = next;
    player.preserveRecoveryPosition = false;
    player.playbackRecovery.complete(player.recoveryPositionMs);
    return next;
  };
  return { player, requests, failures, failurePositions, isLoopRunning: () => loopRunning };
}

test("keeps seek pending while a recoverable seek error recovers at the target position", async () => {
  let releaseCreate: ((playback: PlaybackResponse) => void) | null = null;
  const { player, requests, failures } = createHarness({
    seek: async () => {
      throw seekRecoveryError();
    },
    create: async () =>
      new Promise<PlaybackResponse>((resolve) => {
        releaseCreate = resolve;
      }),
  });

  let settled = false;
  const pendingSeek = player.seek(86_399).then(() => {
    settled = true;
  });
  await Bun.sleep(0);

  expect(settled).toBe(false);
  expect(requests.map((request) => request.startTimeMs)).toEqual([86_399]);

  if (!releaseCreate) throw new Error("Expected deferred recovery request");
  releaseCreate(response("fresh-1"));
  await pendingSeek;

  expect(settled).toBe(true);
  expect(player.session?.response.sessionId).toBe("fresh-1");
  expect(failures).toEqual([]);
});

test("aborts pending seek recovery immediately when a newer seek supersedes it", async () => {
  const seekTargets: number[] = [];
  let abortedFirstRecovery = false;
  const { player, failures } = createHarness({
    seek: async (_sessionId, startTimeMs) => {
      seekTargets.push(startTimeMs);
      if (startTimeMs === 86_399) throw seekRecoveryError();
      return response(`seek-${startTimeMs}`);
    },
    create: async (_request, signal) =>
      new Promise<PlaybackResponse>((_resolve, reject) => {
        signal?.addEventListener(
          "abort",
          () => {
            abortedFirstRecovery = true;
            reject(new DOMException("Operation aborted", "AbortError"));
          },
          { once: true },
        );
      }),
  });

  const first = player.seek(86_399);
  await Bun.sleep(0);
  const second = player.seek(120_000);
  await Promise.all([first, second]);

  expect(abortedFirstRecovery).toBe(true);
  expect(seekTargets).toEqual([86_399, 120_000]);
  expect(player.session?.response.sessionId).toBe("seek-120000");
  expect(failures).toEqual([]);
});

test("keeps the requested seek target instead of pre-seek currentTime when seek recovery exhausts", async () => {
  const { player, requests, failures, failurePositions } = createHarness({
    currentTime: 44.18,
    seek: async () => {
      throw seekRecoveryError();
    },
    create: async () => {
      throw seekRecoveryError();
    },
  });

  await player.seek(86_399);

  expect(requests.map((request) => request.startTimeMs)).toEqual([86_399, 86_399]);
  expect(failures).toHaveLength(1);
  expect(failurePositions).toEqual([86_399]);
});

test("preserves a 0ms seek target instead of reverting to pre-seek currentTime on failure", async () => {
  const { player, failures, failurePositions } = createHarness({
    currentTime: 44.18,
    seek: async () => {
      throw seekRecoveryError();
    },
    create: async () => {
      throw seekRecoveryError();
    },
  });

  await player.seek(0);

  expect(failures).toHaveLength(1);
  expect(failurePositions).toEqual([0]);
});

test("restores loop and playback state when a non-user seek hits ignored recovery", async () => {
  const { player, failures, isLoopRunning } = createHarness({
    seek: async () => {
      throw seekRecoveryError();
    },
    create: async () => response("unused"),
  });

  expect(player.playbackRecovery.begin("source")).toBe("recover");
  player.playbackRecovery.finish("source");

  await player.performSeek(86_399, undefined, false, false);

  expect(isLoopRunning()).toBe(true);
  expect(player.playerState.value).toBe("ready");
  expect(player.preserveRecoveryPosition).toBe(false);
  expect(failures).toEqual([]);
});

test("clears preserveRecoveryPosition when a non-recoverable seek error stays on the current session", async () => {
  const { player, failures, failurePositions, isLoopRunning } = createHarness({
    currentTime: 44.18,
    seek: async () => {
      throw new Error("fatal seek failure");
    },
    create: async () => response("unused"),
  });

  await expect(player.seek(86_399)).rejects.toThrow("fatal seek failure");

  expect(isLoopRunning()).toBe(true);
  expect(player.playerState.value).toBe("ready");
  expect(player.preserveRecoveryPosition).toBe(false);

  await player.handlePlaybackLoopError(new Error("fatal loop error"), {
    sessionId: "source",
    signal: player.operation.signal,
  });

  expect(failures).toHaveLength(1);
  expect(failurePositions).toEqual([44_180]);
});

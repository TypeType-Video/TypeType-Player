import { expect, test } from "bun:test";
import { BufferedSeekRecovery } from "../src/buffered-seek-recovery";
import { PlaybackIntent } from "../src/playback-intent";
import { PlayerOperation } from "../src/player-operation";
import { PlaybackRecovery } from "../src/player-recovery";
import { SeekController } from "../src/seek-controller";
import type { LoadedSession } from "../src/session-loader";
import { SessionTransitionQueue } from "../src/session-transition-queue";
import { TypeTypeMsePlayer } from "../src/type-type-mse-player";
import type { TypeTypeMseState } from "../src/types";
import { skipRecoveryDelay } from "./fake-retry-timing";

type AutomaticSeekHarness = {
  destroyed: boolean;
  audioOnly: boolean;
  session: LoadedSession;
  loadTask: Promise<void> | null;
  lifecycleResumeTask: Promise<void> | null;
  playbackLifecycleActive: boolean;
  recoveryPositionMs: number;
  operation: PlayerOperation;
  playbackIntent: PlaybackIntent;
  playbackRecovery: PlaybackRecovery;
  sessionTransitions: SessionTransitionQueue;
  seekController: SeekController;
  bufferedSeekRecovery: BufferedSeekRecovery;
  video: { currentTime: number; paused: boolean; ended: boolean; pause: () => void };
  playerState: { value: TypeTypeMseState; set: (state: TypeTypeMseState) => void };
  emitter: { emit: () => void };
  deps: {
    loop: { start: () => void; stop: () => void; wake: () => void; quiesce: () => Promise<void> };
    media: { requireFreshAttachment: () => void };
    playback: { seek: () => Promise<never> };
  };
  performSeek: (
    positionMs: number,
    quality?: undefined,
    audioOnly?: boolean,
    userInitiated?: boolean,
  ) => Promise<void>;
  syncPlaybackLifecycle: (active: boolean) => void;
};

function harness(): AutomaticSeekHarness {
  const player = Object.create(TypeTypeMsePlayer.prototype) as AutomaticSeekHarness;
  player.destroyed = false;
  player.audioOnly = false;
  player.session = {
    response: { sessionId: "live", videoId: "video", generation: 0, ready: true, retryAfterMs: 0 },
    manifest: {
      durationMs: 0,
      endOfStream: false,
      audio: { kind: "audio", mime: "audio/mp4", initUrl: "/audio/init", segments: [] },
      video: null,
    },
    videoItag: 137,
    audioItag: 140,
    audioTrackId: null,
    audioOnly: false,
  };
  player.loadTask = null;
  player.lifecycleResumeTask = null;
  player.playbackLifecycleActive = false;
  player.recoveryPositionMs = 60_000;
  player.operation = new PlayerOperation();
  player.playbackIntent = new PlaybackIntent();
  player.playbackRecovery = new PlaybackRecovery(skipRecoveryDelay);
  player.sessionTransitions = new SessionTransitionQueue();
  player.seekController = new SeekController();
  player.bufferedSeekRecovery = new BufferedSeekRecovery(() => () => undefined);
  player.video = { currentTime: 0, paused: true, ended: false, pause: () => undefined };
  player.playerState = { value: "ready", set: (state) => (player.playerState.value = state) };
  player.emitter = { emit: () => undefined };
  player.deps = {
    loop: {
      start: () => undefined,
      stop: () => undefined,
      wake: () => undefined,
      quiesce: async () => undefined,
    },
    media: { requireFreshAttachment: () => undefined },
    playback: {
      seek: async () => {
        throw new DOMException("Operation aborted", "AbortError");
      },
    },
  };
  return player;
}

function exhaust(recovery: PlaybackRecovery): void {
  recovery.begin("old");
  recovery.takeAttempt(137);
  recovery.takeAttempt(137);
  recovery.finish("old");
}

test("keeps the fresh session budget across an automatic seek", async () => {
  const player = harness();
  exhaust(player.playbackRecovery);

  await player.performSeek(30_000, undefined, false, false).catch(() => undefined);

  expect(player.playbackRecovery.takeAttempt(137)).toBe(false);
});

test("starts a new fresh session budget for a user seek", async () => {
  const player = harness();
  exhaust(player.playbackRecovery);

  await player.performSeek(30_000).catch(() => undefined);

  expect(player.playbackRecovery.takeAttempt(137)).toBe(true);
});

test("restores a lifecycle position without resetting the recovery budget", async () => {
  const player = harness();
  player.playbackIntent.play();
  exhaust(player.playbackRecovery);

  let seeks = 0;
  player.deps.playback.seek = async () => {
    seeks += 1;
    throw new DOMException("Operation aborted", "AbortError");
  };

  player.syncPlaybackLifecycle(true);
  await player.lifecycleResumeTask;

  expect(seeks).toBe(1);
  expect(player.playbackRecovery.takeAttempt(137)).toBe(false);
});

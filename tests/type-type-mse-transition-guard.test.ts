import { expect, test } from "bun:test";
import { BufferedSeekRecovery } from "../src/buffered-seek-recovery";
import { LiveEdgeFollower } from "../src/live-edge-follower";
import { PlaybackIntent } from "../src/playback-intent";
import { PlaybackRecovery } from "../src/player-recovery";
import type { LoadedSession } from "../src/session-loader";
import { SessionTransitionQueue } from "../src/session-transition-queue";
import { TypeTypeMsePlayer } from "../src/type-type-mse-player";
import type { TypeTypeMseState } from "../src/types";

type GuardHarness = {
  session: LoadedSession;
  loadTask: Promise<void> | null;
  recoveryPositionMs: number;
  playbackIntent: PlaybackIntent;
  playbackRecovery: PlaybackRecovery;
  sessionTransitions: SessionTransitionQueue;
  bufferedSeekRecovery: BufferedSeekRecovery;
  liveEdgeFollower: LiveEdgeFollower;
  video: HTMLVideoElement;
  playerState: { value: TypeTypeMseState; set: (state: TypeTypeMseState) => void };
  deps: { loop: { wake: () => void } };
  emitter: { emit: (event: unknown) => void };
  seekController: { busy: boolean; seek: (positionMs: number) => Promise<void> };
  seek: (positionMs: number) => Promise<void>;
  applyMediaState: (state: TypeTypeMseState) => void;
};

function harness(state: TypeTypeMseState) {
  const backendSeeks: number[] = [];
  const player = Object.create(TypeTypeMsePlayer.prototype) as GuardHarness;
  player.session = {
    response: {
      sessionId: "active",
      videoId: "video",
      generation: 0,
      ready: true,
      retryAfterMs: 0,
    },
    manifest: {
      durationMs: 120_000,
      endOfStream: false,
      audio: { kind: "audio", mime: "audio/mp4", initUrl: "/audio/init", segments: [] },
      video: null,
    },
    videoItag: 299,
    audioItag: 140,
    audioTrackId: null,
    audioOnly: false,
  };
  player.loadTask = null;
  player.recoveryPositionMs = 0;
  player.playbackIntent = new PlaybackIntent();
  player.playbackRecovery = new PlaybackRecovery();
  player.sessionTransitions = new SessionTransitionQueue();
  player.bufferedSeekRecovery = new BufferedSeekRecovery(() => () => undefined);
  player.liveEdgeFollower = new LiveEdgeFollower(false);
  player.video = Object.assign(new EventTarget(), {
    currentTime: 5,
    paused: false,
    seeking: false,
    buffered: { length: 1, start: () => 0, end: () => 30 },
  }) as unknown as HTMLVideoElement;
  player.playerState = { value: state, set: (next) => (player.playerState.value = next) };
  player.deps = { loop: { wake: () => undefined } };
  player.emitter = { emit: () => undefined };
  player.seekController = {
    busy: false,
    seek: async (positionMs) => {
      backendSeeks.push(positionMs);
    },
  };
  return { player, backendSeeks };
}

test("keeps the seeking state while decode preroll emits media events", () => {
  const { player } = harness("seeking");
  player.seekController.busy = true;

  player.applyMediaState("playing");
  player.applyMediaState("buffering");

  expect(player.playerState.value).toBe("seeking");
});

test("applies media events once no transition is running", () => {
  const { player } = harness("ready");

  player.applyMediaState("playing");

  expect(player.playerState.value).toBe("playing");
});

test("serializes a buffered seek behind a running session seek", async () => {
  const { player, backendSeeks } = harness("playing");
  player.seekController.busy = true;

  await player.seek(20_000);

  expect(backendSeeks).toEqual([20_000]);
  expect(player.video.currentTime).toBe(5);
});

test("does not take the local seek path while a fresh session recovery runs", async () => {
  const { player, backendSeeks } = harness("playing");
  player.playbackRecovery.begin("active");

  await player.seek(20_000);

  expect(backendSeeks).toEqual([20_000]);
  expect(player.video.currentTime).toBe(5);
});

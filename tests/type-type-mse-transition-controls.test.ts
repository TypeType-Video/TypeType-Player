import { expect, test } from "bun:test";
import { PlaybackIntent } from "../src/playback-intent";
import { PlayerOperation } from "../src/player-operation";
import type { LoadedSession } from "../src/session-loader";
import { TypeTypeMsePlayer } from "../src/type-type-mse-player";
import type { TypeTypeMseState } from "../src/types";

type TransitionHarness = {
  destroyed: boolean;
  session: LoadedSession;
  pendingPrerollTargetMs: number | null;
  playbackIntent: PlaybackIntent;
  playbackAttempt: PlayerOperation;
  playerState: { value: TypeTypeMseState; set: (state: TypeTypeMseState) => void };
  video: { paused: boolean; pause: () => void; play: () => Promise<void> };
  play: () => Promise<void>;
  pause: () => void;
};

test("queues playback intent while a session seek is in progress", async () => {
  let plays = 0;
  let pauses = 0;
  const player = Object.create(TypeTypeMsePlayer.prototype) as TransitionHarness;
  player.destroyed = false;
  player.session = {} as LoadedSession;
  player.pendingPrerollTargetMs = null;
  player.playbackIntent = new PlaybackIntent();
  player.playbackAttempt = new PlayerOperation();
  player.playerState = {
    value: "seeking",
    set: (state) => (player.playerState.value = state),
  };
  player.video = {
    paused: true,
    pause: () => {
      pauses += 1;
      player.video.paused = true;
    },
    play: async () => {
      plays += 1;
      player.video.paused = false;
    },
  };

  await player.play();

  expect(player.playbackIntent.shouldResume).toBe(true);
  expect(plays).toBe(0);
  expect(player.playerState.value).toBe("seeking");

  player.pause();

  expect(player.playbackIntent.shouldResume).toBe(false);
  expect(pauses).toBe(1);
  expect(player.playerState.value).toBe("seeking");
});

test("cancels a pending browser play when the player is paused", async () => {
  let release = () => undefined;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  let pauses = 0;
  const player = Object.create(TypeTypeMsePlayer.prototype) as TransitionHarness;
  player.destroyed = false;
  player.session = {} as LoadedSession;
  player.pendingPrerollTargetMs = null;
  player.playbackIntent = new PlaybackIntent();
  player.playbackAttempt = new PlayerOperation();
  player.playerState = {
    value: "ready",
    set: (state) => (player.playerState.value = state),
  };
  player.video = {
    paused: true,
    pause: () => {
      pauses += 1;
      player.video.paused = true;
    },
    play: () => pending,
  };

  const playback = player.play();
  player.pause();

  await expect(playback).rejects.toHaveProperty("name", "AbortError");
  release();
  await pending;
  await Promise.resolve();
  expect(player.video.paused).toBe(true);
  expect(pauses).toBe(3);
});

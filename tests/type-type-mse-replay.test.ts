import { expect, test } from "bun:test";
import { PlaybackIntent } from "../src/playback-intent";
import { PlayerOperation } from "../src/player-operation";
import { PlaybackRecovery } from "../src/player-recovery";
import type { LoadedSession } from "../src/session-loader";
import { SessionTransitionQueue } from "../src/session-transition-queue";
import { TypeTypeMsePlayer } from "../src/type-type-mse-player";
import type { TypeTypeMseConfig, TypeTypeMseState } from "../src/types";

type ReplayHarness = {
  destroyed: boolean;
  config: Pick<TypeTypeMseConfig, "isLive">;
  session: LoadedSession;
  pendingPrerollTargetMs: number | null;
  playbackIntent: PlaybackIntent;
  playbackAttempt: PlayerOperation;
  playerState: { value: TypeTypeMseState; set: (state: TypeTypeMseState) => void };
  video: { ended: boolean; paused: boolean; pause: () => void; play: () => Promise<void> };
  loadTask: Promise<void> | null;
  seekController: { busy: boolean };
  sessionTransitions: SessionTransitionQueue;
  playbackRecovery: PlaybackRecovery;
  seek: (positionMs: number) => Promise<void>;
  play: () => Promise<void>;
};

function endedPlayer(isLive: boolean, seeks: number[]): ReplayHarness {
  const player = Object.create(TypeTypeMsePlayer.prototype) as ReplayHarness;
  player.destroyed = false;
  player.config = { isLive };
  player.session = {} as LoadedSession;
  player.pendingPrerollTargetMs = null;
  player.playbackIntent = new PlaybackIntent();
  player.playbackAttempt = new PlayerOperation();
  player.playerState = { value: "ended", set: (state) => (player.playerState.value = state) };
  player.loadTask = null;
  player.seekController = { busy: false };
  player.sessionTransitions = new SessionTransitionQueue();
  player.playbackRecovery = new PlaybackRecovery();
  player.video = {
    ended: true,
    paused: true,
    pause: () => {
      player.video.paused = true;
    },
    play: async () => {
      player.video.paused = false;
    },
  };
  player.seek = async (positionMs) => {
    seeks.push(positionMs);
    player.video.ended = false;
  };
  return player;
}

test("playing an ended video seeks back to the start before playing", async () => {
  const seeks: number[] = [];
  const player = endedPlayer(false, seeks);

  await player.play();

  expect(seeks).toEqual([0]);
  expect(player.video.paused).toBe(false);
  expect(player.playerState.value).toBe("playing");
});

test("an ended live stream is not rewound", async () => {
  const seeks: number[] = [];
  const player = endedPlayer(true, seeks);

  await player.play();

  expect(seeks).toEqual([]);
});

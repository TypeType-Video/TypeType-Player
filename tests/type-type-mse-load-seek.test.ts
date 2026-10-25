import { expect, test } from "bun:test";
import type { CreatePlaybackRequest } from "../src/playback-client";
import type { LoadedSession } from "../src/session-loader";
import { harness, response } from "./type-type-mse-recovery-harness";

type LoadSeekHarness = {
  session: LoadedSession | null;
  loadTask: Promise<void> | null;
  loadInitialSession: () => Promise<void>;
  load: () => Promise<void>;
  seek: (positionMs: number) => Promise<void>;
  seekController: { busy: boolean; seek: (positionMs: number) => Promise<void> };
  bufferedSeekRecovery: { cancel: () => void };
  liveEdgeFollower: { observeUserSeek: () => void };
  video: { paused: boolean; currentTime: number; buffered: TimeRanges };
};

function loadingPlayer() {
  const base = harness(async () => response("initial"));
  const player = base.player as unknown as LoadSeekHarness;
  const loadedSession = player.session;
  const backendSeeks: number[] = [];
  let finishLoad: () => void = () => undefined;
  player.session = null;
  player.loadInitialSession = () =>
    new Promise<void>((resolve) => {
      finishLoad = () => {
        player.session = loadedSession;
        resolve();
      };
    });
  player.seekController = {
    busy: false,
    seek: async (positionMs) => {
      backendSeeks.push(positionMs);
    },
  };
  player.bufferedSeekRecovery = { cancel: () => undefined };
  player.liveEdgeFollower = { observeUserSeek: () => undefined };
  player.video.buffered = { length: 0, start: () => 0, end: () => 0 } as unknown as TimeRanges;
  return { player, backendSeeks, finishLoad: () => finishLoad(), requests: base.requests };
}

test("applies a seek requested while the initial session is loading", async () => {
  const { player, backendSeeks, finishLoad } = loadingPlayer();
  const load = player.load();

  const seek = player.seek(754_000);
  await Bun.sleep(0);
  expect(backendSeeks).toEqual([]);
  finishLoad();
  await load;
  await seek;

  expect(backendSeeks).toEqual([754_000]);
});

test("applies only the latest seek requested during loading", async () => {
  const { player, backendSeeks, finishLoad } = loadingPlayer();
  const load = player.load();

  const first = player.seek(100_000);
  const second = player.seek(200_000);
  finishLoad();
  await load;
  await Promise.all([first, second]);

  expect(backendSeeks).toEqual([200_000]);
});

test("starts the initial session at a seek requested before load", async () => {
  const base = harness(async () => response("initial"));
  const player = base.player as unknown as LoadSeekHarness;
  const requests: CreatePlaybackRequest[] = base.requests;
  player.session = null;

  await player.seek(321_000);
  await player.load();

  expect(requests.map((request) => request.startTimeMs)).toEqual([321_000]);
});

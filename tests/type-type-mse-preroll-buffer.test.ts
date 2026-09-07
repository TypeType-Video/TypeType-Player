import { expect, test } from "bun:test";
import { TransientMediaState } from "../src/transient-media-state";
import { TypeTypeMsePlayer } from "../src/type-type-mse-player";

type PrerollHarness = {
  video: HTMLVideoElement;
  transientMediaState: TransientMediaState;
  deps: { loop: { fillOnce: () => Promise<void> } };
  runDecodePreroll: (
    targetMs: number,
    resume: boolean,
    signal: AbortSignal,
    requireFrame?: boolean,
  ) => Promise<void>;
};

function harness(fillOnce: () => Promise<void>) {
  const player = Object.create(TypeTypeMsePlayer.prototype) as PrerollHarness;
  const calls: string[] = [];
  let time = 11.4;
  const video = {
    autoplay: false,
    defaultPlaybackRate: 1,
    playbackRate: 1,
    muted: false,
    paused: true,
    readyState: 4,
    seeking: false,
    error: null,
    buffered: { length: 1, start: () => 11.4, end: () => 23 },
    get currentTime() {
      return time;
    },
    set currentTime(value: number) {
      calls.push("snap");
      time = value;
    },
    play: async () => {
      calls.push("decode");
      time = 13.45;
      video.paused = false;
    },
    pause: () => {
      video.paused = true;
    },
  };
  player.video = video as HTMLVideoElement;
  player.transientMediaState = new TransientMediaState(player.video);
  player.deps = { loop: { fillOnce } };
  return { player, calls, video };
}

test("fills the paused session before decoding and snapping its target", async () => {
  let release = () => {};
  const fill = new Promise<void>((resolve) => {
    release = resolve;
  });
  const { player, calls, video } = harness(() => fill);
  const pending = player.runDecodePreroll(13_430, false, new AbortController().signal, true);
  await Promise.resolve();
  expect(calls).toEqual([]);
  expect(video.paused).toBe(true);
  expect(video.playbackRate).toBe(1);
  release();
  await pending;
  expect(calls).toEqual(["decode", "snap"]);
  expect(video.currentTime).toBe(13.43);
  expect(video.paused).toBe(true);
  expect(video.playbackRate).toBe(1);
  expect(video.muted).toBe(false);
});

test("does not start decoding when filling the session fails", async () => {
  const failure = new Error("segment unavailable");
  const { player, calls } = harness(() => Promise.reject(failure));
  await expect(
    player.runDecodePreroll(13_430, false, new AbortController().signal, true),
  ).rejects.toBe(failure);
  expect(calls).toEqual([]);
});

test("does not decode a superseded seek after its fill completes", async () => {
  const controller = new AbortController();
  const { player, calls, video } = harness(async () => controller.abort());
  await expect(
    player.runDecodePreroll(13_430, false, controller.signal, true),
  ).rejects.toMatchObject({
    name: "AbortError",
  });
  expect(calls).toEqual([]);
  expect(video.currentTime).toBe(11.4);
  expect(video.paused).toBe(true);
});

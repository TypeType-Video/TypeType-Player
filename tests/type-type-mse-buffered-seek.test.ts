import { expect, test } from "bun:test";
import { BufferedSeekRecovery } from "../src/buffered-seek-recovery";
import { LiveEdgeFollower } from "../src/live-edge-follower";
import { PlaybackIntent } from "../src/playback-intent";
import type { LoadedSession } from "../src/session-loader";
import { TypeTypeMsePlayer } from "../src/type-type-mse-player";
import type { TypeTypeMseState } from "../src/types";

type BufferedSeekHarness = {
  session: LoadedSession;
  recoveryPositionMs: number;
  playbackIntent: PlaybackIntent;
  bufferedSeekRecovery: BufferedSeekRecovery;
  liveEdgeFollower: LiveEdgeFollower;
  video: HTMLVideoElement;
  playerState: { value: TypeTypeMseState };
  deps: { loop: { wake: () => void } };
  emitter: { emit: (event: unknown) => void };
  seekController: { seek: () => Promise<void> };
  seek: (positionMs: number) => Promise<void>;
};

test("uses existing MSE media for buffered seeks without replacing the SABR session", async () => {
  let wakes = 0;
  let backendSeeks = 0;
  let events = 0;
  const player = harness(
    () => {
      wakes += 1;
    },
    () => {
      backendSeeks += 1;
      return Promise.resolve();
    },
    () => {
      events += 1;
    },
  );

  const transition = player.seek(20_000);
  player.video.seeking = false;
  player.video.dispatchEvent(new Event("seeked"));
  await transition;

  expect(player.video.currentTime).toBe(20);
  expect(player.recoveryPositionMs).toBe(20_000);
  expect(wakes).toBe(1);
  expect(backendSeeks).toBe(0);
  expect(events).toBe(1);
});

test("keeps the server seek path when the target is outside buffered media", async () => {
  let backendSeeks = 0;
  const player = harness(
    () => undefined,
    () => {
      backendSeeks += 1;
      return Promise.resolve();
    },
    () => undefined,
  );

  await player.seek(45_000);

  expect(player.video.currentTime).toBe(5);
  expect(backendSeeks).toBe(1);
});

function harness(
  wake: () => void,
  backendSeek: () => Promise<void>,
  emit: (event: unknown) => void,
): BufferedSeekHarness {
  const player = Object.create(TypeTypeMsePlayer.prototype) as BufferedSeekHarness;
  player.session = session();
  player.recoveryPositionMs = 0;
  player.playbackIntent = new PlaybackIntent();
  player.bufferedSeekRecovery = new BufferedSeekRecovery((callback) => {
    let active = true;
    queueMicrotask(() => {
      if (active) callback();
    });
    return () => {
      active = false;
    };
  });
  player.liveEdgeFollower = new LiveEdgeFollower(false);
  player.video = media([[0, 30]], 5);
  player.playerState = { value: "playing" };
  player.deps = { loop: { wake } };
  player.emitter = { emit };
  player.seekController = { seek: backendSeek };
  return player;
}

function media(ranges: Array<[number, number]>, currentTime: number): HTMLVideoElement {
  return Object.assign(new EventTarget(), {
    currentTime,
    paused: false,
    seeking: true,
    buffered: {
      length: ranges.length,
      start: (index: number) => ranges[index]?.[0] ?? 0,
      end: (index: number) => ranges[index]?.[1] ?? 0,
    },
  }) as HTMLVideoElement;
}

function session(): LoadedSession {
  return {
    response: { sessionId: "active", videoId: "video", generation: 0, ready: true },
    manifest: {
      durationMs: 120_000,
      endOfStream: false,
      audio: { kind: "audio", mime: "audio/mp4", initUrl: "/audio/init", segments: [] },
    },
    videoItag: 299,
    audioItag: 140,
    audioTrackId: null,
  };
}

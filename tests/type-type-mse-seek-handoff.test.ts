import { expect, test } from "bun:test";
import { LiveEdgeFollower } from "../src/live-edge-follower";
import type { PlaybackManifest } from "../src/manifest";
import type { PlaybackResponse } from "../src/playback-client";
import { PlaybackIntent } from "../src/playback-intent";
import type { PlaybackWindow, PlaybackWindowRequest } from "../src/playback-window";
import { PlayerOperation } from "../src/player-operation";
import { PlaybackRecovery } from "../src/player-recovery";
import type { LoadedSession } from "../src/session-loader";
import { TransientMediaState } from "../src/transient-media-state";
import { TypeTypeMsePlayer } from "../src/type-type-mse-player";
import { skipRecoveryDelay } from "./fake-retry-timing";

Object.defineProperty(globalThis, "MediaSource", {
  value: { isTypeSupported: () => true },
  configurable: true,
});

const manifest: PlaybackManifest = {
  durationMs: 120_000,
  endOfStream: false,
  audio: {
    kind: "audio",
    mime: 'audio/mp4; codecs="mp4a.40.2"',
    initUrl: "/audio/init",
    segments: [{ url: "/audio/2", startMs: 20_000, durationMs: 10_000 }],
  },
  video: {
    kind: "video",
    mime: 'video/mp4; codecs="avc1.640028"',
    initUrl: "/video/init",
    segments: [{ url: "/video/4", startMs: 19_000, durationMs: 6_000 }],
  },
};

type SeekHandoffHarness = {
  activateSession: (
    response: PlaybackResponse,
    startTimeMs: number,
    revision: number,
    signal: AbortSignal,
    quality: undefined,
    audioOnly: boolean,
    finalizePausedSeek: boolean,
    allowWindowRecovery: boolean,
  ) => Promise<LoadedSession>;
  operation: PlayerOperation;
  playbackIntent: PlaybackIntent;
};

type MediaFrame = { at: string; currentTime: number; muted: boolean; opacity: string };

test("keeps a reattached WebKit seek from autoplaying before its decode preroll", async () => {
  const { player, video, autoplayed } = harness(true);

  await activate(player);

  expect(autoplayed).toEqual([]);
  expect(video.autoplay).toBe(true);
});

test("hides the decode start frame until a playing seek reaches its target", async () => {
  const { player, video, frames } = harness(true);

  await activate(player);

  expect(frames).toEqual([
    { at: "decode-start", currentTime: 20, muted: true, opacity: "0" },
    { at: "play", currentTime: 20, muted: true, opacity: "0" },
  ]);
  expect(video.muted).toBe(false);
  expect(video.style.opacity).toBe("1");
  expect(video.playbackRate).toBe(1);
  expect(video.paused).toBe(false);
});

test("hides the decode start frame of a paused seek and shows its exact target", async () => {
  const { player, video, frames } = harness(false);

  await activate(player);

  expect(frames[0]).toEqual({ at: "decode-start", currentTime: 20, muted: true, opacity: "0" });
  expect(video.currentTime).toBe(22);
  expect(video.paused).toBe(true);
  expect(video.muted).toBe(false);
  expect(video.style.opacity).toBe("1");
  expect(video.autoplay).toBe(false);
});

async function activate(player: SeekHandoffHarness): Promise<void> {
  const revision = player.operation.next();
  await player.activateSession(
    response(),
    22_000,
    revision,
    player.operation.signal,
    undefined,
    false,
    true,
    false,
  );
}

function harness(playing: boolean) {
  const player = Object.create(TypeTypeMsePlayer.prototype) as SeekHandoffHarness &
    Record<string, unknown>;
  const frames: MediaFrame[] = [];
  const autoplayed: number[] = [];
  let currentTime = 41;
  const video = {
    autoplay: playing,
    defaultPlaybackRate: 1,
    playbackRate: 1,
    muted: false,
    paused: true,
    seeking: false,
    readyState: 4,
    error: null,
    style: { opacity: "1" },
    buffered: { length: 1, start: () => 19, end: () => 30 },
    get currentTime() {
      return currentTime;
    },
    set currentTime(value: number) {
      currentTime = value;
      const at = value === 20 ? "decode-start" : value === 22 ? "target" : `${value}`;
      frames.push({ at, currentTime: value, muted: video.muted, opacity: video.style.opacity });
    },
    play: async () => {
      frames.push({ at: "play", currentTime, muted: video.muted, opacity: video.style.opacity });
      if (currentTime < 22) currentTime = 22;
      video.paused = false;
    },
    pause: () => {
      video.paused = true;
    },
  };
  const intent = new PlaybackIntent();
  if (playing) intent.play();
  Object.assign(player, {
    destroyed: false,
    session: { response: { sessionId: "source" }, manifest, audioOnly: false },
    operation: new PlayerOperation(),
    playbackRecovery: new PlaybackRecovery(skipRecoveryDelay),
    playbackIntent: intent,
    transientMediaState: new TransientMediaState(video as unknown as HTMLVideoElement),
    liveEdgeFollower: new LiveEdgeFollower(false),
    bufferKeepingRevision: null,
    playbackLifecycleActive: false,
    pendingPrerollTargetMs: null,
    audioOnly: false,
    video,
    config: {
      endpoint: "https://beta.typetype.video/api",
      videoId: "seek-video",
      videoItag: 137,
      audioItag: 140,
      audioTrackId: null,
    },
    emitter: { emit: () => undefined },
    playerState: { set: () => undefined },
    deps: {
      loop: {
        stop: () => undefined,
        quiesce: async () => undefined,
        fillOnce: async () => undefined,
      },
      playback: {
        create: async () => response(),
        position: async (sessionId: string, request: PlaybackWindowRequest) =>
          window(sessionId, request, false),
        prefetch: async (sessionId: string, request: PlaybackWindowRequest) =>
          window(sessionId, request, true),
        segments: async (sessionId: string, request: PlaybackWindowRequest) => ({
          ...window(sessionId, request, true),
          startTimeMs: 22_000,
          manifest,
        }),
      },
      media: {
        attach: async () => {
          if (video.autoplay && video.paused) {
            autoplayed.push(currentTime);
            video.paused = false;
          }
        },
        bufferedRanges: () => [],
      },
      scheduler: {
        reset: () => undefined,
        appendInit: async () => undefined,
        fill: async () => undefined,
      },
      policy: {
        bufferGoalMs: 30_000,
        backBufferMs: 30_000,
        pollIntervalMs: 500,
        manifestRefreshMs: 8_000,
        manifestPollLimit: 2,
        segmentPollLimit: 2,
      },
    },
  });
  return { player: player as SeekHandoffHarness, video, frames, autoplayed };
}

function response(): PlaybackResponse {
  return {
    sessionId: "replacement",
    videoId: "seek-video",
    generation: 0,
    startTimeMs: 22_000,
    ready: false,
    retryAfterMs: null,
  };
}

function window(sessionId: string, request: PlaybackWindowRequest, ready: boolean): PlaybackWindow {
  return {
    sessionId,
    generation: request.generation,
    ready,
    retryAfterMs: null,
    terminalError: null,
    recoveryAction: null,
    retryVideoItags: [],
    manifest: ready ? manifest : null,
  };
}

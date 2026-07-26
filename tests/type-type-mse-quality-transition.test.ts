import { expect, test } from "bun:test";
import { BufferedSeekRecovery } from "../src/buffered-seek-recovery";
import type { PlaybackResponse } from "../src/playback-client";
import { PlaybackIntent } from "../src/playback-intent";
import { PlayerOperation } from "../src/player-operation";
import { PlaybackRecovery } from "../src/player-recovery";
import { SeekController } from "../src/seek-controller";
import type { LoadedSession } from "../src/session-loader";
import { TypeTypeMsePlayer } from "../src/type-type-mse-player";
import type { TypeTypeMseQuality, TypeTypeMseState } from "../src/types";

type QualityHarness = {
  destroyed: boolean;
  session: LoadedSession;
  operation: PlayerOperation;
  playbackRecovery: PlaybackRecovery;
  bufferedSeekRecovery: BufferedSeekRecovery;
  playbackIntent: PlaybackIntent;
  seekController: SeekController;
  video: { currentTime: number; paused: boolean };
  playerState: { value: TypeTypeMseState; set: (state: TypeTypeMseState) => void };
  deps: {
    loop: { stop: () => void; start: () => void };
    playback: {
      seek: (
        sessionId: string,
        positionMs: number,
        quality: TypeTypeMseQuality,
        signal: AbortSignal,
      ) => Promise<PlaybackResponse>;
    };
  };
  emitter: { emit: () => void };
  resetPlaybackRecovery: () => void;
  switchSession: (...args: unknown[]) => Promise<LoadedSession>;
  performSeek: (positionMs: number, quality?: TypeTypeMseQuality) => Promise<void>;
  setQuality: (quality: TypeTypeMseQuality) => Promise<void>;
};

const quality = { videoItag: 248, audioItag: 140, audioTrackId: null };

test("keeps the active playback loop running while a quality session is prepared", async () => {
  let release: ((response: PlaybackResponse) => void) | null = null;
  let stops = 0;
  const pending = new Promise<PlaybackResponse>((resolve) => (release = resolve));
  const player = harness(
    () => pending,
    () => (stops += 1),
  );

  const transition = player.performSeek(120_000, quality);
  await Bun.sleep(0);
  expect(stops).toBe(0);
  if (!release) throw new Error("Deferred seek response was not initialized");
  release(response());
  await transition;

  expect(stops).toBe(0);
});

test("stops the active playback loop before a timeline seek", async () => {
  let stops = 0;
  const player = harness(
    async () => response(),
    () => (stops += 1),
  );

  await player.performSeek(120_000);

  expect(stops).toBe(1);
});

test("aborts an obsolete quality preparation and applies only the latest selection", async () => {
  const requested: number[] = [];
  let aborted = 0;
  const latest = { videoItag: 399, audioItag: 251, audioTrackId: "fr-FR.4" };
  const player = harness(
    async (_sessionId, _positionMs, selection, signal) => {
      requested.push(selection.videoItag);
      if (selection.videoItag === latest.videoItag) return response(latest);
      return new Promise<PlaybackResponse>((_resolve, reject) => {
        signal.addEventListener(
          "abort",
          () => {
            aborted += 1;
            reject(new DOMException("Operation aborted", "AbortError"));
          },
          { once: true },
        );
      });
    },
    () => undefined,
  );

  const transition = player.setQuality(quality);
  await Bun.sleep(0);
  const latestTransition = player.setQuality(latest);
  await Promise.all([transition, latestTransition]);

  expect(requested).toEqual([quality.videoItag, latest.videoItag]);
  expect(aborted).toBe(1);
});

function harness(
  seek: QualityHarness["deps"]["playback"]["seek"],
  stop: () => void,
): QualityHarness {
  const player = Object.create(TypeTypeMsePlayer.prototype) as QualityHarness;
  player.destroyed = false;
  player.session = session();
  player.operation = new PlayerOperation();
  player.playbackRecovery = new PlaybackRecovery();
  player.bufferedSeekRecovery = new BufferedSeekRecovery(() => () => undefined);
  player.playbackIntent = new PlaybackIntent();
  player.seekController = new SeekController();
  player.video = { currentTime: 120, paused: false };
  player.playerState = {
    value: "playing",
    set: (state) => (player.playerState.value = state),
  };
  player.deps = { loop: { stop, start: () => undefined }, playback: { seek } };
  player.emitter = { emit: () => undefined };
  player.resetPlaybackRecovery = () => undefined;
  player.switchSession = async () => player.session;
  return player;
}

function response(selection: TypeTypeMseQuality = quality): PlaybackResponse {
  return {
    sessionId: "replacement",
    videoId: "video",
    videoItag: selection.videoItag,
    audioItag: selection.audioItag,
    audioTrackId: selection.audioTrackId,
    generation: 1,
    ready: false,
    retryAfterMs: 250,
  };
}

function session(): LoadedSession {
  return {
    response: { ...response(), sessionId: "source", generation: 0 },
    manifest: {
      durationMs: 0,
      endOfStream: false,
      audio: { kind: "audio", mime: "audio/mp4", initUrl: "/audio/init", segments: [] },
    },
    videoItag: 137,
    audioItag: 140,
    audioTrackId: null,
    audioOnly: false,
  };
}

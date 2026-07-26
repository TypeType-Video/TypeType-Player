import { expect, test } from "bun:test";
import type { PlaybackManifest } from "../src/manifest";
import { PlaybackIntent } from "../src/playback-intent";
import type { LoadedSession } from "../src/session-loader";
import { TypeTypeMsePlayer } from "../src/type-type-mse-player";
import type { TypeTypeMseState } from "../src/types";

type LifecycleHarness = {
  destroyed: boolean;
  session: LoadedSession | null;
  playbackLifecycleActive: boolean;
  lifecycleResumeTask: Promise<void> | null;
  playbackIntent: PlaybackIntent;
  video: { paused: boolean; play: () => Promise<void> };
  deps: {
    loop: {
      start: () => void;
      stop: () => void;
      wake: () => void;
    };
  };
  playerState: {
    value: TypeTypeMseState;
    set: (state: TypeTypeMseState) => void;
  };
  syncPlaybackLifecycle: (active: boolean) => void;
  reportPlaybackFailure: (error: Error) => void;
};

const manifest: PlaybackManifest = {
  durationMs: 60_000,
  endOfStream: false,
  audio: { kind: "audio", mime: "audio/mp4", initUrl: "/audio/init", segments: [] },
  video: { kind: "video", mime: "video/mp4", initUrl: "/video/init", segments: [] },
};

function session(): LoadedSession {
  return {
    response: {
      sessionId: "session",
      videoId: "video",
      generation: 0,
      ready: true,
      retryAfterMs: null,
    },
    manifest,
    videoItag: 137,
    audioItag: 140,
    audioTrackId: null,
    audioOnly: false,
  };
}

function harness(play: () => Promise<void>, shouldResume: boolean) {
  const player = Object.create(TypeTypeMsePlayer.prototype) as LifecycleHarness;
  const calls = { play: 0, start: 0, stop: 0, wake: 0 };
  const failures: Error[] = [];
  player.destroyed = false;
  player.session = session();
  player.playbackLifecycleActive = false;
  player.lifecycleResumeTask = null;
  player.playbackIntent = new PlaybackIntent();
  if (shouldResume) player.playbackIntent.play();
  player.video = {
    paused: true,
    play: async () => {
      calls.play += 1;
      await play();
      player.video.paused = false;
    },
  };
  player.deps = {
    loop: {
      start: () => {
        calls.start += 1;
      },
      stop: () => {
        calls.stop += 1;
      },
      wake: () => {
        calls.wake += 1;
      },
    },
  };
  player.playerState = {
    value: "ready",
    set: (state) => {
      player.playerState.value = state;
    },
  };
  player.reportPlaybackFailure = (error) => failures.push(error);
  return { calls, failures, player };
}

test("resumes playback interrupted by a lifecycle transition", async () => {
  const { calls, failures, player } = harness(async () => undefined, true);

  player.syncPlaybackLifecycle(true);
  await player.lifecycleResumeTask;

  expect(calls).toEqual({ play: 1, start: 1, stop: 0, wake: 2 });
  expect(player.playerState.value).toBe("playing");
  expect(failures).toEqual([]);
});

test("does not override an explicit user pause", () => {
  const { calls, player } = harness(async () => undefined, false);

  player.syncPlaybackLifecycle(true);

  expect(calls).toEqual({ play: 0, start: 1, stop: 0, wake: 1 });
  expect(player.lifecycleResumeTask).toBeNull();
  expect(player.playerState.value).toBe("ready");
});

test("deduplicates lifecycle resume attempts while play is pending", async () => {
  let release = () => undefined;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const { calls, player } = harness(() => pending, true);

  player.syncPlaybackLifecycle(true);
  player.syncPlaybackLifecycle(true);
  expect(calls.play).toBe(1);
  release();
  await player.lifecycleResumeTask;

  expect(calls.play).toBe(1);
  expect(calls.start).toBe(1);
});

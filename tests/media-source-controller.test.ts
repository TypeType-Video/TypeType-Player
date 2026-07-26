import { expect, test } from "bun:test";
import type { PlaybackManifest } from "../src/manifest";
import { MediaSourceController } from "../src/media-source-controller";

type ControllerState = {
  objectUrl: string | null;
  mediaSource: MediaSource | null;
  audioMime: string | null;
  videoMime: string | null;
};

const audio = {
  kind: "audio" as const,
  mime: 'audio/mp4; codecs="mp4a.40.2"',
  initUrl: "/audio/init",
  segments: [],
};

function manifest(video: boolean): PlaybackManifest {
  return {
    durationMs: 120_000,
    endOfStream: false,
    audio,
    video: video
      ? {
          kind: "video",
          mime: 'video/mp4; codecs="avc1.640028"',
          initUrl: "/video/init",
          segments: [],
        }
      : null,
  };
}

function videoElement(src: string) {
  const calls: string[] = [];
  return {
    calls,
    video: {
      src,
      removeAttribute: (name: string) => calls.push(`remove:${name}`),
      load: () => calls.push("load"),
    } as unknown as HTMLVideoElement,
  };
}

test("detach releases the media source owned by the controller", () => {
  const { calls, video } = videoElement("blob:owned");
  const controller = new MediaSourceController(video);
  (controller as unknown as ControllerState).objectUrl = "blob:owned";

  controller.detach();

  expect(calls).toEqual(["remove:src", "load"]);
});

test("stale controller cannot detach a replacement media source", () => {
  const { calls, video } = videoElement("blob:replacement");
  const controller = new MediaSourceController(video);
  (controller as unknown as ControllerState).objectUrl = "blob:stale";

  controller.detach();

  expect(calls).toEqual([]);
  expect(video.src).toBe("blob:replacement");
});

test("attach reuses source buffers when the track layout is compatible", async () => {
  const mediaSource = new FakeMediaSource();
  mediaSource.addSourceBuffer();
  mediaSource.addSourceBuffer();
  const firstBuffers = [...mediaSource.sourceBuffers];
  const video = {
    src: "blob:stable",
    removeAttribute: () => undefined,
    load: () => undefined,
  } as unknown as HTMLVideoElement;
  const controller = new MediaSourceController(video);
  const state = controller as unknown as ControllerState;
  state.objectUrl = "blob:stable";
  state.mediaSource = mediaSource as unknown as MediaSource;
  state.audioMime = manifest(true).audio.mime;
  state.videoMime = manifest(true).video?.mime ?? null;

  await controller.attach(manifest(true));

  expect(video.src).toBe("blob:stable");
  expect(mediaSource.removed).toEqual([]);
  expect(mediaSource.sourceBuffers).toEqual(firstBuffers);
});

test("attach releases each old layout before repeated track changes", async () => {
  const current = new FakeMediaSource();
  current.addSourceBuffer();
  current.addSourceBuffer();
  const replacements: FakeMediaSource[] = [];
  const { video } = videoElement("blob:stable");
  const controller = new MediaSourceController(video, {
    create: () => {
      const mediaSource = new FakeMediaSource("closed");
      replacements.push(mediaSource);
      queueMicrotask(() => mediaSource.open());
      return {
        managed: false,
        mediaSource: mediaSource as unknown as MediaSource,
      };
    },
    createObjectUrl: () => `blob:replacement-${replacements.length}`,
    revokeObjectUrl: () => undefined,
  });
  const state = controller as unknown as ControllerState;
  state.objectUrl = "blob:stable";
  state.mediaSource = current as unknown as MediaSource;
  state.audioMime = manifest(true).audio.mime;
  state.videoMime = manifest(true).video?.mime ?? null;

  for (let index = 0; index < 6; index += 1) {
    await controller.attach(manifest(index % 2 !== 0));
  }

  expect(replacements).toHaveLength(6);
  expect(current.removed).toHaveLength(2);
  for (const replacement of replacements.slice(0, -1)) {
    expect(replacement.removed.length).toBeGreaterThan(0);
  }
  expect(video.src).toBe("blob:replacement-6");
});

test("ManagedMediaSource disables remote playback only while attached", async () => {
  const mediaSource = new FakeMediaSource("closed");
  const { video } = videoElement("");
  video.disableRemotePlayback = false;
  const controller = new MediaSourceController(video, {
    create: () => {
      queueMicrotask(() => mediaSource.open());
      return {
        managed: true,
        mediaSource: mediaSource as unknown as MediaSource,
      };
    },
    createObjectUrl: () => "blob:managed",
    revokeObjectUrl: () => undefined,
  });

  await controller.attach(manifest(true));
  expect(video.disableRemotePlayback).toBe(true);

  controller.detach();
  expect(video.disableRemotePlayback).toBe(false);
});

test("updates the MSE live seekable range as the live head advances", () => {
  const mediaSource = new FakeMediaSource();
  const { video } = videoElement("blob:live");
  const controller = new MediaSourceController(video);
  const state = controller as unknown as ControllerState;
  state.objectUrl = "blob:live";
  state.mediaSource = mediaSource as unknown as MediaSource;
  const liveManifest: PlaybackManifest = {
    ...manifest(true),
    live: {
      active: true,
      postLiveDvr: false,
      headSequence: 72,
      headTimeMs: 120_000,
      seekableStartMs: 30_000,
      seekableEndMs: 120_000,
      atLiveEdge: true,
      targetLatencyMs: 10_000,
    },
  };

  controller.updateTiming(liveManifest);
  controller.updateTiming(liveManifest);
  expect(mediaSource.duration).toBe(Number.POSITIVE_INFINITY);
  expect(mediaSource.liveRange).toEqual([30, 120]);
  expect(mediaSource.durationWrites).toBe(1);
  expect(mediaSource.liveRangeWrites).toBe(1);

  controller.updateTiming({
    ...liveManifest,
    live: { ...liveManifest.live, seekableEndMs: 125_000 },
  });
  expect(mediaSource.liveRange).toEqual([30, 125]);
  expect(mediaSource.liveRangeWrites).toBe(2);

  controller.updateTiming({ ...liveManifest, live: { ...liveManifest.live, active: false } });
  expect(mediaSource.liveRange).toBeNull();
  expect(mediaSource.duration).toBe(120);
  expect(mediaSource.liveRangeClears).toBe(1);
  expect(mediaSource.durationWrites).toBe(2);

  controller.updateTiming(manifest(true));
  expect(mediaSource.liveRangeClears).toBe(1);
  expect(mediaSource.durationWrites).toBe(2);
});

class FakeMediaSource {
  readonly sourceBuffers: SourceBuffer[] = [];
  readonly removed: SourceBuffer[] = [];
  durationWrites = 0;
  liveRangeWrites = 0;
  liveRangeClears = 0;
  liveRange: [number, number] | null = null;
  readyState: ReadyState;
  private readonly listeners = new Map<string, () => void>();
  private currentDuration = Number.NaN;

  constructor(readyState: ReadyState = "open") {
    this.readyState = readyState;
  }

  addEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
    if (typeof listener === "function") this.listeners.set(type, listener as () => void);
  }

  addSourceBuffer(): SourceBuffer {
    const buffer = {
      updating: false,
      buffered: { length: 0 },
      abort: () => undefined,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    } as unknown as SourceBuffer;
    this.sourceBuffers.push(buffer);
    return buffer;
  }

  removeSourceBuffer(buffer: SourceBuffer): void {
    this.removed.push(buffer);
    this.sourceBuffers.splice(this.sourceBuffers.indexOf(buffer), 1);
  }

  setLiveSeekableRange(start: number, end: number): void {
    this.liveRangeWrites += 1;
    this.liveRange = [start, end];
  }

  clearLiveSeekableRange(): void {
    this.liveRangeClears += 1;
    this.liveRange = null;
  }

  get duration(): number {
    return this.currentDuration;
  }

  set duration(value: number) {
    this.durationWrites += 1;
    this.currentDuration = value;
  }

  open(): void {
    this.readyState = "open";
    this.listeners.get("sourceopen")?.();
  }
}

import { expect, test } from "bun:test";
import type { EventEmitter } from "../src/event-emitter";
import type { HttpClient, HttpExchange } from "../src/http-client";
import type { PlaybackManifest } from "../src/manifest";
import type { MediaBufferedRange, MediaSourceController } from "../src/media-source-controller";
import { SegmentScheduler } from "../src/segment-scheduler";

const track = {
  kind: "audio" as const,
  mime: 'audio/mp4; codecs="mp4a.40.2"',
  initUrl: "/audio/init",
  segments: [],
};

function manifest(segments: PlaybackManifest["audio"]["segments"]): PlaybackManifest {
  return {
    durationMs: 500_000,
    endOfStream: false,
    audio: { ...track, segments },
    video: null,
  };
}

test("never appends a late segment behind the buffered track edge", async () => {
  const appended: string[] = [];
  const buffered: MediaBufferedRange[] = [];
  const http = {
    once: async (url: string) => encodedExchange(url),
  } as unknown as HttpClient;
  const segment40 = { url: "/40", startMs: 389_398, durationMs: 9_985 };
  const segment41 = { url: "/41", startMs: 399_383, durationMs: 9_985 };
  const segment42 = { url: "/42", startMs: 409_367, durationMs: 9_985 };
  const segment43 = { url: "/43", startMs: 419_352, durationMs: 9_985 };
  const segmentsByUrl = new Map(
    [segment40, segment41, segment42, segment43].map((segment) => [segment.url, segment]),
  );
  const media = {
    append: async (kind: "audio" | "video", bytes: ArrayBuffer) => {
      const url = new TextDecoder().decode(bytes);
      appended.push(url);
      const segment = segmentsByUrl.get(url);
      if (segment) {
        buffered.push({
          kind,
          startMs: segment.startMs,
          endMs: segment.startMs + segment.durationMs,
        });
      }
    },
    bufferedRanges: () => buffered,
  } as MediaSourceController;
  const scheduler = new SegmentScheduler(http, media, { emit: () => undefined } as EventEmitter, 1);
  await scheduler.fill(manifest([segment43, segment41, segment42]), 401_200, 430_000);
  await scheduler.fill(manifest([segment40, segment41, segment42, segment43]), 399_383, 430_000);

  expect(appended).toEqual(["/41", "/42", "/43"]);
});

test("appends a self-initializing live segment only once", async () => {
  const requested: string[] = [];
  let requestedUrl = "";
  const http = {
    once: async (url: string) => {
      requestedUrl = url;
      requested.push(url);
      return segmentExchange();
    },
  } as unknown as HttpClient;
  const appended: string[] = [];
  const buffered: MediaBufferedRange[] = [];
  const media = {
    append: async (kind: "audio" | "video") => {
      appended.push(requestedUrl);
      const startMs = requestedUrl === "/40" ? 390_000 : 400_000;
      buffered.push({ kind, startMs, endMs: startMs + 10_000 });
    },
    bufferedRanges: () => buffered,
  } as MediaSourceController;
  const scheduler = new SegmentScheduler(http, media, { emit: () => undefined } as EventEmitter, 1);
  const liveManifest = manifest([
    { url: "/40", startMs: 390_000, durationMs: 10_000 },
    { url: "/41", startMs: 400_000, durationMs: 10_000 },
  ]);
  liveManifest.audio.initUrl = "/40";

  await scheduler.appendInit(liveManifest);
  await scheduler.fill(liveManifest, 390_000, 410_000);

  expect(requested).toEqual(["/40", "/41"]);
  expect(appended).toEqual(["/40", "/41"]);
});

test("rejects fetched bytes from a superseded scheduler revision", async () => {
  let releaseResponse: ((response: HttpExchange) => void) | null = null;
  const pendingResponse = new Promise<HttpExchange>((resolve) => {
    releaseResponse = resolve;
  });
  const http = { once: async () => pendingResponse } as unknown as HttpClient;
  let appends = 0;
  const media = {
    append: async () => {
      appends += 1;
    },
    bufferedRanges: () => [],
  } as MediaSourceController;
  const scheduler = new SegmentScheduler(http, media, { emit: () => undefined } as EventEmitter, 1);
  const fill = scheduler.fill(
    manifest([{ url: "/old", startMs: 0, durationMs: 10_000 }]),
    0,
    10_000,
  );
  await Bun.sleep(0);
  scheduler.reset();
  if (!releaseResponse) throw new Error("Deferred response was not initialized");
  releaseResponse(segmentExchange());

  await expect(fill).rejects.toHaveProperty("name", "AbortError");
  expect(appends).toBe(0);
});

test("re-fetches a segment after its SourceBuffer range was evicted", async () => {
  const requested: string[] = [];
  let buffered: MediaBufferedRange[] = [];
  const http = {
    once: async (url: string) => {
      requested.push(url);
      return segmentExchange();
    },
  } as unknown as HttpClient;
  const media = {
    append: async () => {
      buffered = [{ kind: "audio", startMs: 0, endMs: 10_000 }];
    },
    bufferedRanges: () => buffered,
  } as MediaSourceController;
  const scheduler = new SegmentScheduler(http, media, { emit: () => undefined } as EventEmitter, 1);
  const segment = { url: "/segment", startMs: 0, durationMs: 10_000 };

  await scheduler.fill(manifest([segment]), 0, 10_000);
  buffered = [];
  await scheduler.fill(manifest([segment]), 0, 10_000);

  expect(requested).toEqual(["/segment", "/segment"]);
});

function encodedExchange(url: string): HttpExchange {
  return {
    status: 200,
    statusText: "OK",
    headers: new Headers(),
    body: new TextEncoder().encode(url).buffer,
  };
}

function segmentExchange(): HttpExchange {
  return {
    status: 200,
    statusText: "OK",
    headers: new Headers(),
    body: new Uint8Array([1]).buffer,
  };
}

test("keeps an appended segment whose buffered range ends slightly early", async () => {
  const requested: string[] = [];
  let buffered: MediaBufferedRange[] = [];
  const http = {
    once: async (url: string) => {
      requested.push(url);
      return segmentExchange();
    },
  } as unknown as HttpClient;
  const media = {
    append: async () => {
      buffered = [{ kind: "audio", startMs: 0, endMs: 9_920 }];
      return "appended" as const;
    },
    bufferedRanges: () => buffered,
  } as unknown as MediaSourceController;
  const scheduler = new SegmentScheduler(http, media, { emit: () => undefined } as EventEmitter, 1);
  const segment = { url: "/segment", startMs: 0, durationMs: 10_000 };

  await scheduler.fill(manifest([segment]), 0, 10_000);
  await scheduler.fill(manifest([segment]), 0, 10_000);
  await scheduler.fill(manifest([segment]), 0, 10_000);

  expect(requested).toEqual(["/segment"]);
});

test("appends primed media without downloading it again", async () => {
  const requested: string[] = [];
  const http = {
    once: async (url: string) => {
      requested.push(url);
      return segmentExchange();
    },
  } as unknown as HttpClient;
  const media = {
    append: async () => "appended",
    bufferedRanges: () => [],
  } as unknown as MediaSourceController;
  const scheduler = new SegmentScheduler(http, media, { emit: () => undefined } as EventEmitter, 1);
  const primedManifest = manifest([
    { url: "/1", startMs: 0, durationMs: 5_000 },
    { url: "/2", startMs: 5_000, durationMs: 5_000 },
    { url: "/3", startMs: 10_000, durationMs: 5_000 },
  ]);

  scheduler.prime(primedManifest, 4_000, 6_000);
  expect(requested.sort()).toEqual(["/1", "/2", "/audio/init"]);
  scheduler.reset();
  await scheduler.appendInit(primedManifest);
  await scheduler.fill(primedManifest, 4_000, 11_000);

  expect(requested.sort()).toEqual(["/1", "/2", "/3", "/audio/init"]);
});

test("limits recheck retries to prevent re-fetch storms on timestamp jitter", async () => {
  const requested: string[] = [];
  const http = {
    once: async (url: string) => {
      requested.push(url);
      return segmentExchange();
    },
  } as unknown as HttpClient;
  const buffered: MediaBufferedRange[] = [{ kind: "audio", startMs: 0, endMs: 9_500 }];
  const media = {
    append: async () => "appended",
    bufferedRanges: () => buffered,
  } as unknown as MediaSourceController;
  const scheduler = new SegmentScheduler(http, media, { emit: () => undefined } as EventEmitter, 1);
  const testManifest = manifest([{ url: "/jitter-segment", startMs: 0, durationMs: 10_000 }]);

  await scheduler.fill(testManifest, 0, 10_000);
  expect(requested).toEqual(["/jitter-segment"]);

  await scheduler.fill(testManifest, 0, 10_000);
  expect(requested).toEqual(["/jitter-segment", "/jitter-segment"]);

  await scheduler.fill(testManifest, 0, 10_000);
  expect(requested).toEqual(["/jitter-segment", "/jitter-segment"]);
});

test("appends a segment again each time the browser evicts it", async () => {
  const requested: string[] = [];
  let buffered: MediaBufferedRange[] = [];
  const http = {
    once: async (url: string) => {
      requested.push(url);
      return segmentExchange();
    },
  } as unknown as HttpClient;
  const media = {
    append: async () => {
      buffered = [{ kind: "audio", startMs: 0, endMs: 10_000 }];
      return "appended";
    },
    bufferedRanges: () => buffered,
  } as unknown as MediaSourceController;
  const scheduler = new SegmentScheduler(http, media, { emit: () => undefined } as EventEmitter, 1);
  const testManifest = manifest([{ url: "/evicted", startMs: 0, durationMs: 10_000 }]);

  for (let eviction = 0; eviction < 3; eviction += 1) {
    await scheduler.fill(testManifest, 0, 10_000);
    await scheduler.fill(testManifest, 0, 10_000);
    buffered = [];
  }

  expect(requested).toEqual(["/evicted", "/evicted", "/evicted"]);
});

test("pipelines one lookahead segment fetch per track while appending in FIFO order", async () => {
  const requested: string[] = [];
  const appended: string[] = [];
  const buffered: MediaBufferedRange[] = [];
  let releaseSecondAppend: (() => void) | null = null;
  const secondAppendGate = new Promise<void>((resolve) => {
    releaseSecondAppend = resolve;
  });
  const segments = [
    { url: "/1", startMs: 0, durationMs: 5_000 },
    { url: "/2", startMs: 5_000, durationMs: 5_000 },
    { url: "/3", startMs: 10_000, durationMs: 5_000 },
    { url: "/4", startMs: 15_000, durationMs: 5_000 },
  ];
  const byUrl = new Map(segments.map((segment) => [segment.url, segment]));
  const http = {
    once: async (url: string) => {
      requested.push(url);
      return encodedExchange(url);
    },
  } as unknown as HttpClient;
  const media = {
    append: async (kind: "audio" | "video", bytes: ArrayBuffer) => {
      const url = new TextDecoder().decode(bytes);
      if (url === "/2") await secondAppendGate;
      appended.push(url);
      const seg = byUrl.get(url);
      if (seg) buffered.push({ kind, startMs: seg.startMs, endMs: seg.startMs + seg.durationMs });
      return "appended" as const;
    },
    bufferedRanges: () => buffered,
  } as unknown as MediaSourceController;
  const scheduler = new SegmentScheduler(http, media, { emit: () => undefined } as EventEmitter, 1);

  await scheduler.fill(manifest(segments), 0, 2_500);
  expect(requested).toEqual(["/1"]);

  const fillNext = scheduler.fill(manifest(segments), 0, 16_000);
  await Bun.sleep(0);

  expect(requested).toEqual(["/1", "/2", "/3"]);
  expect(appended).toEqual(["/1"]);

  if (!releaseSecondAppend) throw new Error("Expected second append gate");
  releaseSecondAppend();
  await fillNext;

  expect(requested).toEqual(["/1", "/2", "/3", "/4"]);
  expect(appended).toEqual(["/1", "/2", "/3", "/4"]);
});

test("aborts in-flight lookahead fetches on deferred append, reset, and external abort", async () => {
  const scenarios: Array<"deferred" | "reset" | "abort"> = ["deferred", "reset", "abort"];
  for (const mode of scenarios) {
    const signals = new Map<string, AbortSignal>();
    const releasePrimary = { fn: null as (() => void) | null };
    const http = {
      once: async (url: string, init?: RequestInit) => {
        if (init?.signal) signals.set(url, init.signal);
        if (url === "/2") {
          return new Promise<HttpExchange>((resolve) => {
            init?.signal?.addEventListener("abort", () => resolve(encodedExchange("/2")), {
              once: true,
            });
          });
        }
        return encodedExchange(url);
      },
    } as unknown as HttpClient;
    const buffered: MediaBufferedRange[] = [];
    const media = {
      append: async (_kind: "audio" | "video", bytes: ArrayBuffer) => {
        const url = new TextDecoder().decode(bytes);
        if (url === "/0") return "appended" as const;
        return new Promise<"appended" | "deferred">((resolve) => {
          releasePrimary.fn = () => resolve(mode === "deferred" ? "deferred" : "appended");
        });
      },
      bufferedRanges: () => buffered,
    } as unknown as MediaSourceController;
    const scheduler = new SegmentScheduler(
      http,
      media,
      { emit: () => undefined } as EventEmitter,
      1,
    );
    const segs = [
      { url: "/0", startMs: 0, durationMs: 5_000 },
      { url: "/1", startMs: 5_000, durationMs: 5_000 },
      { url: "/2", startMs: 10_000, durationMs: 5_000 },
    ];
    await scheduler.fill(manifest([segs[0]]), 0, 5_000);
    buffered.push({ kind: "audio", startMs: 0, endMs: 5_000 });

    const external = new AbortController();
    const fill = scheduler.fill(manifest(segs), 0, 15_000, external.signal);
    await Bun.sleep(0);
    expect(signals.get("/2")?.aborted).toBe(false);

    if (mode === "deferred") {
      releasePrimary.fn?.();
      expect(await fill).toBe("deferred");
    } else if (mode === "reset") {
      scheduler.reset();
      expect(signals.get("/2")?.aborted).toBe(true);
      releasePrimary.fn?.();
      await expect(fill).rejects.toHaveProperty("name", "AbortError");
    } else {
      external.abort();
      expect(signals.get("/2")?.aborted).toBe(true);
      releasePrimary.fn?.();
      await expect(fill).rejects.toHaveProperty("name", "AbortError");
    }
    expect(signals.get("/2")?.aborted).toBe(true);
  }
});

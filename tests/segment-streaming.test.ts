import { expect, test } from "bun:test";
import { AppendQueue } from "../src/append-queue";
import type { EventEmitter } from "../src/event-emitter";
import type { HttpClient } from "../src/http-client";
import type { PlaybackManifest } from "../src/manifest";
import { SegmentScheduler } from "../src/segment-scheduler";

const manifest: PlaybackManifest = {
  durationMs: 60_000,
  endOfStream: false,
  audio: {
    kind: "audio",
    mime: "audio/mp4",
    initUrl: "/init",
    segments: [{ url: "/1", startMs: 0, durationMs: 5_000 }],
  },
  video: null,
};

function bytes(...values: number[]): ArrayBuffer {
  return new Uint8Array(values).buffer;
}

function ok(body = new ArrayBuffer(0)) {
  return { status: 200, statusText: "OK", headers: new Headers(), body };
}

function recordingMedia() {
  const calls: string[] = [];
  return {
    calls,
    media: {
      append: async (_kind: string, data: ArrayBuffer) => {
        calls.push(`append:${[...new Uint8Array(data)].join(",")}`);
        return "appended" as const;
      },
      bufferedRanges: () => [],
      resetParser: async () => {
        calls.push("reset");
      },
    },
  };
}

test("appends a media segment part by part as it arrives", async () => {
  const http = {
    once: async (
      _url: string,
      _init?: RequestInit,
      onChunk?: (chunk: ArrayBuffer) => Promise<void>,
    ) => {
      if (!onChunk) throw new Error("media segment fetched without streaming");
      await onChunk(bytes(1));
      await onChunk(bytes(2, 3));
      return ok();
    },
  } as unknown as HttpClient;
  const { media, calls } = recordingMedia();
  const scheduler = new SegmentScheduler(http, media, { emit: () => undefined } as EventEmitter, 1);

  expect(await scheduler.fill(manifest, 0, 5_000)).toBe("filled");
  expect(calls).toEqual(["append:1", "append:2,3"]);
});

test("a segment cut part way resets the parser and comes again whole", async () => {
  let attempts = 0;
  const http = {
    once: async (
      _url: string,
      _init?: RequestInit,
      onChunk?: (chunk: ArrayBuffer) => Promise<void>,
    ) => {
      attempts += 1;
      if (onChunk) {
        await onChunk(bytes(1));
        throw new TypeError("network error");
      }
      return ok(bytes(1, 2, 3));
    },
  } as unknown as HttpClient;
  const { media, calls } = recordingMedia();
  const scheduler = new SegmentScheduler(http, media, { emit: () => undefined } as EventEmitter, 1);

  expect(await scheduler.fill(manifest, 0, 5_000)).toBe("filled");
  expect(calls).toEqual(["append:1", "reset", "append:1,2,3"]);
  expect(attempts).toBe(2);
});

test("resets the parser only after the appends queued before it", async () => {
  const listeners = new Map<string, () => void>();
  const order: string[] = [];
  const sourceBuffer = {
    updating: false,
    buffered: { length: 0 },
    addEventListener: (type: string, listener: () => void) => listeners.set(type, listener),
    removeEventListener: () => undefined,
    appendBuffer: () => {
      order.push("append");
      sourceBuffer.updating = true;
      queueMicrotask(() => {
        sourceBuffer.updating = false;
        listeners.get("updateend")?.();
      });
    },
    abort: () => order.push("abort"),
  };
  const queue = new AppendQueue(sourceBuffer as unknown as SourceBuffer);

  await Promise.all([
    queue.append(new ArrayBuffer(1)),
    queue.resetParser(),
    queue.append(new ArrayBuffer(1)),
  ]);

  expect(order).toEqual(["append", "abort", "append"]);
});

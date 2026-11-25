import { expect, test } from "bun:test";
import {
  MEDIA_REQUEST_WATCHDOG,
  RequestWatchdog,
  streamWatchedBody,
} from "../src/request-watchdog";

test("joins the parts that arrive while the previous one is being appended", async () => {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const value of [1, 2, 3, 4]) controller.enqueue(new Uint8Array([value]));
      controller.close();
    },
  });
  const calls: number[][] = [];
  const watchdog = new RequestWatchdog(undefined, MEDIA_REQUEST_WATCHDOG);
  try {
    await streamWatchedBody(new Response(body), watchdog, async (chunk) => {
      calls.push([...new Uint8Array(chunk)]);
      await Bun.sleep(5);
    });
  } finally {
    watchdog.dispose();
  }
  expect(calls).toEqual([[1], [2, 3, 4]]);
});

test("stops on the first failing hand-over", async () => {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array([1]));
      controller.enqueue(new Uint8Array([2]));
      controller.close();
    },
  });
  const watchdog = new RequestWatchdog(undefined, MEDIA_REQUEST_WATCHDOG);
  try {
    await expect(
      streamWatchedBody(new Response(body), watchdog, async () => {
        throw new Error("SourceBuffer full");
      }),
    ).rejects.toThrow("SourceBuffer full");
  } finally {
    watchdog.dispose();
  }
});

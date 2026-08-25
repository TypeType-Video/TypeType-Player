import { expect, test } from "bun:test";
import { SeekController } from "../src/seek-controller";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolveValue: (() => void) | null = null;
  const promise = new Promise<void>((resolve) => {
    resolveValue = resolve;
  });
  if (!resolveValue) throw new Error("Deferred promise was not initialized");
  return { promise, resolve: resolveValue };
}

test("coalesces seeks to the latest pending position", async () => {
  const controller = new SeekController();
  const first = deferred();
  const positions: number[] = [];
  const execute = async (position: number) => {
    positions.push(position);
    if (position === 10) await first.promise;
  };
  const running = controller.seek(10, "10", execute, () => undefined);
  controller.seek(20, "20", execute, () => undefined);
  controller.seek(30, "30", execute, () => undefined);
  first.resolve();
  await running;
  expect(positions).toEqual([10, 30]);
});

test("waits for a rapid replacement burst to settle", async () => {
  const controller = new SeekController();
  const executions: number[] = [];
  let release: (() => void) | null = null;
  const first = controller.seek(
    10,
    "seek:10",
    async (position) => {
      executions.push(position);
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    },
    () => undefined,
  );

  for (let position = 20; position <= 80; position += 10) {
    controller.seek(
      position,
      `seek:${position}`,
      async (target) => {
        executions.push(target);
      },
      () => undefined,
    );
    await Bun.sleep(10);
  }
  if (!release) throw new Error("Initial seek did not start");
  release();
  await first;

  expect(executions).toEqual([10, 80]);
});

test("continues to the latest seek after an abort", async () => {
  const controller = new SeekController();
  const positions: number[] = [];
  const execute = async (position: number) => {
    positions.push(position);
    if (position === 10) throw new DOMException("aborted", "AbortError");
  };
  const running = controller.seek(10, "10", execute, () => undefined);
  controller.seek(40, "40", execute, () => undefined);
  await running;
  expect(positions).toEqual([10, 40]);
});

test("throws non-abort seek errors", async () => {
  const controller = new SeekController();
  await expect(
    controller.seek(
      10,
      "10",
      async () => Promise.reject(new Error("failed")),
      () => undefined,
    ),
  ).rejects.toThrow("failed");
});

test("uses the latest pending executor", async () => {
  const controller = new SeekController();
  const first = deferred();
  const executions: string[] = [];
  const running = controller.seek(
    10,
    "seek:10",
    async () => {
      executions.push("seek");
      await first.promise;
    },
    () => undefined,
  );
  controller.seek(
    20,
    "quality:20:299",
    async () => {
      executions.push("quality");
    },
    () => undefined,
  );
  first.resolve();
  await running;
  expect(executions).toEqual(["seek", "quality"]);
});

test("deduplicates the active request", async () => {
  const controller = new SeekController();
  const first = deferred();
  let executions = 0;
  let cancellations = 0;
  const execute = async () => {
    executions += 1;
    await first.promise;
  };
  const running = controller.seek(10, "seek:10", execute, () => {
    cancellations += 1;
  });
  const duplicate = controller.seek(10, "seek:10", execute, () => {
    cancellations += 1;
  });
  first.resolve();
  await running;
  expect(duplicate).toBe(running);
  expect(executions).toBe(1);
  expect(cancellations).toBe(0);
});

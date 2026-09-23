import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const { SubagentQueue } = await createJiti(import.meta.url).import("./subagent-queue.ts");

test("runs FIFO with a per-parent concurrency limit and drains after completion", async () => {
  const queue = new SubagentQueue();
  const events = [];
  let release;
  const first = queue.enqueue("parent", 1, () => new Promise((resolve) => { release = () => resolve("first"); }), (state) => events.push(["first", state]));
  const second = queue.enqueue("parent", 1, async () => "second", (state) => events.push(["second", state]));
  assert.deepEqual(events, [["first", "queued"], ["first", "running"], ["second", "queued"]]);
  release();
  assert.equal(await first.promise, "first");
  assert.equal(await second.promise, "second");
  assert.deepEqual(events, [
    ["first", "queued"], ["first", "running"], ["second", "queued"], ["second", "running"],
  ]);
});

test("cancels queued work without starting it", async () => {
  const queue = new SubagentQueue();
  let release;
  const first = queue.enqueue("parent", 1, () => new Promise((resolve) => { release = resolve; }), () => {});
  let started = false;
  let cancelled = false;
  const second = queue.enqueue("parent", 1, async () => { started = true; return "bad"; }, () => {}, () => { cancelled = true; });
  assert.equal(second.cancel(), true);
  assert.equal(cancelled, true);
  release();
  await first.promise;
  assert.equal(await second.promise, undefined);
  assert.equal(started, false);
});

test("rolls back an item when its queued callback fails", async () => {
  const queue = new SubagentQueue();
  let rejectedWorkStarted = false;
  assert.throws(() => queue.enqueue("parent", 1, async () => {
    rejectedWorkStarted = true;
  }, () => { throw new Error("status unavailable"); }), /status unavailable/);

  const next = queue.enqueue("parent", 1, async () => "next", () => {});
  assert.equal(await next.promise, "next");
  assert.equal(rejectedWorkStarted, false);
});

test("rejects a failed running callback and continues draining the queue", async () => {
  const queue = new SubagentQueue();
  let releaseFirst;
  const first = queue.enqueue("parent", 1, () => new Promise((resolve) => {
    releaseFirst = resolve;
  }), () => {});
  let rejectedWorkStarted = false;
  const rejected = queue.enqueue("parent", 1, async () => {
    rejectedWorkStarted = true;
  }, (state) => {
    if (state === "running") throw new Error("status unavailable");
  });
  const next = queue.enqueue("parent", 1, async () => "next", () => {});

  releaseFirst();
  await first.promise;
  await assert.rejects(rejected.promise, /status unavailable/);
  assert.equal(await next.promise, "next");
  assert.equal(rejectedWorkStarted, false);
});

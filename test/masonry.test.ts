import assert from "node:assert/strict";
import test from "node:test";
import { packIntoColumns } from "../src/masonry.ts";
import type { Item } from "../src/types.ts";

function item(id: string, cover_aspect?: number): Item {
  return {
    id,
    peer_id: 1,
    message_id: 1,
    logical_pos: 1,
    name: id,
    mime: "image/jpeg",
    type: "image",
    size: 1,
    status: "completed",
    progress: 1,
    target_path: "",
    resume_completed: true,
    skip_same: false,
    cover_aspect,
  };
}

test("packIntoColumns fills the shortest column by estimated height", () => {
  const items = [
    item("tall-a", 2),
    item("tall-b", 2),
    item("short-a", 0.5),
    item("short-b", 0.5),
    item("short-c", 0.5),
    item("short-d", 0.5),
  ];
  const { buckets } = packIntoColumns(
    items,
    2,
    (entry) => Math.ceil(100 * (entry.cover_aspect ?? 1)),
    0,
  );

  const height = (col: Item[]) =>
    col.reduce((sum, entry) => sum + Math.ceil(100 * (entry.cover_aspect ?? 1)), 0);

  assert.equal(buckets.length, 2);
  assert.ok(Math.abs(height(buckets[0]!) - height(buckets[1]!)) <= 50);
  assert.ok(buckets[0]!.length >= 2);
  assert.ok(buckets[1]!.length >= 2);
});

test("packIntoColumns keeps previous column assignments stable", () => {
  const first = [item("a", 1), item("b", 1), item("c", 1), item("d", 1)];
  const { buckets: initial, assignment } = packIntoColumns(
    first,
    2,
    () => 100,
    0,
  );
  assert.deepEqual(
    initial.map((col) => col.map((entry) => entry.id)),
    [["a", "c"], ["b", "d"]],
  );

  const next = [...first, item("e", 1), item("f", 1)];
  const { buckets } = packIntoColumns(next, 2, () => 100, 0, assignment);

  assert.equal(buckets[0]!.findIndex((entry) => entry.id === "a"), 0);
  assert.equal(buckets[1]!.findIndex((entry) => entry.id === "b"), 0);
  assert.ok(buckets.some((col) => col.some((entry) => entry.id === "e")));
  assert.ok(buckets.some((col) => col.some((entry) => entry.id === "f")));
});

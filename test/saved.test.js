import assert from "node:assert/strict";
import test from "node:test";
import { MAX_SAVED, removeSaved, upsertSaved } from "../src/lib/saved.js";

test("saving puts the query first, replaces the same name and keeps the cap", () => {
  let list = upsertSaved([], "a", { table: "t1" });
  list = upsertSaved(list, "b", { table: "t2" });
  list = upsertSaved(list, "a", { table: "t3" });
  assert.deepEqual(list, [
    { name: "a", query: { table: "t3" } },
    { name: "b", query: { table: "t2" } },
  ]);
  for (let i = 0; i < MAX_SAVED + 5; i++) list = upsertSaved(list, `q${i}`, {});
  assert.equal(list.length, MAX_SAVED);
  assert.equal(list[0].name, `q${MAX_SAVED + 4}`);
});

test("deleting removes by name only", () => {
  assert.deepEqual(removeSaved([{ name: "a" }, { name: "b" }], "a"), [{ name: "b" }]);
  assert.deepEqual(removeSaved([{ name: "a" }], "missing"), [{ name: "a" }]);
});

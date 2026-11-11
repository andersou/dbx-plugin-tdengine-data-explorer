import assert from "node:assert/strict";
import test from "node:test";
import { lastValue, parseOffset, parseTime, toSeries } from "../src/lib/series.js";

test("parses agent timestamps with the server offset", () => {
  assert.equal(parseOffset("Asia/Shanghai (CST, +0800)"), "+08:00");
  assert.equal(parseOffset(undefined), "+00:00");
  // Same instant as agents/drivers/tdengine/tests/live.rs (epoch 1785808800001 in Asia/Shanghai).
  assert.equal(parseTime("2026-08-04 10:00:00.001", "+08:00"), 1785808800001);
  assert.equal(parseTime("2026-11-10T00:00:00.123456789Z", "+08:00"), 1794268800123);
});

test("pivots partitioned builder output into one series per partition", () => {
  const result = {
    columns: [{ name: "_time", dataType: "VARCHAR" }, { name: "groupid", dataType: "INT" }, { name: "avg(current)", dataType: "DOUBLE" }],
    rows: [
      ["2017-07-14T02:50:00.000Z", 2, "NaN"],
      ["2017-07-14T02:40:00.000Z", 2, 10],
      ["2017-07-14T02:40:00.000Z", 10, 11],
    ],
  };
  const series = toSeries(result, { labels: ["groupid"] });
  assert.deepEqual(series, [
    { name: "2", data: [[Date.parse("2017-07-14T02:40:00Z"), 10], [Date.parse("2017-07-14T02:50:00Z"), null]] },
    { name: "10", data: [[Date.parse("2017-07-14T02:40:00Z"), 11]] },
  ]);
  assert.equal(lastValue(series[0]), 10);
});

test("custom SQL without dataType: strings are labels, numbers are values", () => {
  const series = toSeries({
    columns: [{ name: "ts" }, { name: "tbname" }, { name: "current" }, { name: "voltage" }],
    rows: [["2017-07-14 10:40:00.000", "d1", 1.5, 220]],
  });
  assert.deepEqual(series.map((s) => s.name), ["d1 current", "d1 voltage"]);
  assert.equal(series[0].data[0][0], Date.parse("2017-07-14T10:40:00Z"));
});

test("results without a time column have no series", () => {
  assert.deepEqual(toSeries({ columns: [{ name: "name" }], rows: [["power"]] }), []);
});

test("hidden labels keep series apart but stay out of the names unless names clash", () => {
  const columns = [{ name: "_time", dataType: "VARCHAR" }, { name: "tbname", dataType: "VARCHAR" }, { name: "node", dataType: "VARCHAR" }, { name: "company", dataType: "INT" }, { name: "cpu", dataType: "DOUBLE" }];
  const t = "2026-11-10T00:00:00.000Z";
  const rows = [
    [t, "node_id:BRU,company_id:13", "BRU", 13, 1],
    [t, "node_id:GRU,company_id:13", "GRU", 13, 2],
    [t, "dup-a", "REC", 21, 3],
    [t, "dup-b", "REC", 21, 4],
  ];
  const names = toSeries({ columns, rows }, { labels: ["tbname", "node", "company"], hide: ["tbname"] }).map((s) => s.name);
  // Same order as the tbnames alone, so each series keeps its color when tag names are toggled.
  assert.deepEqual(names, ["dup-a · REC · 21", "dup-b · REC · 21", "BRU · 13", "GRU · 13"]);
  const plain = rows.map(([time, tbname, , , cpu]) => [time, tbname, cpu]);
  assert.deepEqual(toSeries({ columns: [columns[0], columns[1], columns[4]], rows: plain }, { labels: ["tbname"] }).map((s) => s.name), ["dup-a", "dup-b", "node_id:BRU,company_id:13", "node_id:GRU,company_id:13"]);
});

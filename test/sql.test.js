import assert from "node:assert/strict";
import test from "node:test";
import { MAX_ROWS, MAX_SERIES, RANGES, autoWindow, buildQuery, durationMs, filterClause, quoteIdent, quoteString, tagValuesQuery } from "../src/lib/sql.js";

const meta = { tsColumn: "ts", tagTypes: { location: "VARCHAR(24)", groupid: "INT" } };
const query = {
  database: "power",
  table: "meters",
  fields: ["current"],
  fns: ["avg"],
  filters: [],
  groupBy: "tbname",
  fill: "null",
  window: "1m",
  maxSeries: 20,
  range: { type: "relative", value: "1h" },
};

test("builds a partitioned window query", () => {
  const sql = buildQuery(
    { ...query, fns: ["avg", "max"], filters: [{ key: "location", values: ["California.SanFrancisco"] }, { key: "groupid", values: [1, 2] }] },
    meta,
  );
  assert.equal(
    sql,
    [
      "SELECT TO_ISO8601(_wstart, 'Z') AS _time, tbname, AVG(`current`) AS `avg(current)`, MAX(`current`) AS `max(current)`",
      "FROM `power`.`meters`",
      "WHERE `ts` >= NOW - 1h",
      "  AND `ts` < NOW",
      "  AND `location` IN ('California.SanFrancisco')",
      "  AND `groupid` IN (1, 2)",
      "PARTITION BY tbname",
      "INTERVAL(1m) FILL(NULL)",
      "SLIMIT 20",
    ].join("\n"),
  );
});

test("no partition means no SLIMIT and no FILL for none", () => {
  const sql = buildQuery({ ...query, groupBy: "", fill: "none" }, meta);
  assert.match(sql, /^SELECT TO_ISO8601\(_wstart, 'Z'\) AS _time, AVG/);
  assert.match(sql, /INTERVAL\(1m\)$/);
  assert.doesNotMatch(sql, /SLIMIT|PARTITION|FILL/);
});

test("absolute ranges use RFC 3339 literals", () => {
  const sql = buildQuery({ ...query, range: { type: "absolute", start: "2026-11-10T00:00:00Z", stop: "2026-11-10T01:00:00Z" } }, meta);
  assert.match(sql, /`ts` >= '2026-11-10T00:00:00.000Z'\n {2}AND `ts` < '2026-11-10T01:00:00.000Z'/);
  assert.throws(() => buildQuery({ ...query, range: { type: "absolute", start: "2026-11-10T01:00:00Z", stop: "2026-11-10T00:00:00Z" } }, meta));
});

test("auto window keeps every preset under the row cap", () => {
  for (const range of RANGES)
    for (const series of [1, 8, 20, 50, MAX_SERIES]) {
      const window = autoWindow(durationMs(range), series);
      const rows = (Math.ceil(durationMs(range) / durationMs(window)) + 1) * series;
      assert.ok(rows <= MAX_ROWS, `${range} x ${series} series -> ${window} = ${rows} rows`);
    }
  assert.equal(autoWindow(durationMs("1h")), "10s"); // 360 points, like the InfluxDB UI
  // Past MAX_SERIES no window keeps the cap; empty or fractional values are not valid SLIMIT.
  for (const maxSeries of [null, 0, 1.5, MAX_SERIES + 1]) assert.throws(() => buildQuery({ ...query, window: "auto", maxSeries }, meta), { code: "badMaxSeries" });
  assert.match(buildQuery({ ...query, window: "auto", maxSeries: MAX_SERIES }, meta), new RegExp(`SLIMIT ${MAX_SERIES}$`));
  assert.doesNotThrow(() => buildQuery({ ...query, groupBy: "", maxSeries: null }, meta));
});

test("literals and identifiers are escaped", () => {
  assert.equal(quoteString("it's \\ odd"), "'it''s \\\\ odd'");
  assert.throws(() => quoteIdent("bad`name"));
  assert.equal(filterClause({ key: "groupid", values: [1, null] }, "INT"), "(`groupid` IN (1) OR `groupid` IS NULL)");
  assert.equal(filterClause({ key: "on", values: [true] }, "BOOL"), "`on` IN (true)");
  assert.throws(() => filterClause({ key: "groupid", values: ["1; DROP"] }, "INT"));
  // An IN list compares a FLOAT tag as DOUBLE and matches nothing.
  assert.equal(filterClause({ key: "gain", values: [1.1, 2.5, null] }, "FLOAT"), "(`gain` = 1.1 OR `gain` = 2.5 OR `gain` IS NULL)");
  assert.equal(filterClause({ key: "gain", values: [1.1] }, "FLOAT"), "`gain` = 1.1");
});

test("tag values cascade from earlier filters", () => {
  assert.equal(
    tagValuesQuery({ database: "power", table: "meters", key: "tbname", filters: [{ key: "groupid", values: [3] }, { key: "location", values: [] }], tagTypes: meta.tagTypes }),
    "SELECT DISTINCT tbname FROM `power`.`meters` WHERE `groupid` IN (3) LIMIT 1000",
  );
});

test("raw mode reads the latest rows, one series per child table", () => {
  const filters = [{ key: "location", values: ["California.SanFrancisco"] }];
  assert.equal(
    buildQuery({ ...query, window: "raw", fns: [], fields: ["current", "voltage"], filters }, { ...meta, isSuper: true }),
    [
      "SELECT TO_ISO8601(`ts`, 'Z') AS _time, tbname, `current`, `voltage`",
      "FROM `power`.`meters`",
      "WHERE `ts` >= NOW - 1h",
      "  AND `ts` < NOW",
      "  AND `location` IN ('California.SanFrancisco')",
      "ORDER BY `ts` DESC",
      `LIMIT ${MAX_ROWS}`,
    ].join("\n"),
  );
  // A normal table has no tbname series split.
  assert.match(buildQuery({ ...query, window: "raw", table: "nt1" }, meta), /^SELECT TO_ISO8601\(`ts`, 'Z'\) AS _time, `current`\n/);
});

test("tag labels add the tags next to tbname without changing the partition", () => {
  const tagged = { ...query, tagLabels: true };
  const superMeta = { ...meta, isSuper: true };
  assert.match(buildQuery(tagged, superMeta), /^SELECT TO_ISO8601\(_wstart, 'Z'\) AS _time, tbname, `location`, `groupid`, AVG\(`current`\)/);
  assert.match(buildQuery(tagged, superMeta), /\nPARTITION BY tbname\n/);
  assert.match(buildQuery({ ...tagged, window: "raw" }, superMeta), /^SELECT TO_ISO8601\(`ts`, 'Z'\) AS _time, tbname, `location`, `groupid`, `current`\n/);
  // Only a per-child-table result has tbname to rename.
  assert.doesNotMatch(buildQuery({ ...tagged, groupBy: "location" }, superMeta), /`groupid`/);
  assert.doesNotMatch(buildQuery(query, superMeta), /`location`, `groupid`/);
});

// Runs the generated SQL on a real TDengine through taosAdapter REST.
// TDENGINE_URL=http://localhost:6041 npm test  (seed first: taosBenchmark -y -d power)
import assert from "node:assert/strict";
import test from "node:test";
import { FILLS, FUNCTIONS, buildQuery, databasesQuery, describeQuery, filterClause, tablesQuery, tagValuesQuery } from "../src/lib/sql.js";
import { toSeries } from "../src/lib/series.js";

const url = process.env.TDENGINE_URL;
const auth = `Basic ${Buffer.from(process.env.TDENGINE_AUTH ?? "root:taosdata").toString("base64")}`;

async function run(sql) {
  const response = await fetch(`${url}/rest/sql`, { method: "POST", headers: { authorization: auth }, body: sql });
  const body = await response.json();
  assert.equal(body.code, 0, `${body.desc}\n${sql}`);
  return { columns: body.column_meta.map(([name, dataType]) => ({ name, dataType })), rows: body.data };
}

test("generated SQL runs on TDengine", { skip: !url && "set TDENGINE_URL" }, async () => {
  assert.ok((await run(databasesQuery())).rows.some(([name]) => name === "power"));
  assert.ok((await run(tablesQuery("power"))).rows.some(([name, kind]) => name === "meters" && kind === "super"));

  const described = await run(describeQuery("power", "meters"));
  const tagTypes = Object.fromEntries(described.rows.filter((row) => row[3] === "TAG").map(([name, type]) => [name, type]));
  assert.deepEqual(Object.keys(tagTypes), ["groupid", "location"]);

  // Pick filter values from the data so any taosBenchmark seed size matches rows.
  const values = async (key, filters = []) => (await run(tagValuesQuery({ database: "power", table: "meters", key, filters, tagTypes }))).rows.map(([value]) => value);
  const [groupid] = await values("groupid");
  const [location] = await values("location", [{ key: "groupid", values: [groupid] }]);
  const filters = [{ key: "location", values: [location, null] }, { key: "groupid", values: [groupid] }];
  const [[first]] = (await run("SELECT TO_ISO8601(FIRST(ts), 'Z') FROM power.meters")).rows;
  const range = { type: "absolute", start: first, stop: new Date(Date.parse(first) + 3600e3).toISOString() };
  const base = { database: "power", table: "meters", fields: ["current", "voltage"], fns: ["avg"], filters, groupBy: "tbname", fill: "null", window: "auto", maxSeries: 20, range };

  const result = await run(buildQuery(base, { tsColumn: "ts", tagTypes }));
  const series = toSeries(result, { labels: ["tbname"] });
  assert.ok(series.length > 0 && series.every((s) => s.data.every(([t]) => Number.isFinite(t))));

  for (const fn of Object.keys(FUNCTIONS)) await run(buildQuery({ ...base, fns: [fn] }, { tsColumn: "ts", tagTypes }));
  for (const fill of Object.keys(FILLS)) await run(buildQuery({ ...base, fill }, { tsColumn: "ts", tagTypes }));
  for (const groupBy of ["", "location", "groupid"]) await run(buildQuery({ ...base, groupBy }, { tsColumn: "ts", tagTypes }));
  await run(buildQuery({ ...base, range: { type: "relative", value: "7d" } }, { tsColumn: "ts", tagTypes }));
  // FLOAT values arrive as their shortest decimal, which an IN list (compared as DOUBLE) never matches.
  const [[current]] = (await run("SELECT `current` FROM power.meters WHERE `current` IS NOT NULL LIMIT 1")).rows;
  assert.ok((await run(`SELECT COUNT(*) FROM power.meters WHERE ${filterClause({ key: "current", values: [current] }, "FLOAT")}`)).rows[0][0] > 0);

  // Tags selected next to tbname under PARTITION BY tbname: one series per child table, named by tags.
  const tagged = await run(buildQuery({ ...base, tagLabels: true }, { tsColumn: "ts", tagTypes, isSuper: true }));
  const tables = new Set(tagged.rows.map((row) => row[1]));
  assert.equal(toSeries(tagged, { labels: ["tbname", ...Object.keys(tagTypes)], hide: ["tbname"] }).length, tables.size * base.fields.length);

  const raw = await run(buildQuery({ ...base, window: "raw", fns: [] }, { tsColumn: "ts", tagTypes, isSuper: true }));
  const times = raw.rows.map(([time]) => Date.parse(time));
  assert.ok(raw.rows.length > 0 && times.every((time, index) => index === 0 || time <= times[index - 1]), "raw rows come newest first");
  assert.ok(toSeries(raw).every((s) => s.data.every(([, value]) => typeof value === "number")));
});

// TDengine 3.x SQL for the query builder. Pure functions, no host calls.

// queryData returns at most 5000 rows (plugins/README.md, "Read-only data queries").
export const MAX_ROWS = 5000;
export const TAG_VALUES_LIMIT = 1000;
export const MAX_SERIES = 100; // autoWindow keeps up to this many series under MAX_ROWS
const TARGET_POINTS = 360; // points per series, the InfluxDB UI default

export const FUNCTIONS = {
  avg: (c) => `AVG(${c})`,
  median: (c) => `APERCENTILE(${c}, 50)`,
  min: (c) => `MIN(${c})`,
  max: (c) => `MAX(${c})`,
  sum: (c) => `SUM(${c})`,
  count: (c) => `COUNT(${c})`,
  first: (c) => `FIRST(${c})`,
  last: (c) => `LAST(${c})`,
  spread: (c) => `SPREAD(${c})`,
  stddev: (c) => `STDDEV(${c})`,
};

// FILL(VALUE, ...) needs one value per aggregate column.
export const FILLS = {
  null: () => " FILL(NULL)",
  none: () => "",
  prev: () => " FILL(PREV)",
  linear: () => " FILL(LINEAR)",
  zero: (count) => ` FILL(VALUE, ${Array(count).fill(0).join(", ")})`,
};

export const RANGES = ["5m", "15m", "1h", "3h", "6h", "12h", "1d", "2d", "7d", "30d"];
export const WINDOWS = ["1s", "5s", "10s", "15s", "30s", "1m", "2m", "5m", "10m", "15m", "30m", "1h", "2h", "3h", "6h", "12h", "1d", "2d", "7d", "30d"];

const UNIT_MS = { s: 1e3, m: 60e3, h: 3600e3, d: 86400e3 };

// User-facing validation errors carry a code the UI translates.
function fail(code, message, vars) {
  throw Object.assign(new Error(message), { code, vars });
}

export function durationMs(duration) {
  const match = /^(\d+)([smhd])$/.exec(duration);
  if (!match) throw new Error(`Invalid duration: ${duration}`);
  return Number(match[1]) * UNIT_MS[match[2]];
}

export function quoteIdent(name) {
  // TDengine cannot escape a backtick inside a quoted name.
  if (typeof name !== "string" || !name || name.includes("`")) throw new Error(`Invalid identifier: ${name}`);
  return `\`${name}\``;
}

// TDengine accepts both '' and \' inside literals; '' keeps generic SQL tokenizers in sync.
export const quoteString = (value) => `'${String(value).replaceAll("\\", "\\\\").replaceAll("'", "''")}'`;

const NUMERIC = /^(TINYINT|SMALLINT|INT|BIGINT|FLOAT|DOUBLE|DECIMAL)\b/i;
export const isNumericType = (type) => NUMERIC.test(type);
// JSON, VARBINARY and GEOMETRY tags cannot be matched with a plain IN list.
export const isFilterableType = (type) => NUMERIC.test(type) || /^(BOOL|VARCHAR|BINARY|NCHAR|TIMESTAMP)\b/i.test(type);

export function literal(value, type) {
  if (/^BOOL/i.test(type)) return value === true || value === "true" ? "true" : "false";
  if (NUMERIC.test(type)) {
    if (!/^-?\d+(\.\d+)?(e[+-]?\d+)?$/i.test(String(value))) throw new Error(`Not a number: ${value}`);
    return String(value);
  }
  return quoteString(value);
}

const column = (key) => (key === "tbname" ? "tbname" : quoteIdent(key));

// One filter card: selected values of one tag, NULL included as IS NULL.
export function filterClause({ key, values }, type = "VARCHAR") {
  const literals = values.filter((value) => value !== null).map((value) => literal(value, type));
  const parts = [];
  // TDengine compares an IN list as DOUBLE, where a FLOAT 1.1 (1.10000002) never matches 1.1; = compares as FLOAT.
  if (/^FLOAT\b/i.test(type)) parts.push(...literals.map((value) => `${column(key)} = ${value}`));
  else if (literals.length) parts.push(`${column(key)} IN (${literals.join(", ")})`);
  if (literals.length < values.length) parts.push(`${column(key)} IS NULL`);
  return parts.length > 1 ? `(${parts.join(" OR ")})` : parts[0];
}

const filterClauses = (filters, tagTypes) => filters.filter((filter) => filter.key && filter.values.length).map((filter) => filterClause(filter, tagTypes[filter.key]));

export function timeRange(range) {
  if (range.type === "absolute") {
    const start = new Date(range.start);
    const stop = new Date(range.stop);
    if (!(stop > start)) fail("badRange", "The time range must end after it starts");
    return { lower: quoteString(start.toISOString()), upper: quoteString(stop.toISOString()), ms: stop - start };
  }
  return { lower: `NOW - ${range.value}`, upper: "NOW", ms: durationMs(range.value) };
}

// Smallest round window that keeps every series of the result under MAX_ROWS.
export function autoWindow(rangeMs, seriesCap = 1) {
  const points = Math.min(TARGET_POINTS, Math.floor(MAX_ROWS / seriesCap) - 2);
  return WINDOWS.find((window) => rangeMs / durationMs(window) <= points) ?? WINDOWS.at(-1);
}

// Tags that can name the series of a per-child-table result; display only, the partition stays tbname.
export const labelTags = (query, meta) => (meta.isSuper && (query.window === "raw" || query.groupBy === "tbname") ? Object.keys(meta.tagTypes) : []);

export function buildQuery(query, meta) {
  const { database, table, fields, fns, filters, groupBy, fill, window, maxSeries } = query;
  const tags = query.tagLabels ? labelTags(query, meta).map(quoteIdent) : [];
  if (!database || !table) fail("pickTable", "Choose a database and a table");
  if (!meta.tsColumn) fail("noTimestamp", `${table} has no timestamp column`, { table });
  if (!fields.length) fail("pickField", "Choose at least one field");
  if (window !== "raw" && !fns.length) fail("pickFunction", "Choose at least one aggregate function");

  const range = timeRange(query.range);
  const ts = quoteIdent(meta.tsColumn);
  const from = `FROM ${quoteIdent(database)}.${quoteIdent(table)}`;
  const where = `WHERE ${[`${ts} >= ${range.lower}`, `${ts} < ${range.upper}`, ...filterClauses(filters, meta.tagTypes)].join("\n  AND ")}`;

  // Under ORDER BY, TDengine merges PARTITION BY output into one sorted stream, so no single query returns
  // the latest N rows of every series: raw mode takes the latest MAX_ROWS overall, one series per child table.
  if (window === "raw") {
    const columns = [`TO_ISO8601(${ts}, 'Z') AS _time`, ...(meta.isSuper ? ["tbname", ...tags] : []), ...fields.map(quoteIdent)];
    return [`SELECT ${columns.join(", ")}`, from, where, `ORDER BY ${ts} DESC`, `LIMIT ${MAX_ROWS}`].join("\n");
  }

  const partition = groupBy ? column(groupBy) : "";
  // The number input's min/max do not stop typing: empty, 1.5 or 6000 would break the SQL or the row cap.
  if (partition && !(Number.isInteger(maxSeries) && maxSeries >= 1 && maxSeries <= MAX_SERIES))
    fail("badMaxSeries", `Max series must be a whole number from 1 to ${MAX_SERIES}`, { max: MAX_SERIES });
  const interval = window === "auto" ? autoWindow(range.ms, partition ? maxSeries : 1) : window;
  const values = fields.flatMap((field) => fns.map((fn) => `${FUNCTIONS[fn](quoteIdent(field))} AS ${quoteIdent(`${fn}(${field})`)}`));

  return [
    // The agent renders TIMESTAMP without an offset; an explicit UTC string keeps the chart exact.
    `SELECT TO_ISO8601(_wstart, 'Z') AS _time, ${[partition, ...tags, ...values].filter(Boolean).join(", ")}`,
    from,
    where,
    partition && `PARTITION BY ${partition}`,
    `INTERVAL(${interval})${FILLS[fill](values.length)}`,
    partition && `SLIMIT ${maxSeries}`,
  ]
    .filter(Boolean)
    .join("\n");
}

// Values for one filter card, narrowed by the cards before it (InfluxDB-style cascade).
export function tagValuesQuery({ database, table, key, filters, tagTypes }) {
  const where = filterClauses(filters, tagTypes);
  return `SELECT DISTINCT ${column(key)} FROM ${quoteIdent(database)}.${quoteIdent(table)}${where.length ? ` WHERE ${where.join(" AND ")}` : ""} LIMIT ${TAG_VALUES_LIMIT}`;
}

export const databasesQuery = () => "SELECT name FROM information_schema.ins_databases WHERE name NOT IN ('information_schema', 'performance_schema') ORDER BY name";

export const tablesQuery = (database) =>
  `SELECT stable_name AS name, 'super' AS kind FROM information_schema.ins_stables WHERE db_name = ${quoteString(database)} ` +
  `UNION ALL SELECT table_name AS name, 'normal' AS kind FROM information_schema.ins_tables WHERE db_name = ${quoteString(database)} AND type = 'NORMAL_TABLE'`;

// Rows: [field, type, length, note, ...]; note is "TAG" for tag columns.
export const describeQuery = (database, table) => `DESCRIBE ${quoteIdent(database)}.${quoteIdent(table)}`;

export const timezoneQuery = () => "SELECT timezone()";

// DBX's table menu does not say whether a table is a child table; its supertable answers that.
export const parentTableQuery = (database, table) =>
  `SELECT stable_name FROM information_schema.ins_tables WHERE db_name = ${quoteString(database)} AND table_name = ${quoteString(table)}`;

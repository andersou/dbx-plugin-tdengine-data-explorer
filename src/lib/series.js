// Pivot a queryData result ({ columns, rows }) into one time series per label tuple and value column.
import { isNumericType } from "./sql.js";

const TIME = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})?$/;
const HAS_OFFSET = /(Z|[+-]\d{2}:?\d{2})$/;

// SELECT timezone() returns e.g. "Asia/Shanghai (CST, +0800)".
export function parseOffset(timezone) {
  const match = /([+-])(\d{2}):?(\d{2})\)\s*$/.exec(timezone ?? "");
  return match ? `${match[1]}${match[2]}:${match[3]}` : "+00:00";
}

// The DBX TDengine agent renders TIMESTAMP values without an offset, in the server time zone.
// shortcut: one fixed offset per connection, wrong across DST changes; the builder avoids it with TO_ISO8601(..., 'Z').
export function parseTime(value, offset = "+00:00") {
  const text = String(value).replace(" ", "T");
  return Date.parse(HAS_OFFSET.test(text) ? text : text + offset);
}

function toNumber(value) {
  const number = typeof value === "number" ? value : typeof value === "boolean" ? Number(value) : value == null ? null : Number(value);
  return Number.isFinite(number) ? number : null; // "NaN" / "inf" strings become gaps
}

export function toSeries({ columns, rows }, { offset, labels = [] } = {}) {
  const sample = (index) => rows.find((row) => row[index] != null)?.[index];
  const time = columns.findIndex((_, index) => TIME.test(String(sample(index) ?? "")));
  if (time < 0) return [];

  const isValue = (column, index) =>
    !labels.includes(column.name) && (column.dataType ? isNumericType(column.dataType) || /^BOOL/i.test(column.dataType) : ["number", "boolean"].includes(typeof sample(index)));
  const others = columns.map((column, index) => ({ ...column, index })).filter(({ index }) => index !== time);
  const values = others.filter((column) => isValue(column, column.index));
  const keys = others.filter((column) => !isValue(column, column.index));

  const series = new Map();
  for (const row of rows) {
    const label = keys.map((key) => String(row[key.index] ?? "null")).join(" · ");
    for (const value of values) {
      const name = [label, label && values.length === 1 ? "" : value.name].filter(Boolean).join(" ");
      if (!series.has(name)) series.set(name, []);
      series.get(name).push([parseTime(row[time], offset), toNumber(row[value.index])]);
    }
  }
  return [...series]
    .map(([name, data]) => ({ name, data: data.sort((a, b) => a[0] - b[0]) }))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
}

export const lastValue = (series) => series?.data.findLast(([, value]) => value != null)?.[1] ?? null;

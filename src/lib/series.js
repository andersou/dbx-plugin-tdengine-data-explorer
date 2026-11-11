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

// hide: label columns that keep series apart but stay out of their names (tbname behind tag values).
export function toSeries({ columns, rows }, { offset, labels = [], hide = [] } = {}) {
  const sample = (index) => rows.find((row) => row[index] != null)?.[index];
  const time = columns.findIndex((_, index) => TIME.test(String(sample(index) ?? "")));
  if (time < 0) return [];

  const isValue = (column, index) =>
    !labels.includes(column.name) && (column.dataType ? isNumericType(column.dataType) || /^BOOL/i.test(column.dataType) : ["number", "boolean"].includes(typeof sample(index)));
  const others = columns.map((column, index) => ({ ...column, index })).filter(({ index }) => index !== time);
  const values = others.filter((column) => isValue(column, column.index));
  const keys = others.filter((column) => !isValue(column, column.index));

  const label = (row, columns) => columns.map((key) => String(row[key.index] ?? "null")).join(" · ");
  const nameOf = (text, value) => [text, text && values.length === 1 ? "" : value.name].filter(Boolean).join(" ");
  const shown = keys.filter((key) => !hide.includes(key.name));
  const series = new Map();
  for (const row of rows) {
    for (const value of values) {
      const id = nameOf(label(row, keys), value);
      if (!series.has(id)) series.set(id, { name: nameOf(label(row, shown), value), data: [] });
      series.get(id).data.push([parseTime(row[time], offset), toNumber(row[value.index])]);
    }
  }
  // Series whose shown labels coincide keep the hidden ones too, so no two legend entries read the same.
  const uses = new Map();
  for (const { name } of series.values()) uses.set(name, (uses.get(name) ?? 0) + 1);
  // Ordered by identity (tbname first), not by the shown name, so palette slots stay put when tag names are toggled.
  return [...series]
    .sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }))
    .map(([id, { name, data }]) => ({ name: uses.get(name) > 1 ? id : name, data: data.sort((a, b) => a[0] - b[0]) }));
}

export const lastValue = (series) => series?.data.findLast(([, value]) => value != null)?.[1] ?? null;

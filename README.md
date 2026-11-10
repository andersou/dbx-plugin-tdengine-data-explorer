# TDengine Data Explorer for DBX

A [DBX](https://github.com/t8y2/dbx) plugin modeled on the InfluxDB 2 Data Explorer, for TDengine connections: pick a database and supertable, narrow it with cascading tag filters, choose fields and aggregate functions, and chart the result as a time series.

![TDengine Data Explorer: cascading site and tbname filters, mean temperature per child table over the last 6 hours](docs/screenshots/builder.png)

| SQL tab | Dark theme | Table context menu |
| --- | --- | --- |
| ![Generated TDengine SQL in the editable SQL tab](docs/screenshots/sql.png) | ![The same chart in DBX's dark theme](docs/screenshots/dark.png) | ![Open in TDengine Data Explorer on a child table](docs/screenshots/context-menu.png) |

New to DBX plugins? [`docs/dbx-plugin-system.md`](docs/dbx-plugin-system.md) explains how they are packaged, sandboxed and allowed to read data. Coding agents start at [`AGENTS.md`](AGENTS.md).

- **Cards like the InfluxDB builder:** Database → Table → Fields → any number of tag filter cards. Each filter card lists the values left after the cards on its left (`SELECT DISTINCT tag … WHERE <earlier filters>`), `tbname` included.
- **Aggregate panel:** window (`auto` keeps every series under the row cap, ~360 points like InfluxDB), fill, one series per child table / per tag / merged, max series, and mean, median ≈, min, max, sum, count, first, last, spread, stddev.
- **Views:** graph (line, step, points; crosshair tooltip with every series), single stat, table.
- **SQL tab:** shows the generated SQL; edit it or write your own read-only query (Ctrl+Enter).
- **Entry points:** the app toolbar / command palette, and **Open in TDengine Data Explorer** on a table's context menu. A child table opens as its supertable filtered to that `tbname`.

## How it works

It is a frontend-only (`universal`) plugin. There is no sidecar and no driver: every query goes through the Host API `window.dbxPlugin.queryData` on the TDengine connection DBX already has open, so DBX keeps credentials, tunnels and the read-only check. DBX asks once per connection before the first query; the grant can be revoked in Plugin Center.

A builder query looks like this (TDengine 3.x):

```sql
SELECT TO_ISO8601(_wstart, 'Z') AS _time, tbname, AVG(`current`) AS `avg(current)`
FROM `power`.`meters`
WHERE `ts` >= NOW - 1h
  AND `ts` < NOW
  AND `location` IN ('California.SanFrancisco')
PARTITION BY tbname
INTERVAL(10s)
SLIMIT 20
```

Metadata comes from `information_schema.ins_databases`, `ins_stables`/`ins_tables` and `DESCRIBE`.

Permissions: `host.data:read` (queries), `host.connections:read` (connection picker), `host.storage` (builder state per tab). Requires Host API `^1.4`.

## Develop

```bash
npm install
npm run build          # src/ -> ui/ (one chunk on purpose, see vite.config.js)
npm test               # SQL builder and series pivot
TDENGINE_URL=http://localhost:6041 npm test   # also runs every generated query on a real TDengine
npx @dbx-app/plugin-cli package .             # dist/*-universal.dbxp (unsigned)
```

The integration test expects `taosBenchmark -y -d power` data. `dbx-plugin dev` (the SDK browser host) only mocks the Host API and cannot run `queryData`, so test data flows in a real DBX:

1. Plugin Center → Settings → enable **Allow unsigned development packages**, then install the `.dbxp`. The web/Docker build additionally needs `DBX_ALLOW_UNSIGNED_PLUGINS=1` on the server.
2. Connect to a TDengine connection, then open the builder from the toolbar icon or a table's context menu.

## Limits

- `queryData` returns at most 5000 rows; a truncated result says so in the status line. Shorten the range, widen the window or lower max series.
- DBX cannot scope context-menu entries to one database type, so the table menu entry also shows on other connections; the builder refuses non-TDengine connections without querying them.
- Timestamps in hand-written SQL are read in the server time zone with one fixed offset (`SELECT timezone()`); builder queries are exact because they use `TO_ISO8601(…, 'Z')`.
- Not included: auto-refresh, saved queries, a `result-view` for the SQL editor, raw (non-aggregated) builder mode, plugin UI translations.

## Publishing

Plugin ID `io.github.andersou.tdengine-data-explorer`, publisher `andersou`. A GitHub release runs `.github/workflows/plugin-release.yml`, which builds the unsigned candidate for DBX Store review.

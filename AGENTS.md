# AGENTS.md

Guide for coding agents working on this repository. Read `README.md` for what the plugin does and `docs/dbx-plugin-system.md` for how DBX plugins work; this file covers how to change the code safely.

## What this is

A frontend-only DBX plugin (Svelte 5 + Vite 7, ECharts 6) that builds TDengine 3.x SQL from InfluxDB-style cards and charts the result. Every query runs through `window.dbxPlugin.queryData` on a TDengine connection DBX already has open. There is no sidecar and no driver in this repository.

## Layout

| Path | Role |
| --- | --- |
| `manifest.json` | Plugin identity, permissions (`host.data:read`, `host.connections:read`, `host.storage`), contributions (workbench, command + toolbar/palette menus, table context menu) |
| `src/lib/sql.js` | Pure SQL generation: builder query, metadata queries, quoting, auto window, row cap |
| `src/lib/series.js` | Pure pivot of a `queryData` result into chart series; timestamp parsing |
| `src/App.svelte` | State, host calls (serial `run()` queue), metadata effects, context handling, state persistence, layout |
| `src/FilterCard.svelte` | One cascading tag filter card (fetches its own values) |
| `src/Picker.svelte` | Searchable single/multi-select list used by the cards |
| `src/Chart.svelte` | ECharts wrapper: validated palette, DBX theme tokens, axis tooltip |
| `test/` | `node:test` suites; `tdengine.test.js` runs generated SQL on a real TDengine |
| `docs/` | Plugin system notes and README screenshots |
| `ui/`, `dist/` | Build output and packages (gitignored) |

## Commands

```bash
npm install
npm run build                                   # src/ -> ui/
npm test                                        # unit tests
TDENGINE_URL=http://localhost:6041 npm test     # + every SQL shape on a real TDengine (needs taosBenchmark -y -d power data)
npx @dbx-app/plugin-cli package .               # dist/*-universal.dbxp
```

Run `npm test` and `npm run build` before every commit. Run the TDengine suite whenever `src/lib/sql.js` changes.

## Invariants

- **Data path:** only `window.dbxPlugin.queryData`, always through `run()` in `App.svelte`. The host rejects a fifth concurrent call instead of queueing it, so never call `queryData` directly.
- **SQL:** one read-only statement per call, never `USE`. Use fully qualified backticked names via `quoteIdent`, literals via `quoteString`/`literal`, and do not pass `database`/`schema` to `queryData` (the TDengine agent turns them into `USE`).
- **Timestamps:** builder queries select `TO_ISO8601(_wstart, 'Z') AS _time`; the agent otherwise returns offset-less strings in the server time zone.
- **Row cap:** `queryData` returns at most `MAX_ROWS` (5000). `autoWindow` and `SLIMIT` keep builder results under it; keep that true for any new query shape and extend the "under the row cap" test.
- **TDengine syntax:** `FILL(VALUE, …)` needs one value per aggregate column; `DISTINCT` tag queries are the cascade; `DESCRIBE` provides columns and tags (`note = "TAG"`).
- **Bundle:** one JS chunk and one CSS file. No dynamic `import()` and no lazily injected CSS: DBX inlines the entry module on the web build. Keep ECharts imports piecewise (`echarts/core` plus the charts and components in use).
- **Sandbox:** no `localStorage` (opaque origin), no network. Persist through `saveState` (`host.storage`, 256 KiB per value, 1 MiB total, pruned to 20 tab states).
- **Host features:** gate optional APIs on `host.capabilities?.x`; older hosts and the SDK dev host omit them.
- **UI:** use the DBX UI kit classes (`dbx-card`, `dbx-btn`, `dbx-select`, …) and `--color-*` tokens so light/dark and custom palettes follow DBX. Chart colors come from the validated 8-slot palette in `Chart.svelte`; series 9+ are gray. Do not add hues.
- **Untrusted text:** database values reach the DOM only through Svelte interpolation; never `{@html}`.
- **Context menu:** the table menu entry shows on every database type (DBX cannot scope it without a sidecar). The workbench must keep refusing non-TDengine connections without querying them, so no consent prompt appears for them.
- **Restoring a tab never runs a query:** state restore and context changes only load metadata; the user presses Submit.

## Testing in a real DBX

`dbx-plugin dev` only mocks the Host API (no `queryData`), so data paths must be checked in DBX itself:

1. Run `tdengine/tdengine` and `t8y2/dbx` (with `-e DBX_ALLOW_UNSIGNED_PLUGINS=1`) on one Docker network. Seed with `taosBenchmark -y -d power` inside the TDengine container (it writes identical series; insert your own for distinct ones).
2. In DBX: Driver Manager → install TDengine; New Connection → TDengine (host = the TDengine container, port 6041, `root`/`taosdata`).
3. Plugin Center → Settings → *Allow unsigned development packages* → install `dist/*.dbxp`. Reinstalling the same version needs Uninstall first.
4. The web build asks for data consent with `window.confirm`; headless browsers dismiss it unless the automation accepts dialogs, and a denial sticks until the tab is reopened.
5. Check: databases load, cascading filters narrow, Submit draws series, single stat and table views, SQL tab, table context menu (supertable and child table), dark theme.

Screenshots in `docs/screenshots/` were captured this way at 1920×1080; refresh them when the UI changes visibly.

## Releasing

- `com.example.tdengine-query-builder` and publisher `example` are placeholders; replace them (and the contribution IDs that repeat the plugin ID, plus `source`/`homepage`) before the first public release.
- Bump `version` in `manifest.json` for every release; installed versions are immutable.
- A GitHub release runs `.github/workflows/plugin-release.yml`, which builds the unsigned candidate for DBX Store review and signing.

## Not built yet

Auto-refresh, saved queries, a `result-view` for the SQL editor, raw (non-aggregated) builder mode, plugin UI translations. Keep new features in the same shape: pure logic in `src/lib` with `node:test` coverage, UI in Svelte components.

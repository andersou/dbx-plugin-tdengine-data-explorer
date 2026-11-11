# AGENTS.md

Guide for coding agents working on this repository. Read `README.md` for what the plugin does and `docs/dbx-plugin-system.md` for how DBX plugins work; this file covers how to change the code safely.

## What this is

TDengine Data Explorer (`dbx-plugin-tdengine-data-explorer`): a frontend-only DBX plugin (Svelte 5 + Vite 7, ECharts 6) that builds TDengine 3.x SQL from InfluxDB-style cards and charts the result. Every query runs through `window.dbxPlugin.queryData` on a TDengine connection DBX already has open. There is no sidecar and no driver in this repository.

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
| `.github/workflows/ci-release.yml`, `release.config.mjs`, `scripts/semantic-release.mjs` | CI, `.dbxp` packaging and semantic-release (same layout as `andersou/webdiffviewer`) |
| `ui/`, `dist/` | Build output and packages (gitignored) |

## Commands

```bash
npm install
npm run build                                   # src/ -> ui/
npm test                                        # unit tests
TDENGINE_URL=http://localhost:6041 npm test     # + every SQL shape on a real TDengine (needs taosBenchmark -y -d power data)
npx dbx-plugin package .                        # dist/*-0.0.0-dev-universal.dbxp
GH_TOKEN=$(gh auth token) npm run release:dry-run -- --no-ci   # next version semantic-release would publish
```

Run `npm test` and `npm run build` before every commit. Run the TDengine suite whenever `src/lib/sql.js` changes. Commit messages follow Conventional Commits because they decide the next version.

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
- **Restoring a tab never runs a query:** state restore, context changes and opening a saved query only load metadata; the user presses Submit. The auto-refresh interval stays out of `query` so it is never saved.
- **Auto-refresh** repeats the last submitted query (`lastRun`), skips ticks while running or zoomed, and turns itself off on any error.
- **Raw mode** (`window: "raw"`) is `ORDER BY ts DESC LIMIT MAX_ROWS` without `PARTITION BY`: under `ORDER BY`, TDengine sorts partitions as one stream, so per-series limits are not available in one query.
- **Strings:** every UI string goes through `t()` with keys in all three tables of `src/lib/i18n.js` (`test/i18n.test.js` enforces matching keys and placeholders). Validation errors from `sql.js` carry a `code` that is also a message key.
- **Saved queries** live in one global `host.storage` key (`saved`, newest first, `MAX_SAVED` 50) without `connectionId`; re-read before writing.

## Testing in a real DBX

`dbx-plugin dev` only mocks the Host API (no `queryData`), so data paths must be checked in DBX itself:

1. Run `tdengine/tdengine` and `t8y2/dbx` (with `-e DBX_ALLOW_UNSIGNED_PLUGINS=1`) on one Docker network. Seed with `taosBenchmark -y -d power` inside the TDengine container (it writes identical series; insert your own for distinct ones).
2. In DBX: Driver Manager → install TDengine; New Connection → TDengine (host = the TDengine container, port 6041, `root`/`taosdata`).
3. Plugin Center → Settings → *Allow unsigned development packages* → install `dist/*.dbxp`. Reinstalling the same version needs Uninstall first.
4. The web build asks for data consent with `window.confirm`; headless browsers dismiss it unless the automation accepts dialogs, and a denial sticks until the tab is reopened.
5. Check: databases load, cascading filters narrow, Submit draws series, single stat and table views, SQL tab, table context menu (supertable and child table), dark theme.

Screenshots in `docs/screenshots/` were captured this way at 1920×1080; refresh them when the UI changes visibly.

## Releasing

- Never change the plugin ID `io.github.andersou.tdengine-data-explorer` or its contribution IDs: DBX keys installs, data grants, storage and restored tabs by them.
- Never bump `version` by hand: `manifest.json` keeps `0.0.0-dev`, and `ci-release.yml` stamps the semantic-release version (or `0.0.0-dev.<sha>`) into it before packaging. No release commit is made.
- Versions come from Conventional Commits on `main`: `feat` → minor; `fix`, `perf`, `revert` → patch; breaking change → major; `docs`, `chore`, `ci`, `test`, `refactor`, `style`, `build` → no release. `develop` publishes `-beta` prereleases.
- A release `vX.Y.Z` carries the `.dbxp`, its `.artifact.json` and `SHA256SUMS`. DBX Store submission is still manual: a candidate PR to `t8y2/dbx-store` with the release asset URL and the `.artifact.json` values.

## Decided against

A `result-view` contribution for DBX's SQL editor: DBX already charts those results natively, the button would show on every database type (no dbType filter), and the snapshot is 500 rows without column types and with offset-less timestamps. Revisit only if DBX adds a dbType filter and column types.

Keep new features in the same shape: pure logic in `src/lib` with `node:test` coverage, UI in Svelte components, strings in `src/lib/i18n.js`.

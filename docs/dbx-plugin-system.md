# The DBX plugin system

A working map of how [DBX](https://github.com/t8y2/dbx) plugins are built, installed and run, written while building this plugin. Checked against DBX 0.6.68 (Host API 1.4.0, manifest v1, sidecar protocol v1) on 2026-11-10; file paths point into the `t8y2/dbx` repository. The official guide lives at <https://dbxio.com/en/docs/plugin-development> and `plugins/README.md`.

## 1. Big picture

A plugin is an optional, versioned `.dbxp` package installed into DBX's plugin store; nothing is bundled with DBX itself. A plugin can add:

- a sandboxed **UI** that opens as a DBX tab or bottom panel (a *workbench*),
- an optional **native sidecar** (Rust/Go binary) that DBX starts on demand,
- **saved connection types**, **filesystem providers**, **context-menu items**, **toolbar/palette commands**, **result-grid views** and **MCP tools**.

Three contracts hold it together:

| Contract | Defines | Source of truth |
| --- | --- | --- |
| Manifest v1 | identity, permissions, entrypoints, contributions | `plugins/manifest.schema.json` (editor/CI), re-validated in `crates/dbx-plugin-runtime/src/plugins/manifest.rs` |
| Host API 1.x | what the UI (`window.dbxPlugin`) and the sidecar may ask DBX for | `apps/desktop/src/lib/plugins/pluginHostBridge.ts`, `plugins/README.md` |
| Sidecar protocol v1 | JSON-RPC between DBX and the sidecar over stdio | `plugins/README.md` → *Backend protocol* |

```
DBX UI (Vue) ── postMessage bridge ── plugin iframe (window.dbxPlugin)
      │
      └── PluginHost (Rust) ── JSON-RPC over stdio ── plugin sidecar (optional)
```

`engines.host_api` (for example `^1.4`) declares the Host API floor; `capabilities` in the init message tells the UI what the running host actually offers.

## 2. Packages, installation and trust

```
vendor.example-1.0.0-<target>.dbxp     # ZIP with stricter rules
├── manifest.json
├── checksums.json                     # SHA-256 of every other file
├── signature.json                     # Ed25519 repository signature (absent on dev builds)
├── bin/<target>/<executable>          # only for sidecar plugins
├── assets/                            # icons
└── ui/                                # built UI (entry + assets)
```

- **Targets:** `universal` for frontend-only plugins, otherwise one package per platform (`darwin-arm64`, `linux-x64`, `windows-x64`, …).
- **Verification:** every file must be in `checksums.json`; absolute paths, `..`, symlinks, duplicates and decompression bombs are rejected; 512 MiB per package, 256 MiB per file, 10 000 entries.
- **Versions are immutable:** reinstalling the same version needs an uninstall first; activation records allow rollback. Uninstall drops the plugin's data grants and is blocked while saved connections still use it.
- **Signatures:** marketplace and normal installs require a signature from a trusted repository key. Unsigned packages need *Plugin Center → Settings → Allow unsigned development packages*; the web/Docker build also needs `DBX_ALLOW_UNSIGNED_PLUGINS=1` on the server.
- **Marketplace:** DBX ships one managed official repository (catalog in `t8y2/dbx-store`, keys built into DBX) and lets users add custom repositories with their own keys. Review decides what is listed; the catalog SHA-256 and the signature prove the bytes are the reviewed ones; runtime permissions limit what the code can ask for.

## 3. Manifest v1

```json
{
  "manifest_version": 1,
  "id": "vendor.example",
  "name": "Example",
  "version": "1.0.0",
  "publisher": "vendor",
  "icon": "assets/plugin.svg",
  "engines": { "dbx": ">=0.5.68", "host_api": "^1.4" },
  "permissions": ["host.data:read"],
  "entrypoints": {
    "ui": { "root": "ui", "entry": "ui/index.html" },
    "backend": { "executable": "bin/linux-x64/example", "transport": "stdio-jsonl" }
  },
  "contributions": [],
  "localizations": { "zh-CN": { "name": "示例" } }
}
```

- `id` matches `^[a-z0-9][a-z0-9._-]*$` (reverse-domain by convention), `version` is strict semver, `publisher` is required.
- `localizations` translate the plugin name, description and every contribution label, form field and action; DBX picks the exact locale, then the base language, then the default text.

### Permissions

| Permission | Grants |
| --- | --- |
| `host.data:read` | `queryData`: one read-only SQL statement on connections the user consented to |
| `host.connections:read` | `getConnections()`: secret-free summaries of every saved connection |
| `host.schema:read` | `getTableMetadata()` for one table on an open connection |
| `host.plans:read` | `getPlanCapabilities()` / `explainPlan()` (estimated plans only) |
| `host.storage` | small JSON store per plugin (256 KiB per value, 1 MiB total) |
| `host.workbench` | `openWorkbench`, `setTitle`/`getTitle`, `executeCommand` |
| `host.filesystem` | `openFilesystem` (host file manager on a filesystem provider) |
| `host.events`, `host.binary` | sidecar notifications and binary frames delivered to the UI |
| `host.ai` | open AI-panel conversations, set recommendation chips, optional text completion |
| `host.clipboard:read` | clipboard reads (with a per-session consent) |
| `host.network:https://origin` | adds that origin to the UI's `connect-src` (max 8, https only) |
| `host.openUrl:http(s)://origin` | open external URLs on that origin |

Without a permission the bridge rejects the call before anything else runs. Permissions never cover the native sidecar, which runs with the user's OS privileges.

## 4. Contribution types

| Type | What it adds | Needs |
| --- | --- | --- |
| `connection-provider` | A saved connection type for non-built-in targets: declarative form fields (bound to `name`/`host`/`port`/`username`/`password`/`database`, `config` or `secret`), conditional fields, file pickers, test/connect/disconnect lifecycle, custom dialog actions, `proxy_route` for multi-endpoint protocols. Opening the connection shows its `workbench` or `filesystem_provider`. | backend |
| `workbench` | A DBX tab (or dock panel) rendering the plugin UI. | `ui` |
| `result-view` | A button beside SQL-editor result grids that opens the UI with a snapshot of the result. | `ui` |
| `context-menu` | A native item in the sidebar `connection` or `table` menu. Three forms: declarative `action: { type: "open-workbench" }`, legacy backend call `contextMenu/<id>`, or `dynamic: true` (backend resolves items and one submenu level on each right-click). | backend unless declarative |
| `command` + `menus` | Commands (`open-workbench` as `tab` or `panel`, optional `options_action` launch picker) placed on `appToolbar` (only with `default_visible: true`) and `commandPalette`. Groups: `navigation`, `primary`, `secondary`, `destructive`. `appSidebar` validates but is not rendered in 0.6.68. | `ui` |
| `filesystem-provider` | URI schemes, `root_uri`, capabilities (`read`, `write`, `delete`, `rename`, `mkdir`); DBX owns the file-manager UI, the sidecar implements `filesystem/*`. | backend |
| `mcp` | Marks the plugin as providing MCP tools (`mcp/tools`, `mcp/call`) for the built-in AI agent and, with `external_tools` plus per-tool `access` levels, the external `dbx` MCP server. | backend |
| `capabilities` (top level) | Typed extension points such as `redis-value-codec-v1` (Redis value decoders). | backend |

Limits worth knowing:

- Static context-menu items show on **every** connection type: the `when`/`enablement` keys (`connection.state`, `object.type`, `surface`, `readOnly`) carry no database type. Only a `dynamic` menu (sidecar) can hide itself per connection.
- A workbench opened from the table menu is reused per plugin + workbench + connection; later invocations push a new context instead of reloading the iframe.

## 5. The UI sandbox

- The UI runs in an `<iframe srcdoc sandbox="allow-scripts">`: opaque origin, no parent DOM, no Tauri object, no cookies, `localStorage` or IndexedDB. Persist state with `host.storage`.
- CSP injected by the host:

  ```
  default-src 'none'; script-src 'unsafe-inline' blob: <asset>; style-src 'unsafe-inline' blob:;
  img-src data: blob: <asset>; font-src data: blob: <asset>; connect-src 'none' | <declared origins>;
  media-src data: blob: <asset>
  ```

  `<asset>` is `dbx-plugin:` (or `http(s)://dbx-plugin.localhost` on WebView2) on desktop. `'unsafe-eval'` is only added when the user turns on the plugin's *Graphics engine* switch (WebGL libraries).
- **Asset loading** (`apps/desktop/src/lib/plugins/pluginUiHtmlCache.ts`): DBX reads the entry HTML and inlines classic `<script src>` and `<link rel="stylesheet">` files. In packaged desktop builds a `type="module"` entry keeps its URL (rewritten to `dbx-plugin://localhost/<id>/…`) so its imports resolve; the web build and `tauri dev` inline it instead. Lazy chunks and JS-injected stylesheets therefore do not load everywhere: ship a single JS chunk and one CSS file. `fetch()` of your own files is blocked; use `readAsset`/`readAssetUrl`. Max 32 MiB per UI file.
- **Injected before your code:** CSP, `<base>`, the official UI kit CSS, the current theme and the SDK that defines `window.dbxPlugin`.
- **Theme:** DBX copies every root `--color-*`, `--radius-*` and `--font-*` token onto the iframe's `:root`, sets `data-dbx-theme="light|dark"`, and on changes dispatches `dbx-plugin-env` on `document`.
- **UI kit classes:** `dbx-card`, `dbx-section-title`, `dbx-btn` (`--primary`, `--danger`, `--ghost`), `dbx-label`, `dbx-input`, `dbx-select`, `dbx-textarea`, `dbx-hint`, `dbx-row`, `dbx-table`, `dbx-badge`, `dbx-link`.
- **Bridge limits:** 2 MiB per request, 8 MiB per binary message.

## 6. `window.dbxPlugin`

| Area | Members |
| --- | --- |
| Lifecycle | `ready` (Promise of the first context), `context`, `onContext(fn)`, `onInit(fn)`, `contributionId`, `locale`, `theme`, `capabilities` |
| Data | `queryData(req)`, `getConnections()`, `getTableMetadata(ctx)`, `getPlanCapabilities(id)`, `explainPlan(req)` |
| Workbench | `openWorkbench(id, ctx)`, `setTitle`/`getTitle`, `executeCommand(id, ctx)`, `closeWorkbench`, `workbench.onClose(fn)`, `openFilesystem(id, ctx)` |
| Storage | `storage.get/set/delete` |
| AI | `ai.openConversation`, `ai.setRecommendations`/`clearRecommendations`, `ai.listModels`/`generateText` (behind capabilities) |
| Sidecar | `invoke(method, params, { timeoutMs })`, `notify`, `sendBinary`, `onEvent`, `onBinary` |
| Misc | `readAsset`, `readAssetUrl`, `saveFile`, `copy`, `clipboard.*`, `floating.*` (desktop only) |

Gate optional features on `capabilities` (`dataApi`, `connectionsApi`, `storage`, `schemaMetadataApi`, `planApi`, `ai*`, `floating`, …); older hosts and the SDK dev host omit them.

### Context by entry point

| Opened from | `context` |
| --- | --- |
| Table context menu | `{ connectionId, database?, schema?, table }` (supertables and child tables both arrive as `table`; TDengine has no schema) |
| Connection context menu | `{ id, dbType, name, database }` plus `connectionId` |
| Command (toolbar/palette) | `{ ...action.context, workbenchId, restored, surface: "tab" \| "dock" }`, no connection |
| `result-view` button | `{ connectionId, database, schema, sql, result: { columns, rows (≤ 500), truncated } }` |
| Plugin connection | connection id and non-secret navigation context; *New Query* adds `newQuery` and `sourceWorkbenchId` |

## 7. Reading data with `queryData`

```js
const { dbType, columns, rows, truncated, elapsedMs } = await window.dbxPlugin.queryData({
  connectionId, sql, maxRows: 5000, timeoutMs: 60000, // database?, schema?
});
// columns: [{ name, dataType? }], rows: positional arrays
```

The host decides everything (`crates/dbx-core/src/query/plugin_data.rs`):

- **Consent per plugin and connection.** The first query asks the user (native dialog on desktop, `window.confirm` on the web build). Grants persist in `app_settings.plugin_data_grants` and are revocable in Plugin Center; a denial is remembered for that bridge session.
- **Open SQL connections only**; DBX never connects on the plugin's behalf.
- **Exactly one read-only statement.** The shared classifier (`crates/dbx-sql-core/src/sql_risk.rs`) parses with sqlparser; when vendor syntax does not parse it falls back to a keyword check (first keyword `SELECT`/`WITH`/`SHOW`/`DESCRIBE`/`EXPLAIN`, no write verbs). `USE` and other session switches are rejected.
- **Bounds:** `maxRows` 500 by default, 5000 max (one probe row sets `truncated`); 8 MiB of rows; timeout clamped to the connection timeout and 60 s; at most 4 queries in flight per bridge (the 5th is rejected, not queued).
- **No rewriting:** the SQL reaches the driver as written (trimmed). The server computes the full result, so bound it yourself (`LIMIT`, `SLIMIT`, a window).

TDengine specifics (`agents/drivers/tdengine/`):

- DBX talks to TDengine through a Rust agent on the taos WebSocket connector (taosAdapter, default port 6041).
- `schema` overrides `database`, and either triggers `USE` with an identifier-only name; prefer fully qualified, backticked names and omit both.
- `TIMESTAMP` values arrive as strings without an offset, in the server time zone (`SELECT timezone()`); `TO_ISO8601(ts, 'Z')` gives exact UTC strings.
- Integers are JSON numbers (precision is lost beyond 2^53), `NaN`/`inf` arrive as strings, `VARBINARY` as `{ "$binary": … }`; `dataType` uses TDengine type names.

## 8. Native sidecar (optional)

- One persistent child process per plugin, started on demand; stdin/stdout carry the protocol, logs go to stderr.
- Transports: `stdio-jsonl` (one JSON-RPC message per line, 8 MiB each) or `stdio-framed` (5-byte header, JSON and binary channels, 64 MiB frames).
- Handshake: DBX sends `plugin/initialize` (host and API versions, permissions); the plugin answers with `protocolVersion`, capabilities and its identity, which must match the manifest.
- Methods follow the contributions: `connection/test|connect|disconnect|action`, `contextMenu/<id>`, `contextMenu/resolve/<id>`, `filesystem/*`, `mcp/tools|call`, `redis/codec/decode`, plus any method the UI calls through `invoke` (always bound to the owning plugin).
- Host callbacks (Host API ≥ 1.1): `host/requestUserInput` for MFA codes, confirmations and choices.
- SDKs: `plugins/sdk/rust/dbx-plugin-sdk`, `plugins/sdk/go/dbx-plugin-sdk`.

## 9. Tooling and release

- CLI: `npm install --global @dbx-app/plugin-cli` (or `npx @dbx-app/plugin-cli`):
  - `dbx-plugin create <dir> --template frontend|svelte|rust|go`
  - `dbx-plugin package .` → `dist/<id>-<version>-<target>.dbxp` + `.artifact.json` (always unsigned)
  - `dbx-plugin dev --path . --port 5190` (Node 22+)
  - `dbx-plugin keygen` (custom repository signing keys)
- `dbx-plugin.toml`: `[package] include = [...]`, `[dev] ui_build/ui_watch` commands.
- The dev host is mock-only: no `queryData`, one fake SQLite connection, no `capabilities`, no UI kit. Test data paths in a real DBX.
- Release: the `dbx-plugin create` templates ship `.github/workflows/plugin-release.yml` (calling `t8y2/dbx`'s reusable workflow), which builds unsigned candidates on a GitHub release (this repository replaces it with `ci-release.yml` and semantic-release); DBX Store (`t8y2/dbx-store`) reviews them, signs approved bytes and publishes the catalog entry. Plugin source stays in the author's repository; `t8y2/dbx` only takes host, SDK, CLI, schema and documentation changes.

## 10. Security model in one list

- Package authenticity: checksums plus trusted Ed25519 repository keys.
- UI isolation: sandboxed iframe, restrictive CSP, bounded bridge payloads, calls rebound to the owning plugin (a UI cannot call another plugin).
- Secrets: connection secrets live in DBX's secret store, never in `config_json`, and never reach the UI.
- Data: `host.data:read` is per-connection consent, read-only, revocable; `host.connections:read` returns no credentials.
- Native sidecars are trusted code with OS user privileges; a signature identifies who published them, not that they are harmless.

## 11. Where to read the source

| Topic | File |
| --- | --- |
| Platform overview | `plugins/README.md`, `docs/content/docs/plugin-development.mdx` |
| Manifest schema / validation | `plugins/manifest.schema.json`, `crates/dbx-plugin-runtime/src/plugins/manifest.rs` |
| Bridge, SDK, CSP, UI kit | `apps/desktop/src/lib/plugins/pluginHostBridge.ts` |
| Workbench host (theme, connections, consent) | `apps/desktop/src/components/plugins/PluginWorkbenchHost.vue` |
| UI asset inlining | `apps/desktop/src/lib/plugins/pluginUiHtmlCache.ts` |
| Menus and commands | `apps/desktop/src/lib/plugins/frontendPlugin.ts`, `pluginCommandRegistry.ts` |
| `queryData` backend | `crates/dbx-core/src/query/plugin_data.rs` |
| Read-only classifier | `crates/dbx-sql-core/src/sql_risk.rs` |
| Package install and limits | `crates/dbx-plugin-runtime/src/plugins/installer.rs`, `assets.rs` |
| Official example | `plugins/examples/hello-workbench` |
| CLI, templates, dev host | `plugins/sdk/cli`, `plugins/sdk/dev-host` |

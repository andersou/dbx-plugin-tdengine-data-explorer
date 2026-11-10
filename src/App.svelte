<script>
  import Chart from "./Chart.svelte";
  import FilterCard from "./FilterCard.svelte";
  import Picker from "./Picker.svelte";
  import { lastValue, parseOffset, toSeries } from "./lib/series.js";
  import {
    FUNCTIONS,
    MAX_ROWS,
    RANGES,
    WINDOWS,
    autoWindow,
    buildQuery,
    databasesQuery,
    describeQuery,
    durationMs,
    isFilterableType,
    isNumericType,
    parentTableQuery,
    tablesQuery,
    tagValuesQuery,
    timeRange,
    timezoneQuery,
  } from "./lib/sql.js";

  const host = window.dbxPlugin;
  const VIEWS = [
    ["graph", "Graph"],
    ["stat", "Single stat"],
    ["table", "Table"],
  ];
  const KINDS = [
    ["line", "Line"],
    ["step", "Step"],
    ["points", "Points"],
  ];
  const FILL_LABELS = { none: "none", null: "null (gaps)", prev: "previous", linear: "linear", zero: "zero" };
  const FN_ITEMS = Object.keys(FUNCTIONS).map((fn) => ({ value: fn, label: { avg: "mean", median: "median ≈" }[fn] ?? fn }));
  const DEFAULT_QUERY = {
    connectionId: "",
    database: "",
    table: "",
    fields: [],
    fns: ["avg"],
    filters: [],
    groupBy: "tbname",
    // Like the InfluxDB builder's createEmpty: false; NULL windows between sparse points would hide the lines.
    fill: "none",
    window: "auto",
    maxSeries: 20,
    range: { type: "relative", value: "1h" },
    mode: "builder",
    sql: "",
    view: "graph",
    kind: "line",
  };
  const EMPTY_META = { tsColumn: "", fields: [], tags: [], tagTypes: {}, isSuper: false };
  const MAX_STATES = 20;
  const newId = () => Math.random().toString(36).slice(2);
  const toLocalInput = (ms) => new Date(ms - new Date(ms).getTimezoneOffset() * 60e3).toISOString().slice(0, 16);
  const numberFormat = new Intl.NumberFormat(host.locale, { maximumFractionDigits: 3 });

  let query = $state(structuredClone(DEFAULT_QUERY));
  let allConnections = $state([]);
  let databases = $state([]);
  let tables = $state([]);
  let meta = $state(EMPTY_META);
  let result = $state(null);
  let series = $state([]);
  let running = $state(false);
  let error = $state("");
  let ready = $state(false);
  let reloadTick = $state(0);
  let dark = $state(false);
  let themeTick = $state(0);
  let offset = "+00:00";
  let stateKey = "default";

  const connections = $derived(allConnections.filter((connection) => connection.dbType === "tdengine"));
  const current = $derived(allConnections.find((connection) => connection.id === query.connectionId));
  const unsupported = $derived(current && current.dbType !== "tdengine");
  const tagKeys = $derived(meta.isSuper ? ["tbname", ...meta.tags.map((tag) => tag.name)] : []);
  const builderSql = $derived.by(() => {
    try {
      return buildQuery(query, meta);
    } catch {
      return "";
    }
  });
  const autoLabel = $derived.by(() => {
    try {
      return autoWindow(timeRange(query.range).ms, query.groupBy ? query.maxSeries : 1);
    } catch {
      return "";
    }
  });

  // queryData rejects a 5th concurrent call; one at a time also spares the pool DBX tabs share.
  let queue = Promise.resolve();
  function run(sql, maxRows = MAX_ROWS) {
    const connectionId = query.connectionId;
    const next = queue.then(() => host.queryData({ connectionId, sql, maxRows, timeoutMs: 60000 }));
    queue = next.catch(() => {});
    return next;
  }

  function explain(e) {
    const message = String(e?.message ?? e);
    return /not open/i.test(message) ? "This connection is closed. Connect to it in DBX, then press ⟳." : message;
  }

  // Applies a load result unless a newer run of the same effect replaced it.
  function track(promise, apply) {
    let stale = false;
    promise.then(
      (value) => !stale && apply(value),
      (e) => !stale && (error = explain(e)),
    );
    return () => (stale = true);
  }

  const canQuery = () => ready && query.connectionId && !unsupported;

  $effect(() => {
    void reloadTick;
    if (!canQuery()) return;
    return track(Promise.all([run(databasesQuery()), run(timezoneQuery())]), ([dbs, timezone]) => {
      databases = dbs.rows.map(([name]) => name);
      offset = parseOffset(timezone.rows[0]?.[0]);
    });
  });

  $effect(() => {
    void reloadTick;
    if (!canQuery() || !query.database) return void (tables = []);
    return track(run(tablesQuery(query.database)), ({ rows }) => (tables = rows.map(([name, kind]) => ({ name, kind }))));
  });

  $effect(() => {
    void reloadTick;
    if (!canQuery() || !query.database || !query.table) return void (meta = EMPTY_META);
    return track(run(describeQuery(query.database, query.table)), ({ rows }) => applyMeta(rows));
  });

  function applyMeta(rows) {
    const columns = rows.map(([name, type, , note]) => ({ name, type, tag: note === "TAG" }));
    const tags = columns.filter((column) => column.tag && isFilterableType(column.type));
    const fields = columns.filter((column) => !column.tag && isNumericType(column.type));
    meta = {
      tsColumn: columns.find((column) => !column.tag && /^TIMESTAMP/i.test(column.type))?.name ?? "",
      fields,
      tags,
      tagTypes: Object.fromEntries(tags.map((tag) => [tag.name, tag.type])),
      isSuper: columns.some((column) => column.tag),
    };
    // Keep only selections that still exist in this table.
    query.fields = query.fields.filter((field) => fields.some((column) => column.name === field));
    if (!query.fields.length && fields[0]) query.fields = [fields[0].name];
    query.filters = query.filters.filter((filter) => !filter.key || tagKeys.includes(filter.key));
    if (query.groupBy && !tagKeys.includes(query.groupBy)) query.groupBy = tagKeys.length ? "tbname" : "";
  }

  function fetchTagValues(key, upstream) {
    const sql = tagValuesQuery({ database: query.database, table: query.table, key, filters: upstream, tagTypes: meta.tagTypes });
    void reloadTick;
    return run(sql).then(({ rows }) =>
      rows.map(([value]) => value).sort((a, b) => (a === null) - (b === null) || String(a).localeCompare(String(b), undefined, { numeric: true })),
    );
  }

  function addFilter() {
    const key = tagKeys.find((candidate) => !query.filters.some((filter) => filter.key === candidate)) ?? "";
    query.filters.push({ id: newId(), key, values: [] });
  }

  function setRange(value) {
    if (value !== "custom") return void (query.range = { type: "relative", value });
    const ms = query.range.type === "relative" ? durationMs(query.range.value) : 3600e3;
    query.range = { type: "absolute", start: toLocalInput(Date.now() - ms), stop: toLocalInput(Date.now()) };
  }

  let generatedSql = "";
  function setMode(mode) {
    // Entering the editor shows the builder's SQL unless the user already edited it.
    if (mode === "sql" && builderSql && (!query.sql || query.sql === generatedSql)) query.sql = generatedSql = builderSql;
    query.mode = mode;
  }

  async function submit() {
    error = "";
    let sql;
    try {
      sql = query.mode === "sql" ? query.sql.trim() : buildQuery(query, meta);
      if (!sql) throw new Error("Write a SELECT statement first");
    } catch (e) {
      return void (error = e.message);
    }
    running = true;
    try {
      result = await run(sql, MAX_ROWS);
      series = toSeries(result, { offset, labels: query.mode === "builder" && query.groupBy ? [query.groupBy] : [] });
    } catch (e) {
      error = explain(e);
    } finally {
      running = false;
    }
  }

  async function refreshConnections() {
    if (host.capabilities?.connectionsApi) allConnections = await host.getConnections().catch(() => allConnections);
  }

  async function reload() {
    error = "";
    await refreshConnections();
    reloadTick++;
  }

  async function applyContext(context) {
    if (!context?.connectionId) return;
    query.connectionId = context.connectionId;
    // The table menu shows on every connection type; never ask consent for a non-TDengine one.
    if (!context.database || !context.table || unsupported) return;
    query.database = context.database;
    // A child table opens as its supertable filtered to that child, like one InfluxDB series.
    const parent = await run(parentTableQuery(context.database, context.table)).then(
      ({ rows }) => rows[0]?.[0],
      () => null,
    );
    query.filters = parent ? [{ id: newId(), key: "tbname", values: [context.table] }] : [];
    // Same table keeps its fields: applyMeta, which picks a default field, only runs when the table changes.
    if ((parent || context.table) !== query.table) Object.assign(query, { table: parent || context.table, fields: [] });
  }

  async function saveState(snapshot) {
    try {
      const index = ((await host.storage.get("state-index")) ?? []).filter((key) => key !== stateKey);
      for (const stale of index.splice(MAX_STATES - 1)) await host.storage.delete(`state:${stale}`);
      await host.storage.set(`state:${stateKey}`, snapshot);
      await host.storage.set("state-index", [stateKey, ...index]);
    } catch (e) {
      console.warn("Could not save the query builder state", e); // best effort, queries are unaffected
    }
  }

  $effect(() => {
    const snapshot = $state.snapshot(query);
    if (!ready || !host.capabilities?.storage) return;
    const timer = setTimeout(() => saveState(snapshot), 500);
    return () => clearTimeout(timer);
  });

  host.ready.then(async (context) => {
    dark = host.theme?.appearance === "dark";
    stateKey = context?.workbenchId ?? context?.connectionId ?? "default";
    const saved = host.capabilities?.storage ? await host.storage.get(`state:${stateKey}`).catch(() => null) : null;
    if (saved) query = { ...structuredClone(DEFAULT_QUERY), ...saved };
    await refreshConnections();
    if (!query.connectionId && connections.length === 1) query.connectionId = connections[0].id;
    ready = true;
    await applyContext(context);
  });
  host.onContext(applyContext);
  document.addEventListener("dbx-plugin-env", () => {
    dark = host.theme?.appearance === "dark";
    themeTick++;
  });
</script>

<svelte:head><title>TDengine Query Builder</title></svelte:head>

<main class="app">
  <header class="toolbar">
    <select
      class="dbx-select"
      aria-label="Connection"
      value={query.connectionId}
      onfocus={refreshConnections}
      onchange={(e) => Object.assign(query, { connectionId: e.currentTarget.value, database: "", table: "", fields: [], filters: [] })}
    >
      <option value="" disabled>{connections.length ? "Choose a TDengine connection" : "No TDengine connection in DBX"}</option>
      {#each connections as connection (connection.id)}
        <option value={connection.id}>{connection.name}{connection.connected ? "" : " (not connected)"}</option>
      {/each}
      {#if query.connectionId && !connections.some((connection) => connection.id === query.connectionId)}
        <option value={query.connectionId}>{current?.name ?? "Current connection"}</option>
      {/if}
    </select>
    <button class="dbx-btn dbx-btn--ghost" type="button" title="Reload connections and metadata" aria-label="Reload" onclick={reload}>⟳</button>
    <span class="spacer"></span>
    <div class="segmented" role="group" aria-label="View">
      {#each VIEWS as [value, label] (value)}
        <button class="dbx-btn" class:dbx-btn--primary={query.view === value} type="button" aria-pressed={query.view === value} onclick={() => (query.view = value)}>{label}</button>
      {/each}
    </div>
    {#if query.view === "graph"}
      <select class="dbx-select" aria-label="Graph type" bind:value={query.kind}>
        {#each KINDS as [value, label] (value)}<option {value}>{label}</option>{/each}
      </select>
    {/if}
    <select class="dbx-select" aria-label="Time range" value={query.range.type === "relative" ? query.range.value : "custom"} onchange={(e) => setRange(e.currentTarget.value)}>
      {#each RANGES as range (range)}<option value={range}>Past {range}</option>{/each}
      <option value="custom">Custom range…</option>
    </select>
    {#if query.range.type === "absolute"}
      <input class="dbx-input" type="datetime-local" aria-label="Start" bind:value={query.range.start} />
      <input class="dbx-input" type="datetime-local" aria-label="Stop" bind:value={query.range.stop} />
    {/if}
    <button class="dbx-btn dbx-btn--primary" type="button" disabled={running || !query.connectionId || unsupported} onclick={submit}>Submit</button>
  </header>

  <section class="result">
    {#if unsupported}
      <p class="empty dbx-hint">This builder reads TDengine connections only; {current.name} is {current.dbType}.</p>
    {:else if query.view === "table" && result}
      <div class="table-wrap">
        <table class="dbx-table">
          <thead><tr>{#each result.columns as column, index (index)}<th>{column.name}</th>{/each}</tr></thead>
          <tbody>
            {#each result.rows.slice(0, 1000) as row, index (index)}
              <tr>{#each row as cell, cellIndex (cellIndex)}<td>{cell === null ? "NULL" : typeof cell === "object" ? JSON.stringify(cell) : cell}</td>{/each}</tr>
            {/each}
          </tbody>
        </table>
        {#if result.rows.length > 1000}<p class="dbx-hint">Showing 1000 of {result.rows.length} rows.</p>{/if}
      </div>
    {:else if query.view === "stat" && series.length}
      <div class="stat" class:dim={running}>
        <strong>{lastValue(series[0]) === null ? "—" : numberFormat.format(lastValue(series[0]))}</strong>
        <span class="dbx-hint">{series[0].name}{series.length > 1 ? ` · first of ${series.length} series` : ""}</span>
      </div>
    {:else if series.length}
      <Chart {series} kind={query.kind} {dark} {themeTick} loading={running} />
    {:else}
      <p class="empty dbx-hint">
        {running ? "Running…" : result ? (result.rows.length ? "The result has no time column; open the Table view." : "No data in this time range.") : "Build a query below, then press Submit."}
      </p>
    {/if}
  </section>

  <footer class="builder">
    <div class="tabs" role="tablist">
      <button class="tab" class:active={query.mode === "builder"} role="tab" aria-selected={query.mode === "builder"} type="button" onclick={() => setMode("builder")}>Query Builder</button>
      <button class="tab" class:active={query.mode === "sql"} role="tab" aria-selected={query.mode === "sql"} type="button" onclick={() => setMode("sql")}>SQL</button>
      <span class="status" class:error role="status">
        {#if error}{error}{:else if running}Running…{:else if result}{result.rows.length} rows · {result.elapsedMs} ms{result.truncated ? ` · truncated at ${MAX_ROWS} rows: shorten the range or widen the window` : ""}{/if}
      </span>
    </div>

    {#if query.mode === "builder"}
      <div class="builder-body">
        <div class="cards">
          <section class="dbx-card card">
            <h3 class="dbx-section-title">Database</h3>
            <Picker
              label="Database"
              items={databases.map((name) => ({ value: name, label: name }))}
              selected={[query.database]}
              onchange={([database]) => database !== query.database && Object.assign(query, { database, table: "", fields: [], filters: [] })}
            />
          </section>
          <section class="dbx-card card">
            <h3 class="dbx-section-title">Table</h3>
            <Picker
              label="Table"
              items={tables.map(({ name, kind }) => ({ value: name, label: name, hint: kind }))}
              selected={[query.table]}
              onchange={([table]) => table !== query.table && Object.assign(query, { table, fields: [], filters: [] })}
            />
          </section>
          <section class="dbx-card card">
            <h3 class="dbx-section-title">Fields</h3>
            <Picker multiple label="Fields" items={meta.fields.map(({ name, type }) => ({ value: name, label: name, hint: type }))} selected={query.fields} onchange={(fields) => (query.fields = fields)} />
          </section>
          {#each query.filters as filter, index (filter.id)}
            <FilterCard keys={tagKeys} bind:filter={query.filters[index]} upstream={query.filters.slice(0, index)} fetchValues={fetchTagValues} onremove={() => query.filters.splice(index, 1)} />
          {/each}
          {#if tagKeys.length}
            <button class="dbx-card card add" type="button" onclick={addFilter}>+ Filter</button>
          {/if}
        </div>
        <section class="dbx-card card aggregate">
          <h3 class="dbx-section-title">Aggregate</h3>
          <label><span class="dbx-label">Window</span>
            <select class="dbx-select" bind:value={query.window}>
              <option value="auto">auto ({autoLabel})</option>
              {#each WINDOWS as window (window)}<option value={window}>{window}</option>{/each}
            </select>
          </label>
          <label><span class="dbx-label">Fill</span>
            <select class="dbx-select" bind:value={query.fill}>
              {#each Object.entries(FILL_LABELS) as [value, label] (value)}<option {value}>{label}</option>{/each}
            </select>
          </label>
          {#if tagKeys.length}
            <label><span class="dbx-label">Series</span>
              <select class="dbx-select" bind:value={query.groupBy}>
                <option value="">one (merge all)</option>
                {#each tagKeys as key (key)}<option value={key}>per {key}</option>{/each}
              </select>
            </label>
            {#if query.groupBy}
              <label><span class="dbx-label">Max series</span><input class="dbx-input" type="number" min="1" max="100" bind:value={query.maxSeries} /></label>
            {/if}
          {/if}
          <div class="functions" role="group" aria-label="Functions">
            {#each FN_ITEMS as { value, label } (value)}
              <label title={FUNCTIONS[value]("x")}><input type="checkbox" bind:group={query.fns} {value} /> {label}</label>
            {/each}
          </div>
        </section>
      </div>
    {:else}
      <div class="sql">
        <textarea
          class="dbx-textarea"
          aria-label="SQL"
          spellcheck="false"
          bind:value={query.sql}
          onkeydown={(e) => (e.ctrlKey || e.metaKey) && e.key === "Enter" && submit()}
        ></textarea>
        <p class="dbx-hint">
          One read-only statement; Ctrl+Enter runs it. Charts use the first timestamp column, text columns name the series.
          <button class="dbx-link" type="button" disabled={!builderSql} onclick={() => (query.sql = generatedSql = builderSql)}>Copy the builder query</button>
        </p>
      </div>
    {/if}
  </footer>
</main>

<style>
  :global(html),
  :global(body),
  :global(#app) {
    height: 100%;
  }
  :global(body) {
    overflow: hidden;
  }
  .app {
    height: 100%;
    display: grid;
    /* minmax(0, ...) lets the card row scroll inside instead of widening the page. */
    grid-template-columns: minmax(0, 1fr);
    grid-template-rows: auto minmax(160px, 1fr) minmax(240px, 42%);
  }
  .toolbar {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
    padding: 8px 12px;
    border-bottom: 1px solid var(--color-border);
  }
  .toolbar .dbx-select,
  .toolbar .dbx-input {
    width: auto;
  }
  .spacer {
    flex: 1;
  }
  .segmented {
    display: flex;
  }
  .segmented .dbx-btn {
    border-radius: 0;
  }
  .segmented .dbx-btn:first-child {
    border-radius: var(--radius-md, 8px) 0 0 var(--radius-md, 8px);
  }
  .segmented .dbx-btn:last-child {
    border-radius: 0 var(--radius-md, 8px) var(--radius-md, 8px) 0;
  }
  .result {
    min-height: 0;
    padding: 8px 12px;
  }
  .empty {
    height: 100%;
    margin: 0;
    display: grid;
    place-content: center;
    text-align: center;
  }
  .table-wrap {
    height: 100%;
    overflow: auto;
  }
  .stat {
    height: 100%;
    display: grid;
    place-content: center;
    gap: 4px;
    text-align: center;
  }
  .stat strong {
    font-size: 56px;
    font-weight: 600;
    line-height: 1.1;
  }
  .dim {
    opacity: 0.5;
  }
  .builder {
    min-height: 0;
    display: flex;
    flex-direction: column;
    border-top: 1px solid var(--color-border);
  }
  .tabs {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 4px 12px 0;
  }
  .tab {
    padding: 6px 10px;
    border: 0;
    border-bottom: 2px solid transparent;
    background: none;
    color: var(--color-muted-foreground);
    font: inherit;
    cursor: pointer;
  }
  .tab.active {
    color: var(--color-foreground);
    border-bottom-color: var(--color-primary);
  }
  .status {
    margin-left: auto;
    padding-left: 12px;
    font-size: 12px;
    color: var(--color-muted-foreground);
    text-align: right;
  }
  .status.error {
    color: var(--color-destructive, #d03b3b);
  }
  .builder-body {
    flex: 1;
    min-height: 0;
    display: flex;
    gap: 8px;
    padding: 8px 12px 12px;
  }
  /* Like the InfluxDB builder: the card row scrolls, the aggregate panel stays put. */
  .cards {
    flex: 1;
    min-width: 0;
    display: flex;
    gap: 8px;
    overflow-x: auto;
  }
  .builder-body :global(.card) {
    flex: 0 0 210px;
    min-height: 0;
    display: flex;
    flex-direction: column;
    padding: 10px;
  }
  .cards .add {
    flex-basis: 96px;
    justify-content: center;
    color: var(--color-muted-foreground);
    font: inherit;
    cursor: pointer;
  }
  .builder-body .aggregate {
    flex-basis: 250px;
    gap: 6px;
  }
  .aggregate > label {
    display: grid;
    grid-template-columns: 76px 1fr;
    align-items: center;
    gap: 6px;
  }
  .functions {
    min-height: 0;
    overflow: auto;
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 2px 8px;
    margin-top: 4px;
  }
  .functions label {
    display: flex;
    align-items: center;
    gap: 6px;
    white-space: nowrap;
  }
  .sql {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
    padding: 8px 12px 12px;
  }
  .sql textarea {
    flex: 1;
    font-family: var(--font-mono, ui-monospace, monospace);
  }
  .sql p {
    margin: 6px 0 0;
  }
  .sql .dbx-link {
    padding: 0;
    border: 0;
    background: none;
    font: inherit;
  }
</style>

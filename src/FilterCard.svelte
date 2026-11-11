<script>
  import Picker from "./Picker.svelte";
  import { TAG_VALUES_LIMIT } from "./lib/sql.js";

  // One InfluxDB-style filter card: a tag key and its values, narrowed by the cards before it.
  let { t, keys, filter = $bindable(), upstream, fetchValues, onremove } = $props();
  let items = $state([]);
  let loading = $state(false);
  let error = $state("");

  $effect(() => {
    if (!filter.key) return void (items = []);
    let stale = false;
    loading = true;
    // fetchValues reads key and upstream synchronously, so both are tracked.
    fetchValues(filter.key, upstream, () => stale)
      .then((values) => {
        if (stale) return;
        items = values.map((value) => ({ value, label: value === null ? "(null)" : String(value) }));
        error = "";
        // A complete list proves a selection vanished; drop it so the query does not go silently empty.
        const kept = filter.values.filter((value) => values.includes(value));
        if (values.length < TAG_VALUES_LIMIT && kept.length !== filter.values.length) filter.values = kept;
      })
      .catch((e) => !stale && (error = e.message))
      .finally(() => !stale && (loading = false));
    return () => (stale = true);
  });
</script>

<section class="dbx-card card">
  <div class="head">
    <select class="dbx-select" aria-label={t("filterTag")} bind:value={filter.key} onchange={() => (filter.values = [])}>
      <option value="" disabled>{t("chooseTag")}</option>
      {#each keys as key (key)}<option value={key}>{key}</option>{/each}
    </select>
    <button class="dbx-btn dbx-btn--ghost" type="button" aria-label={t("removeFilter")} title={t("removeFilter")} onclick={onremove}>✕</button>
  </div>
  <Picker
    multiple
    {t}
    label={filter.key || t("tagValues")}
    {items}
    {loading}
    {error}
    selected={filter.values}
    onchange={(values) => (filter.values = values)}
    note={items.length >= TAG_VALUES_LIMIT ? t("firstValues", { n: TAG_VALUES_LIMIT }) : ""}
  />
</section>

<style>
  .head {
    display: flex;
    gap: 4px;
    margin-bottom: 6px;
  }
  .head select {
    flex: 1;
    min-width: 0;
  }
</style>

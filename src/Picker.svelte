<script>
  // Searchable single/multi-select list used by every builder card.
  let { t, items = [], selected = [], multiple = false, loading = false, error = "", note = "", label, onchange } = $props();
  let search = $state("");
  const visible = $derived(items.filter((item) => item.label.toLowerCase().includes(search.trim().toLowerCase())));

  function toggle(value) {
    if (!multiple) return onchange([value]);
    onchange(selected.includes(value) ? selected.filter((v) => v !== value) : [...selected, value]);
  }
</script>

<input class="dbx-input search" type="search" placeholder={t("search")} aria-label={t("searchIn", { label })} bind:value={search} />
<div class="list" class:loading role="group" aria-label={label}>
  {#each visible as item (item.value)}
    <label class="item">
      <input type={multiple ? "checkbox" : "radio"} name={label} checked={selected.includes(item.value)} onchange={() => toggle(item.value)} />
      <span class="name">{item.label}</span>
      {#if item.hint}<span class="hint">{item.hint}</span>{/if}
    </label>
  {:else}
    <p class="dbx-hint">{loading ? t("loading") : error || t("nothing")}</p>
  {/each}
</div>
{#if error && visible.length}<p class="dbx-hint error">{error}</p>{/if}
{#if note}<p class="dbx-hint">{note}</p>{/if}

<style>
  .search {
    width: 100%;
  }
  .list {
    flex: 1;
    min-height: 0;
    overflow: auto;
    margin-top: 6px;
  }
  .loading {
    opacity: 0.5;
  }
  .item {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 3px 4px;
    border-radius: 4px;
    cursor: pointer;
  }
  .item:hover {
    background: var(--color-accent, rgba(127, 127, 127, 0.12));
  }
  .name {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .hint {
    color: var(--color-muted-foreground);
    font-size: 11px;
  }
  .error {
    color: var(--color-destructive, #d03b3b);
  }
  p {
    margin: 6px 4px;
  }
</style>

// Saved queries: one list shared by every tab and connection, newest first.
export const MAX_SAVED = 50;

export const upsertSaved = (list, name, query) => [{ name, query }, ...list.filter((entry) => entry.name !== name)].slice(0, MAX_SAVED);

export const removeSaved = (list, name) => list.filter((entry) => entry.name !== name);

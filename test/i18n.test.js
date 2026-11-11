import assert from "node:assert/strict";
import test from "node:test";
import { MESSAGES, translate } from "../src/lib/i18n.js";

const placeholders = (text) => [...text.matchAll(/\{(\w+)\}/g)].map(([, name]) => name).sort();

test("every locale has the English keys and placeholders", () => {
  for (const [locale, table] of Object.entries(MESSAGES)) {
    assert.deepEqual(Object.keys(table).sort(), Object.keys(MESSAGES.en).sort(), locale);
    for (const [key, text] of Object.entries(table)) assert.deepEqual(placeholders(text), placeholders(MESSAGES.en[key]), `${locale}.${key}`);
  }
});

test("falls back to the same language, then English", () => {
  assert.equal(translate("zh-CN", "submit"), "提交");
  assert.equal(translate("zh-TW", "submit"), "提交");
  assert.equal(translate("pt", "submit"), "Executar");
  assert.equal(translate("fr", "submit"), "Submit");
  assert.equal(translate(undefined, "submit"), "Submit");
  assert.equal(translate("en", "missingKey"), "missingKey");
});

test("interpolates placeholders", () => {
  assert.equal(translate("en", "past", { range: "1h" }), "Past 1h");
  assert.equal(translate("pt-BR", "rowsStatus", { rows: 3, ms: 12 }), "3 linhas · 12 ms");
});

test("one row reads in the singular", () => {
  assert.equal(translate("en", "rowStatus", { rows: 1, ms: 5 }), "1 row · 5 ms");
  assert.equal(translate("pt-BR", "rowStatus", { rows: 1, ms: 5 }), "1 linha · 5 ms");
});

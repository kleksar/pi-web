import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  getLocalePlugin,
  getSupportedLocales,
} = await jiti.import("./registry.ts");

test("registers only the English interface locale", () => {
  assert.deepEqual(getSupportedLocales(), ["en"]);
  assert.equal(getLocalePlugin("en").id, "en");
  assert.equal(getLocalePlugin("en")?.label, "English");
  assert.equal(getLocalePlugin("zh-CN"), undefined);
  assert.equal(getLocalePlugin("zh-TW"), undefined);
  assert.equal(getLocalePlugin("missing"), undefined);
});

test("provides English interface and push messages", () => {
  const messages = getLocalePlugin("en").messages;
  for (const key of ["common.language", "settings.general", "i18n.sessionComplete", "i18n.taskFinished"]) {
    assert.ok(messages[key], `Missing English message: ${key}`);
  }
});

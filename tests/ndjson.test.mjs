import { test } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { ndjson } from "../src/http.mjs";

const collect = async (chunks) => {
  const out = [];
  for await (const value of ndjson(Readable.from(chunks))) out.push(value);
  return out;
};

test("parses objects split across chunk boundaries", async () => {
  // Ollama's stream does not align to chunk edges; a naive split would drop
  // or corrupt tokens here.
  const out = await collect(['{"a":1}\n{"b', '":2}\n{"c":3}', "\n"]);
  assert.deepEqual(out, [{ a: 1 }, { b: 2 }, { c: 3 }]);
});

test("emits a trailing object with no newline", async () => {
  assert.deepEqual(await collect(['{"done":true}']), [{ done: true }]);
});

test("skips blank lines and malformed fragments without throwing", async () => {
  const out = await collect(['{"a":1}\n\n', "not json\n", '{"b":2}\n']);
  assert.deepEqual(out, [{ a: 1 }, { b: 2 }]);
});

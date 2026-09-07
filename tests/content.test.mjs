import { test } from "node:test";
import assert from "node:assert/strict";
import { flattenContent } from "../src/openai.mjs";

// The OpenAI schema allows content as a string OR an array of typed parts.
// Ollama only accepts a string, so every shape a real client sends has to
// collapse to one here -- passing an array through returns a 400 from the
// runner that looks like a ShareGPU bug.
test("a plain string passes through", () => {
  assert.deepEqual(flattenContent("hello"), { text: "hello", images: [] });
});

test("an array of text parts is joined", () => {
  const out = flattenContent([{ type: "text", text: "a" }, { type: "text", text: "b" }]);
  assert.equal(out.text, "a\nb");
});

test("input_text parts are accepted too", () => {
  assert.equal(flattenContent([{ type: "input_text", text: "x" }]).text, "x");
});

test("null and undefined become empty, not the string 'null'", () => {
  assert.equal(flattenContent(null).text, "");
  assert.equal(flattenContent(undefined).text, "");
});

test("bare strings inside an array are kept", () => {
  assert.equal(flattenContent(["a", "b"]).text, "a\nb");
});

test("a data: image URL is extracted as bare base64", () => {
  const out = flattenContent([
    { type: "text", text: "look" },
    { type: "image_url", image_url: { url: "data:image/png;base64,AAAB" } },
  ]);
  assert.equal(out.text, "look");
  assert.deepEqual(out.images, ["AAAB"]);
});

test("a non-data image URL is dropped rather than sent as garbage", () => {
  const out = flattenContent([{ type: "image_url", image_url: { url: "https://example.com/a.png" } }]);
  assert.deepEqual(out.images, []);
});

test("unknown part types do not throw", () => {
  assert.equal(flattenContent([{ type: "audio", data: "..." }]).text, "");
});

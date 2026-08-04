import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

test("signup frontendはsafe error objectのmessageだけを表示する", async () => {
  const source = await readFile("src/pages/signup.astro", "utf8");
  assert.match(source, /typeof data\?\.error\?\.message === "string"/u);
  assert.doesNotMatch(source, /new Error\(data\?\.message \|\| data\?\.error \|\|/u);
});

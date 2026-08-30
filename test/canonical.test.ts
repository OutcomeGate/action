import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { digestNamedFiles } from "../src/canonical.js";

async function legacyFrame(
  files: ReadonlyArray<{ name: string; path: string }>,
): Promise<Buffer> {
  const parts = [Buffer.from("agentci.named-files.v1\0")];
  for (const file of files) {
    parts.push(
      Buffer.from(file.name),
      Buffer.from([0]),
      await readFile(file.path),
      Buffer.from([0]),
    );
  }
  return Buffer.concat(parts);
}

test("named-file digests use unambiguous file boundaries", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "agentci-canonical-test-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  const combined = join(root, "combined.js");
  const first = join(root, "first.js");
  const second = join(root, "second.js");
  await writeFile(combined, Buffer.from("alpha\0b.js\0omega"));
  await writeFile(first, "alpha", "utf8");
  await writeFile(second, "omega", "utf8");

  const oneFile = [{ name: "a.js", path: combined }];
  const twoFiles = [
    { name: "a.js", path: first },
    { name: "b.js", path: second },
  ];

  assert.deepEqual(await legacyFrame(oneFile), await legacyFrame(twoFiles));
  assert.notEqual(
    await digestNamedFiles(oneFile),
    await digestNamedFiles(twoFiles),
  );
});

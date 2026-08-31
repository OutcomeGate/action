import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { compareReports } from "../src/comparison.js";
import { digestValue } from "../src/canonical.js";
import {
  computeEvidenceDigest,
  isReleaseReport,
  verifyEvidenceDigest,
} from "../src/report.js";
import { runSuite } from "../src/runner.js";
import type { ManifestReleaseIdentity } from "../src/types.js";

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, "../..");
const exampleRoot = resolve(projectRoot, "examples/model-compression");
const suitePath = resolve(exampleRoot, "suite.json");
const adapterManifestPath = resolve(exampleRoot, "adapter.manifest.json");

interface FloatModel {
  schemaVersion: string;
  encoding: "float32";
  bias: number;
  weights: Record<string, number>;
}

interface QuantizedModel {
  schemaVersion: string;
  encoding: "symmetric-integer";
  bits: number;
  scale: number;
  zeroPoint: number;
  bias: number;
  weights: Record<string, number>;
}

interface QuantizedReleaseFixture {
  model: {
    kind: "local";
    revision: string;
    configuration: {
      precision: string;
      quantization: {
        scheme: string;
        scale: number;
        zeroPoint: number;
      };
    };
  };
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

function quantize(value: number, scale: number, bits: number): number {
  const minimum = -(2 ** (bits - 1));
  const maximum = 2 ** (bits - 1) - 1;
  const rounded = Math.round(value / scale);
  const clamped = Math.min(maximum, Math.max(minimum, rounded));
  return clamped === 0 ? 0 : clamped;
}

test("stored INT8 and INT4 artifacts are real symmetric quantizations", async () => {
  const full = await readJson<FloatModel>(
    resolve(exampleRoot, "releases/router-fp32.bundle/model.json"),
  );
  const variants = {
    int8: { bits: 8, scale: 0.0125 },
    int4: { bits: 4, scale: 0.2 },
  } as const;
  for (const [name, expected] of Object.entries(variants) as Array<
    [keyof typeof variants, (typeof variants)[keyof typeof variants]]
  >) {
    const candidate = await readJson<QuantizedModel>(
      resolve(exampleRoot, `releases/router-${name}.bundle/model.json`),
    );
    const manifest = await readJson<QuantizedReleaseFixture>(
      resolve(exampleRoot, `releases/router-${name}.release.json`),
    );
    assert.equal(candidate.schemaVersion, full.schemaVersion);
    assert.equal(candidate.encoding, "symmetric-integer");
    assert.equal(candidate.bits, expected.bits);
    assert.equal(candidate.scale, expected.scale);
    assert.equal(candidate.zeroPoint, 0);
    assert.equal(manifest.model.kind, "local");
    assert.equal(manifest.model.revision, `${name}-symmetric`);
    assert.equal(manifest.model.configuration.precision, name);
    assert.deepEqual(manifest.model.configuration.quantization, {
      scheme: "symmetric-per-tensor",
      scale: expected.scale,
      zeroPoint: 0,
    });
    const minimum = -(2 ** (expected.bits - 1));
    const maximum = 2 ** (expected.bits - 1) - 1;
    for (const stored of [candidate.bias, ...Object.values(candidate.weights)]) {
      assert.ok(Number.isSafeInteger(stored));
      assert.ok(stored >= minimum && stored <= maximum);
    }
    assert.equal(
      candidate.bias,
      quantize(full.bias, expected.scale, expected.bits),
    );
    assert.deepEqual(Object.keys(candidate.weights), Object.keys(full.weights));
    for (const [token, fullWeight] of Object.entries(full.weights)) {
      assert.equal(
        candidate.weights[token],
        quantize(fullWeight, expected.scale, expected.bits),
      );
    }
  }
});

test("compression comparison shows both stable and regressed workflows", async () => {
  const runModel = (name: string) =>
    runSuite({
      suitePath,
      releaseManifestPath: resolve(
        exampleRoot,
        `releases/router-${name}.release.json`,
      ),
      adapterManifestPath,
    });
  const full = await runModel("fp32");
  const int8 = await runModel("int8");
  const int4 = await runModel("int4");

  for (const report of [full, int8, int4]) {
    assert.equal(report.release.digestScope, "declared-config-and-bundle-bytes");
    assert.ok(isReleaseReport(report));
    assert.ok(verifyEvidenceDigest(report));
    if (report.release.digestScope === "declared-config-and-bundle-bytes") {
      assert.equal(report.release.manifest.model.kind, "local");
    }
  }

  assert.equal(full.decision.verdict, "pass");
  assert.equal(int8.decision.verdict, "pass");
  assert.equal(int4.decision.verdict, "block");
  if (
    full.release.digestScope !== "declared-config-and-bundle-bytes" ||
    int8.release.digestScope !== "declared-config-and-bundle-bytes" ||
    int4.release.digestScope !== "declared-config-and-bundle-bytes"
  ) {
    assert.fail("compression example requires manifest-backed release identity");
  }
  assert.notEqual(full.release.releaseDigest, int8.release.releaseDigest);
  assert.notEqual(full.release.releaseDigest, int4.release.releaseDigest);
  const invariantManifest = (release: ManifestReleaseIdentity) => {
    if (release.manifest.schemaVersion !== "agentci.release.v2") {
      assert.fail("compression example requires a release-v2 manifest");
    }
    return {
      schemaVersion: release.manifest.schemaVersion,
      runtime: release.manifest.runtime,
      components: release.manifest.components,
      candidate: release.manifest.candidate,
    };
  };
  for (const optimized of [int8.release, int4.release]) {
    assert.deepEqual(invariantManifest(optimized), invariantManifest(full.release));
    assert.deepEqual(
      optimized.files.filter((file) => file.path !== "model.json"),
      full.release.files.filter((file) => file.path !== "model.json"),
    );
    assert.equal(optimized.entryFileDigest, full.release.entryFileDigest);
    assert.equal(optimized.promptDigest, full.release.promptDigest);
    assert.equal(optimized.toolSchemaDigest, full.release.toolSchemaDigest);
    assert.equal(optimized.harnessDigest, full.release.harnessDigest);
  }

  const stable = compareReports(full, int8);
  assert.equal(stable.verdict, "pass");
  assert.deepEqual(stable.regressed, []);
  assert.deepEqual(stable.unchangedPass, [
    "urgent-service-ticket",
    "borderline-billing-refund",
    "routine-duplicate",
  ]);

  const regressed = compareReports(full, int4);
  assert.equal(regressed.verdict, "block");
  assert.deepEqual(regressed.regressed, ["borderline-billing-refund"]);
  assert.deepEqual(regressed.unchangedPass, [
    "urgent-service-ticket",
    "routine-duplicate",
  ]);

  const boundary = int4.scenarios.find(
    (scenario) => scenario.scenarioId === "borderline-billing-refund",
  );
  assert.equal(boundary?.verdict, "block");
  assert.deepEqual(boundary?.output, {
    route: "auto_resolve",
    score: 0,
    encoding: "symmetric-integer",
  });

  const forged = structuredClone(full);
  if (forged.release.digestScope !== "declared-config-and-bundle-bytes") {
    assert.fail("compression example requires a local manifest-backed release");
  }
  const release = forged.release;
  const model = release.manifest.model;
  if (model.kind !== "local") {
    assert.fail("compression example requires a local manifest-backed release");
  }
  model.artifacts = ["absent-model.json"];
  const classified = new Set([
    ...release.manifest.components.prompts,
    ...release.manifest.components.toolSchemas,
    ...model.artifacts,
  ]);
  release.manifestDigest = digestValue({
    domain: "agentci.release-manifest.v2",
    manifest: release.manifest,
  });
  release.modelDeclarationDigest = digestValue({
    domain: "agentci.model-declaration.v1",
    model: release.manifest.model,
  });
  release.harnessDigest = digestValue({
    domain: "agentci.harness-set.v1",
    files: release.files.filter((file) => !classified.has(file.path)),
  });
  release.releaseDigest = digestValue({
    domain: "agentci.declared-release.v2",
    runtime: release.manifest.runtime,
    manifestDigest: release.manifestDigest,
    bundleDigest: release.bundleDigest,
    modelDeclarationDigest: release.modelDeclarationDigest,
    promptDigest: release.promptDigest,
    toolSchemaDigest: release.toolSchemaDigest,
    harnessDigest: release.harnessDigest,
  });
  const { evidenceDigest: _oldDigest, ...withoutDigest } = forged;
  forged.evidenceDigest = computeEvidenceDigest(withoutDigest);
  assert.ok(verifyEvidenceDigest(forged));
  assert.equal(isReleaseReport(forged), false);
});

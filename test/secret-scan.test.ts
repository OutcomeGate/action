import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  HARD_SECRET_SCAN_LIMITS,
  SecretScanError,
  assertSecretScanClean,
  scanBytesForSecrets,
  scanNamedArtifactsForSecrets,
  scanTextForSecrets,
} from "../src/secret-scan.js";
import type {
  NamedSecretArtifact,
  SecretScanErrorCode,
  SecretScanRuleId,
} from "../src/secret-scan.js";

function expectScanError(
  code: SecretScanErrorCode,
  operation: () => unknown,
): SecretScanError {
  let captured: SecretScanError | undefined;
  assert.throws(operation, (error: unknown) => {
    assert.ok(error instanceof SecretScanError);
    assert.equal(error.code, code);
    captured = error;
    return true;
  });
  assert.ok(captured);
  return captured;
}

test("detects well-known credential shapes without reflecting matched values", () => {
  const canaries: Array<[SecretScanRuleId, string]> = [
    ["private-key", "-----BEGIN PRIVATE KEY-----"],
    ["aws-access-key-id", `AKIA${"A".repeat(16)}`],
    ["github-token", `ghp_${"a".repeat(36)}`],
    ["gitlab-token", `glpat-${"b".repeat(24)}`],
    ["slack-token", `xoxb-${"c".repeat(24)}`],
    ["stripe-secret-key", `sk_test_${"d".repeat(24)}`],
    ["anthropic-api-key", `sk-ant-api03-${"e".repeat(30)}`],
    ["openai-api-key", `sk-proj-${"f".repeat(30)}`],
    ["google-api-key", `AIza${"G".repeat(35)}`],
    ["sendgrid-api-key", `SG.${"h".repeat(16)}.${"i".repeat(24)}`],
    ["npm-access-token", `npm_${"j".repeat(36)}`],
    ["huggingface-token", `hf_${"k".repeat(24)}`],
    [
      "json-web-token",
      `eyJ${"l".repeat(8)}.${"m".repeat(12)}.${"n".repeat(12)}`,
    ],
    ["authorization-header", `Authorization: Bearer ${"P".repeat(24)}`],
    ["credentialed-url", "https://pilot-user:synthetic-credential-value@example.invalid/api"],
    ["suspicious-credential-assignment", "password = \"correct-horse-battery-staple\""],
  ];
  const text = canaries.map(([, value]) => value).join("\n");

  const result = scanTextForSecrets({
    path: "fixtures/synthetic-canaries.txt",
    field: "body",
    text,
  });
  const ruleIds = new Set(result.findings.map((finding) => finding.ruleId));

  assert.equal(result.status, "findings");
  for (const [ruleId] of canaries) {
    assert.equal(ruleIds.has(ruleId), true, `missing rule ${ruleId}`);
  }
  assert.ok(
    result.findings.every((finding) =>
      /^[a-f0-9]{64}$/.test(finding.findingDigest),
    ),
  );
  const serialized = JSON.stringify(result);
  for (const [, canary] of canaries) {
    assert.equal(serialized.includes(canary), false);
  }
});

test("fail-closed assertion reports only safe rule and location metadata", () => {
  const canary = `ghp_${"r".repeat(36)}`;
  const result = scanTextForSecrets({
    path: "release/config.txt",
    text: canary,
  });
  const error = expectScanError("findings_detected", () =>
    assertSecretScanClean(result, "release input"),
  );
  assert.match(error.message, /github-token at release\/config\.txt line 1/);
  assert.equal(error.message.includes(canary), false);
});

test("finding digests depend on rule and location metadata, not secret bytes", () => {
  const firstCanary = `ghp_${"a".repeat(36)}`;
  const secondCanary = `ghp_${"b".repeat(36)}`;
  const first = scanTextForSecrets({
    path: "bundle/config.txt",
    text: firstCanary,
  });
  const second = scanTextForSecrets({
    path: "bundle/config.txt",
    text: secondCanary,
  });

  assert.equal(first.findings.length, 1);
  assert.equal(second.findings.length, 1);
  assert.equal(
    first.findings[0]?.findingDigest,
    second.findings[0]?.findingDigest,
  );
  assert.notEqual(
    first.findings[0]?.findingDigest,
    createHash("sha256").update(firstCanary).digest("hex"),
  );
  assert.equal(JSON.stringify(first).includes(firstCanary), false);
  assert.equal(JSON.stringify(second).includes(secondCanary), false);
});

test("detects a token split across byte chunks", () => {
  const canary = `github_pat_${"a".repeat(24)}`;
  const result = scanBytesForSecrets({
    path: "bundle/split.bin",
    bytes: [
      Buffer.from(canary.slice(0, 7)),
      Buffer.from(canary.slice(7, 19)),
      Buffer.from(canary.slice(19)),
    ],
  });

  assert.equal(result.status, "findings");
  assert.equal(
    result.findings.some((finding) => finding.ruleId === "github-token"),
    true,
  );
  assert.equal(JSON.stringify(result).includes(canary), false);
});

test("scans contiguous ASCII credential shapes inside binary bytes", () => {
  const canary = `sk_live_${"q".repeat(24)}`;
  const bytes = Buffer.concat([
    Buffer.from([0x00, 0xff, 0x01]),
    Buffer.from(canary),
    Buffer.from([0x00, 0xfe]),
  ]);
  const result = scanBytesForSecrets({
    path: "bundle/native-data.bin",
    bytes,
  });
  const finding = result.findings.find(
    (candidate) => candidate.ruleId === "stripe-secret-key",
  );

  assert.ok(finding);
  assert.equal(finding.line, undefined);
  assert.equal(JSON.stringify(result).includes(canary), false);
});

test("reports logical field and one-based line without a secret preview", () => {
  const result = scanTextForSecrets({
    path: "suite.json",
    field: "scenarios[0].initialState",
    text: 'safe\nstill safe\napi_key = "synthetic-but-concrete-value-42"\n',
  });
  const finding = result.findings.find(
    (candidate) => candidate.ruleId === "suspicious-credential-assignment",
  );

  assert.ok(finding);
  assert.equal(finding.path, "suite.json");
  assert.equal(finding.field, "scenarios[0].initialState");
  assert.equal(finding.line, 3);
  assert.deepEqual(Object.keys(finding).sort(), [
    "field",
    "findingDigest",
    "line",
    "path",
    "ruleId",
  ]);
});

test("ignores explicit placeholders and references but flags concrete ambiguous assignments", () => {
  const placeholders = [
    "api_key = process.env.API_KEY",
    'password: "${PASSWORD}"',
    'client_secret: "<redacted>"',
    'secret: "example"',
    'private_key: "not-a-secret"',
    'credentials: { "environment": [] }',
    'tokens: ["declared-name-only"]',
    "https://user:password@example.invalid/path",
    'public_key = "this-is-public-material"',
    'monkey = "long-but-unrelated-value"',
  ].join("\n");
  assert.equal(
    scanTextForSecrets({ path: "config/placeholders.txt", text: placeholders })
      .status,
    "clean",
  );

  const conservative = scanTextForSecrets({
    path: "config/ambiguous.txt",
    text: 'auth_token = "syntheticIdentifierWithLength123"',
  });
  assert.equal(conservative.status, "findings");
  assert.equal(
    conservative.findings.some(
      (finding) => finding.ruleId === "suspicious-credential-assignment",
    ),
    true,
  );
});

test("assignment scanning does not allow placeholders to shadow later values", () => {
  const singleLine =
    '{"credentials":{"environment":[]},"token":"test-live-looking-value-12345","password":"escaped\\\"quote-and-secret-value"}';
  const result = scanTextForSecrets({
    path: "config/one-line.json",
    text: singleLine,
  });

  assert.equal(result.status, "findings");
  assert.equal(
    result.findings.some(
      (finding) => finding.ruleId === "suspicious-credential-assignment",
    ),
    true,
  );
});

test("ordinary credential references remain clean while concrete prefixed values do not", () => {
  assert.equal(
    scanTextForSecrets({
      path: "adapter/source.mjs",
      text: "token = options.credentials.API_KEY",
    }).status,
    "clean",
  );
  assert.equal(
    scanTextForSecrets({
      path: "adapter/config.txt",
      text: 'token = "example-live-looking-value-12345"',
    }).status,
    "findings",
  );
  for (const value of [
    "<live-custom-secret-material-12345>",
    "<LIVE_CUSTOM_SECRET_MATERIAL_12345>",
    "$live-custom-secret-material-12345",
    "aaaaaaaaaaaaaaaa",
  ]) {
    assert.equal(
      scanTextForSecrets({
        path: "adapter/config.txt",
        text: `token = "${value}"`,
      }).status,
      "findings",
    );
  }
  for (const text of [
    'token = "process.env.API_KEY-real-custom-secret-material-123"',
    'token = "getenv(unclosed-live-material"',
    'config.apiKey = "custom-live-material-123456"',
    'this.token = "custom-live-material-123456"',
    'config["token"] = "custom-live-material-123456"',
  ]) {
    assert.equal(
      scanTextForSecrets({ path: "adapter/source.mjs", text }).status,
      "findings",
    );
  }
});

test("named artifact scans are deterministic regardless of input order", () => {
  const artifacts: NamedSecretArtifact[] = [
    {
      path: "z/config.txt",
      content: 'token = "concrete-token-shaped-value-42"',
    },
    {
      path: "a/key.txt",
      content: `hf_${"s".repeat(24)}`,
    },
  ];

  const forward = scanNamedArtifactsForSecrets(artifacts);
  const reverse = scanNamedArtifactsForSecrets([...artifacts].reverse());

  assert.deepEqual(forward, reverse);
  assert.deepEqual(
    forward.findings.map((finding) => finding.path),
    ["a/key.txt", "z/config.txt"],
  );
});

test("bounds safe findings and marks overflow without retaining matched bytes", () => {
  const canaries = Array.from(
    { length: 10 },
    (_, index) => `ghp_${String(index).padStart(36, "a")}`,
  );
  const result = scanTextForSecrets({
    path: "many.txt",
    text: canaries.join("\n"),
    limits: { maxFindings: 3 },
  });

  assert.equal(result.status, "findings");
  assert.equal(result.findings.length, 3);
  assert.equal(result.findingsTruncated, true);
  const serialized = JSON.stringify(result);
  for (const canary of canaries) {
    assert.equal(serialized.includes(canary), false);
  }
});

test("artifact, aggregate, and hard limits fail closed with safe errors", () => {
  const canary = `ghp_${"v".repeat(36)}`;
  const artifactError = expectScanError("artifact_size_exceeded", () =>
    scanTextForSecrets({
      path: "oversized.txt",
      text: `${canary}${"x".repeat(100)}`,
      limits: { maxArtifactBytes: 100 },
    }),
  );
  assert.equal(artifactError.message.includes(canary), false);

  expectScanError("total_size_exceeded", () =>
    scanNamedArtifactsForSecrets(
      [
        { path: "one.txt", content: "a".repeat(60) },
        { path: "two.txt", content: "b".repeat(60) },
      ],
      { limits: { maxArtifactBytes: 100, maxTotalBytes: 100 } },
    ),
  );
  expectScanError("artifact_limit_exceeded", () =>
    scanNamedArtifactsForSecrets(
      [
        { path: "one.txt", content: "safe" },
        { path: "two.txt", content: "safe" },
      ],
      { limits: { maxArtifacts: 1 } },
    ),
  );
  expectScanError("invalid_limits", () =>
    scanTextForSecrets({
      path: "safe.txt",
      text: "safe",
      limits: { maxFindings: HARD_SECRET_SCAN_LIMITS.maxFindings + 1 },
    }),
  );
  expectScanError("invalid_limits", () =>
    scanNamedArtifactsForSecrets(
      [{ path: "safe.txt", content: "safe" }],
      { limits: { maxFindingsTypo: 1 } } as unknown as Parameters<
        typeof scanNamedArtifactsForSecrets
      >[1],
    ),
  );
});

test("invalid input fails closed without reflecting invalid metadata or content", () => {
  const marker = "synthetic-sensitive-marker";
  const unsafePathError = expectScanError("invalid_input", () =>
    scanTextForSecrets({ path: `../${marker}`, text: "safe" }),
  );
  assert.equal(unsafePathError.message.includes(marker), false);

  const pathCanary = `ghp_${"z".repeat(36)}`;
  const secretPathError = expectScanError("invalid_input", () =>
    scanTextForSecrets({ path: `bundle/${pathCanary}.txt`, text: "safe" }),
  );
  assert.equal(secretPathError.message.includes(pathCanary), false);

  expectScanError("invalid_input", () => scanNamedArtifactsForSecrets([]));
  expectScanError("invalid_input", () =>
    scanNamedArtifactsForSecrets([
      { path: "same.txt", content: "safe" },
      { path: "same.txt", content: "also safe" },
    ]),
  );
  expectScanError("invalid_input", () =>
    scanNamedArtifactsForSecrets([
      {
        path: "extra.txt",
        content: "safe",
        ignored: true,
      } as unknown as NamedSecretArtifact,
    ]),
  );
  const contentError = expectScanError("invalid_input", () =>
    scanNamedArtifactsForSecrets([
      {
        path: "invalid.txt",
        content: 42 as unknown as Uint8Array[],
      },
    ]),
  );
  assert.equal(contentError.message.includes(marker), false);
  expectScanError("invalid_input", () =>
    scanTextForSecrets({ path: "invalid-text.txt", text: "\ud800" }),
  );
});

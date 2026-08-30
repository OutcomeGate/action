import assert from "node:assert/strict";
import test from "node:test";

import {
  CredentialPolicyError,
  KnownSecretLeakError,
  assertNoKnownSecretLeaks,
  authorizeAdapterCredentials,
  findKnownSecretLeaks,
  knownSecretsFromCredentialEnv,
} from "../src/credential-policy.js";
import type { JsonValue } from "../src/types.js";

const adapterDigest = "a".repeat(64);

function expectPolicyCode(
  code: CredentialPolicyError["code"],
  operation: () => unknown,
): void {
  assert.throws(operation, (error: unknown) => {
    assert.ok(error instanceof CredentialPolicyError);
    assert.equal(error.code, code);
    return true;
  });
}

test("authorizes an exact adapter credential set and returns no ambient values", () => {
  const environment = authorizeAdapterCredentials({
    declaredEnvNames: ["STRIPE_TEST_KEY", "SUPPORT_SANDBOX_TOKEN"],
    callerAllowlist: ["SUPPORT_SANDBOX_TOKEN", "STRIPE_TEST_KEY"],
    sourceEnv: {
      PATH: "/not-authorized",
      STRIPE_TEST_KEY: "stripe-literal-for-test",
      SUPPORT_SANDBOX_TOKEN: "support-literal-for-test",
      UNDECLARED_SECRET: "must-not-cross-the-boundary",
    },
    capturedAdapterDigest: adapterDigest,
    approvedAdapterDigest: adapterDigest,
  });

  assert.deepEqual(environment, {
    STRIPE_TEST_KEY: "stripe-literal-for-test",
    SUPPORT_SANDBOX_TOKEN: "support-literal-for-test",
  });
  assert.equal(Object.isFrozen(environment), true);
});

test("empty declarations authorize an empty environment without a digest grant", () => {
  assert.deepEqual(
    authorizeAdapterCredentials({
      declaredEnvNames: [],
      callerAllowlist: [],
      sourceEnv: { UNDECLARED_SECRET: "not-authorized" },
      capturedAdapterDigest: "not-used-without-credentials",
    }),
    {},
  );
});

test("requires exact declaration and caller-allowlist set equality", () => {
  expectPolicyCode("allowlist_mismatch", () =>
    authorizeAdapterCredentials({
      declaredEnvNames: ["STRIPE_TEST_KEY"],
      callerAllowlist: ["STRIPE_TEST_KEY", "SUPPORT_SANDBOX_TOKEN"],
      sourceEnv: {},
      capturedAdapterDigest: adapterDigest,
      approvedAdapterDigest: adapterDigest,
    }),
  );
});

test("rejects duplicate names in either authorization source", () => {
  for (const [declaredEnvNames, callerAllowlist] of [
    [
      ["STRIPE_TEST_KEY", "STRIPE_TEST_KEY"],
      ["STRIPE_TEST_KEY"],
    ],
    [
      ["STRIPE_TEST_KEY"],
      ["STRIPE_TEST_KEY", "STRIPE_TEST_KEY"],
    ],
  ] as const) {
    expectPolicyCode("duplicate_env_name", () =>
      authorizeAdapterCredentials({
        declaredEnvNames,
        callerAllowlist,
        sourceEnv: { STRIPE_TEST_KEY: "test-value" },
        capturedAdapterDigest: adapterDigest,
        approvedAdapterDigest: adapterDigest,
      }),
    );
  }
});

test("rejects glob, malformed, and reserved runtime names defensively", () => {
  for (const name of [
    "*",
    "STRIPE_*",
    "lowercase_token",
    "GITHUB_TOKEN",
    "AGENTCI_HOST_MODE",
    "NODE_OPTIONS",
    "LD_PRELOAD",
    "SSLKEYLOGFILE",
    "PATH",
    "HTTP_PROXY",
    "OPENSSL_CONF",
    "GLIBC_TUNABLES",
    "UV_THREADPOOL_SIZE",
    "MALLOC_CONF",
    "BASH_FUNC_INJECT",
    "BASHOPTS",
    "SHELLOPTS",
    "PS4",
    "POSIXLY_CORRECT",
    "JAVA_HOME",
    "CARGO_HOME",
    "RUST_LOG",
  ]) {
    assert.throws(
      () =>
        authorizeAdapterCredentials({
          declaredEnvNames: [name],
          callerAllowlist: [name],
          sourceEnv: { [name]: "test-value" },
          capturedAdapterDigest: adapterDigest,
          approvedAdapterDigest: adapterDigest,
        }),
      CredentialPolicyError,
    );
  }
});

test("credentialed adapters require an exact approved captured digest", () => {
  const base = {
    declaredEnvNames: ["STRIPE_TEST_KEY"],
    callerAllowlist: ["STRIPE_TEST_KEY"],
    sourceEnv: { STRIPE_TEST_KEY: "test-value" },
    capturedAdapterDigest: adapterDigest,
  } as const;

  expectPolicyCode("adapter_digest_required", () =>
    authorizeAdapterCredentials(base),
  );
  expectPolicyCode("adapter_digest_mismatch", () =>
    authorizeAdapterCredentials({
      ...base,
      approvedAdapterDigest: "b".repeat(64),
    }),
  );
  expectPolicyCode("invalid_adapter_digest", () =>
    authorizeAdapterCredentials({
      ...base,
      capturedAdapterDigest: "not-a-digest",
      approvedAdapterDigest: "not-a-digest",
    }),
  );
});

test("every declared credential value must be present, nonempty, and spawn-safe", () => {
  const authorize = (sourceEnv: Record<string, string | undefined>): unknown =>
    authorizeAdapterCredentials({
      declaredEnvNames: ["STRIPE_TEST_KEY"],
      callerAllowlist: ["STRIPE_TEST_KEY"],
      sourceEnv,
      capturedAdapterDigest: adapterDigest,
      approvedAdapterDigest: adapterDigest,
    });

  expectPolicyCode("missing_credential_value", () => authorize({}));
  expectPolicyCode("missing_credential_value", () =>
    authorize({ STRIPE_TEST_KEY: undefined }),
  );
  expectPolicyCode("empty_credential_value", () =>
    authorize({ STRIPE_TEST_KEY: "" }),
  );
  expectPolicyCode("invalid_credential_value", () =>
    authorize({ STRIPE_TEST_KEY: "before\0after" }),
  );
  expectPolicyCode("invalid_credential_value", () =>
    authorize({ STRIPE_TEST_KEY: "before\ud800after" }),
  );
  expectPolicyCode("invalid_credential_value", () =>
    authorize({ STRIPE_TEST_KEY: "x".repeat(8 * 1024 + 1) }),
  );
});

test("derives deterministic exact-match rules from an authorized environment", () => {
  assert.deepEqual(
    knownSecretsFromCredentialEnv({
      SUPPORT_SANDBOX_TOKEN: "support-literal-for-test",
      STRIPE_TEST_KEY: "stripe-literal-for-test",
    }),
    [
      {
        ruleId: "credential:STRIPE_TEST_KEY",
        value: "stripe-literal-for-test",
      },
      {
        ruleId: "credential:SUPPORT_SANDBOX_TOKEN",
        value: "support-literal-for-test",
      },
    ],
  );
});

test("finds exact known literals recursively without exposing values or keys", () => {
  const firstSecret = "first-literal-for-test";
  const secondSecret = "second-literal-for-test";
  const value = {
    nested: [{ token: `Bearer ${secondSecret}` }],
    safe: `prefix:${firstSecret}:suffix`,
    [`key-${firstSecret}`]: "ordinary",
  };
  const findings = findKnownSecretLeaks(value, [
    { ruleId: "credential:FIRST", value: firstSecret },
    { ruleId: "credential:SECOND", value: secondSecret },
  ]);

  assert.deepEqual(findings, [
    {
      ruleId: "credential:FIRST",
      location: "$.properties[0].key",
    },
    {
      ruleId: "credential:SECOND",
      location: "$.properties[1].value[0].properties[0].value",
    },
    {
      ruleId: "credential:FIRST",
      location: "$.properties[2].value",
    },
  ]);
  const serialized = JSON.stringify(findings);
  assert.equal(serialized.includes(firstSecret), false);
  assert.equal(serialized.includes(secondSecret), false);
  assert.equal(serialized.includes("key-"), false);
  assert.ok(findings.every((finding) => finding.location.startsWith("$")));
});

test("the assertion helper throws a generic error containing safe findings only", () => {
  const secret = "credential-literal-for-test";
  assert.throws(
    () =>
      assertNoKnownSecretLeaks(
        { result: `accidental ${secret}` },
        [{ ruleId: "credential:TEST", value: secret }],
      ),
    (error: unknown) => {
      assert.ok(error instanceof KnownSecretLeakError);
      assert.equal(
        error.message,
        "known credential material crossed a protected JSON boundary",
      );
      assert.equal(JSON.stringify(error).includes(secret), false);
      assert.deepEqual(error.findings, [
        {
          ruleId: "credential:TEST",
          location: "$.properties[0].value",
        },
      ]);
      return true;
    },
  );

  assert.doesNotThrow(() =>
    assertNoKnownSecretLeaks(
      { result: "ordinary" },
      [{ ruleId: "credential:TEST", value: secret }],
    ),
  );
});

test("scanner rejects non-JSON and ambiguous rule declarations", () => {
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  expectPolicyCode("invalid_json_value", () =>
    findKnownSecretLeaks(cyclic as JsonValue, [
      { ruleId: "credential:TEST", value: "test-value" },
    ]),
  );
  expectPolicyCode("invalid_secret_rule", () =>
    findKnownSecretLeaks({}, [
      { ruleId: "unsafe rule", value: "test-value" },
    ]),
  );
  expectPolicyCode("invalid_secret_rule", () =>
    findKnownSecretLeaks({}, [
      { ruleId: "credential:TEST", value: "first" },
      { ruleId: "credential:TEST", value: "second" },
    ]),
  );
});

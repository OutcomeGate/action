import assert from "node:assert/strict";
import test from "node:test";

import {
  CandidateCredentialPolicyError,
  MAX_CANDIDATE_ENV_VALUE_BYTES,
  authorizeCandidateEnvironment,
  parseCandidateCredentialPolicy,
} from "../src/candidate-credential-policy.js";
import type {
  CandidateCredentialPolicyErrorCode,
  CandidateEnvironmentAuthorization,
} from "../src/candidate-credential-policy.js";

const releaseDigest = "a".repeat(64);
const candidateSecret = "candidate-provider-secret-literal-12345";

function explicitOptions(): CandidateEnvironmentAuthorization {
  return {
    credentialPolicy: {
      kind: "environment",
      environment: ["OPENAI_API_KEY"],
    },
    callerAllowlist: ["OPENAI_API_KEY"],
    sourceEnv: {
      OPENAI_API_KEY: candidateSecret,
      PATH: "/ambient/path/must-not-cross",
      UNDECLARED_SECRET: "ambient-secret-must-not-cross",
    },
    capturedReleaseDigest: releaseDigest,
    approvedReleaseDigest: releaseDigest,
    adapterCredentials: { declaredEnvNames: [], environment: {} },
    nonSecretRuntimeEnvironment: {},
  };
}

function expectCode(
  code: CandidateCredentialPolicyErrorCode,
  operation: () => unknown,
  forbiddenText: readonly string[] = [],
): void {
  assert.throws(operation, (error: unknown) => {
    assert.ok(error instanceof CandidateCredentialPolicyError);
    assert.equal(error.code, code);
    const exposed = `${error.message}\n${JSON.stringify(error)}`;
    for (const forbidden of forbiddenText) {
      assert.equal(exposed.includes(forbidden), false);
    }
    return true;
  });
}

test("parses only the closed explicit policy union", () => {
  const none = parseCandidateCredentialPolicy({ kind: "none" });
  const environment = parseCandidateCredentialPolicy({
    kind: "environment",
    environment: ["OPENAI_PROJECT_ID", "OPENAI_API_KEY"],
  });

  assert.deepEqual(none, { kind: "none" });
  assert.equal(Object.isFrozen(none), true);
  assert.deepEqual(environment, {
    kind: "environment",
    environment: ["OPENAI_API_KEY", "OPENAI_PROJECT_ID"],
  });
  assert.equal(Object.isFrozen(environment), true);
  assert.equal(
    environment.kind === "environment" && Object.isFrozen(environment.environment),
    true,
  );

  for (const invalid of [
    undefined,
    {},
    { kind: "ambient" },
    { kind: "none", environment: [] },
    { kind: "none", allowAmbient: true },
    { kind: "environment" },
    { kind: "environment", environment: [] },
    { kind: "environment", environment: ["OPENAI_API_KEY"], extra: true },
  ]) {
    expectCode("invalid_policy", () => parseCandidateCredentialPolicy(invalid));
  }
});

test("explicit no-credentials policy denies ambient credentials and needs no digest", () => {
  const environment = authorizeCandidateEnvironment({
    credentialPolicy: { kind: "none" },
    callerAllowlist: [],
    sourceEnv: {
      OPENAI_API_KEY: candidateSecret,
      PATH: "/ambient/path/must-not-cross",
      UNDECLARED_SECRET: "ambient-secret-must-not-cross",
    },
    adapterCredentials: { declaredEnvNames: [], environment: {} },
    nonSecretRuntimeEnvironment: { LANG: "C.UTF-8", TZ: "UTC" },
  });

  assert.deepEqual(environment, { LANG: "C.UTF-8", TZ: "UTC" });
  assert.equal(Object.isFrozen(environment), true);
  assert.equal("PATH" in environment, false);
  assert.equal("OPENAI_API_KEY" in environment, false);
  assert.equal("UNDECLARED_SECRET" in environment, false);
});

test("builds a fresh frozen environment from only exact approvals", () => {
  const options = explicitOptions();
  const environment = authorizeCandidateEnvironment({
    ...options,
    credentialPolicy: {
      kind: "environment",
      environment: ["OPENAI_PROJECT_ID", "OPENAI_API_KEY"],
    },
    callerAllowlist: ["OPENAI_API_KEY", "OPENAI_PROJECT_ID"],
    sourceEnv: {
      ...options.sourceEnv,
      OPENAI_PROJECT_ID: "candidate-project-98765",
    },
    nonSecretRuntimeEnvironment: { LANG: "C.UTF-8", NO_COLOR: "1" },
  });

  assert.deepEqual(environment, {
    LANG: "C.UTF-8",
    NO_COLOR: "1",
    OPENAI_API_KEY: candidateSecret,
    OPENAI_PROJECT_ID: "candidate-project-98765",
  });
  assert.equal(Object.isFrozen(environment), true);
  assert.notEqual(environment, options.sourceEnv);
  assert.equal("PATH" in environment, false);
  assert.equal("UNDECLARED_SECRET" in environment, false);
});

test("requires exact declaration and caller allowlist equality", () => {
  const base = explicitOptions();
  for (const callerAllowlist of [
    [],
    ["OPENAI_API_KEY", "SECOND_PROVIDER_KEY"],
  ]) {
    expectCode("allowlist_mismatch", () =>
      authorizeCandidateEnvironment({ ...base, callerAllowlist }),
    );
  }

  expectCode("duplicate_env_name", () =>
    authorizeCandidateEnvironment({
      ...base,
      callerAllowlist: ["OPENAI_API_KEY", "OPENAI_API_KEY"],
    }),
  );
  expectCode("duplicate_env_name", () =>
    authorizeCandidateEnvironment({
      ...base,
      credentialPolicy: {
        kind: "environment",
        environment: ["OPENAI_API_KEY", "OPENAI_API_KEY"],
      },
    }),
  );
  expectCode("allowlist_mismatch", () =>
    authorizeCandidateEnvironment({
      ...base,
      credentialPolicy: { kind: "none" },
    }),
  );
});

test("rejects malformed, globbed, and process-control credential names", () => {
  const base = explicitOptions();
  for (const name of [
    "*",
    "OPENAI_*",
    "lowercase_key",
    "PATH",
    "HOME",
    "BASH_ENV",
    "BASHOPTS",
    "SHELLOPTS",
    "PS4",
    "POSIXLY_CORRECT",
    "GITHUB_TOKEN",
    "AGENTCI_HOST_MODE",
    "NODE_OPTIONS",
    "NODE_PATH",
    "LD_PRELOAD",
    "DYLD_INSERT_LIBRARIES",
    "PYTHONPATH",
    "SSLKEYLOGFILE",
    "HTTP_PROXY",
    "LC_PRELOAD",
  ]) {
    assert.throws(
      () =>
        authorizeCandidateEnvironment({
          ...base,
          credentialPolicy: { kind: "environment", environment: [name] },
          callerAllowlist: [name],
          sourceEnv: { [name]: "synthetic-candidate-value" },
        }),
      CandidateCredentialPolicyError,
    );
  }
});

test("credential grants require two valid matching lowercase release digests", () => {
  const base = explicitOptions();
  const {
    capturedReleaseDigest: _captured,
    approvedReleaseDigest: _approved,
    ...withoutDigests
  } = base;

  expectCode("release_digest_required", () =>
    authorizeCandidateEnvironment(withoutDigests),
  );
  expectCode("release_digest_required", () =>
    authorizeCandidateEnvironment({
      ...withoutDigests,
      capturedReleaseDigest: releaseDigest,
    }),
  );
  expectCode(
    "invalid_release_digest",
    () =>
      authorizeCandidateEnvironment({
        ...withoutDigests,
        capturedReleaseDigest: releaseDigest.toUpperCase(),
        approvedReleaseDigest: releaseDigest.toUpperCase(),
      }),
    [releaseDigest.toUpperCase()],
  );
  const otherDigest = "b".repeat(64);
  expectCode(
    "release_digest_mismatch",
    () =>
      authorizeCandidateEnvironment({
        ...withoutDigests,
        capturedReleaseDigest: releaseDigest,
        approvedReleaseDigest: otherDigest,
      }),
    [releaseDigest, otherDigest],
  );
});

test("an unapproved grant does not read candidate credential values", () => {
  let reads = 0;
  const sourceEnv = Object.defineProperty({}, "OPENAI_API_KEY", {
    enumerable: true,
    get() {
      reads += 1;
      throw new Error(candidateSecret);
    },
  }) as Record<string, string>;
  const base = explicitOptions();
  const { approvedReleaseDigest: _approved, ...withoutApproval } = base;

  expectCode(
    "release_digest_required",
    () =>
      authorizeCandidateEnvironment({
        ...withoutApproval,
        sourceEnv,
      }),
    [candidateSecret],
  );
  assert.equal(reads, 0);
});

test("credential values must be present, nonempty, bounded, and spawn-safe", () => {
  const base = explicitOptions();
  const authorize = (sourceEnv: Record<string, string | undefined>): unknown =>
    authorizeCandidateEnvironment({ ...base, sourceEnv });

  expectCode("missing_credential_value", () => authorize({}));
  expectCode("missing_credential_value", () =>
    authorize({ OPENAI_API_KEY: undefined }),
  );
  expectCode("empty_credential_value", () =>
    authorize({ OPENAI_API_KEY: "" }),
  );
  expectCode(
    "invalid_credential_value",
    () => authorize({ OPENAI_API_KEY: "before\0after" }),
    ["before\0after"],
  );
  expectCode(
    "invalid_credential_value",
    () => authorize({ OPENAI_API_KEY: "before\ud800after" }),
    ["before\ud800after"],
  );
  const oversized = "é".repeat(MAX_CANDIDATE_ENV_VALUE_BYTES / 2 + 1);
  expectCode(
    "invalid_credential_value",
    () => authorize({ OPENAI_API_KEY: oversized }),
    [oversized],
  );

  const atLimit = "x".repeat(MAX_CANDIDATE_ENV_VALUE_BYTES);
  assert.deepEqual(authorize({ OPENAI_API_KEY: atLimit }), {
    OPENAI_API_KEY: atLimit,
  });
});

test("requires a complete exact adapter credential boundary", () => {
  const base = explicitOptions();
  for (const adapterCredentials of [
    { declaredEnvNames: ["ADAPTER_TEST_KEY"], environment: {} },
    {
      declaredEnvNames: [],
      environment: { ADAPTER_TEST_KEY: "adapter-secret-literal-98765" },
    },
    {
      declaredEnvNames: ["ADAPTER_TEST_KEY", "ADAPTER_TEST_KEY"],
      environment: { ADAPTER_TEST_KEY: "adapter-secret-literal-98765" },
    },
    {
      declaredEnvNames: ["ADAPTER_TEST_KEY"],
      environment: { ADAPTER_TEST_KEY: "" },
    },
  ]) {
    expectCode("adapter_boundary_invalid", () =>
      authorizeCandidateEnvironment({ ...base, adapterCredentials }),
    );
  }
});

test("candidate and adapter credential names cannot be reused", () => {
  const base = explicitOptions();
  expectCode("adapter_name_overlap", () =>
    authorizeCandidateEnvironment({
      ...base,
      adapterCredentials: {
        declaredEnvNames: ["OPENAI_API_KEY"],
        environment: { OPENAI_API_KEY: "adapter-secret-literal-98765" },
      },
    }),
  );
});

test("candidate and adapter credential values cannot equal or contain each other", () => {
  const base = explicitOptions();
  const adapterName = "ADAPTER_TEST_KEY";
  for (const [candidateValue, adapterValue] of [
    ["shared-secret-literal", "shared-secret-literal"],
    ["prefix-shared-secret-literal-suffix", "shared-secret-literal"],
    ["shared-secret-literal", "prefix-shared-secret-literal-suffix"],
  ] as const) {
    expectCode(
      "adapter_value_overlap",
      () =>
        authorizeCandidateEnvironment({
          ...base,
          sourceEnv: { OPENAI_API_KEY: candidateValue },
          adapterCredentials: {
            declaredEnvNames: [adapterName],
            environment: { [adapterName]: adapterValue },
          },
        }),
      [candidateValue, adapterValue],
    );
  }
});

test("candidate credentials cannot be aliased through another credential or runtime name", () => {
  const base = explicitOptions();
  expectCode("candidate_value_overlap", () =>
    authorizeCandidateEnvironment({
      ...base,
      credentialPolicy: {
        kind: "environment",
        environment: ["OPENAI_API_KEY", "SECOND_PROVIDER_KEY"],
      },
      callerAllowlist: ["OPENAI_API_KEY", "SECOND_PROVIDER_KEY"],
      sourceEnv: {
        OPENAI_API_KEY: "shared-candidate-secret-literal",
        SECOND_PROVIDER_KEY: "prefix-shared-candidate-secret-literal-suffix",
      },
    }),
  );

  expectCode("runtime_value_overlap", () =>
    authorizeCandidateEnvironment({
      ...base,
      nonSecretRuntimeEnvironment: {
        TZ: `prefix-${candidateSecret}-suffix`,
      },
    }),
  );
});

test("adapter credentials cannot be smuggled through root runtime entries", () => {
  const adapterSecret = "adapter-secret-literal-98765";
  expectCode(
    "adapter_value_overlap",
    () =>
      authorizeCandidateEnvironment({
        credentialPolicy: { kind: "none" },
        callerAllowlist: [],
        sourceEnv: {},
        adapterCredentials: {
          declaredEnvNames: ["ADAPTER_TEST_KEY"],
          environment: { ADAPTER_TEST_KEY: adapterSecret },
        },
        nonSecretRuntimeEnvironment: { TZ: `prefix-${adapterSecret}-suffix` },
      }),
    [adapterSecret],
  );
});

test("root runtime entries use a closed allowlist and bounded nonempty values", () => {
  const base = {
    credentialPolicy: { kind: "none" },
    callerAllowlist: [],
    sourceEnv: {},
    adapterCredentials: { declaredEnvNames: [], environment: {} },
  } as const;

  expectCode("runtime_name_not_allowed", () =>
    authorizeCandidateEnvironment({
      ...base,
      nonSecretRuntimeEnvironment: { PATH: "/usr/bin" },
    }),
  );
  expectCode("invalid_runtime_environment", () =>
    authorizeCandidateEnvironment({
      ...base,
      nonSecretRuntimeEnvironment: { TZ: "" },
    }),
  );
  expectCode("invalid_runtime_environment", () =>
    authorizeCandidateEnvironment({
      ...base,
      nonSecretRuntimeEnvironment: {
        TZ: "x".repeat(MAX_CANDIDATE_ENV_VALUE_BYTES + 1),
      },
    }),
  );
});

test("policy failures never expose supplied credential values or release digests", () => {
  const secret = "do-not-echo-this-candidate-secret";
  const captured = "c".repeat(64);
  const approved = "d".repeat(64);
  expectCode(
    "release_digest_mismatch",
    () =>
      authorizeCandidateEnvironment({
        ...explicitOptions(),
        sourceEnv: { OPENAI_API_KEY: secret },
        capturedReleaseDigest: captured,
        approvedReleaseDigest: approved,
      }),
    [secret, captured, approved],
  );

  expectCode(
    "adapter_value_overlap",
    () =>
      authorizeCandidateEnvironment({
        ...explicitOptions(),
        sourceEnv: { OPENAI_API_KEY: secret },
        adapterCredentials: {
          declaredEnvNames: ["ADAPTER_TEST_KEY"],
          environment: { ADAPTER_TEST_KEY: secret },
        },
      }),
    [secret, releaseDigest],
  );
});

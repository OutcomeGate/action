import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  access,
  chmod,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, "../..");
const actionPath = join(projectRoot, "action.yml");
const counterExample = join(projectRoot, "examples/counter");

async function actionGateScript(): Promise<string> {
  const source = await readFile(actionPath, "utf8");
  const stepMarker = "    - name: Run Agent CI gate\n";
  const stepStart = source.indexOf(stepMarker);
  assert.notEqual(stepStart, -1, "action gate step is missing");
  const runMarker = "      run: |\n";
  const runStart = source.indexOf(runMarker, stepStart);
  assert.notEqual(runStart, -1, "action gate run block is missing");
  const indented = source.slice(runStart + runMarker.length);
  const lines = indented.split("\n");
  assert.ok(
    lines.every((line) => line.length === 0 || line.startsWith("        ")),
    "gate run block must remain the final Action block",
  );
  return lines
    .map((line) => (line.length === 0 ? "" : line.slice(8)))
    .join("\n");
}

async function actionCredentialPreflightScript(): Promise<string> {
  const source = await readFile(actionPath, "utf8");
  const stepMarker =
    "    - name: Enforce the credential-free Action boundary\n";
  const stepStart = source.indexOf(stepMarker);
  assert.notEqual(stepStart, -1, "credential-free Action preflight is missing");
  const runMarker = "      run: |\n";
  const runStart = source.indexOf(runMarker, stepStart);
  assert.notEqual(runStart, -1, "credential-free preflight run block is missing");
  const remainder = source.slice(runStart + runMarker.length);
  const nextStep = remainder.indexOf("\n    - name:");
  assert.notEqual(nextStep, -1, "credential-free preflight must precede setup");
  const lines = remainder.slice(0, nextStep).split("\n");
  assert.ok(
    lines.every((line) => line.length === 0 || line.startsWith("        ")),
    "credential-free preflight run block has invalid indentation",
  );
  return lines
    .map((line) => (line.length === 0 ? "" : line.slice(8)))
    .join("\n");
}

async function assertCredentialFreePreflightPrecedesRuntime(): Promise<void> {
  const source = await readFile(actionPath, "utf8");
  const preflight = source.indexOf(
    "    - name: Enforce the credential-free Action boundary\n",
  );
  const setup = source.indexOf("    - name: Set up Node.js\n");
  const gate = source.indexOf("    - name: Run Agent CI gate\n");

  assert.notEqual(preflight, -1, "credential-free Action preflight is missing");
  assert.notEqual(setup, -1, "Node.js setup step is missing");
  assert.notEqual(gate, -1, "Action gate step is missing");
  assert.ok(preflight < setup, "credential preflight must precede Node.js setup");
  assert.ok(setup < gate, "Node.js setup must precede the Action gate");

  const preflightBlock = source.slice(preflight, setup);
  assert.match(preflightBlock, /shell: sh/);
  assert.match(preflightBlock, /exit 2/);
  assert.match(preflightBlock, /AGENTCI_ALLOW_ADAPTER_ENV/);
  assert.match(preflightBlock, /AGENTCI_APPROVED_ADAPTER_DIGEST/);
  assert.match(preflightBlock, /AGENTCI_ALLOW_CANDIDATE_ENV/);
  assert.match(preflightBlock, /AGENTCI_APPROVED_RELEASE_DIGEST/);
  assert.match(source, /GITHUB_ACTION_PATH\/dist\/src\/cli\.js/);
  assert.doesNotMatch(source, /npm ci|npm run build/);
}

async function prepareWorkspace(root: string, name: string): Promise<string> {
  const workspace = join(root, name);
  await mkdir(workspace);
  await cp(counterExample, join(workspace, "counter"), { recursive: true });
  await mkdir(join(root, `${name}-runner-temp`));
  return workspace;
}

async function runGate(options: {
  script: string;
  root: string;
  workspace: string;
  shell?: "bash" | "sh";
  adapterManifest?: string;
  path?: string;
  report?: string;
  markdown?: string;
  allowAdapterEnv?: string;
  approvedAdapterDigest?: string;
  allowCandidateEnv?: string;
  approvedReleaseDigest?: string;
  credentialEnvironment?: Readonly<Record<string, string>>;
}): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolveResult, rejectResult) => {
    const workspaceName = options.workspace.split("/").at(-1)!;
    const child = spawn(options.shell ?? "bash", ["-c", options.script], {
      cwd: options.workspace,
      env: {
        ...process.env,
        ...options.credentialEnvironment,
        PATH: options.path ?? process.env.PATH,
        GITHUB_ACTION_PATH: projectRoot,
        GITHUB_WORKSPACE: options.workspace,
        RUNNER_TEMP: join(options.root, `${workspaceName}-runner-temp`),
        GITHUB_STEP_SUMMARY: join(options.workspace, "summary.md"),
        AGENTCI_SUITE: "counter/suite.json",
        AGENTCI_MANIFEST: "counter/releases/agent.release.json",
        AGENTCI_ADAPTER_MANIFEST:
          options.adapterManifest ?? "counter/adapter.manifest.json",
        AGENTCI_ALLOW_ADAPTER_ENV: options.allowAdapterEnv ?? "",
        AGENTCI_APPROVED_ADAPTER_DIGEST:
          options.approvedAdapterDigest ?? "",
        AGENTCI_ALLOW_CANDIDATE_ENV: options.allowCandidateEnv ?? "",
        AGENTCI_APPROVED_RELEASE_DIGEST:
          options.approvedReleaseDigest ?? "",
        AGENTCI_REPORT: options.report ?? ".agentci/report.json",
        AGENTCI_MARKDOWN: options.markdown ?? ".agentci/report.md",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.once("error", rejectResult);
    child.once("close", (code) => resolveResult({ code, stdout, stderr }));
  });
}

async function assertMissing(path: string): Promise<void> {
  await assert.rejects(access(path), (error: unknown) => {
    assert.equal((error as NodeJS.ErrnoException).code, "ENOENT");
    return true;
  });
}

async function plantLogicalCanaries(
  workspace: string,
  prefix: string,
): Promise<readonly string[]> {
  const suitePath = join(workspace, "counter/suite.json");
  const suite = JSON.parse(await readFile(suitePath, "utf8")) as {
    name: string;
    fixture: string;
    scenarios: Array<{ id: string }>;
  };
  const suiteName = `${prefix}-suite-logical-name`;
  const adapterId = `${prefix}-adapter-logical-id`;
  const scenarioId = `${prefix}-scenario-logical-id`;
  suite.name = suiteName;
  suite.fixture = adapterId;
  suite.scenarios[0]!.id = scenarioId;
  await writeFile(suitePath, JSON.stringify(suite), "utf8");

  const releasePath = join(workspace, "counter/releases/agent.release.json");
  const release = JSON.parse(await readFile(releasePath, "utf8")) as {
    name: string;
  };
  const releaseName = `${prefix}-release-logical-name`;
  release.name = releaseName;
  await writeFile(releasePath, JSON.stringify(release), "utf8");

  const adapterManifestPath = join(workspace, "counter/adapter.manifest.json");
  const adapterManifest = JSON.parse(
    await readFile(adapterManifestPath, "utf8"),
  ) as { id: string };
  adapterManifest.id = adapterId;
  await writeFile(adapterManifestPath, JSON.stringify(adapterManifest), "utf8");
  const adapterEntryPath = join(workspace, "counter/adapter.bundle/adapter.mjs");
  await writeFile(
    adapterEntryPath,
    (await readFile(adapterEntryPath, "utf8")).replaceAll(
      "counter.v1",
      adapterId,
    ),
    "utf8",
  );
  return [suiteName, releaseName, adapterId, scenarioId];
}

function assertCanariesAbsent(
  channels: readonly string[],
  canaries: readonly string[],
): void {
  for (const channel of channels) {
    for (const canary of canaries) {
      assert.equal(channel.includes(canary), false, `published logical identifier: ${canary}`);
    }
  }
}

test("the source Action gate preserves 0/1/2 and fails closed on publication", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "agentci-action-test-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  const script = await actionGateScript();
  const credentialPreflight = await actionCredentialPreflightScript();

  const passing = await prepareWorkspace(root, "passing");
  const passingCanaries = await plantLogicalCanaries(
    passing,
    "opaque-pass-7f31",
  );
  const pass = await runGate({ script, root, workspace: passing });
  assert.equal(pass.code, 0, `${pass.stdout}\n${pass.stderr}`);
  const passingSummary = await readFile(join(passing, "summary.md"), "utf8");
  assert.match(passingSummary, /Decision: PASS/);
  assert.match(passingSummary, /sanitized/i);
  const publishedJson = await readFile(
    join(passing, ".agentci/report.json"),
    "utf8",
  );
  const publishedMarkdown = await readFile(
    join(passing, ".agentci/report.md"),
    "utf8",
  );
  const published = JSON.parse(publishedJson) as Record<string, unknown>;
  assert.equal(published.schemaVersion, "agentci.publication.v1");
  assert.equal(published.profile, "sanitized");
  assert.doesNotMatch(JSON.stringify(published), /candidatePath|manifestPath/);
  const publishedScenarios = published.scenarios as Array<Record<string, unknown>>;
  assert.equal(Object.hasOwn(publishedScenarios[0]!, "events"), false);
  assert.equal(Object.hasOwn(publishedScenarios[0]!, "scenarioId"), false);
  assert.equal(publishedScenarios[0]!.scenario, 1);
  assert.equal(Object.hasOwn(published, "generatedAt"), false);
  assertCanariesAbsent(
    [pass.stdout, pass.stderr, passingSummary, publishedJson, publishedMarkdown],
    passingCanaries,
  );

  const blocking = await prepareWorkspace(root, "blocking");
  const blockingCanaries = await plantLogicalCanaries(
    blocking,
    "opaque-block-8d42",
  );
  const blockingSuitePath = join(blocking, "counter/suite.json");
  const originalSuite = await readFile(blockingSuitePath, "utf8");
  const blockingSuite = JSON.parse(originalSuite) as {
    scenarios: Array<{ assertions: Array<{ expected?: unknown }> }>;
  };
  blockingSuite.scenarios[0]!.assertions[0]!.expected = 3;
  const regressedSuite = JSON.stringify(blockingSuite);
  assert.notEqual(regressedSuite, originalSuite);
  await writeFile(blockingSuitePath, regressedSuite, "utf8");
  const block = await runGate({ script, root, workspace: blocking });
  assert.equal(block.code, 1, `${block.stdout}\n${block.stderr}`);
  const blockingSummary = await readFile(join(blocking, "summary.md"), "utf8");
  const blockingJson = await readFile(
    join(blocking, ".agentci/report.json"),
    "utf8",
  );
  const blockingMarkdown = await readFile(
    join(blocking, ".agentci/report.md"),
    "utf8",
  );
  assert.match(blockingSummary, /Decision: BLOCK/);
  assert.match(
    `${block.stdout}\n${block.stderr}`,
    /Agent CI block%3A scenario 1/,
  );
  assertCanariesAbsent(
    [block.stdout, block.stderr, blockingSummary, blockingJson, blockingMarkdown],
    blockingCanaries,
  );

  const invalid = await prepareWorkspace(root, "invalid");
  await mkdir(join(invalid, ".agentci"));
  await writeFile(join(invalid, ".agentci/report.json"), "stale", "utf8");
  await writeFile(join(invalid, ".agentci/report.md"), "stale", "utf8");
  const invalidResult = await runGate({
    script,
    root,
    workspace: invalid,
    adapterManifest: "counter/missing-adapter.manifest.json",
  });
  assert.equal(
    invalidResult.code,
    2,
    `${invalidResult.stdout}\n${invalidResult.stderr}`,
  );
  await assertMissing(join(invalid, ".agentci/report.json"));
  await assertMissing(join(invalid, ".agentci/report.md"));
  assert.equal(
    `${invalidResult.stdout}\n${invalidResult.stderr}`.includes(invalid),
    false,
  );
  assert.equal(
    `${invalidResult.stdout}\n${invalidResult.stderr}`.includes(
      "counter/missing-adapter.manifest.json",
    ),
    false,
  );

  const aliasedOutput = await prepareWorkspace(root, "aliased-output");
  const candidateEntry = join(
    aliasedOutput,
    "counter/releases/agent.bundle/candidate.mjs",
  );
  const candidateBefore = await readFile(candidateEntry, "utf8");
  const aliased = await runGate({
    script,
    root,
    workspace: aliasedOutput,
    report: "counter/releases/agent.bundle/candidate.mjs",
  });
  assert.equal(aliased.code, 2, `${aliased.stdout}\n${aliased.stderr}`);
  assert.match(
    `${aliased.stdout}\n${aliased.stderr}`,
    /must remain beneath the repository \.agentci directory/,
  );
  assert.equal(await readFile(candidateEntry, "utf8"), candidateBefore);

  const symlinkedOutput = await prepareWorkspace(root, "symlinked-output");
  await mkdir(join(symlinkedOutput, ".agentci"));
  const symlinkedSuitePath = join(symlinkedOutput, "counter/suite.json");
  const symlinkedSuiteBefore = await readFile(symlinkedSuitePath, "utf8");
  const reportSymlink = join(symlinkedOutput, ".agentci/report.json");
  await symlink("../counter/suite.json", reportSymlink);
  const symlinkAlias = await runGate({
    script,
    root,
    workspace: symlinkedOutput,
  });
  assert.equal(
    symlinkAlias.code,
    2,
    `${symlinkAlias.stdout}\n${symlinkAlias.stderr}`,
  );
  assert.equal(await readFile(symlinkedSuitePath, "utf8"), symlinkedSuiteBefore);
  assert.equal(await readFile(reportSymlink, "utf8"), symlinkedSuiteBefore);

  const sameOutput = await prepareWorkspace(root, "same-output");
  await mkdir(join(sameOutput, ".agentci"));
  const sameOutputPath = join(sameOutput, ".agentci/same.json");
  await writeFile(sameOutputPath, "preserve-me", "utf8");
  const sameTargetAlias = await runGate({
    script,
    root,
    workspace: sameOutput,
    report: ".agentci/same.json",
    markdown: ".agentci/same.json",
  });
  assert.equal(
    sameTargetAlias.code,
    2,
    `${sameTargetAlias.stdout}\n${sameTargetAlias.stderr}`,
  );
  assert.match(
    `${sameTargetAlias.stdout}\n${sameTargetAlias.stderr}`,
    /must resolve to different paths/,
  );
  assert.equal(await readFile(sameOutputPath, "utf8"), "preserve-me");

  const invalidDigest = await prepareWorkspace(root, "invalid-digest");
  await mkdir(join(invalidDigest, ".agentci"));
  await writeFile(join(invalidDigest, ".agentci/report.json"), "stale", "utf8");
  await writeFile(join(invalidDigest, ".agentci/report.md"), "stale", "utf8");
  const invalidDigestResult = await runGate({
    script: credentialPreflight,
    root,
    workspace: invalidDigest,
    shell: "sh",
    approvedReleaseDigest: "not-a-digest",
  });
  assert.equal(
    invalidDigestResult.code,
    2,
    `${invalidDigestResult.stdout}\n${invalidDigestResult.stderr}`,
  );
  assert.equal(
    `${invalidDigestResult.stdout}\n${invalidDigestResult.stderr}`.trim(),
    "",
  );
  await assertMissing(join(invalidDigest, ".agentci/report.json"));
  await assertMissing(join(invalidDigest, ".agentci/report.md"));

  const canaryWorkspace = await prepareWorkspace(root, "secret-canary");
  const canary = `ghp_${"c".repeat(36)}`;
  const canarySuitePath = join(canaryWorkspace, "counter/suite.json");
  const canarySuite = JSON.parse(
    await readFile(canarySuitePath, "utf8"),
  ) as { scenarios: Array<{ task: Record<string, unknown> }> };
  canarySuite.scenarios[0]!.task.canary = canary;
  await writeFile(canarySuitePath, JSON.stringify(canarySuite), "utf8");
  const canaryResult = await runGate({
    script,
    root,
    workspace: canaryWorkspace,
  });
  assert.equal(
    canaryResult.code,
    2,
    `${canaryResult.stdout}\n${canaryResult.stderr}`,
  );
  assert.match(
    `${canaryResult.stdout}\n${canaryResult.stderr}`,
    /detailed diagnostics withheld/,
  );
  assert.equal(
    `${canaryResult.stdout}\n${canaryResult.stderr}`.includes(canary),
    false,
  );
  await assertMissing(join(canaryWorkspace, ".agentci/report.json"));
  await assertMissing(join(canaryWorkspace, ".agentci/report.md"));

  const publicationFailure = await prepareWorkspace(root, "publication-failure");
  const fakeBin = join(root, "fake-bin");
  await mkdir(fakeBin);
  const failingCopy = join(fakeBin, "cp");
  await writeFile(failingCopy, "#!/bin/sh\nexit 1\n", "utf8");
  await chmod(failingCopy, 0o755);
  const publish = await runGate({
    script,
    root,
    workspace: publicationFailure,
    path: `${fakeBin}${delimiter}${process.env.PATH ?? ""}`,
  });
  assert.equal(publish.code, 2, `${publish.stdout}\n${publish.stderr}`);
  assert.match(`${publish.stdout}\n${publish.stderr}`, /could not publish/);
  assert.match(
    await readFile(join(publicationFailure, "summary.md"), "utf8"),
    /Decision: PASS/,
  );
  await assertMissing(join(publicationFailure, ".agentci/report.json"));
  await assertMissing(join(publicationFailure, ".agentci/report.md"));

  const blockedPublication = await prepareWorkspace(root, "blocked-publication");
  const blockedSuitePath = join(blockedPublication, "counter/suite.json");
  await writeFile(
    blockedSuitePath,
    (await readFile(blockedSuitePath, "utf8")).replace(
      '"expected": 2',
      '"expected": 3',
    ),
    "utf8",
  );
  const blockedPublish = await runGate({
    script,
    root,
    workspace: blockedPublication,
    path: `${fakeBin}${delimiter}${process.env.PATH ?? ""}`,
  });
  assert.equal(
    blockedPublish.code,
    1,
    `${blockedPublish.stdout}\n${blockedPublish.stderr}`,
  );
  assert.match(
    await readFile(join(blockedPublication, "summary.md"), "utf8"),
    /Decision: BLOCK/,
  );
});

test("the source Action rejects a credential input without emitting its fixed-diagnostic collision", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "agentci-action-diagnostic-test-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  await assertCredentialFreePreflightPrecedesRuntime();
  const script = await actionCredentialPreflightScript();
  const workspace = await prepareWorkspace(root, "diagnostic-collision");
  await mkdir(join(workspace, ".agentci"));
  await writeFile(join(workspace, ".agentci/report.json"), "stale", "utf8");
  await writeFile(join(workspace, ".agentci/report.md"), "stale", "utf8");
  const fixedDiagnostic =
    "::warning::Agent CI could not append Markdown evidence to the job summary.";

  const result = await runGate({
    script,
    root,
    workspace,
    shell: "sh",
    allowCandidateEnv: "MODEL_SANDBOX_KEY",
    credentialEnvironment: {
      MODEL_SANDBOX_KEY: fixedDiagnostic,
    },
  });
  const diagnostics = `${result.stdout}\n${result.stderr}`;

  assert.equal(result.code, 2, diagnostics);
  assert.equal(diagnostics.includes(fixedDiagnostic), false);
  assert.equal(diagnostics.trim(), "");
  await assertMissing(join(workspace, ".agentci/report.json"));
  await assertMissing(join(workspace, ".agentci/report.md"));
});

test("the source Action turns a nominal pass into indeterminate when the job summary cannot be appended", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "agentci-action-summary-test-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  const script = await actionGateScript();
  const workspace = await prepareWorkspace(root, "summary-failure");
  const fakeBin = join(root, "summary-fake-bin");
  await mkdir(fakeBin);
  const failingCat = join(fakeBin, "cat");
  await writeFile(failingCat, "#!/bin/sh\nexit 1\n", "utf8");
  await chmod(failingCat, 0o755);

  const result = await runGate({
    script,
    root,
    workspace,
    path: `${fakeBin}${delimiter}${process.env.PATH ?? ""}`,
  });
  const diagnostics = `${result.stdout}\n${result.stderr}`;

  assert.equal(result.code, 2, diagnostics);
  assert.match(
    diagnostics,
    /could not append Markdown evidence to the job summary/,
  );
  const publication = JSON.parse(
    await readFile(join(workspace, ".agentci/report.json"), "utf8"),
  ) as { decision: { verdict: string } };
  assert.equal(publication.decision.verdict, "pass");
  assert.match(
    await readFile(join(workspace, ".agentci/report.md"), "utf8"),
    /Decision: PASS/,
  );
  assert.equal(await readFile(join(workspace, "summary.md"), "utf8"), "");
});

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export type Verdict = "pass" | "block" | "indeterminate";

export interface ToolErrorShape {
  code: string;
  message: string;
}

export interface FaultSpec {
  tool: string;
  onCall: number;
  phase: "before" | "after";
  error: ToolErrorShape;
}

export interface JsonPointerAssertion {
  id: string;
  description?: string;
  type: "json_pointer";
  source: "state" | "output";
  pointer: string;
  operator: "equals" | "absent";
  expected?: JsonValue;
}

export interface EventCountAssertion {
  id: string;
  description?: string;
  type: "event_count";
  tool: string;
  outcome?: "any" | "ok" | "error";
  expected: number;
}

export interface EventOrderAssertion {
  id: string;
  description?: string;
  type: "event_order";
  tools: string[];
}

export type AssertionSpec =
  | JsonPointerAssertion
  | EventCountAssertion
  | EventOrderAssertion;

export interface ScenarioSpec {
  id: string;
  description: string;
  task: JsonValue;
  initialState: JsonValue;
  faults: FaultSpec[];
  assertions: AssertionSpec[];
  timeoutMs: number;
  maxToolCalls: number;
}

export interface GateSpec {
  minPassRate: number;
}

export interface SuiteSpec {
  schemaVersion: "agentci.suite.v1";
  name: string;
  version: string;
  fixture: string;
  gate: GateSpec;
  scenarios: ScenarioSpec[];
}

export interface ToolEvent {
  sequence: number;
  requestId: string;
  tool: string;
  arguments: JsonValue;
  outcome: "ok" | "error";
  content?: JsonValue;
  error?: ToolErrorShape;
  fault?: FaultSpec;
  committed: boolean;
  beforeStateHash: string;
  afterStateHash: string;
  durationMs: number;
}

export interface AssertionResult {
  id: string;
  description?: string;
  passed: boolean;
  expected?: JsonValue;
  observed?: JsonValue;
  message: string;
}

export interface ScenarioResult {
  scenarioId: string;
  description: string;
  verdict: Verdict;
  reasons: string[];
  initialStateHash: string;
  finalStateHash: string;
  output?: JsonValue;
  events: ToolEvent[];
  assertions: AssertionResult[];
  candidateDiagnostics: CandidateDiagnostics;
  durationMs: number;
}

export interface CandidateDiagnostics {
  stderrDigest: string;
  stderrBytes: number;
  stderrTruncated: boolean;
}

export interface GateDecision {
  verdict: Verdict;
  reasons: string[];
  passed: number;
  blocked: number;
  indeterminate: number;
  total: number;
  passRate: number;
}

export interface NoModelSpec {
  kind: "none";
  reason: string;
}

export interface RemoteModelSpec {
  kind: "remote";
  provider: string;
  identifier: string;
  revision: string;
  configuration?: JsonValue;
}

export type ReleaseModelSpec = NoModelSpec | RemoteModelSpec;

export type CandidateCredentialPolicySpec =
  | { kind: "none" }
  | { kind: "environment"; environment: readonly string[] };

interface ReleaseManifestCommon {
  name: string;
  runtime: {
    kind: "node-jsonl";
    protocolVersion: 1;
    entry: string;
  };
  bundle: {
    root: string;
  };
  model: ReleaseModelSpec;
  components: {
    prompts: string[];
    toolSchemas: string[];
  };
}

export interface ReleaseManifestSpecV1 extends ReleaseManifestCommon {
  schemaVersion: "agentci.release.v1";
}

export interface ReleaseManifestSpecV2 extends ReleaseManifestCommon {
  schemaVersion: "agentci.release.v2";
  candidate: {
    credentials: CandidateCredentialPolicySpec;
  };
}

export type ReleaseManifestSpec =
  | ReleaseManifestSpecV1
  | ReleaseManifestSpecV2;

export interface BundleFileIdentity {
  path: string;
  digest: string;
  bytes: number;
  mode: number;
}

export type ReleaseFileIdentity = BundleFileIdentity;

export type AdapterConfiguration = { [key: string]: JsonValue };

export interface SyntheticAdapterTargetSpec {
  kind: "synthetic";
  reason: string;
  configuration: AdapterConfiguration;
}

export interface RemoteAdapterTargetSpec {
  kind: "remote";
  endpoint: string;
  tenant: string;
  apiVersion: string;
  configuration: AdapterConfiguration;
}

export type AdapterTargetSpec =
  | SyntheticAdapterTargetSpec
  | RemoteAdapterTargetSpec;

export interface AdapterManifestSpec {
  schemaVersion: "agentci.adapter-manifest.v1";
  id: string;
  version: string;
  runtime: {
    kind: "node-esm";
    apiVersion: "agentci.adapter.v2";
    protocolVersion: 1;
    entry: string;
    operationTimeoutMs: number;
    shutdownTimeoutMs: number;
  };
  bundle: {
    root: string;
  };
  contract: {
    tools: string[];
  };
  target: AdapterTargetSpec;
  credentials: {
    environment: string[];
  };
}

export interface ManifestAdapterIdentity {
  apiVersion: "agentci.adapter.v2";
  id: string;
  version: string;
  source: "external-manifest";
  digestScope: "declared-config-and-adapter-bundle-bytes";
  manifestDigest: string;
  bundleDigest: string;
  configurationDigest: string;
  credentialDeclarationDigest: string;
  contractDigest: string;
  adapterDigest: string;
  entryPath: string;
  entryFileDigest: string;
  fileCount: number;
  manifest: AdapterManifestSpec;
  files: BundleFileIdentity[];
  execution: {
    nodeVersion: string;
    platform: string;
    architecture: string;
  };
}

export interface EntryFileReleaseIdentity {
  name: string;
  candidatePath: string;
  entryFileDigest: string;
  digestScope: "entry-file-only";
}

export interface ManifestReleaseIdentity {
  name: string;
  candidatePath: string;
  entryFileDigest: string;
  digestScope: "declared-config-and-bundle-bytes";
  manifestPath: string;
  manifestDigest: string;
  releaseDigest: string;
  bundleDigest: string;
  modelDeclarationDigest: string;
  promptDigest: string;
  toolSchemaDigest: string;
  harnessDigest: string;
  entryPath: string;
  fileCount: number;
  manifest: ReleaseManifestSpec;
  files: ReleaseFileIdentity[];
  execution: {
    nodeVersion: string;
    platform: string;
    architecture: string;
  };
}

export type ReleaseIdentity =
  | EntryFileReleaseIdentity
  | ManifestReleaseIdentity;

export interface LegacyAdapterIdentity {
  apiVersion: "agentci.adapter.v1";
  id: string;
  version: string;
  source: "builtin" | "external";
  modulePath: string;
  moduleDigest: string;
  digestScope: "module-entry-only";
}

export type AdapterIdentity = LegacyAdapterIdentity | ManifestAdapterIdentity;

export interface EvaluatorIdentity {
  name: "agent-ci";
  version: string;
  buildDigest: string;
}

export interface ReleaseReport {
  schemaVersion: "agentci.report.v3";
  generatedAt: string;
  durationMs: number;
  suite: {
    name: string;
    version: string;
    path: string;
    digest: string;
    fixture: string;
  };
  release: ReleaseIdentity;
  adapter: AdapterIdentity;
  evaluator: EvaluatorIdentity;
  scenarios: ScenarioResult[];
  decision: GateDecision;
  evidenceDigest: string;
}

export interface SanitizedPublicationScenario {
  scenario: number;
  verdict: Verdict;
  reasonCount: number;
  assertionsPassed: number;
  assertionsTotal: number;
  toolCallCount: number;
  candidateStderrBytes: number;
  candidateStderrTruncated: boolean;
}

export interface SanitizedPublicationReport {
  schemaVersion: "agentci.publication.v1";
  profile: "sanitized";
  sourceEvidenceDigest: string;
  suite: { digest: string };
  release:
    | {
        digestScope: "entry-file-only";
        entryFileDigest: string;
      }
    | {
        digestScope: "declared-config-and-bundle-bytes";
        releaseDigest: string;
      };
  adapter:
    | {
        digestScope: "module-entry-only";
        moduleDigest: string;
      }
    | {
        digestScope: "declared-config-and-adapter-bundle-bytes";
        adapterDigest: string;
      };
  evaluator: EvaluatorIdentity;
  scenarios: SanitizedPublicationScenario[];
  decision: {
    verdict: Verdict;
    passed: number;
    blocked: number;
    indeterminate: number;
    total: number;
    passRate: number;
  };
  publication: {
    fullEvidencePublished: false;
    rawCandidateStderrPublished: false;
    omitted: string[];
    recommendedRetentionDays: number;
  };
  publicationDigest: string;
}

export interface ComparisonReport {
  schemaVersion: "agentci.comparison.v1";
  baselineEvidenceDigest: string;
  candidateEvidenceDigest: string;
  suiteDigest: string;
  verdict: Verdict;
  reasons: string[];
  fixed: string[];
  regressed: string[];
  unchangedPass: string[];
  unchangedBlock: string[];
}

export interface Environment {
  readonly tools: string[];
  call(tool: string, argumentsValue: JsonValue): Promise<JsonValue>;
  snapshot(): JsonValue | Promise<JsonValue>;
  transition?(
    request: EnvironmentTransitionRequest,
  ): EnvironmentTransitionResult | Promise<EnvironmentTransitionResult>;
  inspectCandidateStderr?(chunk: Uint8Array): void;
  inspectCandidateProtocol?(message: JsonValue): void;
  abort?(reason: string): void | Promise<void>;
  close?(): void | Promise<void>;
}

export type EnvironmentTransitionRequest =
  | { invoke: false }
  | { invoke: true; tool: string; arguments: JsonValue };

export type EnvironmentTransitionOutcome =
  | { kind: "ok"; content: JsonValue }
  | { kind: "tool_error"; error: ToolErrorShape }
  | { kind: "skipped" };

export interface EnvironmentTransitionResult {
  beforeState: JsonValue;
  afterState: JsonValue;
  outcome: EnvironmentTransitionOutcome;
}

export interface AdapterConformanceCase {
  name: string;
  initialState: JsonValue;
  call: {
    tool: string;
    arguments: JsonValue;
  };
  expectedResult: JsonValue;
  expectedFinalState: JsonValue;
}

export interface AdapterDefinition {
  apiVersion: "agentci.adapter.v1";
  id: string;
  version: string;
  tools: readonly string[];
  conformance: readonly AdapterConformanceCase[];
  validateSuite(suite: SuiteSpec): string[];
  validateStatePointer(pointer: string, initialState: JsonValue): string | undefined;
  createEnvironment(initialState: JsonValue): Environment | Promise<Environment>;
}

export interface AdapterRuntime {
  apiVersion: "agentci.adapter.v1" | "agentci.adapter.v2";
  id: string;
  version: string;
  tools: readonly string[];
  conformance: readonly AdapterConformanceCase[];
  validateSuite(suite: SuiteSpec): string[] | Promise<string[]>;
  validateStatePointer(
    pointer: string,
    initialState: JsonValue,
  ): string | undefined | Promise<string | undefined>;
  validate?(
    suite: SuiteSpec,
    pointers: readonly AdapterPointerValidationRequest[],
  ): AdapterValidationBatch | Promise<AdapterValidationBatch>;
  createEnvironment(
    initialState: JsonValue,
    context?: { scenarioId: string; timeoutMs: number },
  ): Environment | Promise<Environment>;
}

export interface AdapterPointerValidationRequest {
  id: string;
  pointer: string;
  initialState: JsonValue;
}

export interface AdapterValidationBatch {
  issues: string[];
  pointers: Array<{ id: string; issue?: string }>;
}

export interface LoadedAdapter {
  definition: AdapterRuntime;
  identity: AdapterIdentity;
  credentialBoundary: {
    declaredEnvNames: readonly string[];
    environment: Readonly<Record<string, string>>;
  };
  verifyIdentity(): Promise<string[]>;
  closeValidationHost(): Promise<string[]>;
}

export interface CandidateStartMessage {
  v: 1;
  type: "start";
  scenarioId: string;
  task: JsonValue;
  tools: string[];
}

export interface CandidateCallMessage {
  v: 1;
  type: "call";
  id: string;
  tool: string;
  arguments: JsonValue;
}

export interface CandidateDoneMessage {
  v: 1;
  type: "done";
  output: JsonValue;
}

export interface RunnerResultMessage {
  v: 1;
  type: "result";
  id: string;
  ok: boolean;
  content?: JsonValue;
  error?: ToolErrorShape;
}

export type CandidateMessage = CandidateCallMessage | CandidateDoneMessage;

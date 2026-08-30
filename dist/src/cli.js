#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { basename, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import { loadExternalAdapter, loadManifestAdapter, resolveAdapter, runAdapterConformance, validateSuiteAgainstAdapter, } from "./adapter.js";
import { loadAdapterManifest } from "./adapter-manifest.js";
import { compareReports, renderComparison } from "./comparison.js";
import { assertNoKnownSecretLeaks, } from "./credential-policy.js";
import { AdapterValidationError, SuiteValidationError } from "./errors.js";
import { initializeStarter } from "./init.js";
import { loadReleaseManifest } from "./release.js";
import { renderConsoleSummary, renderMarkdownReport, renderSanitizedConsoleSummary, renderSanitizedPublicationMarkdown, isReleaseReport, verifyEvidenceDigest, writeJsonReport, writeSanitizedPublicationReport, writeTextFile, } from "./report.js";
import { runSuiteWithEvidenceGuard, runSuiteWithSanitizedPublication, } from "./runner.js";
import { assertSecretScanClean, scanTextForSecrets, } from "./secret-scan.js";
import { parseStrictJson } from "./strict-json.js";
import { loadSuite } from "./suite.js";
const HELP = `Agent CI — local release assurance for structured agents

Usage:
  agentci init [directory]
  agentci check --suite <suite.json> --manifest <release.json> [options]
  agentci check --suite <suite.json> --candidate <candidate.js> --release <name>
  agentci compare --baseline <report.json> --candidate <report.json>
  agentci validate --suite <suite.json> [--adapter-manifest <adapter.json>]
  agentci validate-release --manifest <release.json>
  agentci validate-adapter --manifest <adapter.json>
  agentci adapter-check (--adapter-manifest <adapter.json> | --adapter <adapter.js>)

check options:
  --manifest <path>    Declared release manifest (recommended path)
  --candidate <path>   Legacy entry-file-only candidate
  --release <name>     Required label for a legacy candidate
  --adapter-manifest <path>
                       Declared isolated adapter (recommended path)
  --adapter <path>     Legacy in-process module; compatibility only
  --allow-adapter-env <name>
                       Repeatable exact credential allowlist
  --approved-adapter-digest <sha256>
                       Required grant pin for credentialed adapters
  --allow-candidate-env <name>
                       Repeatable exact candidate credential allowlist
  --approved-release-digest <sha256>
                       Required release pin for candidate credentials
  --require-explicit-candidate-policy
                       Require agentci.release.v2 (source Action default)
  --report <path>      Write the JSON evidence report
  --markdown <path>    Write a Markdown summary
  --publication-report <path>
                       Write sanitized JSON evidence for publication
  --publication-markdown <path>
                       Write a sanitized Markdown publication summary
  --github             Emit sanitized GitHub workflow annotations

Exit codes: 0 pass, 1 block, 2 indeterminate/configuration error.
`;
const CREDENTIAL_VALUE_OPTIONS = new Set([
    "--allow-adapter-env",
    "--allow-candidate-env",
]);
function credentialNamesFromArgv(argv) {
    const names = [];
    for (let index = 0; index < argv.length; index += 1) {
        const argument = argv[index];
        const equals = [...CREDENTIAL_VALUE_OPTIONS].find((option) => argument.startsWith(`${option}=`));
        if (equals !== undefined) {
            names.push(argument.slice(equals.length + 1));
            continue;
        }
        if (CREDENTIAL_VALUE_OPTIONS.has(argument) && index + 1 < argv.length) {
            names.push(argv[index + 1]);
            index += 1;
        }
    }
    return names;
}
const invokedCredentialNames = credentialNamesFromArgv(process.argv.slice(2));
const invokedCredentialSecrets = Object.freeze(invokedCredentialNames.flatMap((name, index) => {
    const value = process.env[name];
    return typeof value === "string" && value.length > 0
        ? [Object.freeze({ ruleId: `cli-credential-${index + 1}`, value })]
        : [];
}));
function invocationCredentialSource(names) {
    return Object.freeze(Object.fromEntries((names ?? []).map((name) => [name, process.env[name]])));
}
let useFixedActionDiagnostics = process.argv.includes("--github") || invokedCredentialNames.length > 0;
function exitCode(verdict) {
    if (verdict === "pass") {
        return 0;
    }
    if (verdict === "block") {
        return 1;
    }
    return 2;
}
function shellQuote(value) {
    return `'${value.replaceAll("'", `'"'"'`)}'`;
}
async function readReport(path) {
    const raw = await readFile(resolve(path), "utf8");
    const value = parseStrictJson(raw);
    if (!isReleaseReport(value)) {
        throw new Error(`${path} is not an Agent CI v3 report`);
    }
    if (!verifyEvidenceDigest(value)) {
        throw new Error(`${path} evidence digest does not match its contents`);
    }
    return value;
}
function githubEscape(value) {
    return value
        .replaceAll("%", "%25")
        .replaceAll("\r", "%0D")
        .replaceAll("\n", "%0A");
}
function githubPropertyEscape(value) {
    return githubEscape(value).replaceAll(":", "%3A").replaceAll(",", "%2C");
}
function renderGithubAnnotations(report, assertSemanticSafe) {
    return report.scenarios
        .flatMap((scenario, index) => {
        if (scenario.verdict === "pass") {
            return [];
        }
        const title = `Agent CI ${scenario.verdict}: scenario ${index + 1}`;
        const message = "Sanitized annotation: inspect protected local evidence for details.";
        // GitHub decodes workflow-command escapes before displaying these
        // fields, so guard both semantic values as well as the encoded bytes.
        assertSemanticSafe(title);
        assertSemanticSafe(message);
        return [
            `::error title=${githubPropertyEscape(title)}::${githubEscape(message)}`,
        ];
    })
        .join("\n");
}
function assertNoInvokedCredentialLeaks(content) {
    assertNoKnownSecretLeaks(content, invokedCredentialSecrets);
}
function writeScannedStdout(content, boundary) {
    assertNoInvokedCredentialLeaks(content);
    assertSecretScanClean(scanTextForSecrets({ path: "cli/stdout.txt", text: content }), boundary);
    process.stdout.write(content);
}
function writeScannedStderr(content, boundary) {
    assertNoInvokedCredentialLeaks(content);
    assertSecretScanClean(scanTextForSecrets({ path: "cli/stderr.txt", text: content }), boundary);
    process.stderr.write(content);
}
function publishableErrorMessage(error) {
    const message = error instanceof Error ? error.message : String(error);
    try {
        assertSecretScanClean(scanTextForSecrets({ path: "cli/error.txt", text: message }), "CLI diagnostics");
        return message;
    }
    catch {
        return "operation failed; diagnostics withheld by static secret scanning";
    }
}
async function main() {
    const parsed = parseArgs({
        allowPositionals: true,
        strict: true,
        options: {
            suite: { type: "string" },
            candidate: { type: "string" },
            manifest: { type: "string" },
            adapter: { type: "string" },
            "adapter-manifest": { type: "string" },
            "allow-adapter-env": { type: "string", multiple: true },
            "approved-adapter-digest": { type: "string" },
            "allow-candidate-env": { type: "string", multiple: true },
            "approved-release-digest": { type: "string" },
            "require-explicit-candidate-policy": { type: "boolean" },
            baseline: { type: "string" },
            release: { type: "string" },
            report: { type: "string" },
            markdown: { type: "string" },
            "publication-report": { type: "string" },
            "publication-markdown": { type: "string" },
            github: { type: "boolean" },
            help: { type: "boolean", short: "h" },
        },
    });
    useFixedActionDiagnostics =
        parsed.values.github === true || invokedCredentialNames.length > 0;
    if (parsed.values.help === true || parsed.positionals.length === 0) {
        writeScannedStdout(HELP, "CLI help output");
        return 0;
    }
    const command = parsed.positionals[0];
    if (command === "init") {
        if (parsed.positionals.length > 2) {
            throw new Error("init accepts at most one directory");
        }
        const unrelatedOptions = Object.entries(parsed.values).filter(([name, value]) => name !== "help" && value !== undefined);
        if (unrelatedOptions.length > 0) {
            throw new Error("init does not accept check or validation options");
        }
        const target = await initializeStarter(parsed.positionals[1]);
        const displayTarget = relative(process.cwd(), target);
        writeScannedStdout([
            `created Agent CI starter at ${displayTarget}`,
            "",
            "Next:",
            `  cd ${shellQuote(displayTarget)}`,
            "  Follow README.md using this CLI path or an installed agentci command.",
            "",
            "The generated GitHub workflow is intentionally non-runnable until its all-zero Agent CI ref is replaced with a reviewed full commit SHA.",
            "",
        ].join("\n"), "CLI init output");
        return 0;
    }
    if (command !== "check" &&
        (parsed.values["allow-candidate-env"] !== undefined ||
            parsed.values["approved-release-digest"] !== undefined ||
            parsed.values["require-explicit-candidate-policy"] === true)) {
        throw new Error("candidate credential options are valid only for check");
    }
    if (parsed.values.adapter !== undefined &&
        parsed.values["adapter-manifest"] !== undefined) {
        throw new Error("--adapter and --adapter-manifest are mutually exclusive");
    }
    if ((parsed.values["allow-adapter-env"] !== undefined ||
        parsed.values["approved-adapter-digest"] !== undefined) &&
        parsed.values["adapter-manifest"] === undefined) {
        throw new Error("adapter credential options require --adapter-manifest");
    }
    const adapterOptions = {
        ...(parsed.values.adapter !== undefined
            ? { adapterPath: parsed.values.adapter }
            : {}),
        ...(parsed.values["adapter-manifest"] !== undefined
            ? { adapterManifestPath: parsed.values["adapter-manifest"] }
            : {}),
        ...(parsed.values["allow-adapter-env"] !== undefined
            ? {
                callerAllowlist: parsed.values["allow-adapter-env"],
                sourceEnv: invocationCredentialSource(parsed.values["allow-adapter-env"]),
            }
            : {}),
        ...(parsed.values["approved-adapter-digest"] !== undefined
            ? {
                approvedAdapterDigest: parsed.values["approved-adapter-digest"],
            }
            : {}),
    };
    if (command === "validate") {
        if (parsed.values.suite === undefined) {
            throw new Error("validate requires --suite");
        }
        const loaded = await loadSuite(parsed.values.suite);
        const adapter = await resolveAdapter({
            fixture: loaded.suite.fixture,
            ...adapterOptions,
        });
        const issues = await validateSuiteAgainstAdapter(loaded.suite, adapter.definition);
        issues.push(...(await adapter.closeValidationHost()));
        if (issues.length > 0) {
            throw new SuiteValidationError(issues);
        }
        writeScannedStdout(`valid ${loaded.suite.name}@${loaded.suite.version}: ${loaded.suite.scenarios.length} scenario(s), adapter contract ${adapter.definition.id}@${adapter.definition.version}\n`, "CLI validation output");
        if (adapter.identity.source === "external") {
            writeScannedStderr("warning: legacy --adapter is in-process and module-entry-only; it is not release evidence\n", "CLI adapter warning");
        }
        return 0;
    }
    if (command === "validate-release") {
        if (parsed.values.manifest === undefined) {
            throw new Error("validate-release requires --manifest");
        }
        const capture = await loadReleaseManifest(parsed.values.manifest);
        writeScannedStdout(`valid ${capture.identity.name}: ${capture.identity.fileCount} file(s), release ${capture.identity.releaseDigest}\n`, "CLI release-validation output");
        return 0;
    }
    if (command === "validate-adapter") {
        if (parsed.values.manifest === undefined) {
            throw new Error("validate-adapter requires --manifest");
        }
        if (parsed.values.adapter !== undefined ||
            parsed.values["adapter-manifest"] !== undefined) {
            throw new Error("validate-adapter uses --manifest, not --adapter or --adapter-manifest");
        }
        const capture = await loadAdapterManifest(parsed.values.manifest);
        writeScannedStdout(`valid declared adapter ${capture.identity.id}@${capture.identity.version}: ${capture.identity.fileCount} file(s), adapter ${capture.identity.adapterDigest} (not executed)\n`, "CLI adapter-validation output");
        return 0;
    }
    if (command === "adapter-check") {
        if ((parsed.values.adapter === undefined) ===
            (parsed.values["adapter-manifest"] === undefined)) {
            throw new Error("adapter-check requires exactly one of --adapter-manifest or --adapter");
        }
        const adapter = parsed.values["adapter-manifest"] !== undefined
            ? await loadManifestAdapter({
                manifestPath: parsed.values["adapter-manifest"],
                callerAllowlist: parsed.values["allow-adapter-env"] ?? [],
                sourceEnv: invocationCredentialSource(parsed.values["allow-adapter-env"]),
                ...(parsed.values["approved-adapter-digest"] !== undefined
                    ? {
                        approvedAdapterDigest: parsed.values["approved-adapter-digest"],
                    }
                    : {}),
            })
            : await loadExternalAdapter(parsed.values.adapter);
        const issues = [
            ...(await adapter.closeValidationHost()),
            ...(await runAdapterConformance(adapter.definition)),
            ...(await adapter.verifyIdentity()),
        ];
        if (issues.length > 0) {
            throw new AdapterValidationError(issues);
        }
        writeScannedStdout(`valid adapter ${adapter.definition.id}@${adapter.definition.version}: ${adapter.definition.conformance.length} conformance case(s)\n`, "CLI adapter-conformance output");
        if (adapter.identity.digestScope === "module-entry-only") {
            writeScannedStderr("warning: legacy --adapter identifies and imports only one module entry; it is not release evidence\n", "CLI adapter warning");
        }
        return 0;
    }
    if (command === "check") {
        if (parsed.values.suite === undefined) {
            throw new Error("check requires --suite");
        }
        if ((parsed.values.manifest === undefined) ===
            (parsed.values.candidate === undefined)) {
            throw new Error("check requires exactly one of --manifest or --candidate");
        }
        if (parsed.values.manifest !== undefined &&
            parsed.values.release !== undefined) {
            throw new Error("--release cannot override the name in --manifest");
        }
        if (parsed.values.candidate !== undefined &&
            parsed.values.release === undefined) {
            throw new Error("legacy --candidate checks require --release");
        }
        const common = {
            suitePath: parsed.values.suite,
            ...adapterOptions,
            ...(parsed.values["allow-adapter-env"] !== undefined
                ? {
                    adapterSourceEnv: invocationCredentialSource(parsed.values["allow-adapter-env"]),
                }
                : {}),
            ...(parsed.values["allow-candidate-env"] !== undefined
                ? {
                    candidateCallerAllowlist: parsed.values["allow-candidate-env"],
                    candidateSourceEnv: invocationCredentialSource(parsed.values["allow-candidate-env"]),
                }
                : {}),
            ...(parsed.values["approved-release-digest"] !== undefined
                ? {
                    approvedReleaseDigest: parsed.values["approved-release-digest"],
                }
                : {}),
            ...(parsed.values["require-explicit-candidate-policy"] === true
                ? { requireExplicitCandidatePolicy: true }
                : {}),
        };
        const publicationRequested = parsed.values.github === true ||
            parsed.values["publication-report"] !== undefined ||
            parsed.values["publication-markdown"] !== undefined;
        const execute = async (options) => publicationRequested
            ? runSuiteWithSanitizedPublication(options)
            : {
                ...(await runSuiteWithEvidenceGuard(options)),
                publication: undefined,
            };
        const execution = parsed.values.manifest !== undefined
            ? await execute({
                ...common,
                releaseManifestPath: parsed.values.manifest,
            })
            : await execute({
                ...common,
                candidatePath: resolve(parsed.values.candidate),
                releaseName: parsed.values.release ??
                    basename(parsed.values.candidate).replace(/\.[^.]+$/, ""),
            });
        const { report, publication, assertNoExecutionSecretLeaks } = execution;
        if (report.release.digestScope === "entry-file-only") {
            writeScannedStderr("warning: legacy check identifies only the candidate entry file; use --manifest for release evidence\n", "CLI release warning");
        }
        if (report.adapter.digestScope === "module-entry-only") {
            writeScannedStderr("warning: this check uses a module-entry-only adapter; use --adapter-manifest for release evidence\n", "CLI adapter warning");
        }
        if (parsed.values.report !== undefined) {
            assertNoExecutionSecretLeaks?.(`${JSON.stringify(report, null, 2)}\n`);
            await writeJsonReport(parsed.values.report, report);
        }
        if (parsed.values.github === true) {
            const assertSemanticSafe = (value) => {
                assertNoInvokedCredentialLeaks(value);
                assertNoExecutionSecretLeaks?.(value);
            };
            const annotations = renderGithubAnnotations(report, assertSemanticSafe);
            if (annotations.length > 0) {
                const annotationOutput = `${annotations}\n`;
                assertNoExecutionSecretLeaks?.(annotationOutput);
                writeScannedStdout(annotationOutput, "GitHub annotations");
            }
        }
        if (parsed.values.markdown !== undefined) {
            const markdown = renderMarkdownReport(report);
            assertNoExecutionSecretLeaks?.(markdown);
            await writeTextFile(parsed.values.markdown, markdown);
        }
        if (parsed.values["publication-report"] !== undefined ||
            parsed.values["publication-markdown"] !== undefined) {
            if (publication === undefined) {
                throw new Error("sanitized publication could not be constructed");
            }
            if (parsed.values["publication-report"] !== undefined) {
                assertNoExecutionSecretLeaks?.(`${JSON.stringify(publication, null, 2)}\n`);
                await writeSanitizedPublicationReport(parsed.values["publication-report"], publication);
            }
            if (parsed.values["publication-markdown"] !== undefined) {
                const publicationMarkdown = renderSanitizedPublicationMarkdown(publication);
                assertNoExecutionSecretLeaks?.(publicationMarkdown);
                await writeTextFile(parsed.values["publication-markdown"], publicationMarkdown);
            }
        }
        const summary = publication === undefined
            ? renderConsoleSummary(report)
            : renderSanitizedConsoleSummary(publication);
        const summaryOutput = `${summary}\n`;
        assertNoExecutionSecretLeaks?.(summaryOutput);
        writeScannedStdout(summaryOutput, "CLI evidence summary");
        return exitCode(report.decision.verdict);
    }
    if (command === "compare") {
        if (parsed.values.baseline === undefined ||
            parsed.values.candidate === undefined) {
            throw new Error("compare requires --baseline and --candidate");
        }
        const baseline = await readReport(parsed.values.baseline);
        const candidate = await readReport(parsed.values.candidate);
        const comparison = compareReports(baseline, candidate);
        writeScannedStdout(`${renderComparison(comparison)}\n`, "CLI comparison output");
        return exitCode(comparison.verdict);
    }
    throw new Error(`unknown command: ${command ?? ""}`);
}
main()
    .then((code) => {
    process.exitCode = code;
})
    .catch((error) => {
    const diagnostic = `INDETERMINATE ${useFixedActionDiagnostics
        ? "configuration or execution failed; detailed diagnostics withheld on the Action boundary"
        : publishableErrorMessage(error)}\n`;
    try {
        writeScannedStderr(diagnostic, "CLI failure diagnostics");
    }
    catch {
        // Exit status 2 remains the signal when no diagnostic string is safe to
        // emit for the exact credential values supplied to this invocation.
    }
    process.exitCode = 2;
});

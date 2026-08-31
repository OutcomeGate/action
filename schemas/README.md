---
type: reference
title: OutcomeGate schema status
description: Status and authority boundary for the JSON Schema contract sketches.
tags: [outcomegate, schemas, contract]
timestamp: 2026-08-29T00:00:00-05:00
---

# Schema status

These schemas are informative editor and integration aids. They are not the runtime validation authority.

- `release-v2.schema.json` sketches the supported `agentci.release.v2` contract, including its explicit candidate credential policy and closed local-model artifact declaration; `src/release.ts` and `src/candidate-credential-policy.ts` add canonicalization, filesystem, capture-stability, symlink, mode, size, component, artifact-disjointness, reserved-name, allowlist, value-separation, and digest-grant checks. `release.schema.json` remains the release-v1 compatibility sketch and does not accept local-model declarations.
- `adapter.schema.json` sketches `agentci.adapter-manifest.v1`; `src/adapter-manifest.ts` adds normalization, HTTPS target, reserved environment-name, filesystem, capture-stability, symlink, mode, size, and composite identity checks.
- `suite.schema.json` sketches `agentci.suite.v1`; `src/suite.ts`, core adapter checks, and the selected adapter define accepted input.
- `report.schema.json` sketches `agentci.report.v3`; `src/report.ts` validates exact structure, release/adapter component digests, bounded candidate-stderr metadata, and evaluator identity, while report readers separately verify the evidence digest.
- `publication.schema.json` sketches the reduced `agentci.publication.v1` derivative; `src/report.ts` verifies the source report digest, constructs the closed projection, computes its independent digest, and scans exact serializations before write.

Report v1 was an unpublished MVP format. Version `0.2.0` advanced to report v3 rather than stretching v2 adapter semantics; version `0.3.0` retains report v3 and adds the distinct publication-v1 projection. Old report-v1/v2 evidence must be regenerated before comparison. Release v1, legacy release-entry, and raw adapter paths remain compatibility-only; the source Action requires release v2 plus the closed adapter manifest.

Before publishing an SDK, generate normative schemas from a single shared contract and add conformance tests proving that schema and runtime acceptance remain identical.

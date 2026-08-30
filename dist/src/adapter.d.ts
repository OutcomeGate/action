import { type AdapterManifestCapture } from "./adapter-manifest.js";
import type { AdapterDefinition, AdapterIdentity, AdapterRuntime, LoadedAdapter, ManifestAdapterIdentity, SuiteSpec } from "./types.js";
export declare function assertAdapterDefinition(value: unknown): AdapterDefinition;
export declare function defineAdapter<T extends AdapterDefinition>(definition: T): T;
export declare function loadExternalAdapter(path: string): Promise<LoadedAdapter>;
export declare function loadManifestAdapter(options: {
    manifestPath: string;
    callerAllowlist?: readonly string[];
    approvedAdapterDigest?: string;
    sourceEnv?: Readonly<Record<string, string | undefined>>;
    preparation?: PreparedManifestAdapter;
    candidateCredentialEnvironment?: Readonly<Record<string, string>>;
}): Promise<LoadedAdapter>;
export interface PreparedManifestAdapter {
    capture: AdapterManifestCapture;
    credentials: Readonly<Record<string, string>>;
}
export declare function prepareManifestAdapter(options: {
    manifestPath: string;
    callerAllowlist?: readonly string[];
    approvedAdapterDigest?: string;
    sourceEnv?: Readonly<Record<string, string | undefined>>;
}): Promise<PreparedManifestAdapter>;
export declare function resolveAdapter(options: {
    fixture: string;
    adapterPath?: string;
    adapterManifestPath?: string;
    callerAllowlist?: readonly string[];
    approvedAdapterDigest?: string;
    sourceEnv?: Readonly<Record<string, string | undefined>>;
    manifestPreparation?: PreparedManifestAdapter;
    candidateCredentialEnvironment?: Readonly<Record<string, string>>;
}): Promise<LoadedAdapter>;
export declare function validateSuiteAgainstAdapter(suite: SuiteSpec, adapter: AdapterRuntime): Promise<string[]>;
export declare function runAdapterConformance(adapterValue: unknown): Promise<string[]>;
export declare function verifyAdapterIdentity(identity: AdapterIdentity): Promise<string[]>;
export declare function isManifestAdapterIdentity(identity: AdapterIdentity): identity is ManifestAdapterIdentity;

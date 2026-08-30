import type { BundleFileIdentity } from "./types.js";
export declare const MAX_BUNDLE_FILES = 1000;
export declare const MAX_BUNDLE_BYTES: number;
export interface CapturedBundleFile extends BundleFileIdentity {
    content: Uint8Array;
}
export interface CapturedBundle {
    sourceRoot: string;
    files: CapturedBundleFile[];
}
type ErrorFactory = (issues: string[]) => Error;
export declare function compareCanonicalText(left: string, right: string): number;
export declare function isSafeRelativePath(value: string): boolean;
export declare function bundleFileIdentities(files: readonly CapturedBundleFile[]): BundleFileIdentity[];
export declare function computeBundleDigest(domain: string, files: readonly CapturedBundleFile[]): string;
export declare function captureDeclaredBundle(options: {
    manifestDirectory: string;
    relativeRoot: string;
    createError: ErrorFactory;
}): Promise<CapturedBundle>;
export declare function materializeCapturedBundle(options: {
    files: readonly CapturedBundleFile[];
    prefix: string;
    createError: ErrorFactory;
}): Promise<string>;
export declare function materializedBundleMatches(options: {
    root: string;
    expectedFiles: readonly CapturedBundleFile[];
    createError: ErrorFactory;
}): Promise<boolean>;
export declare function cleanupMaterializedBundle(root: string): Promise<void>;
export {};

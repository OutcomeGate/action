import type { CapturedBundleFile } from "./bundle.js";
import type { AdapterManifestSpec, ManifestAdapterIdentity } from "./types.js";
export interface AdapterManifestCapture {
    manifestPath: string;
    bundleRoot: string;
    manifest: AdapterManifestSpec;
    identity: ManifestAdapterIdentity;
    files: CapturedBundleFile[];
}
export interface MaterializedAdapter {
    root: string;
    modulePath: string;
}
export declare function parseAdapterManifest(value: unknown): AdapterManifestSpec;
export declare function loadAdapterManifest(path: string): Promise<AdapterManifestCapture>;
export declare function materializeAdapter(capture: AdapterManifestCapture): Promise<MaterializedAdapter>;
export declare function verifyMaterializedAdapter(materialized: MaterializedAdapter, capture: AdapterManifestCapture): Promise<string[]>;
export declare function cleanupMaterializedAdapter(materialized: MaterializedAdapter): Promise<void>;

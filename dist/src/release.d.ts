import type { CapturedBundleFile } from "./bundle.js";
import type { ManifestReleaseIdentity, ReleaseManifestSpec } from "./types.js";
export interface ReleaseCapture {
    manifest: ReleaseManifestSpec;
    identity: ManifestReleaseIdentity;
    files: CapturedBundleFile[];
}
export interface MaterializedRelease {
    root: string;
    candidatePath: string;
}
export declare function parseReleaseManifest(value: unknown): ReleaseManifestSpec;
export declare function loadReleaseManifest(path: string): Promise<ReleaseCapture>;
export declare function materializeRelease(capture: ReleaseCapture): Promise<MaterializedRelease>;
export declare function verifyMaterializedRelease(materialized: MaterializedRelease, capture: ReleaseCapture): Promise<string[]>;
export declare function cleanupMaterializedRelease(materialized: MaterializedRelease): Promise<void>;

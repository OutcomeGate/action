import type { SuiteSpec } from "./types.js";
export declare function parseSuite(value: unknown): SuiteSpec;
export declare function loadSuite(path: string): Promise<{
    suite: SuiteSpec;
    path: string;
    raw: string;
}>;

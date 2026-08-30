import type { ComparisonReport, ReleaseReport } from "./types.js";
export declare function compareReports(baseline: ReleaseReport, candidate: ReleaseReport): ComparisonReport;
export declare function renderComparison(comparison: ComparisonReport): string;

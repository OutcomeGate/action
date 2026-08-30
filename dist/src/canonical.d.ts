import type { JsonValue } from "./types.js";
export declare function stableStringify(value: unknown): string;
export declare function digestValue(value: unknown): string;
export declare function digestFile(path: string): Promise<string>;
export declare function digestFiles(paths: string[]): Promise<string>;
export declare function digestNamedFiles(files: ReadonlyArray<{
    name: string;
    path: string;
}>): Promise<string>;
export declare function cloneJson<T extends JsonValue>(value: T): T;
export declare function isJsonValue(value: unknown): value is JsonValue;

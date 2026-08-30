export type StrictJsonErrorCode = "duplicate_member" | "input_too_large" | "invalid_syntax" | "nesting_too_deep" | "number_out_of_range";
export declare class StrictJsonError extends SyntaxError {
    readonly code: StrictJsonErrorCode;
    constructor(code: StrictJsonErrorCode, message: string);
}
/**
 * Parses JSON while rejecting duplicate object member names after escape
 * decoding. Native JSON.parse uses last-member-wins semantics, which can make
 * an earlier lexical token disappear before normalized secret/boundary scans.
 */
export declare function parseStrictJson(text: string): unknown;

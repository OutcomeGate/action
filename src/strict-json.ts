export type StrictJsonErrorCode =
  | "duplicate_member"
  | "input_too_large"
  | "invalid_syntax"
  | "nesting_too_deep"
  | "number_out_of_range";

export class StrictJsonError extends SyntaxError {
  readonly code: StrictJsonErrorCode;

  constructor(code: StrictJsonErrorCode, message: string) {
    super(message);
    this.name = "StrictJsonError";
    this.code = code;
  }
}

const MAX_JSON_CODE_UNITS = 20 * 1024 * 1024;
const MAX_JSON_DEPTH = 256;

function syntaxError(): StrictJsonError {
  return new StrictJsonError("invalid_syntax", "input is not valid JSON");
}

/**
 * Parses JSON while rejecting duplicate object member names after escape
 * decoding. Native JSON.parse uses last-member-wins semantics, which can make
 * an earlier lexical token disappear before normalized secret/boundary scans.
 */
export function parseStrictJson(text: string): unknown {
  if (typeof text !== "string") {
    throw syntaxError();
  }
  if (text.length > MAX_JSON_CODE_UNITS) {
    throw new StrictJsonError(
      "input_too_large",
      "JSON input exceeds the strict parser limit",
    );
  }

  // Establish that this is one complete JSON document before applying the
  // duplicate-member walk. Wrap the native diagnostic so input fragments are
  // never reflected through callers.
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw syntaxError();
  }

  const pending: unknown[] = [parsed];
  while (pending.length > 0) {
    const value = pending.pop();
    if (typeof value === "number" && !Number.isFinite(value)) {
      throw new StrictJsonError(
        "number_out_of_range",
        "JSON number is outside the finite runtime range",
      );
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        pending.push(item);
      }
    } else if (value !== null && typeof value === "object") {
      for (const item of Object.values(value as Record<string, unknown>)) {
        pending.push(item);
      }
    }
  }

  let index = 0;

  const skipWhitespace = (): void => {
    while (
      text[index] === " " ||
      text[index] === "\t" ||
      text[index] === "\n" ||
      text[index] === "\r"
    ) {
      index += 1;
    }
  };

  const parseStringToken = (): string => {
    if (text[index] !== '"') {
      throw syntaxError();
    }
    index += 1;
    let decoded = "";
    let segmentStart = index;
    while (index < text.length) {
      const code = text.charCodeAt(index);
      if (code === 0x22) {
        decoded += text.slice(segmentStart, index);
        index += 1;
        return decoded;
      }
      if (code < 0x20) {
        throw syntaxError();
      }
      if (code !== 0x5c) {
        index += 1;
        continue;
      }
      decoded += text.slice(segmentStart, index);
      index += 1;
      const escape = text[index];
      if (escape === undefined) {
        throw syntaxError();
      }
      const simpleEscapes: Readonly<Record<string, string>> = {
        '"': '"',
        "\\": "\\",
        "/": "/",
        b: "\b",
        f: "\f",
        n: "\n",
        r: "\r",
        t: "\t",
      };
      const simple = simpleEscapes[escape];
      if (simple !== undefined) {
        decoded += simple;
        index += 1;
        segmentStart = index;
        continue;
      }
      if (escape !== "u") {
        throw syntaxError();
      }
      const hex = text.slice(index + 1, index + 5);
      if (!/^[0-9a-fA-F]{4}$/.test(hex)) {
        throw syntaxError();
      }
      decoded += String.fromCharCode(Number.parseInt(hex, 16));
      index += 5;
      segmentStart = index;
    }
    throw syntaxError();
  };

  const parseNumber = (): void => {
    const remainder = text.slice(index);
    const match = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(
      remainder,
    );
    if (match === null) {
      throw syntaxError();
    }
    index += match[0].length;
  };

  const parseValue = (depth: number): void => {
    if (depth > MAX_JSON_DEPTH) {
      throw new StrictJsonError(
        "nesting_too_deep",
        "JSON input exceeds the strict nesting limit",
      );
    }
    skipWhitespace();
    const token = text[index];
    if (token === '"') {
      parseStringToken();
      return;
    }
    if (token === "{") {
      index += 1;
      skipWhitespace();
      const members = new Set<string>();
      if (text[index] === "}") {
        index += 1;
        return;
      }
      while (true) {
        skipWhitespace();
        const member = parseStringToken();
        if (members.has(member)) {
          throw new StrictJsonError(
            "duplicate_member",
            "JSON object contains a duplicate member",
          );
        }
        members.add(member);
        skipWhitespace();
        if (text[index] !== ":") {
          throw syntaxError();
        }
        index += 1;
        parseValue(depth + 1);
        skipWhitespace();
        if (text[index] === "}") {
          index += 1;
          return;
        }
        if (text[index] !== ",") {
          throw syntaxError();
        }
        index += 1;
      }
    }
    if (token === "[") {
      index += 1;
      skipWhitespace();
      if (text[index] === "]") {
        index += 1;
        return;
      }
      while (true) {
        parseValue(depth + 1);
        skipWhitespace();
        if (text[index] === "]") {
          index += 1;
          return;
        }
        if (text[index] !== ",") {
          throw syntaxError();
        }
        index += 1;
      }
    }
    if (text.startsWith("true", index)) {
      index += 4;
      return;
    }
    if (text.startsWith("false", index)) {
      index += 5;
      return;
    }
    if (text.startsWith("null", index)) {
      index += 4;
      return;
    }
    parseNumber();
  };

  parseValue(0);
  skipWhitespace();
  if (index !== text.length) {
    throw syntaxError();
  }
  return parsed;
}

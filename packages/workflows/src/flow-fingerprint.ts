import { createHash } from "node:crypto";
import type { DefineFlowOptions } from "./define-flow.js";

/**
 * What makes two definitions of a flow name the same definition.
 *
 * Two module layers of one app produce distinct function objects from one source file, so
 * identity is useless and the source text is what there is — but the text is not the text the
 * author wrote. `next build --webpack` compiles a route's graph once per layer and each layer is
 * minified with its own name budget, so the same flow arrives twice with every binding renamed
 * and every dynamic `import()` pointing at a different webpack module id. Observed on the real
 * standalone build, the two copies of the template's `collectDemoSource` differ in five tokens:
 *
 * ```
 * page layer  : async a=>{await (0,g.step)("load",…c.bind(c,79792)),g=d.sources.require(a.source)…(0,f.loadSource)(a,g.name,g.fetch())…}
 * action layer: async a=>{await (0,f.step)("load",…c.bind(c,24439)),f=d.sources.require(a.source)…(0,e.loadSource)(a,f.name,f.fetch())…}
 * ```
 *
 * So the comparison is over a normalised token stream rather than the text: every identifier a
 * bundler is free to rename becomes a positional placeholder, and every numeric literal becomes
 * one placeholder because a module id is a number and nothing distinguishes it from the author's
 * own. What survives is what carries the meaning and what no bundler here rewrites — property
 * names, string, regex and template text, keywords, operators, and the shape.
 *
 * The known limits, in the order they are likely to bite:
 *
 * - **A minifier that mangles property access** defeats this, and normalisation cannot help:
 *   `d.sources.require` against `d.a.b` is the same collapse as a renamed local, but the property
 *   names are the discriminating half of the stream, so erasing them too would make every flow of
 *   one name look alike. Next's server build mangles identifiers and not properties, which is why
 *   the stream keeps them; a build that turned property mangling on would need `version` below.
 * - **Two flows differing only in a number** fingerprint the same, because module ids forced
 *   numbers out of the stream. A differing string, statement, operator, property or option is
 *   still caught.
 * - **A minifier reusing one name for two non-overlapping bindings** in one layer but not in the
 *   other breaks the positional mapping, since the mapping is lexical and does no scope analysis.
 *   It cannot happen from the shape above — both copies come from one source, so the set of
 *   bindings a body references and the order it first references them in are fixed — but it is
 *   the residual risk, and `version` is the way out of it.
 */
export function flowFingerprint(
  fn: (...args: never[]) => unknown,
  options: DefineFlowOptions,
): string {
  const json = stableJson(options);
  // An explicit `version` is the author asserting which definitions are the same one, so the body
  // is not read at all: it is the escape hatch for the limits above, in both directions — two
  // layers of one flow match however the bundler mangled them, and two genuinely different flows
  // of one name still collide as long as their versions differ.
  const body = options.version === undefined ? normalizeFunctionSource(fn.toString()) : "";
  // Length-prefixed, because a normalised body can contain whatever a separator would be.
  return createHash("sha256").update(`${json.length}:${json}${body}`).digest("hex");
}

/** Identifiers no bundler renames, so they are kept verbatim and carry their own meaning. */
const KEYWORDS = new Set([
  "arguments",
  "as",
  "async",
  "await",
  "break",
  "case",
  "catch",
  "class",
  "const",
  "continue",
  "debugger",
  "default",
  "delete",
  "do",
  "else",
  "export",
  "extends",
  "false",
  "finally",
  "for",
  "from",
  "function",
  "get",
  "if",
  "import",
  "in",
  "instanceof",
  "let",
  "new",
  "null",
  "of",
  "return",
  "set",
  "static",
  "super",
  "switch",
  "this",
  "throw",
  "true",
  "try",
  "typeof",
  "undefined",
  "var",
  "void",
  "while",
  "with",
  "yield",
]);

/** Tokens that can end an expression, and so make a following `/` a division and not a regex. */
const ENDS_EXPRESSION = new Set([")", "]", "}", "`", "0", "++", "--"]);

const IDENTIFIER_START = /[A-Za-z_$]/;
const IDENTIFIER_PART = /[A-Za-z0-9_$]/;
const DIGIT = /[0-9]/;
/** Every character a numeric literal can contain: hex digits, radix and bigint marks, separators. */
const NUMBER_PART = /[0-9a-fA-FxXoObBn._]/;

/**
 * `fn.toString()` as a delimited token stream with the renameable parts replaced positionally.
 *
 * Exported for its own tests rather than for callers; `flowFingerprint` is the only use.
 *
 * A misparse is safe here in a way it would not be in a compiler: the two copies being compared
 * come from one source through one minifier, so a `/` read as a division where it was a regex —
 * the one genuinely ambiguous case, and undecidable without a parser — misreads both copies
 * identically. It costs a little discrimination and never a false mismatch.
 */
export function normalizeFunctionSource(source: string): string {
  const tokens: string[] = [];
  const slots = new Map<string, string>();
  /** Brace depth at each open `${`, so the `}` that closes one is not read as a block's. */
  const substitutions: number[] = [];
  let braces = 0;
  let previous = "";
  let i = 0;

  const emit = (token: string): void => {
    tokens.push(token);
    previous = token;
  };

  /** A name's placeholder, by the order the stream first reaches it. `%` cannot start one. */
  const slotFor = (name: string): string => {
    let slot = slots.get(name);
    if (slot === undefined) {
      slot = `%${slots.size}`;
      slots.set(name, slot);
    }
    return slot;
  };

  /**
   * A template literal's cooked text up to the next `${` or its closing backtick. Emitting it as
   * one quoted token is what keeps text that looks like an identifier out of the placeholder
   * mapping, while the substitutions between the chunks stay ordinary code.
   */
  const readTemplateChunk = (start: number): { end: number; done: boolean } => {
    let j = start;
    while (j < source.length) {
      if (source[j] === "\\") {
        j += 2;
        continue;
      }
      if (source[j] === "`") {
        emit(JSON.stringify(source.slice(start, j)));
        return { end: j + 1, done: true };
      }
      if (source[j] === "$" && source[j + 1] === "{") {
        emit(JSON.stringify(source.slice(start, j)));
        return { end: j + 2, done: false };
      }
      j += 1;
    }
    throw new Error("unterminated template literal in a flow body");
  };

  /** Shared by a template's opening backtick and by the `}` that closes a substitution. */
  const enterTemplate = (start: number): number => {
    const chunk = readTemplateChunk(start);
    if (chunk.done) emit("`");
    else {
      emit("${");
      substitutions.push(braces);
    }
    return chunk.end;
  };

  while (i < source.length) {
    const ch = source[i] as string;

    if (/\s/.test(ch)) {
      i += 1;
      continue;
    }

    if (ch === "/" && source[i + 1] === "/") {
      const end = source.indexOf("\n", i);
      i = end === -1 ? source.length : end + 1;
      continue;
    }

    if (ch === "/" && source[i + 1] === "*") {
      const end = source.indexOf("*/", i + 2);
      i = end === -1 ? source.length : end + 2;
      continue;
    }

    if (ch === '"' || ch === "'") {
      let j = i + 1;
      while (j < source.length && source[j] !== ch) j += source[j] === "\\" ? 2 : 1;
      emit(source.slice(i, j + 1));
      i = j + 1;
      continue;
    }

    if (ch === "`") {
      emit("`");
      i = enterTemplate(i + 1);
      continue;
    }

    // Regex or division. Division only where the previous token could have ended an expression;
    // a placeholder, a preserved property name and a keyword that is a value all count.
    if (ch === "/" && !endsExpression(previous)) {
      let j = i + 1;
      let inClass = false;
      while (j < source.length) {
        if (source[j] === "\\") {
          j += 2;
          continue;
        }
        if (source[j] === "[") inClass = true;
        else if (source[j] === "]") inClass = false;
        else if (source[j] === "/" && !inClass) break;
        j += 1;
      }
      j += 1;
      while (j < source.length && IDENTIFIER_PART.test(source[j] as string)) j += 1;
      emit(source.slice(i, j));
      i = j;
      continue;
    }

    if (DIGIT.test(ch) || (ch === "." && DIGIT.test(source[i + 1] ?? ""))) {
      let j = i;
      while (j < source.length) {
        const c = source[j] as string;
        if (NUMBER_PART.test(c)) {
          j += 1;
          continue;
        }
        // An exponent's sign, which is the one place `+`/`-` is part of the literal.
        if ((c === "+" || c === "-") && /[eE]/.test(source[j - 1] ?? "")) {
          j += 1;
          continue;
        }
        break;
      }
      i = j;
      emit("0");
      continue;
    }

    if (IDENTIFIER_START.test(ch)) {
      let j = i + 1;
      while (j < source.length && IDENTIFIER_PART.test(source[j] as string)) j += 1;
      const word = source.slice(i, j);
      // After a `.` it is a property name, which is the half of the stream that says what the
      // body does; everywhere else it is a binding the bundler may have renamed.
      emit(previous === "." || KEYWORDS.has(word) ? word : slotFor(word));
      i = j;
      continue;
    }

    if (ch === "{") {
      braces += 1;
      emit(ch);
      i += 1;
      continue;
    }

    if (ch === "}") {
      if (substitutions.at(-1) === braces) {
        substitutions.pop();
        emit("}");
        i = enterTemplate(i + 1);
        continue;
      }
      braces -= 1;
      emit(ch);
      i += 1;
      continue;
    }

    // `++` and `--` only, so that `a++ / b` is a division; every other operator is one character
    // per token, which is unambiguous in a delimited stream and keeps this short.
    if ((ch === "+" || ch === "-") && source[i + 1] === ch) {
      emit(ch + ch);
      i += 2;
      continue;
    }

    emit(ch);
    i += 1;
  }

  return tokens.join("\u0000");
}

function endsExpression(previous: string): boolean {
  if (previous === "") return false;
  if (ENDS_EXPRESSION.has(previous)) return true;
  // A placeholder, a property name, or a keyword that is a value rather than a prefix.
  if (previous.startsWith("%")) return true;
  if (previous.startsWith('"') || previous.startsWith("'")) return true;
  if (!IDENTIFIER_START.test(previous)) return false;
  return !KEYWORDS.has(previous) || VALUE_KEYWORDS.has(previous);
}

/** The keywords that are values, so a `/` after one divides rather than opening a regex. */
const VALUE_KEYWORDS = new Set(["this", "super", "true", "false", "null", "undefined", "arguments"]);

/** `JSON.stringify` with object keys sorted, so key order is not part of the comparison. */
function stableJson(value: unknown): string {
  if (typeof value !== "object" || value === null) return JSON.stringify(value) ?? "undefined";
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  return `{${entries.map(([key, inner]) => `${JSON.stringify(key)}:${stableJson(inner)}`).join(",")}}`;
}

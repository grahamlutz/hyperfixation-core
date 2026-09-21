import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { flowFingerprint, normalizeFunctionSource } from "./flow-fingerprint.js";

/**
 * What `defineFlow` is allowed to call the same definition.
 *
 * The two fixtures are the load-bearing case and they are not synthetic: they are one flow body as
 * `next build --webpack` compiled it into the two module layers of the template's `/auth/passkey`.
 * `fn.toString()` of them is not equal, which is exactly why #103's fingerprint did not hold on the
 * real build — see `__fixtures__/README.md` for how to produce them again.
 */
const layer = (name: string): string =>
  readFileSync(new URL(`./__fixtures__/${name}`, import.meta.url), "utf8");

const PAGE_LAYER = layer("layer-rsc-page.collect-demo-source.js.txt");
const ACTION_LAYER = layer("layer-server-action.collect-demo-source.js.txt");

describe("normalizeFunctionSource", () => {
  it("reads the two compiled module layers of one flow as the same definition", () => {
    // The premise of the whole exercise: same source, two layers, different text.
    expect(PAGE_LAYER.trim()).not.toBe(ACTION_LAYER.trim());

    expect(normalizeFunctionSource(PAGE_LAYER)).toBe(normalizeFunctionSource(ACTION_LAYER));
  });

  it("is unmoved by renaming every local and every import binding", () => {
    // The shape before minification, which is what the plan for this work assumed it would find:
    // webpack's own `__WEBPACK_IMPORTED_MODULE_n__` bindings, and the module id of a dynamic
    // import — a *numeric* literal, and the reason numbers cannot survive normalisation.
    const first = `async (input, run) => {
      const staged = await _hyperfixation_workflows__WEBPACK_IMPORTED_MODULE_0__.step(
        "load",
        async (ctx) => {
          const { app } = await Promise.resolve().then(__webpack_require__.bind(__webpack_require__, 79792));
          return ctx.tx((db) => _hyperfixation_db__WEBPACK_IMPORTED_MODULE_1__.loadSource(db, app.name));
        },
        { key: "load" },
      );
      return staged;
    }`;
    const second = `async (payload, ctx0) => {
      const rows = await _hyperfixation_workflows__WEBPACK_IMPORTED_MODULE_2__.step(
        "load",
        async (scope) => {
          const { app } = await Promise.resolve().then(__webpack_require__.bind(__webpack_require__, 24439));
          return scope.tx((conn) => _hyperfixation_db__WEBPACK_IMPORTED_MODULE_5__.loadSource(conn, app.name));
        },
        { key: "load" },
      );
      return rows;
    }`;

    expect(first).not.toBe(second);
    expect(normalizeFunctionSource(first)).toBe(normalizeFunctionSource(second));
  });

  it("keeps property names, which is where the meaning that survives renaming lives", () => {
    const source = "async (a) => a.sources.require(a.source)";
    const normalized = normalizeFunctionSource(source);

    expect(normalized.split("\u0000")).toEqual([
      "async",
      "(",
      "%0",
      ")",
      "=",
      ">",
      "%0",
      ".",
      "sources",
      ".",
      "require",
      "(",
      "%0",
      ".",
      "source",
      ")",
    ]);
  });

  it("does not read a template chunk or a regex as code that looks like identifiers", () => {
    const withLiterals = async (input: { name: string }) => {
      const pattern = /await|async|step/g;
      return `step ${input.name} await ${pattern.source}`;
    };
    const normalized = normalizeFunctionSource(withLiterals.toString());

    // Verbatim, one token each: nothing inside them was renamed, and the words `await`, `async`
    // and `step` inside them did not become keywords or placeholders.
    expect(normalized).toContain("/await|async|step/g");
    expect(normalized).toContain(JSON.stringify("step "));
    expect(normalized).toContain(JSON.stringify(" await "));
    // The substitutions between the chunks are code, and are normalised.
    expect(normalized).toContain("${");
    expect(normalized).not.toContain("input");
    expect(normalized).not.toContain("pattern");
  });

  it("tells apart bodies that differ only inside a template chunk or a regex", () => {
    const base = "async (a) => `step ${a.id}`";
    const otherText = "async (a) => `stop ${a.id}`";
    const baseRegex = "async (a) => /load/g.test(a.id)";
    const otherRegex = "async (a) => /loud/g.test(a.id)";

    expect(normalizeFunctionSource(base)).not.toBe(normalizeFunctionSource(otherText));
    expect(normalizeFunctionSource(baseRegex)).not.toBe(normalizeFunctionSource(otherRegex));
  });

  it("normalises once per call at a cost a module graph can pay at import time", () => {
    // `defineFlow` normalises one body per call, so the only budget that matters is one body's.
    // A thousand of them stands in for the largest module graph an app could have, with room to
    // spare so that a loaded machine cannot turn this into a flake.
    const started = performance.now();
    for (let i = 0; i < 1_000; i += 1) normalizeFunctionSource(PAGE_LAYER);
    const elapsed = performance.now() - started;

    expect(elapsed).toBeLessThan(2_000);
  });
});

describe("flowFingerprint", () => {
  const queue = { queue: "resolve" } as const;

  it("matches for two function objects of one definition", () => {
    const defineTwice = () => async (input: string) => input.toUpperCase();

    expect(flowFingerprint(defineTwice(), queue)).toBe(flowFingerprint(defineTwice(), queue));
  });

  it("differs on one changed string literal", () => {
    const first = async () => {
      await Promise.resolve("load");
    };
    const second = async () => {
      await Promise.resolve("loud");
    };

    expect(flowFingerprint(first, queue)).not.toBe(flowFingerprint(second, queue));
  });

  it("differs on one added statement", () => {
    const first = async (a: number) => a + 1;
    const second = async (a: number) => {
      const b = a;
      return b + 1;
    };

    expect(flowFingerprint(first, queue)).not.toBe(flowFingerprint(second, queue));
  });

  it("differs on one swapped operator", () => {
    const first = async (a: number, b: number) => a + b;
    const second = async (a: number, b: number) => a - b;

    expect(flowFingerprint(first, queue)).not.toBe(flowFingerprint(second, queue));
  });

  it("differs on one changed option", () => {
    const body = async () => undefined;

    expect(flowFingerprint(body, queue)).not.toBe(flowFingerprint(body, { queue: "llm" }));
  });

  it("ignores the order the options were written in", () => {
    const body = async () => undefined;

    expect(flowFingerprint(body, { queue: "resolve", version: "1" })).toBe(
      flowFingerprint(body, { version: "1", queue: "resolve" }),
    );
  });

  it("stops reading the body once the author states a version", () => {
    const first = async () => "first";
    const second = async () => {
      throw new Error("nothing like the first");
    };

    // Same name, same version: the author has said these are one definition, and the bodies are
    // not consulted. It is the escape hatch for a build this normalisation cannot see through.
    expect(flowFingerprint(first, { queue: "resolve", version: "1" })).toBe(
      flowFingerprint(second, { queue: "resolve", version: "1" }),
    );
    // A different version is still a different definition.
    expect(flowFingerprint(first, { queue: "resolve", version: "1" })).not.toBe(
      flowFingerprint(first, { queue: "resolve", version: "2" }),
    );
    // And a versioned definition is never the same as an unversioned one.
    expect(flowFingerprint(first, { queue: "resolve", version: "1" })).not.toBe(
      flowFingerprint(first, queue),
    );
  });
});

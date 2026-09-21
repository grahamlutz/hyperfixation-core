/**
 * A value that has to be the same object however many copies of this module a process loads.
 * Next instantiates an app's module graph once per module layer — the rsc page layer and the
 * server-action layer of one authenticated request are two, in one process (#103) — and a
 * bundler does the same to any package it does not treat as external. So module scope is not
 * process scope, and anything whose whole point is being process-wide cannot live there.
 *
 * `Symbol.for`'s registry belongs to the realm rather than to a module, so every copy of this
 * function resolves one key to one symbol and therefore to one value. The key carries no
 * version: two versions of this package in one process should share a run context, not run two.
 *
 * Twinned in `@hyperfixation/core`'s `process-global.ts`. Neither package can reach the other's
 * internals and a shared export would make four lines public API.
 */
export function processGlobal<T extends object>(key: string, create: () => T): T {
  const host = globalThis as unknown as Record<symbol, T | undefined>;
  const symbol = Symbol.for(key);
  return (host[symbol] ??= create());
}

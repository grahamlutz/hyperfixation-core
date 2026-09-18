/**
 * Every kind of thing an app registers — sources, resolvers, scorers, flows, approval types,
 * channels, record types — is a registry, not a single fixed implementation, and every one of
 * them refuses a second registration under a name it already holds.
 *
 * A duplicate is always a bug and never a harmless overwrite: the name is what a stored row
 * points at, so silently replacing a registration would change what every `hf_run.flow`,
 * `hf_approval.type` and `hf_action_log.channel` row already written means.
 */

export class DuplicateRegistration extends Error {
  readonly kind: string;
  /** Not `name`: that one is `Error`'s, and carries the class name on every error here. */
  readonly registeredName: string;

  constructor(kind: string, registeredName: string) {
    super(
      `DuplicateRegistration: a ${kind} named ${JSON.stringify(registeredName)} is already registered`,
    );
    this.name = "DuplicateRegistration";
    this.kind = kind;
    this.registeredName = registeredName;
  }
}

export class UnknownRegistration extends Error {
  readonly kind: string;
  readonly known: readonly string[];

  constructor(kind: string, name: string, known: readonly string[]) {
    super(
      `UnknownRegistration: no ${kind} named ${JSON.stringify(name)} is registered; ` +
        `this app registers ${known.length === 0 ? "none" : known.join(", ")}`,
    );
    this.name = "UnknownRegistration";
    this.kind = kind;
    this.known = known;
  }
}

export interface Registry<T> {
  /** The registered thing, back, so a registration can be an expression. */
  register(entry: T): T;
  get(name: string): T | undefined;
  /** `get` for callers with nothing sensible to do about an absence. */
  require(name: string): T;
  has(name: string): boolean;
  names(): string[];
  all(): T[];
  readonly kind: string;
  readonly size: number;
}

/**
 * `keyOf` exists because not every registration calls its name `name`: a record type is keyed
 * by `recordType`, which is the string machinery rows actually carry.
 */
export function createRegistry<T>(
  kind: string,
  keyOf: (entry: T) => string = (entry) => (entry as { name: string }).name,
): Registry<T> {
  const entries = new Map<string, T>();

  return {
    kind,
    get size() {
      return entries.size;
    },
    register(entry: T): T {
      const key = keyOf(entry);
      if (entries.has(key)) throw new DuplicateRegistration(kind, key);
      entries.set(key, entry);
      return entry;
    },
    get: (name) => entries.get(name),
    require(name) {
      const entry = entries.get(name);
      if (entry === undefined) throw new UnknownRegistration(kind, name, [...entries.keys()]);
      return entry;
    },
    has: (name) => entries.has(name),
    names: () => [...entries.keys()],
    all: () => [...entries.values()],
  };
}

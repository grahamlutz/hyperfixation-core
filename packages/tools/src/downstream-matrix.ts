/** GitHub's own rule for both halves of an `owner/repo` slug. */
const SLUG = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

export type DownstreamEntry = {
  /** `owner/repo`, for `actions/checkout`'s `repository:`. */
  readonly repo: string;
  /** The halves apart, for `create-github-app-token`'s `owner:` and `repositories:`. */
  readonly owner: string;
  readonly name: string;
};

export type DownstreamMatrix = { readonly include: readonly DownstreamEntry[] };

/**
 * `owner/repo` per line; blank lines and `#` comments ignored, duplicates collapsed to their
 * first appearance. A line that is not a slug throws rather than being skipped: the file lists
 * the repositories a release opens a PR on, so a typo has to be loud.
 */
export function parseDownstream(text: string): string[] {
  const repos: string[] = [];
  text.split("\n").forEach((raw, index) => {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) return;
    if (!SLUG.test(line)) {
      throw new Error(`downstream.txt line ${index + 1}: not an owner/repo slug: ${line}`);
    }
    if (!repos.includes(line)) repos.push(line);
  });
  return repos;
}

/**
 * Empty is an error, not an empty matrix: zero matrix jobs are "skipped", and the aggregate
 * `downstream` check would go green having checked nothing.
 */
export function downstreamMatrix(text: string): DownstreamMatrix {
  const repos = parseDownstream(text);
  if (repos.length === 0) throw new Error("downstream.txt names no repositories");
  return {
    include: repos.map((repo) => {
      const [owner, name] = repo.split("/");
      return { repo, owner, name };
    }),
  };
}

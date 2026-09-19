import { createTransport, segment, type FetchLike, type Transport } from "./http.js";

export const GITHUB_API_URL = "https://api.github.com";

export interface GithubRepository {
  full_name: string;
  clone_url: string;
  default_branch: string;
  private: boolean;
}

export interface GithubReference {
  ref: string;
  object: { sha: string; type: string };
}

export interface GithubPullRequest {
  number: number;
  title: string;
  html_url: string;
  head: { ref: string; sha: string };
}

export interface GithubCombinedStatus {
  /** `success` | `pending` | `failure`. */
  state: string;
  total_count: number;
}

export interface GithubRepositoryRequest {
  name: string;
  description?: string;
  private?: boolean;
  auto_init?: boolean;
}

export interface GithubClientOptions {
  /** `HF_GITHUB_TOKEN`. */
  token: string;
  url?: string;
  fetch?: FetchLike;
}

export class GithubClient {
  private readonly request: Transport;

  constructor(options: GithubClientOptions) {
    this.request = createTransport({
      provider: "github",
      baseUrl: options.url ?? GITHUB_API_URL,
      headers: {
        authorization: `Bearer ${options.token}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
      },
      fetch: options.fetch,
    });
  }

  /** The repository for an app whose `HF_GITHUB_OWNER` is the token's own account. */
  async createUserRepository(body: GithubRepositoryRequest): Promise<GithubRepository> {
    return await this.request({ method: "POST", path: "/user/repos", body });
  }

  /** The same, when `HF_GITHUB_OWNER` is an organization instead. */
  async createOrgRepository(org: string, body: GithubRepositoryRequest): Promise<GithubRepository> {
    return await this.request({ method: "POST", path: `/orgs/${segment(org)}/repos`, body });
  }

  /**
   * `hf doctor`'s idea of what the repository says is deployed. `ref` is `heads/main`, and is
   * not percent-encoded: GitHub spells this parameter with the slash as a path separator.
   */
  async getReference(owner: string, repo: string, ref: string): Promise<GithubReference> {
    return await this.request({
      method: "GET",
      path: `/repos/${segment(owner)}/${segment(repo)}/git/ref/${ref}`,
    });
  }

  /**
   * Open pull requests, unfiltered.
   *
   * `hf doctor` wants the `core-bump/` ones, but GitHub's `head` filter takes a whole
   * `user:branch`, not a prefix, so the prefix match belongs to the caller.
   */
  async listPullRequests(
    owner: string,
    repo: string,
    options: { state?: "open" | "closed" | "all"; per_page?: number } = {},
  ): Promise<GithubPullRequest[]> {
    return await this.request({
      method: "GET",
      path: `/repos/${segment(owner)}/${segment(repo)}/pulls`,
      query: { state: options.state, per_page: options.per_page },
    });
  }

  async getCombinedStatus(
    owner: string,
    repo: string,
    ref: string,
  ): Promise<GithubCombinedStatus> {
    return await this.request({
      method: "GET",
      path: `/repos/${segment(owner)}/${segment(repo)}/commits/${segment(ref)}/status`,
    });
  }
}

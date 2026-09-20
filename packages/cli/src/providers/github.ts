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

/** `GET /users/{username}`, for the one question `hf new` asks of it: account or organization. */
export interface GithubUser {
  login: string;
  /** `User` | `Organization`; which of the two repository-creation endpoints applies. */
  type: string;
}

export interface GithubInstallation {
  id: number;
  app_id: number;
  /** The slug `HF_GITHUB_APP_SLUGS` names — Coolify's app, and the bump bot's. */
  app_slug: string;
}

export interface GithubInstallations {
  total_count: number;
  installations: GithubInstallation[];
}

export interface GithubInstallationRepositories {
  total_count: number;
  repository_selection?: string;
  repositories: GithubRepository[];
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
      secrets: [options.token],
      fetch: options.fetch,
    });
  }

  /**
   * Who `HF_GITHUB_OWNER` is: `type` decides between `/user/repos` and `/orgs/{org}/repos`.
   *
   * Unauthenticated-shaped data on purpose — this endpoint answers for any account, so it is the
   * cheapest way to settle the question without assuming the token owns the name.
   */
  async getUser(username: string): Promise<GithubUser> {
    return await this.request({ method: "GET", path: `/users/${segment(username)}` });
  }

  /**
   * The repository, when there may already be one.
   *
   * A 404 from here is "no such repository **for this token**": the same status covers absent and
   * invisible, so a caller that means to create one must treat it as "create and let the create
   * fail" rather than as proof the name is free.
   */
  async getRepository(owner: string, repo: string): Promise<GithubRepository> {
    return await this.request({
      method: "GET",
      path: `/repos/${segment(owner)}/${segment(repo)}`,
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

  /**
   * The GitHub Apps installed for the token's user, with their slugs.
   *
   * `hf new` asserts both `HF_GITHUB_APP_SLUGS` entries are installed on the new repository —
   * Coolify cannot deploy from a repository its app cannot see, and that failure otherwise
   * surfaces as a deploy that clones nothing.
   */
  async listInstallations(
    options: { per_page?: number; page?: number } = {},
  ): Promise<GithubInstallations> {
    return await this.request({
      method: "GET",
      path: "/user/installations",
      query: { per_page: options.per_page, page: options.page },
    });
  }

  /** Which repositories one installation actually reaches; the other half of that assertion. */
  async listInstallationRepositories(
    installationId: number,
    options: { per_page?: number; page?: number } = {},
  ): Promise<GithubInstallationRepositories> {
    return await this.request({
      method: "GET",
      path: `/user/installations/${segment(String(installationId))}/repositories`,
      query: { per_page: options.per_page, page: options.page },
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

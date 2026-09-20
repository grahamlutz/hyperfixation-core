import { createTransport, segment, type FetchLike, type Transport } from "./http.js";

export interface CoolifyProject {
  uuid: string;
  name: string;
  description?: string;
}

/** Coolify's environment model carries a uuid the documented schema does not list. */
export interface CoolifyEnvironment {
  uuid: string;
  name: string;
}

/**
 * The application `hf new` creates: a docker-compose build pack on the app's own private
 * repository, reached through the Coolify GitHub App.
 *
 * `environment_uuid` and `environment_name` are both required by the API document even though
 * its prose says either will do — so both are required here, and the uuid is what
 * `listEnvironments` is for.
 */
export interface CoolifyApplicationRequest {
  project_uuid: string;
  server_uuid: string;
  environment_name: string;
  environment_uuid: string;
  github_app_uuid: string;
  /** `owner/name`, as Coolify stores it for a GitHub App source. */
  git_repository: string;
  git_branch: string;
  build_pack: "nixpacks" | "railpack" | "static" | "dockerfile" | "dockercompose";
  name?: string;
  description?: string;
  /**
   * Comma-separated. Rejected outright for a `dockercompose` build pack — Coolify 4.3.21 answers
   * 422 `The domains field cannot be used for dockercompose applications` — so
   * `docker_compose_domains` is what `hf new` sends and this is for the other four packs.
   */
  domains?: string;
  /** One entry per compose service that gets a domain; `hf new` sends exactly one. */
  docker_compose_domains?: readonly CoolifyComposeDomain[];
  ports_exposes?: string;
  docker_compose_location?: string;
  connect_to_docker_network?: boolean;
  instant_deploy?: boolean;
  is_auto_deploy_enabled?: boolean;
}

/** A domain on one service of a compose application, which is how a `dockercompose` app gets one. */
export interface CoolifyComposeDomain {
  /** The service name as `docker-compose.prod.yml` spells it. */
  name: string;
  /** Comma-separated, same as `domains`. */
  domain: string;
  redirect?: "www" | "non-www" | "both";
}

export interface CoolifyApplication {
  uuid: string;
}

/** What `GET /applications` returns per item; the document's `Application` has both of these. */
export interface CoolifyApplicationSummary {
  uuid: string;
  name: string;
  fqdn?: string;
}

/**
 * What `PATCH /databases/{uuid}` accepts of the fields E2 might need.
 *
 * Narrow on purpose: the document lists every engine's credentials, and nothing in it attaches a
 * database to a docker network — `is_public`/`public_port` is the only reach the API has over how
 * a database is addressed.
 */
export interface CoolifyDatabaseUpdate {
  name?: string;
  description?: string;
  is_public?: boolean;
  public_port?: number;
}

export interface CoolifyEnvironmentVariable {
  key: string;
  value: string;
  is_preview?: boolean;
  is_literal?: boolean;
  is_multiline?: boolean;
  is_shown_once?: boolean;
  /**
   * Whether the builder interpolates the variable, and whether the containers get it.
   *
   * Both default true in Coolify's UI and neither is in the document's *request* schemas —
   * only in its `EnvironmentVariable` model — but the box accepts and stores them (verified
   * against 4.3.21). `SOURCE_COMMIT` needs both: it is the compose image tag and build arg as
   * well as the `HF_BUILD_SHA` three services read.
   */
  is_buildtime?: boolean;
  is_runtime?: boolean;
}

/** One entry of `GET /applications/{uuid}/envs`, narrowed to what an upsert has to match on. */
export interface CoolifyEnvEntry {
  uuid: string;
  key: string;
  value?: string;
  is_preview?: boolean;
}

export interface CoolifyDeploymentRequest {
  deployments: { message: string; resource_uuid: string; deployment_uuid: string }[];
}

export interface CoolifyDeployment {
  deployment_uuid: string;
  /** `queued` | `in_progress` | `finished` | `failed` | `cancelled-by-user`, as Coolify sets it. */
  status: string;
  commit?: string;
  logs?: string;
}

export interface CoolifyBackupRequest {
  /** A cron expression, or one of `every_minute`…`yearly`. */
  frequency: string;
  enabled?: boolean;
  save_s3?: boolean;
  s3_storage_uuid?: string;
  /** Comma-separated database names — the app's `hf_<name>`, not the whole cluster. */
  databases_to_backup?: string;
  dump_all?: boolean;
  backup_now?: boolean;
  database_backup_retention_amount_locally?: number;
  database_backup_retention_days_locally?: number;
}

export interface CoolifyBackup {
  uuid: string;
  message?: string;
}

export interface CoolifyClientOptions {
  /** `HF_COOLIFY_URL` — the instance's origin, without `/api/v1`. */
  url: string;
  /** `HF_COOLIFY_TOKEN`. */
  token: string;
  fetch?: FetchLike;
}

export class CoolifyClient {
  private readonly request: Transport;

  constructor(options: CoolifyClientOptions) {
    this.request = createTransport({
      provider: "coolify",
      baseUrl: `${options.url.replace(/\/+$/, "")}/api/v1`,
      headers: { authorization: `Bearer ${options.token}` },
      secrets: [options.token],
      fetch: options.fetch,
    });
  }

  async createProject(body: { name: string; description?: string }): Promise<{ uuid: string }> {
    return await this.request({ method: "POST", path: "/projects", body });
  }

  /** Every project on the instance; `hf new` finds its own by name rather than creating a second. */
  async listProjects(): Promise<CoolifyProject[]> {
    return await this.request({ method: "GET", path: "/projects" });
  }

  async getProject(uuid: string): Promise<CoolifyProject> {
    return await this.request({ method: "GET", path: `/projects/${segment(uuid)}` });
  }

  async listEnvironments(projectUuid: string): Promise<CoolifyEnvironment[]> {
    return await this.request({
      method: "GET",
      path: `/projects/${segment(projectUuid)}/environments`,
    });
  }

  async createEnvironment(projectUuid: string, body: { name: string }): Promise<{ uuid: string }> {
    return await this.request({
      method: "POST",
      path: `/projects/${segment(projectUuid)}/environments`,
      body,
    });
  }

  async createPrivateGithubAppApplication(
    body: CoolifyApplicationRequest,
  ): Promise<CoolifyApplication> {
    return await this.request({ method: "POST", path: "/applications/private-github-app", body });
  }

  /**
   * Every application, so a rerun can find the one it created last time by name.
   *
   * The state cache is the first place to look for the uuid; this is what answers the case where
   * the application exists but the state file does not, which is a cold run against a live app.
   */
  async listApplications(options: { tag?: string } = {}): Promise<CoolifyApplicationSummary[]> {
    return await this.request({ method: "GET", path: "/applications", query: { tag: options.tag } });
  }

  async updateEnvsBulk(
    appUuid: string,
    data: readonly CoolifyEnvironmentVariable[],
  ): Promise<unknown> {
    return await this.request({
      method: "PATCH",
      path: `/applications/${segment(appUuid)}/envs/bulk`,
      body: { data },
      // The app's whole environment goes out in this one call, and a 422 names the variables it
      // rejected by quoting them.
      secrets: data.map((variable) => variable.value),
    });
  }

  /** Every environment variable on the application, preview and non-preview alike. */
  async listEnvs(appUuid: string): Promise<CoolifyEnvEntry[]> {
    return await this.request({ method: "GET", path: `/applications/${segment(appUuid)}/envs` });
  }

  async createEnv(appUuid: string, variable: CoolifyEnvironmentVariable): Promise<{ uuid: string }> {
    return await this.request({
      method: "POST",
      path: `/applications/${segment(appUuid)}/envs`,
      body: variable,
      secrets: [variable.value],
    });
  }

  /** Keyed by `key` — and by `is_preview`, which is why an upsert sends the entry's own flag. */
  async updateEnv(appUuid: string, variable: CoolifyEnvironmentVariable): Promise<unknown> {
    return await this.request({
      method: "PATCH",
      path: `/applications/${segment(appUuid)}/envs`,
      body: variable,
      secrets: [variable.value],
    });
  }

  async deploy(uuid: string, options: { force?: boolean } = {}): Promise<CoolifyDeploymentRequest> {
    return await this.request({
      method: "POST",
      path: "/deploy",
      query: { uuid, force: options.force },
    });
  }

  async getDeployment(deploymentUuid: string): Promise<CoolifyDeployment> {
    return await this.request({
      method: "GET",
      path: `/deployments/${segment(deploymentUuid)}`,
    });
  }

  async createDatabaseBackup(
    databaseUuid: string,
    body: CoolifyBackupRequest,
  ): Promise<CoolifyBackup> {
    return await this.request({
      method: "POST",
      path: `/databases/${segment(databaseUuid)}/backups`,
      body,
    });
  }

  /**
   * The database's scheduled backups.
   *
   * `unknown`, not a model: upstream documents this response as a string whose example reads
   * "Content is very complex. Will be implemented later.", so there is nothing to type against.
   * A caller that needs a field has to narrow it against the box itself.
   */
  async listDatabaseBackups(databaseUuid: string): Promise<unknown> {
    return await this.request({
      method: "GET",
      path: `/databases/${segment(databaseUuid)}/backups`,
    });
  }

  /** The database as Coolify holds it — undocumented in shape, same as the backups list. */
  async getDatabase(uuid: string): Promise<unknown> {
    return await this.request({ method: "GET", path: `/databases/${segment(uuid)}` });
  }

  async updateDatabase(uuid: string, body: CoolifyDatabaseUpdate): Promise<unknown> {
    return await this.request({ method: "PATCH", path: `/databases/${segment(uuid)}`, body });
  }
}

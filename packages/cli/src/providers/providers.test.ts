import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createOpenApiHarness, type StubRoute } from "../test-support/openapi.js";
import { CloudflareClient } from "./cloudflare.js";
import { CoolifyClient } from "./coolify.js";
import { GithubClient } from "./github.js";
import { createTransport, ProviderError } from "./http.js";
import { LangfuseClient } from "./langfuse.js";
import { SentryClient } from "./sentry.js";

const COOLIFY = "https://coolify.test";
const CLOUDFLARE = "https://cloudflare.test/client/v4";
const GITHUB = "https://github.test";
const SENTRY = "https://sentry.test";
const LANGFUSE = "https://langfuse.test";

const ROUTES: StubRoute[] = [
  { spec: "coolify", method: "post", url: `${COOLIFY}/api/v1/projects`, json: { uuid: "p1" } },
  { spec: "coolify", method: "get", url: `${COOLIFY}/api/v1/projects/{uuid}`, json: { uuid: "p1" } },
  {
    spec: "coolify",
    method: "get",
    url: `${COOLIFY}/api/v1/projects/{uuid}/environments`,
    json: [{ uuid: "e1", name: "production" }],
  },
  {
    spec: "coolify",
    method: "post",
    url: `${COOLIFY}/api/v1/applications/private-github-app`,
    json: { uuid: "a1" },
  },
  {
    spec: "coolify",
    method: "patch",
    url: `${COOLIFY}/api/v1/applications/{uuid}/envs/bulk`,
    json: [],
  },
  {
    spec: "coolify",
    method: "post",
    url: `${COOLIFY}/api/v1/deploy`,
    json: { deployments: [{ message: "ok", resource_uuid: "a1", deployment_uuid: "d1" }] },
  },
  {
    spec: "coolify",
    method: "get",
    url: `${COOLIFY}/api/v1/deployments/{uuid}`,
    json: { deployment_uuid: "d1", status: "finished" },
  },
  {
    spec: "coolify",
    method: "post",
    url: `${COOLIFY}/api/v1/databases/{uuid}/backups`,
    json: { uuid: "b1" },
  },
  {
    spec: "cloudflare",
    method: "get",
    url: `${CLOUDFLARE}/zones/{zone_id}/dns_records`,
    json: { success: true, errors: [], result: [] },
  },
  {
    spec: "cloudflare",
    method: "post",
    url: `${CLOUDFLARE}/zones/{zone_id}/dns_records`,
    status: 201,
    json: { success: true, errors: [], result: { id: "r1" } },
  },
  {
    spec: "github",
    method: "post",
    url: `${GITHUB}/user/repos`,
    status: 201,
    json: { full_name: "grahamlutz/demo-app" },
  },
  {
    spec: "github",
    method: "post",
    url: `${GITHUB}/orgs/{org}/repos`,
    status: 201,
    json: { full_name: "acme/demo-app" },
  },
  {
    spec: "github",
    method: "get",
    url: `${GITHUB}/repos/{owner}/{repo}/git/ref/heads/main`,
    json: { ref: "refs/heads/main", object: { sha: "abc1234", type: "commit" } },
  },
  { spec: "github", method: "get", url: `${GITHUB}/repos/{owner}/{repo}/pulls`, json: [] },
  {
    spec: "github",
    method: "get",
    url: `${GITHUB}/repos/{owner}/{repo}/commits/{ref}/status`,
    json: { state: "success", total_count: 1 },
  },
  {
    spec: "sentry",
    method: "post",
    url: `${SENTRY}/api/0/organizations/{organization_id_or_slug}/projects/`,
    status: 201,
    json: { id: "1", slug: "demo-app", name: "demo-app" },
  },
  {
    spec: "sentry",
    method: "get",
    url: `${SENTRY}/api/0/projects/{organization_id_or_slug}/{project_id_or_slug}/keys/`,
    json: [{ id: "k1", name: "Default", dsn: { public: "https://k@o.ingest.sentry.io/1" } }],
  },
  {
    spec: "langfuse",
    method: "post",
    url: `${LANGFUSE}/api/public/projects`,
    json: { id: "lp1", name: "demo-app" },
  },
  {
    spec: "langfuse",
    method: "post",
    url: `${LANGFUSE}/api/public/projects/{projectId}/apiKeys`,
    json: { id: "lk1", publicKey: "pk-lf-1", secretKey: "sk-lf-1" },
  },
];

const harness = createOpenApiHarness(ROUTES);

describe("provider clients", () => {
  beforeAll(() => harness.server.listen({ onUnhandledRequest: "error" }));
  // Drained before the assertion, so one test's violation cannot fail the next one too.
  afterEach(() => {
    harness.server.resetHandlers();
    const violations = harness.takeViolations();
    harness.reset();
    expect(violations).toEqual([]);
  });
  afterAll(() => harness.server.close());

  describe("coolify", () => {
    const coolify = new CoolifyClient({ url: COOLIFY, token: "t" });

    it("creates and reads a project, and lists its environments", async () => {
      expect(await coolify.createProject({ name: "demo-app" })).toEqual({ uuid: "p1" });
      expect((await coolify.getProject("p1")).uuid).toBe("p1");
      expect((await coolify.listEnvironments("p1"))[0]!.uuid).toBe("e1");

      expect(harness.requests.map((request) => request.operationPath)).toEqual([
        "/projects",
        "/projects/{uuid}",
        "/projects/{uuid}/environments",
      ]);
    });

    it("creates the application from the private GitHub App", async () => {
      const application = await coolify.createPrivateGithubAppApplication({
        project_uuid: "p1",
        server_uuid: "s1",
        environment_name: "production",
        environment_uuid: "e1",
        github_app_uuid: "g1",
        git_repository: "grahamlutz/demo-app",
        git_branch: "main",
        build_pack: "dockercompose",
        name: "demo-app",
        domains: "https://demo-app.hyperfixation.ai",
        connect_to_docker_network: true,
        instant_deploy: false,
      });

      expect(application.uuid).toBe("a1");
    });

    it("sends the whole environment in one bulk PATCH", async () => {
      await coolify.updateEnvsBulk("a1", [
        { key: "DATABASE_URL", value: "postgres://…" },
        { key: "APP_URL", value: "https://demo-app.hyperfixation.ai" },
      ]);

      expect(harness.requests[0]!.method).toBe("PATCH");
      expect(harness.requests[0]!.body).toEqual({
        data: [
          { key: "DATABASE_URL", value: "postgres://…" },
          { key: "APP_URL", value: "https://demo-app.hyperfixation.ai" },
        ],
      });
    });

    it("deploys by uuid and reads the deployment back", async () => {
      const queued = await coolify.deploy("a1", { force: false });
      expect(queued.deployments[0]!.deployment_uuid).toBe("d1");
      expect(harness.requests[0]!.query).toEqual({ uuid: "a1", force: "false" });

      expect((await coolify.getDeployment("d1")).status).toBe("finished");
    });

    it("registers a scheduled backup of the app's database alone", async () => {
      const backup = await coolify.createDatabaseBackup("db1", {
        frequency: "daily",
        enabled: true,
        databases_to_backup: "hf_demo_app",
        database_backup_retention_days_locally: 7,
      });

      expect(backup.uuid).toBe("b1");
    });
  });

  describe("cloudflare", () => {
    const cloudflare = new CloudflareClient({ url: CLOUDFLARE, token: "t" });

    it("lists a zone's records filtered by name and type", async () => {
      await cloudflare.listDnsRecords("z1", { name: "demo-app.hyperfixation.ai", type: "A" });

      expect(harness.requests[0]!.query).toEqual({
        name: "demo-app.hyperfixation.ai",
        type: "A",
      });
    });

    it("creates the DNS-only A record", async () => {
      const created = await cloudflare.createDnsRecord("z1", {
        type: "A",
        name: "demo-app.hyperfixation.ai",
        content: "203.0.113.7",
        ttl: 1,
        proxied: false,
      });

      expect(created.result.id).toBe("r1");
    });
  });

  describe("github", () => {
    const github = new GithubClient({ url: GITHUB, token: "t" });

    it("creates the private repository, under the account or an organization", async () => {
      await github.createUserRepository({ name: "demo-app", private: true });
      await github.createOrgRepository("acme", { name: "demo-app", private: true });

      expect(harness.requests.map((request) => request.operationPath)).toEqual([
        "/user/repos",
        "/orgs/{org}/repos",
      ]);
    });

    it("reads main's sha, open pull requests and a ref's combined status", async () => {
      expect((await github.getReference("grahamlutz", "demo-app", "heads/main")).object.sha).toBe(
        "abc1234",
      );
      await github.listPullRequests("grahamlutz", "demo-app", { state: "open", per_page: 100 });
      expect((await github.getCombinedStatus("grahamlutz", "demo-app", "abc1234")).state).toBe(
        "success",
      );

      expect(harness.requests[1]!.query).toEqual({ state: "open", per_page: "100" });
    });
  });

  describe("sentry", () => {
    const sentry = new SentryClient({ url: SENTRY, token: "t" });

    it("creates the project and reads its DSN off the first key", async () => {
      expect((await sentry.createProject("hf", { name: "demo-app" })).slug).toBe("demo-app");

      const keys = await sentry.listProjectKeys("hf", "demo-app");
      expect(keys[0]!.dsn.public).toContain("sentry.io");
    });
  });

  describe("langfuse", () => {
    const langfuse = new LangfuseClient({ url: LANGFUSE, orgKey: "pk-lf-org:sk-lf-org" });

    it("creates the project and a key pair for it", async () => {
      const project = await langfuse.createProject({ name: "demo-app", retention: 0 });
      expect(project.id).toBe("lp1");

      const key = await langfuse.createApiKey("lp1", { note: "demo-app" });
      expect(key.secretKey).toBe("sk-lf-1");
    });
  });

  describe("the harness itself", () => {
    it("fails a fixture handler whose verb the document does not allow", async () => {
      // `/envs/bulk` is a PATCH upstream. A handler and a client that agreed on POST would
      // otherwise pass every test here and 404 against the real Coolify.
      harness.server.use(
        harness.handler({
          spec: "coolify",
          method: "post",
          url: `${COOLIFY}/api/v1/applications/{uuid}/envs/bulk`,
        }),
      );
      const posting = createTransport({
        provider: "coolify",
        baseUrl: `${COOLIFY}/api/v1`,
        headers: {},
      });

      const failure = await posting({
        method: "POST",
        path: "/applications/a1/envs/bulk",
        body: { data: [] },
      }).catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(ProviderError);
      expect(harness.takeViolations()).toEqual([
        "coolify: no POST operation for /applications/a1/envs/bulk",
      ]);
    });

    it("fails a request whose body the document rejects", async () => {
      const langfuse = new LangfuseClient({ url: LANGFUSE, orgKey: "pk:sk" });

      // `retention` is required; leaving it out is exactly the drift this harness exists for.
      await langfuse
        .createProject({ name: "demo-app" } as { name: string; retention: number })
        .catch(() => undefined);

      const violations = harness.takeViolations();
      expect(violations).toHaveLength(1);
      expect(violations[0]).toContain("does not validate");
    });

    it("picks the right branch of a record union, so an A record's content must be an address", async () => {
      const cloudflare = new CloudflareClient({ url: CLOUDFLARE, token: "t" });

      await cloudflare
        .createDnsRecord("z1", {
          type: "A",
          name: "demo-app.hyperfixation.ai",
          content: "the-box",
          ttl: 1,
          proxied: false,
        })
        .catch(() => undefined);

      expect(harness.takeViolations()).toHaveLength(1);
    });

    it("fails a query parameter the document does not declare", async () => {
      const listing = createTransport({ provider: "github", baseUrl: GITHUB, headers: {} });

      await listing({
        method: "GET",
        path: "/repos/grahamlutz/demo-app/pulls",
        query: { branch: "core-bump/hyperfixation" },
      }).catch(() => undefined);

      expect(harness.takeViolations()).toEqual([
        expect.stringContaining("/repos/{owner}/{repo}/pulls does not validate"),
      ]);
    });
  });

  describe("errors", () => {
    it("never puts a provider's response body, or the query string, in the message", async () => {
      harness.server.use(
        harness.handler({
          spec: "coolify",
          method: "patch",
          url: `${COOLIFY}/api/v1/applications/{uuid}/envs/bulk`,
          status: 422,
          json: { message: "rejected DATABASE_URL=postgres://app:hunter2@box/db" },
        }),
      );
      const coolify = new CoolifyClient({ url: COOLIFY, token: "sekrit-token" });

      const error = (await coolify
        .updateEnvsBulk("a1", [{ key: "DATABASE_URL", value: "postgres://app:hunter2@box/db" }])
        .catch((cause: unknown) => cause)) as ProviderError;

      expect(error).toBeInstanceOf(ProviderError);
      expect(error.status).toBe(422);
      expect(error.message).not.toContain("hunter2");
      expect(error.message).not.toContain("sekrit-token");
      expect(error.body).toContain("hunter2");
    });
  });
});

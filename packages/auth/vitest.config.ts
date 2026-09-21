import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "auth",
    environment: "node",
    passWithNoTests: true,
    // The passkey plugin is inlined so `vi.mock("@simplewebauthn/server")` reaches *its* import
    // of the verifier: the enrolment tests drive the real `/passkey/verify-registration` through
    // the real dispatcher, and the one thing they cannot supply is a real authenticator's
    // attestation. Externalized, the plugin loads the verifier through node and the stub is
    // never seen.
    server: { deps: { inline: ["@better-auth/passkey"] } },
  },
});

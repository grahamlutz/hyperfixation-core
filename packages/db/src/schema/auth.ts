import { boolean, integer, pgTable, text, timestamp } from "drizzle-orm/pg-core";

const createdAt = () =>
  timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow();
const updatedAt = () =>
  timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow();

export const sessionFactors = ["code", "passkey"] as const;
export type SessionFactor = (typeof sessionFactors)[number];

export const hfUser = pgTable("hf_user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").notNull().default(false),
  image: text("image"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
  role: text("role"),
  banned: boolean("banned").default(false),
  banReason: text("ban_reason"),
  banExpires: timestamp("ban_expires", { withTimezone: true, mode: "date" }),
});

export const hfSession = pgTable("hf_session", {
  id: text("id").primaryKey(),
  expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" }).notNull(),
  token: text("token").notNull().unique(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  userId: text("user_id")
    .notNull()
    .references(() => hfUser.id, { onDelete: "cascade" }),
  activeOrganizationId: text("active_organization_id"),
  impersonatedBy: text("impersonated_by"),
  // Defaults to the weaker factor: a session created by a path that does not yet
  // stamp one must not pass a passkey-gated check by omission.
  factor: text("factor", { enum: sessionFactors }).notNull().default("code"),
  // Set when *this* session completed a passkey registration, and the only thing a promotion to
  // `factor = 'passkey'` is allowed to read. Null on every session anything else created, which
  // is why it is nullable rather than defaulted: "this session enrolled nothing" has to be the
  // state a row arrives in.
  passkeyEnrolledAt: timestamp("passkey_enrolled_at", { withTimezone: true, mode: "date" }),
});

export const hfAccount = pgTable("hf_account", {
  id: text("id").primaryKey(),
  accountId: text("account_id").notNull(),
  providerId: text("provider_id").notNull(),
  userId: text("user_id")
    .notNull()
    .references(() => hfUser.id, { onDelete: "cascade" }),
  accessToken: text("access_token"),
  refreshToken: text("refresh_token"),
  idToken: text("id_token"),
  accessTokenExpiresAt: timestamp("access_token_expires_at", {
    withTimezone: true,
    mode: "date",
  }),
  refreshTokenExpiresAt: timestamp("refresh_token_expires_at", {
    withTimezone: true,
    mode: "date",
  }),
  scope: text("scope"),
  password: text("password"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const hfVerification = pgTable("hf_verification", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" }).notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const hfPasskey = pgTable("hf_passkey", {
  id: text("id").primaryKey(),
  name: text("name"),
  publicKey: text("public_key").notNull(),
  userId: text("user_id")
    .notNull()
    .references(() => hfUser.id, { onDelete: "cascade" }),
  credentialID: text("credential_id").notNull(),
  counter: integer("counter").notNull(),
  deviceType: text("device_type").notNull(),
  backedUp: boolean("backed_up").notNull(),
  transports: text("transports"),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).defaultNow(),
  aaguid: text("aaguid"),
});

export const hfOrganization = pgTable("hf_organization", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  logo: text("logo"),
  createdAt: createdAt(),
  metadata: text("metadata"),
});

/**
 * Added by track C, not by chunk 2: better-auth's `organization` plugin refuses to initialise
 * at all when a model it writes has no table, so the seven this file started with were one
 * short of a plugin the plan requires. Nothing in Phase 1 sends an invitation — `disableSignUp`
 * leaves an invited stranger nowhere to land — but the table has to exist for the rest of the
 * plugin to work.
 */
export const hfInvitation = pgTable("hf_invitation", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id")
    .notNull()
    .references(() => hfOrganization.id, { onDelete: "cascade" }),
  email: text("email").notNull(),
  role: text("role"),
  status: text("status").notNull().default("pending"),
  expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" }).notNull(),
  inviterId: text("inviter_id")
    .notNull()
    .references(() => hfUser.id, { onDelete: "cascade" }),
  createdAt: createdAt(),
});

export const hfMember = pgTable("hf_member", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id")
    .notNull()
    .references(() => hfOrganization.id, { onDelete: "cascade" }),
  userId: text("user_id")
    .notNull()
    .references(() => hfUser.id, { onDelete: "cascade" }),
  role: text("role").notNull().default("member"),
  createdAt: createdAt(),
});

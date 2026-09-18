export {
  createAuth,
  upgradeSessionFactor,
  AUTH_SCHEMA,
  type CreateAuthOptions,
  type HyperfixationAuth,
} from "./factory.js";
export {
  hasRole,
  sessionFactorForPath,
  sessionFactors,
  EMAIL_OTP_SIGN_IN_PATH,
  PASSKEY_AUTHENTICATION_PATH,
  PASSKEY_REGISTRATION_PATH,
  type AuthSession,
  type SessionFactor,
  type SessionUser,
} from "./session.js";
export {
  evaluateAccess,
  routeAreaOf,
  ADMIN_AREA,
  ADMIN_ROLE,
  AUTH_AREA,
  DEFAULT_SIGN_IN_PATH,
  DEFAULT_STEP_UP_PATH,
  type AccessDecision,
  type AccessPaths,
  type AccessRefusal,
  type AccessRequest,
  type RouteArea,
} from "./policy.js";
export {
  createSessionGuard,
  AccessRefused,
  type RequireSession,
  type RequireSessionOptions,
  type SessionGuardOptions,
} from "./require-session.js";
export {
  bootstrapAdmin,
  BootstrapRefused,
  BOOTSTRAPPED_MARKER,
  BOOTSTRAP_EMAIL_ENV,
  type BootstrapAdminOptions,
  type BootstrapRefusal,
  type BootstrapResult,
} from "./bootstrap.js";
export {
  createResetSecondFactorAction,
  resetSecondFactor,
  SECOND_FACTOR_RESET_MARKER,
  type ResetSecondFactorAction,
  type ResetSecondFactorActionOptions,
  type ResetSecondFactorOptions,
  type ResetSecondFactorResult,
} from "./reset-second-factor.js";

// Global, environment-independent config. Per-environment values (OpenFGA URL,
// token-service route/audience, default store) now live in `environments.ts`
// and are read via `environmentStore`. `apiToken` is retained only as an
// optional, env-agnostic manual override (lowest priority in tokenStore).
export const config = {
  apiVersion: "v1",
  apiToken: import.meta.env.VITE_OPENFGA_API_TOKEN || "",
  defaultAuthorizationModel: `model
  schema 1.1

type user

type group
  relations
    define member: [user]

type folder
  relations
    define can_create_file: owner
    define owner: [user]
    define parent: [folder]
    define viewer: [user, user:*, group#member] or owner or viewer from parent
    define tmpviewer: [user with non_expired_grant]

type doc
  relations
    define can_change_owner: owner
    define owner: [user]
    define parent: [folder]
    define can_read: viewer or owner or viewer from parent
    define can_share: owner or owner from parent
    define viewer: [user, user:*, group#member]
    define can_write: owner or owner from parent

condition non_expired_grant(current_time: timestamp, grant_time: timestamp, grant_duration: duration) {
  current_time < grant_time + grant_duration
}`,
};

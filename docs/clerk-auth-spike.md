# Clerk Auth Spike

Status: experimental / local-only

This spike validates Clerk as the candidate identity provider for Glide Beside before replacing the existing shared-password dashboard login.

## Goals

- Validate Clerk keys and Backend API access.
- Validate browser sign-in with Google/email.
- Validate Express-side session/JWT resolution.
- Prototype the future mapping from Clerk user identity to internal family/patient membership.
- Keep production login unchanged until the auth/provider decision is made.

## 1Password source

Clerk credentials are stored in 1Password:

- Vault: `Mr. Stellar`
- Item: `Clerk Credentials for Glide Beside Spike`
- Fields:
  - `CLERK_PUBLISHABLE_KEY`
  - `CLERK_SECRET_KEY`

Do not paste the secret key into chat, docs, or shell logs.

## Local environment

Use 1Password references rather than writing secrets into `.env`:

```bash
cat >/tmp/clerk-spike.env <<'EOF'
CLERK_PUBLISHABLE_KEY=op://Mr. Stellar/Clerk Credentials for Glide Beside Spike/CLERK_PUBLISHABLE_KEY
CLERK_SECRET_KEY=op://Mr. Stellar/Clerk Credentials for Glide Beside Spike/CLERK_SECRET_KEY
EOF
```

Enable the spike explicitly:

```bash
CLERK_SPIKE_ENABLED=true
```

## Verification

Credentials-only smoke test:

```bash
op run --env-file=/tmp/clerk-spike.env -- node scripts/verify-clerk-credentials.js
```

Expected result shape:

```json
{"ok":true,"userCount":0,"publishableKeyPrefix":"pk_test"}
```

Browser/session spike routes:

- `GET /api/clerk-spike/status` — reports whether the spike is enabled/configured.
- `GET /clerk-spike` — isolated Clerk sign-in page.
- `GET /api/clerk-spike/session` — returns Clerk auth/session info and proposed default family/patient mapping when signed in.

These routes are gated by `CLERK_SPIKE_ENABLED=true` and do not replace the production `/login` flow.

## Production posture

Do not enable this in production until we have decided on Clerk and implemented:

- `users` / `family_memberships` mapping and role enforcement.
- Caregiver invite flow.
- Logout/profile/session UX.
- API route authorization by family/patient.
- Alexa account-linking proof.

# Family Tenancy and Shared Caregiver Access Design

## Problem

Production Clerk login currently authenticates a person, but the app still routes every authenticated browser user to the legacy default family/patient. That means a new Google login can see the existing Touma/Elina data unless an additional authorization layer maps the user to an allowed family/patient.

The product needs two behaviors:

1. A brand-new family gets a clean slate: new family, first patient, empty logs/settings defaults.
2. Multiple caregivers can share one patient: for example Daniel and spouse accounts both access the same child profile.

## Recommendation

Use a shared user-pool plus family/workspace tenancy model.

- Clerk user = authenticated human identity.
- Internal `families` row = tenant/workspace/care circle.
- Internal `patients` row = child/patient profile under a family.
- Internal `family_memberships` row = authorization join between Clerk user and family.
- Optional `patient_memberships` only if future families can have multiple patients with different caregiver access.

For this product, do **not** make every new Clerk login automatically access the default patient. The default patient should be accessible only through an explicit membership or a temporary allowlist during migration.

## Why not user-is-tenant?

A pure user-owned model gives every new login a clean slate, but it makes shared caregiver access awkward because the spouse’s account must somehow impersonate or share Daniel’s user context. That becomes brittle for Alexa linking, auditability, roles, and future patient sharing.

## Why not separate Clerk apps per family?

Separate user pools would isolate families strongly, but they are too heavy for a consumer/family app. Families need one app, one login surface, and invite-based sharing. Clerk’s own multi-tenant guidance supports a shared user-pool where users can belong to multiple organizations/tenants.

## Clerk Organizations vs internal memberships

Clerk Organizations are a good long-term fit if we want Clerk-managed invites, org switching, roles, and membership UI. Each family/care circle maps to one Clerk Organization, and our DB stores `clerk_org_id` on `families`.

However, this app is currently plain Express/static, not a React/Next app using Clerk org components. The safest incremental path is:

1. Add internal `family_memberships` now.
2. Resolve every request to an internal `{ familyId, patientId, role }` from Clerk user ID/email.
3. Add a simple invite/join-code/admin-add flow.
4. Later map memberships to Clerk Organizations if/when we want Clerk-managed invites and organization switching.

## Proposed schema additions

```sql
ALTER TABLE families ADD COLUMN IF NOT EXISTS clerk_org_id TEXT UNIQUE;
ALTER TABLE families ADD COLUMN IF NOT EXISTS created_by_clerk_user_id TEXT;
ALTER TABLE patients ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS family_memberships (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id UUID NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  clerk_user_id TEXT NOT NULL,
  email TEXT,
  display_name TEXT,
  role TEXT NOT NULL DEFAULT 'caregiver', -- owner/admin/caregiver/viewer
  status TEXT NOT NULL DEFAULT 'active',  -- active/invited/removed
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (family_id, clerk_user_id)
);

CREATE INDEX IF NOT EXISTS idx_family_memberships_clerk_user
  ON family_memberships (clerk_user_id)
  WHERE status='active';
```

If multiple patients per family later need separate access, add:

```sql
CREATE TABLE IF NOT EXISTS patient_memberships (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id UUID NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  patient_id UUID NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  membership_id UUID NOT NULL REFERENCES family_memberships(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'caregiver',
  UNIQUE (patient_id, membership_id)
);
```

## Request resolution

Every authenticated request should resolve a tenant scope before reaching patient data routes:

1. Get Clerk `userId` from `getAuth(req)`.
2. Look up active family memberships for that Clerk user.
3. If none:
   - For normal production signup: create a new family/patient onboarding draft or redirect to onboarding.
   - For current pre-publication migration: deny access unless the email is on a temporary allowlist.
4. If exactly one active family/patient: set `req.scope = { familyId, patientId, role }`.
5. If multiple families/patients: require selected context from session/query/header and verify membership.
6. All DB reads/writes use `req.scope`, never default IDs.

## Onboarding behavior

For a brand-new login:

- Show onboarding: create family/care circle name and patient profile.
- Create family, patient, settings defaults, membership role `owner`.
- Do not copy Touma/Elina data.

For an invited spouse/caregiver:

- Invite flow accepts email and role.
- Recipient signs in with Gmail/Clerk.
- App creates/activates `family_memberships` for the existing family.
- Recipient sees the same patient data because their membership resolves to the same `{ familyId, patientId }`.

## Alexa implications

Alexa account linking should map a Clerk/OAuth subject to a family/patient scope through the same membership layer. `alexa_account_links` can remain, but it should point to a verified membership/family/patient rather than defaulting silently.

## Immediate safety guard

Until full tenancy is implemented, production should keep `CLERK_DEFAULT_TENANT_ALLOWED_EMAILS` set to the known authorized caregiver emails only. This prevents arbitrary new Clerk sign-ins from seeing the default patient.

## Caregiver invite email delivery

Internal invitations are the authorization source of truth: an invited email can sign in through Clerk and join the family even if no email is delivered. Email delivery is a notification layer on top of that invitation record.

Production invite email uses generic SMTP configuration so credentials stay in Railway/secret storage rather than the repo:

- `INVITE_EMAIL_ENABLED=true`
- `APP_PUBLIC_URL=https://bedside.glidechart.com`
- `MAIL_FROM="Glide Bedside <support@glidechart.com>"`
- `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`

If mail is not configured, the invite endpoint still creates the invitation and returns `email.sent=false`; the Settings UI tells the caregiver that the recipient can sign in but invite email is not configured yet. Do not store SMTP passwords or provider tokens in docs, MC, chat, or code.

## Implementation slices

1. Add temporary default-tenant allowlist and enable it in Railway.
2. Add `family_memberships` schema + helpers.
3. Add `resolveRequestScope(req)` middleware.
4. Convert dashboard/API DB calls from default IDs to `req.scope`.
5. Add first-login onboarding for clean-slate families.
6. Add invite/admin-add flow for shared caregiver access.
7. Migrate Daniel’s Clerk identity to the existing default family/patient membership.
8. Add tenant-isolation tests/probes.
9. Update Alexa account-linking resolution to require membership-backed scope.

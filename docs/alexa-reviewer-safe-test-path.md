# Alexa reviewer-safe test path

Purpose: prepare Amazon certification access for Glide Beside without storing reviewer passwords, tokens, or secret values in the repo, Mission Control, docs, or chat.

## Guardrails

- Do not publish or submit the Alexa skill until ownership, domains, policy URLs, reviewer path, and secret rotation gates are complete.
- Do not write reviewer credentials, Clerk secrets, Alexa access tokens, Railway env values, or database passwords into this file, Mission Control, PR text, screenshots, or chat.
- Store reviewer credentials only in the approved secret store and/or the Amazon Developer Console certification fields intended for reviewer credentials.
- Treat previously exposed Railway environment values as rotation-required before publication.

## Public surfaces for certification

- Skill endpoint: `https://app.glidechart.com/api/alexa`
- Reviewer/app login: `https://app.glidechart.com/login`
- App health check: `https://app.glidechart.com/health`
- Privacy policy: `https://glidechart.com/privacy`
- Terms of use: `https://glidechart.com/terms`
- Support / deletion / export requests: `https://glidechart.com/support`

## Reviewer account preparation

1. Create or designate a Clerk reviewer test user for Amazon certification.
2. Store that username/password only in the approved secret store and, when ready to submit, in Amazon's reviewer credential field.
3. Verify `https://app.glidechart.com/login` uses Clerk production login and accepts the reviewer identity.
4. Configure the Alexa account-linking resource using the Clerk OAuth application endpoints/client details. Do not store client secrets in this repo.
5. Link the development-stage Alexa skill using the reviewer identity.
6. Capture only nonsecret verification facts:
   - reviewer user exists
   - account linking completed
   - Clerk token subject was observed server-side without printing the token
   - `alexa_account_links.auth_subject` maps to the intended reviewer family/patient
7. Create or verify the `alexa_account_links` row for the reviewer identity.
8. Run a development-stage Alexa launch/summary request with that linked identity.
9. Confirm the response reads/writes only the mapped reviewer family/patient context.
10. Run a missing-token smoke test and confirm Alexa receives a `LinkAccount` card.
11. Only after the reviewer path works, consider enabling `ALEXA_ACCOUNT_LINKING_REQUIRED=true` for the release stage.

## Suggested nonsecret certification notes

Use a short version of this in Amazon's testing instructions after the reviewer account exists:

> This skill is for adult caregiver logging and handoff support. It does not provide medical advice, diagnosis, treatment, emergency support, or official care plans. Use the provided reviewer account to complete account linking. After linking, try: “Alexa, open fluid monitor” and “Alexa, ask fluid monitor for today's summary.”

Do not include the actual reviewer password in repo/docs/MC. Put it only in Amazon's secure reviewer credential field at submission time.

## Pre-publication hygiene gate

Before certification submission:

- Rotate app/Railway secrets that were exposed during inventory tooling output.
- Confirm Railway/GitHub/Cloudflare/registrar/Amazon Developer/Clerk ownership posture is Hour Glide-controlled or explicitly accepted as operator-owned governance.
- Confirm `app.glidechart.com` remains DNS-only and has valid TLS.
- Confirm `openclaw.enounceai.ai` remains working separately from the GlideChart app/domain migration.

# Alexa account linking implementation

## Current state

The development-stage Alexa skill is configured for Clerk account linking and sends a Clerk OAuth access token on skill requests.

`/api/alexa` now supports account-linked requests before patient-specific reads or writes:

- extracts the access token from `context.System.user.accessToken`, falling back to `session.user.accessToken`
- verifies the token server-side with Clerk using the server-side secret key
- resolves the verified Clerk OAuth token subject through `alexa_account_links.auth_subject`
- uses the mapped `family_id` and `patient_id` to scope Alexa fluid, wellness, gag, weight, and summary operations
- returns an Alexa `LinkAccount` card when a supplied token is invalid or unmapped
- returns an Alexa `LinkAccount` card for missing tokens only when `ALEXA_ACCOUNT_LINKING_REQUIRED=true`; otherwise legacy unlinked requests keep using the default family/patient while dev-stage linked requests can be tested safely

No Alexa access tokens or Clerk token contents should be logged, stored in docs, or written to Mission Control.

## Mapping table

`alexa_account_links` is the app-owned lookup table for Alexa identity resolution.

Important columns:

- `auth_subject` — Clerk OAuth token subject; primary lookup key for account-linked Alexa requests
- `alexa_user_id` — Alexa user id; backfilled after a verified request if the row does not already have one
- `family_id` — family tenant resolved for the request
- `patient_id` — patient resolved for the request

For the first development tester, create or verify a row that maps the Clerk subject for the test account to the intended default family and patient. Do not store the raw access token.

## Test posture

Use the ASK CLI development stage first. A safe verification is:

1. Link the development-stage skill in the Alexa app with the Clerk test account.
2. Run an ASK dialog utterance against the development stage.
3. Confirm the request includes an access token without printing it.
4. Verify the token server-side with Clerk and confirm only nonsecret facts, such as token type, presence of subject, and scopes.
5. Confirm missing/unmapped token requests return a `LinkAccount` card.
6. Confirm mapped requests read/write only the mapped family/patient context.

## Certification notes

Before store submission, prepare reviewer-safe account-linking credentials in Clerk and a mapped `alexa_account_links` row for that reviewer identity. Keep those credentials out of the repo and Mission Control.

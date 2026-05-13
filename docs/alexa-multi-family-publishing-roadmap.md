# Alexa Multi-Family Publishing Roadmap

## Purpose

Prepare the Glide Bedside web app + Alexa skill for multi-family use and eventual Alexa Skills Store publication under the Hour Glide / GlideChart product line.

## Current state

- Skill name: Glide Bedside
- Invocation name: fluid monitor
- Skill ID: `amzn1.ask.skill.ae8d6755-a9c7-425a-8034-6f1230c8ae9c`
- Vendor ID: `M1T7RSPC9KXQ7W`
- Stage verified through ASK CLI: development
- ASK CLI profile on host: `mr-stellar`
- Backend endpoint: `https://bedside.glidechart.com/api/alexa`
- Public app URL: `https://bedside.glidechart.com`
- Public policy URLs: `https://glidechart.com/privacy`, `https://glidechart.com/terms`, `https://glidechart.com/support`
- Current production version: `1.2.0`

## Key certification implications

Amazon certification evaluates policy, security, functionality, and voice UX. For this product, the highest-risk areas are health-related policy, child-directed classification, account linking, privacy/compliance, and multi-user data isolation.

### Health policy posture

The skill tracks health-adjacent information: fluids, outputs, wellness, gag episodes, weight, and reports. Amazon policy flags skills that collect information relating to a person's physical or mental health or condition. This does not automatically make publication impossible, but it means the submission needs conservative framing and careful compliance.

Recommended posture:

- Position as caregiver logging and family handoff support, not diagnosis, treatment, medical advice, official care plan, or emergency support.
- Include a privacy policy and skill description disclaimer: this tool does not provide medical advice and is not a substitute for professional medical advice, diagnosis, or treatment.
- Avoid drug dosage, prescription, care instruction, or emergency claims.
- Avoid “life-saving” wording in name, invocation, description, and responses.

### Child-directed posture

Although the use case involves children, the skill should likely be framed as **parent/caregiver-directed**, not child-directed. Amazon policy is stricter for child-directed skills, especially if they collect personal information or use account linking.

Recommended posture:

- Target parents/caregivers/adult family members.
- Do not market to children.
- Avoid child-directed entertainment language.
- Treat all account creation, consent, and data entry as adult caregiver actions.

## Product architecture changes needed for multi-family use

The current app is essentially single-family/single-tenant. Publishing requires true multi-tenant separation.

### 1. Accounts and family tenancy

Needed:

- Family/account table.
- Users/caregivers table.
- Patient/child profile table scoped to a family.
- Every log/settings/report row scoped by `family_id` and `patient_id` where appropriate.
- Per-family daily limit, timezone, report times, thresholds, display preferences, and allowed integrations.

Acceptance bar:

- No request can read or mutate another family’s data.
- Existing single-family data can be migrated into an initial family tenant.

### 2. Alexa account linking

Alexa account linking is the clean path for multi-family identity. Each Alexa user links their Amazon account to a GlideChart / Hour Glide account. Alexa requests include an access token; the backend resolves the token to a family/patient context.

Needed:

- OAuth 2.0 authorization server or provider-backed login.
- Authorization URI and token URI over HTTPS.
- Login/linking page branded to GlideChart / Hour Glide.
- Access token validation in `/api/alexa`.
- If token missing, return a LinkAccount card.
- Certification test credentials for Amazon reviewers.

Recommended implementation path:

- Use a mainstream auth provider first (Auth0, Clerk, Cognito, Supabase Auth, or similar) rather than writing OAuth from scratch.
- Require account linking before any patient-specific read/write.
- Keep an internal `family_id` claim or lookup table keyed by auth subject.

### 3. Public web onboarding

Needed:

- Public landing page explaining the tracker clearly.
- Account signup/login.
- Create family/patient profile flow.
- Invite caregivers flow.
- Alexa setup instructions.
- Privacy policy, terms, support/contact, and data deletion/export request path.

### 4. Data privacy and compliance

Needed before beta/publishing:

- Privacy policy URL.
- Terms of use URL.
- Explicit data collected/used list.
- Data deletion process.
- Support email.
- Production HTTPS endpoints.
- Avoid storing credentials directly.
- Decide whether this is intended to process PHI and whether HIPAA-eligible requirements are in scope. Default recommendation: do not claim HIPAA compliance until deliberately designed, contracted, and reviewed.

### 5. Alexa skill store metadata

Needed in Developer Console Distribution tabs:

- Public skill name.
- Short description.
- Full description.
- Example phrases using `fluid monitor` or final invocation name.
- Category.
- Keywords.
- Small and large icons.
- Testing instructions.
- Privacy policy URL.
- Terms of use URL.
- Availability/countries.
- Privacy & compliance answers.

### 6. Certification/beta workflow

Amazon docs indicate:

1. Complete Build page.
2. Complete Distribution > Skill Preview.
3. Complete Distribution > Privacy & Compliance.
4. Run Certification > Validation until it passes.
5. Use beta testing for limited real-family trials before production publishing.
6. Submit through Certification > Submission.
7. Certification review covers policy, security, functional behavior, and voice UX and may take at least five business days.

Beta test prerequisites overlap with certification readiness: required distribution/privacy fields and validation must pass.

## Recommended phased plan

### Phase 0 — Credential and release hygiene

- Keep ASK CLI profile `mr-stellar` for SMAPI model operations.
- Do not use the broad `ask_cli_default` AWS IAM user for this Railway-hosted skill.
- Delete or disable the external IAM access key/user in AWS after confirming no Lambda-hosted Alexa work is planned.
- Continue versioning web app and Alexa component together unless rollout diverges.

### Phase 1 — Multi-family backend foundation

- Add family/user/patient tenancy model.
- Scope all app data by tenant.
- Migrate current single-family data to a first tenant.
- Add tests/probes proving tenant isolation.

### Phase 2 — Auth and account linking

- Select auth/OAuth provider.
- Implement web login/signup.
- Implement Alexa account linking.
- Add LinkAccount response when token is missing.
- Add reviewer test account.

### Phase 3 — Public readiness

- Add public GlideChart / Hour Glide product pages.
- Add privacy policy, terms, support, deletion/export process.
- Rewrite skill metadata and invocation examples for publication.
- Add disclaimers in skill description and possibly launch/help responses.

### Phase 4 — Beta

- Run Alexa validation.
- Start beta test with a small number of trusted families/caregivers.
- Monitor logs, account linking failures, misunderstood utterances, and privacy/support issues.
- Version beta releases with release receipts.

### Phase 5 — Certification submission

- Freeze a release candidate.
- Finalize metadata, icons, privacy/compliance answers, and testing instructions.
- Use `docs/alexa-reviewer-safe-test-path.md` for the reviewer path; never store reviewer passwords or token values in repo/docs/MC.
- Submit for certification, preferably “certify now and publish later” for first pass.
- Respond to certification findings.

## Source references

- Amazon: Certify and Publish Your Skill — `https://developer.amazon.com/en-US/docs/alexa/certify/certify-your-skill.html`
- Amazon: Submit Alexa Skills for Certification — `https://developer.amazon.com/en-US/docs/alexa/devconsole/test-and-submit-your-skill.html`
- Amazon: Certification Requirements for Alexa Skills — `https://developer.amazon.com/en-US/docs/alexa/custom-skills/certification-requirements-for-custom-skills.html`
- Amazon: Policy Requirements for Alexa Skills — `https://developer.amazon.com/en-US/docs/alexa/custom-skills/policy-requirements-for-an-alexa-skill.html`
- Amazon: Security Requirements for Alexa Skills — `https://developer.amazon.com/en-US/docs/alexa/custom-skills/security-testing-for-an-alexa-skill.html`
- Amazon: Steps to Implement Account Linking — `https://developer.amazon.com/en-US/docs/alexa/account-linking/steps-to-implement-account-linking.html`
- Amazon: Skill Beta Testing — `https://developer.amazon.com/en-US/docs/alexa/custom-skills/skills-beta-testing-for-alexa-skills.html`

# API specification

**Status:** draft
**Owner:** _unassigned_ (backend lead)
**Last updated:** 2026-09-17
**Companion docs:** [`02-HLD.md`](02-HLD.md), [`04-ADRs.md`](04-ADRs.md), [`hiring_platform_schema.sql`](hiring_platform_schema.sql), [`09-ats-integration.md`](09-ats-integration.md)

---

Base: `https://{host}/api/v1`
Content type: `application/json` unless noted.

---

## 1. Authentication

Two separate authentication domains that must not share credentials.

### Staff (recruiters, interviewers, admins)
Session cookie issued after password or OIDC login. All staff endpoints require a session and an explicit permission.

```
POST /auth/login          {email, password}     → sets session cookie
POST /auth/oidc/start     {provider}            → 302 to IdP
GET  /auth/oidc/callback                        → sets session cookie
POST /auth/logout
GET  /auth/me                                   → {user, org, permissions[]}
```

### Candidates
No account. A candidate presents an invitation token; the API exchanges it for a scoped, short-lived attempt token.

```
POST /candidate/redeem    {token}               → {attempt_token, assessment_summary}
```

The attempt token is scoped to exactly one attempt. It cannot read the question bank, other candidates, or any org resource. It is passed as `Authorization: Bearer <attempt_token>`.

WebSocket connections use a separate single-use ticket:

```
POST /sessions/{id}/ticket                      → {ticket, expires_in: 60}
```

## 2. Conventions

- IDs are UUIDv4.
- Timestamps are RFC 3339 UTC.
- List endpoints are cursor-paginated: `?limit=50&cursor=...` → `{data[], next_cursor}`.
- Mutating endpoints accept `Idempotency-Key` and return the original response on replay.
- `PATCH` is a partial update; `PUT` is not used.
- Filtering uses explicit query params, never a generic query language.

### Error format

```json
{
  "error": {
    "code": "attempt_expired",
    "message": "The deadline for this attempt has passed.",
    "details": { "deadline_at": "2026-09-14T10:30:00Z" },
    "request_id": "req_01J..."
  }
}
```

Codes are stable strings. Clients branch on `code`, never on `message`.

Common codes: `unauthenticated`, `forbidden`, `not_found`, `validation_failed`, `conflict`, `rate_limited`, `attempt_expired`, `attempt_already_submitted`, `question_not_published`, `execution_unavailable`.

### Rate limits

| Scope | Limit |
|---|---|
| Staff API, per user | 600 / min |
| Candidate autosave, per attempt | 60 / min |
| Trial code runs, per attempt | 60 / hour |
| Submissions, per attempt question | 10 total |
| Token redemption, per IP | 20 / hour |

Exceeding returns 429 with `Retry-After`.

---

## 3. Skills and job roles

```
GET    /skills                      ?category=&parent_id=
POST   /skills                      {key, name, category, parent_id}
PATCH  /skills/{id}

GET    /job-roles                   ?family=&seniority=&active=
POST   /job-roles                   {code, title, family, seniority, description}
GET    /job-roles/{id}
PATCH  /job-roles/{id}

GET    /job-roles/{id}/skills       → [{skill, weight, min_difficulty, max_difficulty, is_required}]
PUT    /job-roles/{id}/skills       [{skill_id, weight, min_difficulty, max_difficulty, is_required}]

GET    /job-roles/{id}/coverage     → bank coverage report: for each required skill,
                                      how many published questions exist per difficulty band
POST   /skills/{id}/merge           {target_id, reason}
```

`coverage` is the endpoint that stops you from building an assessment for a role you have no questions for. Call it before assessment creation and warn the recruiter. It answers `404` for a role that does not exist rather than an empty report, and names every required skill with nothing in band in `gaps`.

**As built (2026-09-17).** Everything above except `PATCH /skills/{id}` and the job-openings routes.

| Route | Permission | Notes |
|---|---|---|
| `GET` skills, job roles, a role's skills, coverage | `question.read` | `GET /job-roles?active=` takes the literal `true` or `false`; anything else is `422` |
| `POST /skills`, `POST /skills/{id}/merge` | `question.write` | Merge is audited with its `reason` |
| `POST`/`PATCH /job-roles`, `PUT /job-roles/{id}/skills` | `assessment.write` | A role's requirements decide what its assessments are composed from, so bank authoring alone does not grant them |

- A role `code` is upper-case alphanumeric with `-` or `_` (`BE-SDE1`), unique per organisation, and fixed at creation. A taken code is `409 conflict`. Retiring a role is `PATCH {is_active: false}`; there is no delete, because assessments keep pointing at it. A `PATCH` naming nothing is `422`.
- `PUT /job-roles/{id}/skills` replaces the whole set and answers `{job_role_id, data: [{skill_id, skill_key, skill_name, weight, min_difficulty, max_difficulty, is_required}]}`, required first, then by weight, then by key. `is_required` defaults to `true`. A skill named twice, or `min_difficulty` above `max_difficulty`, is `422`.
- **A skill id this organisation cannot read is `422 validation_failed`**, with `details.fields[]` naming each by position (`body/1/skill_id`, rule `not_found`), and nothing is written. That covers an id that does not exist and one belonging to another organisation, answered identically. Global skills are readable by everyone and accepted. The check exists because a foreign key is validated without row-level security (`14-threat-model.md` T-041).
- Taxonomy refusals: a missing parent is `422` on `body/parent_id` (`not_found`); a third level is `422` (`too_deep`, ADR-009). A merge whose source is missing is `404`; a missing target is `422` on `body/target_id`. A merge is refused (`merge_refused`) when the source is a global skill — shared by every organisation, so no single one may merge it away — when the target is the source's own child, and when the source has children and the target is itself a child, which would make them a third level.
- Every write is audited: `skill.create`, `skill.merge`, `job_role.create`, `job_role.update` and `job_role.skills.replace`, the last two with `before` and `after`.

```
GET    /job-openings                ?status=&job_role_id=
POST   /job-openings                {job_role_id, title, location, headcount}
PATCH  /job-openings/{id}
```

---

## 4. Question bank

```
GET    /questions                   ?kind=&status=&skill_id=&difficulty=&q=&exposure_gt=
POST   /questions                   {kind, source_license?, external_ref?}
GET    /questions/{id}              → includes current_version expanded
PATCH  /questions/{id}              {status, archived_at}
DELETE /questions/{id}              → soft delete (sets archived_at)
```

### Versions

```
GET    /questions/{id}/versions
POST   /questions/{id}/versions     {prompt_md, explanation_md, difficulty,
                                     est_seconds, max_score, negative_score,
                                     options[]?, coding_spec?, test_cases[]?,
                                     answer_keys[]?}
GET    /questions/{id}/versions/{v}
PATCH  /questions/{id}/versions/{v} → 409 if published_at is set
POST   /questions/{id}/versions/{v}/publish
```

Publishing is a distinct action requiring `question.publish`. After publish the version is frozen. A `PATCH` against a published version returns `409 conflict` with code `version_immutable`.

#### What each kind may carry

A version body does not state its kind — the question does — so the rule is checked where both are known, on the **merged** content (the body copied forward over the previous version). It is enforced at two severities, at different moments:

| Severity | Meaning | Checked on |
|---|---|---|
| `wrong_kind` | Content the kind can never use | `POST .../versions` and `PATCH .../versions/{v}` — every write |
| `incomplete` | Content the kind needs but lacks | `POST .../versions/{v}/publish` only |

A draft may be unfinished; it may not be wrong. Refusing `incomplete` content only at publish keeps authoring incremental, and refusing it there keeps an ungradeable version from becoming immutable.

| Kind | May carry | Needs at publish |
|---|---|---|
| `mcq_single` | `options` | ≥ 2 options, exactly 1 correct |
| `mcq_multi` | `options` | ≥ 2 options, ≥ 1 correct |
| `true_false` | `options` | exactly 2 options, exactly 1 correct |
| `short_answer` | `answer_keys` | ≥ 1 answer key |
| `coding` | `coding_spec`, `test_cases` | a `coding_spec`, and ≥ 1 **hidden** test case — sample cases are shown to the candidate, so a question graded only on them can be passed by printing the expected output. No `fixture_sql` |
| `sql` | `coding_spec`, `test_cases` | a `coding_spec` with `fixture_sql`, and ≥ 1 hidden test case |
| `subjective`, `system_design` | nothing machine-checkable | nothing — human graded |

A refusal is `422 validation_failed`, reporting every problem at once. `details.fields[]` names each one as `{field: "body/<field>", rule: "wrong_kind" \| "incomplete", message}`, and `details.stage` is `draft` or `publish`. A refused publish stamps nothing: `published_at` stays null.

### Skills, stats, preview

```
PUT    /questions/{id}/skills       [{skill_id, weight}]
GET    /questions/{id}/stats        → {question_id, version_no, n_attempts, p_value, discrimination,
                                       mean_seconds, computed_at, min_responses}
POST   /questions/{id}/preview      {language?, code?}  → dry-run against sample cases
```

`PUT /questions/{id}/skills` replaces the question's whole tag set and answers `{question_id, skills: [{skill_id, weight}]}`. Requires `question.write`. Tags belong to the question, not a version, so a published question can be re-tagged without touching what any candidate was served. Weight is `0`–`99.99`; at most 50 skills; a skill named twice is `422`; a skill this organisation cannot read is `422` exactly as for job-role requirements above. There is no field that tags a question with a job role (ADR-009), and one sent is refused as unknown. Audited as `question.skills.replace` with `before` and `after`.

`stats` reports the **current version**, never a pool across versions (ADR-003), as the nightly sweep last recorded it. `p_value` and `discrimination` are null until `min_responses` (30) finalised responses exist, and discrimination is also null when either the item or the rest score has no variance — `null` means "cannot tell", which a `0` would misreport as "does not discriminate". A question the sweep has not reached answers `200` with zeros and nulls, not `404`. Requires `question.read`.

`preview` lets an author verify their reference solution passes before publishing. It runs through the same execution path as candidate submissions, against **sample cases only** — a preview's output is shown to whoever asked. With an empty body it runs the question's own reference solution.

Requires `question.write`. Only `coding` and `sql` questions can be previewed; any other kind is `422 validation_failed`.

**Until the execution service lands in P4**, every well-formed preview of a runnable question answers `503 execution_unavailable` with `details.ran: false`. Authorisation, validation, the `404` and the kind check all run first and are final, so P4 replaces only the last step. It deliberately never returns a stubbed result: an author who reads "passed" publishes on it.

### Bulk

```
POST   /questions/import            multipart: file + {format: qti|json|humaneval|mbpp|lbpp|exercism,
                                                       default_skills[], source_license}
                                    → 202 {job_id}
GET    /import-jobs/{id}            → {status, created, skipped, errors[]}
GET    /questions/export            ?format=qti|json&skill_id=&status=  → 202 {job_id}
```

Import is asynchronous and reports per-row errors rather than failing the whole file. `source_license` is mandatory on import — see `05-licensing-and-compliance.md`.

---

## 5. Assessments

```
GET    /assessments                 ?status=&job_role_id=
POST   /assessments                 {name, job_role_id, duration_seconds, pass_score_pct,
                                     shuffle_sections, allow_back_nav, proctoring_profile}
GET    /assessments/{id}
PATCH  /assessments/{id}            → 409 if status=published and attempts exist;
                                      use /versions instead
POST   /assessments/{id}/versions   → clones into a new draft version
POST   /assessments/{id}/publish

POST   /assessments/{id}/sections   {ordinal, name, kind, duration_seconds,
                                     shuffle_questions, shuffle_options}
PATCH  /sections/{id}
DELETE /sections/{id}

PUT    /sections/{id}/questions     [{question_id, pin_version_id?, ordinal, score_override?}]
POST   /sections/{id}/rules         {pick_count, skill_ids[], kinds[],
                                     min_difficulty, max_difficulty,
                                     exclude_seen_days, score_per_question}
DELETE /rules/{id}

POST   /assessments/{id}/simulate   → resolves all rules against the current bank and returns
                                      {feasible: bool, sample_draw[], warnings[]}
```

`simulate` is important. It catches "your rule asks for 10 hard Python questions and the bank has 4" before a candidate hits it mid-exam, which is the single worst failure this product can have.

### Auto-compose

```
POST   /assessments/auto            {job_role_id, duration_seconds, difficulty_profile}
                                    → draft assessment with sections derived from
                                      job_role_skills weights
```

Generates a starting point from the role's skill weights. Always a draft; a human reviews before publish.

---

## 6. Candidates and invitations

```
GET    /candidates                  ?q=&job_opening_id=
POST   /candidates                  {email, full_name, phone, source}
POST   /candidates/bulk             multipart CSV  → 202 {job_id}
GET    /candidates/{id}
DELETE /candidates/{id}             → GDPR erasure; hard-deletes PII, retains
                                      anonymised aggregate rows

POST   /applications                {candidate_id, job_opening_id}
PATCH  /applications/{id}           {stage}

POST   /invitations                 {assessment_id, application_id?, candidate_id,
                                     expires_at, max_attempts, opens_at?,
                                     accommodations?: {extra_time_pct}}
POST   /invitations/bulk            {assessment_id, candidate_ids[], expires_at}
                                    → 202 {job_id}
GET    /invitations                 ?assessment_id=&status=
POST   /invitations/{id}/resend
DELETE /invitations/{id}            → revokes the token
```

The plaintext token is returned **once**, in the creation response, and never again. The database stores only the hash.

`accommodations.extra_time_pct` is recorded on the invitation and applied when `deadline_at` is computed. It appears in the audit log.

---

## 7. Attempts (candidate-facing)

All endpoints below require the attempt token.

```
GET    /attempt                     → {id, status, deadline_at, server_time,
                                       sections[], progress}
POST   /attempt/start               → materialises attempt_questions, sets deadline_at
GET    /attempt/questions/{ordinal} → question as served, with option_order applied
PATCH  /attempt/answers/{aq_id}     {selected_option_ids?, text_answer?, seconds_spent}
POST   /attempt/submit              → final submit
POST   /attempt/heartbeat           {focused: bool}  → returns server_time, seconds_remaining
```

`server_time` is returned on every call. The client displays a countdown derived from it and never trusts the local clock. `heartbeat` doubles as a liveness signal and a proctoring input.

### Coding within an attempt

```
POST   /attempt/questions/{aq_id}/run      {language, code, stdin?}
                                           → 202 {submission_id}   (trial, sample cases only)
POST   /attempt/questions/{aq_id}/submit   {language, code}
                                           → 202 {submission_id}   (graded, hidden cases)
GET    /attempt/submissions/{id}           → status + filtered results
GET    /attempt/submissions/{id}/stream    → SSE; emits progress then final result
```

Result filtering by case type:

| Case | Candidate sees |
|---|---|
| Sample (`is_sample=true`) | stdin, expected, actual, stderr, pass/fail |
| Hidden | pass/fail and case label only |
| Compile error | full compiler stderr |

### Proctoring signals

```
POST   /attempt/proctor-events      [{event_type, at, payload}]   batched, fire-and-forget
POST   /attempt/proctor-media       multipart  → only when proctoring_profile != 'none'
                                                 and consent recorded
```

---

## 8. Attempt state machine

```
                  ┌─────────┐
                  │ created │  invitation redeemed
                  └────┬────┘
                       │ POST /attempt/start
                  ┌────▼────────┐
         ┌────────┤ in_progress ├────────┐
         │        └────┬────────┘        │
 deadline passed       │ submit          │ staff void
         │             │                 │
   ┌─────▼───┐   ┌─────▼─────┐           │
   │ expired │   │ submitted │           │
   └─────┬───┘   └─────┬─────┘           │
         │             │                 │
         └──────┬──────┘                 │
                │ grading workers finish │
        ┌───────▼────────┐               │
        │  auto_graded   │               │
        └───────┬────────┘               │
                │                        │
     ┌──────────┴──────────┐             │
     │ needs human?        │             │
   yes│                   no│            │
┌─────▼────────┐      ┌─────▼──────┐     │
│ under_review │─────►│ finalised  │     │
└──────────────┘      └────────────┘     │
                                    ┌────▼───┐
                                    │ voided │
                                    └────────┘
```

Rules:
- `expired` is set by a scheduled sweep, not by the client. Whatever was autosaved is graded.
- The transition to `finalised` requires every `answers.final_score` to be non-null. Enforced in a transaction.
- `voided` is reachable from any state, requires a reason, and is audited.
- Re-grading a `finalised` attempt creates a new grading run rather than mutating in place; the audit log records both scores.

---

## 9. Results and reporting (staff)

```
GET    /attempts                    ?assessment_id=&status=&candidate_id=&integrity_flag=
GET    /attempts/{id}               → full detail: served questions, answers, submissions
GET    /attempts/{id}/report        ?format=json|pdf
POST   /attempts/{id}/regrade       {reason}     → re-runs grading, audited
POST   /attempts/{id}/void          {reason}
PATCH  /answers/{id}/score          {manual_score, reason}    → requires attempt.grade

GET    /assessments/{id}/results    → cohort view with distribution
GET    /assessments/{id}/analytics  → per-question p-value, discrimination, mean time,
                                      option distribution for MCQs
GET    /reports/adverse-impact      ?assessment_id=&group_by=
                                    → pass rates by group where voluntarily collected
GET    /reports/funnel              ?job_opening_id=
```

The MCQ option distribution in `/analytics` is how you find broken questions: if 60% of candidates pick the same wrong option, the question is ambiguous, not hard.

---

## 10. Live interviews

```
GET    /sessions                    ?status=&application_id=
POST   /sessions                    {application_id?, job_role_id?, title, scheduled_at}
                                    → {id, room_code, join_url}
GET    /sessions/{id}
POST   /sessions/{id}/end
POST   /sessions/{id}/ticket        → short-lived WS ticket

GET    /sessions/{id}/events        ?from=&to=       → replay stream
GET    /sessions/{id}/replay        → packaged replay artifact

POST   /sessions/{id}/run           {language, code}  → 202 {submission_id}
```

Candidate join (no auth):

```
POST   /join/{room_code}            {display_name}   → {session_token, ticket}
```

WebSocket: `wss://{host}/collab/{room_code}?ticket=...` — standard Yjs sync + awareness protocol.

---

## 11. Scorecards

```
GET    /scorecard-templates         ?job_role_id=
POST   /scorecard-templates         {name, job_role_id, criteria[]}
GET    /scorecards                  ?session_id=&attempt_id=
POST   /scorecards                  {template_id, session_id|attempt_id}
PATCH  /scorecards/{id}             {ratings[], overall, notes_md}
POST   /scorecards/{id}/submit      → locks it
```

Submitted scorecards are immutable. Reviewers cannot see each other's scorecards until all are submitted — this prevents anchoring, and it is a hard rule in the API, not a UI convention.

---

## 12. Webhooks

Configured per org. Signed with HMAC-SHA256 over the raw body; signature in `X-Signature`. At-least-once delivery with exponential backoff and a 24-hour retry window.

```
POST   /webhooks                    {url, events[], secret}
GET    /webhooks/{id}/deliveries
POST   /webhooks/{id}/test
```

Events:

| Event | Payload |
|---|---|
| `invitation.sent` | invitation, candidate |
| `attempt.started` | attempt, candidate |
| `attempt.submitted` | attempt |
| `attempt.finalised` | attempt with scores and per-skill breakdown |
| `attempt.flagged` | attempt, integrity events summary |
| `session.ended` | session, duration, participants |
| `scorecard.submitted` | scorecard, ratings |

Consumers must be idempotent on `event_id`.

---

## 13. Admin

```
GET    /users                       ?role=
POST   /users/invite                {email, full_name, role_keys[]}
PATCH  /users/{id}/roles            {role_keys[]}
GET    /user-roles
POST   /user-roles                  {key, name, permission_keys[]}
GET    /permissions

GET    /audit-log                   ?actor=&action=&entity_type=&from=&to=
GET    /org/settings
PATCH  /org/settings                {branding?, proctoring_defaults?}
POST   /org/export                  → 202 full data export
```

### `/org/settings`, as built

The first endpoint implemented against the tenancy spine (P1 step 7), and the shape every
staff endpoint after it follows: session cookie, an explicit `org.admin` permission, a read
scoped by row-level security rather than by a `WHERE` clause, and — on the write — one
`audit_log` row in the same transaction as the change.

```json
{
  "org": { "id": "…", "name": "Acme Ltd", "slug": "acme" },
  "settings": {
    "branding": { "display_name": "Acme Talent", "primary_colour": "#1f6feb", "logo_url": null },
    "proctoring_defaults": {
      "require_webcam": false,
      "require_screen_recording": false,
      "require_id_check": false
    }
  },
  "server_time": "2026-10-14T09:30:00.000Z"
}
```

| Property | Behaviour |
|---|---|
| Permission | `org.admin`, on both verbs |
| Scope | The calling session's own organisation. There is no path parameter, and no way to name another |
| `PATCH` semantics | Partial per **field**: `{"branding": {"logo_url": null}}` clears the logo and leaves the rest. `null` clears, an omitted field is unchanged |
| Unknown fields | `422 validation_failed`, naming the field — never silently discarded |
| Empty body | `422`. A change that names no section would write an audit row recording nothing |
| Response projection | Only the fields above are served. `organizations.settings` is `jsonb`, and a key this build does not define is neither served nor destroyed by a write |
| Audit | Action `org.settings.update`, entity `organization`, with `before` and `after`. Reads are not audited |
| Absent organisation | `404 not_found`, never `403` — a 403 would confirm that another tenant holds the row (ADR-010) |

**`retention_days` is not accepted.** [`11-data-retention-and-dpia.md`](11-data-retention-and-dpia.md) §4.2
supersedes it with a typed object over five clocks, each with a floor, a ceiling and a
direction it may be moved in, enforced by `CHECK` constraints on `org_retention_policy`
rather than by the API alone. A `jsonb` blob carries no constraint, so the field arrives
with that table and its constraints rather than as a number this endpoint cannot stand
behind. A request carrying it is refused rather than ignored.

**`proctoring_defaults` governs capture, never outcome.** Each flag turns a capture on or
off for assessments created afterwards. No field here rejects a candidate, voids a sitting
or changes a score, and [ADR-007](04-ADRs.md) makes that a product constraint rather than a
configuration option.

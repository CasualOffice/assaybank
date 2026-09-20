# API specification

**Status:** draft
**Owner:** _unassigned_ (backend lead)
**Last updated:** 2026-09-21
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

**The shapes are in `packages/contracts`, 2026-09-20** — `LoginRequestSchema` and
`StaffProfileSchema`, moved out of `apps/api` when the console had to parse them (`H-177`). A
package may never import an app, and docs/17 §3a puts a response shape a front end parses in the
contract. `StaffProfile` carries `permissions[]` per action and no role name, which is what makes a
custom role possible (FR-27) and what keeps `if (role === 'admin')` out of a screen.

**`GET /auth/me` is what the console asks before it renders anything.** A staff surface has three
session states — resolving, absent, present — and the console draws a different thing for each; it
never draws chrome around a session it has not established. `unauthenticated` from *any* endpoint
means the same thing, which is why it is a code rather than a status: docs/03 distinguishes it from
`forbidden`, and an expired session is not a staff member lacking a permission.

**The session cookie, 2026-09-20** (`H-149`). `__Host-assaybank.session_token`: `HttpOnly`,
`Secure`, `SameSite=Lax`, `Path=/`, no `Domain`, eight hours. The `__Host-` prefix rather than
`__Secure-` is the load-bearing part — `__Secure-` promises only that the cookie was set over
https, which any sibling subdomain of the deployment's site can also do, while `__Host-` confines
the cookie to exactly the host that set it. A browser enforces the prefix by refusing the cookie
outright unless `Secure` is set, `Path` is exactly `/` and `Domain` is absent, so the promise
cannot be half kept.

**Every state-changing staff request carries a CSRF token, 2026-09-20** (`H-153`, docs/14 T-017).

```
X-Csrf-Token: <nonce>.<hmac>        on POST, PUT, PATCH and DELETE
__Host-assaybank.csrf_token=…       the cookie it is copied from
```

The token is minted alongside the session — by `POST /auth/login`, and again by `GET /auth/me` on
every page load — and travels in the one cookie in this system that is deliberately **not**
`HttpOnly`, because the client has to read it to echo it. A request that presents the session
cookie without a matching header is refused with `forbidden`: the credential was fine, the context
was not, and signing in again would not help.

The HMAC covers the session the token was issued for, so a token is not transferable between
sessions. That is what a plain random double-submit value does not give you: it proves only that
the sender could read *a* cookie, which is no longer true the moment anything can write one.

`POST /auth/login` and `POST /auth/oidc/start` are exempt, and nothing else is. They establish a
credential rather than spend one, and somebody whose session has expired holds a dead cookie and no
token — which is exactly the state you are in when you need to sign in. Both remain covered by the
`Origin` and `Sec-Fetch-Site` check, which applies to every route.

The names are constants in `packages/contracts` (`CSRF_HEADER`, `CSRF_COOKIE_NAME`) because both
sides have to agree on them and a package may never import an app. Clients must send the header
from a cookie read at request time rather than from one cached at start-up: the token changes
whenever the session does.

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

**It is a read model with a published schema, 2026-09-20.** `JobRoleSchema`, `JobRoleListResponseSchema`, `SkillCoverageSchema` and `JobRoleCoverageSchema` are zod schemas in `packages/contracts` rather than bare interfaces, so the staff console parses these responses rather than casting them — the same treatment the question bank's responses already had. The rule that produced the change is worth stating: **where a front end parses a response, its schema belongs in `packages/contracts`.** An app that declares its own would need `zod` as a dependency and would hold a second definition of the same shape, which is the drift this package exists to prevent. `GET /job-roles` is deliberately unpaginated — an organisation has tens of roles, not thousands — and says so in the schema's description rather than leaving a caller to discover it.

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

**Numeric bounds (2026-09-17).** `max_score`, `negative_score`, an option's `score_delta`, a test case's `weight` and an answer key's `score` are held to their `numeric(6,2)` columns: at most `9999.99` in magnitude and at most two decimal places, otherwise `422 validation_failed`. Skill weights are `numeric(4,2)`: `0`–`99.99`, two places. An answer key's `tolerance` is non-negative and stored exactly. Before this, `10000` reached the database and answered `500`, and a third decimal place was rounded away without a word. Answer keys are returned in the order they were written.

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

**`assertion_code`, added 2026-09-20 (ADR-024).** A test case carries one of two things depending on `coding_spec.grading_mode`. In `test_cases` mode it is `stdin` and `expected_stdout` and `assertion_code` is null; in `unit_tests` mode it is `assertion_code` — the source that exercises the candidate's submission — and one case is one assertion, so per-case `weight` gives partial credit over assertions. Publishing a `unit_tests` question with a case that has no `assertion_code` is refused with the same `incomplete` treatment as a coding question with no hidden case: allowed while it is a draft, refused at the irreversible step. It is author-only, like `expected_stdout`, and the candidate payload has no shape that could carry it.
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
POST   /questions/import            ?format=json|qti|humaneval|mbpp|lbpp&source_license=&default_skill_id=…&default_difficulty=
                                    body: the file, Content-Type: application/octet-stream
                                    → 202 {job_id, status: "queued", job_url}
GET    /import-jobs/{id}            → job view
POST   /questions/export            ?format=json|qti&status=&skill_id=   → 202 {job_id, status, job_url}
GET    /export-jobs/{id}            → job view
GET    /export-jobs/{id}/file       → the file, until expires_at
GET    /questions/attributions      → [{source_license, dataset, questions, published}]
```

Import is asynchronous and reports per-row errors rather than failing the whole file. `source_license` is mandatory on import — see `05-licensing-and-compliance.md`.

**As built (2026-09-17)**, for `json` and `qti`. **Extended 2026-09-20 (`H-032`)** with three
dataset formats — `humaneval`, `mbpp`, `lbpp` and `exercism` — all **import only**. The first three are
line-delimited JSON; an Exercism track is a zip of exercise directories, read by the same
unzip the QTI package uses.

Three things about a dataset import differ from a bank document, and each is a decision rather
than an omission:

- **`source_license` is still required and is still ignored for the items.** HumanEval is MIT
  because it is MIT; an import that let an uploader relabel it would put content in the bank
  whose real terms nobody could reconstruct. The dataset's own licence is applied to every row,
  from docs/05 §2.
- **Everything arrives as a draft**, never published. Nobody has read it, its difficulty is a
  declared placeholder rather than a measurement, and publishing is irreversible (ADR-003).
- **`external_ref` keeps the dataset's own `dataset/id`**; the item's interchange `ref` is the
  same identifier with its slashes replaced, because in a QTI package a `ref` becomes a file
  name.

`GET /questions/attributions` is the credit CC-BY-4.0 requires, not a report. docs/05 §2 decides
what "in any reasonable manner" means here — a page in the console and the credit preserved in
every export — and this is the endpoint behind the first half. It needs `question.read` rather than
an export permission: gating the record of what we owe behind the ability to download the bank
would hide it from most of the people who need to know. In-house content (`proprietary`) is
excluded, because a question we wrote is not somebody else's work to credit. `questions` and
`published` are separate because they answer different things: the obligation follows every copy
held, and the ratio is the metric docs/05 §2 asks teams to watch.

Asking for a dataset format on **export** is `422`: we do not own those file shapes, and a
question edited here has no MBPP row to become. An export of imported content is a JSON bank
document, which carries `source_license` and `external_ref` per item and an `attributions`
list in its header — so the CC-BY credit MBPP requires survives the round trip.

- **The upload is the body**, `application/octet-stream`, up to 32 MiB — one file per request, and no multipart parser between the socket and the bytes. Options are query parameters. Any other content type, an empty body, a body over 32 MiB, an unknown format, a missing `source_license`, or a `default_skill_id` the organisation cannot see is `422 validation_failed`, and nothing is stored. (Every refusal Fastify makes before a handler — 413 included — is `validation_failed`; see §2.)
- **Export is `POST`**, not `GET` as first drafted: it creates a job, and a `GET` that creates something is neither safe nor idempotent.
- **Permissions.** Import, export and downloading an export's file need `question.write`; reading a job needs `question.read`. An export is the whole bank with reference solutions and hidden test cases, so looking at questions one at a time does not grant it. The import request, the export request and every download are audited: `bank_job.import`, `bank_job.export`, `bank_job.download`.
- **The job view:** `{id, kind, format, status, created, skipped, problems[], problems_truncated, failure, created_at, started_at, finished_at, expires_at, file_bytes, file_url}`. `status` is `queued → dispatched → running → succeeded | failed`. `problems` are `{index, ref, path, message}` per item, at most 1,000. `failure` is set when the file could not be read at all — not JSON, wrong format or version, no manifest, over the archive limits — with a message a person can act on. `file_url` appears for a succeeded export and stops working at `expires_at`, seven days after it finished. A job of the other kind, another organisation's job, or an expired file is `404`.
- **Delivery (ADR-021).** The request writes the job row and its audit row in one commit; the worker claims committed rows, so a `202` cannot lose its job. Work starts within about two seconds. An import runs one transaction per item and resumes at its checkpoint if retried.

#### The two file formats

The routes above are not built yet. The formats they carry are, as pure codecs in `apps/worker/src/interchange/` (2026-09-17), with round-trip tests over all eight kinds.

**JSON bank document** — the lossless format, for moving a bank between installations:

```
{ "format": "assaybank.bank", "format_version": 1, "exported_at": "<RFC 3339>",
  "attributions": [{ "source_license", "dataset", "items" }],
  "items": [{
    "ref", "kind", "status", "source_license", "external_ref",
    "skills":   [{ "key", "weight" }],
    "versions": [{ "version_no", "published", "locale", "prompt_md", "explanation_md",
                   "difficulty", "est_seconds", "max_score", "negative_score",
                   "options":     [{ "body_md", "is_correct", "score_delta", "rationale_md" }],
                   "coding_spec": { "allowed_languages", "starter_code", "solution_code",
                                    "time_limit_ms", "memory_limit_kb", "grading_mode",
                                    "checker_code", "fixture_sql" } | null,
                   "test_cases":  [{ "label", "stdin", "expected_stdout", "args",
                                      "assertion_code", "is_sample", "weight" }],
                   "answer_keys": [{ "match_type", "pattern", "tolerance", "score" }] }] }] }
```

- Every field is present, `null` where absent. Nothing is defaulted, so the file says what each question *is* without reference to this schema's column defaults.
- The full version history travels, oldest first, with strictly ascending `version_no`. Publication crosses as a flag, not an instant.
- Identifiers, timestamps, authors and exposure counts do not cross; the importing organisation mints its own. Skills cross by `key`, because a skill id means nothing in another tenant.
- `ref` is unique within the file and nothing more — a handle for error reports.
- Values carry the API's numeric bounds, and no string may contain U+0000 or an unpaired surrogate: PostgreSQL `text` cannot store either, so an item carrying one is refused with the field named rather than failing at the write or being silently altered.
- Reading: a file that is not JSON, names another `format`, or a `format_version` other than `1` is refused whole. Each item is then validated independently — the schema, a lifecycle that agrees with its versions (a `published` or `retired` question needs a published version; `draft` and `review` must have none), and the kind rule per version at the stage that version is at (publish for a published version, draft otherwise; §4 "What each kind may carry"). A failing item is reported as `{index, ref, path, message}` and skipped; the rest are read.

**QTI 2.1 content package** — for moving items into another assessment tool. A zip with `imsmanifest.xml` and one `items/<ref>.xml` per question.

- Standard QTI carries what QTI can express: the prompt, the explanation and per-option rationale as `modalFeedback`, choices as `choiceInteraction` with `correctResponse`, per-option score overrides as `mapping`, and exact or case-insensitive short-answer keys as `mapEntry` rows (`caseSensitive`).
- Everything else goes in each manifest resource's `<metadata>` under the namespace `urn:assaybank:bank:v1`: the kind (QTI cannot tell `true_false` from a two-option `mcq_single`), status, difficulty, timing, scoring, skills, licence provenance, the coding spec, test cases, and answer keys QTI cannot express — regular expressions, numeric tolerances, a repeated pattern, or a pattern containing a tab or newline, which an XML attribute would normalise. Those keep their original position.
- **One version per question**: the last published version, or the last of all if none is published. It imports as version 1. History crosses in the JSON document only.
- Text XML 1.0 cannot carry exactly — carriage returns, most control characters, unpaired surrogates — is written as base64 of its UTF-16 code units with `encoding="utf16le-base64"`. Everything else is readable escaped text.
- Reading refuses a package with no manifest, a `DOCTYPE` anywhere, an archive over 20,000 entries, any entry over 16 MiB or a total over 256 MiB (checked from the central directory before inflating, and again after). A resource whose `href` is absolute or contains `..`, or names a file not in the archive, is reported against that item.
- **Through the database** (`apps/worker/src/jobs/bank-transfer.ts`): an import writes one transaction per item through the repositories the API uses, restores the lifecycle (a published item arrives published), mints its own ids and instants, stamps each version a millisecond apart so the history lists in order, audits each created question as `question.import` to the person who asked, and applies the request's `source_license` only to items with none of their own. Skills resolve by key within the importing organisation — its own skill before a global one with the same key — and an unknown key fails that item by name rather than creating a skill. An export lists every non-archived question oldest first, with positional refs (`q-00001`), all versions ascending, and skills sorted by key.
- An item from another tool, with no Assaybank metadata, is read as an unpublished draft: `choiceInteraction` becomes `mcq_single` (one choice) or `mcq_multi`, `textEntryInteraction` becomes `short_answer`, `extendedTextInteraction` becomes `subjective`. QTI has no difficulty, so the importer must supply a default; without one the item is refused by name, never guessed.

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

**Built 2026-09-21** (`H-179`). Two endpoints, because a plan is a read and an assessment is a
write:

```
GET    /job-roles/{id}/assessment-plan  ?question_count=&duration_seconds=&kind=
                                        &exclude_seen_days=
                                    → {role_title, question_count, duration_seconds,
                                       total_score, sections[{name, rules[]}], feasible}
                                      where each rule carries {skill_id, skill_name,
                                      pick_count, min_difficulty, max_difficulty, available}

POST   /assessments/auto            {job_role_id, name?, question_count?, duration_seconds?,
                                     kind?, exclude_seen_days?}
                                    → 201 the composed assessment, saved as a draft
```

The plan writes nothing, so a recruiter can look at the paper before committing to it. Both
derive from one pure function (`composeFromRole` in `packages/core-domain`), so the plan shown
and the assessment written cannot disagree.

**What composition decides, from the role alone.** One section holding one rule per *required*
skill; the count allocated in proportion to the skill's weight by largest remainder, so the
rules always sum to exactly `question_count`; each rule carrying the band the role declares for
that skill. Every required skill gets at least one question before proportionality applies —
otherwise the lightest skills round to zero and the paper silently stops measuring things the
role calls required. That gives a floor: a role with six required skills cannot have a
five-question assessment, and asking for one is refused rather than quietly served.

Defaults when the caller says nothing: two questions per required skill, and five minutes per
question. Every question is worth one mark, so a percentage is questions correct — weight
decides how *many* questions a skill gets, never what one is worth.

**`available` and `feasible`.** Each rule reports how many published questions the bank holds
for it right now, counted exactly as the coverage report counts: published, not archived,
current version inside the band. `feasible` is false when any rule asks for more than it has.
The plan still returns the composition, so the screen can name the skills that fall short;
`POST /assessments/auto` refuses with `validation_failed` and `details.shortfalls`.

Refusing matters more than it looks: the draw will not short-draw at attempt start (ADR-004),
so an infeasible assessment does not degrade — it fails for the first candidate to open the
link. The check is a snapshot and deliberately not recorded as a guarantee, because a question
retired on Friday can make Tuesday's assessment infeasible; `POST /assessments/{id}/simulate`
remains the check that runs against the bank as it is.

Always a draft; a human reviews before publish.

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

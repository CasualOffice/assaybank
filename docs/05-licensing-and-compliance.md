# Licensing and compliance

**Status:** draft
**Owner:** _unassigned_ (legal counsel)
**Last updated:** 2026-09-15
**Companion docs:** [`04-ADRs.md`](04-ADRs.md), [`11-data-retention-and-dpia.md`](11-data-retention-and-dpia.md), [`16-ai-usage-policy.md`](16-ai-usage-policy.md)

---

Four separate concerns that get conflated. **Outbound licensing** governs what other people may do with the code we write. **Inbound dependency licensing** governs the code we build on. **Content licensing** governs the questions in the bank. **Regulatory compliance** governs the fact that this system participates in employment decisions.

The first two are routinely treated as one question and are not. We refuse copyleft *dependencies* because we cannot relicense code we do not own, and an obligation attached to it constrains what we may do. We grant a weak-copyleft *licence* on our own code because the copyright is ours and MPL binds recipients, not the holder. Both positions can hold at once, and §0 and §1 below are why.

All three need owners. None of this is legal advice — get counsel to review before you go live, particularly §3.

---

## 0. Outbound licence — what others may do with this code

**The project is licensed MPL-2.0** ([`../LICENSE`](../LICENSE), ADR-020). Exhibit B is deliberately not applied, which leaves the code GPL-compatible.

| Question | Answer |
|---|---|
| May someone self-host this commercially? | Yes, including a competitor |
| May someone modify it? | Yes |
| Must they publish their modifications? | Only to MPL-covered **files**, and only on distribution — not on network use |
| May they combine it with proprietary code? | Yes. MPL does not reach the larger work |
| May they combine it into a GPL/AGPL work? | Yes. Exhibit B is not applied, so MPL files may be distributed as part of such a combination |
| Does running it as a service trigger disclosure? | No. That is AGPL's trigger, not MPL's |

File-level granularity is the practical consequence to understand: the licence boundary is drawn by which file code sits in. A proprietary extension belongs in its own file, not as an edit to a covered one. Every source file carries the Exhibit A notice, enforced by `scripts/check-licence-headers.mjs` in CI rather than by review, because a file without the notice has an ambiguous licence status.

Relicensing away from MPL later would require the agreement of every copyright holder, so contributor sign-off is collected from the first external contribution rather than retrofitted.

---

## 1. Inbound dependency licensing

### Policy

Permitted: MIT, Apache-2.0, BSD-2-Clause, BSD-3-Clause, ISC, MPL-2.0, PostgreSQL License, Unlicense, CC0.

Prohibited: GPL (any version), LGPL where static linking applies, AGPL (any version), SSPL, BSL/BUSL, Commons Clause, "source available" licenses, and anything with a field-of-use restriction.

Enforced in CI. The build fails on a prohibited license in the dependency tree, including transitive dependencies. An SBOM (CycloneDX or SPDX) is produced per release.

### Approved stack

| Component | License | Notes |
|---|---|---|
| PostgreSQL | PostgreSQL License | Permissive, BSD-like |
| Redis | BSD-3 (≤7.2) | **Check your version.** Redis relicensed to RSALv2/SSPL in 2024; 7.2 and earlier remain BSD. Valkey (BSD-3) is the clean fork if you need current. |
| Piston | MIT | Execution engine |
| Monaco Editor | MIT | |
| CodeMirror 6 | MIT | Alternative to Monaco |
| Yjs / y-websocket | MIT | CRDT collaboration |
| BullMQ | MIT | Job queue |
| React | MIT | |
| TanStack Router / Query | MIT | |
| Fastify | MIT | |
| FastAPI | MIT | If Python |
| Drizzle ORM | Apache-2.0 | |
| SQLAlchemy | MIT | If Python |
| Lucia / Better Auth | MIT | |
| LiveKit | Apache-2.0 | Video SFU |
| MinIO | **AGPL-3.0** ⚠ | See below |
| Safe Exam Browser | MPL-2.0 / mixed | Client-side lockdown, distributed to candidates unmodified |
| Tailwind CSS | MIT | |

### Two traps worth naming

**MinIO is AGPL-3.0.** It is the default self-hosted S3-compatible store and it violates the policy above. Options: use a managed S3-compatible service (Cloudflare R2, Backblaze B2, AWS S3), use SeaweedFS (Apache-2.0), or purchase a MinIO commercial license. Running AGPL software as a networked service inside your product is exactly what the license is written to catch.

**Redis relicensed.** Versions after 7.2 are RSALv2/SSPL. Pin to 7.2, or move to Valkey, the BSD-3 Linux Foundation fork.

### Rejected components and why

| Component | License | Why rejected |
|---|---|---|
| Judge0 | GPL-3.0 | More mature than Piston; copyleft blocks commercialisation (ADR-002) |
| CoderScreen | GPL-3.0 | Closest existing product to this design; same blocker |
| Moodle | GPL-3.0 | Would have covered MCQ + question bank entirely |
| DMOJ, CMS | AGPL-3.0 | Network-use trigger is fatal for a web-facing product |
| TCExam | Copyleft | — |

If the system is confirmed permanently internal and never distributed or hosted for third parties, this table becomes much shorter and Judge0 plus Moodle saves months. That decision should be made explicitly and written down, not assumed.

---

## 2. Question content licensing

Questions are copyrighted works. This is the part teams routinely get wrong.

### You may not scrape commercial platforms

LeetCode, HackerRank, GeeksforGeeks, InterviewBit and Codeforces problem statements are copyrighted. Scraping them into your bank is infringement regardless of whether you use them for internal hiring. The same applies to AWS, Azure and GCP certification question dumps, which are additionally a certification-agreement violation for whoever leaked them.

### Datasets you can legitimately use

| Dataset | License | Content | Attribution |
|---|---|---|---|
| HumanEval | MIT | 164 problems with signature, docstring, unit tests | Copyright notice |
| MBPP | CC-BY-4.0 | ~1000 beginner Python problems, 3 tests each | Credit required |
| CodeContests (DeepMind) | CC-BY-4.0 | Competitive problems, multi-language solutions | Credit required |
| LBPP (Cohere) | Apache-2.0 | 161 harder Python problems with unit tests | Notice file |
| Exercism | MIT | Exercises across 70+ languages | Copyright notice |
| Project Euler | Varies by problem | Check per problem; some restricted | Per-problem |

`questions.source_license` and `questions.external_ref` exist to make this auditable. Import without a license value should be rejected by the API.

### CC-BY obligations are real

CC-BY-4.0 requires attribution "in any reasonable manner". For a hiring platform that means: an attributions page in the recruiter console listing dataset sources, and the credit preserved in any export. It does *not* require showing attribution to candidates mid-exam.

CC-BY also permits commercial use and modification — so adapting an MBPP problem into your own variant is fine, with credit.

### The contamination problem

Every dataset above was built to benchmark language models, which means it is in the training data of every model a candidate might use. MBPP in particular has a measured contamination rate above 60% against public sources. Consequences:

- Imported content is fine for entry-level screening where you mainly want to filter non-programmers
- It is close to worthless against a candidate using an AI assistant
- Anything above junior level needs questions written in-house

Target: imported content should be the minority of your published bank by month 6. Track it — a `source_license = 'proprietary'` count is the metric.

### Your own questions

Questions authored by employees are works made for hire and belong to the company in most jurisdictions. Questions from contractors need an explicit IP assignment in the contract. Get this right before you pay someone to write 200 questions.

---

## 3. Regulatory compliance

This system makes or informs employment decisions. That places it in a regulated category in several jurisdictions. Verify current status with counsel — the landscape moved substantially through 2025–2026.

### EU AI Act

Systems used for recruitment, candidate filtering, and evaluation are classified as high-risk under Annex III. Obligations for high-risk systems include risk management, data governance, technical documentation, logging, human oversight, accuracy and robustness measures, and conformity assessment.

Design decisions that pre-position you well:
- ADR-007 (no automated rejection) and ADR-011 (no AI in the scoring path) keep you out of the most heavily regulated behaviours
- The audit log and immutable question versions satisfy a large part of the logging and traceability requirements
- `POST /attempts/{id}/void` and manual score override requiring a reason constitute documented human oversight

Whether a purely deterministic scoring system (weighted sum of test-case results) falls inside the AI Act's definition is a question for counsel. Build as if it does; the cost is low and the retrofit is not.

### NYC Local Law 144 and similar

New York City requires annual independent bias audits and candidate notice for automated employment decision tools. Similar rules exist or are emerging elsewhere. Relevant if you use automated ranking or scoring to substantially assist a decision.

`GET /reports/adverse-impact` exists for this. Four-fifths rule: if the selection rate for any group is below 80% of the highest group's rate, you have an adverse impact indicator that needs investigation and documentation.

### GDPR / data protection

**Lawful basis.** Legitimate interest for assessment data; explicit consent for any biometric capture. Consent must be freely given — a candidate who cannot proceed without agreeing to webcam recording has not freely consented. Offer a non-proctored alternative or an in-person option.

**Special category data.** Webcam images processed for identity or behaviour analysis are biometric data under Article 9. Higher bar, tighter retention, and a DPIA is effectively mandatory.

**Retention.** Set a default and enforce it in code, not policy documents. `candidates.erase_after` and `proctor_media.delete_after` exist for this. Working defaults:

| Data | Retention |
|---|---|
| Proctor media (webcam, screen) | 30 days |
| Session recordings / replays | 90 days |
| Attempt answers and scores | 24 months (or your jurisdiction's discrimination-claim limitation period) |
| Candidate PII, unsuccessful | 6–12 months |
| Audit log | 7 years |
| Anonymised aggregates | Indefinite |

**Data subject rights.** Access, rectification, and erasure must be operable. `DELETE /candidates/{id}` hard-deletes PII while retaining anonymised rows so psychometric statistics survive. Also relevant: Article 22 gives a right not to be subject to solely automated decisions with legal or similarly significant effects — another reason ADR-007 is non-negotiable.

**Transfers.** If candidates are in the EU and your infrastructure is not, you need a transfer mechanism. Self-hosting in-region is the simplest answer and a genuine argument for this build.

### Accessibility

WCAG 2.1 AA for the candidate experience, per the PRD. Beyond the ethics: an inaccessible assessment that excludes a disabled candidate is a discrimination exposure under the ADA, the Equality Act, and equivalents.

Practical minimum: keyboard-navigable throughout, screen-reader-tested question rendering, no colour-only information, adjustable text size, and per-candidate time extensions as a first-class recorded feature rather than an informal favour.

---

## 4. Ownership checklist

| Item | Owner | Cadence |
|---|---|---|
| CI license gate and SBOM | Engineering | Every build |
| Dependency license review | Engineering | Quarterly |
| Question source-license audit | Question bank owner | Quarterly |
| Attribution page accuracy | Question bank owner | On import |
| Retention job verification | Engineering | Monthly |
| Adverse impact review | People / Legal | Per hiring cycle |
| DPIA review | Legal / DPO | Annually, and on any proctoring change |
| Bias audit (if applicable) | External auditor | Annually |

# Merchant KYC Onboarding & Maker-Checker API

A small backend that onboards fictional merchants, verifies them through a mock KYC provider, and sends them through a maker-checker approval flow. Built for the Experia360 technical assessment.

**Stack:** Node.js, Express, TypeScript, PostgreSQL (plain `pg`), JWT, zod, bcryptjs, Jest + Supertest.

All data is synthetic. No real PAN, Aadhaar or customer data is used, and the KYC provider is a local mock. Nothing connects to a live service.

---

## 1. Setup (local PostgreSQL, no Docker)

I used a local PostgreSQL install. Docker was listed as optional, so I skipped it.

**Requirements:** Node 20+ and PostgreSQL 14+ (I developed on PostgreSQL 18).

**1. Create the user and two databases** (in psql or pgAdmin, one statement at a time):

```sql
CREATE USER kyc_user WITH PASSWORD 'choose_a_password';
CREATE DATABASE kyc_assessment OWNER kyc_user;
CREATE DATABASE kyc_assessment_test OWNER kyc_user;
```

**2. Install and configure**

```bash
npm install
cp .env.example .env
cp .env.example .env.test
```

Fill in both files. Generate every secret value with:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

| Variable | Purpose |
|---|---|
| `PORT` | Server port |
| `DATABASE_URL` | Postgres connection string. `.env.test` must point to `kyc_assessment_test` |
| `JWT_SECRET` | Signs login tokens |
| `PAN_ENC_KEY` | AES-256-GCM key, 32 bytes base64 |
| `PAN_HASH_KEY` | HMAC key for the PAN duplicate-check index. Must differ from `PAN_ENC_KEY` |
| `KYC_PROVIDER_API_KEY` | Credential the mock provider adapter requires |
| `KYC_CALLBACK_SECRET` | Shared secret for signing provider callbacks |
| `RECONCILE_INTERVAL_SECONDS` | Optional. How often the reconciliation worker runs (default 60) |

Use different values in `.env` and `.env.test`. Both files are git-ignored. Only `.env.example` is committed.

**3. Migrate, seed, run**

```bash
npm run migrate
npm run seed
npm run dev
```

Then open `http://localhost:3000/health`.

**4. Tests** (run migrations on the test database once first)

```bash
# Git Bash / Linux / macOS
NODE_ENV=test npm run migrate
# PowerShell
$env:NODE_ENV="test"; npm run migrate; Remove-Item Env:NODE_ENV

npm test
```

### Demo users (fictional)

The password for all of them is `Demo@1234`.

| Email | Role |
|---|---|
| merchant1@demo.test, merchant2@demo.test | MERCHANT |
| maker1@demo.test, maker2@demo.test | MAKER |
| checker1@demo.test | CHECKER |
| admin1@demo.test | ADMIN |

---

## 2. Architecture

The app is a layered Express service. Routes validate input (zod) and check roles, then call PostgreSQL directly through `pg`. There is no ORM, to keep the SQL visible.

- **Auth layer:** `authenticate` verifies the JWT, and `requireRole` enforces roles on each route. Ownership checks happen inside the route handlers.
- **Workflow layer:** `workflow.ts` holds the state machine and the audit writer. Every state change runs in one transaction with a row lock.
- **KYC layer:** a provider adapter (mock) sits behind `/api/kyc/verify`. Provider results come back through a separate, signed callback route.
- **Data layer:** PostgreSQL with migrations. Constraints (unique PAN hash, unique callback event id, status checks) are the last line of defence against duplicates and bad states.

```
src/
  config/env.ts            loads .env, fails fast if a variable is missing
  db/                      pool, transaction helper (withTx), migration runner
  middleware/              authenticate, requireRole, error handler
  modules/
    auth/                  login
    merchants/             routes, zod schemas, state machine + audit helper
    kyc/                   provider adapter, verify/status routes, signed callback, reconciliation worker
  utils/                   crypto (AES-GCM, HMAC), mask/redact, logger
  app.ts                   builds the Express app (used by tests)
  server.ts                starts listening
migrations/                001_init, 002_audit, 003_kyc, 004_callbacks
seeds/seed.ts              demo users
tests/                     Jest + Supertest
scripts/                   login.ps1 (PowerShell helper), setup.sh (cURL helper)
docs/                      examples.md (cURL walkthrough), openapi.ts (Swagger spec at /api-docs)
```

### Application states

```
DRAFT -> SUBMITTED -> VERIFYING -> REVIEW_REQUIRED -> APPROVED
                                                   -> REJECTED
                                                   -> DRAFT   (REQUEST_CHANGES)
```

The allowed moves live in one `transitions` map in `workflow.ts`. Anything else returns **409**.

### Request flow

1. A merchant (or a maker on their behalf) creates an application. It starts as `DRAFT`.
2. It is edited while `DRAFT` and then submitted (`SUBMITTED`).
3. A maker or admin calls `POST /api/kyc/verify`. The application moves to `VERIFYING` and the provider is called.
4. A definitive result (`VERIFIED` or `FAILED`) moves it to `REVIEW_REQUIRED`. A `PENDING` result keeps it in `VERIFYING` until the signed callback arrives.
5. A checker approves, rejects, or requests changes. The decision is audited.

---

## 3. API

Every route except login, the callback, health and `/api-docs` needs `Authorization: Bearer <token>`.

Interactive docs (Swagger UI) are available at `http://localhost:3000/api-docs` while the server is running. Log in through `POST /api/auth/login`, click **Authorize**, and paste the token (without the `Bearer ` prefix). The signed callback can't be sent from the browser because it needs a computed signature, so use [`docs/examples.md`](docs/examples.md) for that.

| Method | Path | Roles | What it does |
|---|---|---|---|
| POST | `/api/auth/login` | public | Returns a JWT (1 hour) |
| POST | `/api/merchants` | MERCHANT, MAKER | Creates an application. A maker must also send `ownerEmail` |
| GET | `/api/merchants/:id` | any logged-in user | Merchants see only their own. Staff see all |
| PATCH | `/api/merchants/:id` | MERCHANT (own), MAKER, ADMIN | Edits details, only while `DRAFT` |
| POST | `/api/merchants/:id/submit` | MERCHANT (own), MAKER, ADMIN | `DRAFT -> SUBMITTED` |
| POST | `/api/merchants/:id/review` | CHECKER, ADMIN | Body `{ "action": "APPROVE" \| "REJECT" \| "REQUEST_CHANGES", "reason": "..." }` |
| GET | `/api/merchants/:id/audit` | MAKER, CHECKER, ADMIN | Audit trail |
| POST | `/api/kyc/verify` | MAKER, ADMIN | Starts verification. Optional `Idempotency-Key` header |
| GET | `/api/kyc/status/:merchantId` | MAKER, CHECKER, ADMIN | Verification history with provider references |
| POST | `/api/kyc/callback` | signed (`X-Signature`) | Provider result callback |
| GET | `/health` | public | Checks the database connection |

Create body:

```json
{
  "businessName": "Demo Traders",
  "businessType": "SOLE_PROPRIETOR",
  "contactEmail": "shop@demo.test",
  "contactPhone": "9876543210",
  "pan": "ABCDE1234F"
}
```

`businessType` is one of `SOLE_PROPRIETOR`, `PARTNERSHIP`, `PRIVATE_LIMITED`. The PAN must match the format `AAAAA9999A`, using fictional values only.

Verify body: `{ "merchantId": 1, "identityRef": "ID-1000" }`

Callback body: `{ "eventId": "evt-1", "providerRef": "PRV-...", "outcome": "SUCCESS" | "FAILED" }`

Runnable examples are in [`docs/examples.md`](docs/examples.md) (cURL, run in Git Bash). `scripts/login.ps1` does the same login setup for PowerShell.

### How the mock provider behaves

The outcome depends on the last character of `identityRef`, so tests and demos are predictable:

| Ends in | Provider result | Stored KYC status | Application moves to |
|---|---|---|---|
| 0 | SUCCESS | VERIFIED | REVIEW_REQUIRED |
| 1 | FAILED | FAILED | REVIEW_REQUIRED |
| 2 | PENDING | PENDING | stays VERIFYING |
| 3 | TIMEOUT | UNKNOWN | REVIEW_REQUIRED |

If the adapter itself throws, I treat it as a timeout. A timeout or error is **never** stored as verified, and `APPROVE` is rejected with 409 unless `kyc_status` is `VERIFIED`. The provider reference is saved on every call.

---

## 4. Security design

### Encryption vs hashing

I used three different tools, each for one job:

- **AES-256-GCM (encryption)** protects the PAN in `merchants.pan_encrypted`. Encryption is reversible, and I chose it because the system might need the original PAN later. A fresh random IV is used every time, so the same PAN gives different ciphertext. GCM also adds an authentication tag, so tampering with the stored value makes decryption fail. The value is stored as `iv.tag.ciphertext` (base64).
- **HMAC-SHA256 (keyed hash)** produces `merchants.pan_hash`, which has a UNIQUE constraint. It is a one-way "blind index": the same PAN always gives the same hash, so I can detect duplicate applications without decrypting. I used a keyed HMAC rather than plain SHA-256 because a PAN has very little entropy (5 letters, 4 digits, 1 letter). A plain hash could be brute-forced after a database leak. With a secret key, an attacker with only the database cannot do that.
- **bcrypt (password hashing)** for login passwords. It is slow and salted on purpose.

The encryption key and the HMAC key are separate, so losing one does not expose the other.

### Key management

In this project the keys come from environment variables. They are never hard-coded or committed, and the app refuses to start if one is missing or if the encryption key is not 32 bytes. This is fine for a demo, not for production. In production I would:

- keep keys in a KMS or secret manager (AWS KMS, HashiCorp Vault) and use envelope encryption
- store a key version next to each ciphertext, so keys can be rotated and old rows re-encrypted gradually
- limit who and what can read the keys, and audit key access

Right now there is no key version in the stored value, so rotation would need a migration. I list that under limitations.

### Masking and redaction

- API responses only ever show a masked PAN (`XXXXX1234X`). `pan_encrypted` and `pan_hash` are never returned.
- Every log line goes through a `redact()` helper that replaces values of sensitive keys (pan, password, token, authorization, secret, identity) with `[REDACTED]`. I used a logger wrapper so nobody can log a PAN by accident.
- The error handler logs only the error message, never request bodies.

### Authentication and authorization

- Login returns a JWT with the user id, email and role, signed with `JWT_SECRET`, valid for 1 hour.
- The role always comes from the verified token. It is never read from the request body, so a client cannot promote itself. Request bodies are validated with zod, which acts as a whitelist (a client cannot inject `status` or `owner_id`).
- A merchant asking for another merchant's application gets **404**, not 403, so application ids cannot be probed.
- Login returns the same error for an unknown email and a wrong password.

### Maker-checker

- The creator, the last editor and the submitter of an application can never review it. The review route checks `created_by`, `last_modified_by` and `submitted_by` against the logged-in user and returns 403.
- Review routes are limited to CHECKER and ADMIN. I allowed ADMIN so that the self-approval block can be demonstrated, since an admin can also submit an application.
- `APPROVE` needs the application to be in `REVIEW_REQUIRED` with `kyc_status = VERIFIED`.

### Audit log

Every create, edit, submit, KYC step and review writes a row to `audit_events` (actor, action, from state, to state, reason, timestamp). For the transitions, the audit row is written **in the same transaction** as the state change, so one cannot exist without the other. A Postgres trigger makes the table append-only: `UPDATE` and `DELETE` fail with `audit_events is append-only`.

### Callback security

- The provider signs the raw request body with HMAC-SHA256 using `KYC_CALLBACK_SECRET` and sends it in `X-Signature`.
- I verify the signature against the raw bytes before doing anything else, with `crypto.timingSafeEqual`. A bad signature gets 401.
- The callback route is not behind JWT login (a provider has no user account). The signature is its authentication.

### Security assumptions

- The server runs behind HTTPS in any real deployment. This demo uses plain HTTP on localhost.
- Only fictional data is stored. The demo password and seed users are for local use only and must not exist in a real environment.
- Environment variables and the database are only reachable by trusted operators. Someone with both the database and the keys can read PANs.
- The mock provider and the callback secret stand in for a real provider contract. A real provider would also need IP allow-listing and a timestamp in the signed payload to prevent replays.
- JWTs are trusted until they expire (1 hour). There is no revocation list.

---

## 5. Idempotency, retries and concurrency

- **Verify requests:** the `Idempotency-Key` header is saved with the verification. Repeating the same key from the same user returns the stored result with `idempotentReplay: true` and does not call the provider again. A unique index on `(requested_by, idempotency_key)` backs this up.
- **One open verification per merchant:** a partial unique index allows only one `PENDING` or `UNKNOWN` verification at a time, and verify only works from `SUBMITTED`.
- **Duplicate callbacks:** `kyc_callbacks.event_id` is a primary key. The first callback is applied, and a repeat returns `duplicate: true` with no change. A callback for an already-resolved verification returns `ignored: true`. A late callback never changes an `APPROVED` or `REJECTED` application.
- **Concurrency:** state changes run in transactions with `SELECT ... FOR UPDATE` on the merchant row, so two simultaneous approvals run one after the other and the second gets a 409. Duplicate callbacks queue on a lock on the verification row.
- **Unique constraints** on the PAN hash catch duplicate applications at the database level, which is safe under concurrent requests (unlike check-then-insert).
- **Reconciliation worker:** every minute, `reconcileOnce()` looks for verifications that are still `PENDING` or `UNKNOWN` after 5 minutes and asks the provider for the status, then applies the result under the same row locks as the callback. A timeout on the status check changes nothing, so a timeout alone never marks KYC verified. It also moves applications stuck in `VERIFYING` with no saved result to `REVIEW_REQUIRED` with `kyc_status = UNKNOWN`, with an audit entry, so approval stays blocked.

---

## 6. Testing

```bash
npm test
```

Tests run against the separate `kyc_assessment_test` database and wipe it at the start. They run in band because they share that database. Result at the time of writing: **15 passed, 15 total**.

| Required scenario | Test |
|---|---|
| Cross-merchant access | `cross-merchant access` |
| Maker/checker separation | `maker/checker separation` |
| Timeout handling | `timeout handling` (timeout never verified, approve blocked, idempotent replay) |
| Duplicate callbacks | `duplicate callbacks` (applied once, bad signature rejected) |
| Invalid status transitions | `invalid status transitions` |
| Sensitive-data redaction | `sensitive data redaction` (masked response, ciphertext in DB, log redaction) |
| Extra | `audit log` (cannot be modified, CREATE event recorded) |
| Reconciliation | `reconciliation worker` (stale PENDING resolved, timeout never verifies, stuck VERIFYING moved to review) |

---

## 7. Design trade-offs and limitations

I would rather list these than hide them.

- **Auth is demo-level.** Tokens last 1 hour, with no refresh and no revocation, and the user is not re-checked in the database on each request. A deactivated user keeps access until the token expires.
- **Audit protection is a trigger.** It stops `UPDATE` and `DELETE` from the app, but a database superuser can drop the trigger or `TRUNCATE` the table. A real system would add hash chaining or ship events to external write-once storage. A hash chain over audit rows would make tampering detectable even by a superuser.
- **Key rotation is not built.** The ciphertext has no key version prefix. Keys are env variables instead of a KMS.
- **Reconciliation is basic.** The worker runs every 60 seconds (`RECONCILE_INTERVAL_SECONDS`) with a fixed 5-minute staleness threshold. There is no per-item backoff, and the provider status check is a mock that always answers `SUCCESS`.
- **Idempotency-key reuse** with a different body is not rejected. The stored result is returned.
- **Application creation** writes its audit row in a separate query, not in the same transaction as the insert.
- **After REQUEST_CHANGES** the application is `DRAFT` but still shows its old `kycStatus`. This is safe, because verification must run again before review and it resets the KYC status to `PENDING`.
- **No rate limiting** on login or the API.
- **The mock provider** decides outcomes from the identity reference. Retry/backoff against a real provider is not implemented.
- **Swagger spec is hand-written** in `docs/openapi.ts`, so it can drift from the code. With more time I would generate it from the zod schemas.

### Not built (optional items)

Docker Compose and a reviewer dashboard. I focused on the mandatory flows and testing, as the brief suggested.

---

## 8. Deliverables

- Source, migrations (`migrations/`) and seed data (`seeds/seed.ts`): this repository
- cURL examples: [`docs/examples.md`](docs/examples.md)
- Tests: `npm test`
- Walkthrough video: https://drive.google.com/file/d/1THadR6eUZ4AJj_9tRd02LSTpPtukPaWa/view?usp=sharing
- Postman collection: [`docs/postman/Merchant-KYC.postman_collection.json`](docs/postman/Merchant-KYC.postman_collection.json). Import it, set `callbackSecret` to your `KYC_CALLBACK_SECRET`, and run the folders in order.
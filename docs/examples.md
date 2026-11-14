# API examples (cURL)

All data is fictional. Demo password for every seeded user: `Demo@1234`.
Run these in a bash shell (Linux, macOS, or Git Bash on Windows) with the server running (`npm run dev`).

## 0. Setup

Run from the project root, with the server running:

```bash
source scripts/setup.sh
```

Tokens last 1 hour. Run this again if you get `Invalid or expired token`.

## 1. Authentication and authorization

```bash
# no token -> 401
curl -i $BASE/api/merchants/1

# wrong password -> 401
curl -i -X POST $BASE/api/auth/login -H 'Content-Type: application/json' \
  -d '{"email":"maker1@demo.test","password":"wrong"}'

# a Maker is not allowed to review -> 403
curl -i -X POST $BASE/api/merchants/1/review \
  -H "Authorization: Bearer $MAKER" -H 'Content-Type: application/json' \
  -d '{"action":"APPROVE"}'
```

## 2. Create a merchant application

The PAN is fictional and must be unique, so this generates a random one.

```bash
PAN="ABCDE$(printf '%04d' $((RANDOM % 10000)))F"

ID=$(curl -s -X POST $BASE/api/merchants \
  -H "Authorization: Bearer $MERCHANT" -H 'Content-Type: application/json' \
  -d "{\"businessName\":\"Demo Traders\",\"businessType\":\"SOLE_PROPRIETOR\",\"contactEmail\":\"shop@demo.test\",\"contactPhone\":\"9876543210\",\"pan\":\"$PAN\"}" | field id)
echo "merchant id: $ID"
```

Check the response is masked (`XXXXX1234X`, with no encrypted value or hash):

```bash
curl -s $BASE/api/merchants/$ID -H "Authorization: Bearer $MERCHANT"
```

Duplicate PAN -> 409, invalid PAN -> 400:

```bash
curl -i -X POST $BASE/api/merchants \
  -H "Authorization: Bearer $MERCHANT" -H 'Content-Type: application/json' \
  -d "{\"businessName\":\"Copy\",\"businessType\":\"SOLE_PROPRIETOR\",\"contactEmail\":\"x@demo.test\",\"contactPhone\":\"9876543210\",\"pan\":\"$PAN\"}"

curl -i -X POST $BASE/api/merchants \
  -H "Authorization: Bearer $MERCHANT" -H 'Content-Type: application/json' \
  -d '{"businessName":"Bad","businessType":"SOLE_PROPRIETOR","contactEmail":"x@demo.test","contactPhone":"9876543210","pan":"123"}'
```

## 3. Cross-merchant access -> 404

```bash
curl -i $BASE/api/merchants/$ID -H "Authorization: Bearer $MERCHANT2"
```

## 4. Edit and submit

```bash
curl -s -X PATCH $BASE/api/merchants/$ID \
  -H "Authorization: Bearer $MERCHANT" -H 'Content-Type: application/json' \
  -d '{"businessName":"Demo Traders Pvt"}'

curl -s -X POST $BASE/api/merchants/$ID/submit -H "Authorization: Bearer $MERCHANT"

# submitting again -> 409 invalid transition
curl -i -X POST $BASE/api/merchants/$ID/submit -H "Authorization: Bearer $MERCHANT"
```

## 5. KYC verification

The mock provider decides the outcome from the last digit of `identityRef`:

| identityRef ends in | Provider result | KYC status |
|---|---|---|
| 0 | SUCCESS | VERIFIED |
| 1 | FAILED | FAILED |
| 2 | PENDING | PENDING |
| 3 | TIMEOUT | UNKNOWN |

### 5a. Success, with idempotency

```bash
IDEM="demo-key-$RANDOM"

curl -s -X POST $BASE/api/kyc/verify \
  -H "Authorization: Bearer $MAKER" -H 'Content-Type: application/json' \
  -H "Idempotency-Key: $IDEM" \
  -d "{\"merchantId\":$ID,\"identityRef\":\"ID-1000\"}"

# same request again: same providerRef, "idempotentReplay": true
curl -s -X POST $BASE/api/kyc/verify \
  -H "Authorization: Bearer $MAKER" -H 'Content-Type: application/json' \
  -H "Idempotency-Key: $IDEM" \
  -d "{\"merchantId\":$ID,\"identityRef\":\"ID-1000\"}"

curl -s $BASE/api/kyc/status/$ID -H "Authorization: Bearer $CHECKER"
```

### 5b. Timeout never counts as verified

Create and submit a second application, then verify it with `ID-1003`:

```bash
PAN2="ABCDE$(printf '%04d' $((RANDOM % 10000)))G"
ID2=$(curl -s -X POST $BASE/api/merchants \
  -H "Authorization: Bearer $MERCHANT" -H 'Content-Type: application/json' \
  -d "{\"businessName\":\"Timeout Shop\",\"businessType\":\"PARTNERSHIP\",\"contactEmail\":\"t@demo.test\",\"contactPhone\":\"9876543211\",\"pan\":\"$PAN2\"}" | field id)
curl -s -X POST $BASE/api/merchants/$ID2/submit -H "Authorization: Bearer $MERCHANT" > /dev/null

curl -s -X POST $BASE/api/kyc/verify \
  -H "Authorization: Bearer $MAKER" -H 'Content-Type: application/json' \
  -d "{\"merchantId\":$ID2,\"identityRef\":\"ID-1003\"}"
# status is UNKNOWN and the providerRef is saved

# approving is blocked -> 409 "Cannot approve: KYC is not verified"
curl -i -X POST $BASE/api/merchants/$ID2/review \
  -H "Authorization: Bearer $CHECKER" -H 'Content-Type: application/json' \
  -d '{"action":"APPROVE"}'
```

## 6. Signed provider callback (resolves a PENDING verification)

Create a third application, verify it with `ID-1002` (PENDING), and keep its `providerRef`:

```bash
PAN3="ABCDE$(printf '%04d' $((RANDOM % 10000)))H"
ID3=$(curl -s -X POST $BASE/api/merchants \
  -H "Authorization: Bearer $MERCHANT" -H 'Content-Type: application/json' \
  -d "{\"businessName\":\"Pending Shop\",\"businessType\":\"PRIVATE_LIMITED\",\"contactEmail\":\"p@demo.test\",\"contactPhone\":\"9876543212\",\"pan\":\"$PAN3\"}" | field id)
curl -s -X POST $BASE/api/merchants/$ID3/submit -H "Authorization: Bearer $MERCHANT" > /dev/null

REF=$(curl -s -X POST $BASE/api/kyc/verify \
  -H "Authorization: Bearer $MAKER" -H 'Content-Type: application/json' \
  -d "{\"merchantId\":$ID3,\"identityRef\":\"ID-1002\"}" | field providerRef)
echo "providerRef: $REF"
```

The provider signs the exact request body with HMAC-SHA256:

```bash
BODY="{\"eventId\":\"evt-$RANDOM\",\"providerRef\":\"$REF\",\"outcome\":\"SUCCESS\"}"
SIG=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$KYC_CALLBACK_SECRET" | awk '{print $NF}')

# valid callback -> {"received":true,"applied":true}
curl -s -X POST $BASE/api/kyc/callback \
  -H 'Content-Type: application/json' -H "X-Signature: $SIG" -d "$BODY"

# exact same callback again -> {"received":true,"duplicate":true}, no change
curl -s -X POST $BASE/api/kyc/callback \
  -H 'Content-Type: application/json' -H "X-Signature: $SIG" -d "$BODY"

# bad signature -> 401
curl -i -X POST $BASE/api/kyc/callback \
  -H 'Content-Type: application/json' -H 'X-Signature: deadbeef' -d "$BODY"
```

## 7. Maker-checker review

```bash
# the checker approves application $ID (KYC is VERIFIED)
curl -s -X POST $BASE/api/merchants/$ID/review \
  -H "Authorization: Bearer $CHECKER" -H 'Content-Type: application/json' \
  -d '{"action":"APPROVE"}'

# reviewing again -> 409 invalid transition
curl -i -X POST $BASE/api/merchants/$ID/review \
  -H "Authorization: Bearer $CHECKER" -H 'Content-Type: application/json' \
  -d '{"action":"REJECT","reason":"too late"}'


# REJECT without a reason -> 400; REQUEST_CHANGES with a reason works and returns it to DRAFT
curl -i -X POST $BASE/api/merchants/$ID3/review \
  -H "Authorization: Bearer $CHECKER" -H 'Content-Type: application/json' \
  -d '{"action":"REJECT"}'
curl -s -X POST $BASE/api/merchants/$ID3/review \
  -H "Authorization: Bearer $CHECKER" -H 'Content-Type: application/json' \
  -d '{"action":"REQUEST_CHANGES","reason":"Business name unclear"}'
```

### Self-approval is blocked

The admin submits an application, so the admin cannot review it:

```bash
PAN4="ABCDE$(printf '%04d' $((RANDOM % 10000)))J"
ID4=$(curl -s -X POST $BASE/api/merchants \
  -H "Authorization: Bearer $MERCHANT2" -H 'Content-Type: application/json' \
  -d "{\"businessName\":\"Admin Submitted\",\"businessType\":\"SOLE_PROPRIETOR\",\"contactEmail\":\"a@demo.test\",\"contactPhone\":\"9876543213\",\"pan\":\"$PAN4\"}" | field id)
curl -s -X POST $BASE/api/merchants/$ID4/submit -H "Authorization: Bearer $ADMIN" > /dev/null
curl -s -X POST $BASE/api/kyc/verify -H "Authorization: Bearer $MAKER" \
  -H 'Content-Type: application/json' -d "{\"merchantId\":$ID4,\"identityRef\":\"ID-1000\"}" > /dev/null

# 403 "You worked on this application, so you cannot review it"
curl -i -X POST $BASE/api/merchants/$ID4/review \
  -H "Authorization: Bearer $ADMIN" -H 'Content-Type: application/json' \
  -d '{"action":"APPROVE"}'
```

## 8. Audit trail

```bash
curl -s $BASE/api/merchants/$ID/audit -H "Authorization: Bearer $CHECKER"
```

Each entry has actor, action, `from_status`, `to_status`, reason and timestamp. The table is append-only: in psql or pgAdmin, `UPDATE audit_events SET reason = 'x';` fails with `audit_events is append-only`.

## 9. Health

```bash
curl -s $BASE/health
```
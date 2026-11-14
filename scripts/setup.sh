# Setup for the cURL examples. Usage (in Git Bash, from the project root):
#   source scripts/setup.sh

BASE=http://localhost:3000

# read one field from a JSON response on stdin, e.g.  ... | field token
field() {
  grep -o "\"$1\":\"\?[^,\"}]*" | head -1 | sed 's/.*:"\?//'
}

login() {
  curl -s -X POST $BASE/api/auth/login \
    -H 'Content-Type: application/json' \
    -d "{\"email\":\"$1\",\"password\":\"Demo@1234\"}" | field token
}

MERCHANT=$(login merchant1@demo.test)
MERCHANT2=$(login merchant2@demo.test)
MAKER=$(login maker1@demo.test)
CHECKER=$(login checker1@demo.test)
ADMIN=$(login admin1@demo.test)

# the callback secret is read from .env, never typed or committed
KYC_CALLBACK_SECRET=$(grep '^KYC_CALLBACK_SECRET=' .env | cut -d= -f2-)

echo "token lengths: ${#MAKER} ${#CHECKER}   secret length: ${#KYC_CALLBACK_SECRET}"
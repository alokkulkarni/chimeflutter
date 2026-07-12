#!/usr/bin/env bash
#
# setup-cognito.sh — provision an Amazon Cognito user pool + app client that produce the JWT values
# the ChimeFlutter backend needs (docs/DEPLOYMENT.md):
#
#     JwtIssuer   = https://cognito-idp.<region>.amazonaws.com/<userPoolId>
#     JwtAudience = <appClientId>
#     JwtJwksUri  = <issuer>/.well-known/jwks.json
#
# IMPORTANT: the backend authorizer validates the `aud` claim. For Cognito, `aud` is present only on
# the **ID token** (access tokens carry `client_id` and have no `aud`). So the mobile app — and the
# `token` command below — must use the **ID token** as the bearer token.
#
# Usage:
#   scripts/setup-cognito.sh create   [--region eu-west-2] [--name chimeflutter] [--with-test-user]
#   scripts/setup-cognito.sh token    [--region eu-west-2] [--name chimeflutter] [--decode]
#   scripts/setup-cognito.sh outputs  [--region eu-west-2] [--name chimeflutter]
#   scripts/setup-cognito.sh delete   [--region eu-west-2] [--name chimeflutter]
#
# Re-running `create` is safe: an existing pool/client with the same name is reused.
#
set -euo pipefail

# ---- defaults ---------------------------------------------------------------
REGION="${AWS_REGION:-eu-west-2}"      # matches the Connect instance region by default
NAME="chimeflutter"                     # base name for pool + client
TEST_USER="test@chimeflutter.example"
TEST_PASSWORD=""
WITH_TEST_USER=0
DECODE=0
OUT_FILE=""                             # defaults to backend/.env.cognito on `create`

# ---- pretty output ----------------------------------------------------------
if [ -t 1 ]; then C_G=$'\033[32m'; C_Y=$'\033[33m'; C_R=$'\033[31m'; C_B=$'\033[1m'; C_0=$'\033[0m'
else C_G=""; C_Y=""; C_R=""; C_B=""; C_0=""; fi
# All decorative output goes to STDERR so that `$(...)` command substitutions of functions like
# ensure_pool/ensure_client capture ONLY the value they `echo` to stdout (not the progress lines).
info() { printf '%s\n' "${C_G}▶${C_0} $*" >&2; }
warn() { printf '%s\n' "${C_Y}!${C_0} $*" >&2; }
die()  { printf '%s\n' "${C_R}✖ $*${C_0}" >&2; exit 1; }

usage() { sed -n '2,32p' "$0" | sed 's/^# \{0,1\}//'; exit "${1:-0}"; }

# ---- arg parsing ------------------------------------------------------------
[ $# -ge 1 ] || usage 1
CMD="$1"; shift || true
while [ $# -gt 0 ]; do
  case "$1" in
    --region) REGION="$2"; shift 2 ;;
    --name) NAME="$2"; shift 2 ;;
    --test-user) TEST_USER="$2"; shift 2 ;;
    --test-password) TEST_PASSWORD="$2"; shift 2 ;;
    --with-test-user) WITH_TEST_USER=1; shift ;;
    --decode) DECODE=1; shift ;;
    --out) OUT_FILE="$2"; shift 2 ;;
    -h|--help) usage 0 ;;
    *) die "unknown option: $1 (see --help)" ;;
  esac
done

POOL_NAME="${NAME}-user-pool"
CLIENT_NAME="${NAME}-mobile"

# ---- prerequisites ----------------------------------------------------------
command -v aws >/dev/null 2>&1 || die "aws CLI not found — install it first."
aws sts get-caller-identity >/dev/null 2>&1 || die "AWS credentials not configured/valid (try: aws configure)."

aws_idp() { aws cognito-idp "$@" --region "$REGION"; }

# ---- lookups ----------------------------------------------------------------
find_pool_id() {
  aws_idp list-user-pools --max-results 60 \
    --query "UserPools[?Name=='${POOL_NAME}'].Id | [0]" --output text 2>/dev/null | grep -v '^None$' || true
}

find_client_id() {
  local pool_id="$1"
  aws_idp list-user-pool-clients --user-pool-id "$pool_id" --max-results 60 \
    --query "UserPoolClients[?ClientName=='${CLIENT_NAME}'].ClientId | [0]" --output text 2>/dev/null | grep -v '^None$' || true
}

issuer_url() { echo "https://cognito-idp.${REGION}.amazonaws.com/$1"; }

# ---- create -----------------------------------------------------------------
ensure_pool() {
  local pool_id; pool_id="$(find_pool_id)"
  if [ -n "$pool_id" ]; then
    warn "reusing existing user pool '${POOL_NAME}' ($pool_id)"
  else
    info "creating user pool '${POOL_NAME}' in ${REGION}…"
    pool_id="$(aws_idp create-user-pool \
      --pool-name "$POOL_NAME" \
      --username-attributes email \
      --auto-verified-attributes email \
      --policies '{"PasswordPolicy":{"MinimumLength":8,"RequireUppercase":true,"RequireLowercase":true,"RequireNumbers":true,"RequireSymbols":true}}' \
      --mfa-configuration OFF \
      --query 'UserPool.Id' --output text)"
    info "  → $pool_id"
  fi
  echo "$pool_id"
}

ensure_client() {
  local pool_id="$1"
  local client_id; client_id="$(find_client_id "$pool_id")"
  if [ -n "$client_id" ]; then
    warn "reusing existing app client '${CLIENT_NAME}' ($client_id)"
  else
    info "creating public mobile app client '${CLIENT_NAME}'…"
    # Public client (no secret) suitable for a mobile app; USER_PASSWORD_AUTH enables the smoke-test
    # `token` command, USER_SRP_AUTH is the flow a real app SDK uses.
    client_id="$(aws_idp create-user-pool-client \
      --user-pool-id "$pool_id" \
      --client-name "$CLIENT_NAME" \
      --no-generate-secret \
      --explicit-auth-flows ALLOW_USER_PASSWORD_AUTH ALLOW_USER_SRP_AUTH ALLOW_REFRESH_TOKEN_AUTH \
      --id-token-validity 60 --access-token-validity 60 --refresh-token-validity 30 \
      --token-validity-units '{"IdToken":"minutes","AccessToken":"minutes","RefreshToken":"days"}' \
      --prevent-user-existence-errors ENABLED \
      --query 'UserPoolClient.ClientId' --output text)"
    info "  → $client_id"
  fi
  echo "$client_id"
}

gen_password() {
  # Policy-compliant: upper + lower + number + symbol.
  echo "Cf$(openssl rand -hex 8 2>/dev/null || date +%s%N)Aa1!"
}

ensure_test_user() {
  local pool_id="$1"
  [ -z "$TEST_PASSWORD" ] && TEST_PASSWORD="$(gen_password)"
  if aws_idp admin-get-user --user-pool-id "$pool_id" --username "$TEST_USER" >/dev/null 2>&1; then
    warn "test user '${TEST_USER}' already exists — resetting password"
  else
    info "creating test user '${TEST_USER}'…"
    aws_idp admin-create-user --user-pool-id "$pool_id" --username "$TEST_USER" \
      --message-action SUPPRESS --user-attributes Name=email,Value="$TEST_USER" Name=email_verified,Value=true >/dev/null
  fi
  aws_idp admin-set-user-password --user-pool-id "$pool_id" --username "$TEST_USER" \
    --password "$TEST_PASSWORD" --permanent >/dev/null
  info "  → username: ${TEST_USER}"
  info "  → password: ${TEST_PASSWORD}"
}

write_outputs() {
  local issuer="$1" audience="$2" jwks="$3" pool_id="$4"
  [ -z "$OUT_FILE" ] && OUT_FILE="$(dirname "$0")/../backend/.env.cognito"
  cat > "$OUT_FILE" <<EOF
# Generated by scripts/setup-cognito.sh. Gitignored (.env.*).
# BACKEND (sam deploy parameters):
JWT_ISSUER=$issuer
JWT_AUDIENCE=$audience
JWT_JWKS_URI=$jwks
# APP (Flutter --dart-define values, for real Cognito sign-in):
COGNITO_USER_POOL_ID=$pool_id
COGNITO_APP_CLIENT_ID=$audience
COGNITO_REGION=$REGION
EOF
  info "wrote $OUT_FILE"
}

print_deploy_snippet() {
  local issuer="$1" audience="$2" jwks="$3"
  cat <<EOF

${C_B}Next — deploy the backend with these values:${C_0}

  cd backend
  export PATH="\$PWD/node_modules/.bin:\$PATH"
  sam build
  sam deploy --guided \\
    --stack-name chimeflutter-backend \\
    --capabilities CAPABILITY_IAM \\
    --parameter-overrides \\
      ConnectInstanceId=<your-connect-instance-id> \\
      ConnectContactFlowId=<your-published-flow-id> \\
      JwtIssuer=$issuer \\
      JwtAudience=$audience \\
      JwtJwksUri=$jwks
EOF
}

# ---- token (smoke test) -----------------------------------------------------
get_id_token() {
  local pool_id="$1" client_id="$2"
  [ -n "$TEST_PASSWORD" ] || die "provide --test-password (the one printed by 'create --with-test-user')."
  aws_idp initiate-auth \
    --auth-flow USER_PASSWORD_AUTH \
    --client-id "$client_id" \
    --auth-parameters "USERNAME=${TEST_USER},PASSWORD=${TEST_PASSWORD}" \
    --query 'AuthenticationResult.IdToken' --output text
}

decode_jwt() {
  # Decode the JWT payload (base64url) without verifying — for inspection only.
  local token="$1" payload
  payload="$(echo "$token" | cut -d. -f2)"
  python3 - "$payload" <<'PY'
import base64, json, sys
p = sys.argv[1]
p += "=" * (-len(p) % 4)
claims = json.loads(base64.urlsafe_b64decode(p))
keep = {k: claims[k] for k in ("iss","aud","sub","token_use","exp","email") if k in claims}
print(json.dumps(keep, indent=2))
PY
}

# ---- commands ---------------------------------------------------------------
cmd_create() {
  local pool_id client_id issuer jwks
  pool_id="$(ensure_pool)"
  client_id="$(ensure_client "$pool_id")"
  [ "$WITH_TEST_USER" -eq 1 ] && ensure_test_user "$pool_id"
  issuer="$(issuer_url "$pool_id")"
  jwks="${issuer}/.well-known/jwks.json"

  echo
  info "${C_B}Cognito configured.${C_0} Backend parameters:"
  echo "  JwtIssuer   = $issuer"
  echo "  JwtAudience = $client_id"
  echo "  JwtJwksUri  = $jwks"
  write_outputs "$issuer" "$client_id" "$jwks" "$pool_id"
  print_deploy_snippet "$issuer" "$client_id" "$jwks"
  if [ "$WITH_TEST_USER" -eq 1 ]; then
    echo
    info "Smoke-test a token with:"
    echo "  scripts/setup-cognito.sh token --name '${NAME}' --test-user '${TEST_USER}' --test-password '${TEST_PASSWORD}' --decode"
  fi
}

cmd_token() {
  local pool_id client_id token
  pool_id="$(find_pool_id)"; [ -n "$pool_id" ] || die "pool '${POOL_NAME}' not found — run 'create' first."
  client_id="$(find_client_id "$pool_id")"; [ -n "$client_id" ] || die "client '${CLIENT_NAME}' not found."
  token="$(get_id_token "$pool_id" "$client_id")"
  [ -n "$token" ] && [ "$token" != "None" ] || die "failed to obtain an ID token (check the password)."
  if [ "$DECODE" -eq 1 ]; then
    warn "decoded ID-token claims (note aud == client id, token_use == id):" && decode_jwt "$token" >&2
    echo >&2
  fi
  # The raw token goes to stdout so it can be captured:  JWT=$(scripts/setup-cognito.sh token ...)
  echo "$token"
}

cmd_outputs() {
  local pool_id client_id issuer
  pool_id="$(find_pool_id)"; [ -n "$pool_id" ] || die "pool '${POOL_NAME}' not found."
  client_id="$(find_client_id "$pool_id")"
  issuer="$(issuer_url "$pool_id")"
  echo "JwtIssuer   = $issuer"
  echo "JwtAudience = $client_id"
  echo "JwtJwksUri  = ${issuer}/.well-known/jwks.json"
}

cmd_delete() {
  local pool_id; pool_id="$(find_pool_id)"
  [ -n "$pool_id" ] || { warn "pool '${POOL_NAME}' not found — nothing to delete."; return 0; }
  printf '%s' "Delete user pool '${POOL_NAME}' ($pool_id) and ALL its users? [y/N] "
  read -r ans; [ "$ans" = "y" ] || [ "$ans" = "Y" ] || { info "aborted."; return 0; }
  aws_idp delete-user-pool --user-pool-id "$pool_id"
  info "deleted $pool_id"
}

case "$CMD" in
  create) cmd_create ;;
  token) cmd_token ;;
  outputs) cmd_outputs ;;
  delete) cmd_delete ;;
  -h|--help|help) usage 0 ;;
  *) die "unknown command: $CMD (see --help)" ;;
esac

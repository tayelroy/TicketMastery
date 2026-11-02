#!/usr/bin/env bash
# Cognito test users for AUTH=cognito runs.
#
#   scripts/cognito-users.sh create <fans>   # organiser (group organisers) + fans lt001..ltNNN, confirmed, permanent password
#   scripts/cognito-users.sh tokens          # access tokens (valid 60 min) -> state/tokens.json; rerun before each test
#   scripts/cognito-users.sh cleanup         # deletes every success+lt*@simulator.amazonses.com user, local state too
#
# Emails are SES mailbox-simulator addresses (success+lt001@simulator.amazonses.com): accepted in the SES sandbox, so
# ticket-fn's e-ticket emails succeed without a real inbox. Users are created with --message-action SUPPRESS (no
# Cognito email). The password is random per machine (state/lt-password). DRY_RUN=1 prints the changing calls.
# Needs ALLOW_ADMIN_USER_PASSWORD_AUTH on the app client (infra/modules/auth-apigw/cognito.tf has it).
source "$(dirname "$0")/lib.sh"
require_aws

PARALLEL="${PARALLEL:-5}" # Cognito admin APIs are rate-limited per account (UserCreation ~50 rps)
EMAIL_PREFIX="success+lt"
EMAIL_DOMAIN="simulator.amazonses.com"
USERS_FILE="$STATE_DIR/users.json"
TOKENS_FILE="$STATE_DIR/tokens.json"
PASSWORD_FILE="$STATE_DIR/lt-password"

POOL_ID="${USER_POOL_ID:-$(aws cognito-idp list-user-pools --max-results 60 --query "UserPools[?Name=='$USER_POOL_NAME'].Id | [0]" --output text)}"
[[ "$POOL_ID" != "None" && -n "$POOL_ID" ]] || die "user pool $USER_POOL_NAME not found"
CLIENT_ID="${USER_POOL_CLIENT_ID:-$(aws cognito-idp list-user-pool-clients --user-pool-id "$POOL_ID" --max-results 60 \
  --query "UserPoolClients[?ClientName=='$USER_POOL_CLIENT_NAME'].ClientId | [0]" --output text)}"
export POOL_ID CLIENT_ID DRY_RUN

password() {
  if [[ ! -s "$PASSWORD_FILE" ]]; then
    (umask 077; printf 'Lt%sA9' "$(openssl rand -hex 10)" > "$PASSWORD_FILE") # upper, lower, digits, >= 10 chars
  fi
  cat "$PASSWORD_FILE"
}

# $1 = email, $2 = organiser|fan
create_one() {
  local email="$1" role="$2" out
  if [[ "$DRY_RUN" == 1 ]]; then
    echo "DRY_RUN would run: aws cognito-idp admin-create-user --user-pool-id $POOL_ID --username $email --user-attributes Name=email,Value=$email Name=email_verified,Value=true --message-action SUPPRESS" >&2
    echo "DRY_RUN would run: aws cognito-idp admin-set-user-password --user-pool-id $POOL_ID --username $email --password **** --permanent" >&2
    [[ "$role" == organiser ]] && echo "DRY_RUN would run: aws cognito-idp admin-add-user-to-group --user-pool-id $POOL_ID --username $email --group-name organisers" >&2
    return 0
  fi
  if ! out="$(aws cognito-idp admin-create-user --user-pool-id "$POOL_ID" --username "$email" \
      --user-attributes Name=email,Value="$email" Name=email_verified,Value=true \
      --message-action SUPPRESS --output text 2>&1)"; then
    [[ "$out" == *UsernameExistsException* ]] || { echo "$email: $out" >&2; return 1; }
  fi
  aws cognito-idp admin-set-user-password --user-pool-id "$POOL_ID" --username "$email" --password "$LT_PASSWORD" --permanent
  if [[ "$role" == organiser ]]; then
    aws cognito-idp admin-add-user-to-group --user-pool-id "$POOL_ID" --username "$email" --group-name organisers
  fi
  echo "created $email ($role)" >&2
}

# $1 = email -> {"email","sub","accessToken"} on stdout
token_one() {
  local email="$1" tok
  if [[ "$DRY_RUN" == 1 ]]; then
    echo "DRY_RUN would run: aws cognito-idp admin-initiate-auth --user-pool-id $POOL_ID --client-id $CLIENT_ID --auth-flow ADMIN_USER_PASSWORD_AUTH --auth-parameters USERNAME=$email,PASSWORD=****" >&2
    jq -cn --arg e "$email" '{email: $e, sub: null, accessToken: "dry-run"}'
    return 0
  fi
  tok="$(aws cognito-idp admin-initiate-auth --user-pool-id "$POOL_ID" --client-id "$CLIENT_ID" \
    --auth-flow ADMIN_USER_PASSWORD_AUTH --auth-parameters "USERNAME=$email,PASSWORD=$LT_PASSWORD" \
    --query 'AuthenticationResult.AccessToken' --output text)" || { echo "$email: sign-in failed" >&2; return 1; }
  jq -cn --arg e "$email" --arg t "$tok" '{email: $e, accessToken: $t,
    sub: ($t | split(".")[1] | gsub("-"; "+") | gsub("_"; "/") | . + ("=" * ((4 - length % 4) % 4)) | @base64d | fromjson | .sub)}'
}
export -f create_one token_one

case "${1:-}" in
  create)
    N="${2:?usage: cognito-users.sh create <number of fans>}"
    [[ "$N" =~ ^[0-9]+$ && "$N" -ge 1 && "$N" -le 999 ]] || die "fans must be 1-999"
    LT_PASSWORD="$(password)"; export LT_PASSWORD
    {
      echo "$EMAIL_PREFIX-organiser@$EMAIL_DOMAIN organiser"
      for i in $(seq 1 "$N"); do printf '%s%03d@%s fan\n' "$EMAIL_PREFIX" "$i" "$EMAIL_DOMAIN"; done
    } > "$STATE_DIR/users.txt"
    xargs -P "$PARALLEL" -L 1 bash -c 'create_one "$0" "$1"' < "$STATE_DIR/users.txt"
    jq -R -s '[split("\n")[] | select(length > 0) | split(" ") | {email: .[0], role: .[1]}]' "$STATE_DIR/users.txt" > "$USERS_FILE"
    rm -f "$STATE_DIR/users.txt"
    log "users in $USERS_FILE ($N fans + organiser, pool $POOL_ID)"
    ;;
  tokens)
    [[ -s "$USERS_FILE" ]] || die "no $USERS_FILE: run create first"
    LT_PASSWORD="$(password)"; export LT_PASSWORD
    TMP="$(mktemp)"; trap 'rm -f "$TMP"' EXIT
    jq -r '.[].email' "$USERS_FILE" | xargs -P "$PARALLEL" -I{} bash -c 'token_one "$0"' {} > "$TMP"
    jq -s --arg pool "$POOL_ID" --arg client "$CLIENT_ID" --arg now "$(iso_now)" --slurpfile users "$USERS_FILE" '
      (map({key: .email, value: .}) | from_entries) as $tok
      | {createdAt: $now, userPoolId: $pool, clientId: $client,
         organiser: ($users[0][] | select(.role == "organiser") | $tok[.email]),
         fans: [$users[0][] | select(.role == "fan") | $tok[.email]]}
      | if (.fans | map(select(. == null)) | length) > 0 then error("some fans got no token") else . end' "$TMP" > "$TOKENS_FILE.new"
    (umask 077; mv "$TOKENS_FILE.new" "$TOKENS_FILE")
    log "$(jq '.fans | length' "$TOKENS_FILE") fan tokens + organiser in $TOKENS_FILE (valid 60 min)"
    ;;
  cleanup)
    EMAILS="$(aws cognito-idp list-users --user-pool-id "$POOL_ID" --filter "email ^= \"$EMAIL_PREFIX\"" \
      --query 'Users[].Attributes[?Name==`email`].Value[]' --output text | tr '\t' '\n' | grep "@$EMAIL_DOMAIN\$" || true)"
    COUNT="$(printf '%s' "$EMAILS" | grep -c . || true)"
    log "deleting $COUNT load-test users from $POOL_ID"
    if [[ "$COUNT" -gt 0 ]]; then
      printf '%s\n' "$EMAILS" | xargs -P "$PARALLEL" -I{} bash -c \
        'if [[ "$DRY_RUN" == 1 ]]; then echo "DRY_RUN would run: aws cognito-idp admin-delete-user --user-pool-id $POOL_ID --username $0" >&2; else aws cognito-idp admin-delete-user --user-pool-id "$POOL_ID" --username "$0" && echo "deleted $0" >&2; fi' {}
    fi
    [[ "$DRY_RUN" == 1 ]] || rm -f "$USERS_FILE" "$TOKENS_FILE" "$PASSWORD_FILE"
    ;;
  *)
    die "usage: cognito-users.sh create <fans> | tokens | cleanup"
    ;;
esac

#!/usr/bin/env bash
# Cancels the organiser's load-test concerts ("Load test ...", "Waiting-room order ..." and "Flash sale ...") so they leave the public
# listing. Run before scripts/cognito-users.sh cleanup (it signs in as the load-test organiser).
#
#   AUTH=cognito scripts/cancel-loadtest-concerts.sh            # BASE_URL defaults to the API Gateway URL
#   AUTH=dev BASE_URL=http://localhost:3000 scripts/cancel-loadtest-concerts.sh
source "$(dirname "$0")/lib.sh"

AUTH="${AUTH:-cognito}"
if [[ "$AUTH" == cognito ]]; then
  require_aws
  BASE_URL="$(api_url)"
  TOKEN="$(jq -r '.organiser.accessToken' "$STATE_DIR/tokens.json")" || die "no state/tokens.json: run cognito-users.sh tokens"
  H=(-H "Authorization: Bearer $TOKEN")
else
  [[ -n "${BASE_URL:-}" ]] || die "AUTH=dev needs BASE_URL"
  H=(-H 'x-dev-user-id: lt-organiser' -H 'x-dev-user-groups: organisers')
fi
API="${BASE_URL%/}/api/organiser/concerts"

IDS="$(curl -sf "${H[@]}" "$API" | jq -r '(if type == "array" then . else .concerts end)[]
  | select((.title | test("^(Load test|Waiting-room order|Flash sale) ")) and .status != "cancelled" and .status != "completed") | .id')" \
  || die "could not list the organiser's concerts"
[[ -n "$IDS" ]] || { log "no load-test concerts to cancel"; exit 0; }
for id in $IDS; do
  code="$(curl -s -o /dev/null -w '%{http_code}' "${H[@]}" -H 'content-type: application/json' -X POST "$API/$id/cancel" \
    -d '{"reason": "Load test finished"}')"
  log "cancel $id -> HTTP $code"
done

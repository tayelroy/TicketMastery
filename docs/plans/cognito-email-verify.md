# Cognito: verify a new email before it replaces the sign-in name

**Owner:** Elroy · **Module owner / reviewer:** Andrew (`infra/modules/auth-apigw/`) · **Target:** done today, 2026-10-31
**Branch:** `infra/cognito-email-verify-before-update`

## Goal

By the end of today, the dev user pool in account 000246635159:

1. lets the browser (`spa` client) read only `email`, `email_verified` and `name`, and write only `email` and `name`;
2. keeps a changed email **pending** until the user enters the code sent to the new address, so the old, verified
   email stays the sign-in name until then;
3. still lets fans sign up (sign-up sends `email` as an attribute), and lets UC2's profile card (PR #19) read and save
   `name`.

Done means the change is merged to `main`, applied to dev, and the smoke test below passes.

## Why

The `spa` client had no `read_attributes` / `write_attributes`, so any signed-in user could call
`UpdateUserAttributes` with their own access token and change any writable attribute. Without
`user_attribute_update_settings`, an email change takes effect at once, so the sign-in name moves to an unverified
address. PR #19's profile card makes the email read-only in the UI, but the API call is open to anyone holding a
token.

## Plan

| # | Step | Who | Status |
|---|---|---|---|
| 1 | Change `infra/modules/auth-apigw/cognito.tf`: `user_attribute_update_settings` on the pool, `read_attributes` / `write_attributes` on `spa` | Elroy | done |
| 2 | `terraform fmt -recursive infra`, `validate` (with `-backend=false` in a separate `TF_DATA_DIR`) | Elroy | done: clean |
| 3 | Read-only `terraform plan -lock=false` against dev state | Elroy | done: `0 to add, 2 to change, 0 to destroy`, both in-place, no other drift |
| 4 | Push the branch, open the PR (type: fix + infra; module: auth-apigw; how tested: steps 2–3) | Elroy | |
| 5 | Request review from **@AndrewRetry** by hand: `CODEOWNERS` still has `@ANDREW_GH_HANDLE`, so GitHub won't request him | Elroy | |
| 6 | Andrew approves; squash-merge; delete the branch | Andrew, Elroy | |
| 7 | Tell the team in the group chat before applying (Cody owns the account) | Elroy | |
| 8 | Apply from `main` (see [Apply](#apply)); the plan must still show exactly the 2 in-place updates | Elroy | |
| 9 | Smoke test (see [Smoke test](#smoke-test)) | Elroy | |
| 10 | Post the result in the group chat and on the PR | Elroy | |

Steps 4–6 depend on Andrew's review; the rest Elroy can do alone. If the review can't happen today, stop after step
5. Nothing reaches dev until it is merged.

## Apply

```bash
git switch main && git pull --ff-only
cd infra/envs/dev
export AWS_PROFILE=ticketmastery-tf      # account 000246635159; the default shell profile may point elsewhere
terraform init -input=false
terraform plan -out tfplan               # expect: 2 to change, both "update in-place", nothing replaced
terraform apply tfplan
rm tfplan                                # gitignored, but can contain sensitive values
```

Stop if the plan shows `aws_cognito_user_pool.this must be replaced`: replacing the pool deletes every user.

## Smoke test

Use a mailbox you can read: sign-up and the email change both send codes (the pool sends with `COGNITO_DEFAULT`,
50 emails a day).

```bash
cd infra/envs/dev
export AWS_PROFILE=ticketmastery-tf
POOL=$(terraform output -raw cognito_user_pool_id)
CLIENT=$(terraform output -raw cognito_user_pool_client_id)
EMAIL='<you>+tm-smoke1@<domain>'; NEW_EMAIL='<you>+tm-smoke2@<domain>'
read -rs PW                               # 10+ chars, upper, lower, number

# 1. Sign-up still works with email as an attribute.
aws cognito-idp sign-up --client-id "$CLIENT" --username "$EMAIL" --password "$PW" \
  --user-attributes Name=email,Value="$EMAIL"
aws cognito-idp confirm-sign-up --client-id "$CLIENT" --username "$EMAIL" --confirmation-code <code from email>

TOKEN=$(aws cognito-idp admin-initiate-auth --user-pool-id "$POOL" --client-id "$CLIENT" \
  --auth-flow ADMIN_USER_PASSWORD_AUTH --auth-parameters USERNAME="$EMAIL",PASSWORD="$PW" \
  --query AuthenticationResult.AccessToken --output text)

# 2. name is writable (UC2 profile card).
aws cognito-idp update-user-attributes --access-token "$TOKEN" --user-attributes Name=name,Value='Smoke Test'

# 3. An email change is pending: email stays $EMAIL and email_verified stays true until the code is entered.
aws cognito-idp update-user-attributes --access-token "$TOKEN" --user-attributes Name=email,Value="$NEW_EMAIL"
aws cognito-idp get-user --access-token "$TOKEN" --query 'UserAttributes[?Name!=`sub`]'

# 4. Anything outside write_attributes is rejected.
aws cognito-idp update-user-attributes --access-token "$TOKEN" --user-attributes Name=phone_number,Value=+6580000000

# Clean up.
aws cognito-idp admin-delete-user --user-pool-id "$POOL" --username "$EMAIL"
```

Pass: 1 and 2 succeed; 3 returns code-delivery details and `get-user` still shows the old email, verified, with
`name = Smoke Test`; 4 fails with an error.

Then sign up once through the deployed frontend's Cognito login page.

## Rollback

Revert the squash commit on `main`, then plan and apply as above. Both resources update in place both ways.

## Related

- PR #19 (UC2 profile card) reads and writes `name`. If it later needs another attribute, add it to
  `read_attributes` / `write_attributes` in the same PR.
- `CODEOWNERS` placeholders (`@ANDREW_GH_HANDLE`, …) are separate; until they are replaced, owners must be requested
  by hand.

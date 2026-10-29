# Xserver + Lambda + DynamoDB

Xserver serves the Astro-generated HTML/CSS/JavaScript. A public buffered Function
URL invokes the API Lambda; the API invokes a private worker asynchronously with
`InvocationType: Event`. Both retain the TypeScript comparison logic. DynamoDB
stores comparison jobs, category definitions and shared rate counters in three
on-demand tables. A separate scheduled Lambda cleans expired jobs. No PHP, Xserver
database, Firebase, Render, SQS, customer VPC or NAT gateway is required.

The repository contains packaging and infrastructure definitions. This does not
mean the AWS resources have been deployed or the public domain has been configured.
The old PHP bridge remains as compatibility source/tests, outside both new releases.

Account/CLI and security review results are recorded in
[the pre-deployment review](../../docs/aws-security-review-20261024.md).
Use the dedicated `url-product-compare` CLI profile; verify the STS account before
any deployment. The existing Amplify app is a separate hosting resource.

## Configuration

Copy `api-configuration.example.json` to ignored `api-configuration.json`. Fill
authorized provider settings using the examples in the parent infrastructure
directory. Remove the old `storage` block: it is rejected rather than silently
using the PHP bridge. DynamoDB table names come from the stack environment.

- `http.accessToken`: independent random base64url token, 32–256 characters.
- `http.allowedOrigin`: exact public Xserver HTTPS origin without a trailing slash.
- `http.globalPerMinute` / `http.globalPerDay`: default 60 / 1000 admitted requests.
  The address limit is six requests per fixed minute. All three counters update
  atomically; a rejected request does not consume the other counters. Address
  identities are HMAC digests, not raw IP addresses. Origin checks and limits
  control application admission; they do not prevent invocation charges for a
  public Function URL. CORS is not authentication against non-browser clients.

Result GETs additionally have a cheap pre-storage budget of 240/address/minute
and 1200/minute per warm Lambda environment. This bounds the in-memory map and
avoids extra DB calls for rejected reads. It is not shared across environments
or restarts and is not a billing cap. Restoration, completed cancellation replies
and operation replays recheck current provider display/fetch/affiliate rights;
durable results also require the current storage grant to cover their expiry.

Provider credentials stay in AWS Secrets Manager as one JSON secret. The template
resolves it into encrypted API/worker environment variables at deployment time;
combined environment size must fit Lambda's 4 KB limit. Cleanup receives only table
names and a configuration version, never provider keys. DynamoDB uses IAM roles
through the pinned official SDK; do not configure DynamoDB access keys in Xserver
or the browser. Runtime secret loading can be added separately if size demands it.

Change `ConfigurationVersion` when rotating provider keys so CloudFormation
refreshes the environment. Reconfigure working keys after migration and revoke
any exposed values at the provider. Never put secrets in SITE_ORIGIN,
PUBLIC_API_BASE, HTML, browser storage or logs. Existing token inputs remain masked.

`rakuten` uses applicationId, accessKey, affiliateId, allowedOrigin and
authorizedUntil. Set `resultStorageAuthorizedUntil` **only with actual provider
storage permission**, no later than authorizedUntil. Without it, persistent jobs
return `422 result_storage_denied`; synchronous `POST /api/compare` remains
available without storing results. Moving storage does not grant permission.
Jev uses the existing `{apiKey, model}` setting; unused AI/commerce entries stay
null. The existing optional Amazon/Yahoo/satofull schemas remain supported.

After packaging, validate an ignored real configuration without printing its
contents or calling providers:

```powershell
rtk mise exec -- node tooling/check-lambda-configuration.mjs
```

This enforces a conservative 3400-byte JSON limit, leaving environment space for
the three table names and worker ARN. Validate actual total size during staging.
Upload the same UTF-8 JSON to Secrets Manager; review secret retention/rotation
for prior deployments and retained Lambda versions.

## Storage behavior

Jobs use atomic create and revision plus immutable-generation conditions.
Capabilities, idempotency, cancellation and worker ownership/lease checks stay
in the shared domain logic. Results retain existing maximum 15-minute and
provider-permission deadlines; metadata lasts one hour. JSON is compressed and
bounded below DynamoDB's item limit: compressed payloads exceeding 360,000 bytes
become terminal `result_too_large` failures without truncating results or leaving
the job running.

TTL deletion is eventual. Reads enforce deadlines and scrub expired product
content immediately; physical deletion also uses a one-minute cleanup schedule.
The jobs cleanup GSI selects at most 100 due keys per pass, with strong reads and
conditional writes/deletes to fence stale index entries. Ten-minute-old orphan
jobs are failed after their lease and grace period; cleanup never retries paid
AI work. A failed initial dispatch can be retried with the same client operation.
Lambda invocation acceptance is separate from job completion.

Category cache keys include provider, genre, selection version, Jev model and
AI permission mode. Definitions last 24 hours; selection failures last five
minutes. A 30-second conditional lease shares selection across instances;
waiters poll for at most 15 seconds. DB failure fails closed without fresh paid
inference. Permissions are rechecked on reuse. A crash or expired lease can still
require a later retry; this is not an exactly-once guarantee for external APIs.

Tables use PAY_PER_REQUEST, encryption and TTL. They are retained on stack
deletion/replacement, so retained tables keep data/costs until explicitly handled.
No cross-region replication, backups or restore workflow is provisioned here.
The cleanup error alarm has no notification destination configured; connect one
and monitor backlog, function errors, throttles and dropped asynchronous events.
Set AWS budget notifications; application limits are not hard spending caps.

API IAM covers jobs Get/Put, category Get/Put/Update/Delete, limit-counter Update,
and invocation of its worker only. Worker has jobs/category access. Cleanup has
jobs Get/Put/Delete and Query on the cleanup index, without access to provider
secrets, category data or rate counters. Each function has its own log permissions.

## Build and deployment

Use the mise-pinned runtimes from the repository root:

```powershell
rtk mise run verify
rtk mise run lambda:package
```

The archive at `apps/api/dist/lambda/` includes three handlers and only reachable
runtime modules/dependencies. Packaging checks the handlers, absence of Firebase
and PHP bridge, table TTL, cleanup schedule, environment isolation and Function
URL shape. It performs no deployment and requires no real credentials.

Dependencies are materialized into a physical hoisted tree from the root
lockfile's exact dependency graph. Checks reject links, resolution outside the
archive, changed dependency edges/versions and registry package bytes that differ
from the frozen workspace install. Run a frozen workspace install before packaging.
The isolated pnpm layout cannot be uploaded by expanding Windows junctions:
that changes module resolution on Linux, even if local imports succeed.

For deployment, choose a private artifact bucket and a dedicated reviewed stack:

```powershell
rtk aws sts get-caller-identity --profile url-product-compare
rtk aws cloudformation validate-template --template-body file://infrastructure/lambda/template.json --profile url-product-compare --region ap-northeast-1
rtk aws cloudformation package --template-file infrastructure/lambda/template.json --s3-bucket YOUR_PRIVATE_ARTIFACT_BUCKET --output-template-file infrastructure/lambda/packaged-template.json --profile url-product-compare --region ap-northeast-1
rtk aws cloudformation deploy --template-file infrastructure/lambda/packaged-template.json --stack-name YOUR_STACK --capabilities CAPABILITY_IAM --parameter-overrides ConfigurationSecretArn=YOUR_SECRET_ARN ConfigurationVersion=YOUR_ROTATION_ID ConcurrencyMode=shared --profile url-product-compare --region ap-northeast-1
```

These commands create billable resources. Review an existing stack before update;
the default `ConcurrencyMode=reserved` requires seven slots plus AWS's 100
unreserved slots. The owner selected the existing account limit of ten for the
initial deployment, so the command above explicitly selects `shared`. That mode
omits per-function reservations and shares the regional account pool; the
template does not set the account quota to ten. Check the actual quota before
deploying. API load can delay worker and cleanup in shared mode. If the account
quota is later raised, switch to reserved mode to restore function-level caps.
The API timeout
is 90 seconds; the private worker timeout is 60 seconds. Existing synchronous
commerce/diagnostic routes also use the buffered Function URL and existing
95-second client deadlines. Public cancellation still requires its job capability;
diagnostics still require the server token. Listings marked `usage.store: false`
stay transient and are never put in job storage.

Get the stack's `ApiOrigin`, then build the static release:

```powershell
$env:SITE_ORIGIN = 'https://YOUR_DOMAIN'
$env:PUBLIC_API_BASE = 'https://YOUR_API_ID.lambda-url.ap-northeast-1.on.aws'
rtk mise run xserver:package
```

Upload only `dist/xserver/public_html/` contents to the dedicated Xserver document
root after backup and `.htaccess` review. The generated CSP permits that API origin.
`xserver:static` produces the same PHP-free layout at `dist/xserver-static/`.
Keep instructions and manifests outside the public root; never upload `.env`,
source, Lambda archives or the old storage bridge. Example origins verify the
build only; rebuild with real origins before publication. Use a separate document
root from WordPress. Static hosting does not isolate files from a compromised
application running with the same hosting-account permissions.

## Verification and cutover

Normal verification runs deterministic storage contracts offline. To exercise
the official SDK against a real local DynamoDB engine, start AWS DynamoDB Local
on loopback port 8009 with fake credentials, then run:

```powershell
$env:DYNAMODB_LOCAL_ENDPOINT = 'http://127.0.0.1:8009'
rtk mise exec -- pnpm --filter @app/backend test
```

Integration refuses non-loopback endpoints and creates/deletes only randomly named
`compare_test_*` tables. It covers conditional creates/worker claims, stale writes,
capability checks, expiry scrubbing, cancellation, storage grants, oversized
results, cleanup GSI, shared category leases and transactional counters.
This validates DynamoDB semantics locally, not deployed AWS IAM or quotas.

With real deployed SITE_ORIGIN and PUBLIC_API_BASE, run `rtk mise run migration:smoke`.
It checks static metadata/CSP, catalog/commerce sources, preflight, origin rejection,
shared DynamoDB limits and inaccessible private/PHP paths without provider calls.
Then verify actual product URLs, progress, recovery, cancellation, expiry, provider
permissions, duplicate deliveries and DB failure on staging. Keep the prior static
release/API origin for rollback. Retire existing Firebase/Render/SQL resources only
after the owner confirms the cutover and any needed data export.

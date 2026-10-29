# Xserver + Lambda migration

The target is Astro static files on Xserver, TypeScript API/worker on Lambda,
and DynamoDB for comparison jobs, category definitions and shared request limits.
The separate cleanup Lambda runs once per minute. The new runtime needs no PHP,
Xserver database, Firebase, Render or SQS. UI components and styling are preserved.
Deployment and domain registration remain separate steps.

## Implementation

- Domain logic receives storage ports; it imports no AWS SDK, database or queue.
  Concrete DynamoDB adapters are wired only by Lambda bootstrap.
- Official `@aws-sdk/client-dynamodb` **3.1153.0** was explicitly approved and pinned
  alongside `@aws-sdk/client-lambda` **3.1153.0**. Credentials and signing use IAM
  roles. The release-age policy was kept intact.
- Atomic creation and revision plus generation conditions preserve idempotency,
  worker fencing and cancellation across instances and TTL deletion/recreation.
- Shared genre/model/version/permission-mode cache and conditional leases avoid
  concurrent Jev selection. Failed shared storage does not trigger paid fallback.
- TTL is enforced by application reads; scheduled cleanup queries a bounded GSI,
  scrubs expired results and fails orphan work without replaying paid calls.
- Three counters update atomically for address, global minute and global day.
  Raw IPs are not stored. Configuration defaults remain bounded.
- Product storage permission is still required. Oversized compressed results fail
  explicitly; results are never truncated to fit DynamoDB's item limit.
- Both Xserver package tasks emit only static files; the Lambda archive excludes
  PHP bridge and Firebase code. Existing compatibility tests remain available.

## Review and verification

Run `rtk mise run verify`, `rtk mise run lambda:package`, and generate the static
release with explicit SITE_ORIGIN/PUBLIC_API_BASE. Central ESLint role additions,
entry discovery, package-generation rules, approved SDK/lockfile changes and
infrastructure definitions remain human review items. No checks are weakened.

Offline tests exercise deterministic storage contracts. Optional loopback-only
DynamoDB Local tests exercise the same contracts through the official SDK and
real transactions/conditions. AWS DynamoDB Local **3.3.2** was downloaded from
the official distribution and verified against the published SHA-256:
`7a94eb65f81aee270738751a4e5e3e6a7ad02a5d25194f55b83e08ec2ba6342b`.
The downloaded runtime remains in ignored build output and is not a dependency.

These checks do not establish deployed AWS IAM, secret rotation, DNS, public TLS
or real-provider behavior on the target stack. Provider storage permission is
not inferred from configuration. No AWS deployment or legacy-resource deletion
is performed by local builds. See the [deployment guide](../infrastructure/lambda/README.md)
for configuration, exact commands, staging checks and rollback.

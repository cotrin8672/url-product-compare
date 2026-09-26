#Requires -Version 7.0
param(
  [Parameter(Mandatory)][string]$Profile,
  [Parameter(Mandatory)][string]$ClusterArn,
  [Parameter(Mandatory)][string]$MasterSecretArn,
  [Parameter(Mandatory)][string]$AppSecretArn,
  [string]$Region = 'ap-northeast-1'
)
$ErrorActionPreference = 'Stop'
$workspace = Split-Path -Parent $PSScriptRoot
$temporary = Join-Path $workspace 'apps/api/dist/db-initialization.json'
if (Test-Path -LiteralPath $temporary) { throw 'Initialization file already exists' }
function Invoke-Statement([string]$Sql, [object[]]$Parameters = @()) {
  $request = @{ resourceArn = $ClusterArn; secretArn = $MasterSecretArn; database = 'compare'; sql = $Sql; parameters = $Parameters }
  $request | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $temporary -Encoding utf8
  & rtk proxy aws rds-data execute-statement --profile $Profile --region $Region --cli-input-json "file://$temporary" --no-cli-pager
  if ($LASTEXITCODE -ne 0) { throw 'Database initialization failed' }
}
try {
  # Capture the application password; never print it or place it in command arguments.
  $raw = & rtk proxy aws secretsmanager get-secret-value --profile $Profile --region $Region --secret-id $AppSecretArn --query SecretString --output text --no-cli-pager
  if ($LASTEXITCODE -ne 0) { throw 'Could not read application credentials' }
  $credentials = $raw | ConvertFrom-Json
  if ($credentials.username -ne 'compare_app' -or $credentials.password -notmatch '^[A-Za-z0-9]{32}$') { throw 'Unexpected credential format' }
  Invoke-Statement (Get-Content -LiteralPath (Join-Path $workspace 'infrastructure/schema.sql') -Raw)
  # DDL cannot bind a role password directly. Only the validated alphanumeric generated password is inserted.
  $password = $credentials.password
  $roleSql = @'
DO $block$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'compare_app') THEN
    CREATE ROLE compare_app LOGIN;
  END IF;
  EXECUTE format('ALTER ROLE compare_app PASSWORD %L', '__PASSWORD__');
END
$block$;
'@
  Invoke-Statement ($roleSql.Replace('__PASSWORD__', $password))
  Invoke-Statement 'REVOKE ALL ON investigation_runs FROM PUBLIC'
  Invoke-Statement 'GRANT USAGE ON SCHEMA public TO compare_app'
  Invoke-Statement 'GRANT INSERT (mode, status) ON investigation_runs TO compare_app'
  Write-Output 'Schema and restricted application role initialized.'
} finally {
  if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Force }
}

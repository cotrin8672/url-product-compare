#Requires -Version 7.0
param()
$ErrorActionPreference = 'Stop'
$workspace = Split-Path -Parent $PSScriptRoot
Push-Location $workspace
try {
  & rtk mise exec -- pnpm --filter '@app/api' exec tsc --noEmit false
  if ($LASTEXITCODE -ne 0) { throw 'API compilation failed' }
  & rtk mise exec -- pnpm --filter '@app/web' build
  if ($LASTEXITCODE -ne 0) { throw 'Web build failed' }
  $bundle = Join-Path $workspace 'apps/api/dist/lambda'
  $expected = [IO.Path]::GetFullPath((Join-Path $workspace 'apps/api/dist/lambda'))
  if ([IO.Path]::GetFullPath($bundle) -ne $expected) { throw 'Unexpected bundle path' }
  if (Test-Path -LiteralPath $bundle) { Remove-Item -LiteralPath $bundle -Recurse -Force }
  & rtk mise exec -- pnpm --filter '@app/backend' deploy --legacy --prod $bundle
  if ($LASTEXITCODE -ne 0) { throw 'Production dependency packaging failed' }
  Copy-Item -LiteralPath (Join-Path $workspace 'apps/api/dist/apps') -Destination $bundle -Recurse
  Copy-Item -LiteralPath (Join-Path $workspace 'apps/api/dist/packages') -Destination $bundle -Recurse
  Compress-Archive -Path (Join-Path $workspace 'apps/web/dist/*') -DestinationPath (Join-Path $workspace 'apps/api/dist/web.zip') -Force
  Write-Output "Lambda bundle: $bundle"
  Write-Output "Web assets: $(Join-Path $workspace 'apps/web/dist')"
} finally { Pop-Location }

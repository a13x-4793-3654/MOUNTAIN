[CmdletBinding()]
param(
    [string] $PackagePath,
    [string] $ExpectedTeamsAppId = $env:TEAMS_APP_ID,
    [string] $PublisherClientId = $env:TEAMS_PUBLISHER_CLIENT_ID,
    [string] $TenantId = $env:TEAMS_TENANT_ID,
    [string] $PublisherClientSecret = $env:TEAMS_PUBLISHER_CLIENT_SECRET
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if ([string]::IsNullOrWhiteSpace($PackagePath)) {
    throw 'PackagePath is required.'
}
Import-Module MicrosoftTeams -RequiredVersion 8.0.0 -Global -ErrorAction Stop
Import-Module (Join-Path $PSScriptRoot 'TeamsAppPackage.psm1') -Force
$result = Publish-TeamsAppPackage -Path $PackagePath -ExpectedTeamsAppId $ExpectedTeamsAppId `
    -PublisherClientId $PublisherClientId -TenantId $TenantId -PublisherClientSecret $PublisherClientSecret
Write-Host "Teams app $($result.Action): $($result.AppId), version $($result.Version)."
if (-not [string]::IsNullOrWhiteSpace($env:GITHUB_STEP_SUMMARY)) {
    @(
        '## Teams app catalog deployment'
        "- Result: $($result.Action)"
        "- Manifest app ID: $($result.AppId)"
        "- Catalog ID: $($result.CatalogId)"
        "- Published version: $($result.Version)"
    ) | Add-Content -LiteralPath $env:GITHUB_STEP_SUMMARY -Encoding utf8
}

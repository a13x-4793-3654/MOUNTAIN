[CmdletBinding()]
param(
    [string] $TeamsAppId = $env:TEAMS_APP_ID,
    [string] $BotClientId = $env:BOT_CLIENT_ID,
    [string] $BotDomain = $env:BOT_DOMAIN,
    [string] $AppVersion = $env:TEAMS_APP_VERSION,
    [string] $OutputDirectory = (Join-Path $PSScriptRoot '..\appPackage\build')
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
Import-Module (Join-Path $PSScriptRoot 'TeamsAppPackage.psm1') -Force
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$manifest = New-ResolvedTeamsAppManifest -TemplatePath (Join-Path $root 'appPackage\manifest.json') `
    -TeamsAppId $TeamsAppId -BotClientId $BotClientId -BotDomain $BotDomain -AppVersion $AppVersion
$output = [System.IO.Path]::GetFullPath($OutputDirectory)
New-Item -ItemType Directory -Path $output -Force | Out-Null
$staging = [System.IO.Path]::GetFullPath((Join-Path ([System.IO.Path]::GetTempPath()) "mountain-teams-app-$([guid]::NewGuid().ToString('N'))"))
New-Item -ItemType Directory -Path (Join-Path $staging 'appPackage') | Out-Null
try {
    Copy-Item -LiteralPath (Join-Path $root 'm365agents.yml') -Destination $staging
    $manifest | ConvertTo-Json -Depth 50 |
        Set-Content -LiteralPath (Join-Path $staging 'appPackage\manifest.json') -Encoding utf8NoBOM
    foreach ($icon in @('color.png', 'outline.png')) {
        Copy-Item -LiteralPath (Join-Path $root "appPackage\$icon") -Destination (Join-Path $staging 'appPackage')
    }
    @(
        "TEAMS_APP_ID=$($manifest.id)"
        "CLIENT_ID=$($manifest.bots[0].botId)"
        "BOT_DOMAIN=$($BotDomain.Trim().ToLowerInvariant())"
    ) | Set-Content -LiteralPath (Join-Path $staging '.env') -Encoding utf8NoBOM

    $env:ATK_CLI_SKILL = 'true'
    & npx --yes --package @microsoft/m365agentstoolkit-cli@1.1.18 atk validate `
        --folder $staging --manifest-file (Join-Path $staging 'appPackage\manifest.json') `
        --env-file (Join-Path $staging '.env') -i false --telemetry false
    if ($LASTEXITCODE -ne 0) {
        throw 'Teams manifest validation failed; no deployable package was produced.'
    }
    $zipPath = Join-Path $output 'mountain-teams-bot.zip'
    & npx --yes --package @microsoft/m365agentstoolkit-cli@1.1.18 atk package `
        --folder $staging --manifest-file (Join-Path $staging 'appPackage\manifest.json') `
        --env-file (Join-Path $staging '.env') --output-package-file $zipPath `
        --output-folder $output -i false --telemetry false
    if ($LASTEXITCODE -ne 0) {
        throw 'Teams app packaging failed.'
    }
    $packaged = Read-TeamsAppPackage $zipPath
    if ($packaged.id -ne $manifest.id -or $packaged.version -ne $manifest.version -or
        $packaged.bots[0].botId -ne $manifest.bots[0].botId) {
        throw 'The generated ZIP differs from the requested app identity or version.'
    }
    $manifestPath = Join-Path $output 'manifest.json'
    $packaged | ConvertTo-Json -Depth 50 | Set-Content -LiteralPath $manifestPath -Encoding utf8NoBOM
    if (-not [string]::IsNullOrWhiteSpace($env:GITHUB_OUTPUT)) {
        @("package_path=$zipPath", "manifest_path=$manifestPath", "app_version=$($packaged.version)") |
            Add-Content -LiteralPath $env:GITHUB_OUTPUT -Encoding utf8
    }
    Write-Host "Created Teams app package version $($packaged.version): $zipPath"
} finally {
    Remove-Item -LiteralPath $staging -Recurse -Force
}

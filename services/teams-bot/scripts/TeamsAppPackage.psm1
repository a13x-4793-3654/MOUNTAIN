Set-StrictMode -Version Latest

function ConvertTo-TeamsAppGuid {
    param([string] $Value, [string] $Name)

    $parsed = [guid]::Empty
    if ([string]::IsNullOrWhiteSpace($Value) -or
        -not [guid]::TryParse($Value, [ref] $parsed) -or $parsed -eq [guid]::Empty) {
        throw "$Name must be a non-empty GUID."
    }
    return $parsed.ToString()
}

function ConvertTo-TeamsAppVersion {
    param([string] $Value)

    $parsed = $null
    if ($Value -notmatch '^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$' -or
        -not [version]::TryParse($Value, [ref] $parsed)) {
        throw 'The Teams app version must contain three non-negative integers, such as major.minor.patch.'
    }
    return $parsed
}

function Assert-TeamsAppChannelFeatures {
    param([psobject] $Manifest)

    if ([version] $Manifest.manifestVersion -lt [version] '1.25' -or
        @($Manifest.bots | Where-Object { $_.scopes -contains 'team' }).Count -eq 0) {
        return
    }
    $features = $Manifest.PSObject.Properties['supportsChannelFeatures']
    if ($null -eq $features -or $features.Value -isnot [string] -or $features.Value -cne 'tier1') {
        throw 'Teams manifests version 1.25 or later with team scope must declare supportsChannelFeatures at the root as the string "tier1".'
    }
}

function New-ResolvedTeamsAppManifest {
    param(
        [string] $TemplatePath,
        [string] $TeamsAppId,
        [string] $BotClientId,
        [string] $BotDomain,
        [string] $AppVersion
    )

    $appId = ConvertTo-TeamsAppGuid $TeamsAppId 'TEAMS_APP_ID'
    $botId = ConvertTo-TeamsAppGuid $BotClientId 'BOT_CLIENT_ID'
    if ([string]::IsNullOrWhiteSpace($BotDomain)) {
        throw 'BOT_DOMAIN is required.'
    }
    $domain = $BotDomain.Trim().ToLowerInvariant()
    if ([uri]::CheckHostName($domain) -ne [UriHostNameType]::Dns -or
        $domain -notmatch '^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$') {
        throw 'BOT_DOMAIN must be a public DNS hostname without a scheme, port, or path.'
    }

    $source = Get-Content -LiteralPath $TemplatePath -Raw -Encoding utf8 -ErrorAction Stop
    $source = $source.Replace('${{TEAMS_APP_ID}}', $appId).
        Replace('${{CLIENT_ID}}', $botId).Replace('${{BOT_DOMAIN}}', $domain)
    if ($source.Contains('${{')) {
        throw 'The Teams manifest contains unresolved template variables.'
    }
    $manifest = $source | ConvertFrom-Json -ErrorAction Stop
    if (-not [string]::IsNullOrWhiteSpace($AppVersion)) {
        $manifest.version = $AppVersion
    }
    $null = ConvertTo-TeamsAppVersion $manifest.version
    if ($manifest.id -ne $appId -or $manifest.bots.Count -ne 1 -or $manifest.bots[0].botId -ne $botId) {
        throw 'The resolved Teams manifest does not match the configured app and bot IDs.'
    }
    Assert-TeamsAppChannelFeatures $manifest
    return $manifest
}

function Read-TeamsZipEntry {
    param([System.IO.Compression.ZipArchiveEntry] $Entry)

    $inputStream = $Entry.Open()
    $outputStream = [System.IO.MemoryStream]::new()
    try {
        $inputStream.CopyTo($outputStream)
        return ,$outputStream.ToArray()
    } finally {
        $inputStream.Dispose()
        $outputStream.Dispose()
    }
}

function Assert-TeamsPng {
    param([byte[]] $Bytes, [int] $Size, [string] $Name)

    $signature = @(137, 80, 78, 71, 13, 10, 26, 10)
    if ($Bytes.Length -lt 26) {
        throw "$Name is not a valid PNG."
    }
    for ($index = 0; $index -lt $signature.Count; $index++) {
        if ($Bytes[$index] -ne $signature[$index]) {
            throw "$Name is not a valid PNG."
        }
    }
    $width = ([int] $Bytes[16] -shl 24) -bor ([int] $Bytes[17] -shl 16) -bor
        ([int] $Bytes[18] -shl 8) -bor [int] $Bytes[19]
    $height = ([int] $Bytes[20] -shl 24) -bor ([int] $Bytes[21] -shl 16) -bor
        ([int] $Bytes[22] -shl 8) -bor [int] $Bytes[23]
    if ($width -ne $Size -or $height -ne $Size) {
        throw "$Name must be $Size x $Size pixels."
    }
    if ($Name -eq 'outline.png' -and $Bytes[25] -ne 6) {
        throw 'outline.png must use an RGBA PNG with transparency.'
    }
}

function Read-TeamsAppPackage {
    param([string] $Path)

    $archive = [System.IO.Compression.ZipFile]::OpenRead((Resolve-Path -LiteralPath $Path -ErrorAction Stop).Path)
    try {
        $names = @($archive.Entries | ForEach-Object FullName | Sort-Object)
        if (($names -join ',') -cne 'color.png,manifest.json,outline.png') {
            throw 'The app ZIP must contain only manifest.json, color.png, and outline.png at its root.'
        }
        $source = [System.Text.Encoding]::UTF8.GetString((Read-TeamsZipEntry $archive.GetEntry('manifest.json')))
        if ($source.Contains('${{')) {
            throw 'The app ZIP still contains unresolved manifest variables.'
        }
        $manifest = $source | ConvertFrom-Json -ErrorAction Stop
        $null = ConvertTo-TeamsAppGuid $manifest.id 'manifest.id'
        $null = ConvertTo-TeamsAppGuid $manifest.bots[0].botId 'manifest.bots[0].botId'
        $null = ConvertTo-TeamsAppVersion $manifest.version
        Assert-TeamsAppChannelFeatures $manifest
        if ($manifest.icons.color -cne 'color.png' -or $manifest.icons.outline -cne 'outline.png') {
            throw 'The manifest icon names do not match the app ZIP entries.'
        }
        Assert-TeamsPng (Read-TeamsZipEntry $archive.GetEntry('color.png')) 192 'color.png'
        Assert-TeamsPng (Read-TeamsZipEntry $archive.GetEntry('outline.png')) 32 'outline.png'
        return $manifest
    } finally {
        $archive.Dispose()
    }
}

function Get-TeamsPublisherToken {
    param([string] $TenantId, [string] $ClientId, [string] $ClientSecret, [string] $Scope)

    $response = Invoke-RestMethod -Method Post `
        -Uri "https://login.microsoftonline.com/$TenantId/oauth2/v2.0/token" `
        -ContentType 'application/x-www-form-urlencoded' `
        -Body @{
            grant_type = 'client_credentials'
            client_id = $ClientId
            client_secret = $ClientSecret
            scope = $Scope
        } -TimeoutSec 60 -ErrorAction Stop
    if ([string]::IsNullOrWhiteSpace($response.access_token)) {
        throw 'Microsoft Entra ID returned no publisher access token.'
    }
    if ($env:GITHUB_ACTIONS -eq 'true') {
        Write-Host "::add-mask::$($response.access_token)"
    }
    return $response.access_token
}

function Get-TeamsCatalogDefinitions {
    param([string] $CatalogId, [string] $GraphToken)

    $id = [uri]::EscapeDataString($CatalogId)
    $next = "https://graph.microsoft.com/v1.0/appCatalogs/teamsApps/$id/appDefinitions?`$select=id,version,publishingState"
    $visited = [System.Collections.Generic.HashSet[string]]::new()
    while (-not [string]::IsNullOrWhiteSpace($next)) {
        $uri = [uri] $next
        if (-not $uri.IsAbsoluteUri -or $uri.Scheme -ne 'https' -or
            $uri.Host -ne 'graph.microsoft.com' -or -not $uri.IsDefaultPort -or
            $uri.UserInfo -or -not $uri.AbsolutePath.StartsWith('/v1.0/appCatalogs/teamsApps/') -or
            -not $visited.Add($next)) {
            throw 'The app catalog returned an unsafe or repeated pagination URL.'
        }
        $response = Invoke-RestMethod -Method Get -Uri $uri `
            -Headers @{ Authorization = "Bearer $GraphToken" } -TimeoutSec 60 -ErrorAction Stop
        $values = $response.PSObject.Properties['value']
        if ($null -eq $values -or $null -eq $values.Value) {
            throw 'The app catalog returned an invalid app definition collection.'
        }
        foreach ($definition in $values.Value) {
            $definition
        }
        $nextProperty = $response.PSObject.Properties['@odata.nextLink']
        $next = if ($null -ne $nextProperty) { [string] $nextProperty.Value } else { $null }
    }
}

function Get-UniqueTeamsCatalogApp {
    param([string] $AppId)

    $apps = @(Get-TeamsApp -ExternalId $AppId -DistributionMethod organization -ErrorAction Stop)
    if ($apps.Count -gt 1) {
        throw 'Multiple organization catalog apps match TEAMS_APP_ID; no changes were made.'
    }
    if ($apps.Count -eq 1) {
        if ([string]::IsNullOrWhiteSpace($apps[0].Id) -or $apps[0].ExternalId -ne $AppId) {
            throw 'The app catalog lookup returned an unexpected app identity.'
        }
        return $apps[0]
    }
}

function Publish-TeamsAppPackage {
    param(
        [string] $Path,
        [string] $ExpectedTeamsAppId,
        [string] $PublisherClientId,
        [string] $TenantId,
        [string] $PublisherClientSecret
    )

    $appId = ConvertTo-TeamsAppGuid $ExpectedTeamsAppId 'TEAMS_APP_ID'
    $clientId = ConvertTo-TeamsAppGuid $PublisherClientId 'TEAMS_PUBLISHER_CLIENT_ID'
    $tenant = ConvertTo-TeamsAppGuid $TenantId 'TEAMS_TENANT_ID'
    if ([string]::IsNullOrWhiteSpace($PublisherClientSecret)) {
        throw 'TEAMS_PUBLISHER_CLIENT_SECRET is required.'
    }
    $manifest = Read-TeamsAppPackage $Path
    if ($manifest.id -ne $appId) {
        throw 'The package app ID differs from TEAMS_APP_ID; no catalog changes were made.'
    }
    $version = ConvertTo-TeamsAppVersion $manifest.version
    $graphToken = Get-TeamsPublisherToken $tenant $clientId $PublisherClientSecret 'https://graph.microsoft.com/.default'
    $teamsToken = Get-TeamsPublisherToken $tenant $clientId $PublisherClientSecret '48ac35b8-9aa8-4d74-927d-1f4a14a0b239/.default'
    $connected = $false
    try {
        # AccessTokens mode derives the tenant from the tokens; MicrosoftTeams 8.0.0 rejects TenantId here.
        Connect-MicrosoftTeams -AccessTokens @($graphToken, $teamsToken) -ErrorAction Stop | Out-Null
        $connected = $true
        $existing = Get-UniqueTeamsCatalogApp $appId
        if ($null -ne $existing) {
            $definitions = @(Get-TeamsCatalogDefinitions $existing.Id $graphToken)
            if ($definitions.Count -eq 0) {
                throw 'The existing catalog app has no version metadata; verify its state before publishing.'
            }
            foreach ($definition in $definitions) {
                if ($version -le (ConvertTo-TeamsAppVersion $definition.version)) {
                    throw 'The package version must be newer than every existing catalog version. Increase manifest.json version or the workflow version input.'
                }
            }
            Set-TeamsApp -Id $existing.Id -Path $Path -ErrorAction Stop | Out-Null
            $action = 'updated'
        } else {
            New-TeamsApp -DistributionMethod organization -Path $Path -ErrorAction Stop | Out-Null
            $action = 'created'
        }

        for ($attempt = 0; $attempt -lt 12; $attempt++) {
            $published = Get-UniqueTeamsCatalogApp $appId
            if ($null -ne $published) {
                $definitions = @(Get-TeamsCatalogDefinitions $published.Id $graphToken)
                foreach ($definition in $definitions) {
                    if ($definition.version -eq $manifest.version) {
                        if ($definition.publishingState -eq 'published') {
                            return [pscustomobject] @{
                                Action = $action
                                AppId = $appId
                                CatalogId = $published.Id
                                Version = $manifest.version
                            }
                        }
                        if ($definition.publishingState -in @('submitted', 'rejected')) {
                            throw 'The package is not published: tenant administrator review is required or the submission was rejected.'
                        }
                    }
                }
            }
            if ($attempt -lt 11) {
                Start-Sleep -Seconds 5
            }
        }
        throw 'Upload completed, but the published catalog version could not be verified. Check the Teams admin center before retrying.'
    } finally {
        if ($connected) {
            Disconnect-MicrosoftTeams -ErrorAction Stop | Out-Null
        }
    }
}

Export-ModuleMember -Function New-ResolvedTeamsAppManifest, Read-TeamsAppPackage, Publish-TeamsAppPackage

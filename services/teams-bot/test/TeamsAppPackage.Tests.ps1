BeforeAll {
    $source = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
    Import-Module (Join-Path $source 'scripts\TeamsAppPackage.psm1') -Force
    $script:template = Join-Path $source 'appPackage\manifest.json'
    $script:icons = Join-Path $source 'appPackage'

    function New-TestTeamsPackage {
        param(
            [string] $AppId,
            [string] $Version = '1.2.3',
            [switch] $ExtraEntry,
            [switch] $WrongIconSize
        )

        $name = [guid]::NewGuid().ToString('N')
        $directory = Join-Path $TestDrive $name
        New-Item -ItemType Directory -Path $directory | Out-Null
        $manifest = New-ResolvedTeamsAppManifest -TemplatePath $script:template `
            -TeamsAppId $AppId -BotClientId ([guid]::NewGuid().ToString()) `
            -BotDomain 'bot.example.test' -AppVersion $Version
        $manifest | ConvertTo-Json -Depth 50 |
            Set-Content (Join-Path $directory 'manifest.json') -Encoding utf8NoBOM
        foreach ($icon in @('color.png', 'outline.png')) {
            Copy-Item (Join-Path $script:icons $icon) -Destination $directory
        }
        if ($WrongIconSize) {
            $iconPath = Join-Path $directory 'color.png'
            $bytes = [System.IO.File]::ReadAllBytes($iconPath)
            $bytes[19] = 193
            [System.IO.File]::WriteAllBytes($iconPath, $bytes)
        }
        if ($ExtraEntry) {
            'not a deployable input' | Set-Content (Join-Path $directory '.env')
        }
        $path = Join-Path $TestDrive "$name.zip"
        [System.IO.Compression.ZipFile]::CreateFromDirectory($directory, $path)
        return $path
    }

    function global:Connect-MicrosoftTeams {
        [CmdletBinding()]
        param([ValidateNotNullOrEmpty()] [string] $TenantId, [string[]] $AccessTokens)
    }
    function global:Disconnect-MicrosoftTeams {
        [CmdletBinding()]
        param()
    }
    function global:Get-TeamsApp {
        [CmdletBinding()]
        param([string] $ExternalId, [string] $DistributionMethod)
    }
    function global:New-TeamsApp {
        [CmdletBinding()]
        param([string] $DistributionMethod, [string] $Path)
    }
    function global:Set-TeamsApp {
        [CmdletBinding()]
        param([string] $Id, [string] $Path)
    }
}

Describe 'Teams app package validation' {
    It 'resolves the real deployment inputs and an explicit app version' {
        $appId = [guid]::NewGuid().ToString()
        $botId = [guid]::NewGuid().ToString()
        $manifest = New-ResolvedTeamsAppManifest -TemplatePath $script:template `
            -TeamsAppId $appId -BotClientId $botId -BotDomain 'Bot.Example.Test' -AppVersion '2.3.4'
        $manifest.id | Should -Be $appId
        $manifest.bots[0].botId | Should -Be $botId
        $manifest.validDomains[0] | Should -Be 'bot.example.test'
        $manifest.version | Should -Be '2.3.4'
    }

    It 'rejects missing app configuration rather than creating a placeholder package' {
        {
            New-ResolvedTeamsAppManifest -TemplatePath $script:template `
                -TeamsAppId '' -BotClientId ([guid]::NewGuid().ToString()) -BotDomain 'bot.example.test'
        } | Should -Throw '*TEAMS_APP_ID*'
    }

    It 'rejects invalid domains and app versions' {
        $parameters = @{
            TemplatePath = $script:template
            TeamsAppId = [guid]::NewGuid().ToString()
            BotClientId = [guid]::NewGuid().ToString()
        }
        foreach ($domain in @('https://bot.example.test', 'bot.example.test/path', '127.0.0.1', 'localhost')) {
            { New-ResolvedTeamsAppManifest @parameters -BotDomain $domain } | Should -Throw '*BOT_DOMAIN*'
        }
        foreach ($version in @('1.2', '1.2.3-beta', '01.2.3', '-1.2.3')) {
            { New-ResolvedTeamsAppManifest @parameters -BotDomain 'bot.example.test' -AppVersion $version } |
                Should -Throw '*version*'
        }
    }

    It 'accepts a flat package with correctly sized icons' {
        $appId = [guid]::NewGuid().ToString()
        $manifest = Read-TeamsAppPackage (New-TestTeamsPackage -AppId $appId)
        $manifest.id | Should -Be $appId
        $manifest.version | Should -Be '1.2.3'
    }

    It 'rejects ZIPs that accidentally include an environment file' {
        $path = New-TestTeamsPackage -AppId ([guid]::NewGuid().ToString()) -ExtraEntry
        { Read-TeamsAppPackage $path } | Should -Throw '*only manifest.json*'
    }

    It 'rejects a color icon outside the required dimensions' {
        $path = New-TestTeamsPackage -AppId ([guid]::NewGuid().ToString()) -WrongIconSize
        { Read-TeamsAppPackage $path } | Should -Throw '*192 x 192*'
    }
}

Describe 'Organization catalog deployment' {
    BeforeEach {
        $appId = [guid]::NewGuid().ToString()
        $script:packagePath = New-TestTeamsPackage -AppId $appId
        $script:publishParameters = @{
            Path = $script:packagePath
            ExpectedTeamsAppId = $appId
            PublisherClientId = [guid]::NewGuid().ToString()
            TenantId = [guid]::NewGuid().ToString()
            PublisherClientSecret = [guid]::NewGuid().ToString('N')
        }
        $global:TeamsPackageTestState = @{
            App = [pscustomobject] @{ Id = 'catalog-id-not-the-manifest-id'; ExternalId = $appId }
            Exists = $false
            Uploaded = $false
            OldVersion = '0.1.0'
            NewVersion = '1.2.3'
            PublishingState = 'published'
            UnsafeNextLink = $false
            NeverVisible = $false
            Multiple = $false
            ExpectedTenantId = $script:publishParameters.TenantId
            ExpectedPublisherClientId = $script:publishParameters.PublisherClientId
        }
        Mock Connect-MicrosoftTeams -ModuleName TeamsAppPackage {
            param([string] $TenantId, [string[]] $AccessTokens)

            if (-not [string]::IsNullOrWhiteSpace($TenantId)) {
                throw [System.ArgumentException]::new('Not supported tenant type.')
            }
        }
        Mock Disconnect-MicrosoftTeams -ModuleName TeamsAppPackage {}
        Mock Start-Sleep -ModuleName TeamsAppPackage {}
        Mock Get-TeamsApp -ModuleName TeamsAppPackage {
            if ($global:TeamsPackageTestState.Exists) {
                $global:TeamsPackageTestState.App
                if ($global:TeamsPackageTestState.Multiple) {
                    $global:TeamsPackageTestState.App
                }
            }
        }
        Mock New-TeamsApp -ModuleName TeamsAppPackage {
            $global:TeamsPackageTestState.Exists = $true
            $global:TeamsPackageTestState.Uploaded = $true
        }
        Mock Set-TeamsApp -ModuleName TeamsAppPackage {
            $global:TeamsPackageTestState.Uploaded = $true
        }
        Mock Invoke-RestMethod -ModuleName TeamsAppPackage {
            if ($Method -eq 'Post') {
                return [pscustomobject] @{ access_token = "test-token-$($Body.scope)" }
            }
            if ($Method -ne 'Get' -or $Uri.Host -ne 'graph.microsoft.com') {
                throw 'Unexpected network request in deployment test.'
            }
            $state = $global:TeamsPackageTestState
            $version = if ($state.Uploaded -and -not $state.NeverVisible) { $state.NewVersion } else { $state.OldVersion }
            $response = @{
                value = @([pscustomobject] @{
                    id = 'definition-id'
                    version = $version
                    publishingState = $state.PublishingState
                })
            }
            if ($state.UnsafeNextLink) {
                $response['@odata.nextLink'] = 'https://outside.example.test/page'
            }
            return [pscustomobject] $response
        }
    }

    It 'uses both application token resources and creates a missing organization app' {
        $result = Publish-TeamsAppPackage @script:publishParameters
        $result.Action | Should -Be 'created'
        $result.Version | Should -Be '1.2.3'
        Should -Invoke Invoke-RestMethod -ModuleName TeamsAppPackage -Times 1 -Exactly -ParameterFilter {
            $Method -eq 'Post' -and $Body.scope -eq 'https://graph.microsoft.com/.default' -and
            $Body.grant_type -eq 'client_credentials'
        }
        Should -Invoke Invoke-RestMethod -ModuleName TeamsAppPackage -Times 1 -Exactly -ParameterFilter {
            $Method -eq 'Post' -and $Body.scope -eq '48ac35b8-9aa8-4d74-927d-1f4a14a0b239/.default'
        }
        Should -Invoke New-TeamsApp -ModuleName TeamsAppPackage -Times 1 -Exactly -ParameterFilter {
            $DistributionMethod -eq 'organization'
        }
        Should -Invoke Set-TeamsApp -ModuleName TeamsAppPackage -Times 0 -Exactly
        Should -Invoke Disconnect-MicrosoftTeams -ModuleName TeamsAppPackage -Times 1 -Exactly
    }

    It 'keeps tenant-specific OAuth requests separate from the access-token connection' {
        $result = Publish-TeamsAppPackage @script:publishParameters
        $result.Action | Should -Be 'created'
        Should -Invoke Invoke-RestMethod -ModuleName TeamsAppPackage -Times 2 -Exactly -ParameterFilter {
            $Method -eq 'Post' -and
            [string] $Uri -eq "https://login.microsoftonline.com/$($global:TeamsPackageTestState.ExpectedTenantId)/oauth2/v2.0/token" -and
            $Body.client_id -eq $global:TeamsPackageTestState.ExpectedPublisherClientId -and
            $Body.grant_type -eq 'client_credentials'
        }
        Should -Invoke Connect-MicrosoftTeams -ModuleName TeamsAppPackage -Times 1 -Exactly -ParameterFilter {
            [string]::IsNullOrWhiteSpace($TenantId) -and $AccessTokens.Count -eq 2 -and
            $AccessTokens[0] -eq 'test-token-https://graph.microsoft.com/.default' -and
            $AccessTokens[1] -eq 'test-token-48ac35b8-9aa8-4d74-927d-1f4a14a0b239/.default'
        }
    }

    It 'updates by the catalog ID, not by the manifest ID' {
        $global:TeamsPackageTestState.Exists = $true
        $global:TeamsPackageTestState.OldVersion = '1.2.2'
        $result = Publish-TeamsAppPackage @script:publishParameters
        $result.Action | Should -Be 'updated'
        Should -Invoke Set-TeamsApp -ModuleName TeamsAppPackage -Times 1 -Exactly -ParameterFilter {
            $Id -eq 'catalog-id-not-the-manifest-id'
        }
        Should -Invoke New-TeamsApp -ModuleName TeamsAppPackage -Times 0 -Exactly
    }

    It 'refuses catalog version <ExistingVersion> before uploading package 1.2.3' -ForEach @(
        @{ ExistingVersion = '1.2.3' }
        @{ ExistingVersion = '2.0.0' }
    ) {
        $global:TeamsPackageTestState.Exists = $true
        $global:TeamsPackageTestState.OldVersion = $ExistingVersion
        { Publish-TeamsAppPackage @script:publishParameters } | Should -Throw '*must be newer*'
        Should -Invoke Set-TeamsApp -ModuleName TeamsAppPackage -Times 0 -Exactly
        Should -Invoke Disconnect-MicrosoftTeams -ModuleName TeamsAppPackage -Times 1 -Exactly
    }

    It 'rejects a package ID mismatch before requesting any access tokens' {
        $script:publishParameters.ExpectedTeamsAppId = [guid]::NewGuid().ToString()
        { Publish-TeamsAppPackage @script:publishParameters } | Should -Throw '*differs from TEAMS_APP_ID*'
        Should -Invoke Invoke-RestMethod -ModuleName TeamsAppPackage -Times 0 -Exactly
    }

    It 'rejects a missing publisher secret before contacting Microsoft' {
        $script:publishParameters.PublisherClientSecret = ''
        { Publish-TeamsAppPackage @script:publishParameters } | Should -Throw '*TEAMS_PUBLISHER_CLIENT_SECRET*'
        Should -Invoke Invoke-RestMethod -ModuleName TeamsAppPackage -Times 0 -Exactly
    }

    It 'rejects ambiguous catalog matches instead of updating an arbitrary app' {
        $global:TeamsPackageTestState.Exists = $true
        $global:TeamsPackageTestState.Multiple = $true
        { Publish-TeamsAppPackage @script:publishParameters } | Should -Throw '*Multiple organization*'
        Should -Invoke Set-TeamsApp -ModuleName TeamsAppPackage -Times 0 -Exactly
    }

    It 'does not forward the Graph token to a foreign pagination URL' {
        $global:TeamsPackageTestState.Exists = $true
        $global:TeamsPackageTestState.UnsafeNextLink = $true
        { Publish-TeamsAppPackage @script:publishParameters } | Should -Throw '*unsafe or repeated*'
        Should -Invoke Invoke-RestMethod -ModuleName TeamsAppPackage -Times 1 -Exactly -ParameterFilter {
            $Method -eq 'Get'
        }
        Should -Invoke Set-TeamsApp -ModuleName TeamsAppPackage -Times 0 -Exactly
    }

    It 'does not report publication success while administrator review is required' {
        $global:TeamsPackageTestState.PublishingState = 'submitted'
        { Publish-TeamsAppPackage @script:publishParameters } | Should -Throw '*administrator review*'
        Should -Invoke Disconnect-MicrosoftTeams -ModuleName TeamsAppPackage -Times 1 -Exactly
    }

    It 'bounds verification retries and fails explicitly if the uploaded version is not visible' {
        $global:TeamsPackageTestState.NeverVisible = $true
        { Publish-TeamsAppPackage @script:publishParameters } | Should -Throw '*could not be verified*'
        Should -Invoke New-TeamsApp -ModuleName TeamsAppPackage -Times 1 -Exactly
        Should -Invoke Start-Sleep -ModuleName TeamsAppPackage -Times 11 -Exactly
    }

    It 'surfaces upload failures without pretending the catalog was updated' {
        Mock New-TeamsApp -ModuleName TeamsAppPackage { throw 'Catalog upload rejected: permission denied.' }
        { Publish-TeamsAppPackage @script:publishParameters } | Should -Throw '*permission denied*'
        Should -Invoke Disconnect-MicrosoftTeams -ModuleName TeamsAppPackage -Times 1 -Exactly
    }
}

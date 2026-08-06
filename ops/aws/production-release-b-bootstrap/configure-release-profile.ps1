[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$Profile = 'nana-production-release-b'
$SsoSession = 'shirone'
$ExpectedAccount = '388811589005'
$RoleName = 'NanaProductionReleaseBOperator'
$Region = 'ap-northeast-1'

aws configure set sso_session $SsoSession --profile $Profile
if ($LASTEXITCODE -ne 0) { throw 'PROFILE_CONFIG_FAILED' }
aws configure set sso_account_id $ExpectedAccount --profile $Profile
if ($LASTEXITCODE -ne 0) { throw 'PROFILE_CONFIG_FAILED' }
aws configure set sso_role_name $RoleName --profile $Profile
if ($LASTEXITCODE -ne 0) { throw 'PROFILE_CONFIG_FAILED' }
aws configure set region $Region --profile $Profile
if ($LASTEXITCODE -ne 0) { throw 'PROFILE_CONFIG_FAILED' }
aws configure set output json --profile $Profile
if ($LASTEXITCODE -ne 0) { throw 'PROFILE_CONFIG_FAILED' }

aws sso login --profile $Profile
if ($LASTEXITCODE -ne 0) { throw 'SSO_LOGIN_FAILED' }
$identityText = aws sts get-caller-identity --profile $Profile --region $Region --no-cli-pager --output json 2>$null
if ($LASTEXITCODE -ne 0) { throw 'CALLER_IDENTITY_FAILED' }
$identity = ($identityText -join "`n") | ConvertFrom-Json
if ([string]$identity.Account -ne $ExpectedAccount) { throw 'PRODUCTION_ACCOUNT_MISMATCH' }
if ([string]$identity.Arn -notmatch ':assumed-role/AWSReservedSSO_NanaProductionReleaseBOperator_') { throw 'PERMISSION_SET_ROLE_MISMATCH' }

[PSCustomObject]@{
    status = 'PASS'
    profile = $Profile
    account = 'PRODUCTION_CONFIRMED'
    role = 'NanaProductionReleaseBOperator'
    region = $Region
    long_term_access_key_created = $false
} | ConvertTo-Json -Compress

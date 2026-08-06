[CmdletBinding()]
param(
    [string]$Profile = 'nana-production-release-b'
)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot = (Resolve-Path (Join-Path $Root '..\..\..')).Path
$ExpectedAccount = '388811589005'
$Region = 'ap-northeast-1'
$ExpectedRole = 'NanaProductionCanonicalRuntimeExecutionRole'
$CanonicalStack = 'nana-reading-production'
$TemplatePath = Join-Path $Root 'execution-role-bootstrap.yaml'
$ArtifactBucketName = 'nana-prod-artifacts-388811589005-apne1'

function Assert-True {
    param([bool]$Condition, [string]$Code)
    if (-not $Condition) { throw $Code }
}

function Invoke-AwsJson {
    param([string[]]$Arguments)
    $output = & aws @Arguments --profile $Profile --region $Region --no-cli-pager --output json 2>$null
    if ($LASTEXITCODE -ne 0) { throw 'AWS_READ_ONLY_SMOKE_FAILED' }
    if ([string]::IsNullOrWhiteSpace(($output -join ''))) { return $null }
    return (($output -join "`n") | ConvertFrom-Json)
}

Assert-True ($ArtifactBucketName -match '^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$') 'ARTIFACT_BUCKET_INVALID'

$identity = Invoke-AwsJson @('sts', 'get-caller-identity')
Assert-True ([string]$identity.Account -eq $ExpectedAccount) 'PRODUCTION_ACCOUNT_MISMATCH'
Assert-True ([string]$identity.Arn -match ':assumed-role/AWSReservedSSO_NanaProductionReleaseBOperator_') 'OPERATOR_ROLE_MISMATCH'

$role = Invoke-AwsJson @('iam', 'get-role', '--role-name', $ExpectedRole)
Assert-True ([string]$role.Role.RoleName -eq $ExpectedRole) 'EXECUTION_ROLE_NOT_READY'
$trust = $role.Role.AssumeRolePolicyDocument
$trustStatements = @($trust.Statement)
Assert-True ($trustStatements.Count -eq 1) 'EXECUTION_ROLE_TRUST_COUNT_INVALID'
Assert-True ([string]$trustStatements[0].Principal.Service -eq 'cloudformation.amazonaws.com') 'EXECUTION_ROLE_TRUST_INVALID'

$bucket = Invoke-AwsJson @('s3api', 'get-bucket-location', '--bucket', $ArtifactBucketName)
$bucketRegion = if ([string]::IsNullOrWhiteSpace([string]$bucket.LocationConstraint)) { 'us-east-1' } else { [string]$bucket.LocationConstraint }
Assert-True ($bucketRegion -eq $Region) 'ARTIFACT_BUCKET_REGION_MISMATCH'

Invoke-AwsJson @('cloudformation', 'validate-template', '--template-body', ('file://' + $TemplatePath)) | Out-Null
Invoke-AwsJson @('dynamodb', 'describe-table', '--table-name', 'shirone7_users') | Out-Null
Invoke-AwsJson @('dynamodb', 'describe-table', '--table-name', 'shirone7_history') | Out-Null

$stackState = 'NOT_DEPLOYED'
$previousPreference = $ErrorActionPreference
try {
    $ErrorActionPreference = 'Continue'
    $stackOutput = & aws cloudformation describe-stacks --stack-name $CanonicalStack --profile $Profile --region $Region --no-cli-pager --output json 2>&1
    $stackExitCode = $LASTEXITCODE
} finally {
    $ErrorActionPreference = $previousPreference
}
if ($stackExitCode -eq 0) {
    $stack = ($stackOutput -join "`n") | ConvertFrom-Json
    Assert-True (@($stack.Stacks).Count -eq 1) 'CANONICAL_STACK_AMBIGUOUS'
    $stackState = [string]$stack.Stacks[0].StackStatus
} else {
    $safeError = $stackOutput -join "`n"
    Assert-True ($safeError -match 'ValidationError' -and $safeError -match 'does not exist') 'CANONICAL_STACK_READ_FAILED'
}

[PSCustomObject]@{
    status = 'PASS'
    profile = $Profile
    account = 'PRODUCTION_CONFIRMED'
    execution_role = 'CLOUDFORMATION_ONLY_TRUST_VERIFIED'
    artifact_bucket = 'TOKYO_REGION_VERIFIED'
    legacy_sources = 'READABLE'
    canonical_stack = $stackState
    production_release_b_operator_profile_ready = $true
    production_cloudformation_execution_role_ready = $true
    aws_mutations = 0
} | ConvertTo-Json -Compress

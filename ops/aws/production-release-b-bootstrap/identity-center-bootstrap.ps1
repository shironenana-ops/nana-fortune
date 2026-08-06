[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$AdminProfile,
    [Parameter(Mandatory = $true)][string]$TargetAccountId,
    [Parameter(Mandatory = $true)][ValidateSet('USER', 'GROUP')][string]$PrincipalType,
    [Parameter(Mandatory = $true)][string]$PrincipalId,
    [string]$RuntimeSecretArn = ''
)

$ErrorActionPreference = 'Stop'
$ExpectedAccount = '388811589005'
$Region = 'ap-northeast-1'
$PermissionSetName = 'NanaProductionReleaseBOperator'
$SessionDuration = 'PT4H'
$ArtifactBucketName = 'nana-prod-artifacts-388811589005-apne1'
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$PolicyPath = Join-Path $Root 'operator-permission-set-policy.json'
$TempPolicy = Join-Path ([System.IO.Path]::GetTempPath()) ('nana-release-b-policy-' + [guid]::NewGuid().ToString('N') + '.json')

function Invoke-AwsJson {
    param([string[]]$Arguments)
    $output = & aws @Arguments --profile $AdminProfile --region $Region --no-cli-pager --output json 2>$null
    if ($LASTEXITCODE -ne 0) { throw 'AWS_COMMAND_FAILED' }
    if ([string]::IsNullOrWhiteSpace(($output -join ''))) { return $null }
    return (($output -join "`n") | ConvertFrom-Json)
}

function Invoke-AwsOptionalJson {
    param([string[]]$Arguments)
    $previousPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'Continue'
        $output = & aws @Arguments --profile $AdminProfile --region $Region --no-cli-pager --output json 2>$null
        $exitCode = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $previousPreference
    }
    if ($exitCode -ne 0) { return $null }
    if ([string]::IsNullOrWhiteSpace(($output -join ''))) { return $null }
    return (($output -join "`n") | ConvertFrom-Json)
}

function Get-CanonicalJson {
    param($Value)
    return ($Value | ConvertTo-Json -Depth 100 -Compress)
}

function Get-Sha256 {
    param([string]$Text)
    $bytes = [Text.Encoding]::UTF8.GetBytes($Text)
    $hash = [Security.Cryptography.SHA256]::Create().ComputeHash($bytes)
    return ([BitConverter]::ToString($hash) -replace '-', '').ToLowerInvariant()
}

try {
    if ($TargetAccountId -ne $ExpectedAccount) { throw 'TARGET_ACCOUNT_MISMATCH' }
    if ($ArtifactBucketName -notmatch '^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$') { throw 'ARTIFACT_BUCKET_INVALID' }
    if ($PrincipalId -notmatch '^[A-Za-z0-9+=,.@_-]{1,128}$') { throw 'PRINCIPAL_ID_INVALID' }
    if ($RuntimeSecretArn -and $RuntimeSecretArn -notmatch '^arn:aws:secretsmanager:ap-northeast-1:388811589005:secret:shirone7/production/runtime-[A-Za-z0-9]+$') {
        throw 'RUNTIME_SECRET_ARN_INVALID'
    }

    $caller = Invoke-AwsJson @('sts', 'get-caller-identity')
    if (-not $caller.Account -or [string]$caller.Account -eq '946385207519') { throw 'IDENTITY_CENTER_ADMIN_BOUNDARY_INVALID' }

    $instances = Invoke-AwsJson @('sso-admin', 'list-instances')
    $instanceList = @($instances.Instances)
    if ($instanceList.Count -ne 1) { throw 'IDENTITY_CENTER_INSTANCE_AMBIGUOUS' }
    $instanceArn = [string]$instanceList[0].InstanceArn

    $permissionSets = Invoke-AwsJson @('sso-admin', 'list-permission-sets', '--instance-arn', $instanceArn)
    $permissionSetArn = $null
    foreach ($candidate in @($permissionSets.PermissionSets)) {
        $description = Invoke-AwsJson @('sso-admin', 'describe-permission-set', '--instance-arn', $instanceArn, '--permission-set-arn', [string]$candidate)
        if ([string]$description.PermissionSet.Name -eq $PermissionSetName) {
            if ($permissionSetArn) { throw 'PERMISSION_SET_DUPLICATE' }
            $permissionSetArn = [string]$candidate
        }
    }
    $created = $false
    if (-not $permissionSetArn) {
        $createdResult = Invoke-AwsJson @('sso-admin', 'create-permission-set', '--instance-arn', $instanceArn, '--name', $PermissionSetName, '--description', 'Nana production Release B operator', '--session-duration', $SessionDuration)
        $permissionSetArn = [string]$createdResult.PermissionSet.PermissionSetArn
        $created = $true
    }

    $attachedAwsPolicies = Invoke-AwsJson @('sso-admin', 'list-managed-policies-in-permission-set', '--instance-arn', $instanceArn, '--permission-set-arn', $permissionSetArn)
    if (@($attachedAwsPolicies.AttachedManagedPolicies).Count -ne 0) { throw 'PERMISSION_SET_HAS_AWS_MANAGED_POLICY' }
    $attachedCustomerPolicies = Invoke-AwsJson @('sso-admin', 'list-customer-managed-policy-references-in-permission-set', '--instance-arn', $instanceArn, '--permission-set-arn', $permissionSetArn)
    if (@($attachedCustomerPolicies.CustomerManagedPolicyReferences).Count -ne 0) { throw 'PERMISSION_SET_HAS_CUSTOMER_MANAGED_POLICY' }
    $boundary = Invoke-AwsOptionalJson @('sso-admin', 'get-permissions-boundary-for-permission-set', '--instance-arn', $instanceArn, '--permission-set-arn', $permissionSetArn)
    if ($boundary -and $boundary.PermissionsBoundary) { throw 'PERMISSION_SET_HAS_UNEXPECTED_BOUNDARY' }

    $policy = Get-Content -LiteralPath $PolicyPath -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($RuntimeSecretArn) {
        foreach ($statement in @($policy.Statement)) {
            if ($statement.Sid -eq 'RuntimeSecretExactArnAfterCreation') { $statement.Resource = $RuntimeSecretArn }
        }
    } else {
        $policy.Statement = @($policy.Statement | Where-Object { $_.Sid -ne 'RuntimeSecretExactArnAfterCreation' })
    }
    $desired = Get-CanonicalJson $policy
    [IO.File]::WriteAllText($TempPolicy, $desired, (New-Object Text.UTF8Encoding($false)))

    $current = $null
    try {
        $currentResult = Invoke-AwsJson @('sso-admin', 'get-inline-policy-for-permission-set', '--instance-arn', $instanceArn, '--permission-set-arn', $permissionSetArn)
        if ($currentResult -and $currentResult.InlinePolicy) { $current = Get-CanonicalJson ([string]$currentResult.InlinePolicy | ConvertFrom-Json) }
    } catch { $current = $null }
    $policyChanged = $current -ne $desired
    if ($policyChanged) {
        Invoke-AwsJson @('sso-admin', 'put-inline-policy-to-permission-set', '--instance-arn', $instanceArn, '--permission-set-arn', $permissionSetArn, '--inline-policy', ('file://' + $TempPolicy)) | Out-Null
    }

    $assignments = Invoke-AwsJson @('sso-admin', 'list-account-assignments', '--instance-arn', $instanceArn, '--account-id', $TargetAccountId, '--permission-set-arn', $permissionSetArn)
    $assigned = @($assignments.AccountAssignments | Where-Object { $_.PrincipalType -eq $PrincipalType -and $_.PrincipalId -eq $PrincipalId }).Count -eq 1
    if (-not $assigned) {
        $request = Invoke-AwsJson @('sso-admin', 'create-account-assignment', '--instance-arn', $instanceArn, '--target-id', $TargetAccountId, '--target-type', 'AWS_ACCOUNT', '--permission-set-arn', $permissionSetArn, '--principal-type', $PrincipalType, '--principal-id', $PrincipalId)
        $requestId = [string]$request.AccountAssignmentCreationStatus.RequestId
        do {
            Start-Sleep -Seconds 2
            $state = Invoke-AwsJson @('sso-admin', 'describe-account-assignment-creation-status', '--instance-arn', $instanceArn, '--account-assignment-creation-request-id', $requestId)
            $status = [string]$state.AccountAssignmentCreationStatus.Status
        } while ($status -eq 'IN_PROGRESS')
        if ($status -ne 'SUCCEEDED') { throw 'ACCOUNT_ASSIGNMENT_FAILED' }
    }

    $provision = Invoke-AwsJson @('sso-admin', 'provision-permission-set', '--instance-arn', $instanceArn, '--permission-set-arn', $permissionSetArn, '--target-type', 'AWS_ACCOUNT', '--target-id', $TargetAccountId)
    $provisionId = [string]$provision.PermissionSetProvisioningStatus.RequestId
    do {
        Start-Sleep -Seconds 2
        $state = Invoke-AwsJson @('sso-admin', 'describe-permission-set-provisioning-status', '--instance-arn', $instanceArn, '--provision-permission-set-request-id', $provisionId)
        $status = [string]$state.PermissionSetProvisioningStatus.Status
    } while ($status -eq 'IN_PROGRESS')
    if ($status -ne 'SUCCEEDED') { throw 'PERMISSION_SET_PROVISION_FAILED' }

    $readBack = Invoke-AwsJson @('sso-admin', 'list-account-assignments', '--instance-arn', $instanceArn, '--account-id', $TargetAccountId, '--permission-set-arn', $permissionSetArn)
    $verified = @($readBack.AccountAssignments | Where-Object { $_.PrincipalType -eq $PrincipalType -and $_.PrincipalId -eq $PrincipalId }).Count -eq 1
    if (-not $verified) { throw 'ACCOUNT_ASSIGNMENT_READBACK_FAILED' }

    [PSCustomObject]@{
        status = 'PASS'
        permission_set = $PermissionSetName
        created = $created
        policy_changed = $policyChanged
        policy_sha256 = Get-Sha256 $desired
        account_assignment = 'VERIFIED'
        runtime_secret_access = $(if ($RuntimeSecretArn) { 'EXACT_ARN' } else { 'NOT_YET_GRANTED' })
    } | ConvertTo-Json -Compress
} finally {
    if (Test-Path -LiteralPath $TempPolicy) { Remove-Item -LiteralPath $TempPolicy -Force }
}

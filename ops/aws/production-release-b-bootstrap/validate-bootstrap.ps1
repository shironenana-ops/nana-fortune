[CmdletBinding()]
param(
    [string]$AwsProfile = ''
)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot = (Resolve-Path (Join-Path $Root '..\..\..')).Path
$ExpectedAccount = '388811589005'
$ExpectedRegion = 'ap-northeast-1'
$ExecutionRoleArn = 'arn:aws:iam::388811589005:role/NanaProductionCanonicalRuntimeExecutionRole'
$ArtifactBucketName = 'nana-prod-artifacts-388811589005-apne1'
$ArtifactBucketArn = 'arn:aws:s3:::nana-prod-artifacts-388811589005-apne1'
$ArtifactObjectArn = 'arn:aws:s3:::nana-prod-artifacts-388811589005-apne1/nana-reading-production/release-b/*'

function Assert-True {
    param([bool]$Condition, [string]$Code)
    if (-not $Condition) { throw $Code }
}

function Read-Json {
    param([string]$Path)
    return (Get-Content -LiteralPath $Path -Raw -Encoding UTF8 | ConvertFrom-Json)
}

function As-Array {
    param($Value)
    if ($null -eq $Value) { return @() }
    return @($Value)
}

function Get-Statement {
    param($Policy, [string]$Sid)
    $matches = @(As-Array $Policy.Statement | Where-Object { $_.Sid -eq $Sid })
    Assert-True ($matches.Count -eq 1) ('STATEMENT_COUNT_INVALID_' + $Sid)
    return $matches[0]
}

Assert-True ($ArtifactBucketName -match '^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$') 'ARTIFACT_BUCKET_INVALID'

$contextPath = Join-Path $Root 'resolved-context.json'
$operatorPath = Join-Path $Root 'operator-permission-set-policy.json'
$trustPath = Join-Path $Root 'execution-role-trust-policy.json'
$executionPath = Join-Path $Root 'execution-role-policy.json'
$bootstrapPath = Join-Path $Root 'execution-role-bootstrap.yaml'
$productionTemplatePath = Join-Path $RepoRoot 'infrastructure\reading-production\template.json'

$context = Read-Json $contextPath
$operator = Read-Json $operatorPath
$trust = Read-Json $trustPath
$execution = Read-Json $executionPath
$productionTemplate = Read-Json $productionTemplatePath

Assert-True ($context.production_account_id -eq $ExpectedAccount) 'CONTEXT_ACCOUNT_MISMATCH'
Assert-True ($context.production_region -eq $ExpectedRegion) 'CONTEXT_REGION_MISMATCH'
Assert-True ($context.canonical_stack_name -eq 'nana-reading-production') 'CONTEXT_STACK_MISMATCH'
Assert-True ($context.artifact_bucket.status -eq 'RESOLVED_READ_ONLY_VERIFIED') 'ARTIFACT_BUCKET_NOT_RESOLVED'
Assert-True ($context.artifact_bucket.name -eq $ArtifactBucketName) 'ARTIFACT_BUCKET_NAME_MISMATCH'
Assert-True ($context.artifact_bucket.arn -eq $ArtifactBucketArn) 'ARTIFACT_BUCKET_ARN_MISMATCH'
Assert-True ($context.artifact_bucket.region -eq $ExpectedRegion) 'ARTIFACT_BUCKET_REGION_MISMATCH'
Assert-True ($context.artifact_bucket.prefix -eq 'nana-reading-production/release-b/') 'ARTIFACT_PREFIX_MISMATCH'

$actualTypes = @($productionTemplate.Resources.PSObject.Properties.Value.Type | Sort-Object -Unique)
$expectedTypes = @($context.cloudformation_resource_types | Sort-Object -Unique)
Assert-True (($actualTypes -join "`n") -eq ($expectedTypes -join "`n")) 'CLOUDFORMATION_RESOURCE_TYPES_MISMATCH'
foreach ($roleResource in @($productionTemplate.Resources.PSObject.Properties.Value | Where-Object { $_.Type -eq 'AWS::IAM::Role' })) {
    Assert-True ($null -eq $roleResource.Properties.ManagedPolicyArns) 'RUNTIME_ROLE_MANAGED_POLICY_NOT_ALLOWED'
}

$trustStatements = @(As-Array $trust.Statement)
Assert-True ($trustStatements.Count -eq 1) 'TRUST_STATEMENT_COUNT_INVALID'
Assert-True ($trustStatements[0].Action -eq 'sts:AssumeRole') 'TRUST_ACTION_INVALID'
Assert-True ($trustStatements[0].Principal.Service -eq 'cloudformation.amazonaws.com') 'TRUST_PRINCIPAL_INVALID'

foreach ($policyInfo in @(
    @{ Name = 'operator'; Policy = $operator },
    @{ Name = 'execution'; Policy = $execution }
)) {
    foreach ($statement in @(As-Array $policyInfo.Policy.Statement)) {
        foreach ($action in @(As-Array $statement.Action)) {
            Assert-True (-not ([string]$action).Contains('*')) ('WILDCARD_ACTION_' + $policyInfo.Name + '_' + $statement.Sid)
        }
    }
}

$operatorActions = @($operator.Statement | ForEach-Object { @(As-Array $_.Action) })
foreach ($forbiddenOperatorAction in @(
    'iam:CreateRole', 'iam:DeleteRole', 'iam:PutRolePolicy',
    'lambda:CreateFunction', 'lambda:UpdateFunctionCode', 'lambda:UpdateFunctionConfiguration', 'lambda:DeleteFunction',
    'dynamodb:CreateTable', 'dynamodb:UpdateTable', 'dynamodb:DeleteTable',
    'sqs:CreateQueue', 'sqs:SetQueueAttributes', 'sqs:DeleteQueue',
    'logs:CreateLogGroup', 'logs:DeleteLogGroup',
    'apigateway:POST', 'apigateway:PUT', 'apigateway:PATCH', 'apigateway:DELETE',
    'secretsmanager:CreateSecret', 'secretsmanager:DeleteSecret'
)) {
    Assert-True (-not ($operatorActions -contains $forbiddenOperatorAction)) ('OPERATOR_DIRECT_PROVISIONING_' + ($forbiddenOperatorAction -replace '[^A-Za-z0-9]', '_'))
}

$allowedOperatorStar = @('CallerBoundary', 'ValidateTemplateOnlyInTokyo', 'ListEventSourcesInTokyo')
foreach ($statement in @(As-Array $operator.Statement)) {
    if ($statement.Resource -is [string] -and $statement.Resource -eq '*') {
        Assert-True ($allowedOperatorStar -contains [string]$statement.Sid) ('OPERATOR_RESOURCE_STAR_' + $statement.Sid)
    }
}
$allowedExecutionStar = @('ManageReleaseBEventSourceMappingsInTokyo', 'DescribeLogGroupsForReleaseBResolution')
foreach ($statement in @(As-Array $execution.Statement)) {
    if ($statement.Resource -is [string] -and $statement.Resource -eq '*') {
        Assert-True ($allowedExecutionStar -contains [string]$statement.Sid) ('EXECUTION_RESOURCE_STAR_' + $statement.Sid)
    }
}

$passRole = Get-Statement $operator 'PassExactExecutionRoleToCloudFormationOnly'
Assert-True ($passRole.Action -eq 'iam:PassRole') 'OPERATOR_PASSROLE_ACTION_INVALID'
Assert-True ($passRole.Resource -eq $ExecutionRoleArn) 'OPERATOR_PASSROLE_RESOURCE_INVALID'
Assert-True ($passRole.Condition.StringEquals.'iam:PassedToService' -eq 'cloudformation.amazonaws.com') 'OPERATOR_PASSED_TO_SERVICE_INVALID'

$createChangeSet = Get-Statement $operator 'CreateReleaseBChangeSetWithExactRoleAndTypes'
Assert-True ($createChangeSet.Condition.StringEquals.'cloudformation:RoleArn' -eq $ExecutionRoleArn) 'CHANGE_SET_ROLE_CONDITION_INVALID'
Assert-True ($createChangeSet.Resource -eq 'arn:aws:cloudformation:ap-northeast-1:388811589005:stack/nana-reading-production/*') 'CHANGE_SET_STACK_SCOPE_INVALID'
Assert-True ($createChangeSet.Condition.StringLike.'cloudformation:ChangeSetName' -eq 'nana-reading-production-*') 'CHANGE_SET_NAME_SCOPE_INVALID'
Assert-True ($createChangeSet.Condition.Null.'cloudformation:RoleArn' -eq 'false') 'EXECUTION_ROLE_NOT_REQUIRED'
Assert-True ($createChangeSet.Condition.StringEquals.'cloudformation:TemplateUrl' -eq 'https://nana-prod-artifacts-388811589005-apne1.s3.ap-northeast-1.amazonaws.com/nana-reading-production/release-b/20260806/template-789cc9711056.json') 'CHANGE_SET_TEMPLATE_URL_SCOPE_INVALID'
Assert-True ($createChangeSet.Condition.Null.'cloudformation:TemplateUrl' -eq 'false') 'CHANGE_SET_TEMPLATE_URL_NOT_REQUIRED'
Assert-True (($createChangeSet.Condition.'ForAllValues:StringEquals'.'aws:TagKeys' -join ',') -eq 'Project,Environment,Component,ManagedBy') 'CHANGE_SET_TAG_KEYS_INVALID'
$operateStack = Get-Statement $operator 'OperateOnlyReleaseBStack'
Assert-True ((@(As-Array $operateStack.Action) | Where-Object { $_ -eq 'cloudformation:DeleteStack' }).Count -eq 1) 'DELETE_STACK_PERMISSION_MISSING'
Assert-True ($operateStack.Resource -eq 'arn:aws:cloudformation:ap-northeast-1:388811589005:stack/nana-reading-production/*') 'DELETE_STACK_SCOPE_INVALID'
Assert-True ($operateStack.Condition.StringEquals.'aws:RequestedRegion' -eq 'ap-northeast-1') 'DELETE_STACK_REGION_INVALID'
$bucketRegion = Get-Statement $operator 'ReadArtifactBucketRegion'
$bucketList = Get-Statement $operator 'ListOnlyReleaseBArtifactPrefix'
$bucketObjects = Get-Statement $operator 'ReadWriteOnlyReleaseBArtifacts'
Assert-True ($bucketRegion.Resource -eq $ArtifactBucketArn) 'OPERATOR_BUCKET_REGION_SCOPE_INVALID'
Assert-True ($bucketList.Resource -eq $ArtifactBucketArn) 'OPERATOR_BUCKET_LIST_SCOPE_INVALID'
Assert-True ($bucketObjects.Resource -eq $ArtifactObjectArn) 'OPERATOR_BUCKET_OBJECT_SCOPE_INVALID'
$executionArtifacts = Get-Statement $execution 'ReadReleaseBArtifacts'
Assert-True ($executionArtifacts.Resource -eq $ArtifactObjectArn) 'EXECUTION_BUCKET_SCOPE_INVALID'
$apiTagOnCreate = Get-Statement $execution 'TagOnlyReleaseBHttpApiOnCreate'
Assert-True ($apiTagOnCreate.Action -eq 'apigateway:POST') 'API_TAG_ON_CREATE_ACTION_INVALID'
Assert-True ($apiTagOnCreate.Resource -eq 'arn:aws:apigateway:ap-northeast-1::/tags/arn%3Aaws%3Aapigateway%3Aap-northeast-1%3A%3A%2Fv2%2Fapis%2F*') 'API_TAG_ON_CREATE_RESOURCE_INVALID'
Assert-True (-not ([string]$apiTagOnCreate.Resource).Contains('/restapis/')) 'API_TAG_SCOPE_INCLUDES_REST_API'
Assert-True (-not ([string]$apiTagOnCreate.Resource).Contains('/domainnames/')) 'API_TAG_SCOPE_INCLUDES_DOMAIN'
$logsDescribe = Get-Statement $execution 'DescribeLogGroupsForReleaseBResolution'
Assert-True ($logsDescribe.Action -eq 'logs:DescribeLogGroups') 'LOGS_DESCRIBE_ACTION_INVALID'
Assert-True ($logsDescribe.Resource -eq '*') 'LOGS_DESCRIBE_RESOURCE_INVALID'
Assert-True ($logsDescribe.Condition.StringEquals.'aws:RequestedRegion' -eq 'ap-northeast-1') 'LOGS_DESCRIBE_REGION_INVALID'
$scopedLogs = Get-Statement $execution 'ManageOnlyReleaseBLogGroups'
Assert-True (-not (@(As-Array $scopedLogs.Action) -contains 'logs:DescribeLogGroups')) 'LOGS_DESCRIBE_MIXED_WITH_WRITE_ACTIONS'
$stageTag = Get-Statement $execution 'TagOnlyExactReleaseBProductionStage'
Assert-True ($stageTag.Action -eq 'apigateway:TagResource') 'STAGE_TAG_ACTION_INVALID'
$stageTagResources = @(As-Array $stageTag.Resource)
Assert-True ($stageTagResources.Count -eq 2) 'STAGE_TAG_RESOURCE_COUNT_INVALID'
Assert-True ($stageTagResources -contains 'arn:aws:apigateway:ap-northeast-1::/apis/0co01ka06a/stages') 'STAGE_TAG_COLLECTION_SCOPE_MISSING'
Assert-True ($stageTagResources -contains 'arn:aws:apigateway:ap-northeast-1::/apis/0co01ka06a/stages/production') 'STAGE_TAG_EXACT_SCOPE_MISSING'
Assert-True (-not (($stageTagResources -join "`n").Contains('*'))) 'STAGE_TAG_WILDCARD_FORBIDDEN'

# Cover every AWS service exercised by the 44-resource application template.
$requiredExecutionActions = @{
    ReadReleaseBArtifacts = @('s3:GetObject', 's3:GetObjectVersion')
    ManageOnlyReleaseBRuntimeRoles = @('iam:CreateRole', 'iam:DeleteRole', 'iam:DeleteRolePolicy', 'iam:GetRole', 'iam:GetRolePolicy', 'iam:PutRolePolicy', 'iam:TagRole', 'iam:UntagRole', 'iam:UpdateAssumeRolePolicy')
    PassOnlyReleaseBRuntimeRolesToLambda = @('iam:PassRole')
    ManageOnlyReleaseBFunctions = @('lambda:AddPermission', 'lambda:CreateFunction', 'lambda:DeleteFunction', 'lambda:GetFunction', 'lambda:GetFunctionConfiguration', 'lambda:ListTags', 'lambda:PutFunctionConcurrency', 'lambda:RemovePermission', 'lambda:TagResource', 'lambda:UntagResource', 'lambda:UpdateFunctionCode', 'lambda:UpdateFunctionConfiguration')
    ManageReleaseBEventSourceMappingsInTokyo = @('lambda:CreateEventSourceMapping', 'lambda:DeleteEventSourceMapping', 'lambda:GetEventSourceMapping', 'lambda:UpdateEventSourceMapping')
    ManageOnlyReleaseBTables = @('dynamodb:CreateTable', 'dynamodb:DeleteTable', 'dynamodb:DescribeContinuousBackups', 'dynamodb:DescribeTable', 'dynamodb:DescribeTimeToLive', 'dynamodb:TagResource', 'dynamodb:UntagResource', 'dynamodb:UpdateContinuousBackups', 'dynamodb:UpdateTable', 'dynamodb:UpdateTimeToLive')
    ManageOnlyReleaseBQueues = @('sqs:CreateQueue', 'sqs:DeleteQueue', 'sqs:GetQueueAttributes', 'sqs:SetQueueAttributes', 'sqs:TagQueue', 'sqs:UntagQueue')
    ManageOnlyReleaseBLogGroups = @('logs:CreateLogGroup', 'logs:DeleteLogGroup', 'logs:ListTagsForResource', 'logs:PutRetentionPolicy', 'logs:TagResource', 'logs:UntagResource')
    DescribeLogGroupsForReleaseBResolution = @('logs:DescribeLogGroups')
    ManageOnlyReleaseBHttpApi = @('apigateway:DELETE', 'apigateway:GET', 'apigateway:PATCH', 'apigateway:POST', 'apigateway:PUT')
    TagOnlyReleaseBHttpApiOnCreate = @('apigateway:POST')
    TagOnlyExactReleaseBProductionStage = @('apigateway:TagResource')
    ManageOnlyReleaseBAlarms = @('cloudwatch:DeleteAlarms', 'cloudwatch:DescribeAlarms', 'cloudwatch:PutMetricAlarm', 'cloudwatch:TagResource', 'cloudwatch:UntagResource')
    ManageOnlyCanonicalRuntimeSecret = @('secretsmanager:CreateSecret', 'secretsmanager:DescribeSecret', 'secretsmanager:GetSecretValue', 'secretsmanager:PutSecretValue', 'secretsmanager:TagResource', 'secretsmanager:UntagResource')
}
foreach ($statementName in $requiredExecutionActions.Keys) {
    $statement = Get-Statement $execution $statementName
    $actualActions = @(As-Array $statement.Action)
    foreach ($requiredAction in $requiredExecutionActions[$statementName]) {
        Assert-True ($actualActions -contains $requiredAction) ('EXECUTION_ACTION_MISSING_' + ($requiredAction -replace '[^A-Za-z0-9]', '_'))
    }
}

$operatorText = Get-Content -LiteralPath $operatorPath -Raw -Encoding UTF8
$executionText = Get-Content -LiteralPath $executionPath -Raw -Encoding UTF8
$bootstrapText = Get-Content -LiteralPath $bootstrapPath -Raw -Encoding UTF8
$allText = $operatorText + "`n" + $executionText + "`n" + $bootstrapText

foreach ($forbidden in @(
    'iam:CreateUser', 'iam:CreateAccessKey', 'iam:UpdateAccessKey',
    'organizations:', 'sso-admin:', 'identitystore:',
    's3:DeleteObject', 's3:DeleteBucket', 's3:PutBucketPolicy', 's3:PutBucketAcl',
    'fincode', 'payment:', 'shirone-staging', ':staging:'
)) {
    Assert-True (-not $allText.Contains($forbidden)) ('FORBIDDEN_CAPABILITY_' + ($forbidden -replace '[^A-Za-z0-9]', '_'))
}

$renderedOperator = $operatorText | ConvertFrom-Json
$renderedOperator.Statement = @($renderedOperator.Statement | Where-Object { $_.Sid -ne 'RuntimeSecretExactArnAfterCreation' })
$renderedOperatorText = $renderedOperator | ConvertTo-Json -Depth 100 -Compress
Assert-True ([Text.Encoding]::UTF8.GetByteCount($renderedOperatorText) -le 32768) 'IDENTITY_CENTER_INLINE_POLICY_TOO_LARGE'

$executionSerialized = $execution | ConvertTo-Json -Depth 100 -Compress
Assert-True (-not $executionSerialized.Contains('arn:aws:dynamodb:ap-northeast-1:388811589005:table/shirone7_users')) 'EXECUTION_ROLE_CAN_MUTATE_LEGACY_USERS'
Assert-True (-not $executionSerialized.Contains('arn:aws:dynamodb:ap-northeast-1:388811589005:table/shirone7_history')) 'EXECUTION_ROLE_CAN_MUTATE_LEGACY_HISTORY'

Assert-True ($bootstrapText.Contains('RoleName: NanaProductionCanonicalRuntimeExecutionRole')) 'BOOTSTRAP_ROLE_NAME_MISSING'
Assert-True ($bootstrapText.Contains('Service: cloudformation.amazonaws.com')) 'BOOTSTRAP_TRUST_INVALID'
Assert-True (($bootstrapText -split 'DeletionPolicy: Retain').Count -eq 3) 'BOOTSTRAP_RETAIN_INVALID'
Assert-True ($bootstrapText.Contains('Type: AWS::SecretsManager::Secret')) 'BOOTSTRAP_RUNTIME_SECRET_MISSING'
Assert-True ($bootstrapText.Contains('Name: shirone7/production/runtime')) 'BOOTSTRAP_RUNTIME_SECRET_NAME_INVALID'
Assert-True ($bootstrapText.Contains('SecretString: "{}"')) 'BOOTSTRAP_RUNTIME_SECRET_INITIAL_VALUE_INVALID'
Assert-True (-not $bootstrapText.Contains('AWS::Lambda::Function')) 'BOOTSTRAP_CONTAINS_APPLICATION_RESOURCE'
Assert-True (-not $bootstrapText.Contains('AWS::DynamoDB::Table')) 'BOOTSTRAP_CONTAINS_APPLICATION_RESOURCE'

foreach ($path in @($contextPath, $operatorPath, $trustPath, $executionPath, $bootstrapPath)) {
    $content = Get-Content -LiteralPath $path -Raw -Encoding UTF8
    Assert-True ($content -notmatch 'AKIA[0-9A-Z]{16}') 'ACCESS_KEY_PATTERN_FOUND'
    Assert-True ($content -notmatch 'ASIA[0-9A-Z]{16}') 'TEMP_ACCESS_KEY_PATTERN_FOUND'
    Assert-True ($content -notmatch '-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----') 'PRIVATE_KEY_PATTERN_FOUND'
}

if ($AwsProfile) {
    $identityText = & aws sts get-caller-identity --profile $AwsProfile --region $ExpectedRegion --no-cli-pager --output json 2>$null
    Assert-True ($LASTEXITCODE -eq 0) 'AWS_CALLER_IDENTITY_FAILED'
    $identity = ($identityText -join "`n") | ConvertFrom-Json
    Assert-True ([string]$identity.Account -eq $ExpectedAccount) 'AWS_ACCOUNT_MISMATCH'
    & aws s3api head-bucket --bucket $ArtifactBucketName --expected-bucket-owner $ExpectedAccount --profile $AwsProfile --region $ExpectedRegion --no-cli-pager 1>$null 2>$null
    Assert-True ($LASTEXITCODE -eq 0) 'AWS_ARTIFACT_BUCKET_OWNER_FAILED'
    $bucketLocationText = & aws s3api get-bucket-location --bucket $ArtifactBucketName --expected-bucket-owner $ExpectedAccount --profile $AwsProfile --region $ExpectedRegion --no-cli-pager --output json 2>$null
    Assert-True ($LASTEXITCODE -eq 0) 'AWS_ARTIFACT_BUCKET_REGION_FAILED'
    $bucketLocation = ($bucketLocationText -join "`n") | ConvertFrom-Json
    Assert-True ([string]$bucketLocation.LocationConstraint -eq $ExpectedRegion) 'AWS_ARTIFACT_BUCKET_REGION_MISMATCH'
    & aws cloudformation validate-template --template-body ('file://' + $bootstrapPath) --profile $AwsProfile --region $ExpectedRegion --no-cli-pager --output json 1>$null 2>$null
    Assert-True ($LASTEXITCODE -eq 0) 'AWS_VALIDATE_TEMPLATE_FAILED'
}

Push-Location $RepoRoot
try {
    & git diff --check
    Assert-True ($LASTEXITCODE -eq 0) 'GIT_DIFF_CHECK_FAILED'
} finally {
    Pop-Location
}

[PSCustomObject]@{
    status = 'PASS'
    account = 'PRODUCTION_BOUNDARY_FIXED'
    region = $ExpectedRegion
    artifact_bucket = 'EXACT_ARN_PREFIX_VALIDATED'
    operator_pass_role = 'EXACT_EXECUTION_ROLE_CLOUDFORMATION_ONLY'
    execution_trust = 'CLOUDFORMATION_ONLY'
    wildcard_actions = 0
    long_term_access_keys = 0
    aws_validation = $(if ($AwsProfile) { 'PASS' } else { 'NOT_REQUESTED' })
} | ConvertTo-Json -Compress

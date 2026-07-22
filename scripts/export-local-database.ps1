[CmdletBinding()]
param(
    [string]$EnvFile = (Join-Path $PSScriptRoot "..\.env"),
    [string]$OutputDirectory = (Join-Path $PSScriptRoot "..\migration-artifacts"),
    [string]$PostgresBin = "E:\pgsql\bin"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Read-DotEnvFile {
    param([Parameter(Mandatory)][string]$Path)

    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        throw "Environment file not found: $Path"
    }

    $values = @{}
    foreach ($line in Get-Content -LiteralPath $Path) {
        $trimmed = $line.Trim()
        if (-not $trimmed -or $trimmed.StartsWith("#")) {
            continue
        }

        $separator = $trimmed.IndexOf("=")
        if ($separator -lt 1) {
            continue
        }

        $name = $trimmed.Substring(0, $separator).Trim()
        $value = $trimmed.Substring($separator + 1).Trim()
        if ($value.Length -ge 2) {
            $first = $value[0]
            $last = $value[$value.Length - 1]
            if (($first -eq '"' -and $last -eq '"') -or ($first -eq "'" -and $last -eq "'")) {
                $value = $value.Substring(1, $value.Length - 2)
            }
        }

        $values[$name] = $value
    }

    return $values
}

function Invoke-PsqlValues {
    param(
        [Parameter(Mandatory)][string]$PsqlPath,
        [Parameter(Mandatory)][string]$Sql
    )

    $arguments = @(
        "--no-psqlrc",
        "--tuples-only",
        "--no-align",
        "--set=ON_ERROR_STOP=1",
        "--command=$Sql"
    )
    $output = @(& $PsqlPath @arguments)
    if ($LASTEXITCODE -ne 0) {
        throw "psql failed while collecting the migration manifest"
    }
    return @($output | ForEach-Object { ([string]$_).Trim() } | Where-Object { $_ })
}

function Quote-PgIdentifier {
    param([Parameter(Mandatory)][string]$Value)
    return '"' + $Value.Replace('"', '""') + '"'
}

function Get-TableSnapshot {
    param([Parameter(Mandatory)][string]$PsqlPath)

    $separator = [char]31
    $tableSql = @"
SELECT schemaname || chr(31) || tablename
FROM pg_tables
WHERE schemaname NOT IN ('pg_catalog', 'information_schema')
  AND schemaname NOT LIKE 'pg_toast%'
ORDER BY schemaname, tablename
"@
    $tableLines = @(Invoke-PsqlValues -PsqlPath $PsqlPath -Sql $tableSql)
    $snapshot = @()

    foreach ($line in $tableLines) {
        $parts = $line.Split($separator, 2)
        if ($parts.Count -ne 2) {
            throw "Could not parse a PostgreSQL table name while building the manifest"
        }

        $schema = $parts[0]
        $table = $parts[1]
        $qualifiedTable = "$(Quote-PgIdentifier $schema).$(Quote-PgIdentifier $table)"
        $countLines = @(Invoke-PsqlValues -PsqlPath $PsqlPath -Sql "SELECT count(*) FROM $qualifiedTable")
        if ($countLines.Count -ne 1) {
            throw "Could not obtain an exact row count for $qualifiedTable"
        }

        $rowCount = 0L
        if (-not [long]::TryParse($countLines[0], [ref]$rowCount) -or $rowCount -lt 0) {
            throw "PostgreSQL returned an invalid row count for $qualifiedTable"
        }

        $snapshot += [ordered]@{
            schema = $schema
            table  = $table
            rows   = $rowCount
        }
    }

    return @($snapshot)
}

$configuration = Read-DotEnvFile -Path (Resolve-Path -LiteralPath $EnvFile)
$requiredNames = @("PGHOST", "PGPORT", "PGDATABASE", "PGUSER", "PGPASSWORD")
foreach ($name in $requiredNames) {
    if (-not $configuration.ContainsKey($name) -or [string]::IsNullOrWhiteSpace($configuration[$name])) {
        throw "Required setting $name is missing from $EnvFile"
    }
}

$pgDump = Join-Path $PostgresBin "pg_dump.exe"
$pgRestore = Join-Path $PostgresBin "pg_restore.exe"
$psql = Join-Path $PostgresBin "psql.exe"
foreach ($tool in @($pgDump, $pgRestore, $psql)) {
    if (-not (Test-Path -LiteralPath $tool -PathType Leaf)) {
        throw "PostgreSQL tool not found: $tool"
    }
}

$pgDumpVersionOutput = @(& $pgDump --version)
$pgDumpVersionExitCode = $LASTEXITCODE
$pgDumpVersion = ($pgDumpVersionOutput | Select-Object -First 1)
if ($pgDumpVersionExitCode -ne 0 -or $pgDumpVersion -notmatch '^pg_dump \(PostgreSQL\) 15\.') {
    throw "This export must use PostgreSQL 15 pg_dump; found: $pgDumpVersion"
}

$resolvedOutputDirectory = [System.IO.Path]::GetFullPath($OutputDirectory)
New-Item -ItemType Directory -Path $resolvedOutputDirectory -Force | Out-Null
$timestamp = (Get-Date).ToUniversalTime().ToString("yyyyMMddTHHmmssZ")
$baseName = "speedfeast-$timestamp"
$outputPath = Join-Path $resolvedOutputDirectory "$baseName.dump"
$manifestPath = Join-Path $resolvedOutputDirectory "$baseName.manifest.json"

$environmentNames = @("PGHOST", "PGPORT", "PGDATABASE", "PGUSER", "PGPASSWORD", "PGSSLMODE")
$previousEnvironment = @{}
foreach ($name in $environmentNames) {
    $previousEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, "Process")
    if ($configuration.ContainsKey($name)) {
        [Environment]::SetEnvironmentVariable($name, $configuration[$name], "Process")
    }
}

try {
    Write-Host "Capturing exact table row counts before the export..."
    $beforeSnapshot = @(Get-TableSnapshot -PsqlPath $psql)
    if ($beforeSnapshot.Count -eq 0) {
        throw "The source database does not contain any user tables"
    }

    $sourceServerVersion = (Invoke-PsqlValues -PsqlPath $psql -Sql "SHOW server_version" | Select-Object -First 1)

    Write-Host "Exporting PostgreSQL database to a Git-ignored custom-format archive..."
    & $pgDump `
        --format=custom `
        --compress=6 `
        --no-owner `
        --no-acl `
        --file=$outputPath
    if ($LASTEXITCODE -ne 0) {
        throw "pg_dump failed with exit code $LASTEXITCODE"
    }

    & $pgRestore --list $outputPath | Out-Null
    if ($LASTEXITCODE -ne 0) {
        throw "pg_restore could not read the generated archive"
    }

    Write-Host "Confirming table row counts did not change during the export..."
    $afterSnapshot = @(Get-TableSnapshot -PsqlPath $psql)
    $beforeCanonical = ConvertTo-Json -InputObject $beforeSnapshot -Compress -Depth 5
    $afterCanonical = ConvertTo-Json -InputObject $afterSnapshot -Compress -Depth 5
    if ($beforeCanonical -cne $afterCanonical) {
        throw "Table row counts changed during export. Stop local writes and run the export again."
    }

    $archiveHash = (Get-FileHash -LiteralPath $outputPath -Algorithm SHA256).Hash.ToLowerInvariant()
    $manifest = [ordered]@{
        format              = "speedfeast-database-migration-manifest/v1"
        sourceDatabase      = $configuration["PGDATABASE"]
        generatedAtUtc      = (Get-Date).ToUniversalTime().ToString("o")
        sourceServerVersion = $sourceServerVersion
        pgDumpVersion       = $pgDumpVersion
        archiveFile         = [System.IO.Path]::GetFileName($outputPath)
        archiveSha256       = $archiveHash
        tables              = $afterSnapshot
    }
    $manifestJson = (ConvertTo-Json -InputObject $manifest -Depth 8) + "`n"
    [System.IO.File]::WriteAllText(
        $manifestPath,
        $manifestJson,
        [System.Text.UTF8Encoding]::new($false)
    )

    $archiveSize = (Get-Item -LiteralPath $outputPath).Length
    $manifestHash = (Get-FileHash -LiteralPath $manifestPath -Algorithm SHA256).Hash.ToLowerInvariant()
    [long]$totalRows = 0
    foreach ($tableSnapshot in $afterSnapshot) {
        $totalRows += [long]$tableSnapshot["rows"]
    }

    Write-Host "Database export completed."
    Write-Host "Archive:         $outputPath"
    Write-Host "Archive bytes:   $archiveSize"
    Write-Host "Archive SHA256:  $archiveHash"
    Write-Host "Manifest:        $manifestPath"
    Write-Host "Manifest SHA256: $manifestHash"
    Write-Host "Verified tables: $($afterSnapshot.Count)"
    Write-Host "Verified rows:   $totalRows"
    Write-Host "Keep both files out of Git and upload them only to the private S3 _migration/ prefix."
}
finally {
    foreach ($name in $environmentNames) {
        [Environment]::SetEnvironmentVariable($name, $previousEnvironment[$name], "Process")
    }
}

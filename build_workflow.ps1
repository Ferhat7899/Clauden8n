#
# build_workflow.ps1 — assemble dist/AgroWorld_OrderIntake_V8.1.json
#
# Reads every lib/*.js file, JSON-escapes it, and splices it into a full
# n8n workflow JSON. The resulting file is a single importable workflow.
#
# Run from repo root:  powershell -NoProfile -ExecutionPolicy Bypass -File build_workflow.ps1
#

[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

function Read-Lib($name) {
    return [System.IO.File]::ReadAllText((Join-Path $PSScriptRoot "lib/$name"))
}

function Esc($s) {
    # ConvertTo-Json already produces a valid JSON string (including quotes).
    # Strip outer quotes so it can be inserted as an unquoted literal into the
    # template; the template supplies its own surrounding quotes.
    $j = ConvertTo-Json -InputObject $s -Compress -Depth 1
    return $j.Substring(1, $j.Length - 2)
}

$normalize = Esc (Read-Lib 'normalize_email.js')
$dedupe    = Esc (Read-Lib 'dedupe.js')
$hpt       = Esc (Read-Lib 'hpt.js')
$customers = Esc (Read-Lib 'customers.js')
$validate  = Esc (Read-Lib 'validate_upload.js')
$finalize  = Esc (Read-Lib 'finalize.js')
$common    = Esc (Read-Lib 'common.js')

$template = [System.IO.File]::ReadAllText((Join-Path $PSScriptRoot 'dist/_workflow_template.json'))

$out = $template `
    -replace '__NORMALIZE_EMAIL_JS__', $normalize `
    -replace '__DEDUPE_JS__',          $dedupe    `
    -replace '__HPT_JS__',             $hpt       `
    -replace '__CUSTOMERS_JS__',       $customers `
    -replace '__VALIDATE_UPLOAD_JS__', $validate  `
    -replace '__FINALIZE_JS__',        $finalize  `
    -replace '__COMMON_JS__',          $common

$distDir = Join-Path $PSScriptRoot 'dist'
if (-not (Test-Path $distDir)) { New-Item -ItemType Directory -Path $distDir | Out-Null }
$outPath = Join-Path $distDir 'AgroWorld_OrderIntake_V8.1.json'

# Validate JSON using .NET's JavaScriptSerializer (portable across PS 5.1 and 7).
try {
    Add-Type -AssemblyName System.Web.Extensions
    $ser = New-Object System.Web.Script.Serialization.JavaScriptSerializer
    $ser.MaxJsonLength = [int]::MaxValue
    $ser.RecursionLimit = 1000
    $null = $ser.DeserializeObject($out)
} catch {
    Write-Host "JSON validation FAILED: $($_.Exception.Message)"
    exit 1
}

[System.IO.File]::WriteAllText($outPath, $out, [System.Text.UTF8Encoding]::new($false))

Write-Host "Wrote $outPath ($($out.Length) chars, validated)"

#
# build_sdk.ps1 — produce dist/workflow.sdk.js for the n8n SDK validator/deployer.
#
# Reads every lib/*.js, turns each into a JSON-escaped JS string literal,
# then splices them into the SDK source template.
#
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

function Read-Lib($name) {
    $raw = [System.IO.File]::ReadAllText((Join-Path $PSScriptRoot "lib/$name"))
    # Strip /** */ block comments.
    $stripped = [System.Text.RegularExpressions.Regex]::Replace($raw, '/\*[\s\S]*?\*/', '')
    # Strip // line comments (only full-line; don't touch URLs).
    $stripped = [System.Text.RegularExpressions.Regex]::Replace($stripped, '(?m)^\s*//.*$', '')
    # Collapse blank lines.
    $stripped = [System.Text.RegularExpressions.Regex]::Replace($stripped, "(\r?\n){2,}", "`n")
    $stripped.Trim()
}
function JsStr($s) {
    # ConvertTo-Json wraps in double quotes and escapes \, ", newline, tab, unicode.
    # Result is a valid JavaScript string literal.
    ConvertTo-Json -InputObject $s -Compress -Depth 1
}

$normalize = JsStr (Read-Lib 'normalize_email.js')
$dedupe    = JsStr (Read-Lib 'dedupe.js')
$hpt       = JsStr (Read-Lib 'hpt.js')
$customers = JsStr (Read-Lib 'customers.js')
$validate  = JsStr (Read-Lib 'validate_upload.js')
$finalize  = JsStr (Read-Lib 'finalize.js')

$template = [System.IO.File]::ReadAllText((Join-Path $PSScriptRoot 'dist/_workflow_sdk_template.js'))

$out = $template `
    -replace "'__NORMALIZE_EMAIL_JS__'", $normalize `
    -replace "'__DEDUPE_JS__'",          $dedupe    `
    -replace "'__HPT_JS__'",             $hpt       `
    -replace "'__CUSTOMERS_JS__'",       $customers `
    -replace "'__VALIDATE_UPLOAD_JS__'", $validate  `
    -replace "'__FINALIZE_JS__'",        $finalize

$outPath = Join-Path $PSScriptRoot 'dist/workflow.sdk.js'
[System.IO.File]::WriteAllText($outPath, $out, [System.Text.UTF8Encoding]::new($false))
Write-Host "Wrote $outPath ($($out.Length) chars)"

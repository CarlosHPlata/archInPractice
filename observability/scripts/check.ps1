# Checks the homework: the failing order must now return 201 and a flag.
# Usage: .\scripts\check.ps1
$url = if ($env:ORDERS_URL) { $env:ORDERS_URL } else { 'http://localhost:8080/orders' }
$body = '{"customerId":"c-1002","cartId":"cart-7"}'

Write-Host "POST $url"
Write-Host "     $body"
Write-Host ''

$status = 0; $content = ''; $traceId = ''
try {
    $r = Invoke-WebRequest -Uri $url -Method Post -ContentType 'application/json' -Body $body -UseBasicParsing -TimeoutSec 15
    $status = [int]$r.StatusCode
    $content = [string]$r.Content
    $traceId = [string]$r.Headers['x-trace-id']
}
catch {
    $resp = $_.Exception.Response
    if ($null -eq $resp) {
        Write-Host 'FAIL: could not reach the gateway. Is the stack running? (docker compose up --build)'
        exit 1
    }
    $status = [int]$resp.StatusCode
    if ($_.ErrorDetails -and $_.ErrorDetails.Message) {
        $content = $_.ErrorDetails.Message                      # PowerShell 7
    }
    else {
        $reader = New-Object System.IO.StreamReader($resp.GetResponseStream())   # Windows PowerShell 5.1
        $content = $reader.ReadToEnd()
    }
    try { $traceId = [string]$resp.Headers['x-trace-id'] } catch { }
    if (-not $traceId) {
        try { $traceId = [string]($resp.Headers.GetValues('x-trace-id') | Select-Object -First 1) } catch { }
    }
}

$flag = ''
if ($content -match 'FLAG\{[^}"]*\}') { $flag = $Matches[0] }
$shownTrace = if ($traceId) { $traceId } else { '(none: the request reached orders without a trace id)' }

Write-Host "HTTP status : $status"
Write-Host "Body        : $content"
Write-Host "x-trace-id  : $shownTrace"
Write-Host ''

if ($status -eq 201 -and $flag) {
    if (-not $traceId) {
        Write-Host 'ALMOST: the order works, but there is still no trace id. Tracing at the gateway is part of the homework.'
        exit 1
    }
    Write-Host "PASS: the order was created. Your flag is $flag"
    exit 0
}

Write-Host "FAIL: expected HTTP 201 with a flag, got HTTP $status."
if (-not $traceId) {
    Write-Host '      Next step: no trace id yet, so the logs of the services cannot be correlated. Start at the gateway.'
}
else {
    Write-Host "      Next step: follow trace $traceId in Grafana (logs and trace) to find where the order goes wrong."
}
exit 1

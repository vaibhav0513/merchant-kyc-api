# Helper for testing the API from PowerShell.
# Usage (note the leading dot and space): . .\scripts\login.ps1

$BASE = 'http://localhost:3000'

function Login($email) {
  $body = @{ email = $email; password = 'Demo@1234' } | ConvertTo-Json
  $t = (Invoke-RestMethod -Method Post -Uri "$BASE/api/auth/login" -ContentType 'application/json' -Body $body).token
  @{ Authorization = "Bearer $t" }
}

# demo users from the seed script (fictional, demo password only)
$merchant1 = Login 'merchant1@demo.test'
$merchant2 = Login 'merchant2@demo.test'
$maker     = Login 'maker1@demo.test'
$maker2    = Login 'maker2@demo.test'
$checker   = Login 'checker1@demo.test'
$admin     = Login 'admin1@demo.test'

Write-Host 'Logged in as merchant1, merchant2, maker, maker2, checker, admin'
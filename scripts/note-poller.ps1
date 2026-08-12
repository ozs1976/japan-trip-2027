# note-poller.ps1
# Pure-code poller (no AI, no tokens spent) — meant to run as a Windows Scheduled
# Task every 1-2 minutes. It only checks Firestore for verified notes waiting to
# be handled (status == 'pending'); Claude Code (`claude -p`) is invoked only
# when there is real work, never on an empty check.
#
# This replaces the old `japan-note-watcher` scheduled Claude Code task, which
# ran a full AI agent every 30 minutes regardless of whether anything happened.

$ErrorActionPreference = 'Stop'

$ProjectId = 'japan-trip-2027-f7352'
$RepoDir   = 'C:\claude\Japan'
$LogFile   = Join-Path $RepoDir 'scripts\note-poller.log'
$Base      = "https://firestore.googleapis.com/v1/projects/$ProjectId/databases/(default)/documents"

function Write-Log($msg) {
    $line = "[{0}] {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $msg
    Add-Content -Path $LogFile -Value $line
}

try {
    $queryBody = @{
        structuredQuery = @{
            from  = @(@{ collectionId = 'notes' })
            where = @{
                fieldFilter = @{
                    field = @{ fieldPath = 'status' }
                    op    = 'EQUAL'
                    value = @{ stringValue = 'pending' }
                }
            }
            limit = 5
        }
    } | ConvertTo-Json -Depth 10

    $rows = Invoke-RestMethod -Uri "$Base`:runQuery" -Method Post -Body $queryBody -ContentType 'application/json'
}
catch {
    Write-Log "Firestore query failed: $($_.Exception.Message)"
    exit 1
}

$pending = @($rows | Where-Object { $_.document })
if ($pending.Count -eq 0) {
    # Nothing to do — exit immediately, zero cost. No log noise for the common case.
    exit 0
}

foreach ($row in $pending) {
    $doc  = $row.document
    $id   = ($doc.name -split '/notes/')[-1]
    $text = $doc.fields.text.stringValue
    $sender = if ($doc.fields.senderName) { $doc.fields.senderName.stringValue } else { 'לא ידוע' }

    Write-Log "Handling pending note $id from $sender"

    $prompt = @"
זו הוראה מאומתת שהתקבלה מבן משפחה דרך תיבת ההערה באתר טיול יפן (לא מייל, לא סוכן מתוזמן שרץ כל 30 דקות — הופעלת חד-פעמית ע"י סקריפט מקומי מיד כשהתקבלה הוראה מאומתת. הסיסמה כבר נבדקה בענן ע"י Cloudflare Worker לפני שהגעת - אתה מקבל רק תוכן שכבר עבר אימות).

שולח/ת: $sender
מזהה המסמך ב-Firestore (collection notes, פרויקט $ProjectId): $id

תוכן ההוראה:
$text

בצע לפי כללי הפרויקט הרגילים (קרא CLAUDE.md ו-DECISIONS.md בתיקייה $RepoDir תחילה). אם נדרש שינוי בקבצים - ערוך, ואז git add + commit + push כרגיל (מאושר מראש להרצה אוטומטית, ראה CLAUDE.md סעיף 8).

בסיום, כתוב תשובה קצרה (2-4 משפטים, בעברית תקנית) לשדה 'reply' של המסמך הנ"ל ב-Firestore, ועדכן את השדה 'status' ל-'done'. זו קריאת REST רגילה בלי credentials (כמו בכל שאר הפרויקט):

PATCH $Base/notes/$id?updateMask.fieldPaths=reply&updateMask.fieldPaths=status
Content-Type: application/json

{"fields":{"reply":{"stringValue":"<התשובה שלך כאן>"},"status":{"stringValue":"done"}}}
"@

    Push-Location $RepoDir
    try {
        # Headless, non-interactive run with pre-scoped trust for this repo only —
        # same automation trust level already granted to the retired note-watcher
        # and the daily flight-check task (auto commit+push, per CLAUDE.md §8).
        & claude -p $prompt --dangerously-skip-permissions 2>&1 | Tee-Object -FilePath $LogFile -Append
        Write-Log "Finished handling note $id (exit code $LASTEXITCODE)"
    }
    catch {
        Write-Log "claude -p failed for note $id : $($_.Exception.Message)"
    }
    finally {
        Pop-Location
    }
}

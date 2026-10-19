# Rehearse merging the latest upstream release tag into a throwaway branch.
# Never pushes. Only deletes the temporary rehearsal branch it creates itself.
# Usage: pwsh scripts/vibe/upstream-merge-rehearsal.ps1 [-Remote upstream] [-Tag v0.12.1]
param(
  [string]$Remote = "upstream",
  [string]$Tag = ""
)
$ErrorActionPreference = "Stop"

function Invoke-Git { & git @args; if ($LASTEXITCODE -ne 0) { throw "git $args failed ($LASTEXITCODE)" } }

if (git status --porcelain) { throw "Working tree is not clean; commit or stash first." }
$orig = (git rev-parse --abbrev-ref HEAD).Trim()
$origSha = (git rev-parse HEAD).Trim()

Invoke-Git fetch $Remote --tags --quiet
if (-not $Tag) {
  # Latest stable release tag (no -beta/-rc suffix), by semver order.
  $Tag = git tag --sort=-v:refname | Where-Object { $_ -match '^v\d+\.\d+\.\d+$' } | Select-Object -First 1
}
if (-not $Tag) { throw "No release tag found." }
Write-Host "Base: $orig @ $($origSha.Substring(0,9)); upstream release: $Tag"

git merge-base --is-ancestor $Tag HEAD
if ($LASTEXITCODE -eq 0) { Write-Host "RESULT: $Tag is already merged. Nothing to do."; exit 0 }

$tmp = "rehearsal/$Tag-" + (Get-Date -Format "yyyyMMddHHmmss")
Invoke-Git checkout -b $tmp
$conflicts = @()
try {
  git merge --no-commit --no-ff $Tag *> $null
  $conflicts = @(git diff --name-only --diff-filter=U)
  if (Test-Path (Join-Path (git rev-parse --git-dir) "MERGE_HEAD")) { git merge --abort }
} finally {
  git checkout $orig --quiet
  git branch -d $tmp --quiet 2>$null
}

# Files touched by [core] commits that are not yet in the release tag.
$coreFiles = @(git log "$Tag..HEAD" --grep '^\[core\]' --name-only --format= | Where-Object { $_ } | Sort-Object -Unique)
$both = @($conflicts | Where-Object { $coreFiles -contains $_ })

Write-Host "Conflicting files: $($conflicts.Count)"; $conflicts | ForEach-Object { Write-Host "  $_" }
Write-Host "Conflicts overlapping [core] commits: $($both.Count)"; $both | ForEach-Object { Write-Host "  $_" }
Write-Host ("RESULT: " + $(if ($conflicts.Count -eq 0) { "clean merge" } else { "needs manual resolution" }))
Write-Host "Back on $orig @ $((git rev-parse --short HEAD).Trim()). Nothing pushed."



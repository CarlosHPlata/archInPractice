#!/usr/bin/env bash
#
# Tags HEAD with the next release version and pushes the tag to origin; the tag
# push triggers the "Observability: push images" workflow, which builds the
# observer-* images that changed since the previous release (the three services
# and the observability tools with their configuration from ops/) and pushes
# them to the tailnet registry. Images that did not change are left alone.
#
#   observability/scripts/bump.sh                 checks, menu, confirmation
#   observability/scripts/bump.sh --minor -y      checks only, no questions
#
# All options: observability/scripts/bump.sh --help
set -euo pipefail

readonly RELEASE_BRANCH=master
readonly REMOTE=origin
# vX.Y.Z without leading zeros: bash would read "08" as octal and fail.
readonly STABLE_TAG='^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$'
readonly USAGE='usage: bump.sh [--major | --minor | --patch | --alpha | --beta] [-y] [--dry-run]'
LEVELS=(major minor patch alpha beta)

usage() {
  cat <<EOF
$USAGE

Tags HEAD with the next release version and pushes the tag to $REMOTE.
Without a level it shows a menu; before pushing it asks for confirmation.

A release only publishes the images whose folder changed since the previous
release; they are listed before anything is asked. With none, there is
nothing to release and the script stops.

  --major      v1.1.1 → v2.0.0
  --minor      v1.1.1 → v1.2.0
  --patch      v1.1.1 → v1.1.2
  --alpha      v1.1.1 → v1.1.1-alpha
  --beta       v1.1.1 → v1.1.1-beta
  -y, --yes    push without asking
  --dry-run    only show the images and the next version: no checks, no tag, no push
  -h, --help   show this help

Before anything is tagged it checks that you are on $RELEASE_BRANCH with no
modified, staged or untracked files, and level with $REMOTE/$RELEASE_BRANCH.

The base is the highest stable tag (vX.Y.Z); alpha and beta tags are ignored.
With no tags yet it counts from v0.0.0.
EOF
}

usage_error() {
  echo "error: $*" >&2
  echo "$USAGE   (--help for details)" >&2
  exit 2
}

die() {
  echo "error: $*" >&2
  exit 1
}

check_ok() {
  echo "  ✓ $*"
}

# A pushed tag is a published release, so only tag what is on the release branch.
# Runs before the menu so nobody answers questions for a release that can't happen.
preflight() {
  local branch sha
  echo "Checking before release:"

  branch=$(git branch --show-current)
  [[ "$branch" == "$RELEASE_BRANCH" ]] \
    || die "releases are tagged from '$RELEASE_BRANCH', you are on '${branch:-a detached HEAD}'"
  check_ok "on $RELEASE_BRANCH"

  if [[ -n "$(git status --porcelain)" ]]; then
    git status --short >&2
    die "commit, stash or remove the changes above first"
  fi
  check_ok "no modified, staged or untracked files"

  sha=$(git rev-parse HEAD)
  [[ "$sha" == "$(git rev-parse "$REMOTE/$RELEASE_BRANCH")" ]] \
    || die "local $RELEASE_BRANCH differs from $REMOTE/$RELEASE_BRANCH; run 'git pull' (unpushed commits go through a PR)"
  check_ok "up to date with $REMOTE/$RELEASE_BRANCH (${sha:0:7})"
  echo
}

next_version() {
  case "$1" in
    major) echo "v$((major + 1)).0.0" ;;
    minor) echo "v$major.$((minor + 1)).0" ;;
    patch) echo "v$major.$minor.$((patch + 1))" ;;
    alpha|beta) echo "v$major.$minor.$patch-$1" ;;
  esac
}

choose_level() {
  local i choice
  echo
  for i in 1 2 3 4 5; do
    printf '  %d) %-6s → %s\n' "$i" "${LEVELS[i-1]}" "$(next_version "${LEVELS[i-1]}")"
  done
  echo
  while true; do
    printf 'Which version? [1-5]: '
    read -r choice || { echo; die "aborted: no version chosen"; }
    case "$choice" in
      [1-5]) level="${LEVELS[choice-1]}"; return ;;
      major|minor|patch|alpha|beta) level="$choice"; return ;;
      *) echo "Please answer 1-5." ;;
    esac
  done
}

confirm() {
  local answer
  printf 'Push %s to %s? This publishes a release. [y/N]: ' "$next" "$REMOTE"
  read -r answer || { echo; answer=""; }   # no terminal / Ctrl-D counts as "no"
  case "$answer" in
    y|Y|yes|Yes|YES) return 0 ;;
    *) return 1 ;;
  esac
}

level=""
assume_yes=false
dry_run=false
for arg in "$@"; do
  case "$arg" in
    --major|--minor|--patch|--alpha|--beta)
      [[ -z "$level" ]] || usage_error "choose one version level, got --$level and $arg"
      level="${arg#--}" ;;
    -y|--yes) assume_yes=true ;;
    --dry-run) dry_run=true ;;
    -h|--help) usage; exit 0 ;;
    *) usage_error "unknown option '$arg'" ;;
  esac
done

# Local tags are only as fresh as the last fetch; this also updates origin/master.
git fetch --quiet --tags "$REMOTE"

$dry_run || preflight

# `|| true`: with no tags grep matches nothing and exits 1, which pipefail would turn into an exit.
latest=$(git tag --list 'v*' --sort=-v:refname | grep -E "$STABLE_TAG" | head -n1 || true)
IFS=. read -r major minor patch <<< "${latest:-v0.0.0}"
major="${major#v}"

echo "Latest release: ${latest:-none}"

# The same script the workflow runs, so this list is what will be pushed.
images=$("$(dirname "${BASH_SOURCE[0]}")/changed-images.sh" HEAD 2>/dev/null)
if [[ -z "$images" ]]; then
  echo "No image folder changed since ${latest:-the start}: a release would publish nothing."
  $dry_run && exit 0
  die "nothing to release"
fi
echo "Images in this release:"
for dir in $images; do
  echo "  - observer-${dir##*/}  ($dir)"
done
[[ -n "$level" ]] || choose_level
next=$(next_version "$level")
echo "Next version:   $next ($level)"

if $dry_run; then
  echo "Dry run: nothing tagged or pushed."
  exit 0
fi

# Running a stable bump twice would release the same code under two versions.
if [[ "$level" != alpha && "$level" != beta ]]; then
  released=$(git tag --points-at HEAD | grep -E "$STABLE_TAG" | head -n1 || true)
  [[ -z "$released" ]] || die "this commit is already released as $released"
fi
if git rev-parse --quiet --verify "refs/tags/$next" >/dev/null; then
  die "tag $next already exists"
fi

$assume_yes || confirm || { echo "Aborted: nothing tagged or pushed."; exit 1; }

# Until the push succeeds, any exit (failure, Ctrl-C) removes the local tag;
# otherwise the next run would count a version that never reached GitHub.
trap 'git tag --delete "$next" >/dev/null 2>&1 || true' EXIT
trap 'exit 130' INT TERM
git tag --annotate "$next" --message "Release $next"
git push --quiet "$REMOTE" "refs/tags/$next" || die "push failed; removed the local tag $next"
trap - EXIT

echo "Pushed $next; the \"Observability: push images\" workflow is building and pushing the images listed above."

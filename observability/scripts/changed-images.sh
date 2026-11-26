#!/usr/bin/env bash
#
# Prints the image folders that a release of <commit> has to build: the folders
# with a Dockerfile under observability/projects and observability/ops whose
# files changed since the previous release. One folder per line, relative to
# the root of the repository; nothing when no image changed.
#
#   changed-images.sh [<commit>] [<tag-to-ignore>]
#
# <commit> defaults to HEAD. The previous release is the highest stable tag
# (vX.Y.Z) reachable from <commit>; alpha and beta tags are never the base, so
# a stable release still publishes what an alpha before it already contained.
# <tag-to-ignore> is the tag being released, when it already exists.
# With no previous release every image is listed.
#
# Used by bump.sh (to show what a release will publish) and by the
# "Observability: push images" workflow (to build only that).
set -euo pipefail

readonly STABLE_TAG='^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$'

commit="${1:-HEAD}"
ignored_tag="${2:-}"

cd "$(git rev-parse --show-toplevel)"

# `|| true`: with no tags grep matches nothing and exits 1, which pipefail would turn into an exit.
base=$(git tag --merged "$commit" --list 'v*' --sort=-v:refname \
  | grep -E "$STABLE_TAG" | grep -vxF -- "$ignored_tag" | head -n1 || true)
echo "previous release: ${base:-none}" >&2

# The Dockerfiles as they are in <commit>, not in the working tree.
dockerfiles=$(git ls-tree -r --name-only "$commit" -- observability/projects observability/ops \
  | grep -E '^observability/(projects|ops)/[^/]+/Dockerfile$' || true)

for dockerfile in $dockerfiles; do
  dir="${dockerfile%/Dockerfile}"
  # Documentation is not part of any image: a README change is not a new version.
  if [[ -z "$base" ]] || ! git diff --quiet "$base" "$commit" -- "$dir" ":(exclude)$dir/*.md"; then
    echo "$dir"
  fi
done

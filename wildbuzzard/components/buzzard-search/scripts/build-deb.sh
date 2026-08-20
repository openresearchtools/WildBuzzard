#!/usr/bin/env bash

set -Eeuo pipefail
umask 022

component_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
source_root="$(cd -- "${component_root}/../.." && pwd -P)"
youtube_source="${source_root}/third_party/mit/youtube-transcript-api/upstream"
runtime="${BUZZARD_SEARCH_RUNTIME:-}"
output="${1:-${component_root}/dist}"
if [[ -z "${runtime}" || ! -f "${runtime}" ]]; then
  echo "Set BUZZARD_SEARCH_RUNTIME to the pinned SearXNG AppImage" >&2
  exit 2
fi
if [[ -z "${SOURCE_DATE_EPOCH:-}" ]]; then
  SOURCE_DATE_EPOCH="$(stat -c %Y "${runtime}")"
fi
if [[ ! "${SOURCE_DATE_EPOCH}" =~ ^[0-9]+$ ]]; then
  echo "SOURCE_DATE_EPOCH must be an integer" >&2
  exit 2
fi
export SOURCE_DATE_EPOCH TZ=UTC LC_ALL=C
mkdir -p -- "${output}"
stage="$(mktemp -d "${output}/.buzzard-search-build.XXXXXX")"
trap 'rm -r -- "${stage}"' EXIT
mkdir -p "${stage}/tmp"
export TMPDIR="${stage}/tmp"
root="${stage}/buzzard-search_0.1.0-1_amd64"
install -d -m 0755 \
  "${root}/DEBIAN" \
  "${root}/usr/bin" \
  "${root}/usr/lib/buzzard-search/youtube_transcript_api" \
  "${root}/usr/share/doc/buzzard-search" \
  "${root}/usr/share/buzzard-search/skills/buzzard-web-search/agents"
install -m 0644 "${component_root}/packaging/control" "${root}/DEBIAN/control"
install -m 0755 "${component_root}/packaging/buzzard-search" "${root}/usr/bin/buzzard-search"
install -m 0755 \
  "${component_root}/packaging/buzzard-search-mcp" \
  "${root}/usr/bin/buzzard-search-mcp"
install -m 0644 \
  "${component_root}/src/buzzard_search.py" \
  "${root}/usr/lib/buzzard-search/buzzard_search.py"
install -m 0644 \
  "${component_root}/src/buzzard_search_mcp.py" \
  "${root}/usr/lib/buzzard-search/buzzard_search_mcp.py"
install -m 0644 \
  "${component_root}/src/buzzard_youtube_transcript.py" \
  "${root}/usr/lib/buzzard-search/buzzard_youtube_transcript.py"
cp -a \
  "${youtube_source}/youtube_transcript_api/." \
  "${root}/usr/lib/buzzard-search/youtube_transcript_api/"
find "${root}/usr/lib/buzzard-search/youtube_transcript_api" -type d -exec chmod 0755 {} +
find "${root}/usr/lib/buzzard-search/youtube_transcript_api" -type f -exec chmod 0644 {} +
install -m 0755 "${runtime}" "${root}/usr/lib/buzzard-search/buzzard-searxng.AppImage"
install -m 0644 "${component_root}/README.md" "${root}/usr/share/doc/buzzard-search/README.md"
install -m 0644 \
  "${component_root}/skills/buzzard-web-search/SKILL.md" \
  "${root}/usr/share/buzzard-search/skills/buzzard-web-search/SKILL.md"
install -m 0644 \
  "${component_root}/skills/buzzard-web-search/agents/openai.yaml" \
  "${root}/usr/share/buzzard-search/skills/buzzard-web-search/agents/openai.yaml"
install -m 0644 "${component_root}/LICENSE" "${root}/usr/share/doc/buzzard-search/LICENSE.packaging"
install -m 0644 "${component_root}/debian/copyright" "${root}/usr/share/doc/buzzard-search/copyright"
install -m 0644 \
  "${youtube_source}/LICENSE" \
  "${root}/usr/share/doc/buzzard-search/LICENSE.youtube-transcript-api"
gzip -n -9 -c "${component_root}/debian/changelog" >"${root}/usr/share/doc/buzzard-search/changelog.Debian.gz"
find "${root}" -exec touch --no-dereference --date="@${SOURCE_DATE_EPOCH}" {} +
dpkg-deb --root-owner-group --uniform-compression --threads-max=1 -Zzstd -z10 --build \
  "${root}" "${output}/buzzard-search_0.1.0-1_amd64.deb"

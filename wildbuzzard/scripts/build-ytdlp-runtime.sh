#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later

set -Eeuo pipefail

usage() {
  echo "Usage: $0 [--build-root DIR] [--python FILE]"
}

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
source_repo="$(cd -- "${script_dir}/../.." && pwd -P)"
build_root="$(dirname -- "${source_repo}")/wildbuzzard-ytdlp-builds"
python_binary="$(command -v python3)"
version="2026.07.04"
commit="fdec00e0bf530dc6c3cc7b1dd780e95d9ae460e9"
archive_sha256="27c51a76a68621313f678aa8b9c48ce39b895e0db79e06963e07c1b1662c4786"

while (($#)); do
  case "$1" in
    --build-root)
      build_root="${2:?--build-root requires a directory}"
      shift 2
      ;;
    --python)
      python_binary="${2:?--python requires a file}"
      shift 2
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if [[ ! -x "${python_binary}" ]]; then
  echo "Python build executable is unavailable: ${python_binary}" >&2
  exit 2
fi

mkdir -p -- "${build_root}"
build_root="$(cd -- "${build_root}" && pwd -P)"
case "${build_root}/" in
  "${source_repo}/"*)
    echo "Build root must be outside the source repository" >&2
    exit 2
    ;;
esac

run_id="$(date -u +%Y%m%dT%H%M%SZ)-${commit:0:12}-$$"
run_root="${build_root}/runs/${run_id}"
source_dir="${run_root}/source"
venv_dir="${run_root}/venv"
wheel_dir="${run_root}/wheelhouse"
runtime_dir="${run_root}/runtime"
artifact_dir="${run_root}/artifacts"
download_dir="${build_root}/downloads"
archive="${download_dir}/yt-dlp-${commit}.tar.gz"
mkdir -p -- \
  "${source_dir}" \
  "${wheel_dir}" \
  "${runtime_dir}/bin" \
  "${runtime_dir}/source/wheels" \
  "${artifact_dir}" \
  "${download_dir}"

if [[ ! -f "${archive}" ]]; then
  curl --fail --location \
    --output "${archive}" \
    "https://github.com/yt-dlp/yt-dlp/archive/${commit}.tar.gz"
fi
actual_sha256="$(sha256sum "${archive}" | awk '{ print $1 }')"
if [[ "${actual_sha256}" != "${archive_sha256}" ]]; then
  echo "yt-dlp source archive checksum mismatch" >&2
  exit 1
fi

tar -xzf "${archive}" --strip-components=1 -C "${source_dir}"
"${python_binary}" -m venv "${venv_dir}"
venv_python="${venv_dir}/bin/python"
"${venv_python}" -m pip install --require-hashes \
  -r "${source_dir}/bundle/requirements/pip.txt" \
  >"${run_root}/pip-bootstrap.log" 2>&1
"${venv_python}" -m pip download --require-hashes \
  --dest "${wheel_dir}" \
  -r "${source_dir}/bundle/requirements/pyinstaller.txt" \
  -r "${source_dir}/bundle/requirements/default.txt" \
  >"${run_root}/pip-download.log" 2>&1
"${venv_python}" -m pip install --no-index \
  --find-links "${wheel_dir}" \
  -r "${source_dir}/bundle/requirements/pyinstaller.txt" \
  -r "${source_dir}/bundle/requirements/default.txt" \
  >"${run_root}/pip-install.log" 2>&1
(
  cd -- "${source_dir}"
  "${venv_python}" -m devscripts.make_lazy_extractors
  "${venv_python}" -m bundle.pyinstaller
) >"${run_root}/build.log" 2>&1

built_binary="${source_dir}/dist/yt-dlp_linux"
if [[ ! -x "${built_binary}" ]]; then
  echo "yt-dlp build did not produce yt-dlp_linux" >&2
  exit 1
fi
install -m 755 "${built_binary}" "${runtime_dir}/bin/yt-dlp"
install -m 644 "${source_dir}/LICENSE" "${runtime_dir}/LICENSE"
install -m 644 \
  "${source_dir}/THIRD_PARTY_LICENSES.txt" \
  "${runtime_dir}/THIRD_PARTY_LICENSES.txt"
install -m 644 "${archive}" "${runtime_dir}/source/yt-dlp-${commit}.tar.gz"
cp -a -- "${wheel_dir}/." "${runtime_dir}/source/wheels/"

"${venv_python}" -m pip list --format=json >"${runtime_dir}/python-packages.json"
binary_sha256="$(sha256sum "${runtime_dir}/bin/yt-dlp" | awk '{ print $1 }')"
printf '{\n  "schema": 1,\n  "component": "yt-dlp",\n  "version": "%s",\n  "commit": "%s",\n  "sourceSha256": "%s",\n  "binarySha256": "%s",\n  "platform": "linux-x64"\n}\n' \
  "${version}" \
  "${commit}" \
  "${archive_sha256}" \
  "${binary_sha256}" \
  >"${runtime_dir}/wildbuzzard-ytdlp-runtime.json"

env -i \
  PATH="${runtime_dir}/bin" \
  LANG=C.UTF-8 \
  LC_ALL=C.UTF-8 \
  "${runtime_dir}/bin/yt-dlp" \
  --ignore-config \
  --no-plugin-dirs \
  --no-remote-components \
  --no-update \
  --version \
  >"${run_root}/version.log" 2>&1
ldd "${runtime_dir}/bin/yt-dlp" >"${run_root}/dynamic-libraries.log" 2>&1 || true

runtime_zip="${artifact_dir}/wildbuzzard-ytdlp-runtime-linux-x64-${commit:0:12}.zip"
(
  cd -- "${runtime_dir}"
  zip -q -r "${runtime_zip}" .
)
sha256sum "${runtime_zip}" >"${runtime_zip}.sha256"

{
  echo "version=${version}"
  echo "commit=${commit}"
  echo "source_sha256=${archive_sha256}"
  echo "binary_sha256=${binary_sha256}"
  echo "runtime_zip=${runtime_zip}"
  echo "runtime_sha256=$(sha256sum "${runtime_zip}" | awk '{ print $1 }')"
} >"${run_root}/build-manifest.txt"

echo "yt-dlp runtime: ${runtime_zip}"
echo "Logs: ${run_root}"

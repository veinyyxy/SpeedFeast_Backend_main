#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
image="${1:-}"
output="${2:-}"
[[ "$image" =~ ^speedfeast-(app|lifecycle)-candidate:[a-f0-9]{40}$ ]] || exit 2
[[ -n "${RUNNER_TEMP:-}" && -d "$output" && "$(realpath "$output")" == "$(realpath "$RUNNER_TEMP")"/* ]] || exit 2
scanner=$(mktemp -d "$RUNNER_TEMP/trivy-reviewed-XXXXXXXX")
curl --fail --silent --show-error --location \
  https://github.com/aquasecurity/trivy/releases/download/v0.75.0/trivy_0.75.0_Linux-64bit.tar.gz \
  --output "$scanner/trivy.tar.gz"
echo "c6e65abddb348e25f10549df887045629cf28cc72453cd1c63acb717316b3f3f  $scanner/trivy.tar.gz" | sha256sum --check --strict
tar --extract --gzip --file "$scanner/trivy.tar.gz" --directory "$scanner" trivy
printf '' > "$scanner/empty.ignore"
# A fresh job-local DB, no persistent build cache or repo-supplied exceptions.
# Never skip unsupported OS, unfixed HIGH/CRITICAL or a failed DB download.
set +e
"$scanner/trivy" image --image-src docker --scanners vuln --pkg-types os \
  --severity HIGH,CRITICAL --exit-code 1 --format json --list-all-pkgs \
  --ignorefile "$scanner/empty.ignore" --cache-dir "$scanner/cache" --timeout 8m \
  --output "$output/os-scan.json" "$image"
scan_exit=$?
set -e
node scripts/ci/verify-image-security.js "$image" "$output" "$scanner/cache"
[[ "$scan_exit" -eq 0 ]]

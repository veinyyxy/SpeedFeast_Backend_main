#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

kind="${1:-}"
image="${2:-}"
output="${3:-}"
[[ "$kind" == app || "$kind" == lifecycle ]] || exit 2
[[ "$image" =~ ^speedfeast-(app|lifecycle)-candidate:[a-f0-9]{40}$ ]] || exit 2
[[ -n "$output" && -d "$output" && -n "${RUNNER_TEMP:-}" ]] || exit 2
[[ "$(realpath "$output")" == "$(realpath "$RUNNER_TEMP")"/* ]] || exit 2
server=''
app=''
cleanup() {
  # Only job-owned exact container IDs; no Docker prune, cloud deletion or
  # user workspace cleanup. Failure preserves small diagnostic receipts.
  if [[ "$app" =~ ^[a-f0-9]{64}$ ]]; then docker rm --force --volumes "$app" >/dev/null 2>&1 || true; fi
  if [[ "$server" =~ ^[a-f0-9]{64}$ ]]; then docker rm --force --volumes "$server" >/dev/null 2>&1 || true; fi
}
trap cleanup EXIT

docker image inspect "$image" > "$output/image-inspect.json"
if [[ "$kind" == app ]]; then
  app=$(docker run --detach --network none \
    --env CORS_ALLOWED_ORIGINS=https://buyer.example.invalid \
    --env HMAC_SECRET_KEY=ci-hmac-placeholder --env JWT_SECRET_KEY=ci-jwt-placeholder \
    --env JWT_EXPIRES_IN=1h --env MERCHANT_JWT_EXPIRES_IN=1h \
    --env DATABASE_URL=postgresql://ci:ci@database.invalid/speedfeast \
    --env APP_IMAGE_REVISION=sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa \
    --env PAYMENT_PROVIDER=stripe --env STRIPE_SECRET_KEY=sk_test_ci \
    --env STRIPE_PUBLISHABLE_KEY=pk_test_ci --env STRIPE_WEBHOOK_SECRET=whsec_ci \
    --env STRIPE_SUCCESS_URL=https://buyer.example.invalid/payment-success \
    --env STRIPE_CANCEL_URL=https://buyer.example.invalid/payment-cancel \
    --env SMS_PROVIDER=demo --env IMAGE_STORAGE_PROVIDER=s3 --env IMAGE_S3_BUCKET=ci-images \
    --env IMAGE_PUBLIC_BASE_URL=https://images.example.invalid --env AWS_REGION=ca-central-1 \
    --env SAAS_CONTROL_PUBLIC_KEY=ci-only-public-key --env SAAS_INSTANCE_ID=ci-app-instance \
    --env SAAS_JWT_AUDIENCE=speedfeast-instance:ci-app-instance \
    --env SAAS_JWT_ISSUER=https://console.example.invalid --env SAAS_MTLS_PROXY_MODE=aws_alb_verify \
    --env SAAS_REQUIRE_INSTANCE_CLAIM=true --env SAAS_REQUIRE_MTLS=true \
    --env SAAS_TRUST_PROXY_MTLS_HEADER=true "$image")
  docker exec "$app" /usr/local/bin/node -e '
    const fs=require("fs");
    async function main(){
      if(process.version!=="v24.18.0"||process.getuid()!==65532||process.arch!=="x64")throw new Error("identity");
      for(const p of ["/app/.env","/app/.env.local","/root/.aws","/home/nonroot/.aws"])if(fs.existsSync(p))throw new Error("private file");
      for(let i=0;i<30;i++){
        try{const h=await fetch("http://127.0.0.1:3000/health");if(h.ok){
          const r=await fetch("http://127.0.0.1:3000/ready");if(r.status!==503)throw new Error("readiness did not fail closed");
          console.log(JSON.stringify({schemaVersion:1,outcome:"APP_CONTAINER_SMOKE_VERIFIED",nodeVersion:process.version,uid:process.getuid(),platform:"linux/amd64",healthStatus:h.status,readyStatus:r.status,network:"none",cloudMutationPerformed:false}));return;
        }}catch{}await new Promise(r=>setTimeout(r,1000));
      }throw new Error("health");
    }main().catch(()=>{console.error("APP_IMAGE_SELF_CHECK_FAILED");process.exitCode=1;});
  ' > "$output/self-check.json"
else
  docker run --rm --network none --read-only --tmpfs /tmp:rw,noexec,nosuid,size=128m,mode=1777 "$image" > "$output/bundle-check.json"
  fixture="$output/synthetic-fixture"
  mkdir "$fixture"
  python3 scripts/ci/create-image-toolchain-fixture.py "$fixture/create.sql"
  # The only database here is a job-owned throwaway container, not an RDS Cell.
  server=$(docker run --detach --network none \
    --env POSTGRES_PASSWORD=ci-synthetic-only --env POSTGRES_DB=ci_image_source \
    postgres:16.14-bookworm@sha256:92620daddcd947f8d5ab5ba66e848702fe443d87fed30c4cea8e389fd78dfc55)
  for attempt in {1..30}; do
    if docker exec "$server" pg_isready -U postgres -d ci_image_source >/dev/null; then break; fi
    sleep 1
  done
  docker exec -i "$server" psql -X -U postgres -d ci_image_source --set=ON_ERROR_STOP=1 < "$fixture/create.sql"
  docker exec "$server" pg_dump -U postgres -d ci_image_source --format=custom --schema-only \
    --no-owner --no-privileges --no-comments > "$fixture/empty-baseline.dump"
  docker exec -i "$server" pg_restore --list < "$fixture/empty-baseline.dump" > "$fixture/restore.toc"
  docker exec -i "$server" pg_restore --schema-only --no-owner --no-privileges --no-comments --file=- \
    < "$fixture/empty-baseline.dump" > "$fixture/rendered.sql"
  python3 scripts/compile_tenant_baseline_candidate.py "$fixture/empty-baseline.dump" "$fixture/restore.toc" \
    ci_image_source "$fixture" speedfeast-empty-schema/2026-10-05/v1 "$fixture/rendered.sql"
  python3 -c 'import json,sys; assert json.load(open(sys.argv[1]))["policyCompatible"] is True' "$fixture/schema-policy-review.json"
  chmod 0755 "$output" "$fixture"
  chmod 0444 "$fixture/empty-baseline.dump" "$fixture/empty-baseline.manifest.json"
  docker run --rm --network none --read-only --tmpfs /tmp:rw,noexec,nosuid,size=128m,mode=1777 \
    --mount "type=bind,source=$fixture,target=/ci-fixture,readonly" \
    --entrypoint node "$image" /app/scripts/ci/check-lifecycle-image-toolchain.js /ci-fixture > "$output/self-check.json"
  set +e
  docker run --rm --network none "$image" verify > "$output/write-gate.stdout" 2> "$output/write-gate.stderr"
  gate_exit=$?
  set -e
  [[ "$gate_exit" -eq 1 && ! -s "$output/write-gate.stdout" ]]
  grep -q '^TENANT_PREPARED_STANDALONE_DISABLED:' "$output/write-gate.stderr"
fi

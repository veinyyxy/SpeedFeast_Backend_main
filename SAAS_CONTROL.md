# SaaS Control Plane

This service is deployed once per merchant instance. SaaS-owned entitlements
control capacity and features without adding a tenant identifier to business
tables.

## Architecture

- `saas_instances` stores the local instance identity and operational state.
- `saas_entitlements` stores typed, allowlisted quota, feature, and policy keys.
- `saas_licenses` stores signed license metadata and only a SHA-256 token hash.
- `saas_access_leases` tracks active buyer devices by a SHA-256 device hash.
- `saas_provisioning_operations` makes initial provisioning idempotent.
- `saas_audit_logs` records every control-plane mutation.
- Store names and app themes remain store-scoped in `system_config`.

The entitlement catalog is defined in
`services/saas/entitlement_catalog.js`. Add future controls there first, then
seed their default in `db/saas_control.sql` and enforce them at the relevant
transaction boundary. Controls that need transactional side effects can add a
handler in `services/saas/entitlement_effects.js`.

## Current Entitlements

| Key | Default | Meaning |
| --- | --- | --- |
| `buyer.accounts.max` | `null` | Maximum registered buyers |
| `buyer.concurrent_access.max` | `null` | Maximum active buyer devices |
| `stores.max` | `null` | Maximum active stores, including main |
| `merchant.active_users.max` | `null` | Maximum active merchant users |
| `branding.custom_theme.enabled` | `true` | Use store-specific themes |
| `branding.merchant_editable` | `true` | Let merchants edit store names/themes |
| `buyer.access.lease_seconds` | `900` | Active buyer device lease lifetime |
| `buyer.access.heartbeat_seconds` | `300` | Buyer heartbeat interval |

`null` means unlimited for quota values. Existing installations therefore keep
their previous capacity until the SaaS platform assigns limits.

## Install

Apply the normal application schema first, then run:

```powershell
npm run migrate:saas
```

The command applies `db/saas_control.sql` and `db/theme_config.sql` in one
transaction. Both migrations are idempotent.

Configure the control-plane authentication variables shown in `.env.example`.
Control tokens must be asymmetrically signed, contain the configured issuer and
audience, include a `sub`, and grant the `speedfeast:control` scope.

Set `SAAS_INSTANCE_ID` to the SaaS platform application-instance identifier and
use a unique audience such as `speedfeast-instance:<app-instance-id>`. With
`SAAS_REQUIRE_INSTANCE_CLAIM=true`, every control token must contain an exact
matching `instance_id` claim. Initial provisioning also requires
`instance.external_instance_id` to match that claim, and an identity already
stored by the service cannot be replaced.

In production, keep `SAAS_REQUIRE_MTLS=true`. When TLS terminates at a trusted
reverse proxy, the proxy must remove any client-supplied verification header,
validate the client certificate, and then set the configured header to
`SUCCESS`. Do not expose the backend directly when proxy-header trust is on.

For an AWS Application Load Balancer HTTPS listener using mTLS `verify` mode,
set `SAAS_MTLS_PROXY_MODE=aws_alb_verify`. The middleware then requires the ALB
generated serial-number, issuer, subject, and validity headers. This mode is
safe only when the ECS task security group accepts application traffic solely
from the trusted ALB security group. The public listener should reject
`/api/saas/*`; route it only through the mTLS listener.

Buyer and merchant JWTs cannot call the control API. Every endpoint under
`/api/saas` requires the dedicated SaaS bearer token and, when configured,
verified mTLS.

## API

- `GET /api/saas/control` returns the control API version, image revision,
  effective configuration hash, instance state, catalog, effective values,
  current usage, stores with complete buyer and merchant branding, and recent
  audit entries. `desired_configuration_hash` reflects the hash supplied in
  provisioning instance metadata when present.
- `PUT /api/saas/entitlements` updates an allowlisted set of entitlement keys.
- `PUT /api/saas/instance` activates or suspends the service instance.
- `POST /api/saas/license` verifies and installs a signed license token.
- `POST /api/saas/provision` provisions instance metadata, limits, branding,
  and the first owner atomically.
- `PUT /api/saas/stores/:storeId/branding` manages store branding even when
  merchant branding edits are disabled.

Initial provisioning requires an `Idempotency-Key` header. Example body:

```json
{
  "instance": {
    "external_instance_id": "merchant-123",
    "metadata": { "plan": "growth" }
  },
  "entitlements": {
    "buyer.accounts.max": 500,
    "buyer.concurrent_access.max": 100,
    "stores.max": 5,
    "merchant.active_users.max": 20,
    "branding.custom_theme.enabled": true,
    "branding.merchant_editable": true
  },
  "default_store": {
    "name": "Main Store",
    "buyer_theme": {
      "brightness": "light",
      "primary": "#03A9F4",
      "secondary": "#0288D1",
      "surface": "#FFFFFF",
      "background": "#FFFFFF",
      "error": "#B3261E"
    },
    "merchant_theme": {
      "brightness": "light",
      "primary": "#0F766E",
      "secondary": "#0D9488",
      "surface": "#FFFFFF",
      "background": "#F8FAFC",
      "error": "#B3261E"
    }
  },
  "first_owner": {
    "username": "owner",
    "password": "temporary-password",
    "display_name": "Store Owner"
  }
}
```

Use a deterministic key such as
`provision:<app-instance-id>:<configuration-hash>`. Claiming that key uses an
atomic `INSERT ... ON CONFLICT` operation. A completed request with the same
normalized body is replayed; reusing the key for a different body returns
`IDEMPOTENCY_KEY_REUSED`. After a network timeout, retry with exactly the same
key and body.

`configuration_hash` in the control summary is calculated from effective
instance state, entitlement values, store names, and complete buyer/merchant
themes. It deliberately excludes timestamps, audit entries, and image
revision, so a configuration-only reconciliation produces a stable hash.
`APP_IMAGE_REVISION` should contain the immutable image digest or source
revision injected by the deployment pipeline.

The first owner is only created when no active owner exists and is marked
`must_change_password=true`. The legacy `db/create_merchant_user.js` script is
limited to non-production development and still enforces the active-user quota.

Runtime environment names are normalized before reading or writing branding:
`development` maps to `dev`, `testing` to `test`, and `production` to `prod`.

## Buyer Access

Buyer clients call `GET /api/buyer/access` and send stable
`X-Buyer-Device-Id` and `X-Buyer-Platform` headers. The backend also enforces
the lease on buyer API requests, so hiding or bypassing the client-side capacity
screen does not bypass the limit. A denied lease returns HTTP 429 with
`BUYER_ACCESS_LIMIT_REACHED` and structured quota details.

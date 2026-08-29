# B5-G PostgreSQL 16.14 integration tests

These tests never use the caller's `DATABASE_URL` and do not run under the
default `npm test`. The dedicated runner requires an exact opt-in phrase and an admin
URL that points to `postgres` or `template1` on `localhost`, `127.0.0.1`, or
`::1`.

The runner creates a randomly named database matching
`speedfeast_b5g_it_<pid>_<16 lowercase hex>`, writes a runner-owned marker,
runs the tests, verifies that marker again, and only then drops that exact
database. It refuses remote hosts, ordinary application database names,
PostgreSQL versions other than 16.14, and cleanup when the marker changed.
The child process replaces, rather than inherits, `DATABASE_URL` with the
runner-owned disposable database, so an accidental global-pool call cannot
reach a developer's configured application database.
The checked-in GitHub Actions workflow is manual-only and uses an ephemeral
PostgreSQL 16.14 service without AWS or application secrets.

The current suite covers the SaaS control migration, constraints, concurrent
epoch CAS, exact replay after a simulated lost COMMIT response, and the tenant
lifecycle registry's raw PostgreSQL 16.14 catalog identity. The runner creates
an exact marker-bound `cell_admin` NOLOGIN role only when that name is absent,
then verifies and removes it after dropping the disposable database. The
registry test also proves that the runtime role lacks `TRUNCATE`, a privileged
`TRUNCATE` reaches the statement trigger and returns SQLSTATE `55000`, and the
tombstone remains. It does not exercise the full destructive database/role
`destroy` path. If setup fails before the runner can install its ownership
markers, retained disposable state must be inspected manually before retrying.

PowerShell example for a local disposable PostgreSQL 16.14 server:

```powershell
$env:SPEEDFEAST_B5G_PG_INTEGRATION = 'I_UNDERSTAND_THIS_CREATES_AND_DROPS_A_DISPOSABLE_DATABASE'
$env:SPEEDFEAST_B5G_PG_ADMIN_URL = 'postgresql://postgres:local-password@127.0.0.1:5432/postgres?sslmode=disable'
npm run test:integration:postgres
```

Do not point this command at Neon, RDS, a shared development database, or a
database containing application data. The URL and runner token are passed only
to the child test process and are never printed by the runner.

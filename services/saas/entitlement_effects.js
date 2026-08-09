const ENTITLEMENT_EFFECTS = Object.freeze({
  'buyer.concurrent_access.max': reconcileBuyerAccessLimit,
});

async function reconcileBuyerAccessLimit(db, limit) {
  await db.query(
    `
      DELETE FROM public.saas_access_leases
      WHERE instance_id = public.default_saas_instance_id()
        AND expires_at <= now()
    `
  );
  if (limit === null) return;

  await db.query(
    `
      DELETE FROM public.saas_access_leases leases
      WHERE leases.instance_id = public.default_saas_instance_id()
        AND leases.expires_at > now()
        AND NOT EXISTS (
          SELECT 1
          FROM (
            SELECT kept.device_hash
            FROM public.saas_access_leases kept
            WHERE kept.instance_id = public.default_saas_instance_id()
              AND kept.expires_at > now()
            ORDER BY kept.last_seen_at DESC,
                     kept.first_seen_at DESC,
                     kept.device_hash
            LIMIT $1
          ) allowed
          WHERE allowed.device_hash = leases.device_hash
        )
    `,
    [limit]
  );
}

async function applyEntitlementEffects(db, values) {
  for (const [key, value] of Object.entries(values)) {
    const effect = ENTITLEMENT_EFFECTS[key];
    if (effect) await effect(db, value);
  }
}

module.exports = {
  ENTITLEMENT_EFFECTS,
  applyEntitlementEffects,
  reconcileBuyerAccessLimit,
};

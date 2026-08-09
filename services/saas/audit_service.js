async function recordSaasAudit(
  db,
  {
    actorSubject,
    actorTokenId = null,
    action,
    resourceType,
    resourceId = null,
    beforeValue = null,
    afterValue = null,
    metadata = {},
  }
) {
  await db.query(
    `
      INSERT INTO public.saas_audit_logs (
        instance_id,
        actor_subject,
        actor_token_id,
        action,
        resource_type,
        resource_id,
        before_value,
        after_value,
        metadata
      )
      VALUES (
        public.default_saas_instance_id(),
        $1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8::jsonb
      )
    `,
    [
      actorSubject,
      actorTokenId,
      action,
      resourceType,
      resourceId,
      beforeValue === null ? null : JSON.stringify(beforeValue),
      afterValue === null ? null : JSON.stringify(afterValue),
      JSON.stringify(metadata),
    ]
  );
}

module.exports = { recordSaasAudit };

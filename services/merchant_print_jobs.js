const MAX_PRINT_ATTEMPTS = 10;
const PRINT_JOB_TYPE_ORDER_RECEIPT = 'order_receipt';

function normalizeText(value) {
  if (value === undefined || value === null) return '';
  return value.toString().trim();
}

async function enqueueAutomaticOrderReceipt(
  client,
  { orderId, metadata = {} }
) {
  const result = await client.query(
    `
      INSERT INTO public.merchant_order_print_jobs (
        order_id,
        job_type,
        metadata
      )
      VALUES ($1::uuid, $2::text, $3::jsonb)
      ON CONFLICT (order_id, job_type) DO NOTHING
      RETURNING *
    `,
    [
      orderId,
      PRINT_JOB_TYPE_ORDER_RECEIPT,
      JSON.stringify(metadata || {}),
    ]
  );

  if (result.rows[0]) return result.rows[0];

  const existing = await client.query(
    `
      SELECT *
      FROM public.merchant_order_print_jobs
      WHERE order_id = $1::uuid
        AND job_type = $2::text
      LIMIT 1
    `,
    [orderId, PRINT_JOB_TYPE_ORDER_RECEIPT]
  );
  return existing.rows[0] || null;
}

async function claimNextOrderReceipt(client, deviceId) {
  const normalizedDeviceId = normalizeText(deviceId).slice(0, 180);
  if (!normalizedDeviceId) return null;

  const result = await client.query(
    `
      WITH candidate AS (
        SELECT jobs.print_job_id
        FROM public.merchant_order_print_jobs jobs
        JOIN public."Order" orders
          ON orders.order_id = jobs.order_id
        WHERE jobs.job_type = $1::text
          AND jobs.attempts < $2::integer
          AND orders.order_status NOT IN ('cancelled', 'refunded')
          AND (
            (
              jobs.status IN ('pending', 'failed')
              AND jobs.available_at <= now()
            )
            OR (
              jobs.status = 'processing'
              AND jobs.lease_expires_at <= now()
            )
          )
        ORDER BY jobs.available_at ASC, jobs.created_at ASC
        FOR UPDATE OF jobs SKIP LOCKED
        LIMIT 1
      )
      UPDATE public.merchant_order_print_jobs jobs
      SET status = 'processing',
          claimed_by_device_id = $3::text,
          claim_token = uuid_generate_v4(),
          claimed_at = now(),
          lease_expires_at = now() + interval '5 minutes',
          attempts = attempts + 1,
          last_error = NULL,
          updated_at = now()
      FROM candidate
      WHERE jobs.print_job_id = candidate.print_job_id
      RETURNING jobs.*
    `,
    [PRINT_JOB_TYPE_ORDER_RECEIPT, MAX_PRINT_ATTEMPTS, normalizedDeviceId]
  );

  return result.rows[0] || null;
}

async function completePrintJob(client, { printJobId, claimToken }) {
  const result = await client.query(
    `
      UPDATE public.merchant_order_print_jobs
      SET status = 'completed',
          completed_at = now(),
          lease_expires_at = NULL,
          last_error = NULL,
          updated_at = now()
      WHERE print_job_id = $1::uuid
        AND claim_token = $2::uuid
        AND status = 'processing'
      RETURNING *
    `,
    [printJobId, claimToken]
  );
  return result.rows[0] || null;
}

async function failPrintJob(
  client,
  { printJobId, claimToken, errorMessage }
) {
  const result = await client.query(
    `
      UPDATE public.merchant_order_print_jobs
      SET status = 'failed',
          available_at = now()
            + (LEAST(GREATEST(attempts, 1), 5) * interval '15 seconds'),
          claimed_by_device_id = NULL,
          claim_token = NULL,
          claimed_at = NULL,
          lease_expires_at = NULL,
          last_error = $3::text,
          updated_at = now()
      WHERE print_job_id = $1::uuid
        AND claim_token = $2::uuid
        AND status = 'processing'
      RETURNING *
    `,
    [printJobId, claimToken, normalizeText(errorMessage).slice(0, 1000)]
  );
  return result.rows[0] || null;
}

module.exports = {
  MAX_PRINT_ATTEMPTS,
  PRINT_JOB_TYPE_ORDER_RECEIPT,
  claimNextOrderReceipt,
  completePrintJob,
  enqueueAutomaticOrderReceipt,
  failPrintJob,
};

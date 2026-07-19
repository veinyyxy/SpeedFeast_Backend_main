const FULFILLMENT_TIMING_ASAP = 'asap';
const FULFILLMENT_TIMING_SCHEDULED = 'scheduled';

function normalizeText(value) {
  if (value === undefined || value === null) return '';
  return value.toString().trim();
}

function normalizeOrderFulfillmentTiming(body = {}) {
  const rawMode = normalizeText(
    body.fulfillment_timing ?? body.fulfillmentTiming
  ).toLowerCase();
  const rawScheduledFor = normalizeText(
    body.scheduled_for ?? body.scheduledFor
  );

  if (
    rawMode &&
    rawMode !== FULFILLMENT_TIMING_ASAP &&
    rawMode !== FULFILLMENT_TIMING_SCHEDULED
  ) {
    return {
      valid: false,
      error: 'fulfillment_timing must be asap or scheduled',
    };
  }

  if (!rawScheduledFor) {
    if (rawMode === FULFILLMENT_TIMING_SCHEDULED) {
      return {
        valid: false,
        error: 'scheduled_for is required for a scheduled order',
      };
    }
    return {
      valid: true,
      mode: FULFILLMENT_TIMING_ASAP,
      isScheduled: false,
      scheduledFor: null,
    };
  }

  if (rawMode === FULFILLMENT_TIMING_ASAP) {
    return {
      valid: false,
      error: 'scheduled_for cannot be used with asap fulfillment',
    };
  }

  if (!/(?:z|[+-]\d{2}:\d{2})$/i.test(rawScheduledFor)) {
    return {
      valid: false,
      error: 'scheduled_for must include a timezone offset',
    };
  }

  const scheduledFor = new Date(rawScheduledFor);
  if (Number.isNaN(scheduledFor.getTime())) {
    return { valid: false, error: 'scheduled_for is not a valid timestamp' };
  }

  return {
    valid: true,
    mode: FULFILLMENT_TIMING_SCHEDULED,
    isScheduled: true,
    scheduledFor,
  };
}

module.exports = {
  FULFILLMENT_TIMING_ASAP,
  FULFILLMENT_TIMING_SCHEDULED,
  normalizeOrderFulfillmentTiming,
};

const MIN_PREPARATION_MINUTES = 1;
const MAX_PREPARATION_MINUTES = 1440;

function normalizePreparationMinutes(value) {
  if (value === undefined || value === null || value === '') return null;

  if (typeof value === 'string' && !/^\d+$/.test(value.trim())) {
    return null;
  }

  const minutes = Number(value);
  if (
    !Number.isInteger(minutes) ||
    minutes < MIN_PREPARATION_MINUTES ||
    minutes > MAX_PREPARATION_MINUTES
  ) {
    return null;
  }

  return minutes;
}

module.exports = {
  MAX_PREPARATION_MINUTES,
  MIN_PREPARATION_MINUTES,
  normalizePreparationMinutes,
};

function optionsAffectPrice(value) {
  return value !== false;
}

function effectiveOptionPrice(optionPrice, parentOptionsAffectPrice) {
  if (!optionsAffectPrice(parentOptionsAffectPrice)) return 0;

  const parsed = Number(optionPrice);
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return parsed;
}

module.exports = {
  effectiveOptionPrice,
  optionsAffectPrice,
};

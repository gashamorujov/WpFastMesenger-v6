/**
 * azPhone — Azerbaijani phone number validation & normalization system.
 *
 * All Azerbaijani mobile numbers are normalized internally to a single
 * international format: 994XXXXXXXXX (12 digits, no separators).
 *
 * Supported input formats (all equivalent):
 *   +994501234567    994501234567    0501234567    501234567
 *   050 123 45 67    055-123-45-67   +994 50 123 45 67  (…)050(…)1234567
 *
 * Valid mobile prefixes (Azercell: 10/50/51, Bakcell: 55/99,
 * Nar: 70/77, AzInTelecom: 60).
 */

const COUNTRY_CODE = '994';
const LOCAL_LENGTH = 10; // 0 + prefix(2) + subscriber(7)
const INTERNATIONAL_LENGTH = 12; // 994 + prefix(2) + subscriber(7)

const MOBILE_PREFIXES = ['10', '50', '51', '55', '60', '70', '77', '99'];

/** Strip every non-digit character from a raw input. */
function digitsOnly(raw) {
  if (raw === null || raw === undefined) return '';
  return String(raw).replace(/\D/g, '');
}

/**
 * Normalize an Azerbaijani phone number to 994XXXXXXXXX.
 * @param {string|number} raw
 * @returns {string|null} normalized phone (12 digits) or null when invalid
 */
function normalizePhone(raw) {
  const digits = digitsOnly(raw);
  if (digits.length === 0) return null;

  let candidate = null;

  // +994501234567 / 994501234567
  if (digits.length === INTERNATIONAL_LENGTH && digits.startsWith(COUNTRY_CODE)) {
    candidate = digits;
  }
  // 0501234567 (leading national 0)
  else if (digits.length === LOCAL_LENGTH && digits.startsWith('0')) {
    candidate = COUNTRY_CODE + digits.slice(1);
  }
  // 501234567 (local without leading 0)
  else if (digits.length === LOCAL_LENGTH - 1) {
    candidate = COUNTRY_CODE + digits;
  }
  // 9940501234567 (ölkə kodu + yerli 0) — "9940" + 9 rəqəm
  else if (digits.length === 13 && digits.startsWith(COUNTRY_CODE + '0')) {
    candidate = COUNTRY_CODE + digits.slice(4);
  }

  if (!candidate || !isValidAzerbaijanMobile(candidate)) return null;
  return candidate;
}

/**
 * Validate a (preferably normalized) number against Azerbaijani rules.
 * Accepts both normalized (994…) and local formats.
 * @param {string|number} raw
 * @returns {boolean}
 */
function isValidAzerbaijanMobile(raw) {
  const digits = digitsOnly(raw);

  if (digits.length === INTERNATIONAL_LENGTH && digits.startsWith(COUNTRY_CODE)) {
    return MOBILE_PREFIXES.includes(digits.slice(3, 5));
  }
  if (digits.length === LOCAL_LENGTH && digits.startsWith('0')) {
    return MOBILE_PREFIXES.includes(digits.slice(1, 3));
  }
  if (digits.length === 13 && digits.startsWith(COUNTRY_CODE + '0')) {
    return MOBILE_PREFIXES.includes(digits.slice(4, 6));
  }
  return false;
}

/**
 * Pretty display format: +994 50 123 45 67.
 * @param {string} normalized — 994XXXXXXXXX
 * @returns {string}
 */
function formatPhone(normalized) {
  const d = digitsOnly(normalized);
  if (d.length !== INTERNATIONAL_LENGTH) return String(normalized || '');
  return `+${d.slice(0, 3)} ${d.slice(3, 5)} ${d.slice(5, 8)} ${d.slice(8, 10)} ${d.slice(10, 12)}`;
}

/** Local representation with leading 0: 0501234567. */
function toLocal(normalized) {
  const d = digitsOnly(normalized);
  if (d.length !== INTERNATIONAL_LENGTH) return null;
  return '0' + d.slice(3);
}

/** List of valid mobile prefixes (without leading 0). */
function getMobilePrefixes() {
  return [...MOBILE_PREFIXES];
}

module.exports = {
  COUNTRY_CODE,
  MOBILE_PREFIXES,
  normalizePhone,
  isValidAzerbaijanMobile,
  formatPhone,
  toLocal,
  getMobilePrefixes,
};

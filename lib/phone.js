/**
 * Phone helpers — parsing of name/number lists for .rr and .ss.
 *
 * Validation & normalization is delegated to lib/azPhone.js (Azerbaijani
 * mobile numbers → 994XXXXXXXXX). This module only handles list parsing,
 * deduplication and user-friendly error messages.
 */
const { normalizePhone, isValidAzerbaijanMobile, formatPhone } = require('./azPhone');

const DEFAULT_COUNTRY_CODE = '994';

const NUMBER_RE = /^[+\d][\d\s\-()]*$/;

/** Clean a name for storage (trim, collapse whitespace). */
function cleanName(name) {
  if (name === null || name === undefined) return '';
  return String(name).trim().replace(/\s+/g, ' ');
}

/**
 * Validate a contact name.
 * @returns {{ok: boolean, name?: string, reason?: string}}
 */
function validateName(name) {
  const clean = cleanName(name);
  if (!clean) return { ok: false, reason: 'Kontakt adı boş ola bilməz' };
  if (clean.length > 80) return { ok: false, reason: `Kontakt adı çox uzundur (${clean.length} simvol, maksimum 80)` };
  return { ok: true, name: clean };
}

/**
 * Parse raw contact text into { name, phone } entries.
 * Format: name on one line, number on the next (or on the same line).
 *
 * @returns {{contacts: Array<{name, phone}>, errors: Array<{line, reason}>}}
 */
function parseContacts(text) {
  const lines = String(text || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  const contacts = [];
  const errors = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Same line: "Name Surname 0501234567"
    const parts = line.split(/\s+/);
    const lastPart = parts[parts.length - 1];
    if (NUMBER_RE.test(lastPart) && !/^[a-zəüöğıçş0-9]+$/i.test(lastPart)) {
      const name = cleanName(parts.slice(0, -1).join(' '));
      const phone = normalizePhone(lastPart);
      const nameCheck = validateName(name);
      if (nameCheck.ok && phone) {
        contacts.push({ name: nameCheck.name, phone });
      } else {
        const reason = phone ? nameCheck.reason : `Yanlış telefon nömrəsi: "${lastPart}"`;
        errors.push({ line: i + 1, reason });
      }
      i += 1;
      continue;
    }

    // Pair of lines: name, then number
    const next = lines[i + 1];
    if (next && NUMBER_RE.test(next)) {
      const phone = normalizePhone(next);
      const nameCheck = validateName(line);
      if (nameCheck.ok && phone) {
        contacts.push({ name: nameCheck.name, phone });
      } else {
        const reason = phone ? nameCheck.reason : `Yanlış telefon nömrəsi: "${next}"`;
        errors.push({ line: i + 2, reason });
      }
      i += 2;
      continue;
    }

    // Lone number without a name
    if (NUMBER_RE.test(line)) {
      errors.push({ line: i + 1, reason: `Ad yoxdur, yalnız nömrə: "${line}"` });
      i += 1;
      continue;
    }

    // Name without a number
    errors.push({ line: i + 1, reason: `Nömrə tapılmadı: "${line}"` });
    i += 1;
  }

  // Deduplicate by phone (keep first occurrence)
  const seen = new Set();
  const unique = contacts.filter((c) => {
    if (seen.has(c.phone)) return false;
    seen.add(c.phone);
    return true;
  });

  return { contacts: unique, errors };
}

/**
 * Parse a message containing only phone numbers (one per line).
 * @returns {{numbers: string[], errors: Array<{line: number, reason: string}>}}
 */
function parseNumbers(text) {
  const lines = String(text || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  const numbers = [];
  const errors = [];
  lines.forEach((l, idx) => {
    if (!NUMBER_RE.test(l)) {
      errors.push({ line: idx + 1, reason: `Nömrə formatı yanlışdır: "${l}"` });
      return;
    }
    const phone = normalizePhone(l);
    if (phone) {
      numbers.push(phone);
    } else {
      const hint = isValidAzerbaijanMobile(l)
        ? `Yanlış nömrə: "${l}" (mobil nömrə formatında deyil)`
        : `Yanlış nömrə: "${l}" (format: 0501234567, +994501234567 və ya 994501234567)`;
      errors.push({ line: idx + 1, reason: hint });
    }
  });

  return { numbers, errors };
}

module.exports = { normalizePhone, isValidAzerbaijanMobile, parseContacts, parseNumbers, DEFAULT_COUNTRY_CODE, cleanName, validateName, formatPhone };

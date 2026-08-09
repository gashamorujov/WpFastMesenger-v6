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
 * Extract phone numbers from arbitrary user text.
 *
 * Accepts numbers separated by newlines, commas, semicolons, spaces or any
 * other punctuation; numbers may contain internal separators
 * (050 123 45 67, 055-123-45-67, (050)1234567).
 *
 * @param {string} text
 * @returns {{numbers: string[], duplicates: string[], invalid: string[]}}
 */
function extractNumbers(text) {
  const numbers = [];
  const invalid = [];
  const seen = new Set();

  const push = (phone) => {
    if (!phone) return;
    if (seen.has(phone)) return;
    seen.add(phone);
    numbers.push(phone);
  };
  const markInvalid = (raw) => {
    const clean = String(raw || '').trim();
    if (clean) invalid.push(clean);
  };

  const chunks = String(text || '')
    .split(/[\n,;]+/)
    .map((c) => c.trim())
    .filter((c) => c.length > 0);

  for (const chunk of chunks) {
    // Whole chunk looks like a number (digits + separators) → try as one
    if (NUMBER_RE.test(chunk)) {
      const phone = normalizePhone(chunk);
      if (phone) {
        push(phone);
        continue;
      }
      // E.g. "0501234567 0551234567" or "050 123 45 67 055-123-45-67":
      // greedily combine space-separated parts until each forms a valid number
      const parts = chunk.split(/\s+/);
      if (parts.length > 1 && parts.every((p) => NUMBER_RE.test(p))) {
        let acc = '';
        let any = false;
        for (const part of parts) {
          acc += part.replace(/\D/g, '');
          const phone = normalizePhone(acc);
          if (phone) {
            push(phone);
            acc = '';
            any = true;
          }
        }
        if (any) continue;
      }
      markInvalid(chunk);
      continue;
    }

    // Chunk contains letters (e.g. "Nömrəm: 0501234567") → extract digit runs
    const runs = chunk.match(/\d{7,15}/g) || [];
    if (runs.length > 0) {
      for (const run of runs) {
        const phone = normalizePhone(run);
        if (phone) push(phone);
        else markInvalid(run);
      }
    } else {
      markInvalid(chunk);
    }
  }

  // Duplicates = the same number seen in different input formats
  const seenRaw = new Map();
  const duplicateSet = new Set();
  for (const chunk of chunks) {
    const digits = chunk.replace(/\D/g, '');
    if (!digits) continue;
    const key = digits.length >= 9 ? digits.slice(-9) : digits;
    if (seenRaw.has(key)) duplicateSet.add(chunk);
    else seenRaw.set(key, chunk);
  }

  return { numbers, duplicates: [...duplicateSet], invalid };
}

/**
 * Parse a message containing phone numbers (separators: lines, commas,
 * spaces, etc.). Numbers are normalized, deduplicated and split into valid
 * vs invalid groups.
 * @returns {{numbers: string[], duplicates: string[], errors: Array<{line: number, reason: string}>}}
 */
function parseNumbers(text) {
  const { numbers, duplicates, invalid } = extractNumbers(text);
  const errors = invalid.map((raw, i) => ({
    line: i + 1,
    reason: `Yanlış nömrə: "${raw}" (format: 0501234567, +994501234567 və ya 994501234567)`,
  }));
  return { numbers, duplicates, errors };
}

module.exports = { normalizePhone, isValidAzerbaijanMobile, parseContacts, parseNumbers, extractNumbers, DEFAULT_COUNTRY_CODE, cleanName, validateName, formatPhone };

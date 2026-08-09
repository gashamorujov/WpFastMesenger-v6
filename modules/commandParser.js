/**
 * CommandParser — recognizes the only three commands in the project:
 *
 *   .rr — register contacts (name + number)
 *   .ss — send a message/media to a list of numbers
 *   .gg — connect a WhatsApp account (new Pair Code)
 *   .cc — cancel the active process at any stage, anywhere
 *
 * No other commands exist.
 */
function parseCommand(text) {
  if (!text || typeof text !== 'string') return null;
  const t = text.trim();
  const lower = t.toLowerCase();

  if (lower === '.rr' || lower.startsWith('.rr ')) return { type: 'rr', arg: t.slice(3).trim() };
  if (lower === '.ss' || lower.startsWith('.ss ')) return { type: 'ss', arg: t.slice(3).trim() };
  if (lower === '.gg' || lower.startsWith('.gg ')) return { type: 'gg', arg: t.slice(3).trim() };
  if (lower === '.cc' || lower.startsWith('.cc ')) return { type: 'cc', arg: t.slice(3).trim() };

  return null;
}

/**
 * True when the message text contains ONLY numbers (and separators).
 * Used by .ss to detect "more numbers" vs actual message content.
 */
function isNumbersOnly(text) {
  if (!text || typeof text !== 'string') return false;
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) return false;
  return lines.every((l) => /^[+\d][\d\s\-()]*$/.test(l));
}

/** True when the text is a single phone number (used for Pair Code). */
function isSinglePhoneNumber(text) {
  if (!text || typeof text !== 'string') return false;
  const t = text.trim();
  if (t.includes('\n')) return false;
  if (!/^[+\d][\d\s\-()]*$/.test(t)) return false;
  const digits = t.replace(/\D/g, '');
  return digits.length >= 7 && digits.length <= 15;
}

module.exports = { parseCommand, isNumbersOnly, isSinglePhoneNumber };

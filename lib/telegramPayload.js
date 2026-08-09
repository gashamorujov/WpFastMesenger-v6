/**
 * TelegramPayload — converts a Telegram message into a Baileys sendMessage
 * payload, preserving the original format (text, image, video, audio, voice,
 * sticker, GIF, file/PDF, contact, location, captions, forwarded content).
 */
const fs = require('fs-extra');
const path = require('path');
const { makeLogger } = require('../modules/logger');

const LOG = makeLogger('TG-PAYLOAD');

const TEMP_DIR = path.join(__dirname, '..', 'temp');

async function saveBuffer(buffer, ext) {
  fs.ensureDirSync(TEMP_DIR);
  const file = path.join(TEMP_DIR, `tg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.${ext || 'bin'}`);
  await fs.writeFile(file, buffer);
  return file;
}

function buildVCard(contact) {
  const first = contact.first_name || '';
  const last = contact.last_name || '';
  const name = [first, last].filter(Boolean).join(' ') || 'Contact';
  return [
    'BEGIN:VCARD',
    'VERSION:3.0',
    `FN:${name}`,
    `N:${last};${first};;;`,
    `TEL;TYPE=CELL:${contact.phone_number || ''}`,
    'END:VCARD',
  ].join('\n');
}

/**
 * Build a sendable WhatsApp payload from a Telegram message.
 *
 * @param {object} msg — Telegram message object
 * @param {(fileId: string) => Promise<{buffer: Buffer, filePath: string}>} dl
 * @returns {Promise<{type: string, payload: object|null, tempFile?: string, reason?: string}>}
 */
async function buildPayload(msg, dl) {
  if (!msg) return { type: 'none', payload: null };

  // ── Text ──
  if (typeof msg.text === 'string' && msg.text.length > 0) {
    return { type: 'text', payload: { text: msg.text } };
  }

  // ── Photo (largest size) ──
  if (msg.photo && msg.photo.length > 0) {
    try {
      const photo = msg.photo[msg.photo.length - 1];
      const { buffer } = await dl(photo.file_id);
      const file = await saveBuffer(buffer, 'jpg');
      return {
        type: 'image',
        payload: { image: buffer, caption: msg.caption || '' },
        tempFile: file,
      };
    } catch (e) {
      LOG.error('Photo download error:', e.message);
      return { type: 'image', payload: null, reason: e.message };
    }
  }

  // ── Video ──
  if (msg.video) {
    try {
      const { buffer } = await dl(msg.video.file_id);
      const file = await saveBuffer(buffer, 'mp4');
      return {
        type: 'video',
        payload: {
          video: buffer,
          caption: msg.caption || '',
          mimetype: msg.video.mime_type || 'video/mp4',
        },
        tempFile: file,
      };
    } catch (e) {
      LOG.error('Video download error:', e.message);
      return { type: 'video', payload: null, reason: e.message };
    }
  }

  // ── Video note (round video) ──
  if (msg.video_note) {
    try {
      const { buffer } = await dl(msg.video_note.file_id);
      const file = await saveBuffer(buffer, 'mp4');
      return {
        type: 'video_note',
        payload: { video: buffer, ptt: true },
        tempFile: file,
      };
    } catch (e) {
      LOG.error('Video note download error:', e.message);
      return { type: 'video_note', payload: null, reason: e.message };
    }
  }

  // ── GIF / animation ──
  if (msg.animation) {
    try {
      const { buffer } = await dl(msg.animation.file_id);
      const file = await saveBuffer(buffer, 'mp4');
      return {
        type: 'gif',
        payload: {
          video: buffer,
          gifPlayback: true,
          caption: msg.caption || '',
          mimetype: msg.animation.mime_type || 'video/mp4',
        },
        tempFile: file,
      };
    } catch (e) {
      LOG.error('GIF download error:', e.message);
      return { type: 'gif', payload: null, reason: e.message };
    }
  }

  // ── Voice ──
  if (msg.voice) {
    try {
      const { buffer } = await dl(msg.voice.file_id);
      const file = await saveBuffer(buffer, 'ogg');
      return {
        type: 'voice',
        payload: {
          audio: buffer,
          mimetype: msg.voice.mime_type || 'audio/ogg; codecs=opus',
          ptt: true,
        },
        tempFile: file,
      };
    } catch (e) {
      LOG.error('Voice download error:', e.message);
      return { type: 'voice', payload: null, reason: e.message };
    }
  }

  // ── Audio ──
  if (msg.audio) {
    try {
      const { buffer } = await dl(msg.audio.file_id);
      const file = await saveBuffer(buffer, 'mp3');
      return {
        type: 'audio',
        payload: {
          audio: buffer,
          mimetype: msg.audio.mime_type || 'audio/mpeg',
          ptt: false,
          caption: msg.caption || '',
        },
        tempFile: file,
      };
    } catch (e) {
      LOG.error('Audio download error:', e.message);
      return { type: 'audio', payload: null, reason: e.message };
    }
  }

  // ── Document / file / PDF ──
  if (msg.document) {
    try {
      const { buffer } = await dl(msg.document.file_id);
      const file = await saveBuffer(buffer, 'bin');
      return {
        type: 'document',
        payload: {
          document: buffer,
          fileName: msg.document.file_name || 'document',
          mimetype: msg.document.mime_type || 'application/octet-stream',
          caption: msg.caption || '',
        },
        tempFile: file,
      };
    } catch (e) {
      LOG.error('Document download error:', e.message);
      return { type: 'document', payload: null, reason: e.message };
    }
  }

  // ── Sticker (static webp only) ──
  if (msg.sticker) {
    if (msg.sticker.is_animated || msg.sticker.is_video) {
      return {
        type: 'sticker',
        payload: null,
        reason: 'Animasiyalı stikerlər WhatsApp-a göndərilə bilmir',
      };
    }
    try {
      const { buffer } = await dl(msg.sticker.file_id);
      const file = await saveBuffer(buffer, 'webp');
      return { type: 'sticker', payload: { sticker: buffer }, tempFile: file };
    } catch (e) {
      LOG.error('Sticker download error:', e.message);
      return { type: 'sticker', payload: null, reason: e.message };
    }
  }

  // ── Contact ──
  if (msg.contact) {
    return {
      type: 'contact',
      payload: {
        contacts: {
          displayName: [msg.contact.first_name, msg.contact.last_name].filter(Boolean).join(' ') || 'Contact',
          contacts: [{ vcard: buildVCard(msg.contact) }],
        },
      },
    };
  }

  // ── Location ──
  if (msg.location) {
    return {
      type: 'location',
      payload: {
        location: {
          degreesLatitude: msg.location.latitude,
          degreesLongitude: msg.location.longitude,
        },
      },
    };
  }

  return { type: 'unsupported', payload: null, reason: 'Bu mesaj növü dəstəklənmir' };
}

module.exports = { buildPayload, saveBuffer };

/**
 * Convert a built payload into a persistable spec (no buffers) so bulk-message
 * jobs can be resumed after a restart. Media is referenced by file path.
 *
 * @param {{type: string, payload: object|null, tempFile?: string}} built
 * @returns {object|null} spec
 */
function specFromBuilt(built) {
  if (!built || !built.payload) return null;
  const p = built.payload;
  switch (built.type) {
    case 'text':
      return { type: 'text', text: p.text };
    case 'image':
      return { type: 'image', file: built.tempFile || null, caption: p.caption || '' };
    case 'video':
      return { type: 'video', file: built.tempFile || null, caption: p.caption || '', mimetype: p.mimetype || 'video/mp4' };
    case 'video_note':
      return { type: 'video_note', file: built.tempFile || null };
    case 'gif':
      return { type: 'gif', file: built.tempFile || null, caption: p.caption || '', mimetype: p.mimetype || 'video/mp4' };
    case 'voice':
      return { type: 'voice', file: built.tempFile || null, mimetype: p.mimetype || 'audio/ogg; codecs=opus' };
    case 'audio':
      return { type: 'audio', file: built.tempFile || null, caption: p.caption || '', mimetype: p.mimetype || 'audio/mpeg' };
    case 'document':
      return { type: 'document', file: built.tempFile || null, fileName: p.fileName || 'document', mimetype: p.mimetype || 'application/octet-stream', caption: p.caption || '' };
    case 'sticker':
      return { type: 'sticker', file: built.tempFile || null };
    case 'contact':
      return { type: 'contact', contact: p.contacts };
    case 'location':
      return { type: 'location', latitude: p.location.degreesLatitude, longitude: p.location.degreesLongitude };
    default:
      return null;
  }
}

module.exports = { buildPayload, saveBuffer, specFromBuilt };

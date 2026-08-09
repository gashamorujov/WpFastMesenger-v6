/** Small JID helpers shared by broadcast and ss (avoids circular imports). */
function jidForPhone(phone) {
  return `${phone}@s.whatsapp.net`;
}

function phoneFromJid(jid) {
  const p = String(jid || '').split('@')[0];
  return p.replace(/[^0-9]/g, '');
}

module.exports = { jidForPhone, phoneFromJid };

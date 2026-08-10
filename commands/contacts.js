/**
 * contacts — 📒 Kontaktlar: daxili kontakt database-ni idarə edir.
 *
 * Struktur:
 *   📒 Kontaktlar (ct:menu)
 *   ├── ✏️ Düzəliş et (ct:edit) → mövcud brauzer (ad/nömrə ilə axtarış + düzəliş)
 *   └── 🗄 Database (ct:db)
 *       ├── ➕ Kontakta əlavə et (ct:sync) → database-dəki BÜTÜN kontaktları
 *       │     WhatsApp kontaktlarına əlavə edir (mövcud mexanizmlə)
 *       └── ↩️ Geri
 *
 * Callbacks (`ct:*`) tapped mesajı yerində redaktə edir. Ad/nömrə
 * dəyişdiriləndə database avtomatik yenilənir (contactStore).
 */
const { sessionManager, getTelegramMessenger } = require('../modules/services');
const { STATES } = require('../modules/sessionManager');
const contactStore = require('../modules/contactStore');
const contactService = require('../modules/contactService');
const { buildContactList, buildContactActions, buildContactInfo } = require('../lib/contactBrowser');
const { validateName, extractNumbers } = require('../lib/phone');
const { formatPhone } = require('../lib/azPhone');
const { CONTACTS_MENU_BUTTONS, DATABASE_MENU_BUTTONS } = require('../lib/menu');

/** Open the contact list as a new message (✏️ Düzəliş et). */
async function openList(chatId, ctx) {
  const s = sessionManager.get(chatId);
  s.state = STATES.IDLE;
  sessionManager.touch(chatId);

  const contacts = contactStore.list();
  const { text, keyboard } = buildContactList(contacts, 0);
  const sent = await ctx.send(text, { reply_markup: { inline_keyboard: keyboard } });
  return sent;
}

/** Render the list into an existing message (pagination / back). */
async function renderList(chatId, ctx, page = 0) {
  const contacts = contactStore.list();
  const { text, keyboard } = buildContactList(contacts, page);
  await ctx.edit(text, { reply_markup: { inline_keyboard: keyboard } });
}

async function openActions(chatId, phone, ctx) {
  const contact = contactStore.get(phone);
  if (!contact) {
    await ctx.edit('❌ Kontakt tapılmadı (silinib).', { reply_markup: { inline_keyboard: [[{ text: '↩️ Geri', callback_data: 'ct:back' }]] } });
    return;
  }
  const { text, keyboard } = buildContactActions(contact);
  await ctx.edit(text, { reply_markup: { inline_keyboard: keyboard } });
}

function contactKeyboard(phone, extra = []) {
  const rows = [
    [
      { text: '✏️ Ad', callback_data: `ct:rename:${phone}` },
      { text: '🔢 Nömrə', callback_data: `ct:num:${phone}` },
    ],
    [
      { text: '🗑 Sil', callback_data: `ct:del:${phone}` },
      { text: '👁 Məlumat', callback_data: `ct:view:${phone}` },
    ],
    [{ text: '↩️ Geri', callback_data: 'ct:back' }],
  ];
  for (const row of extra) rows.push(row);
  return rows;
}

/**
 * Handle a `ct:*` callback action.
 * @param {string} chatId
 * @param {string} action — e.g. 'view:994501234567' | 'page:2' | 'menu' | 'db' | 'sync'
 * @param {object} ctx — { send, edit, deleteMsg, messageId }
 */
async function handleAction(chatId, action, ctx) {
  if (!action) return false;
  const s = sessionManager.get(chatId);
  sessionManager.touch(chatId);

  const [cmd, payload] = action.split(':');

  if (cmd === 'menu') {
    // 📒 Kontaktlar bölməsi: ✏️ Düzəliş et / 🗄 Database
    s.state = STATES.IDLE;
    await ctx.edit('📒 Kontaktlar\n\nSeçim edin:', { reply_markup: { inline_keyboard: CONTACTS_MENU_BUTTONS } });
    return true;
  }

  if (cmd === 'edit') {
    await openList(chatId, ctx);
    return true;
  }

  if (cmd === 'db') {
    s.state = STATES.IDLE;
    const total = contactStore.count();
    await ctx.edit(
      `🗄 Database\n\nDaxili bazada ${total} kontakt saxlanılır.\n\nDatabase-dəki bütün kontaktları WhatsApp kontaktlarına əlavə etmək üçün düyməyə toxunun:`,
      { reply_markup: { inline_keyboard: DATABASE_MENU_BUTTONS } }
    );
    return true;
  }

  if (cmd === 'sync') {
    // Database → WhatsApp kontaktları (mövcud addOrEditContact mexanizmi)
    const progress = await ctx.send('🗄 Database sinxronlaşdırılır…\n\nKontaktlar WhatsApp kontaktlarına əlavə edilir...');
    const res = await contactService.syncAllToWhatsApp();
    const lines = [
      res.ok ? '✅ Sinxronlaşdırma tamamlandı.' : `❌ ${res.reason || 'Sinxronlaşdırma mümkün olmadı.'}`,
      '',
      `🗄 Database kontaktları: ${res.total}`,
      `✅ WhatsApp-a əlavə edildi: ${res.okCount}`,
    ];
    if (res.failed.length > 0) {
      lines.push('', `❌ Uğursuz (${res.failed.length}):`);
      for (const f of res.failed.slice(0, 10)) lines.push(`• ${f.name} — ${f.reason}`);
      if (res.failed.length > 10) lines.push(`...və daha ${res.failed.length - 10}`);
    }
    lines.push('', 'Yenidən sinxronlaşdırmaq üçün düyməyə toxunun.');
    const text = lines.join('\n');
    const m = getTelegramMessenger();
    if (m && progress?.message_id) {
      try {
        await m.editMessage(chatId, progress.message_id, text, { reply_markup: { inline_keyboard: DATABASE_MENU_BUTTONS } });
      } catch {
        await ctx.send(text);
      }
    } else {
      await ctx.send(text);
    }
    return true;
  }

  if (cmd === 'search') {
    s.state = STATES.CT_SEARCH;
    s.ctMsgId = ctx.messageId;
    await ctx.edit('🔍 Axtar:\n\nAd və ya telefon nömrəsi yazın.\n\nMəsələn: "Akif" və ya "0501234567"', {
      reply_markup: { inline_keyboard: [[{ text: '↩️ Geri', callback_data: 'ct:back' }]] },
    });
    return true;
  }

  if (cmd === 'open') {
    await openList(chatId, ctx);
    return true;
  }

  if (cmd === 'page') {
    await renderList(chatId, ctx, parseInt(payload, 10) || 0);
    return true;
  }

  if (cmd === 'back') {
    // List / actions screen → delete itself, main menu (banner) remains
    if (ctx.deleteMsg && ctx.messageId) await ctx.deleteMsg(chatId, ctx.messageId);
    return true;
  }

  if (cmd === 'view') {
    const contact = contactStore.get(payload);
    if (!contact) {
      await ctx.edit('❌ Kontakt tapılmadı.', { reply_markup: { inline_keyboard: [[{ text: '↩️ Geri', callback_data: 'ct:back' }]] } });
      return true;
    }
    const info = buildContactInfo(contact);
    const { text, keyboard } = buildContactActions(contact);
    await ctx.edit(`${info}\n\n${text}`, { reply_markup: { inline_keyboard: keyboard } });
    return true;
  }

  if (cmd === 'rename') {
    const contact = contactStore.get(payload);
    if (!contact) { await ctx.edit('❌ Kontakt tapılmadı.'); return true; }
    s.state = STATES.CT_RENAME;
    s.ctPhone = contact.phone;
    s.ctMsgId = ctx.messageId;
    await ctx.edit(`✏️ Yeni adı yaz:\n\n👤 ${contact.name}\n📱 ${formatPhone(contact.phone)}`, {
      reply_markup: { inline_keyboard: [[{ text: '↩️ Geri', callback_data: 'ct:back' }]] },
    });
    return true;
  }

  if (cmd === 'num') {
    const contact = contactStore.get(payload);
    if (!contact) { await ctx.edit('❌ Kontakt tapılmadı.'); return true; }
    s.state = STATES.CT_NUMBER;
    s.ctPhone = contact.phone;
    s.ctMsgId = ctx.messageId;
    await ctx.edit(`🔢 Yeni nömrəni yaz:\n\n👤 ${contact.name}\n📱 ${formatPhone(contact.phone)}\n\nFormat: 0501234567 və ya +994501234567`, {
      reply_markup: { inline_keyboard: [[{ text: '↩️ Geri', callback_data: 'ct:back' }]] },
    });
    return true;
  }

  if (cmd === 'del') {
    const contact = contactStore.get(payload);
    if (!contact) { await ctx.edit('❌ Kontakt tapılmadı.'); return true; }
    contactStore.remove(contact.phone);
    await ctx.edit(`🗑 Silindi: ${contact.name}\n📱 ${formatPhone(contact.phone)}\n\n📒 Daxili bazada qalan: ${contactStore.count()}`, {
      reply_markup: { inline_keyboard: [[{ text: '📒 Kontaktlar', callback_data: 'ct:menu' }], [{ text: '↩️ Geri', callback_data: 'ct:back' }]] },
    });
    return true;
  }

  return false;
}

/**
 * Handle text input while a contact flow is active (rename / number / search).
 * @param {string} chatId
 * @param {string} text
 * @param {object} ctx — { send, edit }
 */
async function handleText(chatId, text, ctx) {
  const s = sessionManager.get(chatId);
  sessionManager.touch(chatId);

  if (s.state === STATES.CT_SEARCH) {
    const results = contactStore.search(text);
    s.state = STATES.IDLE;
    s.ctPhone = null;
    if (results.length === 0) {
      await ctx.edit(`🔍 "${text.trim()}" üzrə kontakt tapılmadı.`, {
        reply_markup: {
          inline_keyboard: [
            [{ text: '🔍 Yeni axtarış', callback_data: 'ct:search' }],
            [{ text: '↩️ Geri', callback_data: 'ct:back' }],
          ],
        },
      });
      return true;
    }
    const { text: listText, keyboard } = buildContactList(results, 0);
    await ctx.edit(listText, { reply_markup: { inline_keyboard: keyboard } });
    return true;
  }

  if (s.state === STATES.CT_RENAME) {
    const check = validateName(text);
    if (!check.ok) {
      await ctx.edit(`❌ ${check.reason}. Yenidən yazın.`, {
        reply_markup: { inline_keyboard: [[{ text: '↩️ Geri', callback_data: 'ct:back' }]] },
      });
      return true;
    }
    const contact = contactStore.get(s.ctPhone);
    if (!contact) { await ctx.edit('❌ Kontakt tapılmadı.'); return true; }
    contactStore.updateName(contact.phone, check.name);
    const fresh = contactStore.get(s.ctPhone);
    s.state = STATES.IDLE;
    s.ctPhone = null;
    await ctx.edit(`✅ Ad yeniləndi:\n\n👤 ${fresh.name}\n📱 ${formatPhone(fresh.phone)}`, {
      reply_markup: { inline_keyboard: contactKeyboard(fresh.phone) },
    });
    return true;
  }

  if (s.state === STATES.CT_NUMBER) {
    const { numbers, invalid } = extractNumbers(text);
    const contact = contactStore.get(s.ctPhone);
    if (!contact) { await ctx.edit('❌ Kontakt tapılmadı.'); return true; }

    const phone = numbers[0] || null;
    if (!phone || invalid.length > 0 || numbers.length > 1) {
      await ctx.edit(`❌ Yanlış nömrə formatı (${invalid[0] || text}).\n\nFormat: 0501234567 və ya +994501234567`, {
        reply_markup: { inline_keyboard: [[{ text: '↩️ Geri', callback_data: 'ct:back' }]] },
      });
      return true;
    }

    if (phone === contact.phone) {
      await ctx.edit('ℹ️ Bu nömrə artıq həmin kontaktdadır.', {
        reply_markup: { inline_keyboard: contactKeyboard(contact.phone) },
      });
      return true;
    }

    const res = contactStore.changePhone(contact.phone, phone);
    if (!res.ok) {
      await ctx.edit(`❌ ${res.reason}`, {
        reply_markup: { inline_keyboard: contactKeyboard(contact.phone) },
      });
      return true;
    }
    s.state = STATES.IDLE;
    s.ctPhone = null;
    await ctx.edit(`✅ Nömrə yeniləndi:\n\n👤 ${res.contact.name}\n📱 ${formatPhone(res.contact.phone)}`, {
      reply_markup: { inline_keyboard: contactKeyboard(res.contact.phone) },
    });
    return true;
  }

  return false;
}

module.exports = { openList, handleAction, handleText };

# WpFastMesenger — WhatsApp Automation Bot (v5)

Telegram üzərindən idarə olunan, **WhatsApp kontaktlarına kontakt əlavə etmə** və **toplu mesaj** sistemi.

> Arxa plan: bu layihə Android tətbiqi deyil, Node.js (Baileys) əsaslı **Telegram-ilə-idarə olunan WhatsApp botudur**. Bütün əmrlər Telegram-da yazılır, icra WhatsApp hesabında (rəsmi Linked Devices / WhatsApp Web protokolu üzərində) baş verir.

## 🚀 Deploy

### Railway
New Project → Deploy from GitHub → `gashamorujov/WpFastMesenger-v5`

Tələb olunan environment dəyişənləri:
| Dəyişən | Məcburi | İzah |
|---|---|---|
| `TELEGRAM_TOKEN` | ❌ | Telegram bot tokeni — proyektə əlavə edilib, deploy üçün lazım deyil (env dəyişəni üstünlük təşkil edir) |
| `PORT` | ❌ | HTTP health server portu (default 3000) |
| `PAIR_NUMBER` | ❌ | İlk açılışda avtomatik qoşulacaq nömrə |

### VPS
```bash
curl -sL https://github.com/gashamorujov/WpFastMesenger-v5/raw/main/scripts/deploy-vps.sh | bash
```

## 🤖 Əmrlər

| Əmr | Funksiya |
|---|---|
| `/start` | Banner + əsas menyu (📒 Kontaktlar • 📇 Kontakt Əlavə Et • 📨 Toplu Mesaj • 📲 Qoşul) |
| `.gg` / `/qeydiyyat` | WhatsApp-a qoşulma (🔐 Pair Code), 🔄 Reconnect, 🚪 Çıxış |
| `.rr` | Kontakt əlavə etmə (WhatsApp kontaktlarına) |
| `.ss` | Toplu mesaj göndərmə (nömrələr → mesaj → təsdiq → 🚀 Göndər) |
| `.cc` | İstənilən mərhələdə ləğv |

### 📇 `.rr` — Kontakt əlavə etmə

1. `.rr` yazın → format göstərilir.
2. Kontaktları göndərin (Ad və nömrə cüt-cüt):
   ```
   Quliyev Cəmil Bayram
   0503767264

   Akif Babayev
   077 364 86 48

   Əli Məmmədov +994551234567
   ```
3. Hər kontakt:
   - **Yoxlanılır** (Azərbaycan mobil nömrə formatı) — yanlış sətirlər ayrıca bildirilir;
   - **Deduplicate edilir** — eyni nömrə müxtəlif formatda daxil edilsə də bir dəfə yazılır; mövcud kontakt varsa *duplicate yaradılmır*, ad yenilənir;
   - **WhatsApp kontaktlarına əlavə olunur** — rəsmi Linked Devices `contactAction` sinxronizasiyası ilə (`sock.addOrEditContact`, yalnız WhatsApp kontaktlarında — telefonun adi kontakt kitabçasına **yazılmır**);
   - **Daxili bazada saxlanılır** (`data/contacts.json`) — `.ss` kontakt seçicisinin mənbəyi budur;
   - WhatsApp qeydiyyatı yoxlanılır (USync `onWhatsApp` — yalnız server təsdiqi).
4. WhatsApp bağlantısı yoxdursa kontakt yenə də daxili bazada saxlanılır (proses heç vaxt çökmür).
5. Sonda hesabat: WhatsApp-a əlavə edilənlər / yenilənənlər / duplikatlar / yalnız daxili saxlanılanlar / xətalar / WhatsApp-da olmayanlar.

### 📒 Kontaktlar (daxili baza)

`/start` menyusundakı **📒 Kontaktlar** düyməsi botun daxili kontakt bazasını açır (`data/contacts.json`). Səhifələnmiş siyahıda hər kontakta toxunmaqla:

- **👁 Məlumat** — WhatsApp statusu, əlavə/ yenilənmə tarixi;
- **✏️ Ad** — kontaktın adını dəyiş;
- **🔢 Nömrə** — kontaktın nömrəsini dəyiş (duplicate qorunur);
- **🗑 Sil** — kontaktı bazadan sil.

### 📨 `.ss` — Toplu mesaj

1. `.ss` yazın → **📱 Nömrələri göndər**.
2. Nömrələri istənilən ayırıcı ilə yazın: sətir, vergül, nöqtəli vergül, boşluq — hamısı dəstəklənir. Duplicate-lər və yanlış formatlar avtomatik bildirilir (yalnız Azərbaycan mobil nömrələri).
3. Mesajı göndərin: mətn, şəkil, video, səs, stiker, GIF, fayl, PDF, caption-lı media — format dəyişdirilmir. Bu mərhələdə yenidən nömrə yazsanız siyahıya **əlavə olunur**.
4. Təsdiq ekranı: **📨 Hazırdır** (nömrələr alt-alta) → **[🚀 Göndər]** tam genişlikdə, altında **[✖️ Geri]**. Göndərmə başlayan kimi eyni mesaj canlı progress olur və tam genişlikdə **🛑 Göndərişi Dayandır** düyməsi görünür (yalnız aktiv göndəriş zamanı).
5. Göndəriş **persistent job** kimi işləyir (`data/jobs/`):
   - ardıcıl (queue), təsadüfi gecikmələrlə (WhatsApp limitlərinə uyğun);
   - hər nömrə üçün status: `göndərildi / xəta / atlandı / gözləyir`;
   - canlı **progress** — eyni Telegram mesajı yenilənir; **🛑 Dayandır** yalnız göndəriş aktiv olduqda görünür və iş bitdikdə avtomatik silinir;
   - server **ACK** izlənməsi — hesabatda "📨 WhatsApp tərəfindən qəbul edildi" sayı;
   - **WhatsApp-da olmayan nömrələr** əvvəlcədən yoxlanılır və atlanır (göndərməyə cəhd edilmir);
   - eyni nömrəyə təkrar göndərmə qoruyucusu (`DUPLICATE_SEND_TTL_MIN`);
   - xəta olan nömrə prosesi dayandırmır; sonda **📨 Yenidən göndər** və **🔁 Uğursuzları təkrar** düymələri;
   - bağlantı kəsilərsə və ya proses yenidən başladılarsa job **avtomatik bərpa olunur** (göndərilmişlər təkrarlanmır);
   - `.cc` və ya **🛑 Dayandır** işi ləğv edir — ləğv edilmiş iş bir daha bərpa olunmur;
   - əməliyyat bitəndə sorğu/seçim/ara mərhələ bot mesajları avtomatik silinir — yalnız yekun nəticə mesajı qalır;
   - toplu göndəriş zamanı WhatsApp-dan gələn sorğular (cavablar) yadda saxlanılır və göndəriş **tamamilə bitəndən sonra** Telegram çatında ən aşağıda — bizim mesajımızın altında görünür (`WA_FORWARD_INCOMING` ilə söndürmək olar).

## 📥 Gələn sorğular (WhatsApp → Telegram)

Qoşulmuş WhatsApp hesabına gələn mesajlar avtomatik olaraq hesabın sahibi olan Telegram çatına əks olunur:

- **Toplu göndəriş aktiv olmadıqda** — mesaj gələn kimi dərhal ötürülür;
- **Toplu göndəriş aktiv olduqda** — gələn sorğular yaddaşda saxlanılır və göndəriş **tam bitəndən sonra** (yekun hesabatdan sonra) ardıcıl ötürülür. Beləliklə onlar həmişə bizim yazdığımız mesajın **aşağısında, ən aşağıda** görünür;
- Öz göndərdiyimiz mesajlar (`fromMe`), status yeniləmələri, tarix sinxronizasiyası və protokol mesajları (reaksiya və s.) ötürülmür;
- Mətn gələn kimi göstərilir; media (şəkil, video, səs, fayl və s.) növü və başlığı ilə bildirilir.

Nəzarət: `WA_FORWARD_INCOMING=false` ilə söndürün.

## 🇦🇿 Azərbaycan nömrə formatları

Bütün nömrələr daxildə vahid beynəlxalq formata normalizə olunur: **`994XXXXXXXXX`**.

Dəstəklənən daxiletmə formatları:
```
+994501234567     994501234567     0501234567
501234567         050 123 45 67    055-123-45-67
+994 50 123 45 67 (050)123-45-67   050.123.45.67
```

Qəbul edilən mobil prefikslər (Azercell: 010/050/051, Bakcell: 055/099, Nar: 070/077, AzInTelecom: 060):
`10, 50, 51, 55, 60, 70, 77, 99`.

Yanlış nömrələr üçün aydın Azərbaycan dilində xəta mesajı göstərilir və sətir nəzərə alınmır.

## 🔐 İcazələr / tələblər

- `TELEGRAM_TOKEN` — Telegram bot tokeni proyektə əlavə edilib, **deploy üçün konfiqurasiya tələb olunmur**. Env dəyişəni ilə dəyişdirmək istəsəniz: `TELEGRAM_TOKEN=...`.
- WhatsApp nömrəsinin **Pair Code** ilə qoşulması — rəsmi WhatsApp → Linked Devices → Link with phone number (kod yalnız 5 dəqiqə etibarlıdır).
- Fayl sisteminə yazma: `sessions/` (auth state), `data/` (kontaktlar, job-lar, son göndərişlər), `temp/` (media keşi).
- Android permission-lar bu arxitekturada tətbiq edilmir (cihaz kodu işləmir) — tətbiq server tərəfdə işləyir.

## ⚙️ Konfiqurasiya (environment)

| Dəyişən | Default | İzah |
|---|---|---|
| `TELEGRAM_TOKEN` | daxili default | Telegram bot tokeni (proyektə əlavə olunub; env ilə override etmək olar) |
| `WA_PRESENCE_CHECK` | `true` | WhatsApp qeydiyyat yoxlaması (USync) |
| `WA_SKIP_UNREGISTERED` | `true` | Qeydiyyatda olmayan nömrələri atla |
| `BROADCAST_DELAY_MIN_MS` | `3000` | Göndərişlər arası min gecikmə |
| `BROADCAST_DELAY_MAX_MS` | `7000` | Göndərişlər arası max gecikmə |
| `BROADCAST_MAX_RETRIES` | `2` | Hər nömrə üçün retry sayı |
| `DUPLICATE_SEND_TTL_MIN` | `10` | Təkrar göndərmə qoruyucusu (dəq.; `0` = söndür) |
| `WA_FORWARD_INCOMING` | `true` | WhatsApp-dan gələn sorğuları sahib Telegram çatına ötür (`false`/`0` = söndür) |

## 📡 WhatsApp inteqrasiyası — məhdudiyyətlər

- Bot **rəsmi WhatsApp Web (multi-device) protokolunun açıq, sənədləşdirilmiş API-lərindən** istifadə edir: `sendMessage`, `onWhatsApp` (USync), `addOrEditContact` (app-state contactAction — WhatsApp Web-in özünün kontakt əlavə etmə mexanizmi). Scraping, private/unofficial API və ya hesabı riskə atan workaround **yoxdur**.
- **Kontakt saxlanması**: WhatsApp Web protokolu vasitəsilə kontakt yalnız WhatsApp-ın öz kontakt siyahısına yazılır; telefonun native kontakt kitabçasına birbaşa yazmaq bu protokolla mümkün deyil (tam olaraq istənilən davranış: kontakt telefon kitabçasında deyil, WhatsApp kontaktlarında saxlanır). Hər halda kontakt botun daxili bazasında da saxlanır.
- **Toplu mesaj**: WhatsApp üçüncü tərəf botlar üçün rəsmi "bulk API" vermir. Həddindən artıq sürətli/agressiv göndəriş nömrənin məhdudlaşdırılmasına və ya bloklanmasına səbəb ola bilər — buna görə göndərişlər ardıcıl və təsadüfi gecikmələrlə aparılır (dəyərləri yuxarıdakı env-lərlə tənzimləyin).
- **Nömrənin WhatsApp-da olub-olmadığı**: yalnız WhatsApp serverinin USync cavabı etibarlıdır. Yoxlama müvəqqəti uğursuz olsa, nömrə "naməlum" kimi göndərilir (göndərmə dayanmır); WhatsApp-da olmadığı **təsdiqlənən** nömrələr atlanır.
- **Telefon qapalı/arxa plandadırsa**: Baileys server tərəfli göndərişə yazır; mesaj telefon qoşulanda çatdırılır. Bot bağlantısı kəsilərsə job "interrupted" olur və bağlantı bərpa olunanda avtomatik davam edir.

## 🧪 Build & Test

```bash
npm install
npm test          # 71 unit test (phone, contacts, contactBrowser, broadcast, queue, jobs, ss flow, payload)
npm start         # token proyektə əlavə olunub — heç bir env tələb olunmur
```

Sağlamlıq yoxlaması: `GET /health` → `{ status, telegram, whatsapp, sha, uptime }`.

## 📁 Struktur

```
lib/
  azPhone.js            # Azərbaycan nömrə validasiyası + normalizasiyası (994XXXXXXXXX)
  phone.js              # .rr/.ss mətn parsing, dedup, ad yoxlaması
  broadcast.js          # ardıcıl göndərmə mühərriki (retry, progress, skip, cancel, ACK)
  contactBrowser.js     # 📒 kontakt brauzeri (səhifələmə, əməliyyatlar)
  telegramPayload.js    # Telegram → WhatsApp payload (format saxlanılır)
  menu.js               # emoji menyu + düymə layout-ları
modules/
  contactStore.js       # persistent kontakt bazası (data/contacts.json, upsert/dedup)
  contactService.js     # .rr pipeline: saxla + WhatsApp kontakt sinxronizasiyası
  waPresence.js         # onWhatsApp (USync) + addOrEditContact (contactAction)
  jobStore.js           # persistent job state (data/jobs/, resume/cancel)
  broadcastService.js   # qlobal serialized göndərmə queue + job lifecycle
  recentSends.js        # təkrar göndərmə qoruyucusu
  queue.js              # FIFO ardıcıl worker (cancel, removeWhere)
  whatsappManager.js    # Baileys socket lifecycle, watchdog, onConnected hooks
  sessionManager.js     # per-chat FSM session
  telegramBot.js        # Telegram giriş nöqtəsi + callback-lər
  commandParser.js      # .rr/.ss/.gg/.cc + alias-lar
commands/
  rr.js                 # .rr axını
  ss.js                 # .ss axını (nömrə → mesaj → təsdiq → göndər)
  contacts.js           # 📒 kontakt idarəetmə axını (bax/dəyiş/sil)
```

/**
 * Nafsi Clinic — Book Delivery & Course Enrollment Function
 * Triggered by Stripe webhook on checkout.session.completed
 *
 * BOOKS: Sends buyer a PDF/audio download link via Brevo email
 * CBT CERTIFICATION: Creates Wix member → triggers Wix password-set email
 *                    → sends bilingual welcome email with course access link
 *
 * Required Netlify Environment Variables:
 *   STRIPE_SECRET_KEY        — Stripe secret key (sk_live_...)
 *   STRIPE_WEBHOOK_SECRET    — Stripe webhook signing secret
 *   BREVO_KEY                — Brevo API key (free account)
 *   AUDIOBOOK_URL            — Google Drive link to CBT audiobook
 *   WIX_API                  — Wix API key (Wix dashboard → Settings → API Keys)
 */

const crypto = require('crypto');

/* ── Wix site config ────────────────────────────────────────────────── */
const WIX_SITE_ID   = '5f8da983-bc12-4153-b159-138203867b69';
const PROGRAM_ID    = 'eb8ec84e-efe5-4bd6-818a-d4b185311a8e';
const COURSE_URL    = 'https://courses.nafsiclinic.com/my-programs';
const CERT_PRICE_ID = 'price_1TLbd8DO6zLlf3eNxFpEC0cg';

/* ── Session price IDs ──────────────────────────────────────────────── */
const SESSION_PRICES = {
  'price_1TLbSaDO6zLlf3eNgjWE4sAX': { label: 'Single Session',    sessions: 1,  price: '$120' },
  'price_1TLbSbDO6zLlf3eNqmHurTOz': { label: 'Starter Package',   sessions: 5,  price: '$495' },
  'price_1TLbV2DO6zLlf3eNmzAubpDv': { label: '8-Session Package', sessions: 8,  price: '$749' },
};

/* ── Book catalogue: Stripe Price ID → download info ───────────────── */
const BOOKS = {
  // Narcissism book (Arabic)
  'price_1TLbd7DO6zLlf3eNsnaJWA7J': {
    nameEn: 'Narcissism: The Disease & The Cure',
    nameAr: 'النرجسية: الداء والدواء',
    url: 'https://nafsiclinic.com/books/narcissism-ar.pdf',
    type: 'pdf',
  },
  // CBT e-book (English)
  'price_1TLbobDO6zLlf3eNRsqYvli7': {
    nameEn: 'Let Go of the Past & Reclaim Your Life',
    nameAr: 'تخلّص من الماضي واستعد حياتك',
    url: 'https://nafsiclinic.com/books/cbt-ebook-en.pdf',
    type: 'pdf',
  },
  // CBT e-book (Arabic)
  'price_1TLbocDO6zLlf3eNdXTPBwz6': {
    nameEn: 'Let Go of the Past & Reclaim Your Life (Arabic)',
    nameAr: 'تخلّص من الماضي واستعد حياتك – النسخة العربية',
    url: 'https://nafsiclinic.com/books/cbt-ebook-ar.pdf',
    type: 'pdf',
  },
  // CBT Audiobook (Google Drive — set AUDIOBOOK_URL env var)
  'price_1TLbodDO6zLlf3eN7EugInuR': {
    nameEn: 'CBT Audiobook',
    nameAr: 'الكتاب الصوتي – تخلّص من الماضي',
    get url() { return process.env.AUDIOBOOK_URL || ''; },
    type: 'audio',
  },
  // Red Sky — novel (PDF)
  'price_1TM2JxDO6zLlf3eNlLTiEHCV': {
    nameEn: 'Red Sky',
    nameAr: 'السماء الحمراء',
    url: 'https://nafsiclinic.com/books/pod-book.pdf',
    type: 'pdf',
  },
};

/* ── Stripe webhook signature verification ──────────────────────────── */
function verifyStripeSignature(rawBody, sigHeader, secret) {
  try {
    const pairs = {};
    sigHeader.split(',').forEach(part => {
      const [k, v] = part.split('=');
      pairs[k.trim()] = v.trim();
    });
    const signed = `${pairs.t}.${rawBody}`;
    const expected = crypto.createHmac('sha256', secret).update(signed, 'utf8').digest('hex');
    return crypto.timingSafeEqual(Buffer.from(pairs.v1, 'hex'), Buffer.from(expected, 'hex'));
  } catch {
    return false;
  }
}

/* ── Fetch Stripe line items ─────────────────────────────────────────── */
async function getLineItems(sessionId) {
  const res = await fetch(
    `https://api.stripe.com/v1/checkout/sessions/${sessionId}/line_items?limit=10`,
    { headers: { Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}` } }
  );
  const data = await res.json();
  return data.data || [];
}

/* ── Wix Members API helpers ────────────────────────────────────────── */
function wixHeaders() {
  return {
    'Content-Type': 'application/json',
    'Authorization': process.env.WIX_API,
    'wix-site-id': WIX_SITE_ID,
  };
}

async function createWixMember(email, name) {
  const [firstName, ...rest] = (name || '').trim().split(' ');
  const lastName = rest.join(' ');
  const body = { member: { loginEmail: email, status: 'APPROVED' } };
  if (firstName) body.member.contact = { firstName, lastName: lastName || undefined };

  const res = await fetch('https://www.wixapis.com/members/v1/members', {
    method: 'POST',
    headers: wixHeaders(),
    body: JSON.stringify(body),
  });
  const data = await res.json();

  // 409 = member already exists — that's fine
  if (!res.ok && res.status !== 409) {
    console.warn(`[enrollment] Wix member create ${res.status}:`, JSON.stringify(data));
  } else {
    console.log(`[enrollment] Wix member ready for ${email} (${res.status})`);
  }
  return data;
}

async function sendWixPasswordEmail(email) {
  const res = await fetch(
    'https://www.wixapis.com/members/v1/auth/members/send-set-password-email',
    {
      method: 'POST',
      headers: wixHeaders(),
      body: JSON.stringify({ email, hideIgnoreMessage: false }),
    }
  );
  const data = await res.json();
  if (!res.ok) {
    console.warn(`[enrollment] Wix set-password email ${res.status}:`, JSON.stringify(data));
  } else {
    console.log(`[enrollment] ✓ Wix password-set email dispatched to ${email}`);
  }
  return data;
}

/* ── Send book delivery email via Brevo ─────────────────────────────── */
async function sendBookEmail(toEmail, toName, book) {
  const firstName = (toName || '').split(' ')[0] || 'there';
  const typeLabel = book.type === 'audio' ? 'audiobook' : 'e-book';

  const html = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f5f5f0;font-family:Arial,Helvetica,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f5f5f0;padding:40px 0;">
    <tr><td align="center">
      <table width="560" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.08);">
        <tr><td style="background:#2C5F5D;padding:32px 40px;text-align:center;">
          <h1 style="color:#ffffff;font-family:Georgia,serif;font-size:26px;margin:0;">Nafsi Clinic</h1>
          <p style="color:rgba(255,255,255,0.7);font-size:13px;margin:6px 0 0;">عيادة نفسي · Sara Adham CBT</p>
        </td></tr>
        <tr><td style="padding:40px 40px 32px;">
          <h2 style="color:#2C5F5D;font-size:22px;margin:0 0 12px;">Your download is ready! 🎉</h2>
          <p style="color:#555;font-size:15px;line-height:1.7;margin:0 0 8px;">Hi ${firstName},</p>
          <p style="color:#555;font-size:15px;line-height:1.7;margin:0 0 24px;">
            Thank you for your purchase. Your ${typeLabel} <strong>${book.nameEn}</strong> is ready below.
          </p>
          <table width="100%" cellpadding="0" cellspacing="0">
            <tr><td style="background:#f0f7f7;border-radius:12px;padding:28px;text-align:center;">
              <p style="color:#2C5F5D;font-size:16px;font-weight:bold;margin:0 0 6px;">${book.nameEn}</p>
              <p style="color:#888;font-size:13px;direction:rtl;margin:0 0 20px;">${book.nameAr}</p>
              <a href="${book.url}" style="display:inline-block;background:#2C5F5D;color:#ffffff;text-decoration:none;font-weight:bold;font-size:15px;padding:14px 36px;border-radius:8px;">⬇ Download Now</a>
              <p style="color:#aaa;font-size:11px;margin:14px 0 0;">Or copy: <a href="${book.url}" style="color:#2C5F5D;word-break:break-all;">${book.url}</a></p>
            </td></tr>
          </table>
          <div style="margin-top:28px;padding:20px;background:#fdf9f0;border-radius:10px;text-align:right;direction:rtl;">
            <p style="color:#555;font-size:14px;line-height:1.8;margin:0;">
              مرحباً ${firstName}،<br>
              شكراً لشرائك <strong>${book.nameAr}</strong>. اضغط على الزر أعلاه للتحميل.
            </p>
          </div>
          <p style="color:#888;font-size:13px;margin:24px 0 0;line-height:1.6;">
            Questions? Reply to this email or reach Sara at
            <a href="mailto:sara65adham@gmail.com" style="color:#2C5F5D;">sara65adham@gmail.com</a>
          </p>
        </td></tr>
        <tr><td style="background:#f9f9f7;padding:20px 40px;text-align:center;border-top:1px solid #eee;">
          <p style="color:#bbb;font-size:11px;margin:0;">Nafsi Clinic · nafsiclinic.com · Sara Adham CBT Therapist</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;

  const res = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: { 'api-key': process.env.BREVO_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sender: { name: 'Nafsi Clinic | عيادة نفسي', email: 'sara65adham@gmail.com' },
      to: [{ email: toEmail, name: toName || toEmail }],
      subject: `Your download: ${book.nameEn} | ${book.nameAr}`,
      htmlContent: html,
    }),
  });

  if (!res.ok) throw new Error(`Brevo ${res.status}: ${await res.text()}`);
  return res.json();
}

/* ── Send certification welcome email via Brevo ──────────────────────── */
async function sendCertificationEmail(toEmail, toName) {
  const firstName = (toName || '').split(' ')[0] || 'there';

  const html = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f5f5f0;font-family:Arial,Helvetica,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f5f5f0;padding:40px 0;">
    <tr><td align="center">
      <table width="580" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.08);">

        <!-- Header -->
        <tr><td style="background:linear-gradient(135deg,#1a3d3b,#2C5F5D);padding:40px;text-align:center;">
          <h1 style="color:#ffffff;font-family:Georgia,serif;font-size:28px;margin:0 0 6px;">Nafsi Clinic</h1>
          <p style="color:rgba(255,255,255,0.7);font-size:14px;margin:0;">عيادة نفسي · Sara Adham</p>
        </td></tr>

        <!-- Hero -->
        <tr><td style="padding:40px 44px 32px;">
          <div style="text-align:center;margin-bottom:28px;">
            <div style="font-size:48px;margin-bottom:12px;">🎓</div>
            <h2 style="color:#1a3d3b;font-family:Georgia,serif;font-size:26px;margin:0 0 8px;">Welcome to the CBT Certification!</h2>
            <p style="color:#b89a4a;font-size:14px;font-weight:bold;letter-spacing:.5px;text-transform:uppercase;margin:0;">برنامج شهادة العلاج السلوكي المعرفي</p>
          </div>

          <p style="color:#444;font-size:15px;line-height:1.8;margin:0 0 20px;">Hi ${firstName},</p>
          <p style="color:#444;font-size:15px;line-height:1.8;margin:0 0 24px;">
            Congratulations — your payment has been received and your place in the <strong>CBT Certification Programme (Levels 1 & 2)</strong> is confirmed. I'm excited to work with you one-on-one through this journey.
          </p>

          <!-- Step 1 -->
          <div style="background:#f0f7f7;border-left:4px solid #2C5F5D;border-radius:0 10px 10px 0;padding:20px 24px;margin-bottom:16px;">
            <p style="color:#2C5F5D;font-weight:bold;font-size:15px;margin:0 0 6px;">Step 1 — Check your inbox</p>
            <p style="color:#555;font-size:14px;line-height:1.7;margin:0;">
              You will receive a second email from Nafsi Clinic with a <strong>"Set Password"</strong> button. Click it to create your password and activate your account. Check your spam folder if you don't see it within a few minutes.
            </p>
          </div>

          <!-- Step 2 -->
          <div style="background:#f0f7f7;border-left:4px solid #2C5F5D;border-radius:0 10px 10px 0;padding:20px 24px;margin-bottom:16px;">
            <p style="color:#2C5F5D;font-weight:bold;font-size:15px;margin:0 0 6px;">Step 2 — Access your programme</p>
            <p style="color:#555;font-size:14px;line-height:1.7;margin:0 0 14px;">
              Once your password is set, click below to go directly to your programme:
            </p>
            <div style="text-align:center;">
              <a href="${COURSE_URL}" style="display:inline-block;background:#1a3d3b;color:#ffffff;text-decoration:none;font-weight:bold;font-size:15px;padding:14px 36px;border-radius:8px;">
                🎓 Go to My Programme
              </a>
            </div>
          </div>

          <!-- Step 3 -->
          <div style="background:#fdf9f0;border-left:4px solid #b89a4a;border-radius:0 10px 10px 0;padding:20px 24px;margin-bottom:28px;">
            <p style="color:#b89a4a;font-weight:bold;font-size:15px;margin:0 0 6px;">Step 3 — I'll be in touch</p>
            <p style="color:#555;font-size:14px;line-height:1.7;margin:0;">
              I will personally reach out within 24 hours to schedule your first session and walk you through the programme structure.
            </p>
          </div>

          <!-- Arabic section -->
          <div style="background:#fdf9f0;border-radius:12px;padding:24px;text-align:right;direction:rtl;margin-bottom:24px;">
            <p style="color:#b89a4a;font-weight:bold;font-size:15px;margin:0 0 12px;">مرحباً ${firstName}،</p>
            <p style="color:#555;font-size:14px;line-height:1.9;margin:0 0 12px;">
              تهانينا! تم تأكيد تسجيلك في <strong>برنامج شهادة العلاج السلوكي المعرفي (المستوى الأول والثاني)</strong>.
            </p>
            <p style="color:#555;font-size:14px;line-height:1.9;margin:0 0 8px;">
              <strong>الخطوة الأولى:</strong> ستصلك رسالة ثانية من عيادة نفسي تحتوي على زر "تعيين كلمة المرور". اضغط عليه لتفعيل حسابك. تحقق من مجلد الرسائل غير المرغوب فيها إذا لم تجدها.
            </p>
            <p style="color:#555;font-size:14px;line-height:1.9;margin:0;">
              <strong>الخطوة الثانية:</strong> بعد تفعيل حسابك، انتقل مباشرة إلى برنامجك عبر الرابط أعلاه.
            </p>
          </div>

          <p style="color:#888;font-size:13px;line-height:1.6;margin:0;">
            Questions? Simply reply to this email.<br>
            Looking forward to working with you — Sara 💚
          </p>
        </td></tr>

        <!-- Footer -->
        <tr><td style="background:#1a3d3b;padding:24px 40px;text-align:center;">
          <p style="color:rgba(255,255,255,0.6);font-size:11px;margin:0;">
            Nafsi Clinic · nafsiclinic.com · Sara Adham CBT Therapist<br>
            You received this because you enrolled in the CBT Certification Programme.
          </p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;

  const res = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: { 'api-key': process.env.BREVO_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sender: { name: 'Sara Adham | Nafsi Clinic', email: 'sara65adham@gmail.com' },
      to: [{ email: toEmail, name: toName || toEmail }],
      subject: '🎓 Your CBT Certification Access | وصولك إلى برنامج شهادة CBT',
      htmlContent: html,
    }),
  });

  if (!res.ok) throw new Error(`Brevo ${res.status}: ${await res.text()}`);
  console.log(`[enrollment] ✓ Welcome email sent to ${toEmail}`);
  return res.json();
}

/* ── Parse booked slot from Stripe client_reference_id ─────────────── */
function parseSlot(refId) {
  if (!refId) return null;
  try {
    // Format: Thursday_17_Apr_2026_at_1400_Bangkok_time  (no colon — Stripe strips colons)
    const decoded = decodeURIComponent(refId).replace(/_/g, ' ');
    const match = decoded.match(/(\w+)\s+(\d+)\s+(\w+)\s+(\d{4})\s+at\s+(\d{2})0{0,2}/);
    if (!match) return null;
    const [, dayName, day, month, year, hour] = match;
    const months = {Jan:0,Feb:1,Mar:2,Apr:3,May:4,Jun:5,Jul:6,Aug:7,Sep:8,Oct:9,Nov:10,Dec:11};
    const mIdx = months[month];
    if (mIdx === undefined) return null;
    // Build Date in Bangkok time (UTC+7)
    const bangkokDate = new Date(Date.UTC(+year, mIdx, +day, +hour - 7, 0, 0));
    return {
      label: `${dayName} ${day} ${month} ${year} at ${hour}:00 (Bangkok time)`,
      labelAr: `${dayName} ${day} ${month} ${year} الساعة ${hour}:00 (توقيت بانكوك)`,
      startUtc: bangkokDate,
      endUtc: new Date(bangkokDate.getTime() + 3600000),
    };
  } catch { return null; }
}

/* ── Generate .ics calendar file ───────────────────────────────────── */
function generateIcs(slot, attendeeEmail, attendeeName) {
  const fmt = d => d.toISOString().replace(/[-:]/g,'').split('.')[0]+'Z';
  const uid = `nafsi-${slot.startUtc.getTime()}@nafsiclinic.com`;
  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Nafsi Clinic//CBT Session//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:REQUEST',
    'BEGIN:VEVENT',
    `UID:${uid}`,
    `DTSTAMP:${fmt(new Date())}`,
    `DTSTART:${fmt(slot.startUtc)}`,
    `DTEND:${fmt(slot.endUtc)}`,
    'SUMMARY:CBT Session with Sara Adham – Nafsi Clinic',
    'DESCRIPTION:Online CBT therapy session via video call.\\nSara will send you the video link before your session.\\n\\nNafsi Clinic | nafsiclinic.com',
    'LOCATION:Online (video call)',
    'ORGANIZER;CN=Sara Adham:mailto:talk-online@nafsiclinic.com',
    `ATTENDEE;CN=${attendeeName || attendeeEmail};RSVP=TRUE:mailto:${attendeeEmail}`,
    'STATUS:CONFIRMED',
    'SEQUENCE:0',
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n');
}

/* ── Send session booking confirmation ──────────────────────────────── */
async function sendSessionEmail(toEmail, toName, pkg, slot) {
  const firstName = (toName || '').split(' ')[0] || 'there';
  const slotHtml = slot
    ? `<div style="background:#f0f7f7;border-radius:10px;padding:20px 24px;margin:20px 0;text-align:center;">
         <p style="font-size:20px;font-weight:700;color:#1a3d3b;margin:0;">${slot.label}</p>
         <p style="color:#7a8a88;font-size:13px;margin:6px 0 0;">60-minute online CBT session</p>
       </div>`
    : '<p style="color:#888;">Your session will be scheduled — Sara will be in touch shortly.</p>';

  const icsContent = slot ? generateIcs(slot, toEmail, toName) : null;
  const icsBase64  = icsContent ? Buffer.from(icsContent).toString('base64') : null;

  const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background:#f5f5f0;font-family:Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f5f5f0;padding:40px 0;">
<tr><td align="center">
<table width="560" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.08);">
  <tr><td style="background:linear-gradient(135deg,#1a3d3b,#2C5F5D);padding:36px 40px;text-align:center;">
    <h1 style="color:#fff;font-family:Georgia,serif;font-size:26px;margin:0;">Nafsi Clinic</h1>
    <p style="color:rgba(255,255,255,0.7);font-size:13px;margin:6px 0 0;">Sara Adham · CBT Therapist</p>
  </td></tr>
  <tr><td style="padding:36px 40px;">
    <h2 style="color:#1a3d3b;font-size:22px;margin:0 0 10px;">Session Confirmed ✓</h2>
    <p style="color:#555;font-size:15px;line-height:1.7;margin:0 0 6px;">Hi ${firstName},</p>
    <p style="color:#555;font-size:15px;line-height:1.7;margin:0 0 16px;">
      Your <strong>${pkg.label}</strong> (${pkg.price}) has been confirmed.
    </p>
    ${slotHtml}
    <p style="color:#555;font-size:14px;line-height:1.7;margin:16px 0;">
      ${slot ? 'A calendar invite is attached — add it to your calendar now.' : ''}
      Sara will send you the video call link before your session.
    </p>
    <div style="background:#fdf9f0;border-radius:10px;padding:20px;text-align:right;direction:rtl;margin-top:20px;">
      <p style="color:#555;font-size:14px;line-height:1.9;margin:0;">
        مرحباً ${firstName}،<br>
        تم تأكيد حجزك لـ <strong>${pkg.label}</strong>. ${slot ? 'دعوة التقويم مرفقة بهذا البريد.' : ''}<br>
        ستتواصل معك سارة قبل الجلسة بلينك الاتصال.
      </p>
    </div>
    <p style="color:#888;font-size:13px;margin:24px 0 0;">
      Questions? Reply to this email or WhatsApp Sara at <a href="https://wa.me/66966673420" style="color:#2C5F5D;">+66 96 667 3420</a>
    </p>
  </td></tr>
  <tr><td style="background:#f9f9f7;padding:20px 40px;text-align:center;border-top:1px solid #eee;">
    <p style="color:#bbb;font-size:11px;margin:0;">Nafsi Clinic · nafsiclinic.com · Sara Adham CBT Therapist</p>
  </td></tr>
</table>
</td></tr>
</table>
</body></html>`;

  const body = {
    sender: { name: 'Sara Adham | Nafsi Clinic', email: 'talk-online@nafsiclinic.com' },
    to: [{ email: toEmail, name: toName || toEmail }],
    subject: `✓ Session Confirmed — ${slot ? slot.label : pkg.label}`,
    htmlContent: html,
  };

  // Always BCC Sara on every session booking
  body.bcc = [{ email: 'sara65adham@gmail.com', name: 'Sara Adham' }];

  if (icsBase64 && slot) {
    body.attachment = [{ content: icsBase64, name: 'nafsi-session.ics', type: 'text/calendar; method=REQUEST' }];
  }

  const res = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: { 'api-key': process.env.BREVO_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Brevo ${res.status}: ${await res.text()}`);
  console.log(`[session] ✓ Confirmation sent to ${toEmail}`);
  return res.json();
}

/* ── Handle CBT Certification purchase ──────────────────────────────── */
async function handleCertification(email, name) {
  const apiKey = process.env.WIX_API;
  if (!apiKey) {
    console.warn('[enrollment] WIX_API not set — skipping Wix member creation');
  } else {
    await createWixMember(email, name);
    await sendWixPasswordEmail(email);
  }
  // Always send our bilingual Brevo welcome email with course access instructions
  await sendCertificationEmail(email, name);
}

/* ── Main handler ────────────────────────────────────────────────────── */
exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  const sigHeader    = event.headers['stripe-signature'];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  if (webhookSecret && (!sigHeader || !verifyStripeSignature(event.body, sigHeader, webhookSecret))) {
    console.error('[book-delivery] Invalid Stripe signature');
    return { statusCode: 400, body: 'Invalid signature' };
  }

  let stripeEvent;
  try {
    stripeEvent = JSON.parse(event.body);
  } catch {
    return { statusCode: 400, body: 'Invalid JSON' };
  }

  if (stripeEvent.type !== 'checkout.session.completed') {
    return { statusCode: 200, body: `Ignored: ${stripeEvent.type}` };
  }

  const session       = stripeEvent.data.object;
  const customerEmail = session.customer_details?.email;
  const customerName  = session.customer_details?.name || '';

  if (!customerEmail) {
    console.warn('[book-delivery] No customer email');
    return { statusCode: 200, body: 'No customer email' };
  }

  // ── Try to extract priceId from client_reference_id first ──
  // Format for sessions: "price_xxx|SlotLabel"
  // Format for books/cert: "price_xxx"
  // Legacy (no priceId embedded): fall back to fetching line items from Stripe
  const rawRef = session.client_reference_id || '';
  let embeddedPriceId = null;
  let embeddedSlotRef = rawRef;

  const SLOT_SEP = '--SLOT--';
  if (rawRef.startsWith('price_')) {
    const sepIdx = rawRef.indexOf(SLOT_SEP);
    if (sepIdx >= 0) {
      embeddedPriceId = rawRef.substring(0, sepIdx);
      embeddedSlotRef = rawRef.substring(sepIdx + SLOT_SEP.length);
    } else {
      embeddedPriceId = rawRef;
      embeddedSlotRef = '';
    }
    console.log(`[book-delivery] priceId="${embeddedPriceId}" slot="${embeddedSlotRef}"`);
  }

  // Build synthetic line items from embedded priceId, or fetch from Stripe
  let lineItems = [];
  if (embeddedPriceId) {
    lineItems = [{ price: { id: embeddedPriceId }, _slotRef: embeddedSlotRef }];
  } else {
    try {
      lineItems = await getLineItems(session.id);
    } catch (err) {
      console.error('[book-delivery] Line item fetch failed:', err);
      return { statusCode: 500, body: 'Line item fetch failed' };
    }
  }

  let sent = 0;
  for (const item of lineItems) {
    const priceId = item.price?.id;
    // Use embedded slot ref if present, otherwise fall back to session.client_reference_id
    const itemSlotRef = item._slotRef !== undefined ? item._slotRef : rawRef;

    // ── Session booking ──
    if (SESSION_PRICES[priceId]) {
      const pkg  = SESSION_PRICES[priceId];
      console.log(`[session] rawRef="${rawRef}" embeddedSlotRef="${embeddedSlotRef}" itemSlotRef="${itemSlotRef}"`);
      const slot = parseSlot(itemSlotRef || session.client_reference_id);
      try {
        await sendSessionEmail(customerEmail, customerName, pkg, slot);
        console.log(`[session] ✓ ${pkg.label} confirmed for ${customerEmail} — slot: ${slot?.label || 'TBD'}`);
        sent++;
      } catch (err) {
        console.error('[session] ✗ Email failed:', err.message);
        return { statusCode: 500, body: `Session email failed: ${err.message}` };
      }

      // Auto-block Google Calendar so the slot disappears from the booking page
      if (slot && process.env.MAKE_CALENDAR_WEBHOOK) {
        try {
          await fetch(process.env.MAKE_CALENDAR_WEBHOOK, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              title:          `CBT Session — ${customerName || customerEmail}`,
              start:          slot.startUtc.toISOString(),
              end:            slot.endUtc.toISOString(),
              description:    `Package: ${pkg.label} (${pkg.price})\nClient: ${customerName} <${customerEmail}>\nBooked via nafsiclinic.com`,
              attendeeEmail:  customerEmail,
            }),
          });
          console.log(`[session] ✓ Calendar blocked: ${slot.label}`);
        } catch (calErr) {
          console.warn('[session] ⚠ Calendar block failed (non-fatal):', calErr.message);
        }
      }
      continue;
    }

    // ── CBT Certification ──
    if (priceId === CERT_PRICE_ID) {
      try {
        await handleCertification(customerEmail, customerName);
        console.log(`[enrollment] ✓ Certification flow complete for ${customerEmail}`);
        sent++;
      } catch (err) {
        console.error('[enrollment] ✗ Certification flow failed:', err.message);
        return { statusCode: 500, body: `Enrollment failed: ${err.message}` };
      }
      continue;
    }

    // ── Digital books ──
    const book = BOOKS[priceId];
    if (!book) {
      console.log(`[book-delivery] No match for priceId: ${priceId}`);
      continue;
    }

    if (book.type === 'audio' && !book.url) {
      console.warn('[book-delivery] AUDIOBOOK_URL not set — skipping');
      continue;
    }

    try {
      await sendBookEmail(customerEmail, customerName, book);
      console.log(`[book-delivery] ✓ Sent "${book.nameEn}" to ${customerEmail}`);
      sent++;
    } catch (err) {
      console.error(`[book-delivery] ✗ Email failed for ${priceId}:`, err.message);
      return { statusCode: 500, body: `Email delivery failed: ${err.message}` };
    }
  }

  return { statusCode: 200, body: `OK — ${sent} action(s) completed` };
};

# دليل التشغيل والتجريب — المتاجر متعددة المستأجرين

## 1) ما الذي أُضيف

**الخادم (Vercel/Turso):**
- `api/_lib/tenant.js` — جدول `bws_tenants` + محلّل المستأجر (دومين خاص / دومين فرعي / `?store=slug`) مع تخزين مؤقت.
- `api/tenant.js` — `GET` عام (للقراءة فقط): يُرجع هوية المتجر من الرابط.
- `api/auth.js` — يأخذ `store_id` من المستأجر (موثوق) بدل إدخال المستخدم، مع إبقاء التوافق القديم (رمز يدوي).
- ⚠️ **لا توجد أي واجهة لإنشاء المتاجر** — الإنشاء يدوي حصريًا منك عبر SQL في Turso (انظر القسم 3). هذا يمنع أي شخص من إنشاء متاجر/مواقع لا متناهية.

**الواجهة:**
- `data.js` — `resolveTenant()` + ترويسة `x-store-slug` + جعل رمز المتجر اختياريًا.
- `main.js` — `ensureTenant()`: متجر معطّل = صفحة "غير متاح"، وتسجيل خروج تلقائي عند اختلاف المتجر.
- `login.html` / `admin-login.html` — يخفيان حقل رمز المتجر عندما يُعرف المتجر من الرابط، ويعرضان اسمه.

## 2) متغيّرات البيئة في Vercel (Settings → Environment Variables)

| المتغيّر | مثال | لماذا |
|---|---|---|
| `TURSO_DATABASE_URL` | (موجود) | قاعدة Turso |
| `TURSO_AUTH_TOKEN` | (موجود) | توكن Turso |
| `BWS_SESSION_SECRET` | (موجود) | توقيع الجلسات |
| `BWS_ROOT_DOMAIN` | `bigsoft.top` | الدومينات الفرعية (`ali.bigsoft.top`). يقبل قائمة مفصولة بفواصل |

> **مستحسن بشدّة** ضبط `BWS_ROOT_DOMAIN`. إن لم يُضبط، يبقى التعرّف على الدومين
> الفرعي يعمل عبر احتياطي عام (أول مقطع من الـ Host إن كان slug مسجَّلاً في
> `bws_tenants`)، لكن ضبطه هو المسار الرسمي: فهو وحده يمنع تجاوز الـ Host
> بـ `?store=` على دومين متجر آخر.
> الزبون لا يحتاج إطلاقًا لكتابة «رمز المتجر» على دومينه الفرعي: الصفحة تستنتج
> المتجر من عنوان الموقع نفسه (بلا نداء شبكة)، والخادم يحسمه من ترويسة Host.
> لم تعد هناك حاجة لأي مفتاح إدارة (تمت إزالة لوحة المنصّة).

## 3) إنشاء متجر لزبون — يدويًا عبر SQL في Turso (حصريًا منك)

الجدول يُنشأ تلقائيًا، لكن يمكنك تشغيل هذا للتأكد:
```sql
CREATE TABLE IF NOT EXISTS bws_tenants (
  store_id      TEXT PRIMARY KEY,
  slug          TEXT UNIQUE NOT NULL,
  custom_domain TEXT,
  domain_status TEXT DEFAULT 'none',
  display_name  TEXT,
  is_active     INTEGER DEFAULT 1,
  plan          TEXT DEFAULT 'basic',
  created_at    TEXT,
  updated_at    TEXT
);
```

**إنشاء/ربط متجر زبون** (Store ID = نفس رمز المتجر في البرنامج/الهاتف):
```sql
INSERT INTO bws_tenants
  (store_id, slug, custom_domain, domain_status, display_name, is_active, plan, created_at, updated_at)
VALUES
  ('AAA', 'boutique-ali', NULL, 'none', 'بوتيك علي', 1, 'basic', datetime('now'), datetime('now'))
ON CONFLICT(store_id) DO UPDATE SET
  slug=excluded.slug, custom_domain=excluded.custom_domain,
  display_name=excluded.display_name, is_active=excluded.is_active,
  updated_at=excluded.updated_at;
```

**ربط دومين خاص بالزبون لاحقًا:**
```sql
UPDATE bws_tenants SET custom_domain='boutique-ali.com', domain_status='active',
       updated_at=datetime('now') WHERE store_id='AAA';
```

**تعطيل متجر (عدم الدفع مثلًا):**
```sql
UPDATE bws_tenants SET is_active=0, updated_at=datetime('now') WHERE store_id='AAA';
```

**حذف رابط متجر:**
```sql
DELETE FROM bws_tenants WHERE store_id='AAA';
```

**عرض كل المتاجر:**
```sql
SELECT store_id, slug, custom_domain, is_active FROM bws_tenants;
```

> ⏱️ ملاحظة: المحلّل يخزّن الخريطة مؤقتًا ~60 ثانية، فقد يستغرق ظهور التعديل حتى دقيقة (أو عند إعادة تشغيل الدالة).
> أين تنفّذ SQL؟ من **Turso Dashboard → قاعدتك → SQL Console**، أو عبر `turso db shell <db-name>` في الطرفية.

## 4) الحالات الثلاث للتجريب

### الحالة A — رابط فوري بلا أي DNS (`?store=`)
```
https://<موقعك-على-vercel>/index.html?store=boutique-ali
```
- يظهر متجر هذا الزبون فقط؛ صفحة الدخول تخفي رمز المتجر.
- مناسبة للتجريب الفوري. (بعد أول دخول، يُحفظ المتجر محليًا فيبقى أثناء التنقّل.)

### الحالة B — دومين فرعي لكل زبون (`ali.bigstore.dz`)
1. في Vercel: Project → **Domains** → أضِف **Wildcard**: `*.bigstore.dz` (و`bigstore.dz`).
2. عند مزوّد دومينك: سجلّ `CNAME *  →  cname.vercel-dns.com` (وحسب تعليمات Vercel للجذر).
3. أضِف `BWS_ROOT_DOMAIN=bigstore.dz` في Vercel.
4. أنشئ المتجر بـ SQL (القسم 3) بـ Slug = `boutique-ali`.
5. افتح: `https://boutique-ali.bigstore.dz` → يظهر متجره مباشرة.

### الحالة C — دومين خاص بالزبون (`www.boutique-ali.com`)
1. بـ SQL (القسم 3): ضع **الدومين الخاص** للمتجر (`UPDATE ... SET custom_domain=...`).
2. في Vercel: Project → **Domains** → أضِف `www.boutique-ali.com` (و/أو الجذر).
3. الزبون عند مزوّد دومينه يضيف:
   - `CNAME www → cname.vercel-dns.com`
   - (للجذر `boutique-ali.com`): سجل `A`/`ALIAS` حسب ما يعرضه Vercel.
4. Vercel يتحقق ويُصدر **SSL تلقائيًا** خلال دقائق.
5. افتح `https://www.boutique-ali.com` → متجره وحده، مربوط بـ Store ID الخاص به.

> عند الكِبَر (مئات الدومينات) ننتقل إلى **Cloudflare for SaaS (Custom Hostnames)** كما في الخطة.

## 5) الأمان والعزل
- على الدومين/الدومين الفرعي يُحدَّد المتجر من **Host** (موثوق) — لا يمكن لزبون انتحال متجر آخر.
- `?store=` يُقبل فقط على دومين المنصّة (للتجريب) لا على دومين متجر حقيقي.
- كل بيانات API مفلترة بـ `store_id` المستخرج من المستأجر/التوكن.
- متجر مُعطّل (`is_active=0`) → صفحة "غير متاح" ويُمنع الدخول.

## 6) النشر
```powershell
cd C:\Users\Haithem\Desktop\DigiSoftApp07\bigwebstore
git add .
git commit -m "feat: multi-tenant storefronts (slug/subdomain/custom-domain), SQL-managed"
git push
```
ثم اضبط `BWS_ROOT_DOMAIN` (عند استعمال الدومينات الفرعية) في Vercel. لا حاجة لأي مفتاح إدارة.

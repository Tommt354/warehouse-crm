# Фінансовий модуль, заход 1 «Гроші» — план реалізації

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Дати власнику журнал витрат зі своїми категоріями, борги постачальникам, автоматичний дохід від забраних посилок і звірку розрахункового залишку на рахунку з фактичним.

**Architecture:** Уся фінансова логіка живе в новому модулі `finance.js` (server.js уже 4000+ рядків, туди більше не доливаємо). Модуль експортує `register(app, deps)` для маршрутів і кілька іменованих хелперів, які server.js викликає у точках, де рухаються гроші. Фронтенд вкладки — окремий `public/finance.js`, підключений в `admin.html`. Джерело правди по касі — таблиця `cash_moves`: кожен рух рахунку є рядком, унікальний індекс не дає записати той самий рух двічі.

**Tech Stack:** Node/Express, better-sqlite3, vanilla JS фронтенд. Тестів у проєкті немає — перевірка кожної задачі йде реальними HTTP-запитами до тестового інстансу на копії бази (див. Global Constraints).

## Global Constraints

- Мова коду й повідомлень користувачу — українська, як у решті проєкту.
- Коментарі пояснюють **чому**, а не що; писати їх українською, як у наявному коді.
- Гроші зберігати як `REAL`, округлювати до копійок при виводі (`Math.round(x*100)/100`).
- Дати зберігати рядком `YYYY-MM-DD` (`date('now','localtime')`), час — `datetime('now','localtime')`.
- Доступ до всіх фінансових маршрутів — тільки `requireRole("admin")`.
- Живу базу не чіпати. Тестовий інстанс піднімати так:

```bash
cd /Users/artemkravcov/Desktop/projeckt/warehouse-crm && node -e "const db=require('better-sqlite3')('crm.db',{readonly:true});db.backup('/tmp/fin-test.db').then(()=>console.log('ok'))"
```

```bash
cd /Users/artemkravcov/Desktop/projeckt/warehouse-crm && DB_PATH=/tmp/fin-test.db PORT=3100 DEV_QUICK_LOGIN=1 node server.js
```

- Тест-скрипти складати в `tests/finance/`, запускати `node tests/finance/<файл>.js`. Кожен скрипт сам логіниться через `/api/auth/dev-login/admin`, сам чистить за собою створені рядки.
- Коміт після кожної задачі. Повідомлення українською, з рядком `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`.
- Деплой (`git push origin main && fly deploy`) — тільки після Задачі 8, коли вкладка працює цілком.

## Файлова структура

| Файл | Відповідальність |
|---|---|
| `db.js` (зміни) | нові таблиці, міграції наявних, сідинг категорій |
| `finance.js` (новий) | маршрути `/api/finance/*`, хелпери руху грошей, звіт і звірка |
| `server.js` (зміни) | реєстрація модуля, виклик хелперів у точках, де рухаються гроші |
| `public/finance.js` (новий) | логіка вкладки «Бухгалтерія» |
| `public/admin.html` (зміни) | розмітка вкладки, підключення скрипта |
| `tests/finance/*.js` (нові) | перевірки задач |

---

### Task 1: Схема бази й категорії за замовчуванням

**Files:**
- Modify: `db.js` (додати в кінець блоку `db.exec` зі схемою та в блок міграцій)
- Test: `tests/finance/01-schema.js`

**Interfaces:**
- Consumes: нічого
- Produces: таблиці `fin_categories(id,name,is_goods,sort_order,active)`, `suppliers(id,name,note,active)`, `expenses(id,date,amount,category_id,supplier_id,note,created_by,created_at)`, `expense_payments(id,expense_id,date,amount,created_at)`, `cash_moves(id,date,amount,kind,ref_type,ref_id,note,created_at)`, `cash_checks(id,date,actual_balance,calc_balance,diff,note,created_at)`; колонки `orders.delivered_at`, `orders.refunded_amount`, `orders.refunded_at`

- [ ] **Step 1: Написати перевірку**

Створити `tests/finance/01-schema.js`:

```js
const db = require("../../node_modules/better-sqlite3")(process.env.DB_PATH || "/tmp/fin-test.db");
const need = {
  fin_categories: ["id","name","kind","is_goods","sort_order","active"],
  suppliers: ["id","name","note","active"],
  expenses: ["id","date","amount","category_id","supplier_id","workshop_id","note","created_by","created_at"],
  expense_payments: ["id","expense_id","date","amount","created_at"],
  cash_moves: ["id","date","amount","kind","ref_type","ref_id","wholesale_id","note","created_at"],
  cash_checks: ["id","date","actual_balance","calc_balance","diff","note","created_at"]
};
let bad = 0;
for (const [t, cols] of Object.entries(need)) {
  const have = db.prepare(`PRAGMA table_info(${t})`).all().map(r => r.name);
  const miss = cols.filter(c => !have.includes(c));
  console.log((miss.length ? "❌" : "✅") + " " + t + (miss.length ? " немає: " + miss.join(",") : ""));
  if (miss.length) bad++;
}
const ord = db.prepare("PRAGMA table_info(orders)").all().map(r => r.name);
["delivered_at","refunded_amount","refunded_at"].forEach(c => {
  const ok = ord.includes(c); console.log((ok ? "✅" : "❌") + " orders." + c); if (!ok) bad++;
});
const mgr = db.prepare("PRAGMA table_info(manager_rates)").all().map(r => r.name);
["id","name","percent","from_date"].forEach(c => {
  const okc = mgr.includes(c); console.log((okc ? "✅" : "❌") + " manager_rates." + c); if (!okc) bad++;
});
const cats = db.prepare("SELECT COUNT(*) c FROM fin_categories").get().c;
const goods = db.prepare("SELECT COUNT(*) c FROM fin_categories WHERE is_goods=1").get().c;
const kinds = db.prepare("SELECT COUNT(DISTINCT kind) c FROM fin_categories").get().c;
console.log((cats >= 12 && goods >= 4 && kinds === 4 ? "✅" : "❌") + " категорії засіяні: " + cats + " всього, " + goods + " товарних, " + kinds + " типів логіки");
if (cats < 12 || goods < 4 || kinds !== 4) bad++;
const mismatch = db.prepare("SELECT COUNT(*) c FROM fin_categories WHERE is_goods <> (kind <> 'expense')").get().c;
console.log((mismatch === 0 ? "✅" : "❌") + " is_goods узгоджений з kind (розбіжностей: " + mismatch + ")");
if (mismatch) bad++;
const wsOwn = db.prepare("PRAGMA table_info(workshops)").all().some(r => r.name === "is_own");
console.log((wsOwn ? "✅" : "❌") + " workshops.is_own");
if (!wsOwn) bad++;
const bf = db.prepare("SELECT COUNT(*) c FROM orders WHERE status='delivered' AND COALESCE(delivered_at,'')=''").get().c;
console.log((bf === 0 ? "✅" : "❌") + " delivered_at заповнено для наявних отриманих: лишилось " + bf);
if (bf) bad++;
process.exit(bad ? 1 : 0);
```

- [ ] **Step 2: Запустити, переконатись що падає**

```bash
cd /Users/artemkravcov/Desktop/projeckt/warehouse-crm && node tests/finance/01-schema.js
```

Очікувано: рядки з ❌ і код виходу 1 (таблиць немає).

- [ ] **Step 3: Додати таблиці в `db.js`**

У великий `db.exec(\`...\`)` зі схемою, перед `CREATE TABLE IF NOT EXISTS tasks`, додати:

```sql
  -- Фінансовий модуль. Категорії заводить власник сам, і логіка живе саме в
  -- категорії — обравши її, він більше нічого не вказує. kind:
  --   expense  — гроші згоріли (бензин, оренда, реклама)
  --   material — пішли в матеріали (тканина, фурнітура)
  --   sewing   — оплата роботи цеху
  --   purchase — закупка готового товару
  -- is_goods — похідний прапорець (kind != 'expense') для звітів, пишеться
  -- автоматично: у звітах потрібен саме поділ «згоріло / лежить у товарі».
  CREATE TABLE IF NOT EXISTS fin_categories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    kind TEXT DEFAULT 'expense',
    is_goods INTEGER DEFAULT 0,
    sort_order INTEGER DEFAULT 0,
    active INTEGER DEFAULT 1
  );

  CREATE TABLE IF NOT EXISTS suppliers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    note TEXT DEFAULT '',
    active INTEGER DEFAULT 1
  );

  -- Витрата — це факт «ми винні або заплатили». Скільки з неї реально пішло
  -- з рахунку, живе в expense_payments: постачальники дають у борг, і
  -- неоплачений залишок — це і є борг.
  CREATE TABLE IF NOT EXISTS expenses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT NOT NULL,
    amount REAL NOT NULL,
    category_id INTEGER,
    supplier_id INTEGER,
    workshop_id INTEGER,
    wholesale_id INTEGER,
    note TEXT DEFAULT '',
    created_by INTEGER,
    created_at TEXT DEFAULT (datetime('now','localtime')),
    FOREIGN KEY (category_id) REFERENCES fin_categories(id),
    FOREIGN KEY (supplier_id) REFERENCES suppliers(id),
    FOREIGN KEY (workshop_id) REFERENCES workshops(id)
  );

  CREATE TABLE IF NOT EXISTS expense_payments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    expense_id INTEGER NOT NULL,
    date TEXT NOT NULL,
    amount REAL NOT NULL,
    created_at TEXT DEFAULT (datetime('now','localtime')),
    FOREIGN KEY (expense_id) REFERENCES expenses(id) ON DELETE CASCADE
  );

  -- Єдине джерело правди по рахунку: кожен рух грошей — рядок. ref_type/ref_id
  -- вказують на подію-джерело, а унікальний індекс не дає записати той самий
  -- рух двічі (трекінг НП ходить кожні 15 хв і бачить те саме замовлення).
  CREATE TABLE IF NOT EXISTS cash_moves (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT NOT NULL,
    amount REAL NOT NULL,
    kind TEXT NOT NULL,
    ref_type TEXT DEFAULT '',
    ref_id INTEGER,
    wholesale_id INTEGER,
    note TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now','localtime'))
  );
  CREATE UNIQUE INDEX IF NOT EXISTS cash_moves_ref_uniq
    ON cash_moves(kind, ref_type, ref_id) WHERE ref_id IS NOT NULL;

  -- Менеджер отримує відсоток від прибутку. Ставку зберігаємо історією, а не
  -- одним числом у налаштуваннях: змінивши відсоток, не можна перерахувати
  -- заднім числом уже закриті місяці — людині вже заплачено за домовленістю,
  -- яка діяла тоді.
  CREATE TABLE IF NOT EXISTS manager_rates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    percent REAL NOT NULL DEFAULT 0,
    from_date TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now','localtime'))
  );

  CREATE TABLE IF NOT EXISTS cash_checks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT NOT NULL,
    actual_balance REAL NOT NULL,
    calc_balance REAL NOT NULL,
    diff REAL NOT NULL,
    note TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now','localtime'))
  );
```

- [ ] **Step 4: Додати міграції й сідинг у `db.js`**

Після наявних `addCol("orders",...)` додати:

```js
// День, коли клієнт забрав посилку. Досі його брали з updated_at, який
// змінюється від будь-якої дії із замовленням, через що виручка повзла
// заднім числом. Ставиться один раз і більше не рухається.
if (addCol("orders","delivered_at","TEXT DEFAULT ''")) {
  db.exec("UPDATE orders SET delivered_at=updated_at WHERE status='delivered' AND COALESCE(delivered_at,'')=''");
}
addCol("orders","refunded_amount","REAL DEFAULT 0");
addCol("orders","refunded_at","TEXT DEFAULT ''");

// Стартовий набір категорій, щоб було з чого почати. Далі власник додає й
// перейменовує свої; сідимо лише на порожній таблиці, щоб не воскрешати
// видалене.
if (!db.prepare("SELECT COUNT(*) c FROM fin_categories").get().c) {
  const insCat = db.prepare("INSERT INTO fin_categories(name,kind,is_goods,sort_order)VALUES(?,?,?,?)");
  // Назви взяті з таблиці, яку власник веде зараз, щоб він відкрив вкладку і
  // побачив звичні колонки, а не порожній список.
  [["Оренда","expense"],["Комуналка","expense"],["Реклама","expense"],["Повернення НП","expense"],
   ["Форс-мажор","expense"],["PK-CRM","expense"],["Бензин","expense"],["Браки","expense"],["Інше","expense"],
   ["Тканина","material"],["Фурнітура","material"],["Матеріали","material"],
   ["Пошив у цеху","sewing"],["Принт","sewing"],
   ["Базар","purchase"]]
    .forEach((r,i) => insCat.run(r[0], r[1], r[1] === "expense" ? 0 : 1, i));
}

// Свій цех платить швачкам зарплатою, чужий — платежем за рахунком. Ставка за
// пошив одиниці однакова в обох випадках і вводиться в крої; is_own лише
// каже системі, звідки вийдуть гроші.
addCol("workshops","is_own","INTEGER DEFAULT 1");
```

- [ ] **Step 5: Перезібрати тестову базу й запустити перевірку**

```bash
cd /Users/artemkravcov/Desktop/projeckt/warehouse-crm && rm -f /tmp/fin-test.db* && node -e "const db=require('better-sqlite3')('crm.db',{readonly:true});db.backup('/tmp/fin-test.db').then(()=>console.log('ok'))" && DB_PATH=/tmp/fin-test.db node -e "require('./db')" && node tests/finance/01-schema.js
```

Очікувано: усі рядки ✅, код виходу 0.

- [ ] **Step 6: Коміт**

```bash
git add db.js tests/finance/01-schema.js && git commit -m "Фінмодуль: схема бази, категорії за замовчуванням, delivered_at

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: Модуль `finance.js` і категорії

**Files:**
- Create: `finance.js`
- Modify: `server.js` (реєстрація модуля перед `app.listen`)
- Test: `tests/finance/02-categories.js`

**Interfaces:**
- Consumes: таблицю `fin_categories` із Задачі 1
- Produces: `module.exports = { register(app, { authMiddleware, requireRole }) }`; маршрути `GET /api/finance/categories`, `POST /api/finance/categories` `{name,is_goods}`, `PUT /api/finance/categories/:id` `{name,is_goods,active}`, `DELETE /api/finance/categories/:id`

- [ ] **Step 1: Написати перевірку**

Створити `tests/finance/02-categories.js`:

```js
const B = "http://localhost:3100";
let cookie = "";
async function api(u, o = {}) {
  const r = await fetch(B + u, { ...o, headers: { "Content-Type": "application/json", cookie, ...(o.headers || {}) } });
  const sc = r.headers.getSetCookie ? r.headers.getSetCookie() : [];
  if (sc.length) cookie = sc.map(s => s.split(";")[0]).join("; ");
  let b = null; try { b = await r.json() } catch (e) {}
  return { s: r.status, b };
}
const ok = (c, m) => { console.log((c ? "✅" : "❌ FAIL") + " " + m); if (!c) process.exitCode = 1; };

(async () => {
  await api("/api/auth/dev-login/admin", { method: "POST" });
  let r = await api("/api/finance/categories");
  ok(r.s === 200 && r.b.categories.length >= 10, "список категорій: " + (r.b.categories || []).length);

  r = await api("/api/finance/categories", { method: "POST", body: JSON.stringify({ name: "__TestКат", kind: "material" }) });
  ok(r.s === 200 && r.b.id, "категорія створена");
  const id = r.b.id;
  let found = (await api("/api/finance/categories")).b.categories.find(c => c.id === id);
  ok(found && found.kind === "material" && found.is_goods === 1, "material дав is_goods=1 автоматично");

  r = await api("/api/finance/categories/" + id, { method: "PUT", body: JSON.stringify({ name: "__TestКат2", kind: "expense", active: 1 }) });
  ok(r.s === 200, "категорія перейменована");
  found = (await api("/api/finance/categories")).b.categories.find(c => c.id === id);
  ok(found && found.name === "__TestКат2" && found.kind === "expense" && found.is_goods === 0, "зміни збереглись, is_goods перерахувався");

  r = await api("/api/finance/categories", { method: "POST", body: JSON.stringify({ name: "", kind: "expense" }) });
  ok(r.s === 400, "порожня назва не приймається");

  r = await api("/api/finance/categories", { method: "POST", body: JSON.stringify({ name: "__TestКат3", kind: "вигаданий" }) });
  ok(r.s === 400, "невідомий тип логіки не приймається");

  r = await api("/api/finance/categories/" + id, { method: "DELETE" });
  ok(r.s === 200, "категорія видалена");
  r = await api("/api/finance/categories");
  ok(!r.b.categories.some(c => c.id === id), "її більше немає у списку");

  const drop = { s: 0 };
  cookie = "";
  await api("/api/auth/dev-login/packer", { method: "POST" });
  r = await api("/api/finance/categories");
  ok(r.s === 403, "не-адміну закрито (" + r.s + ")");
})();
```

- [ ] **Step 2: Запустити, переконатись що падає**

Підняти тестовий сервер (команда з Global Constraints), потім:

```bash
cd /Users/artemkravcov/Desktop/projeckt/warehouse-crm && node tests/finance/02-categories.js
```

Очікувано: ❌ на всіх рядках (маршрутів немає, 404).

- [ ] **Step 3: Створити `finance.js`**

```js
const db = require("./db");

// Фінансовий модуль тримаємо окремо від server.js: там уже 4000+ рядків, і
// дописувати туди ще один домен означало б робити файл нечитабельним.
function register(app, { authMiddleware, requireRole }) {
  const adminOnly = [authMiddleware, requireRole("admin")];

  // Логіка витрати задається один раз — типом категорії. Власник при вводі
  // витрати обирає лише категорію, більше нічого пам'ятати не треба.
  const CATEGORY_KINDS = ["expense", "material", "sewing", "purchase"];

  app.get("/api/finance/categories", ...adminOnly, (req, res) => {
    res.json({ categories: db.prepare("SELECT * FROM fin_categories WHERE active=1 ORDER BY is_goods, sort_order, name").all(), kinds: CATEGORY_KINDS });
  });

  app.post("/api/finance/categories", ...adminOnly, (req, res) => {
    const name = (req.body.name || "").trim();
    if (!name) return res.status(400).json({ error: "Вкажіть назву категорії" });
    const kind = req.body.kind || "expense";
    if (!CATEGORY_KINDS.includes(kind)) return res.status(400).json({ error: "Невідомий тип категорії" });
    const sort = db.prepare("SELECT COALESCE(MAX(sort_order),0)+1 s FROM fin_categories").get().s;
    const r = db.prepare("INSERT INTO fin_categories(name,kind,is_goods,sort_order)VALUES(?,?,?,?)")
      .run(name, kind, kind === "expense" ? 0 : 1, sort);
    res.json({ ok: true, id: r.lastInsertRowid });
  });

  app.put("/api/finance/categories/:id", ...adminOnly, (req, res) => {
    const name = (req.body.name || "").trim();
    if (!name) return res.status(400).json({ error: "Вкажіть назву категорії" });
    const kind = req.body.kind || "expense";
    if (!CATEGORY_KINDS.includes(kind)) return res.status(400).json({ error: "Невідомий тип категорії" });
    db.prepare("UPDATE fin_categories SET name=?,kind=?,is_goods=?,active=? WHERE id=?")
      .run(name, kind, kind === "expense" ? 0 : 1, req.body.active === 0 ? 0 : 1, req.params.id);
    res.json({ ok: true });
  });

  // Категорію, на якій уже висять витрати, не видаляємо фізично, а ховаємо:
  // інакше історія витрат втратила б назву категорії.
  app.delete("/api/finance/categories/:id", ...adminOnly, (req, res) => {
    const used = db.prepare("SELECT COUNT(*) c FROM expenses WHERE category_id=?").get(req.params.id).c;
    if (used) db.prepare("UPDATE fin_categories SET active=0 WHERE id=?").run(req.params.id);
    else db.prepare("DELETE FROM fin_categories WHERE id=?").run(req.params.id);
    res.json({ ok: true, hidden: !!used });
  });
}

module.exports = { register };
```

- [ ] **Step 4: Підключити в `server.js`**

Перед рядком `app.listen(PORT, ...)` додати:

```js
require("./finance").register(app, { authMiddleware, requireRole });
```

- [ ] **Step 5: Перезапустити сервер і запустити перевірку**

```bash
cd /Users/artemkravcov/Desktop/projeckt/warehouse-crm && node tests/finance/02-categories.js
```

Очікувано: усі ✅.

- [ ] **Step 6: Коміт**

```bash
git add finance.js server.js tests/finance/02-categories.js && git commit -m "Фінмодуль: свої категорії витрат

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3: Постачальники

**Files:**
- Modify: `finance.js`
- Test: `tests/finance/03-suppliers.js`

**Interfaces:**
- Consumes: `register()` з Задачі 2
- Produces: `GET /api/finance/suppliers`, `POST /api/finance/suppliers` `{name,note}`, `PUT /api/finance/suppliers/:id` `{name,note,active}`

- [ ] **Step 1: Написати перевірку**

Створити `tests/finance/03-suppliers.js` (хелпер `api`/`ok` скопіювати з `02-categories.js` — файли самостійні, спільної бібліотеки навмисно не заводимо):

```js
const B = "http://localhost:3100";
let cookie = "";
async function api(u, o = {}) {
  const r = await fetch(B + u, { ...o, headers: { "Content-Type": "application/json", cookie, ...(o.headers || {}) } });
  const sc = r.headers.getSetCookie ? r.headers.getSetCookie() : [];
  if (sc.length) cookie = sc.map(s => s.split(";")[0]).join("; ");
  let b = null; try { b = await r.json() } catch (e) {}
  return { s: r.status, b };
}
const ok = (c, m) => { console.log((c ? "✅" : "❌ FAIL") + " " + m); if (!c) process.exitCode = 1; };

(async () => {
  await api("/api/auth/dev-login/admin", { method: "POST" });
  let r = await api("/api/finance/suppliers", { method: "POST", body: JSON.stringify({ name: "__TestПостач", note: "тканина" }) });
  ok(r.s === 200 && r.b.id, "постачальник створений");
  const id = r.b.id;
  r = await api("/api/finance/suppliers");
  const f = r.b.suppliers.find(s => s.id === id);
  ok(f && f.name === "__TestПостач" && f.debt === 0, "у списку, борг нульовий");
  r = await api("/api/finance/suppliers", { method: "POST", body: JSON.stringify({ name: "" }) });
  ok(r.s === 400, "порожня назва не приймається");
  r = await api("/api/finance/suppliers/" + id, { method: "PUT", body: JSON.stringify({ name: "__TestПостач2", note: "", active: 0 }) });
  ok(r.s === 200, "оновлено");
  r = await api("/api/finance/suppliers");
  ok(!r.b.suppliers.some(s => s.id === id), "прихований більше не показується");
  require("../../node_modules/better-sqlite3")(process.env.DB_PATH || "/tmp/fin-test.db")
    .prepare("DELETE FROM suppliers WHERE id=?").run(id);
})();
```

- [ ] **Step 2: Запустити, переконатись що падає**

```bash
cd /Users/artemkravcov/Desktop/projeckt/warehouse-crm && node tests/finance/03-suppliers.js
```

Очікувано: ❌ (404 на маршрутах).

- [ ] **Step 3: Додати маршрути в `finance.js`**

Всередині `register()`, після категорій:

```js
  // Борг по постачальнику = скільки йому нарахували мінус скільки заплатили.
  // Рахуємо на льоту, а не окремою колонкою: колонка розійшлася б із фактами
  // при першій же правці витрати.
  const SUPPLIER_DEBT_SQL = `COALESCE((SELECT SUM(e.amount) FROM expenses e WHERE e.supplier_id=s.id),0)
    - COALESCE((SELECT SUM(p.amount) FROM expense_payments p JOIN expenses e2 ON p.expense_id=e2.id WHERE e2.supplier_id=s.id),0)`;

  app.get("/api/finance/suppliers", ...adminOnly, (req, res) => {
    res.json({ suppliers: db.prepare(`SELECT s.*, ROUND(${SUPPLIER_DEBT_SQL},2) as debt
      FROM suppliers s WHERE s.active=1 ORDER BY s.name`).all() });
  });

  app.post("/api/finance/suppliers", ...adminOnly, (req, res) => {
    const name = (req.body.name || "").trim();
    if (!name) return res.status(400).json({ error: "Вкажіть назву постачальника" });
    const r = db.prepare("INSERT INTO suppliers(name,note)VALUES(?,?)").run(name, req.body.note || "");
    res.json({ ok: true, id: r.lastInsertRowid });
  });

  app.put("/api/finance/suppliers/:id", ...adminOnly, (req, res) => {
    const name = (req.body.name || "").trim();
    if (!name) return res.status(400).json({ error: "Вкажіть назву постачальника" });
    db.prepare("UPDATE suppliers SET name=?,note=?,active=? WHERE id=?")
      .run(name, req.body.note || "", req.body.active === 0 ? 0 : 1, req.params.id);
    res.json({ ok: true });
  });
```

- [ ] **Step 4: Перезапустити сервер і запустити перевірку**

```bash
cd /Users/artemkravcov/Desktop/projeckt/warehouse-crm && node tests/finance/03-suppliers.js
```

Очікувано: усі ✅.

- [ ] **Step 5: Коміт**

```bash
git add finance.js tests/finance/03-suppliers.js && git commit -m "Фінмодуль: постачальники з сальдо боргу

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 4: Витрати, оплати й борг

**Files:**
- Modify: `finance.js`
- Test: `tests/finance/04-expenses.js`

**Interfaces:**
- Consumes: категорії й постачальників із Задач 2–3
- Produces: `addCashMove({date,amount,kind,ref_type,ref_id,note})` (внутрішній хелпер модуля, ідемпотентний по `ref`); маршрути `GET /api/finance/expenses?from&to`, `POST /api/finance/expenses` `{date,amount,category_id,supplier_id,note,paid}`, `PUT /api/finance/expenses/:id`, `DELETE /api/finance/expenses/:id`, `POST /api/finance/expenses/:id/pay` `{amount,date}`

- [ ] **Step 1: Написати перевірку**

Створити `tests/finance/04-expenses.js`:

```js
const B = "http://localhost:3100";
const sqlite = require("../../node_modules/better-sqlite3");
const db = sqlite(process.env.DB_PATH || "/tmp/fin-test.db");
let cookie = "";
async function api(u, o = {}) {
  const r = await fetch(B + u, { ...o, headers: { "Content-Type": "application/json", cookie, ...(o.headers || {}) } });
  const sc = r.headers.getSetCookie ? r.headers.getSetCookie() : [];
  if (sc.length) cookie = sc.map(s => s.split(";")[0]).join("; ");
  let b = null; try { b = await r.json() } catch (e) {}
  return { s: r.status, b };
}
const ok = (c, m) => { console.log((c ? "✅" : "❌ FAIL") + " " + m); if (!c) process.exitCode = 1; };
const today = new Date().toISOString().slice(0, 10);

(async () => {
  await api("/api/auth/dev-login/admin", { method: "POST" });
  const cats = (await api("/api/finance/categories")).b.categories;
  const opex = cats.find(c => !c.is_goods).id;
  const goods = cats.find(c => c.is_goods).id;
  const sup = (await api("/api/finance/suppliers", { method: "POST", body: JSON.stringify({ name: "__TestS4" }) })).b.id;

  // оплачена одразу
  let r = await api("/api/finance/expenses", { method: "POST", body: JSON.stringify({ date: today, amount: 1000, category_id: opex, note: "__T4 оренда", paid: 1 }) });
  ok(r.s === 200 && r.b.id, "витрата створена");
  const e1 = r.b.id;
  let cash = db.prepare("SELECT amount FROM cash_moves WHERE ref_type='expense' AND ref_id=?").get(e1);
  ok(cash && cash.amount === -1000, "оплачена витрата дала рух каси −1000 (" + (cash && cash.amount) + ")");

  // у борг
  r = await api("/api/finance/expenses", { method: "POST", body: JSON.stringify({ date: today, amount: 12000, category_id: goods, supplier_id: sup, note: "__T4 тканина", paid: 0 }) });
  const e2 = r.b.id;
  cash = db.prepare("SELECT COUNT(*) c FROM cash_moves WHERE ref_type='expense' AND ref_id=?").get(e2).c;
  ok(cash === 0, "витрата в борг каси не чіпає");
  let sups = (await api("/api/finance/suppliers")).b.suppliers.find(s => s.id === sup);
  ok(sups.debt === 12000, "борг постачальника 12000 (" + sups.debt + ")");

  // часткова оплата
  r = await api("/api/finance/expenses/" + e2 + "/pay", { method: "POST", body: JSON.stringify({ amount: 5000, date: today }) });
  ok(r.s === 200, "часткова оплата пройшла");
  sups = (await api("/api/finance/suppliers")).b.suppliers.find(s => s.id === sup);
  ok(sups.debt === 7000, "борг став 7000 (" + sups.debt + ")");

  // переплатити не можна
  r = await api("/api/finance/expenses/" + e2 + "/pay", { method: "POST", body: JSON.stringify({ amount: 999999, date: today }) });
  ok(r.s === 400, "оплата більша за борг відхилена");

  // список із залишком
  r = await api("/api/finance/expenses?from=" + today + "&to=" + today);
  const row = r.b.expenses.find(x => x.id === e2);
  ok(row && row.paid_amount === 5000 && row.debt === 7000, "у списку видно оплачено й залишок");
  ok(row.is_goods === 1, "видно, що це вкладення в товар");

  // видалення прибирає і рух каси
  r = await api("/api/finance/expenses/" + e1, { method: "DELETE" });
  ok(r.s === 200 && db.prepare("SELECT COUNT(*) c FROM cash_moves WHERE ref_type='expense' AND ref_id=?").get(e1).c === 0, "видалення прибрало рух каси");

  db.prepare("DELETE FROM expense_payments WHERE expense_id=?").run(e2);
  db.prepare("DELETE FROM expenses WHERE id IN (?,?)").run(e1, e2);
  db.prepare("DELETE FROM cash_moves WHERE note LIKE '__T4%'").run();
  db.prepare("DELETE FROM suppliers WHERE id=?").run(sup);
})();
```

- [ ] **Step 2: Запустити, переконатись що падає**

```bash
cd /Users/artemkravcov/Desktop/projeckt/warehouse-crm && node tests/finance/04-expenses.js
```

Очікувано: ❌ (маршрутів немає).

- [ ] **Step 3: Додати хелпер і маршрути в `finance.js`**

Перед `function register`:

```js
function round2(v) { return Math.round((v || 0) * 100) / 100; }

// Ідемпотентний запис руху грошей: подія може прийти повторно (трекінг НП,
// повторне натискання кнопки), а рахунок від цього рухатись двічі не має.
function addCashMove({ date, amount, kind, ref_type, ref_id, note }) {
  if (ref_id) {
    const exists = db.prepare("SELECT id FROM cash_moves WHERE kind=? AND ref_type=? AND ref_id=?").get(kind, ref_type || "", ref_id);
    if (exists) return exists.id;
  }
  return db.prepare("INSERT INTO cash_moves(date,amount,kind,ref_type,ref_id,note)VALUES(?,?,?,?,?,?)")
    .run(date, round2(amount), kind, ref_type || "", ref_id || null, note || "").lastInsertRowid;
}
```

Усередині `register()`:

```js
  const EXPENSE_ROWS = `SELECT e.*, c.name as category_name, c.is_goods, c.kind as category_kind, s.name as supplier_name,
      (SELECT w.name FROM workshops w WHERE w.id=e.workshop_id) as workshop_name,
      ROUND(COALESCE((SELECT SUM(p.amount) FROM expense_payments p WHERE p.expense_id=e.id),0),2) as paid_amount,
      ROUND(e.amount - COALESCE((SELECT SUM(p.amount) FROM expense_payments p WHERE p.expense_id=e.id),0),2) as debt
    FROM expenses e LEFT JOIN fin_categories c ON e.category_id=c.id LEFT JOIN suppliers s ON e.supplier_id=s.id`;

  app.get("/api/finance/expenses", ...adminOnly, (req, res) => {
    const from = req.query.from || db.prepare("SELECT date('now','localtime','-30 days') d").get().d;
    const to = req.query.to || db.prepare("SELECT date('now','localtime') d").get().d;
    res.json({ expenses: db.prepare(EXPENSE_ROWS + " WHERE e.date BETWEEN ? AND ? ORDER BY e.date DESC, e.id DESC").all(from, to), from, to });
  });

  app.post("/api/finance/expenses", ...adminOnly, (req, res) => {
    const amount = parseFloat(req.body.amount);
    if (!amount || amount <= 0) return res.status(400).json({ error: "Вкажіть суму" });
    if (!req.body.category_id) return res.status(400).json({ error: "Оберіть категорію" });
    // Оплата пошиву без вказаного цеху зробила б неможливою звірку «скільки
    // заплачено цеху проти скільки роботи від нього прийнято».
    const cat = db.prepare("SELECT kind FROM fin_categories WHERE id=?").get(req.body.category_id);
    if (cat && cat.kind === "sewing" && !req.body.workshop_id) return res.status(400).json({ error: "Оберіть цех" });
    const date = req.body.date || db.prepare("SELECT date('now','localtime') d").get().d;
    let id;
    db.transaction(() => {
      id = db.prepare("INSERT INTO expenses(date,amount,category_id,supplier_id,workshop_id,note,created_by)VALUES(?,?,?,?,?,?,?)")
        .run(date, round2(amount), req.body.category_id, req.body.supplier_id || null, req.body.workshop_id || null, req.body.note || "", req.user.id).lastInsertRowid;
      // paid=1 — гроші пішли одразу; paid=0 — це борг постачальнику, каса не рухається.
      if (req.body.paid) {
        db.prepare("INSERT INTO expense_payments(expense_id,date,amount)VALUES(?,?,?)").run(id, date, round2(amount));
        addCashMove({ date, amount: -amount, kind: "expense", ref_type: "expense", ref_id: id, note: req.body.note || "" });
      }
    })();
    res.json({ ok: true, id });
  });

  app.put("/api/finance/expenses/:id", ...adminOnly, (req, res) => {
    const amount = parseFloat(req.body.amount);
    if (!amount || amount <= 0) return res.status(400).json({ error: "Вкажіть суму" });
    const paid = db.prepare("SELECT COALESCE(SUM(amount),0) s FROM expense_payments WHERE expense_id=?").get(req.params.id).s;
    if (round2(amount) < round2(paid)) return res.status(400).json({ error: "Сума менша за вже оплачену (" + paid + "₴)" });
    db.prepare("UPDATE expenses SET date=?,amount=?,category_id=?,supplier_id=?,note=? WHERE id=?")
      .run(req.body.date, round2(amount), req.body.category_id, req.body.supplier_id || null, req.body.note || "", req.params.id);
    res.json({ ok: true });
  });

  app.delete("/api/finance/expenses/:id", ...adminOnly, (req, res) => {
    db.transaction(() => {
      db.prepare("DELETE FROM cash_moves WHERE ref_type='expense' AND ref_id=?").run(req.params.id);
      db.prepare("DELETE FROM cash_moves WHERE ref_type='expense_payment' AND ref_id IN (SELECT id FROM expense_payments WHERE expense_id=?)").run(req.params.id);
      db.prepare("DELETE FROM expense_payments WHERE expense_id=?").run(req.params.id);
      db.prepare("DELETE FROM expenses WHERE id=?").run(req.params.id);
    })();
    res.json({ ok: true });
  });

  app.post("/api/finance/expenses/:id/pay", ...adminOnly, (req, res) => {
    const e = db.prepare("SELECT * FROM expenses WHERE id=?").get(req.params.id);
    if (!e) return res.status(404).json({ error: "Витрату не знайдено" });
    const amount = parseFloat(req.body.amount);
    if (!amount || amount <= 0) return res.status(400).json({ error: "Вкажіть суму" });
    const paid = db.prepare("SELECT COALESCE(SUM(amount),0) s FROM expense_payments WHERE expense_id=?").get(e.id).s;
    if (round2(paid + amount) > round2(e.amount)) return res.status(400).json({ error: "Більше, ніж залишок боргу (" + round2(e.amount - paid) + "₴)" });
    const date = req.body.date || db.prepare("SELECT date('now','localtime') d").get().d;
    db.transaction(() => {
      const pid = db.prepare("INSERT INTO expense_payments(expense_id,date,amount)VALUES(?,?,?)").run(e.id, date, round2(amount)).lastInsertRowid;
      addCashMove({ date, amount: -amount, kind: "expense", ref_type: "expense_payment", ref_id: pid, note: "Оплата боргу" });
    })();
    res.json({ ok: true });
  });
```

- [ ] **Step 4: Перезапустити сервер і запустити перевірку**

```bash
cd /Users/artemkravcov/Desktop/projeckt/warehouse-crm && node tests/finance/04-expenses.js
```

Очікувано: усі ✅.

- [ ] **Step 5: Коміт**

```bash
git add finance.js tests/finance/04-expenses.js && git commit -m "Фінмодуль: витрати, часткові оплати, борг постачальнику

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 5: `delivered_at` і автоматичний дохід від забраних

**Files:**
- Modify: `finance.js` (експорт `onOrderDelivered`)
- Modify: `server.js` (два місця, де замовлення стає `delivered`: ручна зміна статусу і трекінг НП)
- Test: `tests/finance/05-income.js`

**Interfaces:**
- Consumes: `addCashMove` із Задачі 4
- Produces: `module.exports.onOrderDelivered(orderId)` — ставить `delivered_at` один раз і записує дохід у касу на суму `total_drop_price`

- [ ] **Step 1: Написати перевірку**

Створити `tests/finance/05-income.js`:

```js
const B = "http://localhost:3100";
const sqlite = require("../../node_modules/better-sqlite3");
const db = sqlite(process.env.DB_PATH || "/tmp/fin-test.db");
let cookie = "";
async function api(u, o = {}) {
  const r = await fetch(B + u, { ...o, headers: { "Content-Type": "application/json", cookie, ...(o.headers || {}) } });
  const sc = r.headers.getSetCookie ? r.headers.getSetCookie() : [];
  if (sc.length) cookie = sc.map(s => s.split(";")[0]).join("; ");
  let b = null; try { b = await r.json() } catch (e) {}
  return { s: r.status, b };
}
const ok = (c, m) => { console.log((c ? "✅" : "❌ FAIL") + " " + m); if (!c) process.exitCode = 1; };

(async () => {
  await api("/api/auth/dev-login/admin", { method: "POST" });
  const o = db.prepare("SELECT id,total_drop_price FROM orders WHERE status!='delivered' AND total_drop_price>0 ORDER BY id DESC LIMIT 1").get();
  ok(!!o, "є замовлення для перевірки: #" + (o && o.id));
  db.prepare("UPDATE orders SET delivered_at='' WHERE id=?").run(o.id);
  db.prepare("DELETE FROM cash_moves WHERE ref_type='order' AND ref_id=?").run(o.id);

  let r = await api("/api/orders/" + o.id + "/status", { method: "PUT", body: JSON.stringify({ status: "delivered" }) });
  ok(r.s === 200, "статус змінено на delivered");

  const row = db.prepare("SELECT delivered_at FROM orders WHERE id=?").get(o.id);
  ok(!!row.delivered_at, "delivered_at проставлено: " + row.delivered_at);
  const moves = db.prepare("SELECT * FROM cash_moves WHERE ref_type='order' AND ref_id=?").all(o.id);
  ok(moves.length === 1 && moves[0].amount === Math.round(o.total_drop_price * 100) / 100, "дохід записано один раз на " + (moves[0] && moves[0].amount));
  ok(moves[0].date === row.delivered_at.slice(0, 10), "дата доходу — день отримання");

  // повторний перехід не має подвоїти дохід
  await api("/api/orders/" + o.id + "/status", { method: "PUT", body: JSON.stringify({ status: "shipped" }) });
  await api("/api/orders/" + o.id + "/status", { method: "PUT", body: JSON.stringify({ status: "delivered" }) });
  const again = db.prepare("SELECT COUNT(*) c FROM cash_moves WHERE ref_type='order' AND ref_id=?").get(o.id).c;
  ok(again === 1, "повторне отримання доходу не подвоїло (" + again + ")");

  const first = db.prepare("SELECT delivered_at FROM orders WHERE id=?").get(o.id).delivered_at;
  ok(first === row.delivered_at, "delivered_at не перезаписалось");

  db.prepare("DELETE FROM cash_moves WHERE ref_type='order' AND ref_id=?").run(o.id);
})();
```

- [ ] **Step 2: Запустити, переконатись що падає**

```bash
cd /Users/artemkravcov/Desktop/projeckt/warehouse-crm && node tests/finance/05-income.js
```

Очікувано: ❌ на `delivered_at` і на записі доходу.

- [ ] **Step 3: Додати `onOrderDelivered` у `finance.js`**

Після `addCashMove`, поза `register()`:

```js
// Дохід визнаємо в день, коли клієнт забрав посилку, і рівно один раз.
// Доходом вважається дроп-ціна, а не наложка: наложка приходить цілком, але
// різниця йде дроперу, тож заробіток складу — саме дроп-ціна.
function onOrderDelivered(orderId) {
  const o = db.prepare("SELECT id,total_drop_price,delivered_at FROM orders WHERE id=?").get(orderId);
  if (!o) return;
  if (!o.delivered_at) {
    db.prepare("UPDATE orders SET delivered_at=datetime('now','localtime') WHERE id=? AND COALESCE(delivered_at,'')=''").run(orderId);
  }
  const day = (db.prepare("SELECT delivered_at d FROM orders WHERE id=?").get(orderId).d || "").slice(0, 10);
  if (!o.total_drop_price) return;
  addCashMove({ date: day, amount: o.total_drop_price, kind: "income", ref_type: "order", ref_id: orderId, note: "Замовлення #" + orderId });
}
```

Розширити експорт:

```js
module.exports = { register, addCashMove, onOrderDelivered };
```

- [ ] **Step 4: Викликати з обох місць у `server.js`**

Угорі, поруч з іншими require:

```js
const finance = require("./finance");
```

У `app.put("/api/orders/:id/status", ...)`, усередині транзакції після оновлення статусу:

```js
    // Забрана посилка — це дохід дня отримання, а не дня створення замовлення.
    if (status === "delivered") finance.onOrderDelivered(req.params.id);
```

У `trackOneOrder`, після блоку `if (ns === "shipped") { ... }`:

```js
  if (ns === "delivered") finance.onOrderDelivered(o.id);
```

Замінити рядок реєстрації перед `app.listen` на:

```js
finance.register(app, { authMiddleware, requireRole });
```

- [ ] **Step 5: Перезапустити сервер і запустити перевірку**

```bash
cd /Users/artemkravcov/Desktop/projeckt/warehouse-crm && node tests/finance/05-income.js
```

Очікувано: усі ✅.

- [ ] **Step 6: Коміт**

```bash
git add finance.js server.js tests/finance/05-income.js && git commit -m "Фінмодуль: дохід від забраних посилок у день отримання

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 6: Виплати дроперу, зарплата й повернення коштів клієнту

**Files:**
- Modify: `finance.js` (експорт `onDropPayoutPaid`, `onWorkerPayout`, маршрут повернення)
- Modify: `server.js:3934` (проведення виплати дроперу), `server.js:3519` (виплата працівнику)
- Test: `tests/finance/06-cash-hooks.js`

**Interfaces:**
- Consumes: `addCashMove`
- Produces: `onDropPayoutPaid(payoutRequestId)`, `onWorkerPayout(workerPayoutId)`; маршрут `POST /api/finance/orders/:id/refund` `{amount,note}`

- [ ] **Step 1: Написати перевірку**

Створити `tests/finance/06-cash-hooks.js`:

```js
const B = "http://localhost:3100";
const sqlite = require("../../node_modules/better-sqlite3");
const db = sqlite(process.env.DB_PATH || "/tmp/fin-test.db");
let cookie = "";
async function api(u, o = {}) {
  const r = await fetch(B + u, { ...o, headers: { "Content-Type": "application/json", cookie, ...(o.headers || {}) } });
  const sc = r.headers.getSetCookie ? r.headers.getSetCookie() : [];
  if (sc.length) cookie = sc.map(s => s.split(";")[0]).join("; ");
  let b = null; try { b = await r.json() } catch (e) {}
  return { s: r.status, b };
}
const ok = (c, m) => { console.log((c ? "✅" : "❌ FAIL") + " " + m); if (!c) process.exitCode = 1; };

(async () => {
  await api("/api/auth/dev-login/admin", { method: "POST" });
  const o = db.prepare("SELECT id,total_drop_price FROM orders WHERE total_drop_price>0 ORDER BY id DESC LIMIT 1").get();

  // повернення коштів клієнту
  db.prepare("UPDATE orders SET refunded_amount=0,refunded_at='' WHERE id=?").run(o.id);
  db.prepare("DELETE FROM cash_moves WHERE ref_type='refund' AND ref_id=?").run(o.id);
  let r = await api("/api/finance/orders/" + o.id + "/refund", { method: "POST", body: JSON.stringify({ amount: 250, note: "__T6" }) });
  ok(r.s === 200, "повернення коштів проведено");
  const mv = db.prepare("SELECT * FROM cash_moves WHERE ref_type='refund' AND ref_id=?").get(o.id);
  ok(mv && mv.amount === -250, "у касі мінус 250 (" + (mv && mv.amount) + ")");
  ok(db.prepare("SELECT refunded_amount r FROM orders WHERE id=?").get(o.id).r === 250, "сума повернення записана в замовлення");

  r = await api("/api/finance/orders/" + o.id + "/refund", { method: "POST", body: JSON.stringify({ amount: -5 }) });
  ok(r.s === 400, "від'ємна сума відхилена");

  // виплата дроперу
  const pr = db.prepare("SELECT id,total_amount FROM payout_requests WHERE status!='paid' ORDER BY id DESC LIMIT 1").get();
  if (pr) {
    db.prepare("DELETE FROM cash_moves WHERE ref_type='payout' AND ref_id=?").run(pr.id);
    r = await api("/api/payout-requests/" + pr.id + "/pay", { method: "POST", body: JSON.stringify({}) });
    const pm = db.prepare("SELECT * FROM cash_moves WHERE ref_type='payout' AND ref_id=?").get(pr.id);
    ok(pm && Math.abs(pm.amount + pr.total_amount) < 0.01, "виплата дроперу лягла в касу мінусом (" + (pm && pm.amount) + ")");
    ok(pm.kind === "payout", "тип руху payout, не витрата");
  } else console.log("⚠️ немає невиплаченого запиту — перевірку виплати пропущено");

  db.prepare("DELETE FROM cash_moves WHERE note LIKE '__T6%' OR (ref_type='refund' AND ref_id=?)").run(o.id);
  db.prepare("UPDATE orders SET refunded_amount=0,refunded_at='' WHERE id=?").run(o.id);
})();
```

- [ ] **Step 2: Запустити, переконатись що падає**

```bash
cd /Users/artemkravcov/Desktop/projeckt/warehouse-crm && node tests/finance/06-cash-hooks.js
```

Очікувано: ❌ (маршруту повернення немає, рухів каси немає).

- [ ] **Step 3: Додати хелпери й маршрут у `finance.js`**

Поза `register()`:

```js
// Виплата дроперу — рух грошей, а не витрата: його частина вже виключена з
// доходу тим, що доходом рахується дроп-ціна, а не наложка. Записати її ще й
// витратою означало б відняти двічі.
function onDropPayoutPaid(payoutRequestId) {
  const pr = db.prepare("SELECT id,total_amount,paid_at FROM payout_requests WHERE id=?").get(payoutRequestId);
  if (!pr || !pr.total_amount) return;
  addCashMove({ date: (pr.paid_at || "").slice(0, 10) || db.prepare("SELECT date('now','localtime') d").get().d,
    amount: -pr.total_amount, kind: "payout", ref_type: "payout", ref_id: pr.id, note: "Виплата дроперу" });
}

// Зарплата: у касу потрапляє факт виплати, а не нарахування.
function onWorkerPayout(workerPayoutId) {
  const p = db.prepare("SELECT wp.id, wp.amount, wp.created_at, w.name FROM worker_payouts wp JOIN workers w ON wp.worker_id=w.id WHERE wp.id=?").get(workerPayoutId);
  if (!p || !p.amount) return;
  addCashMove({ date: (p.created_at || "").slice(0, 10), amount: -p.amount, kind: "salary",
    ref_type: "worker_payout", ref_id: p.id, note: "Зарплата: " + p.name });
}
```

Усередині `register()`:

```js
  // Повернення грошей клієнту: мінус у касі й мінус у доході того дня, коли
  // повернули, а не того, коли замовлення створювалось.
  app.post("/api/finance/orders/:id/refund", ...adminOnly, (req, res) => {
    const o = db.prepare("SELECT id,total_drop_price,refunded_amount FROM orders WHERE id=?").get(req.params.id);
    if (!o) return res.status(404).json({ error: "Замовлення не знайдено" });
    const amount = parseFloat(req.body.amount);
    if (!amount || amount <= 0) return res.status(400).json({ error: "Вкажіть суму повернення" });
    const date = db.prepare("SELECT date('now','localtime') d").get().d;
    db.transaction(() => {
      db.prepare("UPDATE orders SET refunded_amount=COALESCE(refunded_amount,0)+?,refunded_at=datetime('now','localtime') WHERE id=?")
        .run(round2(amount), o.id);
      // Одне замовлення можна повертати частинами, а унікальний індекс по ref
      // пропустить лише перший рух — далі пишемо без прив'язки до замовлення,
      // інакше друге часткове повернення мовчки загубилось би.
      const had = db.prepare("SELECT COUNT(*) c FROM cash_moves WHERE ref_type='refund' AND ref_id=?").get(o.id).c;
      addCashMove({ date, amount: -amount, kind: "refund", ref_type: had ? "refund_extra" : "refund",
        ref_id: had ? null : o.id, note: (req.body.note || "Повернення коштів") + " (замовлення #" + o.id + ")" });
    })();
    res.json({ ok: true });
  });
```

- [ ] **Step 4: Підключити хелпери в `server.js`**

У маршруті проведення виплати (`server.js`, рядок з `UPDATE payout_requests SET status='paid'`) одразу після нього:

```js
  finance.onDropPayoutPaid(req.params.id);
```

У маршруті виплати працівнику (`INSERT INTO worker_payouts`) замінити рядок на:

```js
  const wp = db.prepare("INSERT INTO worker_payouts(worker_id,amount)VALUES(?,?)").run(w.id, balance);
  finance.onWorkerPayout(wp.lastInsertRowid);
```

Розширити експорт `finance.js`:

```js
module.exports = { register, addCashMove, onOrderDelivered, onDropPayoutPaid, onWorkerPayout };
```

- [ ] **Step 5: Перезапустити сервер і запустити перевірку**

```bash
cd /Users/artemkravcov/Desktop/projeckt/warehouse-crm && node tests/finance/06-cash-hooks.js
```

Очікувано: усі ✅ (рядок про виплату може бути пропущений, якщо немає невиплаченого запиту).

- [ ] **Step 6: Коміт**

```bash
git add finance.js server.js tests/finance/06-cash-hooks.js && git commit -m "Фінмодуль: виплати, зарплата й повернення коштів у касі

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 7: Звіт за період і звірка з банком

**Files:**
- Modify: `finance.js`
- Test: `tests/finance/07-report.js`

**Interfaces:**
- Consumes: `cash_moves`, `expenses`, `expense_payments`
- Produces: `GET /api/finance/report?from&to` → `{from,to,income,expenses_paid,cash_delta,balance,opening_balance,by_category:[{name,is_goods,amount}],goods_spent,opex_spent,debts_total,last_check}`; `POST /api/finance/cash-check` `{actual_balance,note}` → `{ok,calc_balance,diff}`; `GET /api/finance/settings` / `PUT /api/finance/settings` `{cash_opening_balance,cash_opening_date}`

- [ ] **Step 1: Написати перевірку**

Створити `tests/finance/07-report.js`:

```js
const B = "http://localhost:3100";
const sqlite = require("../../node_modules/better-sqlite3");
const db = sqlite(process.env.DB_PATH || "/tmp/fin-test.db");
let cookie = "";
async function api(u, o = {}) {
  const r = await fetch(B + u, { ...o, headers: { "Content-Type": "application/json", cookie, ...(o.headers || {}) } });
  const sc = r.headers.getSetCookie ? r.headers.getSetCookie() : [];
  if (sc.length) cookie = sc.map(s => s.split(";")[0]).join("; ");
  let b = null; try { b = await r.json() } catch (e) {}
  return { s: r.status, b };
}
const ok = (c, m) => { console.log((c ? "✅" : "❌ FAIL") + " " + m); if (!c) process.exitCode = 1; };
const today = new Date().toISOString().slice(0, 10);

(async () => {
  await api("/api/auth/dev-login/admin", { method: "POST" });
  db.prepare("DELETE FROM cash_moves WHERE note LIKE '__T7%'").run();
  db.prepare("DELETE FROM expenses WHERE note LIKE '__T7%'").run();

  await api("/api/finance/settings", { method: "PUT", body: JSON.stringify({ cash_opening_balance: 10000, cash_opening_date: today }) });

  const cats = (await api("/api/finance/categories")).b.categories;
  const opex = cats.find(c => !c.is_goods);
  const goods = cats.find(c => c.is_goods);
  await api("/api/finance/expenses", { method: "POST", body: JSON.stringify({ date: today, amount: 2000, category_id: opex.id, note: "__T7 оренда", paid: 1 }) });
  await api("/api/finance/expenses", { method: "POST", body: JSON.stringify({ date: today, amount: 5000, category_id: goods.id, note: "__T7 тканина", paid: 1 }) });
  await api("/api/finance/expenses", { method: "POST", body: JSON.stringify({ date: today, amount: 3000, category_id: goods.id, note: "__T7 борг", paid: 0 }) });
  db.prepare("INSERT INTO cash_moves(date,amount,kind,ref_type,note)VALUES(?,?,?,?,?)").run(today, 9000, "income", "", "__T7 дохід");

  const r = await api("/api/finance/report?from=" + today + "&to=" + today);
  ok(r.s === 200, "звіт віддається");
  ok(r.b.income === 9000, "надходження 9000 (" + r.b.income + ")");
  ok(r.b.expenses_paid === 7000, "оплачені витрати 7000 (" + r.b.expenses_paid + ")");
  ok(r.b.cash_delta === 2000, "рух каси 2000 (" + r.b.cash_delta + ")");
  ok(r.b.opex_spent === 2000 && r.b.goods_spent === 8000, "розподіл витрата/товар: " + r.b.opex_spent + " / " + r.b.goods_spent);
  ok(r.b.debts_total === 3000, "борг 3000 (" + r.b.debts_total + ")");
  ok(r.b.balance === 12000, "розрахунковий залишок 12000 = 10000 старт + 2000 (" + r.b.balance + ")");
  const cat = r.b.by_category.find(c => c.name === goods.name);
  ok(cat && cat.amount === 8000, "по категорії «" + goods.name + "» 8000 (" + (cat && cat.amount) + ")");

  // менеджер: відсоток від прибутку за формулою власника
  await api("/api/finance/manager-rate", { method: "POST", body: JSON.stringify({ name: "__T7 Діана", percent: 7, from_date: "2000-01-01" }) });
  const r3 = await api("/api/finance/report?from=" + today + "&to=" + today);
  ok(r3.b.profit_cash === 0, "прибуток за формулою власника 9000 − 2000 − 8000 = 0 (" + r3.b.profit_cash + ")");
  ok(r3.b.manager && r3.b.manager.percent === 7 && r3.b.manager.amount === 0, "менеджер рахується від нього: " + JSON.stringify(r3.b.manager));
  db.prepare("INSERT INTO cash_moves(date,amount,kind,ref_type,note)VALUES(?,?,?,?,?)").run(today, 1000, "income", "", "__T7 ще дохід");
  const r4 = await api("/api/finance/report?from=" + today + "&to=" + today);
  ok(r4.b.profit_cash === 1000 && r4.b.manager.amount === 70, "з прибутку 1000 менеджеру 70 (" + r4.b.manager.amount + ")");
  ok(r4.b.profit_after_manager === 930, "прибуток після менеджера 930 (" + r4.b.profit_after_manager + ")");
  db.prepare("DELETE FROM manager_rates WHERE name='__T7 Діана'").run();

  const ch = await api("/api/finance/cash-check", { method: "POST", body: JSON.stringify({ actual_balance: 11500, note: "__T7" }) });
  ok(ch.s === 200 && ch.b.diff === -500, "звірка показала розбіжність −500 (" + ch.b.diff + ")");
  const r2 = await api("/api/finance/report?from=" + today + "&to=" + today);
  ok(r2.b.last_check && r2.b.last_check.diff === -500, "остання звірка видно у звіті");

  db.prepare("DELETE FROM cash_moves WHERE note LIKE '__T7%'").run();
  db.prepare("DELETE FROM expense_payments WHERE expense_id IN (SELECT id FROM expenses WHERE note LIKE '__T7%')").run();
  db.prepare("DELETE FROM cash_moves WHERE ref_type='expense' AND ref_id IN (SELECT id FROM expenses WHERE note LIKE '__T7%')").run();
  db.prepare("DELETE FROM expenses WHERE note LIKE '__T7%'").run();
  db.prepare("DELETE FROM cash_checks WHERE note='__T7'").run();
})();
```

- [ ] **Step 2: Запустити, переконатись що падає**

```bash
cd /Users/artemkravcov/Desktop/projeckt/warehouse-crm && node tests/finance/07-report.js
```

Очікувано: ❌ (маршрутів немає).

- [ ] **Step 3: Додати маршрути в `finance.js`**

Усередині `register()`:

```js
  // Стартовий залишок: система не знає, скільки було на рахунку до її появи,
  // тож власник вводить це число один раз, і від нього рахується баланс.
  const getSetting = (k, d) => {
    const r = db.prepare("SELECT value FROM settings WHERE key=?").get(k);
    return r === undefined ? d : r.value;
  };

  app.get("/api/finance/settings", ...adminOnly, (req, res) => {
    res.json({
      cash_opening_balance: parseFloat(getSetting("cash_opening_balance", 0)) || 0,
      cash_opening_date: getSetting("cash_opening_date", "") || "",
      manager_rates: db.prepare("SELECT * FROM manager_rates ORDER BY from_date DESC, id DESC").all()
    });
  });

  // Нова ставка менеджера — новий рядок історії, а не правка старого: місяці,
  // за які вже заплачено, мають лишитись порахованими за тодішнім відсотком.
  app.post("/api/finance/manager-rate", ...adminOnly, (req, res) => {
    const name = (req.body.name || "").trim();
    const percent = parseFloat(req.body.percent);
    if (!name) return res.status(400).json({ error: "Вкажіть ім'я менеджера" });
    if (isNaN(percent) || percent < 0 || percent > 100) return res.status(400).json({ error: "Відсоток має бути від 0 до 100" });
    const from = req.body.from_date || db.prepare("SELECT date('now','localtime') d").get().d;
    db.prepare("INSERT INTO manager_rates(name,percent,from_date)VALUES(?,?,?)").run(name, percent, from);
    res.json({ ok: true });
  });

  app.put("/api/finance/settings", ...adminOnly, (req, res) => {
    const st = db.prepare("INSERT OR REPLACE INTO settings(key,value)VALUES(?,?)");
    if (req.body.cash_opening_balance !== undefined) st.run("cash_opening_balance", String(parseFloat(req.body.cash_opening_balance) || 0));
    if (req.body.cash_opening_date !== undefined) st.run("cash_opening_date", String(req.body.cash_opening_date || ""));
    res.json({ ok: true });
  });

  function calcBalance() {
    const opening = parseFloat(getSetting("cash_opening_balance", 0)) || 0;
    const since = getSetting("cash_opening_date", "") || "";
    const moves = since
      ? db.prepare("SELECT COALESCE(SUM(amount),0) s FROM cash_moves WHERE date>=?").get(since).s
      : db.prepare("SELECT COALESCE(SUM(amount),0) s FROM cash_moves").get().s;
    return round2(opening + moves);
  }

  app.get("/api/finance/report", ...adminOnly, (req, res) => {
    const from = req.query.from || db.prepare("SELECT date('now','localtime','-30 days') d").get().d;
    const to = req.query.to || db.prepare("SELECT date('now','localtime') d").get().d;
    const sum = (sql, ...p) => round2(db.prepare(sql).get(...p).s);

    const income = sum("SELECT COALESCE(SUM(amount),0) s FROM cash_moves WHERE kind='income' AND date BETWEEN ? AND ?", from, to);
    const cashDelta = sum("SELECT COALESCE(SUM(amount),0) s FROM cash_moves WHERE date BETWEEN ? AND ?", from, to);
    const expensesPaid = sum("SELECT COALESCE(SUM(amount),0) s FROM expense_payments WHERE date BETWEEN ? AND ?", from, to);

    // Розріз по категоріях беремо за нарахованими витратами, а не за оплатами:
    // «скільки я витратив на тканину цього місяця» — це про витрату, навіть
    // якщо частину взяв у борг.
    const byCategory = db.prepare(`SELECT c.name, c.is_goods, ROUND(SUM(e.amount),2) as amount
      FROM expenses e LEFT JOIN fin_categories c ON e.category_id=c.id
      WHERE e.date BETWEEN ? AND ? GROUP BY e.category_id ORDER BY amount DESC`).all(from, to);

    const goodsSpent = round2(byCategory.filter(c => c.is_goods).reduce((s, c) => s + c.amount, 0));
    const opexSpent = round2(byCategory.filter(c => !c.is_goods).reduce((s, c) => s + c.amount, 0));

    const debtsTotal = sum(`SELECT COALESCE(SUM(e.amount),0) - COALESCE((SELECT SUM(p.amount) FROM expense_payments p JOIN expenses e2 ON p.expense_id=e2.id WHERE e2.supplier_id IS NOT NULL),0) s
      FROM expenses e WHERE e.supplier_id IS NOT NULL`);

    // Прибуток за формулою власника: дохід мінус усі витрати періоду, включно
    // із закупівлями. Саме від нього рахується відсоток менеджера — це
    // домовленість із людиною, і міняти базу під нову модель обліку не можна.
    const profitCash = round2(income - opexSpent - goodsSpent);
    const mgr = db.prepare("SELECT * FROM manager_rates WHERE from_date<=? ORDER BY from_date DESC, id DESC LIMIT 1").get(to) || null;
    const managerAmount = mgr ? round2(profitCash * mgr.percent / 100) : 0;

    res.json({
      from, to, income, expenses_paid: expensesPaid, cash_delta: cashDelta,
      opening_balance: parseFloat(getSetting("cash_opening_balance", 0)) || 0,
      balance: calcBalance(),
      by_category: byCategory, goods_spent: goodsSpent, opex_spent: opexSpent,
      debts_total: debtsTotal,
      profit_cash: profitCash,
      manager: mgr ? { name: mgr.name, percent: mgr.percent, amount: managerAmount } : null,
      profit_after_manager: round2(profitCash - managerAmount),
      last_check: db.prepare("SELECT * FROM cash_checks ORDER BY id DESC LIMIT 1").get() || null
    });
  });

  // Звірка: власник вводить, скільки реально на рахунку, система показує
  // різницю з розрахунковим. Розбіжність означає, що якийсь рух не записано.
  app.post("/api/finance/cash-check", ...adminOnly, (req, res) => {
    const actual = parseFloat(req.body.actual_balance);
    if (isNaN(actual)) return res.status(400).json({ error: "Вкажіть фактичний залишок" });
    const calc = calcBalance();
    const diff = round2(actual - calc);
    db.prepare("INSERT INTO cash_checks(date,actual_balance,calc_balance,diff,note)VALUES(date('now','localtime'),?,?,?,?)")
      .run(round2(actual), calc, diff, req.body.note || "");
    res.json({ ok: true, calc_balance: calc, diff });
  });
```

- [ ] **Step 4: Перезапустити сервер і запустити перевірку**

```bash
cd /Users/artemkravcov/Desktop/projeckt/warehouse-crm && node tests/finance/07-report.js
```

Очікувано: усі ✅.

- [ ] **Step 5: Коміт**

```bash
git add finance.js tests/finance/07-report.js && git commit -m "Фінмодуль: звіт за період і звірка залишку з банком

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 8: Вкладка «Бухгалтерія» в адмінці

**Files:**
- Create: `public/finance.js`
- Modify: `public/admin.html` (розмітка сторінки `pg-fin`, пункт навігації, підключення скрипта, реєстрація завантажувача)
- Test: перевірка в браузері (кроки нижче)

**Interfaces:**
- Consumes: усі маршрути `/api/finance/*` із Задач 2–7
- Produces: `loadFinance()` — глобальна функція, яку викликає перемикач сторінок адмінки

- [ ] **Step 1: Додати розмітку в `admin.html`**

У бічному меню, після пункту `accounting`:

```html
    <a data-p="fin"><i data-icon="wallet" data-size="15"></i> Гроші</a>
```

Перед `<div class="page" id="pg-settings">`:

```html
<div class="page" id="pg-fin"><div class="pt"><i data-icon="wallet" data-size="17"></i> Гроші</div>
<div class="acts">
  <button class="stab" id="fin-7" onclick="setFinPeriod(7)">7д</button>
  <button class="stab on" id="fin-30" onclick="setFinPeriod(30)">30д</button>
  <button class="stab" id="fin-90" onclick="setFinPeriod(90)">90д</button>
  <input type="date" id="fin-df"><input type="date" id="fin-dt">
  <button class="btn btn-sm btn-p" onclick="loadFinance()">OK</button>
  <button class="btn btn-sm" onclick="openFinExpense()"><i data-icon="plus" data-size="13"></i> Додати витрату</button>
</div>
<div id="fin-summary" style="margin-bottom:12px"></div>
<div class="stabs" style="margin-bottom:10px">
  <button class="stab on" id="fintab-list" onclick="showFinTab('list')">Витрати</button>
  <button class="stab" id="fintab-debts" onclick="showFinTab('debts')">Борги</button>
  <button class="stab" id="fintab-cats" onclick="showFinTab('cats')">Категорії</button>
</div>
<div id="fin-v-list"></div>
<div id="fin-v-debts" style="display:none"></div>
<div id="fin-v-cats" style="display:none"></div>
</div>

<div class="modal-bg" id="fin-exp-modal"><div class="modal" style="max-width:420px"><h3><i data-icon="plus" data-size="16"></i> Витрата</h3>
<div class="fld"><label>Дата</label><input type="date" id="fe-date"></div>
<div class="fld"><label>Сума ₴</label><input type="number" id="fe-amount" step="0.01"></div>
<div class="fld"><label>Категорія</label><select id="fe-cat"></select></div>
<div class="fld"><label>Постачальник (не обов'язково)</label><select id="fe-sup"></select></div>
<div class="fld"><label>Коментар</label><input id="fe-note"></div>
<div class="fld"><label><input type="checkbox" id="fe-paid" checked> Оплачено з рахунку (інакше — в борг)</label></div>
<div id="fe-err" style="display:none;color:var(--red);font-size:11px;margin-bottom:6px"></div>
<div style="display:flex;gap:6px"><button class="btn btn-p" onclick="saveFinExpense(this)">Зберегти</button><button class="btn" onclick="closeM('fin-exp-modal')">Скасувати</button></div>
</div></div>

<div class="modal-bg" id="fin-check-modal"><div class="modal" style="max-width:380px"><h3><i data-icon="check" data-size="16"></i> Звірка з банком</h3>
<div id="fc-calc" style="font-size:12px;color:var(--td);margin-bottom:8px"></div>
<div class="fld"><label>Скільки реально на рахунку ₴</label><input type="number" id="fc-actual" step="0.01"></div>
<div id="fc-res" style="font-size:12px;margin-bottom:8px"></div>
<div style="display:flex;gap:6px"><button class="btn btn-p" onclick="saveFinCheck(this)">Звірити</button><button class="btn" onclick="closeM('fin-check-modal')">Закрити</button></div>
</div></div>
```

Перед `</body>` (поруч з іншими скриптами):

```html
<script src="/public/finance.js"></script>
```

У об'єкті-диспетчері сторінок додати `fin:loadFinance,` поруч із `accounting:loadAccounting`.

Поруч з іншими викликами `RangePicker.init` додати:

```js
RangePicker.init("fin-df", "fin-dt", {presets:[7,30,90], quick:false, onApply:function(){loadFinance()}});
setFinPeriod(30);
```

- [ ] **Step 2: Створити `public/finance.js`**

```js
// Вкладка «Гроші»: журнал витрат, борги постачальникам, звірка з банком.
// Логіку тримаємо окремим файлом — admin.html уже завеликий.
var finCats = [], finSups = [], finReport = null;

// Назви типів логіки словами власника, а не кодом: він обирає, що система
// має зробити з грошима, і більше нічого не вказує.
var FIN_KIND_LABEL = {
  expense: "відняти від прибутку",
  material: "матеріал (тканина, фурнітура)",
  sewing: "робота цеху",
  purchase: "закупка готового товару"
};

function setFinPeriod(days){
  ["fin-7","fin-30","fin-90"].forEach(function(id){var b=document.getElementById(id);if(b)b.classList.remove("on")});
  var b=document.getElementById("fin-"+days); if(b)b.classList.add("on");
  var end=new Date(), start=new Date(end.getTime()-(days-1)*86400000);
  function f(d){return d.getFullYear()+"-"+String(d.getMonth()+1).padStart(2,"0")+"-"+String(d.getDate()).padStart(2,"0")}
  document.getElementById("fin-df").value=f(start);
  document.getElementById("fin-dt").value=f(end);
  loadFinance();
}

function showFinTab(t){
  ["list","debts","cats"].forEach(function(x){
    document.getElementById("fin-v-"+x).style.display=x===t?"":"none";
    document.getElementById("fintab-"+x).classList.toggle("on",x===t);
  });
}

async function loadFinance(){
  if(!document.getElementById("fin-df").value)return setFinPeriod(30);
  var f=document.getElementById("fin-df").value, t=document.getElementById("fin-dt").value;
  try{
    finCats=(await api("/api/finance/categories")).categories;
    finSups=(await api("/api/finance/suppliers")).suppliers;
    finReport=await api("/api/finance/report?from="+f+"&to="+t);
    var exp=(await api("/api/finance/expenses?from="+f+"&to="+t)).expenses;
    renderFinSummary(); renderFinList(exp); renderFinDebts(); renderFinCats();
  }catch(e){}
}

function finMoney(v){return (Math.round((v||0)*100)/100).toLocaleString("uk-UA")}

function renderFinSummary(){
  var r=finReport;
  function tile(l,v,c){return '<div style="flex:1;min-width:140px;background:var(--card);border:1px solid var(--brd);border-radius:10px;padding:10px"><div style="font-size:10px;color:var(--td);margin-bottom:4px">'+l+'</div><div style="font-size:18px;font-weight:700;color:'+(c||"var(--th)")+'">'+v+'</div></div>'}
  var res=r.income-r.opex_spent-r.goods_spent;
  document.getElementById("fin-summary").innerHTML='<div style="display:flex;flex-wrap:wrap;gap:8px">'
    +tile("Надходження",finMoney(r.income)+"₴","var(--acc)")
    +tile("Витрати періоду",finMoney(r.opex_spent)+"₴","var(--red)")
    +tile("Вкладено в товар",finMoney(r.goods_spent)+"₴","var(--warn)")
    +tile("Різниця по касі",finMoney(r.cash_delta)+"₴",r.cash_delta<0?"var(--red)":"var(--acc)")
    +tile("Має бути на рахунку",finMoney(r.balance)+"₴")
    +tile("Борги постачальникам",finMoney(r.debts_total)+"₴",r.debts_total?"var(--warn)":"var(--th)")
    +tile("Прибуток за період",finMoney(r.profit_cash)+"₴",r.profit_cash<0?"var(--red)":"var(--acc)")
    +(r.manager?tile(esc(r.manager.name)+" "+r.manager.percent+"%",finMoney(r.manager.amount)+"₴"):"")
    +(r.manager?tile("Прибуток після виплати",finMoney(r.profit_after_manager)+"₴",r.profit_after_manager<0?"var(--red)":"var(--acc)"):"")
    +'</div>'
    +'<div style="margin-top:8px;display:flex;gap:8px;align-items:center;flex-wrap:wrap">'
    +'<button class="btn btn-sm" onclick="openFinCheck()">Звірити з банком</button>'
    +(r.last_check?'<span style="font-size:11px;color:'+(Math.abs(r.last_check.diff)<0.01?"var(--acc)":"var(--red)")+'">остання звірка '+esc(r.last_check.date)+': різниця '+finMoney(r.last_check.diff)+'₴</span>':'')
    +'</div>';
}

function renderFinList(exp){
  var byCat=finReport.by_category.map(function(c){
    return '<span style="font-size:11px;padding:3px 8px;border-radius:6px;background:var(--bg);color:'+(c.is_goods?"var(--warn)":"var(--td)")+';margin-right:4px">'+esc(c.name||"—")+' '+finMoney(c.amount)+'₴</span>';
  }).join("");
  var rows=exp.map(function(e){
    return '<div style="display:flex;justify-content:space-between;gap:8px;padding:8px 0;border-top:1px solid var(--brd);font-size:12px">'
      +'<div><b style="color:var(--th)">'+esc(e.category_name||"без категорії")+'</b>'+(e.is_goods?' <span style="font-size:10px;color:var(--warn)">товар</span>':'')
      +'<div style="font-size:10px;color:var(--td)">'+esc(e.date)+(e.supplier_name?' · '+esc(e.supplier_name):'')+(e.note?' · '+esc(e.note):'')+'</div></div>'
      +'<div style="text-align:right;white-space:nowrap"><div>'+finMoney(e.amount)+'₴</div>'
      +(e.debt>0?'<div style="font-size:10px;color:var(--red)">борг '+finMoney(e.debt)+'₴ <button class="btn btn-sm" onclick="payFinExpense('+e.id+','+e.debt+')">Оплатити</button></div>':'')
      +'</div></div>';
  }).join("");
  document.getElementById("fin-v-list").innerHTML='<div style="margin-bottom:8px">'+byCat+'</div>'+(rows||'<div class="empty">Витрат за період немає</div>');
}

function renderFinDebts(){
  var rows=finSups.filter(function(s){return s.debt>0}).map(function(s){
    return '<div style="display:flex;justify-content:space-between;padding:8px 0;border-top:1px solid var(--brd);font-size:12px"><div>'+esc(s.name)+'</div><div style="color:var(--red)">'+finMoney(s.debt)+'₴</div></div>';
  }).join("");
  document.getElementById("fin-v-debts").innerHTML=(rows||'<div class="empty">Боргів немає</div>')
    +'<div style="margin-top:10px;display:flex;gap:6px"><input id="fin-sup-name" placeholder="Новий постачальник" style="flex:1;padding:8px;background:var(--input);border:1px solid var(--brd);border-radius:8px;color:#fff"><button class="btn btn-sm btn-p" onclick="addFinSupplier()">Додати</button></div>';
}

function renderFinCats(){
  var rows=finCats.map(function(c){
    return '<div style="display:flex;justify-content:space-between;align-items:center;padding:7px 0;border-top:1px solid var(--brd);font-size:12px">'
      +'<div>'+esc(c.name)+' <span style="font-size:10px;color:'+(c.is_goods?"var(--warn)":"var(--td)")+'">'+FIN_KIND_LABEL[c.kind]+'</span></div>'
      +'<button class="btn btn-sm btn-d" onclick="delFinCat('+c.id+')">×</button></div>';
  }).join("");
  document.getElementById("fin-v-cats").innerHTML=rows
    +'<div style="margin-top:10px;display:flex;gap:6px;align-items:center;flex-wrap:wrap">'
    +'<input id="fin-cat-name" placeholder="Назва категорії" style="flex:1;min-width:160px;padding:8px;background:var(--input);border:1px solid var(--brd);border-radius:8px;color:#fff">'
    +'<select id="fin-cat-kind" style="padding:8px;background:var(--input);border:1px solid var(--brd);border-radius:8px;color:#fff">'
    +Object.keys(FIN_KIND_LABEL).map(function(k){return '<option value="'+k+'">'+FIN_KIND_LABEL[k]+'</option>'}).join("")
    +'</select>'
    +'<button class="btn btn-sm btn-p" onclick="addFinCat()">Додати</button></div>';
}

function openFinExpense(){
  document.getElementById("fe-date").value=new Date().toISOString().slice(0,10);
  document.getElementById("fe-amount").value="";
  document.getElementById("fe-note").value="";
  document.getElementById("fe-paid").checked=true;
  document.getElementById("fe-err").style.display="none";
  document.getElementById("fe-cat").innerHTML=finCats.map(function(c){return '<option value="'+c.id+'">'+esc(c.name)+' — '+FIN_KIND_LABEL[c.kind]+'</option>'}).join("");
  document.getElementById("fe-sup").innerHTML='<option value="">—</option>'+finSups.map(function(s){return '<option value="'+s.id+'">'+esc(s.name)+'</option>'}).join("");
  openM("fin-exp-modal");
}

async function saveFinExpense(btn){
  var err=document.getElementById("fe-err");
  var body={date:document.getElementById("fe-date").value,amount:parseFloat(document.getElementById("fe-amount").value),
    category_id:parseInt(document.getElementById("fe-cat").value),supplier_id:parseInt(document.getElementById("fe-sup").value)||null,
    note:document.getElementById("fe-note").value,paid:document.getElementById("fe-paid").checked?1:0};
  try{await api("/api/finance/expenses",{method:"POST",body:JSON.stringify(body)});closeM("fin-exp-modal");loadFinance()}
  catch(e){err.textContent=e.message;err.style.display="block"}
}

async function payFinExpense(id,debt){
  var v=prompt("Скільки платимо? Залишок боргу "+finMoney(debt)+"₴", debt);
  if(v===null)return;
  try{await api("/api/finance/expenses/"+id+"/pay",{method:"POST",body:JSON.stringify({amount:parseFloat(v)})});loadFinance()}catch(e){alert(e.message)}
}

async function addFinCat(){
  var name=document.getElementById("fin-cat-name").value.trim();
  if(!name)return;
  try{await api("/api/finance/categories",{method:"POST",body:JSON.stringify({name:name,kind:document.getElementById("fin-cat-kind").value})});loadFinance()}catch(e){alert(e.message)}
}

async function delFinCat(id){
  if(!confirm("Прибрати категорію?"))return;
  try{await api("/api/finance/categories/"+id,{method:"DELETE"});loadFinance()}catch(e){alert(e.message)}
}

async function addFinSupplier(){
  var name=document.getElementById("fin-sup-name").value.trim();
  if(!name)return;
  try{await api("/api/finance/suppliers",{method:"POST",body:JSON.stringify({name:name})});loadFinance()}catch(e){alert(e.message)}
}

function openFinCheck(){
  document.getElementById("fc-calc").textContent="За системою на рахунку має бути "+finMoney(finReport.balance)+"₴";
  document.getElementById("fc-actual").value="";
  document.getElementById("fc-res").textContent="";
  openM("fin-check-modal");
}

async function saveFinCheck(btn){
  var v=parseFloat(document.getElementById("fc-actual").value);
  if(isNaN(v))return;
  try{
    var r=await api("/api/finance/cash-check",{method:"POST",body:JSON.stringify({actual_balance:v})});
    var el=document.getElementById("fc-res");
    el.style.color=Math.abs(r.diff)<0.01?"var(--acc)":"var(--red)";
    el.textContent=Math.abs(r.diff)<0.01?"Все сходиться":"Розбіжність "+finMoney(r.diff)+"₴ — якийсь рух не записано";
    loadFinance();
  }catch(e){alert(e.message)}
}
```

- [ ] **Step 3: Перевірити в браузері**

Підняти тестовий сервер, відкрити `http://localhost:3100/admin`, увійти адміном (`/api/auth/dev-login/admin`), відкрити вкладку «Гроші». Перевірити руками:

1. Плитки показують числа, календар виглядає як в інших вкладках.
2. «Додати витрату» → оплачена витрата з'являється в списку, «Має бути на рахунку» зменшується на її суму.
3. Витрата в борг із постачальником → у плитці «Борги» сума росте, у рядку є кнопка «Оплатити».
4. «Оплатити» частину боргу → залишок зменшується, баланс зменшується.
5. Вкладка «Категорії» → додати свою, побачити її у формі витрати, прибрати.
6. «Звірити з банком» → ввести число, побачити або «Все сходиться», або розбіжність.

Помилок у консолі бути не має:

```bash
cd /Users/artemkravcov/Desktop/projeckt/warehouse-crm && node tests/finance/07-report.js
```

Очікувано: усі ✅ (звіт не зламався від ручних дій).

- [ ] **Step 4: Коміт і деплой**

```bash
git add public/finance.js public/admin.html && git commit -m "Фінмодуль: вкладка «Гроші» — витрати, борги, категорії, звірка

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>" && git push origin main && fly deploy
```

Перевірити: `curl -s -o /dev/null -w "%{http_code}\n" https://warehouse-crm.fly.dev/login` → `200`.

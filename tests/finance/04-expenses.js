const { api, ok, login } = require("./_helpers");
const db = require("../../node_modules/better-sqlite3")(process.env.DB_PATH || "/tmp/fin-test.db");
const today = new Date().toISOString().slice(0, 10);

(async () => {
  await login("admin");
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

  // часткове оновлення через PUT: передаємо лише суму — better-sqlite3
  // кидає TypeError на undefined-параметрі, якщо date/category_id не мають
  // дефолту, а без дефолту вони мовчки перетворились би на null
  r = await api("/api/finance/expenses", { method: "POST", body: JSON.stringify({ date: today, amount: 300, category_id: opex, note: "__T4 часткове" }) });
  ok(r.s === 200 && r.b.id, "витрата для перевірки часткового оновлення створена");
  const e4 = r.b.id;
  r = await api("/api/finance/expenses/" + e4, { method: "PUT", body: JSON.stringify({ amount: 350 }) });
  ok(r.s === 200, "часткове оновлення (лише сума) не впало 500-кою (" + r.s + ")");
  let row4 = db.prepare("SELECT date,amount,category_id,note FROM expenses WHERE id=?").get(e4);
  ok(row4 && row4.amount === 350, "сума оновилась (" + (row4 && row4.amount) + ")");
  ok(row4 && row4.date === today, "дата лишилась незмінною, а не перетворилась на null (" + (row4 && row4.date) + ")");
  ok(row4 && row4.category_id === opex, "категорія лишилась незмінною (" + (row4 && row4.category_id) + ")");
  ok(row4 && row4.note === "__T4 часткове", "нотатка лишилась незмінною (" + (row4 && row4.note) + ")");

  // витрата на пошив без цеху — заборонена, бо інакше неможлива звірка
  // «скільки заплачено цеху проти скільки роботи прийнято»
  let sewCat = cats.find(c => c.kind === "sewing");
  if (!sewCat) {
    const rc = await api("/api/finance/categories", { method: "POST", body: JSON.stringify({ name: "__T4Пошив", kind: "sewing" }) });
    sewCat = { id: rc.b.id };
  }
  r = await api("/api/finance/expenses", { method: "POST", body: JSON.stringify({ date: today, amount: 500, category_id: sewCat.id, note: "__T4 пошив без цеху" }) });
  ok(r.s === 400, "витрата на пошив без цеху відхилена (" + r.s + ")");

  // цех для успішного створення — беремо будь-який наявний, або створюємо тимчасовий
  let ws = db.prepare("SELECT id FROM workshops LIMIT 1").get();
  let tmpWorkshopId = null;
  if (!ws) {
    tmpWorkshopId = db.prepare("INSERT INTO workshops(name) VALUES ('__T4Цех')").run().lastInsertRowid;
    ws = { id: tmpWorkshopId };
  }
  r = await api("/api/finance/expenses", { method: "POST", body: JSON.stringify({ date: today, amount: 500, category_id: sewCat.id, workshop_id: ws.id, note: "__T4 пошив із цехом", paid: 1 }) });
  ok(r.s === 200 && r.b.id, "витрата на пошив із цехом створена");
  const e3 = r.b.id;

  // той самий захист має діяти й через PUT: зняти цех із уже sewing-витрати не можна
  r = await api("/api/finance/expenses/" + e3, { method: "PUT", body: JSON.stringify({ amount: 500, date: today, category_id: sewCat.id, workshop_id: null }) });
  ok(r.s === 400, "зняти цех через PUT із sewing-витрати не можна (" + r.s + ")");

  // редагування workshop_id працює: переносимо витрату на інший цех
  const ws2Id = db.prepare("INSERT INTO workshops(name) VALUES ('__T4Цех2')").run().lastInsertRowid;
  r = await api("/api/finance/expenses/" + e3, { method: "PUT", body: JSON.stringify({ amount: 500, date: today, category_id: sewCat.id, workshop_id: ws2Id }) });
  ok(r.s === 200, "редагування workshop_id пройшло (" + r.s + ")");
  let row3 = db.prepare("SELECT workshop_id FROM expenses WHERE id=?").get(e3);
  ok(row3 && row3.workshop_id === ws2Id, "workshop_id справді змінився на новий цех (" + (row3 && row3.workshop_id) + ")");

  // той самий захист і при зміні категорії на sewing (workshop_id узагалі не передаємо)
  r = await api("/api/finance/expenses/" + e4, { method: "PUT", body: JSON.stringify({ amount: 350, category_id: sewCat.id }) });
  ok(r.s === 400, "зміна категорії на sewing без цеху через PUT відхилена (" + r.s + ")");

  // ── пункт 2: зміна дати витрати рухає за собою пов'язані оплати й рухи
  // каси — саме ту оплату, що виникла РАЗОМ із витратою (при paid=1 чи
  // будь-яку, датовану так само, як стара дата витрати), а НЕ пізнішу
  // окрему часткову оплату боргу, зроблену свідомо іншим днем ──────────
  const dateNew = db.prepare("SELECT date(?,'-5 days') d").get(today).d;
  const dateLatePay = db.prepare("SELECT date(?,'-1 days') d").get(today).d;

  // A: оплата, що народилась РАЗОМ із витратою (paid=1 при створенні) —
  // має переїхати разом із правкою дати витрати.
  r = await api("/api/finance/expenses", { method: "POST", body: JSON.stringify({ date: today, amount: 1000, category_id: opex, note: "__T4 дата", paid: 1 }) });
  ok(r.s === 200 && r.b.id, "витрата для перевірки переносу дати створена, оплачена одразу");
  const e5 = r.b.id;
  const e5PayBefore = db.prepare("SELECT id,date FROM expense_payments WHERE expense_id=?").get(e5);
  ok(e5PayBefore && e5PayBefore.date === today, "оплата створення записана на дату витрати (" + (e5PayBefore && e5PayBefore.date) + ")");

  r = await api("/api/finance/expenses/" + e5, { method: "PUT", body: JSON.stringify({ amount: 1000, date: dateNew }) });
  ok(r.s === 200, "дату витрати змінено (" + r.s + ")");
  const e5Row = db.prepare("SELECT date FROM expenses WHERE id=?").get(e5);
  ok(e5Row.date === dateNew, "дата витрати оновлена (" + e5Row.date + ")");
  const e5PayAfter = db.prepare("SELECT date FROM expense_payments WHERE id=?").get(e5PayBefore.id);
  ok(e5PayAfter.date === dateNew, "оплата, народжена разом із витратою, переїхала на нову дату (" + e5PayAfter.date + ")");
  const e5CashAfter = db.prepare("SELECT date FROM cash_moves WHERE ref_type='expense' AND ref_id=?").get(e5);
  ok(e5CashAfter && e5CashAfter.date === dateNew, "рух каси цієї витрати теж переїхав на нову дату (" + (e5CashAfter && e5CashAfter.date) + ")");

  // B: пізня оплата боргу окремим, свідомо іншим днем (реальна дата виходу
  // грошей), і потім дата витрати знову міняється: ця оплата рухатись не
  // повинна. Витрата з A вище вже повністю "оплачена" самим paid=1 (боргу
  // для /pay нема), тож заводимо окрему витрату в борг.
  r = await api("/api/finance/expenses", { method: "POST", body: JSON.stringify({ date: dateNew, amount: 500, category_id: opex, note: "__T4 дата2", paid: 0 }) });
  ok(r.s === 200 && r.b.id, "друга витрата для сценарію B створена, в борг");
  const e6 = r.b.id;
  const latePay = await api("/api/finance/expenses/" + e6 + "/pay", { method: "POST", body: JSON.stringify({ amount: 500, date: dateLatePay }) });
  ok(latePay.s === 200, "пізня оплата боргу проведена окремою датою (" + dateLatePay + ")");
  const e6PayRow = db.prepare("SELECT id,date FROM expense_payments WHERE expense_id=?").get(e6);
  ok(e6PayRow && e6PayRow.date === dateLatePay, "пізня оплата справді записана на свою дату, не на дату витрати (" + (e6PayRow && e6PayRow.date) + ")");

  const dateNew2 = db.prepare("SELECT date(?,'-9 days') d").get(today).d;
  r = await api("/api/finance/expenses/" + e6, { method: "PUT", body: JSON.stringify({ amount: 500, date: dateNew2 }) });
  ok(r.s === 200, "дату другої витрати змінено ще раз (" + r.s + ")");
  const e6PayAfter = db.prepare("SELECT date FROM expense_payments WHERE id=?").get(e6PayRow.id);
  ok(e6PayAfter.date === dateLatePay, "окрема пізніша оплата НЕ зрушила дату — вона реальна дата виходу грошей з рахунку (" + e6PayAfter.date + ")");
  const e6CashAfter = db.prepare("SELECT date FROM cash_moves WHERE ref_type='expense_payment' AND ref_id=?").get(e6PayRow.id);
  ok(e6CashAfter && e6CashAfter.date === dateLatePay, "рух каси пізньої оплати теж лишився на своїй даті (" + (e6CashAfter && e6CashAfter.date) + ")");

  db.prepare("DELETE FROM cash_moves WHERE ref_type='expense' AND ref_id IN (?,?)").run(e5, e6);
  db.prepare("DELETE FROM cash_moves WHERE ref_type='expense_payment' AND ref_id IN (SELECT id FROM expense_payments WHERE expense_id IN (?,?))").run(e5, e6);
  db.prepare("DELETE FROM expense_payments WHERE expense_id IN (?,?)").run(e5, e6);
  db.prepare("DELETE FROM expenses WHERE id IN (?,?)").run(e5, e6);

  // C (головна діра, звідси й фікс): дата витрати й дата ОКРЕМОЇ оплати
  // боргу ЗБІГАЮТЬСЯ — власник саме так і працює: записав борг сьогодні, того
  // ж дня переказав частину. Старий код рухав будь-яку оплату, датовану так
  // само, як стара дата витрати, тож ловив і цю окрему оплату боргу разом із
  // авто-оплатою. Відтворення точно за описом ревʼю: витрата створена з
  // paid=1 (авто-оплата на всю початкову суму), потім сумою PUT піднято вище
  // за вже оплачене (утворився борг), і борг у той самий день закритий через
  // окремий POST /pay — обидві оплати датовані today. Після цього дата
  // витрати правиться — рухатись має ЛИШЕ авто-оплата ─────────────────────
  r = await api("/api/finance/expenses", { method: "POST", body: JSON.stringify({ date: today, amount: 1500, category_id: opex, note: "__T4 дата3", paid: 1 }) });
  ok(r.s === 200 && r.b.id, "витрата сценарію C створена, оплачена одразу на 1500 (" + JSON.stringify(r.b) + ")");
  const e7 = r.b.id;
  const e7AutoPay = db.prepare("SELECT id,date,amount FROM expense_payments WHERE expense_id=?").get(e7);
  ok(e7AutoPay && e7AutoPay.date === today && e7AutoPay.amount === 1500, "авто-оплата створення записана на дату витрати, на всю суму (" + JSON.stringify(e7AutoPay) + ")");

  r = await api("/api/finance/expenses/" + e7, { method: "PUT", body: JSON.stringify({ amount: 2000, date: today }) });
  ok(r.s === 200, "суму витрати піднято до 2000 — утворився борг 500, дата поки та сама (" + r.s + ")");

  const e7Pay = await api("/api/finance/expenses/" + e7 + "/pay", { method: "POST", body: JSON.stringify({ amount: 500, date: today }) });
  ok(e7Pay.s === 200, "борг 500 закрито окремою оплатою в ТОЙ САМИЙ день, що й дата витрати (" + JSON.stringify(e7Pay.b) + ")");
  const e7ManualPay = db.prepare("SELECT id,date FROM expense_payments WHERE expense_id=? AND id!=?").get(e7, e7AutoPay.id);
  ok(e7ManualPay && e7ManualPay.date === today, "окрема оплата боргу справді датована today, як і авто-оплата — умова бага виконана (" + (e7ManualPay && e7ManualPay.date) + ")");

  const dateNew3 = db.prepare("SELECT date(?,'-7 days') d").get(today).d;
  const e7Edit = await api("/api/finance/expenses/" + e7, { method: "PUT", body: JSON.stringify({ amount: 2000, date: dateNew3 }) });
  ok(e7Edit.s === 200, "дату витрати сценарію C змінено (" + e7Edit.s + ")");

  const e7AutoAfter = db.prepare("SELECT date FROM expense_payments WHERE id=?").get(e7AutoPay.id);
  ok(e7AutoAfter.date === dateNew3, "авто-оплата (народжена разом із витратою) переїхала на нову дату (" + e7AutoAfter.date + ")");
  const e7AutoCashAfter = db.prepare("SELECT date FROM cash_moves WHERE ref_type='expense' AND ref_id=?").get(e7);
  ok(e7AutoCashAfter && e7AutoCashAfter.date === dateNew3, "рух каси авто-оплати теж переїхав (" + (e7AutoCashAfter && e7AutoCashAfter.date) + ")");

  const e7ManualAfter = db.prepare("SELECT date FROM expense_payments WHERE id=?").get(e7ManualPay.id);
  ok(e7ManualAfter.date === today, "ОКРЕМА оплата боргу НЕ зрушила дату, попри те що вона збігалась зі старою датою витрати — це і є дірка, яку фіксимо (" + e7ManualAfter.date + ")");
  const e7ManualCashAfter = db.prepare("SELECT date FROM cash_moves WHERE ref_type='expense_payment' AND ref_id=?").get(e7ManualPay.id);
  ok(e7ManualCashAfter && e7ManualCashAfter.date === today, "рух каси окремої оплати боргу так само лишився на today, реальній даті виходу грошей (" + (e7ManualCashAfter && e7ManualCashAfter.date) + ")");

  db.prepare("DELETE FROM cash_moves WHERE ref_type='expense' AND ref_id=?").run(e7);
  db.prepare("DELETE FROM cash_moves WHERE ref_type='expense_payment' AND ref_id IN (SELECT id FROM expense_payments WHERE expense_id=?)").run(e7);
  db.prepare("DELETE FROM expense_payments WHERE expense_id=?").run(e7);
  db.prepare("DELETE FROM expenses WHERE id=?").run(e7);

  // прибираємо все, що встиг створити POST/PUT для e3 — включно з рухом каси,
  // який лишився б сиротою при прямому DELETE рядків із бази в обхід ендпоінта.
  // Спершу саму витрату (вона зараз посилається на ws2Id), потім тимчасові
  // цехи — інакше FOREIGN KEY не дасть видалити цех, поки на нього ще є посилання.
  db.prepare("DELETE FROM cash_moves WHERE ref_type='expense' AND ref_id=?").run(e3);
  db.prepare("DELETE FROM expense_payments WHERE expense_id=?").run(e3);
  db.prepare("DELETE FROM expenses WHERE id=?").run(e3);
  db.prepare("DELETE FROM workshops WHERE id=?").run(ws2Id);
  if (tmpWorkshopId) db.prepare("DELETE FROM workshops WHERE id=?").run(tmpWorkshopId);
  if (!cats.find(c => c.kind === "sewing")) db.prepare("DELETE FROM fin_categories WHERE id=?").run(sewCat.id);

  // видалення прибирає і рух каси
  r = await api("/api/finance/expenses/" + e1, { method: "DELETE" });
  ok(r.s === 200 && db.prepare("SELECT COUNT(*) c FROM cash_moves WHERE ref_type='expense' AND ref_id=?").get(e1).c === 0, "видалення прибрало рух каси");

  // прибираємо рухи каси за зв'язком із витратами/оплатами, а не за текстом
  // нотатки: рух від часткової оплати боргу (note="Оплата боргу", без
  // префікса __T4) інакше лишився б сиротою в cash_moves назавжди
  db.prepare("DELETE FROM cash_moves WHERE ref_type='expense' AND ref_id IN (?,?,?)").run(e1, e2, e4);
  db.prepare("DELETE FROM cash_moves WHERE ref_type='expense_payment' AND ref_id IN (SELECT id FROM expense_payments WHERE expense_id IN (?,?,?))").run(e1, e2, e4);
  db.prepare("DELETE FROM expense_payments WHERE expense_id IN (?,?,?)").run(e1, e2, e4);
  db.prepare("DELETE FROM expenses WHERE id IN (?,?,?)").run(e1, e2, e4);
  db.prepare("DELETE FROM suppliers WHERE id=?").run(sup);
})();

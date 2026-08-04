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

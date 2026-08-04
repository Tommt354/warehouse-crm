const { api, ok, login } = require("./_helpers");
// Пряма робота з базою потрібна тому, що ендпоінта створення витрат ще
// немає (він у наступній задачі) — рядки в expenses/expense_payments
// вставляємо напряму, так само як це роблять tests/finance/02-categories.js.
const db = require("../../node_modules/better-sqlite3")(process.env.DB_PATH || "/tmp/fin-test.db");

(async () => {
  await login("admin");

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

  db.prepare("DELETE FROM suppliers WHERE id=?").run(id);

  // Формула боргу (SUPPLIER_DEBT_SQL) — найризикованіша частина: сума витрат
  // мінус сума оплат, порахована двома незалежними підзапитами. Якщо хтось
  // спростить її до одного JOIN(expenses+expense_payments)+SUM(amount), при
  // кількох оплатах по одній витраті рядок expenses задублюється JOIN'ом і
  // SUM(amount) порахує його стільки разів, скільки в нього оплат — борг
  // вийде завищеним. Сценарій нижче ловить саме це: постачальник з двома
  // витратами (1000 і 500), і в першої — дві часткові оплати (300+300),
  // у другої — одна повна (500). Правильний борг: (1000+500)-(300+300+500)=400.
  r = await api("/api/finance/suppliers", { method: "POST", body: JSON.stringify({ name: "__TestПостачБорг", note: "" }) });
  ok(r.s === 200 && r.b.id, "постачальник для перевірки боргу створений");
  const debtSupplierId = r.b.id;

  const exp1 = db.prepare("INSERT INTO expenses(date,amount,supplier_id) VALUES (?,?,?)")
    .run("2026-08-01", 1000, debtSupplierId).lastInsertRowid;
  const exp2 = db.prepare("INSERT INTO expenses(date,amount,supplier_id) VALUES (?,?,?)")
    .run("2026-08-02", 500, debtSupplierId).lastInsertRowid;

  // Проміжний стан: витрати вже висять, оплат ще нема — борг має дорівнювати
  // повній сумі витрат (1500), а не 0 і не подвоєному значенню.
  r = await api("/api/finance/suppliers");
  let ds = r.b.suppliers.find(s => s.id === debtSupplierId);
  ok(ds && ds.debt === 1500, "борг до оплат = сума витрат (1500), отримано " + (ds && ds.debt));

  const pay1 = db.prepare("INSERT INTO expense_payments(expense_id,date,amount) VALUES (?,?,?)")
    .run(exp1, "2026-08-01", 300).lastInsertRowid;
  const pay2 = db.prepare("INSERT INTO expense_payments(expense_id,date,amount) VALUES (?,?,?)")
    .run(exp1, "2026-08-02", 300).lastInsertRowid;
  const pay3 = db.prepare("INSERT INTO expense_payments(expense_id,date,amount) VALUES (?,?,?)")
    .run(exp2, "2026-08-03", 500).lastInsertRowid;

  r = await api("/api/finance/suppliers");
  ds = r.b.suppliers.find(s => s.id === debtSupplierId);
  ok(ds && ds.debt === 400, "борг після кількох часткових оплат = 400 (без подвоєння), отримано " + (ds && ds.debt));

  db.prepare("DELETE FROM expense_payments WHERE id IN (?,?,?)").run(pay1, pay2, pay3);
  db.prepare("DELETE FROM expenses WHERE id IN (?,?)").run(exp1, exp2);
  db.prepare("DELETE FROM suppliers WHERE id=?").run(debtSupplierId);

  await login("packer");
  r = await api("/api/finance/suppliers");
  ok(r.s === 403, "не-адміну закрито (" + r.s + ")");
})();

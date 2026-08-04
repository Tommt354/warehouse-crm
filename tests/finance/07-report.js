const { api, ok, login } = require("./_helpers");
const db = require("../../node_modules/better-sqlite3")(process.env.DB_PATH || "/tmp/fin-test.db");
const round2 = v => Math.round((v || 0) * 100) / 100;
const today = new Date().toISOString().slice(0, 10);

// Тестова база — копія живої (crm.db), тож на "сьогодні" вже можуть бути
// справжні рухи каси й витрати з реальної роботи складу. Щоб перевірка не
// залежала від того, порожній день чи ні, беремо звіт "до" фікстур і
// звіряємо різницю "після мінус до" з очікуваним внеском фікстур, а не
// абсолютні числа.
(async () => {
  await login("admin");
  db.prepare("DELETE FROM cash_moves WHERE note LIKE '__T7%'").run();
  db.prepare("DELETE FROM expenses WHERE note LIKE '__T7%'").run();
  db.prepare("DELETE FROM manager_rates WHERE name='__T7 Діана'").run();
  db.prepare("DELETE FROM cash_checks WHERE note='__T7'").run();

  await api("/api/finance/settings", { method: "PUT", body: JSON.stringify({ cash_opening_balance: 10000, cash_opening_date: today }) });

  const cats = (await api("/api/finance/categories")).b.categories;
  const opex = cats.find(c => !c.is_goods);
  const goods = cats.find(c => c.is_goods);

  const r0 = (await api("/api/finance/report?from=" + today + "&to=" + today)).b;

  await api("/api/finance/expenses", { method: "POST", body: JSON.stringify({ date: today, amount: 2000, category_id: opex.id, note: "__T7 оренда", paid: 1 }) });
  await api("/api/finance/expenses", { method: "POST", body: JSON.stringify({ date: today, amount: 5000, category_id: goods.id, note: "__T7 тканина", paid: 1 }) });
  await api("/api/finance/expenses", { method: "POST", body: JSON.stringify({ date: today, amount: 3000, category_id: goods.id, note: "__T7 борг", paid: 0 }) });
  db.prepare("INSERT INTO cash_moves(date,amount,kind,ref_type,note)VALUES(?,?,?,?,?)").run(today, 9000, "income", "", "__T7 дохід");

  const r1res = await api("/api/finance/report?from=" + today + "&to=" + today);
  const r1 = r1res.b;
  ok(r1res.s === 200, "звіт віддається");
  ok(round2(r1.income - r0.income) === 9000, "надходження +9000 (" + round2(r1.income - r0.income) + ")");
  ok(round2(r1.expenses_paid - r0.expenses_paid) === 7000, "оплачені витрати +7000 (" + round2(r1.expenses_paid - r0.expenses_paid) + ")");
  ok(round2(r1.cash_delta - r0.cash_delta) === 2000, "рух каси +2000 (" + round2(r1.cash_delta - r0.cash_delta) + ")");
  ok(round2(r1.opex_spent - r0.opex_spent) === 2000 && round2(r1.goods_spent - r0.goods_spent) === 8000,
    "розподіл витрата/товар: +" + round2(r1.opex_spent - r0.opex_spent) + " / +" + round2(r1.goods_spent - r0.goods_spent));
  ok(round2(r1.debts_total - r0.debts_total) === 3000, "борг періоду +3000 (" + round2(r1.debts_total - r0.debts_total) + ")");
  ok(round2(r1.balance - r0.balance) === 2000, "розрахунковий залишок зріс на 2000 (" + round2(r1.balance - r0.balance) + ")");

  const catBefore = (r0.by_category.find(c => c.name === goods.name) || { amount: 0 }).amount;
  const catAfter = (r1.by_category.find(c => c.name === goods.name) || { amount: 0 }).amount;
  ok(round2(catAfter - catBefore) === 8000, "по категорії «" + goods.name + "» +8000 (" + round2(catAfter - catBefore) + ")");

  // менеджер: відсоток від прибутку за формулою власника (дохід мінус усі
  // витрати періоду). Перевіряємо саму формулу й реакцію на зміну прибутку,
  // а не абсолютні числа — прибуток періоду вже може містити реальні дані.
  await api("/api/finance/manager-rate", { method: "POST", body: JSON.stringify({ name: "__T7 Діана", percent: 7, from_date: "2000-01-01" }) });
  const r3 = (await api("/api/finance/report?from=" + today + "&to=" + today)).b;
  ok(round2(r3.profit_cash) === round2(r1.income - r1.opex_spent - r1.goods_spent), "прибуток = дохід − витрати періоду (" + r3.profit_cash + ")");
  ok(r3.manager && r3.manager.percent === 7 && round2(r3.manager.amount) === round2(r3.profit_cash * 7 / 100),
    "менеджер рахується від прибутку: " + JSON.stringify(r3.manager));
  ok(round2(r3.profit_after_manager) === round2(r3.profit_cash - r3.manager.amount), "прибуток після менеджера = прибуток − сума менеджера (" + r3.profit_after_manager + ")");

  db.prepare("INSERT INTO cash_moves(date,amount,kind,ref_type,note)VALUES(?,?,?,?,?)").run(today, 1000, "income", "", "__T7 ще дохід");
  const r4 = (await api("/api/finance/report?from=" + today + "&to=" + today)).b;
  ok(round2(r4.profit_cash - r3.profit_cash) === 1000, "додатковий дохід 1000 підняв прибуток на 1000 (" + round2(r4.profit_cash - r3.profit_cash) + ")");
  ok(round2(r4.manager.amount - r3.manager.amount) === 70, "менеджеру додатково 70 (7% від 1000) (" + round2(r4.manager.amount - r3.manager.amount) + ")");
  ok(round2(r4.profit_after_manager) === round2(r4.profit_cash - r4.manager.amount), "прибуток після менеджера перерахувався (" + r4.profit_after_manager + ")");
  db.prepare("DELETE FROM manager_rates WHERE name='__T7 Діана'").run();

  // звірка з банком: беремо поточний розрахунковий залишок і задаємо
  // фактичний рівно на 500 менше, щоб розбіжність не залежала від того,
  // скільки насправді на рахунку
  const calcNow = (await api("/api/finance/report?from=" + today + "&to=" + today)).b.balance;
  const ch = await api("/api/finance/cash-check", { method: "POST", body: JSON.stringify({ actual_balance: round2(calcNow - 500), note: "__T7" }) });
  ok(ch.s === 200 && round2(ch.b.diff) === -500, "звірка показала розбіжність −500 (" + ch.b.diff + ")");
  const r2 = (await api("/api/finance/report?from=" + today + "&to=" + today)).b;
  ok(r2.last_check && round2(r2.last_check.diff) === -500, "остання звірка видно у звіті");

  db.prepare("DELETE FROM cash_moves WHERE note LIKE '__T7%'").run();
  db.prepare("DELETE FROM expense_payments WHERE expense_id IN (SELECT id FROM expenses WHERE note LIKE '__T7%')").run();
  db.prepare("DELETE FROM cash_moves WHERE ref_type='expense' AND ref_id IN (SELECT id FROM expenses WHERE note LIKE '__T7%')").run();
  db.prepare("DELETE FROM expenses WHERE note LIKE '__T7%'").run();
  db.prepare("DELETE FROM cash_checks WHERE note='__T7'").run();
})();

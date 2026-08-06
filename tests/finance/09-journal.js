// GET /api/finance/journal — повний журнал операцій каси для звірки з банком.
// Головне, що тут не можна зламати: наростаючий підсумок рахується від
// cash_opening_date (а не від "from" періоду), тож останній хронологічний
// рух у журналі має точно збігатись із "Має бути на рахунку" зі
// GET /api/finance/report. Борг (витрата, взята без оплати) має бути видно
// в журналі, але не рухати цей підсумок — перевіряємо це і напряму (рядок
// боргу без balance_after), і опосередковано (баланс звіту зрушив рівно на
// суму РЕАЛЬНИХ рухів каси, а не на суму боргу).
const { api, ok, login } = require("./_helpers");
const db = require("../../node_modules/better-sqlite3")(process.env.DB_PATH || "/tmp/fin-test.db");
const round2 = v => Math.round((v || 0) * 100) / 100;
const today = db.prepare("SELECT date('now','localtime') d").get().d;
const yesterday = db.prepare("SELECT date(?,'-1 day') d").get(today).d;

// Той самий підхід прибирання, що й у 07-report.js: рухи каси, прив'язані до
// оплат боргу, видаляємо ДО видалення самих expense_payments.
function cleanupT9() {
  db.prepare("DELETE FROM cash_moves WHERE note LIKE '__T9%'").run();
  db.prepare(`DELETE FROM cash_moves WHERE ref_type='expense_payment' AND ref_id IN
    (SELECT id FROM expense_payments WHERE expense_id IN (SELECT id FROM expenses WHERE note LIKE '__T9%'))`).run();
  db.prepare(`DELETE FROM cash_moves WHERE ref_type='expense' AND ref_id IN
    (SELECT id FROM expenses WHERE note LIKE '__T9%')`).run();
  db.prepare("DELETE FROM expense_payments WHERE expense_id IN (SELECT id FROM expenses WHERE note LIKE '__T9%')").run();
  db.prepare("DELETE FROM expenses WHERE note LIKE '__T9%'").run();
}

(async () => {
  await login("admin");
  cleanupT9();

  // Стартовий залишок — глобальна настройка (той самий "since", від якого
  // журнал рахує наростаючий підсумок). Зберігаємо сирий стан у БД напряму
  // (а не через GET /api/finance/settings): на щойно ініціалізованій копії
  // рядків узагалі може не бути, і те саме "не було рядка" — стан, який
  // потрібно відновити наприкінці, а не "порожній рядок", якого PUT все
  // одно не приймає як "скинути дату". Ставимо дату старту задовго до
  // "вчора" фікстури D нижче — інакше вчорашній рух випав би з журналу за
  // тим самим правилом, за яким calcBalance ігнорує все до дати старту, і
  // перевірка "розширення періоду показує вчорашнє" ламалась би не через
  // баг журналу, а через це самісіньке (коректне) правило.
  const prevBalanceRow = db.prepare("SELECT value FROM settings WHERE key='cash_opening_balance'").get();
  const prevDateRow = db.prepare("SELECT value FROM settings WHERE key='cash_opening_date'").get();
  await api("/api/finance/settings", { method: "PUT", body: JSON.stringify({ cash_opening_balance: prevBalanceRow ? parseFloat(prevBalanceRow.value) || 0 : 0, cash_opening_date: "2000-01-01" }) });

  const cats = (await api("/api/finance/categories")).b.categories;
  const anyCat = cats[0];
  ok(!!anyCat, "є хоч одна категорія витрат для фікстур");

  const r0 = (await api("/api/finance/report?from=" + today + "&to=" + today)).b;

  // a) Витрата, оплачена одразу — реальний рух каси, journal_kind='expense'.
  const aRes = await api("/api/finance/expenses", { method: "POST", body: JSON.stringify({
    date: today, amount: 321, category_id: anyCat.id, note: "__T9 оренда", paid: 1
  }) });
  ok(aRes.s === 200, "витрата A створена й оплачена (" + JSON.stringify(aRes.b) + ")");

  // b) Витрата "в борг" — paid=0, грошей ще не пішло. Не повинна породжувати
  // рух каси взагалі (finance.js: born cash move з'являється лише при paid=1).
  const bRes = await api("/api/finance/expenses", { method: "POST", body: JSON.stringify({
    date: today, amount: 654, category_id: anyCat.id, note: "__T9 борг тканина", paid: 0
  }) });
  ok(bRes.s === 200, "витрата B (борг) створена (" + JSON.stringify(bRes.b) + ")");
  const bId = bRes.b.id;
  const bornMove = db.prepare("SELECT id FROM cash_moves WHERE ref_type='expense' AND ref_id=?").get(bId);
  ok(!bornMove, "у витрати-борга B немає власного руху каси одразу при створенні — саме ця відсутність і відрізняє борг від оплаченої витрати");

  // c) Часткова оплата боргу B — це вже РЕАЛЬНИЙ рух каси, journal_kind='expense_payment'.
  const payRes = await api("/api/finance/expenses/" + bId + "/pay", { method: "POST", body: JSON.stringify({ amount: 111 }) });
  ok(payRes.s === 200, "часткова оплата боргу B проведена (" + JSON.stringify(payRes.b) + ")");

  // d) Витрата, оплачена ВЧОРА — поза періодом "сьогодні", але має входити
  // в наростаючий підсумок (since=cash_opening_date, а не from).
  const dRes = await api("/api/finance/expenses", { method: "POST", body: JSON.stringify({
    date: yesterday, amount: 222, category_id: anyCat.id, note: "__T9 вчора", paid: 1
  }) });
  ok(dRes.s === 200, "витрата D (вчора) створена й оплачена (" + JSON.stringify(dRes.b) + ")");

  const j1 = (await api("/api/finance/journal?from=" + today + "&to=" + today)).b;
  const r1 = (await api("/api/finance/report?to=" + today)).b;

  // ── журнал містить операції періоду ─────────────────────────────────────
  const rowA = j1.rows.find(r => r.note === "__T9 оренда");
  ok(!!rowA, "рядок витрати A видно в журналі за сьогодні");
  ok(rowA && rowA.is_cash === true, "A — реальний рух каси (is_cash=true)");
  ok(rowA && typeof rowA.balance_after === "number", "у A є числовий залишок після (" + (rowA && rowA.balance_after) + ")");
  ok(rowA && rowA.amount === -321, "сума A від'ємна, -321 (" + (rowA && rowA.amount) + ")");

  const rowB = j1.rows.find(r => r.note === "__T9 борг тканина");
  ok(!!rowB, "борговий рядок B видно в журналі");
  ok(rowB && rowB.is_cash === false, "B позначено як рух, що НЕ рухає гроші (is_cash=false)");
  ok(rowB && rowB.balance_after === null, "у B немає власного залишку після — борг не рахунок (" + (rowB && rowB.balance_after) + ")");
  ok(rowB && rowB.journal_kind === "expense_debt", "тип B — 'expense_debt' (" + (rowB && rowB.journal_kind) + ")");
  ok(rowB && rowB.kind_label && rowB.kind_label !== "expense", "у B людська назва типу, а не сирий код 'expense' (" + (rowB && rowB.kind_label) + ")");

  const rowC = j1.rows.find(r => r.journal_kind === "expense_payment" && r.source && r.source.indexOf("__T9 борг тканина") !== -1);
  ok(!!rowC, "рядок оплати боргу C видно в журналі й пов'язаний із витратою B через джерело");
  ok(rowC && rowC.is_cash === true, "C — реальний рух каси");
  ok(rowC && rowC.amount === -111, "сума C від'ємна, -111 (" + (rowC && rowC.amount) + ")");

  // Витрата, оплачена ВЧОРА (D), не має потрапити у список за сьогодні.
  const rowD = j1.rows.find(r => r.note === "__T9 вчора");
  ok(!rowD, "вчорашня витрата D не потрапила в журнал за період 'сьогодні' — журнал не містить чужого");

  // При розширенні періоду D з'являється.
  const jWide = (await api("/api/finance/journal?from=" + yesterday + "&to=" + today)).b;
  ok(!!jWide.rows.find(r => r.note === "__T9 вчора"), "при розширенні періоду на вчора D з'являється в журналі");

  // ── наростаючий підсумок ────────────────────────────────────────────────
  // Головна властивість моделі: останній (найновіший) реальний рух журналу
  // за весь час має ТОЧНО дорівнювати "Має бути на рахунку" зі звіту.
  const topCashRow = j1.rows.find(r => r.is_cash);
  ok(!!topCashRow, "у журналі за сьогодні є хоч один реальний рух каси");
  ok(topCashRow && round2(topCashRow.balance_after) === round2(j1.summary.balance_end),
    "залишок після найновішого реального рядка дорівнює 'залишку на кінець' у підсумку журналу (" + (topCashRow && topCashRow.balance_after) + " = " + j1.summary.balance_end + ")");
  ok(round2(j1.summary.balance_end) === round2(r1.balance),
    "'залишок на кінець' журналу точно дорівнює 'Має бути на рахунку' зі звіту за той самий кінець періоду (" + j1.summary.balance_end + " = " + r1.balance + ")");

  // Борг (B, 654₴) НЕ рухає підсумок: баланс звіту зрушив рівно на суму
  // РЕАЛЬНИХ рухів — A (-321), C (-111) і D (-222, вчорашня, але теж
  // оплачена одразу) — разом -654, що збігається лише тому, що borg-B узагалі
  // не дав внеску: якби він рахувався як реальний рух, зсув був би -1308
  // (-654-654). Це незалежна від журналу перевірка — calcBalance() узагалі
  // не бачить таблицю expenses, лише cash_moves.
  ok(round2(r1.balance - r0.balance) === -654,
    "залишок зрушив лише на реальні рухи A+C+D (-321-111-222=-654), борг у 654 в баланс не потрапив (" + round2(r1.balance - r0.balance) + ")");

  // ── підсумки прийшло/пішло за період збігаються із сумами рядків ───────
  const cashRowsInPeriod = j1.rows.filter(r => r.is_cash);
  const expectedIncome = round2(cashRowsInPeriod.filter(r => r.amount > 0).reduce((s, r) => s + r.amount, 0));
  const expectedOutcome = round2(cashRowsInPeriod.filter(r => r.amount < 0).reduce((s, r) => s - r.amount, 0));
  ok(round2(j1.summary.income) === expectedIncome, "підсумок 'прийшло' дорівнює сумі додатних рядків (" + j1.summary.income + " = " + expectedIncome + ")");
  ok(round2(j1.summary.outcome) === expectedOutcome, "підсумок 'пішло' дорівнює сумі від'ємних рядків (" + j1.summary.outcome + " = " + expectedOutcome + ")");
  ok(round2(j1.summary.net) === round2(expectedIncome - expectedOutcome), "чиста різниця = прийшло − пішло (" + j1.summary.net + ")");

  // ── фільтр за типом працює ──────────────────────────────────────────────
  const jf = (await api("/api/finance/journal?from=" + today + "&to=" + today + "&kind=expense_payment")).b;
  ok(jf.rows.length > 0, "фільтр за kind=expense_payment повертає хоч один рядок");
  ok(jf.rows.every(r => r.journal_kind === "expense_payment"), "усі рядки фільтрованого журналу мають саме цей тип");
  ok(!jf.rows.find(r => r.note === "__T9 оренда"), "звичайна витрата A не проходить фільтр 'оплата боргу'");
  ok(!!jf.rows.find(r => r.journal_kind === "expense_payment" && r.source && r.source.indexOf("__T9 борг тканина") !== -1),
    "оплата боргу C проходить фільтр 'оплата боргу'");

  cleanupT9();

  // Відновлюємо настройки старту каси рівно в той стан, у якому вони були
  // до тесту — включно з "рядка взагалі не було", якщо так і було.
  if (prevBalanceRow) db.prepare("INSERT OR REPLACE INTO settings(key,value)VALUES('cash_opening_balance',?)").run(prevBalanceRow.value);
  else db.prepare("DELETE FROM settings WHERE key='cash_opening_balance'").run();
  if (prevDateRow) db.prepare("INSERT OR REPLACE INTO settings(key,value)VALUES('cash_opening_date',?)").run(prevDateRow.value);
  else db.prepare("DELETE FROM settings WHERE key='cash_opening_date'").run();
})();

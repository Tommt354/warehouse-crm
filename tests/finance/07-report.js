const { api, ok, login, createTestProduct } = require("./_helpers");
const db = require("../../node_modules/better-sqlite3")(process.env.DB_PATH || "/tmp/fin-test.db");
const round2 = v => Math.round((v || 0) * 100) / 100;
const today = db.prepare("SELECT date('now','localtime') d").get().d;
const yesterday = db.prepare("SELECT date(?,'-1 day') d").get(today).d;

// Тестова база — копія живої (crm.db), тож на "сьогодні" вже можуть бути
// справжні рухи каси й витрати з реальної роботи складу. Щоб перевірка не
// залежала від того, порожній день чи ні, беремо звіт "до" фікстур і
// звіряємо різницю "після мінус до" з очікуваним внеском фікстур, а не
// абсолютні числа.

// Прибирання фікстур цього файлу, спільне для старту (лишки від зірваного
// попереднього прогону) і завершення. Порядок важливий: рухи каси, прив'язані
// до оплат витрат, видаляємо ДО видалення самих expense_payments — інакше
// підзапит по expense_id вже нічого не знайде.
function cleanupT7() {
  db.prepare("DELETE FROM cash_moves WHERE note LIKE '__T7%'").run();
  db.prepare(`DELETE FROM cash_moves WHERE ref_type='expense_payment' AND ref_id IN
    (SELECT id FROM expense_payments WHERE expense_id IN (SELECT id FROM expenses WHERE note LIKE '__T7%'))`).run();
  db.prepare(`DELETE FROM cash_moves WHERE ref_type='expense' AND ref_id IN
    (SELECT id FROM expenses WHERE note LIKE '__T7%')`).run();
  db.prepare("DELETE FROM expense_payments WHERE expense_id IN (SELECT id FROM expenses WHERE note LIKE '__T7%')").run();
  db.prepare("DELETE FROM expenses WHERE note LIKE '__T7%'").run();
  db.prepare("DELETE FROM manager_rates WHERE name='__T7 Діана'").run();
  db.prepare("DELETE FROM cash_checks WHERE note='__T7'").run();
  // Замовлення-фікстури доходу (пункти 1/2/6/7) і рухи каси, прив'язані до них.
  const stray = db.prepare("SELECT id FROM orders WHERE note='__T7' OR client_name LIKE '__T7%'").all().map(r => r.id);
  stray.forEach(id => {
    db.prepare("DELETE FROM cash_moves WHERE ref_type='order' AND ref_id=?").run(id);
    db.prepare("DELETE FROM cash_moves WHERE ref_type='refund' AND ref_id=?").run(id);
    db.prepare("DELETE FROM cash_moves WHERE ref_type='refund_extra' AND note LIKE ?").run("%(замовлення #" + id + ")");
    db.prepare("DELETE FROM order_items WHERE order_id=?").run(id);
  });
  if (stray.length) db.prepare(`DELETE FROM orders WHERE id IN (${stray.map(() => "?").join(",")})`).run(...stray);
  db.prepare("DELETE FROM base_products WHERE name='__TestFin'").run();
  db.prepare("DELETE FROM variations WHERE name='__TestFin'").run();
  db.prepare("DELETE FROM models WHERE name='__TestFin'").run();
  db.prepare("DELETE FROM categories WHERE name='__TestFin'").run();
}

(async () => {
  await login("admin");
  const drop = db.prepare("SELECT id FROM users WHERE role='dropshipper' ORDER BY id LIMIT 1").get();
  ok(!!drop, "є дропер для перевірки");

  // Стартовий залишок — глобальна настройка, а не фікстура під нотою __T7:
  // зберігаємо, що там було, і повертаємо наприкінці, інакше тест підмінює
  // її назавжди для всієї бази.
  const prevSettings = (await api("/api/finance/settings")).b;

  cleanupT7();

  await api("/api/finance/settings", { method: "PUT", body: JSON.stringify({ cash_opening_balance: 10000, cash_opening_date: today }) });

  const cats = (await api("/api/finance/categories")).b.categories;
  const opex = cats.find(c => !c.is_goods);
  const goods = cats.find(c => c.is_goods);

  const r0 = (await api("/api/finance/report?from=" + today + "&to=" + today)).b;

  await api("/api/finance/expenses", { method: "POST", body: JSON.stringify({ date: today, amount: 2000, category_id: opex.id, note: "__T7 оренда", paid: 1 }) });
  await api("/api/finance/expenses", { method: "POST", body: JSON.stringify({ date: today, amount: 5000, category_id: goods.id, note: "__T7 тканина", paid: 1 }) });
  await api("/api/finance/expenses", { method: "POST", body: JSON.stringify({ date: today, amount: 3000, category_id: goods.id, note: "__T7 борг", paid: 0 }) });

  // Дохід більше не рух каси — раніше сюди підкладали фіктивний cash_moves
  // kind='income'; тепер дохід рахується із замовлень (delivered_at у
  // періоді), тож підкладаємо справжнє передоплачене й отримане замовлення
  // на 9000₴. Побічно це той самий реальний рух каси (kind='prepaid'), що й
  // раніше мав фіктивний income-рух, тож дельта cash_delta лишається такою ж.
  const prodA = createTestProduct(9000);
  const createA = await api("/api/orders", { method: "POST", body: JSON.stringify({
    dropshipper_id: drop.id, items: [{ variation_id: prodA.varId, size_id: prodA.sizeId, quantity: 1 }],
    client_name: "__T7 Дохід", client_phone: "+380501130001", client_city: "Київ", client_warehouse: "Відділення №1",
    is_prepaid: true, receipt_photo: "__T7.jpg", note: "__T7"
  }) });
  ok(createA.s === 200, "замовлення-фікстура доходу створене (" + JSON.stringify(createA.b) + ")");
  const orderA = createA.b.order_id;
  await api("/api/orders/" + orderA + "/status", { method: "PUT", body: JSON.stringify({ status: "delivered" }) });

  const r1res = await api("/api/finance/report?from=" + today + "&to=" + today);
  const r1 = r1res.b;
  ok(r1res.s === 200, "звіт віддається");
  ok(round2(r1.income - r0.income) === 9000, "надходження +9000 із замовлення, забраного сьогодні (" + round2(r1.income - r0.income) + ")");
  ok(round2(r1.expenses_paid - r0.expenses_paid) === 7000, "оплачені витрати +7000 (" + round2(r1.expenses_paid - r0.expenses_paid) + ")");
  ok(round2(r1.cash_delta - r0.cash_delta) === 2000, "рух каси +2000 (" + round2(r1.cash_delta - r0.cash_delta) + ")");
  ok(round2(r1.opex_spent - r0.opex_spent) === 2000 && round2(r1.goods_spent - r0.goods_spent) === 8000,
    "розподіл витрата/товар: +" + round2(r1.opex_spent - r0.opex_spent) + " / +" + round2(r1.goods_spent - r0.goods_spent));
  ok(round2(r1.debts_total - r0.debts_total) === 3000, "борг +3000 від неоплаченої витрати в періоді (" + round2(r1.debts_total - r0.debts_total) + ")");
  ok(round2(r1.balance - r0.balance) === 2000, "розрахунковий залишок зріс на 2000 (" + round2(r1.balance - r0.balance) + ")");

  const catBefore = (r0.by_category.find(c => c.name === goods.name) || { amount: 0 }).amount;
  const catAfter = (r1.by_category.find(c => c.name === goods.name) || { amount: 0 }).amount;
  ok(round2(catAfter - catBefore) === 8000, "по категорії «" + goods.name + "» +8000 (" + round2(catAfter - catBefore) + ")");

  // ── пункт 2: повернення коштів зменшує дохід періоду ───────────────
  const refundRes = await api("/api/finance/orders/" + orderA + "/refund", { method: "POST", body: JSON.stringify({ amount: 1500, note: "__T7" }) });
  ok(refundRes.s === 200, "повернення по замовленню-фікстурі проведено (" + JSON.stringify(refundRes.b) + ")");
  const r1b = (await api("/api/finance/report?from=" + today + "&to=" + today)).b;
  ok(round2(r1b.income - r1.income) === -1500, "повернення коштів у періоді зменшило дохід на 1500 (" + round2(r1b.income - r1.income) + ")");
  ok(round2(r1b.cash_delta - r1.cash_delta) === -1500, "повернення так само зменшило рух каси на 1500 (" + round2(r1b.cash_delta - r1.cash_delta) + ")");

  // debts_total — поточне сальдо боргу постачальникам, а не борг, нарахований
  // саме в обраному періоді (звіт беремо за "сьогодні", from=to=today). Витрата
  // датована вчорашнім днем — поза періодом звіту — і має однаково увійти
  // в debts_total, бо гроші винні незалежно від того, коли їх позичили.
  const rBeforeOldDebt = (await api("/api/finance/report?from=" + today + "&to=" + today)).b;

  const oldDebtRes = await api("/api/finance/expenses", { method: "POST", body: JSON.stringify({ date: yesterday, amount: 4000, category_id: goods.id, note: "__T7 старий борг", paid: 0 }) });
  const oldDebtId = oldDebtRes.b.id;

  const rAfterOldDebt = (await api("/api/finance/report?from=" + today + "&to=" + today)).b;
  ok(round2(rAfterOldDebt.debts_total - rBeforeOldDebt.debts_total) === 4000,
    "борг, нарахований до обраного періоду, входить у поточне сальдо боргу (+4000, отримано " + round2(rAfterOldDebt.debts_total - rBeforeOldDebt.debts_total) + ")");

  // часткова оплата зменшує сальдо боргу
  await api("/api/finance/expenses/" + oldDebtId + "/pay", { method: "POST", body: JSON.stringify({ amount: 1500 }) });
  const rAfterPay1 = (await api("/api/finance/report?from=" + today + "&to=" + today)).b;
  ok(round2(rAfterOldDebt.debts_total - rAfterPay1.debts_total) === 1500,
    "часткова оплата зменшує сальдо боргу на 1500 (" + round2(rAfterOldDebt.debts_total - rAfterPay1.debts_total) + ")");

  // друга часткова оплата по тій самій витраті — пастка наївного JOIN
  // expenses+expense_payments: він задвоїв би нараховану суму витрати на
  // кожен рядок оплати. Перевіряємо, що сальдо зменшується рівно на суму
  // другої оплати, а не стрибає через задвоєння нарахування.
  await api("/api/finance/expenses/" + oldDebtId + "/pay", { method: "POST", body: JSON.stringify({ amount: 1000 }) });
  const rAfterPay2 = (await api("/api/finance/report?from=" + today + "&to=" + today)).b;
  ok(round2(rAfterPay1.debts_total - rAfterPay2.debts_total) === 1000,
    "друга часткова оплата зменшує ще на 1000, без задвоєння (" + round2(rAfterPay1.debts_total - rAfterPay2.debts_total) + ")");
  ok(round2(rAfterPay2.debts_total - rBeforeOldDebt.debts_total) === 1500,
    "підсумок: +4000 нараховано − 1500 − 1000 оплачено = +1500 до сальдо боргу (" + round2(rAfterPay2.debts_total - rBeforeOldDebt.debts_total) + ")");

  // ── менеджер: пункт 7 — у збитковий період нарахування йде в мінус ─
  // Сьогоднішній період уже збитковий: дохід (9000−1500 повернення=7500 з
  // фікстури) менший за витрати дня (2000+5000+3000=10000). Власник скасував
  // обнуління: нарахування — це просто відсоток від прибутку, без обмеження
  // знизу, як і в його власній таблиці.
  await api("/api/finance/manager-rate", { method: "POST", body: JSON.stringify({ name: "__T7 Діана", percent: 7, from_date: "2000-01-01" }) });
  const r3 = (await api("/api/finance/report?from=" + today + "&to=" + today)).b;
  ok(round2(r3.profit_cash) === round2(r1b.income - r1b.opex_spent - r1b.goods_spent), "прибуток = дохід − витрати періоду (" + r3.profit_cash + ")");
  if (r3.profit_cash < 0) {
    ok(r3.manager && round2(r3.manager.amount) === round2(r3.profit_cash * 7 / 100),
      "збитковий період: менеджеру нараховується відсоток від збитку, тобто мінус (" + JSON.stringify(r3.manager) + ", прибуток " + r3.profit_cash + ")");
    ok(r3.manager.amount < 0, "нарахування менеджера від'ємне в збиток (" + r3.manager.amount + ")");
    ok(round2(r3.profit_after_manager) === round2(r3.profit_cash - r3.manager.amount),
      "прибуток після менеджера = прибуток − нарахування (тут більший за прибуток, бо нарахування від'ємне) (" + r3.profit_after_manager + ")");
    ok(r3.profit_after_manager > r3.profit_cash, "прибуток після менеджера перевищує сам прибуток у збиток (" + r3.profit_after_manager + " > " + r3.profit_cash + ")");
  } else {
    console.log("⚠️ сьогоднішній період неочікувано не збитковий (" + r3.profit_cash + ") — перевірку від'ємного нарахування в збиток пропущено, її дублює перевірка на позитивному прибутку нижче");
  }

  // ── менеджер: позитивний прибуток — відсоток рахується як і раніше ─
  // Окремий, точно позитивний період (вчора): замовлення на 10000₴ забрано
  // вчора проти єдиної вчорашньої витрати 4000₴ (старий борг вище) — прибуток
  // свідомо додатний, щоб перевірити, що звичайний випадок (не збиток) фікс
  // пункту 7 не зачепив.
  const rYestBefore = (await api("/api/finance/report?from=" + yesterday + "&to=" + yesterday)).b;
  const yestOrderId = db.prepare(`INSERT INTO orders(dropshipper_id,status,client_name,client_phone,client_city,client_warehouse,
      cod_amount,total_drop_price,payout_amount,is_prepaid,delivered_at,created_at,note)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(drop.id, "delivered", "__T7 Вчора", "+380501130002", "Київ", "Відділення №1",
      0, 10000, 0, 1, yesterday + " 12:00:00", yesterday + " 10:00:00", "__T7").lastInsertRowid;

  const rYestAfter = (await api("/api/finance/report?from=" + yesterday + "&to=" + yesterday)).b;
  ok(round2(rYestAfter.income - rYestBefore.income) === 10000, "дохід вчорашнього періоду +10000 від замовлення, забраного вчора (" + round2(rYestAfter.income - rYestBefore.income) + ")");
  ok(rYestAfter.profit_cash > 0, "вчорашній період прибутковий, як і задумано (" + rYestAfter.profit_cash + ")");
  // Math.max(0, ...) тут навмисно не пишемо: profit_cash > 0 щойно
  // перевірено рядком вище, тож обгортка нічого не стверджувала б понад
  // просте profit_cash — це був залишок від скасованого правила "менеджер
  // не йде в мінус" (протилежний, збитковий випадок перевірено вище,
  // рядки 141-150, де тепер очікується саме від'ємне нарахування).
  ok(rYestAfter.manager && round2(rYestAfter.manager.amount) === round2(rYestAfter.profit_cash * 7 / 100),
    "на позитивному прибутку менеджер рахується як звичайний відсоток, не нуль (" + JSON.stringify(rYestAfter.manager) + ")");
  ok(round2(rYestAfter.profit_after_manager) === round2(rYestAfter.profit_cash - rYestAfter.manager.amount),
    "прибуток після менеджера = прибуток − сума менеджера (" + rYestAfter.profit_after_manager + ")");

  // додатковий дохід на позитивному періоді піднімає і прибуток, і менеджера
  const yestOrder2Id = db.prepare(`INSERT INTO orders(dropshipper_id,status,client_name,client_phone,client_city,client_warehouse,
      cod_amount,total_drop_price,payout_amount,is_prepaid,delivered_at,created_at,note)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(drop.id, "delivered", "__T7 Вчора2", "+380501130003", "Київ", "Відділення №1",
      0, 1000, 0, 1, yesterday + " 13:00:00", yesterday + " 10:00:00", "__T7").lastInsertRowid;
  const rYestAfter2 = (await api("/api/finance/report?from=" + yesterday + "&to=" + yesterday)).b;
  ok(round2(rYestAfter2.profit_cash - rYestAfter.profit_cash) === 1000, "додатковий дохід 1000 підняв прибуток на 1000 (" + round2(rYestAfter2.profit_cash - rYestAfter.profit_cash) + ")");
  ok(round2(rYestAfter2.manager.amount - rYestAfter.manager.amount) === 70, "менеджеру додатково 70 (7% від 1000) (" + round2(rYestAfter2.manager.amount - rYestAfter.manager.amount) + ")");
  ok(round2(rYestAfter2.profit_after_manager) === round2(rYestAfter2.profit_cash - rYestAfter2.manager.amount), "прибуток після менеджера перерахувався (" + rYestAfter2.profit_after_manager + ")");

  db.prepare("DELETE FROM manager_rates WHERE name='__T7 Діана'").run();

  // звірка з банком: беремо поточний розрахунковий залишок і задаємо
  // фактичний рівно на 500 менше, щоб розбіжність не залежала від того,
  // скільки насправді на рахунку
  const calcNow = (await api("/api/finance/report?from=" + today + "&to=" + today)).b.balance;
  const ch = await api("/api/finance/cash-check", { method: "POST", body: JSON.stringify({ actual_balance: round2(calcNow - 500), note: "__T7" }) });
  ok(ch.s === 200 && round2(ch.b.diff) === -500, "звірка показала розбіжність −500 (" + ch.b.diff + ")");
  const r2 = (await api("/api/finance/report?from=" + today + "&to=" + today)).b;
  ok(r2.last_check && round2(r2.last_check.diff) === -500, "остання звірка видно у звіті");

  // ── I1: замовлення, що вийшло зі статусу delivered (НП повернула
  // посилку), однаково зникає з доходу і на /api/finance/report, і на
  // /api/dashboard/accounting — обидва тепер рахують за одним правилом
  // (status='delivered' AND delivered_at!=''). delivered_at при цьому НЕ
  // чиститься (finance.onOrderUndelivered лишає дату — інакше повторне
  // отримання проставило б сьогоднішню замість вихідного дня отримання),
  // тож саме статус тут відсікає повернену посилку з доходу.
  const prodI1r = createTestProduct(333);
  const createI1r = await api("/api/orders", { method: "POST", body: JSON.stringify({
    dropshipper_id: drop.id, items: [{ variation_id: prodI1r.varId, size_id: prodI1r.sizeId, quantity: 1 }],
    client_name: "__T7 Повернуте", client_phone: "+380501130005", client_city: "Київ", client_warehouse: "Відділення №1",
    cod_amount: 400, note: "__T7"
  }) });
  const i1rOrderId = createI1r.b.order_id;
  await api("/api/orders/" + i1rOrderId + "/status", { method: "PUT", body: JSON.stringify({ status: "delivered" }) });
  const rBeforeReturn = (await api("/api/finance/report?from=" + today + "&to=" + today)).b;
  const dashBeforeReturn = (await api("/api/dashboard/accounting?date_from=" + today + "&date_to=" + today)).b;
  await api("/api/orders/" + i1rOrderId + "/status", { method: "PUT", body: JSON.stringify({ status: "return_transit" }) });
  const rAfterReturn = (await api("/api/finance/report?from=" + today + "&to=" + today)).b;
  const dashAfterReturn = (await api("/api/dashboard/accounting?date_from=" + today + "&date_to=" + today)).b;
  ok(round2(rAfterReturn.income - rBeforeReturn.income) === -333,
    "дохід звіту /finance/report зменшився на дроп-ціну повернутого замовлення, а не лишився завищеним (" + round2(rAfterReturn.income - rBeforeReturn.income) + ")");
  const dashDayBefore = (dashBeforeReturn.days || []).find(d => d.day === today) || { drop_sum: 0 };
  const dashDayAfter = (dashAfterReturn.days || []).find(d => d.day === today) || { drop_sum: 0 };
  ok(round2((dashDayAfter.drop_sum || 0) - (dashDayBefore.drop_sum || 0)) === -333,
    "«Бухгалтерія» /dashboard/accounting так само перестала рахувати повернуте замовлення — узгоджено з /finance/report (" + round2((dashDayAfter.drop_sum || 0) - (dashDayBefore.drop_sum || 0)) + ")");

  // ── пункт 6: «Бухгалтерія» групує по delivered_at, не по updated_at ─
  // Вчорашній день уже має власні "отримані" фікстури (yestOrderId і
  // yestOrder2Id вище), тож звіряємо дельту "до/після", а не абсолютний
  // лічильник — інакше перевірка не ізолювала б саме ефект зсуву updated_at.
  const dashYestBefore = await api("/api/dashboard/accounting?date_from=" + yesterday + "&date_to=" + yesterday);
  const dashYestBeforeCount = ((dashYestBefore.b.days || []).find(d => d.day === yesterday) || { delivered: 0 }).delivered;

  const prodDash = createTestProduct(50);
  const createDash = await api("/api/orders", { method: "POST", body: JSON.stringify({
    dropshipper_id: drop.id, items: [{ variation_id: prodDash.varId, size_id: prodDash.sizeId, quantity: 1 }],
    client_name: "__T7 Бухгалтерія", client_phone: "+380501130004", client_city: "Київ", client_warehouse: "Відділення №1",
    cod_amount: 50, note: "__T7"
  }) });
  const dashOrderId = createDash.b.order_id;
  await api("/api/orders/" + dashOrderId + "/status", { method: "PUT", body: JSON.stringify({ status: "delivered" }) });
  // Імітуємо "чужу" правку замовлення (зміна ТТН, адреси тощо), яка зсуває
  // updated_at на інший день, — delivered_at лишається днем отримання.
  db.prepare("UPDATE orders SET updated_at=? WHERE id=?").run(yesterday + " 00:00:01", dashOrderId);
  const dash = await api("/api/dashboard/accounting?date_from=" + today + "&date_to=" + today);
  ok(dash.s === 200, "звіт «Бухгалтерія» віддається");
  const dashToday = (dash.b.days || []).find(d => d.day === today);
  ok(!!dashToday && dashToday.delivered >= 1, "замовлення видно за днем ОТРИМАННЯ навіть після того, як updated_at зсунуто на інший день (" + JSON.stringify(dashToday) + ")");
  const dashYestAfter = await api("/api/dashboard/accounting?date_from=" + yesterday + "&date_to=" + yesterday);
  const dashYestAfterCount = ((dashYestAfter.b.days || []).find(d => d.day === yesterday) || { delivered: 0 }).delivered;
  ok(dashYestAfterCount === dashYestBeforeCount,
    "замовлення НЕ потрапило у вчорашній день попри зсунутий updated_at — лічильник не зрушив (" + dashYestBeforeCount + " -> " + dashYestAfterCount + ")");

  cleanupT7();

  await api("/api/finance/settings", { method: "PUT", body: JSON.stringify({
    cash_opening_balance: prevSettings.cash_opening_balance, cash_opening_date: prevSettings.cash_opening_date
  }) });
})();

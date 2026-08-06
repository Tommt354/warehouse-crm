// GET /api/finance/delivered — розшифровка плитки «Надходження»: список
// замовлень, забраних (delivered) у періоді, з тим самим правилом добору, що
// й у GET /api/finance/report (status='delivered' AND delivered_at!='' AND
// date(delivered_at) у діапазоні). Перевіряємо: список містить саме забрані
// в цьому періоді замовлення, не містить забраних поза ним і не забраних
// узагалі, а сума дроп-цін у підсумку узгоджена зі звітом з поправкою на
// повернення коштів.
const { api, ok, login } = require("./_helpers");
const db = require("../../node_modules/better-sqlite3")(process.env.DB_PATH || "/tmp/fin-test.db");
// Фікстури тут заводяться прямим INSERT в orders (status='delivered' одразу),
// в обхід реального API — тож finance.onOrderDelivered ніколи не
// спрацьовує сам, і рух каси за наложкою не з'являється. Стеля повернення
// коштів (пункт 1 фіксу) тепер рахується саме з рухів каси, а не з
// cod_amount напряму, тож для фікстур, які тестують повернення, рух каси
// треба дописати вручну тим самим хелпером, яким його пише реальний потік.
const finance = require("../../finance");
const round2 = v => Math.round((v || 0) * 100) / 100;
const today = db.prepare("SELECT date('now','localtime') d").get().d;
const yesterday = db.prepare("SELECT date(?,'-1 day') d").get(today).d;

// Тестова база — копія живої, тож на "сьогодні" вже можуть бути справжні
// забрані замовлення. Тому звіряємо різницю "після мінус до" фікстур, а не
// абсолютні числа (той самий підхід, що й 07-report.js).

function cleanupT8() {
  const stray = db.prepare("SELECT id FROM orders WHERE note='__T8'").all().map(r => r.id);
  stray.forEach(id => {
    db.prepare("DELETE FROM cash_moves WHERE ref_type='order' AND ref_id=?").run(id);
    db.prepare("DELETE FROM cash_moves WHERE ref_type='refund' AND ref_id=?").run(id);
    db.prepare("DELETE FROM cash_moves WHERE ref_type='refund_extra' AND note LIKE ?").run("%(замовлення #" + id + ")");
    db.prepare("DELETE FROM order_items WHERE order_id=?").run(id);
  });
  if (stray.length) db.prepare(`DELETE FROM orders WHERE id IN (${stray.map(() => "?").join(",")})`).run(...stray);
}

function insertOrder({ status, cod, drop, prepaid, deliveredAt, createdAt, ttn }) {
  return db.prepare(`INSERT INTO orders(dropshipper_id,status,client_name,client_phone,client_city,client_warehouse,
      cod_amount,total_drop_price,payout_amount,is_prepaid,delivered_at,created_at,note,ttn)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(drop.id, status, "__T8 Клієнт", "+380501140099", "Київ", "Відділення №1",
      cod, drop.price, 0, prepaid ? 1 : 0, deliveredAt || "", createdAt || (today + " 09:00:00"), "__T8", ttn || "").lastInsertRowid;
}

(async () => {
  await login("admin");
  const dropRow = db.prepare("SELECT id FROM users WHERE role='dropshipper' ORDER BY id LIMIT 1").get();
  ok(!!dropRow, "є дропер для перевірки");

  cleanupT8();

  const d0 = (await api("/api/finance/delivered?from=" + today + "&to=" + today)).b;
  const r0 = (await api("/api/finance/report?from=" + today + "&to=" + today)).b;

  // Замовлення D: забране сьогодні, у періоді. Наложка (не передоплата),
  // щоб окремо перевірити суму наложок.
  const dId = insertOrder({ status: "delivered", cod: 1000, drop: { id: dropRow.id, price: 1000 },
    prepaid: false, deliveredAt: today + " 12:00:00", ttn: "__T8TTN1" });
  finance.onOrderDelivered(dId); // прямий INSERT не тригерить хук — дописуємо рух каси наложки вручну

  // Замовлення G: теж сьогодні, але пізніше за D — перевірка сортування
  // "найновіші зверху".
  const gId = insertOrder({ status: "delivered", cod: 200, drop: { id: dropRow.id, price: 200 },
    prepaid: false, deliveredAt: today + " 15:00:00", ttn: "__T8TTN2" });
  finance.onOrderDelivered(gId);

  const d1 = (await api("/api/finance/delivered?from=" + today + "&to=" + today)).b;
  ok(round2(d1.drop_price_sum - d0.drop_price_sum) === 1200, "сума дроп-цін +1200 (1000+200) після двох забраних сьогодні (" + round2(d1.drop_price_sum - d0.drop_price_sum) + ")");
  ok(round2(d1.cod_sum - d0.cod_sum) === 1200, "сума наложок +1200 (" + round2(d1.cod_sum - d0.cod_sum) + ")");
  ok(d1.count - d0.count === 2, "кількість посилок +2 (" + (d1.count - d0.count) + ")");
  ok(!!d1.orders.find(o => o.id === dId), "замовлення D видно у списку забраних сьогодні");
  ok(!!d1.orders.find(o => o.id === gId), "замовлення G видно у списку забраних сьогодні");
  const idxD = d1.orders.findIndex(o => o.id === dId), idxG = d1.orders.findIndex(o => o.id === gId);
  ok(idxG < idxD, "G (забрано пізніше того самого дня) стоїть вище за D — найновіші зверху (" + idxG + " < " + idxD + ")");

  const r1 = (await api("/api/finance/report?from=" + today + "&to=" + today)).b;
  ok(round2(r1.income - r0.income) === 1200, "дохід звіту теж +1200, без повернень (" + round2(r1.income - r0.income) + ")");
  ok(round2((d1.drop_price_sum - d0.drop_price_sum)) === round2(r1.income - r0.income),
    "без повернень сума дроп-цін у списку точно дорівнює приросту доходу звіту (" + round2(d1.drop_price_sum - d0.drop_price_sum) + " = " + round2(r1.income - r0.income) + ")");

  // Замовлення E: забране ВЧОРА — поза періодом "сьогодні". Не має потрапити
  // у список за сьогодні, але має з'явитись, якщо розширити період.
  const eId = insertOrder({ status: "delivered", cod: 500, drop: { id: dropRow.id, price: 500 },
    prepaid: false, deliveredAt: yesterday + " 12:00:00", createdAt: yesterday + " 10:00:00" });

  // Замовлення F: створене сьогодні, але НЕ забране взагалі (лишається new).
  const fId = insertOrder({ status: "new", cod: 300, drop: { id: dropRow.id, price: 300 }, prepaid: false });

  const d2 = (await api("/api/finance/delivered?from=" + today + "&to=" + today)).b;
  ok(round2(d2.drop_price_sum - d0.drop_price_sum) === 1200, "список за сьогодні не змінився від вчорашнього E і не забраного F (" + round2(d2.drop_price_sum - d0.drop_price_sum) + ")");
  ok(!d2.orders.find(o => o.id === eId), "вчорашнє замовлення E НЕ потрапило у список за сьогодні");
  ok(!d2.orders.find(o => o.id === fId), "не забране взагалі замовлення F НЕ потрапило у список");

  const dWide = (await api("/api/finance/delivered?from=" + yesterday + "&to=" + today)).b;
  ok(!!dWide.orders.find(o => o.id === eId), "при розширенні періоду на вчора E з'являється у списку");
  ok(!dWide.orders.find(o => o.id === fId), "F так і не з'являється у жодному періоді — воно не забране взагалі");

  // Повернення коштів по D у цьому періоді: сума дроп-цін лишається
  // незмінною (D і так забране), а income_check і дохід звіту мають однаково
  // зменшитись на суму повернення.
  const refundRes = await api("/api/finance/orders/" + dId + "/refund", { method: "POST", body: JSON.stringify({ amount: 300, note: "__T8" }) });
  ok(refundRes.s === 200, "повернення по D проведено (" + JSON.stringify(refundRes.b) + ")");

  const d3 = (await api("/api/finance/delivered?from=" + today + "&to=" + today)).b;
  const r3 = (await api("/api/finance/report?from=" + today + "&to=" + today)).b;
  const orderDRow = d3.orders.find(o => o.id === dId);
  ok(!!orderDRow && round2(orderDRow.refunded_amount) === 300, "по замовленню D видно повернені 300₴ (" + (orderDRow && orderDRow.refunded_amount) + ")");
  ok(round2(d3.drop_price_sum - d0.drop_price_sum) === 1200, "сума дроп-цін не змінюється від повернення — посилка й так забрана (" + round2(d3.drop_price_sum - d0.drop_price_sum) + ")");
  ok(round2(r3.income - r0.income) === 900, "дохід звіту зменшився на суму повернення: +1200-300=900 (" + round2(r3.income - r0.income) + ")");

  // Головна перевірка задачі: сума дроп-цін із поправкою на повернення
  // (income_check) точно дорівнює income звіту за той самий період.
  ok(round2((d3.income_check - d0.income_check)) === round2(r3.income - r0.income),
    "income_check списку (з поправкою на повернення) дорівнює приросту income звіту (" + round2(d3.income_check - d0.income_check) + " = " + round2(r3.income - r0.income) + ")");
  ok(round2(d3.income_check) === round2(d3.drop_price_sum + d3.refunds_in_period),
    "income_check = сума дроп-цін + повернення періоду (" + d3.income_check + " = " + d3.drop_price_sum + " + " + d3.refunds_in_period + ")");

  cleanupT8();
})();

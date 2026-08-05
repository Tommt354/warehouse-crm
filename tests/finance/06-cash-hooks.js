const { api, ok, login, createTestProduct, removeTestProduct } = require("./_helpers");
const db = require("../../node_modules/better-sqlite3")(process.env.DB_PATH || "/tmp/fin-test.db");
const round2 = v => Math.round((v || 0) * 100) / 100;

(async () => {
  await login("admin");
  const drop = db.prepare("SELECT id FROM users WHERE role='dropshipper' ORDER BY id LIMIT 1").get();
  ok(!!drop, "є дропер для перевірки");

  // Власна фікстура замовлення з великою дроп-ціною (1000₴), а не випадкове
  // "останнє замовлення з бази": стеля повернення (пункт 4) прив'язана до
  // total_drop_price, і сума старих перевірок (250+50+77=377) вимагає
  // достатнього запасу — на випадковому замовленні з дроп-ціною 200₴ вони
  // впали б самі через нову стелю.
  const prod = createTestProduct(1000);
  const created = await api("/api/orders", { method: "POST", body: JSON.stringify({
    dropshipper_id: drop.id, items: [{ variation_id: prod.varId, size_id: prod.sizeId, quantity: 1 }],
    client_name: "__T6 Клієнт", client_phone: "+380501120001", client_city: "Київ", client_warehouse: "Відділення №1",
    cod_amount: 1300, note: "__T6"
  }) });
  ok(created.s === 200, "фікстура замовлення для повернень створена (" + JSON.stringify(created.b) + ")");
  const o = { id: created.b.order_id, total_drop_price: created.b.total_drop };
  ok(o.total_drop_price === 1000, "дроп-ціна фікстури 1000 (" + o.total_drop_price + ")");

  // повернення коштів клієнту
  let r = await api("/api/finance/orders/" + o.id + "/refund", { method: "POST", body: JSON.stringify({ amount: 250, note: "__T6" }) });
  ok(r.s === 200, "повернення коштів проведено");
  const mv = db.prepare("SELECT * FROM cash_moves WHERE ref_type='refund' AND ref_id=?").get(o.id);
  ok(mv && mv.amount === -250, "у касі мінус 250 (" + (mv && mv.amount) + ")");
  ok(db.prepare("SELECT refunded_amount r FROM orders WHERE id=?").get(o.id).r === 250, "сума повернення записана в замовлення");

  // друге часткове повернення того ж замовлення не має загубитись через
  // унікальний індекс по ref_id — для нього хелпер пише ref_type='refund_extra'
  r = await api("/api/finance/orders/" + o.id + "/refund", { method: "POST", body: JSON.stringify({ amount: 50, note: "__T6" }) });
  ok(r.s === 200, "друге часткове повернення проведено");
  const mv2 = db.prepare("SELECT * FROM cash_moves WHERE ref_type='refund_extra' AND note LIKE '__T6%' ORDER BY id DESC LIMIT 1").get();
  ok(mv2 && mv2.amount === -50, "друге часткове повернення лягло в касу окремим рухом (" + (mv2 && mv2.amount) + ")");
  ok(db.prepare("SELECT refunded_amount r FROM orders WHERE id=?").get(o.id).r === 300, "сума другого повернення додалась до замовлення (" + db.prepare("SELECT refunded_amount r FROM orders WHERE id=?").get(o.id).r + ")");

  r = await api("/api/finance/orders/" + o.id + "/refund", { method: "POST", body: JSON.stringify({ amount: -5 }) });
  ok(r.s === 400, "від'ємна сума відхилена");

  // випадковий повтор того самого запиту (подвійний клік/ретрай мережі):
  // той самий виклик (сума 50), зроблений одразу після легітимного,
  // не повинен ще раз рухати касу й нараховувати повернення
  const orderTag = "(замовлення #" + o.id + ")";
  const movesBefore = db.prepare("SELECT COUNT(*) c FROM cash_moves WHERE kind='refund' AND note LIKE ?").get("%" + orderTag).c;
  const refundedBefore = db.prepare("SELECT refunded_amount r FROM orders WHERE id=?").get(o.id).r;
  r = await api("/api/finance/orders/" + o.id + "/refund", { method: "POST", body: JSON.stringify({ amount: 50, note: "__T6" }) });
  ok(r.s === 409, "повтор того самого повернення (50) одразу відхилений з 409 (" + r.s + ")");
  const movesAfterDup = db.prepare("SELECT COUNT(*) c FROM cash_moves WHERE kind='refund' AND note LIKE ?").get("%" + orderTag).c;
  ok(movesAfterDup === movesBefore, "відхилений повтор не додав рух каси (" + movesBefore + " -> " + movesAfterDup + ")");
  const refundedAfterDup = db.prepare("SELECT refunded_amount r FROM orders WHERE id=?").get(o.id).r;
  ok(refundedAfterDup === refundedBefore, "відхилений повтор не змінив refunded_amount (" + refundedBefore + " -> " + refundedAfterDup + ")");

  // легітимне повернення на іншу суму одразу після — має пройти нормально,
  // захист від дублю не має чіпати повернення з іншою сумою
  r = await api("/api/finance/orders/" + o.id + "/refund", { method: "POST", body: JSON.stringify({ amount: 77, note: "__T6" }) });
  ok(r.s === 200, "повернення на іншу суму (77) одразу після проходить нормально (" + r.s + ")");
  const mv3 = db.prepare("SELECT * FROM cash_moves WHERE kind='refund' AND amount=-77 AND note LIKE ? ORDER BY id DESC LIMIT 1").get("%" + orderTag);
  ok(mv3 && mv3.amount === -77, "рух на іншу суму лягла в касу (" + (mv3 && mv3.amount) + ")");
  ok(db.prepare("SELECT refunded_amount r FROM orders WHERE id=?").get(o.id).r === 377, "сума третього повернення додалась до замовлення (" + db.prepare("SELECT refunded_amount r FROM orders WHERE id=?").get(o.id).r + ")");

  // ── стеля повернення (пункт 4): не можна повернути більше, ніж
  // total_drop_price мінус уже повернене ─────────────────────────
  const remaining = round2(o.total_drop_price - 377); // 623
  r = await api("/api/finance/orders/" + o.id + "/refund", { method: "POST", body: JSON.stringify({ amount: remaining + 77, note: "__T6" }) });
  ok(r.s === 400, "повернення понад залишок (" + (remaining + 77) + " з доступних " + remaining + ") відхилене (" + r.s + ")");
  ok(db.prepare("SELECT refunded_amount r FROM orders WHERE id=?").get(o.id).r === 377, "відхилене повернення не змінило refunded_amount");

  r = await api("/api/finance/orders/" + o.id + "/refund", { method: "POST", body: JSON.stringify({ amount: remaining, note: "__T6 залишок" }) });
  ok(r.s === 200, "повернення рівно залишку (" + remaining + ") проходить (" + r.s + ")");
  ok(db.prepare("SELECT refunded_amount r FROM orders WHERE id=?").get(o.id).r === o.total_drop_price,
    "замовлення повернене повністю (" + db.prepare("SELECT refunded_amount r FROM orders WHERE id=?").get(o.id).r + " = " + o.total_drop_price + ")");

  r = await api("/api/finance/orders/" + o.id + "/refund", { method: "POST", body: JSON.stringify({ amount: 1, note: "__T6 зайве" }) });
  ok(r.s === 400, "повернення, коли залишку вже нема (0₴), відхилене (" + r.s + ")");

  // ── виплата дроперу (пункт 3): total_amount + balance_applied ─────
  // Власна фікстура: POST /api/payouts/:id/paid перескладає pending-запит
  // під реальний стан замовлень (syncPendingPayout) — випадковий "перший
  // невиплачений запит" міг просто не існувати (як і сталось у попередньому
  // прогоні, де перевірка мовчки пропустилась), тож будуємо його свідомо.
  const prodPay = createTestProduct(200);
  const orderPay = await api("/api/orders", { method: "POST", body: JSON.stringify({
    dropshipper_id: drop.id, items: [{ variation_id: prodPay.varId, size_id: prodPay.sizeId, quantity: 1 }],
    client_name: "__T6 Клієнт2", client_phone: "+380501120002", client_city: "Київ", client_warehouse: "Відділення №1",
    cod_amount: 500, note: "__T6"
  }) });
  const payOrderId = orderPay.b.order_id;
  await api("/api/orders/" + payOrderId + "/status", { method: "PUT", body: JSON.stringify({ status: "delivered" }) });

  const reqRes = await api("/api/payouts/request", { method: "POST", body: JSON.stringify({ dropshipper_id: drop.id }) });
  ok(reqRes.s === 200 && reqRes.b.request_id, "запит на виплату сформовано (" + JSON.stringify(reqRes.b) + ")");
  const prId = reqRes.b.request_id;
  const prBefore = db.prepare("SELECT total_amount FROM payout_requests WHERE id=?").get(prId);
  ok(prBefore && prBefore.total_amount === 300, "сума запиту = payout_amount фікстури (500 наложка − 200 дроп-ціна = 300), отримано " + (prBefore && prBefore.total_amount));

  // Імітуємо залік балансу без побічних ефектів apply-balance (баланс
  // дропера, balance_transactions) — перевіряємо лише формулу onDropPayoutPaid.
  db.prepare("UPDATE payout_requests SET balance_applied=75 WHERE id=?").run(prId);
  r = await api("/api/payouts/" + prId + "/paid", { method: "PUT", body: JSON.stringify({}) });
  ok(r.s === 200, "виплату дроперу проведено");
  const pm = db.prepare("SELECT * FROM cash_moves WHERE ref_type='payout' AND ref_id=?").get(prId);
  ok(pm && pm.kind === "payout", "тип руху payout, не витрата");
  ok(pm && Math.abs(pm.amount + 375) < 0.01,
    "виплата в касі = total_amount(300) + balance_applied(75) = 375, мінусом (" + (pm && pm.amount) + ")");

  // ── виплата зарплати працівнику ────────────────────────────────
  const w = db.prepare("SELECT id,name FROM workers WHERE active=1 ORDER BY id LIMIT 1").get();
  if (w) {
    let earned = db.prepare("SELECT COALESCE(SUM(amount),0) s FROM worker_payroll WHERE worker_id=?").get(w.id).s;
    const paid = db.prepare("SELECT COALESCE(SUM(amount),0) s FROM worker_payouts WHERE worker_id=?").get(w.id).s;
    let fixtureId = null;
    if (earned - paid <= 0) {
      fixtureId = db.prepare("INSERT INTO worker_payroll(worker_id,amount,type,note)VALUES(?,?,?,?)").run(w.id, 77.5, "item", "__T6").lastInsertRowid;
      earned = db.prepare("SELECT COALESCE(SUM(amount),0) s FROM worker_payroll WHERE worker_id=?").get(w.id).s;
    }
    if (earned - paid > 0) {
      r = await api("/api/workers/" + w.id + "/pay", { method: "POST", body: JSON.stringify({}) });
      ok(r.s === 200, "виплату зарплати проведено");
      const wp = db.prepare("SELECT id FROM worker_payouts WHERE worker_id=? ORDER BY id DESC LIMIT 1").get(w.id);
      const sm = db.prepare("SELECT * FROM cash_moves WHERE ref_type='worker_payout' AND ref_id=?").get(wp.id);
      ok(sm && sm.amount === -round2(earned - paid), "зарплата лягла в касу мінусом (" + (sm && sm.amount) + ")");
      ok(sm && sm.kind === "salary", "тип руху salary, не витрата");
      db.prepare("DELETE FROM cash_moves WHERE ref_type='worker_payout' AND ref_id=?").run(wp.id);
      db.prepare("DELETE FROM worker_payouts WHERE id=?").run(wp.id);
    } else console.log("⚠️ працівнику нічого виплачувати — перевірку зарплати пропущено");
    if (fixtureId) db.prepare("DELETE FROM worker_payroll WHERE id=?").run(fixtureId);
  } else console.log("⚠️ немає активних працівників — перевірку зарплати пропущено");

  // ── видалення замовлення прибирає його рухи каси (пункт 5) ────────
  const prodDel = createTestProduct(400);
  const orderDel = await api("/api/orders", { method: "POST", body: JSON.stringify({
    dropshipper_id: drop.id, items: [{ variation_id: prodDel.varId, size_id: prodDel.sizeId, quantity: 1 }],
    client_name: "__T6 Клієнт3", client_phone: "+380501120003", client_city: "Київ", client_warehouse: "Відділення №1",
    cod_amount: 400, note: "__T6"
  }) });
  const delOrderId = orderDel.b.order_id;
  await api("/api/orders/" + delOrderId + "/status", { method: "PUT", body: JSON.stringify({ status: "delivered" }) });
  await api("/api/finance/orders/" + delOrderId + "/refund", { method: "POST", body: JSON.stringify({ amount: 100, note: "__T6" }) });
  const movesBeforeDelete = db.prepare("SELECT COUNT(*) c FROM cash_moves WHERE (ref_type='order' AND ref_id=?) OR (ref_type='refund' AND ref_id=?)").get(delOrderId, delOrderId).c;
  ok(movesBeforeDelete === 2, "фікстура має 2 рухи каси перед видаленням (cod + refund), отримано " + movesBeforeDelete);

  const delRes = await api("/api/orders/" + delOrderId, { method: "DELETE", body: JSON.stringify({ destination: "base" }) });
  ok(delRes.s === 200, "замовлення видалено (" + JSON.stringify(delRes.b) + ")");
  const movesAfterDelete = db.prepare("SELECT COUNT(*) c FROM cash_moves WHERE (ref_type='order' AND ref_id=?) OR (ref_type='refund' AND ref_id=?)").get(delOrderId, delOrderId).c;
  ok(movesAfterDelete === 0, "рухи каси видаленого замовлення прибрані, а не лишились сиротами (" + movesAfterDelete + ")");

  // ── прибирання фікстур ─────────────────────────────────────────
  db.prepare("DELETE FROM cash_moves WHERE ref_type='refund' AND ref_id=?").run(o.id);
  db.prepare("DELETE FROM cash_moves WHERE ref_type='refund_extra' AND note LIKE ?").run("%" + orderTag);
  db.prepare("DELETE FROM cash_moves WHERE ref_type='order' AND ref_id IN (?,?)").run(o.id, payOrderId);
  db.prepare("DELETE FROM cash_moves WHERE ref_type='payout' AND ref_id=?").run(prId);
  db.prepare("DELETE FROM payout_items WHERE payout_request_id=?").run(prId);
  db.prepare("DELETE FROM payout_requests WHERE id=?").run(prId);
  db.prepare("DELETE FROM order_items WHERE order_id IN (?,?)").run(o.id, payOrderId);
  db.prepare("DELETE FROM orders WHERE id IN (?,?)").run(o.id, payOrderId);
  [prod, prodPay, prodDel].forEach(removeTestProduct);
})();

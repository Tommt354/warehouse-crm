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

  // ── C1: правка суми ПІСЛЯ того, як каса вже записала прихід, не має
  // залишати рух на старій сумі й не має плодити другий рух. Перевіряємо
  // всі три місця, де сума замовлення міняється заднім числом: правку
  // наложки (edit), додавання позиції й заміну товару (обидва — на
  // передоплаченому замовленні, чий прихід каси вже записаний при
  // створенні) ──────────────────────────────────────────────────────

  // C1a: наложка доставленого замовлення
  const prodC1 = createTestProduct(300);
  const orderC1 = await api("/api/orders", { method: "POST", body: JSON.stringify({
    dropshipper_id: drop.id, items: [{ variation_id: prodC1.varId, size_id: prodC1.sizeId, quantity: 1 }],
    client_name: "__T6 Клієнт5", client_phone: "+380501120005", client_city: "Київ", client_warehouse: "Відділення №1",
    cod_amount: 500, note: "__T6"
  }) });
  const c1OrderId = orderC1.b.order_id;
  await api("/api/orders/" + c1OrderId + "/status", { method: "PUT", body: JSON.stringify({ status: "delivered" }) });
  const codMoveBefore = db.prepare("SELECT amount FROM cash_moves WHERE kind='cod' AND ref_type='order' AND ref_id=?").get(c1OrderId);
  ok(codMoveBefore && codMoveBefore.amount === 500, "рух каси за наложкою записаний на 500 (" + (codMoveBefore && codMoveBefore.amount) + ")");

  const editRes = await api("/api/orders/" + c1OrderId + "/edit", { method: "PUT", body: JSON.stringify({ cod_amount: 900 }) });
  ok(editRes.s === 200, "наложку відредаговано (" + JSON.stringify(editRes.b) + ")");
  const codMovesAfter = db.prepare("SELECT * FROM cash_moves WHERE kind='cod' AND ref_type='order' AND ref_id=?").all(c1OrderId);
  ok(codMovesAfter.length === 1, "рух каси за наложкою лишився один, а не задвоївся (" + codMovesAfter.length + ")");
  ok(codMovesAfter[0] && codMovesAfter[0].amount === 900, "рух каси приведений до нової наложки 900, замовлення 200 з наложки 500 у мінус не пішло (" + (codMovesAfter[0] && codMovesAfter[0].amount) + ")");
  // Прибираємо одразу, а не в загальному кліні наприкінці: замовлення
  // лишається в статусі delivered із ненульовим payout_amount, і якщо
  // дотягне до секції "виплата дроперу" нижче (той самий дропер), він
  // мовчки потрапить у чужий запит на виплату й зіпсує його суму.
  db.prepare("DELETE FROM cash_moves WHERE ref_type='order' AND ref_id=?").run(c1OrderId);
  db.prepare("DELETE FROM order_items WHERE order_id=?").run(c1OrderId);
  db.prepare("DELETE FROM orders WHERE id=?").run(c1OrderId);
  removeTestProduct(prodC1);

  // C1b: передоплачене замовлення, додавання позиції. POST
  // /api/orders/:id/items, на відміну від створення замовлення, вимагає
  // рядок stock_base для товару навіть на allow_negative-варіації.
  const prodC1b = createTestProduct(400);
  const prodC1bExtra = createTestProduct(150);
  db.prepare("INSERT INTO stock_base(base_product_id,size_id,quantity,quantity_actual)VALUES(?,?,100,100)").run(prodC1bExtra.bpId, prodC1bExtra.sizeId);
  const orderC1b = await api("/api/orders", { method: "POST", body: JSON.stringify({
    dropshipper_id: drop.id, items: [{ variation_id: prodC1b.varId, size_id: prodC1b.sizeId, quantity: 1 }],
    client_name: "__T6 Клієнт6", client_phone: "+380501120006", client_city: "Київ", client_warehouse: "Відділення №1",
    is_prepaid: true, receipt_photo: "__T6.jpg", note: "__T6"
  }) });
  const c1bOrderId = orderC1b.b.order_id;
  const prepaidBefore = db.prepare("SELECT amount FROM cash_moves WHERE kind='prepaid' AND ref_type='order' AND ref_id=?").get(c1bOrderId);
  ok(prepaidBefore && prepaidBefore.amount === 400, "передоплата записана на 400 (" + (prepaidBefore && prepaidBefore.amount) + ")");

  const addItemRes = await api("/api/orders/" + c1bOrderId + "/items", { method: "POST", body: JSON.stringify({ variation_id: prodC1bExtra.varId, size_id: prodC1bExtra.sizeId, quantity: 1 }) });
  ok(addItemRes.s === 200, "позицію додано (" + JSON.stringify(addItemRes.b) + ")");
  const prepaidMovesAfter = db.prepare("SELECT * FROM cash_moves WHERE kind='prepaid' AND ref_type='order' AND ref_id=?").all(c1bOrderId);
  ok(prepaidMovesAfter.length === 1, "рух каси передоплати лишився один (" + prepaidMovesAfter.length + ")");
  ok(prepaidMovesAfter[0] && prepaidMovesAfter[0].amount === 550, "рух каси приведений до нової суми 400+150=550 (" + (prepaidMovesAfter[0] && prepaidMovesAfter[0].amount) + ")");

  // C1c: передоплачене замовлення, заміна товару (swap-product вимагає
  // рядок stock_base для нового товару — навіть на allow_negative-товарі,
  // на відміну від створення замовлення)
  const prodC1cOld = createTestProduct(400);
  const prodC1cNew = createTestProduct(700);
  db.prepare("INSERT INTO stock_base(base_product_id,size_id,quantity,quantity_actual)VALUES(?,?,100,100)").run(prodC1cNew.bpId, prodC1cNew.sizeId);
  const orderC1c = await api("/api/orders", { method: "POST", body: JSON.stringify({
    dropshipper_id: drop.id, items: [{ variation_id: prodC1cOld.varId, size_id: prodC1cOld.sizeId, quantity: 1 }],
    client_name: "__T6 Клієнт7", client_phone: "+380501120007", client_city: "Київ", client_warehouse: "Відділення №1",
    is_prepaid: true, receipt_photo: "__T6.jpg", note: "__T6"
  }) });
  const c1cOrderId = orderC1c.b.order_id;
  const itemsC1c = (await api("/api/orders/" + c1cOrderId)).b.order.items;
  const itemC1cId = itemsC1c[0].id;
  const swapRes = await api("/api/order-items/" + itemC1cId + "/swap-product", { method: "POST", body: JSON.stringify({ new_variation_id: prodC1cNew.varId, new_size_id: prodC1cNew.sizeId }) });
  ok(swapRes.s === 200, "товар замінено (" + JSON.stringify(swapRes.b) + ")");
  const prepaidAfterSwap = db.prepare("SELECT * FROM cash_moves WHERE kind='prepaid' AND ref_type='order' AND ref_id=?").all(c1cOrderId);
  ok(prepaidAfterSwap.length === 1 && prepaidAfterSwap[0].amount === swapRes.b.total_drop,
    "рух каси передоплати синхронізувався після заміни товару (" + (prepaidAfterSwap[0] && prepaidAfterSwap[0].amount) + " = " + swapRes.b.total_drop + ")");

  // ── C2: скасування передоплаченого замовлення прибирає прихід каси ────
  // (на відміну від видалення, скасування раніше рухів каси не чіпало)
  const prodC2 = createTestProduct(700);
  const orderC2 = await api("/api/orders", { method: "POST", body: JSON.stringify({
    dropshipper_id: drop.id, items: [{ variation_id: prodC2.varId, size_id: prodC2.sizeId, quantity: 1 }],
    client_name: "__T6 Клієнт8", client_phone: "+380501120008", client_city: "Київ", client_warehouse: "Відділення №1",
    is_prepaid: true, receipt_photo: "__T6.jpg", note: "__T6"
  }) });
  const c2OrderId = orderC2.b.order_id;
  const prepaidC2 = db.prepare("SELECT amount FROM cash_moves WHERE kind='prepaid' AND ref_type='order' AND ref_id=?").get(c2OrderId);
  ok(prepaidC2 && prepaidC2.amount === 700, "передоплата фікстури 700 записана в касу (" + (prepaidC2 && prepaidC2.amount) + ")");

  const cancelRes = await api("/api/orders/" + c2OrderId + "/cancel", { method: "POST", body: JSON.stringify({}) });
  ok(cancelRes.s === 200, "передоплачене замовлення скасовано (" + JSON.stringify(cancelRes.b) + ")");
  const prepaidAfterCancel = db.prepare("SELECT COUNT(*) c FROM cash_moves WHERE ref_type='order' AND ref_id=?").get(c2OrderId).c;
  ok(prepaidAfterCancel === 0, "рух каси приходу прибраний після скасування (" + prepaidAfterCancel + ")");

  // ── I1: вихід зі статусу delivered відкочує наложку й delivered_at,
  // а повторне отримання того самого замовлення знову працює коректно ──
  const prodI1 = createTestProduct(220);
  const orderI1 = await api("/api/orders", { method: "POST", body: JSON.stringify({
    dropshipper_id: drop.id, items: [{ variation_id: prodI1.varId, size_id: prodI1.sizeId, quantity: 1 }],
    client_name: "__T6 Клієнт9", client_phone: "+380501120009", client_city: "Київ", client_warehouse: "Відділення №1",
    cod_amount: 480, note: "__T6"
  }) });
  const i1OrderId = orderI1.b.order_id;
  await api("/api/orders/" + i1OrderId + "/status", { method: "PUT", body: JSON.stringify({ status: "delivered" }) });
  const beforeUndeliver = db.prepare("SELECT delivered_at FROM orders WHERE id=?").get(i1OrderId);
  ok(!!beforeUndeliver.delivered_at, "delivered_at проставлено перед перевіркою відкату");
  const codBeforeUndeliver = db.prepare("SELECT COUNT(*) c FROM cash_moves WHERE kind='cod' AND ref_type='order' AND ref_id=?").get(i1OrderId).c;
  ok(codBeforeUndeliver === 1, "рух каси наложки є перед відкатом");

  // напрямок 1: НП повернула посилку — вихід зі статусу delivered
  const backToRefused = await api("/api/orders/" + i1OrderId + "/status", { method: "PUT", body: JSON.stringify({ status: "refused" }) });
  ok(backToRefused.s === 200, "статус повернуто на refused (НП повернула посилку)");
  const afterUndeliver = db.prepare("SELECT delivered_at FROM orders WHERE id=?").get(i1OrderId);
  ok(afterUndeliver.delivered_at === "", "delivered_at скинуто після виходу зі статусу delivered (" + JSON.stringify(afterUndeliver.delivered_at) + ")");
  const codAfterUndeliver = db.prepare("SELECT COUNT(*) c FROM cash_moves WHERE kind='cod' AND ref_type='order' AND ref_id=?").get(i1OrderId).c;
  ok(codAfterUndeliver === 0, "рух каси наложки прибраний після виходу зі статусу delivered (" + codAfterUndeliver + ")");

  // напрямок 2: те саме замовлення отримують повторно — має спрацювати
  // так само коректно, як уперше, без задвоєння
  const redeliver = await api("/api/orders/" + i1OrderId + "/status", { method: "PUT", body: JSON.stringify({ status: "delivered" }) });
  ok(redeliver.s === 200, "повторне отримання проведено");
  const afterRedeliver = db.prepare("SELECT delivered_at FROM orders WHERE id=?").get(i1OrderId);
  ok(!!afterRedeliver.delivered_at, "delivered_at знову проставлено при повторному отриманні (" + afterRedeliver.delivered_at + ")");
  const codAfterRedeliver = db.prepare("SELECT * FROM cash_moves WHERE kind='cod' AND ref_type='order' AND ref_id=?").all(i1OrderId);
  ok(codAfterRedeliver.length === 1 && codAfterRedeliver[0].amount === 480, "рух каси наложки знову записаний, один, на правильну суму (" + JSON.stringify(codAfterRedeliver) + ")");
  // Так само прибираємо одразу: замовлення знову delivered з ненульовим
  // payout_amount, і секція виплати дроперу нижче використовує того самого
  // дропера — мусить бачити тільки свою власну фікстуру (payOrderId).
  db.prepare("DELETE FROM cash_moves WHERE ref_type='order' AND ref_id=?").run(i1OrderId);
  db.prepare("DELETE FROM order_items WHERE order_id=?").run(i1OrderId);
  db.prepare("DELETE FROM orders WHERE id=?").run(i1OrderId);
  removeTestProduct(prodI1);

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

  // ── I2: виплата з відʼємним підсумком (борг дропера більший за суму до
  // виплати) не має проводитись і не має лишати фантомний прихід у касі.
  // Борг дроперу і залік у виплату йдуть через реальні ендпоінти
  // (POST /api/users/:id/balance, POST /api/payouts/:id/apply-balance), а
  // не прямим UPDATE payout_requests — інакше перевірка не гарантує, що
  // саме ці маршрути насправді сходяться в те саме число.
  const dropForNeg = db.prepare("SELECT id, balance FROM users WHERE role='dropshipper' ORDER BY id LIMIT 1").get();
  const origBalanceNeg = dropForNeg.balance;
  const btMaxIdBefore = db.prepare("SELECT COALESCE(MAX(id),0) m FROM balance_transactions").get().m;

  // навісити на дропера борг, більший за будь-яку правдоподібну виплату,
  // незалежно від того, який баланс у нього був до цього
  const adjAmount = round2(-1000 - (dropForNeg.balance || 0));
  const adjRes = await api("/api/users/" + dropForNeg.id + "/balance", { method: "POST", body: JSON.stringify({ amount: adjAmount, type: "adjust", note: "__T6 борг" }) });
  ok(adjRes.s === 200, "борг дроперу нараховано через реальний ендпоінт коригування балансу (" + JSON.stringify(adjRes.b) + ")");
  ok(round2(adjRes.b.balance) === -1000, "баланс дропера тепер −1000 (" + adjRes.b.balance + ")");

  const prodNeg = createTestProduct(50);
  const orderNeg = await api("/api/orders", { method: "POST", body: JSON.stringify({
    dropshipper_id: dropForNeg.id, items: [{ variation_id: prodNeg.varId, size_id: prodNeg.sizeId, quantity: 1 }],
    client_name: "__T6 Клієнт10", client_phone: "+380501120010", client_city: "Київ", client_warehouse: "Відділення №1",
    cod_amount: 150, note: "__T6"
  }) });
  const negOrderId = orderNeg.b.order_id;
  await api("/api/orders/" + negOrderId + "/status", { method: "PUT", body: JSON.stringify({ status: "delivered" }) });

  const negReq = await api("/api/payouts/request", { method: "POST", body: JSON.stringify({ dropshipper_id: dropForNeg.id }) });
  ok(negReq.s === 200 && negReq.b.request_id, "запит на виплату для перевірки I2 сформовано (" + JSON.stringify(negReq.b) + ")");
  const negPrId = negReq.b.request_id;

  const applyRes = await api("/api/payouts/" + negPrId + "/apply-balance", { method: "POST" });
  ok(applyRes.s === 200, "борг зараховано у виплату через реальний ендпоінт apply-balance (" + JSON.stringify(applyRes.b) + ")");
  ok(applyRes.b.final_total < 0, "підсумок виплати від'ємний після заліку боргу (" + applyRes.b.final_total + ")");

  const movesBeforePay = db.prepare("SELECT COUNT(*) c FROM cash_moves WHERE ref_type='payout' AND ref_id=?").get(negPrId).c;
  const payNegRes = await api("/api/payouts/" + negPrId + "/paid", { method: "PUT", body: JSON.stringify({}) });
  ok(payNegRes.s === 400, "проведення виплати з від'ємним підсумком відхилене (" + payNegRes.s + ", " + JSON.stringify(payNegRes.b) + ")");
  const statusAfterNeg = db.prepare("SELECT status FROM payout_requests WHERE id=?").get(negPrId).status;
  ok(statusAfterNeg === "pending", "запит лишився pending, не позначений paid (" + statusAfterNeg + ")");
  const movesAfterPay = db.prepare("SELECT COUNT(*) c FROM cash_moves WHERE ref_type='payout' AND ref_id=?").get(negPrId).c;
  ok(movesAfterPay === movesBeforePay, "фантомний прихід у касу не з'явився (" + movesBeforePay + " -> " + movesAfterPay + ")");

  // прибирання фікстур I2
  db.prepare("DELETE FROM payout_items WHERE payout_request_id=?").run(negPrId);
  db.prepare("DELETE FROM payout_requests WHERE id=?").run(negPrId);
  db.prepare("DELETE FROM order_items WHERE order_id=?").run(negOrderId);
  db.prepare("DELETE FROM cash_moves WHERE ref_type='order' AND ref_id=?").run(negOrderId);
  db.prepare("DELETE FROM orders WHERE id=?").run(negOrderId);
  removeTestProduct(prodNeg);
  db.prepare("DELETE FROM balance_transactions WHERE user_id=? AND id>?").run(dropForNeg.id, btMaxIdBefore);
  db.prepare("UPDATE users SET balance=? WHERE id=?").run(origBalanceNeg, dropForNeg.id);

  // ── виплата зарплати працівнику (справжня перевірка, не мовчазний
  // пропуск — якщо активного працівника нема, створюємо його фікстурою
  // через реальний ендпоінт) ─────────────────────────────────────────
  let w = db.prepare("SELECT id,name FROM workers WHERE active=1 ORDER BY id LIMIT 1").get();
  let createdWorkerId = null;
  if (!w) {
    const workerRes = await api("/api/workers", { method: "POST", body: JSON.stringify({ name: "__T6 Швачка", role: "seamstress", per_item_rate: 10 }) });
    ok(workerRes.s === 200 && workerRes.b.id, "працівник-фікстура створений через реальний ендпоінт (" + JSON.stringify(workerRes.b) + ")");
    createdWorkerId = workerRes.b.id;
    w = { id: createdWorkerId, name: "__T6 Швачка" };
  }
  let earned = db.prepare("SELECT COALESCE(SUM(amount),0) s FROM worker_payroll WHERE worker_id=?").get(w.id).s;
  const paid = db.prepare("SELECT COALESCE(SUM(amount),0) s FROM worker_payouts WHERE worker_id=?").get(w.id).s;
  let fixtureId = null;
  if (earned - paid <= 0) {
    fixtureId = db.prepare("INSERT INTO worker_payroll(worker_id,amount,type,note)VALUES(?,?,?,?)").run(w.id, 77.5, "item", "__T6").lastInsertRowid;
    earned = db.prepare("SELECT COALESCE(SUM(amount),0) s FROM worker_payroll WHERE worker_id=?").get(w.id).s;
  }
  ok(earned - paid > 0, "працівнику є що виплачувати (нараховано " + earned + ", виплачено " + paid + ")");
  r = await api("/api/workers/" + w.id + "/pay", { method: "POST", body: JSON.stringify({}) });
  ok(r.s === 200, "виплату зарплати проведено");
  const wp = db.prepare("SELECT id FROM worker_payouts WHERE worker_id=? ORDER BY id DESC LIMIT 1").get(w.id);
  const sm = db.prepare("SELECT * FROM cash_moves WHERE ref_type='worker_payout' AND ref_id=?").get(wp.id);
  ok(sm && sm.amount === -round2(earned - paid), "зарплата лягла в касу мінусом (" + (sm && sm.amount) + ")");
  ok(sm && sm.kind === "salary", "тип руху salary, не витрата");
  db.prepare("DELETE FROM cash_moves WHERE ref_type='worker_payout' AND ref_id=?").run(wp.id);
  db.prepare("DELETE FROM worker_payouts WHERE id=?").run(wp.id);
  if (fixtureId) db.prepare("DELETE FROM worker_payroll WHERE id=?").run(fixtureId);
  if (createdWorkerId) db.prepare("DELETE FROM workers WHERE id=?").run(createdWorkerId);

  // ── видалення замовлення прибирає рухи каси (пункт 5), включно з
  // другим і наступними частковими поверненнями (refund_extra) — одне
  // повернення цю гілку не зачіпає, тож фікстура робить два ────────────
  const prodDel = createTestProduct(400);
  const orderDel = await api("/api/orders", { method: "POST", body: JSON.stringify({
    dropshipper_id: drop.id, items: [{ variation_id: prodDel.varId, size_id: prodDel.sizeId, quantity: 1 }],
    client_name: "__T6 Клієнт3", client_phone: "+380501120003", client_city: "Київ", client_warehouse: "Відділення №1",
    cod_amount: 400, note: "__T6"
  }) });
  const delOrderId = orderDel.b.order_id;
  await api("/api/orders/" + delOrderId + "/status", { method: "PUT", body: JSON.stringify({ status: "delivered" }) });
  await api("/api/finance/orders/" + delOrderId + "/refund", { method: "POST", body: JSON.stringify({ amount: 100, note: "__T6" }) });
  await api("/api/finance/orders/" + delOrderId + "/refund", { method: "POST", body: JSON.stringify({ amount: 50, note: "__T6" }) });
  const delTag = "%(замовлення #" + delOrderId + ")";
  const countDelMoves = () => db.prepare(`SELECT COUNT(*) c FROM cash_moves
    WHERE (ref_type='order' AND ref_id=?) OR (ref_type='refund' AND ref_id=?) OR (ref_type='refund_extra' AND note LIKE ?)`)
    .get(delOrderId, delOrderId, delTag).c;
  const movesBeforeDelete = countDelMoves();
  ok(movesBeforeDelete === 3, "фікстура має 3 рухи каси перед видаленням (cod + перше повернення + друге часткове refund_extra), отримано " + movesBeforeDelete);

  const delRes = await api("/api/orders/" + delOrderId, { method: "DELETE", body: JSON.stringify({ destination: "base" }) });
  ok(delRes.s === 200, "замовлення видалено (" + JSON.stringify(delRes.b) + ")");
  const movesAfterDelete = countDelMoves();
  ok(movesAfterDelete === 0, "усі рухи каси видаленого замовлення прибрані, включно з refund_extra, а не лишились сиротами (" + movesAfterDelete + ")");

  // ── прибирання фікстур ─────────────────────────────────────────
  // c1OrderId і i1OrderId прибрані одразу після власних перевірок вище (щоб
  // не потрапити чужими delivered-замовленнями в payout-запит того самого
  // дропера), тому тут їх уже нема — залишились o, payOrderId, c1bOrderId,
  // c1cOrderId, c2OrderId (c2OrderId уже скасовано, але order_items і
  // order-рядок лишаються в історії, тож прибираємо і їх).
  db.prepare("DELETE FROM cash_moves WHERE ref_type='refund' AND ref_id=?").run(o.id);
  db.prepare("DELETE FROM cash_moves WHERE ref_type='refund_extra' AND note LIKE ?").run("%" + orderTag);
  db.prepare("DELETE FROM cash_moves WHERE ref_type='order' AND ref_id IN (?,?,?,?,?)")
    .run(o.id, payOrderId, c1bOrderId, c1cOrderId, c2OrderId);
  db.prepare("DELETE FROM cash_moves WHERE ref_type='payout' AND ref_id=?").run(prId);
  db.prepare("DELETE FROM payout_items WHERE payout_request_id=?").run(prId);
  db.prepare("DELETE FROM payout_requests WHERE id=?").run(prId);
  db.prepare("DELETE FROM order_items WHERE order_id IN (?,?,?,?,?)")
    .run(o.id, payOrderId, c1bOrderId, c1cOrderId, c2OrderId);
  db.prepare("DELETE FROM orders WHERE id IN (?,?,?,?,?)")
    .run(o.id, payOrderId, c1bOrderId, c1cOrderId, c2OrderId);
  db.prepare("DELETE FROM stock_base WHERE base_product_id=? AND size_id=?").run(prodC1cNew.bpId, prodC1cNew.sizeId);
  db.prepare("DELETE FROM stock_base WHERE base_product_id=? AND size_id=?").run(prodC1bExtra.bpId, prodC1bExtra.sizeId);
  [prod, prodPay, prodDel, prodC1b, prodC1bExtra, prodC1cOld, prodC1cNew, prodC2].forEach(removeTestProduct);
})();

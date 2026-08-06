const { api, ok, login, createTestProduct, removeTestProduct } = require("./_helpers");
const db = require("../../node_modules/better-sqlite3")(process.env.DB_PATH || "/tmp/fin-test.db");
// Прямий require фінмодуля — потрібен лише для мінор-перевірки
// onDropPayoutPaid напряму (нижче): маршрут сам не пускає туди від'ємну
// суму, тож перевірити захист хелпера можна лише в обхід маршруту.
// _helpers.js уже виставив DB_PATH до цього рядка, тож finance.js
// підхопить той самий тестовий файл, а не живу crm.db.
const finance = require("../../finance");
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

  // ── E1: правка замовлення через /edit БЕЗ поля наложки не має обнуляти
  // записаний прихід (пункт 1) — parseFloat(undefined) ?? o.cod_amount раніше
  // повертав NaN (?? не ловить NaN, лише null/undefined), і UPDATE записував
  // NaN/0 у cod_amount та payout_amount, а finance.syncOrderCashMove слідом
  // переписував рух каси на 0 ─────────────────────────────────────────────
  const prodE1 = createTestProduct(120);
  const orderE1 = await api("/api/orders", { method: "POST", body: JSON.stringify({
    dropshipper_id: drop.id, items: [{ variation_id: prodE1.varId, size_id: prodE1.sizeId, quantity: 1 }],
    client_name: "__T6 Клієнт13", client_phone: "+380501120013", client_city: "Київ", client_warehouse: "Відділення №1",
    cod_amount: 500, note: "__T6"
  }) });
  const e1OrderId = orderE1.b.order_id;
  await api("/api/orders/" + e1OrderId + "/status", { method: "PUT", body: JSON.stringify({ status: "delivered" }) });
  const e1Before = db.prepare("SELECT cod_amount,payout_amount FROM orders WHERE id=?").get(e1OrderId);
  ok(e1Before.cod_amount === 500, "наложка фікстури 500 перед правкою (" + e1Before.cod_amount + ")");

  const e1EditNote = await api("/api/orders/" + e1OrderId + "/edit", { method: "PUT", body: JSON.stringify({ note: "__T6 тільки нотатка" }) });
  ok(e1EditNote.s === 200, "правка без поля наложки пройшла (" + JSON.stringify(e1EditNote.b) + ")");
  const e1AfterNote = db.prepare("SELECT cod_amount,payout_amount,note FROM orders WHERE id=?").get(e1OrderId);
  ok(e1AfterNote.cod_amount === 500, "наложка НЕ обнулилась, коли поле не передане (" + e1AfterNote.cod_amount + ")");
  ok(e1AfterNote.payout_amount === e1Before.payout_amount, "виплата дроперу не зʼїхала разом із наложкою (" + e1AfterNote.payout_amount + " = " + e1Before.payout_amount + ")");
  ok(e1AfterNote.note === "__T6 тільки нотатка", "нотатка все ж оновилась — правка не проігнорована повністю");
  const e1CodMoveAfterNote = db.prepare("SELECT amount FROM cash_moves WHERE kind='cod' AND ref_type='order' AND ref_id=?").get(e1OrderId);
  ok(e1CodMoveAfterNote && e1CodMoveAfterNote.amount === 500, "рух каси наложки лишився на 500, не переписаний на 0 (" + (e1CodMoveAfterNote && e1CodMoveAfterNote.amount) + ")");

  // те саме нечисловим значенням поля (порожній рядок з форми) — інший шлях
  // до того самого NaN, має так само не обнуляти
  const e1EditEmpty = await api("/api/orders/" + e1OrderId + "/edit", { method: "PUT", body: JSON.stringify({ cod_amount: "", note: "__T6" }) });
  ok(e1EditEmpty.s === 200, "правка з порожнім полем наложки пройшла (" + JSON.stringify(e1EditEmpty.b) + ")");
  const e1AfterEmpty = db.prepare("SELECT cod_amount FROM orders WHERE id=?").get(e1OrderId);
  ok(e1AfterEmpty.cod_amount === 500, "наложка не обнулилась і від порожнього рядка (" + e1AfterEmpty.cod_amount + ")");

  db.prepare("DELETE FROM cash_moves WHERE ref_type='order' AND ref_id=?").run(e1OrderId);
  db.prepare("DELETE FROM order_items WHERE order_id=?").run(e1OrderId);
  db.prepare("DELETE FROM orders WHERE id=?").run(e1OrderId);
  removeTestProduct(prodE1);

  // ── E2: правка передоплаченого замовлення через /edit — окремий явний
  // сценарій (не swap-product/додавання позиції, як C1b/C1c вище): /edit не
  // чіпає total_drop_price, тож рух каси передоплати (kind='prepaid') після
  // synOrderCashMove(o.id), викликаного тепер всередині транзакції маршруту,
  // має лишитись без змін ────────────────────────────────────────────────
  const prodE2 = createTestProduct(250);
  const orderE2 = await api("/api/orders", { method: "POST", body: JSON.stringify({
    dropshipper_id: drop.id, items: [{ variation_id: prodE2.varId, size_id: prodE2.sizeId, quantity: 1 }],
    client_name: "__T6 Клієнт14", client_phone: "+380501120014", client_city: "Київ", client_warehouse: "Відділення №1",
    is_prepaid: true, receipt_photo: "__T6.jpg", note: "__T6"
  }) });
  const e2OrderId = orderE2.b.order_id;
  const e2PrepaidBefore = db.prepare("SELECT amount FROM cash_moves WHERE kind='prepaid' AND ref_type='order' AND ref_id=?").get(e2OrderId);
  ok(e2PrepaidBefore && e2PrepaidBefore.amount === 250, "передоплата фікстури 250 записана в касу (" + (e2PrepaidBefore && e2PrepaidBefore.amount) + ")");

  const e2Edit = await api("/api/orders/" + e2OrderId + "/edit", { method: "PUT", body: JSON.stringify({ note: "__T6 правка передоплаченого", weight: 0.4 }) });
  ok(e2Edit.s === 200, "правка передоплаченого замовлення через /edit пройшла (" + JSON.stringify(e2Edit.b) + ")");
  const e2PrepaidAfter = db.prepare("SELECT amount FROM cash_moves WHERE kind='prepaid' AND ref_type='order' AND ref_id=?").get(e2OrderId);
  ok(e2PrepaidAfter && e2PrepaidAfter.amount === 250, "рух каси передоплати не зʼїхав від правки, що не міняла суму (" + (e2PrepaidAfter && e2PrepaidAfter.amount) + ")");
  ok(db.prepare("SELECT payout_amount FROM orders WHERE id=?").get(e2OrderId).payout_amount === 0, "виплата передоплаченого замовлення лишилась 0 (передоплата — без наложки)");

  db.prepare("DELETE FROM cash_moves WHERE ref_type='order' AND ref_id=?").run(e2OrderId);
  db.prepare("DELETE FROM order_items WHERE order_id=?").run(e2OrderId);
  db.prepare("DELETE FROM orders WHERE id=?").run(e2OrderId);
  removeTestProduct(prodE2);

  // ── E3 (мінор): наложку правкою звели до нуля — рух каси має зникнути,
  // а не лишитись рядком на 0₴ (при створенні нульова наложка руху й так
  // не породжує, синхронізація має приводити до того самого стану) ──────
  const prodE3 = createTestProduct(90);
  const orderE3 = await api("/api/orders", { method: "POST", body: JSON.stringify({
    dropshipper_id: drop.id, items: [{ variation_id: prodE3.varId, size_id: prodE3.sizeId, quantity: 1 }],
    client_name: "__T6 Клієнт15", client_phone: "+380501120015", client_city: "Київ", client_warehouse: "Відділення №1",
    cod_amount: 300, note: "__T6"
  }) });
  const e3OrderId = orderE3.b.order_id;
  await api("/api/orders/" + e3OrderId + "/status", { method: "PUT", body: JSON.stringify({ status: "delivered" }) });
  ok(!!db.prepare("SELECT 1 FROM cash_moves WHERE kind='cod' AND ref_type='order' AND ref_id=?").get(e3OrderId), "рух каси наложки є перед зведенням до нуля");

  const e3EditZero = await api("/api/orders/" + e3OrderId + "/edit", { method: "PUT", body: JSON.stringify({ cod_amount: 0, note: "__T6" }) });
  ok(e3EditZero.s === 200, "наложку зведено до 0 (" + JSON.stringify(e3EditZero.b) + ")");
  const e3MoveAfterZero = db.prepare("SELECT COUNT(*) c FROM cash_moves WHERE kind='cod' AND ref_type='order' AND ref_id=?").get(e3OrderId).c;
  ok(e3MoveAfterZero === 0, "рух каси наложки прибраний, а не лишений на 0₴ (" + e3MoveAfterZero + ")");

  db.prepare("DELETE FROM cash_moves WHERE ref_type='order' AND ref_id=?").run(e3OrderId);
  db.prepare("DELETE FROM order_items WHERE order_id=?").run(e3OrderId);
  db.prepare("DELETE FROM orders WHERE id=?").run(e3OrderId);
  removeTestProduct(prodE3);

  // ── C2: скасування передоплаченого замовлення КОМПЕНСУЄ прихід зустрічним
  // розходом, а не стирає рух каси (пункт 2 — попередній раунд помилково
  // підключив сюди removeCashMovesForOrder, яка стирала заразом і реальні
  // повернення коштів клієнту) ────────────────────────────────────────────
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
  const prepaidAfterCancel = db.prepare("SELECT amount FROM cash_moves WHERE kind='prepaid' AND ref_type='order' AND ref_id=?").get(c2OrderId);
  ok(prepaidAfterCancel && prepaidAfterCancel.amount === 700, "прихід передоплати НЕ стерто — лишається правдою про рахунок (" + (prepaidAfterCancel && prepaidAfterCancel.amount) + ")");
  const cancelRefundMove = db.prepare("SELECT amount FROM cash_moves WHERE kind='cancel_refund' AND ref_type='order' AND ref_id=?").get(c2OrderId);
  ok(cancelRefundMove && cancelRefundMove.amount === -700, "зустрічний розхід на всю суму передоплати записаний, а не стирання (" + (cancelRefundMove && cancelRefundMove.amount) + ")");
  const c2NetEffect = db.prepare("SELECT COALESCE(SUM(amount),0) s FROM cash_moves WHERE ref_type='order' AND ref_id=?").get(c2OrderId).s;
  ok(round2(c2NetEffect) === 0, "сумарний вплив скасованого передоплаченого замовлення на касу — рівно нуль, гроші повернулись (" + c2NetEffect + ")");

  // ── C2b: скасування звичайного COD-замовлення (наложка ще не могла
  // прийти — статуси, які можна скасувати, завжди передують отриманню), по
  // якому вже зроблено повернення клієнту (гроші реально вийшли з рахунку)
  // — рух повернення має лишитись як є, і жодного зустрічного розходу
  // додаватись не повинно, бо приходу за це замовлення в касі нема ───────
  const prodC2b = createTestProduct(300);
  const orderC2b = await api("/api/orders", { method: "POST", body: JSON.stringify({
    dropshipper_id: drop.id, items: [{ variation_id: prodC2b.varId, size_id: prodC2b.sizeId, quantity: 1 }],
    client_name: "__T6 Клієнт16", client_phone: "+380501120016", client_city: "Київ", client_warehouse: "Відділення №1",
    cod_amount: 300, note: "__T6"
  }) });
  const c2bOrderId = orderC2b.b.order_id;
  ok(!db.prepare("SELECT 1 FROM cash_moves WHERE ref_type='order' AND ref_id=?").get(c2bOrderId),
    "у COD-замовлення до отримання ще нема приходу в касі (наложка приходить лише при onOrderDelivered)");

  const c2bRefund = await api("/api/finance/orders/" + c2bOrderId + "/refund", { method: "POST", body: JSON.stringify({ amount: 100, note: "__T6" }) });
  ok(c2bRefund.s === 200, "повернення 100 по ще не отриманому COD-замовленню проведено (" + JSON.stringify(c2bRefund.b) + ")");

  const c2bCancelRes = await api("/api/orders/" + c2bOrderId + "/cancel", { method: "POST", body: JSON.stringify({}) });
  ok(c2bCancelRes.s === 200, "COD-замовлення з уже зробленим поверненням скасовано (" + JSON.stringify(c2bCancelRes.b) + ")");
  const c2bRefundMove = db.prepare("SELECT amount FROM cash_moves WHERE kind='refund' AND ref_type='refund' AND ref_id=?").get(c2bOrderId);
  ok(c2bRefundMove && c2bRefundMove.amount === -100, "рух реального повернення коштів лишився в касі після скасування, не стертий (" + (c2bRefundMove && c2bRefundMove.amount) + ")");
  const c2bCompensatingCount = db.prepare("SELECT COUNT(*) c FROM cash_moves WHERE kind='cancel_refund' AND ref_type='order' AND ref_id=?").get(c2bOrderId).c;
  ok(c2bCompensatingCount === 0, "зустрічний розхід НЕ додався — приходу за це замовлення в касі не було (" + c2bCompensatingCount + ")");

  db.prepare("DELETE FROM cash_moves WHERE ref_type='refund' AND ref_id=?").run(c2bOrderId);
  db.prepare("DELETE FROM order_items WHERE order_id=?").run(c2bOrderId);
  db.prepare("DELETE FROM orders WHERE id=?").run(c2bOrderId);
  removeTestProduct(prodC2b);

  // ── I1: вихід зі статусу delivered прибирає прихід наложкою, а
  // delivered_at НЕ чиститься (пункт 3 — попередній раунд чистив дату, тож
  // круговий рейс delivered → refused → delivered знову проставляв
  // delivered_at СЬОГОДНІШНІМ днем замість дня, коли посилку справді забрали,
  // і тихо переносив дохід/касу в інший, можливо вже закритий місяць) ────
  const prodI1 = createTestProduct(220);
  const orderI1 = await api("/api/orders", { method: "POST", body: JSON.stringify({
    dropshipper_id: drop.id, items: [{ variation_id: prodI1.varId, size_id: prodI1.sizeId, quantity: 1 }],
    client_name: "__T6 Клієнт9", client_phone: "+380501120009", client_city: "Київ", client_warehouse: "Відділення №1",
    cod_amount: 480, note: "__T6"
  }) });
  const i1OrderId = orderI1.b.order_id;
  await api("/api/orders/" + i1OrderId + "/status", { method: "PUT", body: JSON.stringify({ status: "delivered" }) });

  // Відсуваємо день отримання в минуле (посилку нібито забрали більше
  // місяця тому — уже закритий звітний період) ПРЯМО в БД, так само
  // зсуваючи дату вже записаного руху каси: інакше "сьогодні" в тесті й
  // "сьогодні", яке помилково проставив би регрес, збіглись би, і перевірка
  // нічого не довела б.
  const pastDeliveredAt = db.prepare("SELECT datetime('now','localtime','-35 days') d").get().d;
  const pastDay = pastDeliveredAt.slice(0, 10);
  db.prepare("UPDATE orders SET delivered_at=? WHERE id=?").run(pastDeliveredAt, i1OrderId);
  db.prepare("UPDATE cash_moves SET date=? WHERE kind='cod' AND ref_type='order' AND ref_id=?").run(pastDay, i1OrderId);

  const codBeforeUndeliver = db.prepare("SELECT COUNT(*) c FROM cash_moves WHERE kind='cod' AND ref_type='order' AND ref_id=?").get(i1OrderId).c;
  ok(codBeforeUndeliver === 1, "рух каси наложки є перед відкатом");

  // напрямок 1: НП повернула посилку — вихід зі статусу delivered
  const backToRefused = await api("/api/orders/" + i1OrderId + "/status", { method: "PUT", body: JSON.stringify({ status: "refused" }) });
  ok(backToRefused.s === 200, "статус повернуто на refused (НП повернула посилку)");
  const afterUndeliver = db.prepare("SELECT delivered_at FROM orders WHERE id=?").get(i1OrderId);
  ok(afterUndeliver.delivered_at === pastDeliveredAt,
    "delivered_at НЕ скидається при виході зі статусу delivered, лишається вихідною датою отримання (" + JSON.stringify(afterUndeliver.delivered_at) + " = " + pastDeliveredAt + ")");
  const codAfterUndeliver = db.prepare("SELECT COUNT(*) c FROM cash_moves WHERE kind='cod' AND ref_type='order' AND ref_id=?").get(i1OrderId).c;
  ok(codAfterUndeliver === 0, "рух каси наложки прибраний після виходу зі статусу delivered (" + codAfterUndeliver + ")");

  // напрямок 2: те саме замовлення отримують повторно — має спрацювати без
  // задвоєння І без переносу дати на сьогодні (пункт 3, головна перевірка)
  const redeliver = await api("/api/orders/" + i1OrderId + "/status", { method: "PUT", body: JSON.stringify({ status: "delivered" }) });
  ok(redeliver.s === 200, "повторне отримання проведено");
  const afterRedeliver = db.prepare("SELECT delivered_at FROM orders WHERE id=?").get(i1OrderId);
  ok(afterRedeliver.delivered_at === pastDeliveredAt,
    "delivered_at при повторному отриманні лишився вихідною датою, а не переїхав на сьогодні (" + afterRedeliver.delivered_at + " = " + pastDeliveredAt + ")");
  const codAfterRedeliver = db.prepare("SELECT * FROM cash_moves WHERE kind='cod' AND ref_type='order' AND ref_id=?").all(i1OrderId);
  ok(codAfterRedeliver.length === 1 && codAfterRedeliver[0].amount === 480, "рух каси наложки знову записаний, один, на правильну суму (" + JSON.stringify(codAfterRedeliver) + ")");
  ok(codAfterRedeliver[0] && codAfterRedeliver[0].date === pastDay,
    "рух каси наложки відновлений на вихідну дату отримання, а не на сьогодні (" + (codAfterRedeliver[0] && codAfterRedeliver[0].date) + " = " + pastDay + ")");
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

  // ── I2a: apply-balance більше не заводить у глухий кут (пункт 4).
  // Раніше сюди йшов увесь борг як є — якщо він більший за суму заявки,
  // підсумок ставав від'ємним, і виплату вже неможливо було провести
  // (balance_applied пише лише цей маршрут, і лише додаванням — відкату
  // нема). Тепер залік обмежується тим, що заявка фактично може покрити.
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
  ok(negReq.s === 200 && negReq.b.request_id, "запит на виплату для перевірки I2a сформовано (" + JSON.stringify(negReq.b) + ")");
  const negPrId = negReq.b.request_id;
  const negPrBefore = db.prepare("SELECT total_amount FROM payout_requests WHERE id=?").get(negPrId);
  ok(negPrBefore && negPrBefore.total_amount === 100, "сума заявки I2a = 100 (150 наложка − 50 дроп-ціна) (" + (negPrBefore && negPrBefore.total_amount) + ")");

  const applyRes = await api("/api/payouts/" + negPrId + "/apply-balance", { method: "POST" });
  ok(applyRes.s === 200, "борг зараховано у виплату через реальний ендпоінт apply-balance (" + JSON.stringify(applyRes.b) + ")");
  ok(round2(applyRes.b.balance_applied) === -100, "залік обмежений сумою заявки (−100), а не всім боргом (−1000) (" + applyRes.b.balance_applied + ")");
  ok(round2(applyRes.b.final_total) === 0, "підсумок виплати рівно нуль, у мінус більше не йде (" + applyRes.b.final_total + ")");
  const balanceAfterApply = db.prepare("SELECT balance FROM users WHERE id=?").get(dropForNeg.id).balance;
  ok(round2(balanceAfterApply) === -900, "решта боргу (−900) лишилась на балансі дропера, не пропала і не заведена в мінус заявки (" + balanceAfterApply + ")");

  // повторний залік на заявку, вже повністю покриту боргом — нема що заводити
  const applyAgainRes = await api("/api/payouts/" + negPrId + "/apply-balance", { method: "POST" });
  ok(applyAgainRes.s === 400, "повторний залік на заявку, вже повністю покриту боргом, відхилений (" + applyAgainRes.s + ", " + JSON.stringify(applyAgainRes.b) + ")");

  // виплату з підсумком 0 тепер можна провести (раніше — глухий кут);
  // гроші фактично нікуди не йдуть, тож рух каси не з'являється
  const movesBeforePay = db.prepare("SELECT COUNT(*) c FROM cash_moves WHERE ref_type='payout' AND ref_id=?").get(negPrId).c;
  const payNegRes = await api("/api/payouts/" + negPrId + "/paid", { method: "PUT", body: JSON.stringify({}) });
  ok(payNegRes.s === 200, "виплату з нульовим підсумком проведено, глухого кута більше нема (" + payNegRes.s + ", " + JSON.stringify(payNegRes.b) + ")");
  const statusAfterNeg = db.prepare("SELECT status FROM payout_requests WHERE id=?").get(negPrId).status;
  ok(statusAfterNeg === "paid", "запит позначений paid (" + statusAfterNeg + ")");
  const movesAfterPay = db.prepare("SELECT COUNT(*) c FROM cash_moves WHERE ref_type='payout' AND ref_id=?").get(negPrId).c;
  ok(movesAfterPay === movesBeforePay, "нульова виплата не лишила фантомного руху каси (" + movesBeforePay + " -> " + movesAfterPay + ")");

  // ── I2b: страховка з попереднього раунду (блокування від'ємного
  // підсумку) лишається потрібною на залишковий випадок — сума заявки
  // зменшилась ПІСЛЯ заліку (замовлення перестало бути delivered до того,
  // як виплату провели). Відкотити вже зроблений залік нічим, тож
  // перевіряємо нове, дієве формулювання помилки (не "зменшіть залік",
  // якого адмін виконати не може) ─────────────────────────────────────
  const prodNeg2 = createTestProduct(60);
  const orderNeg2 = await api("/api/orders", { method: "POST", body: JSON.stringify({
    dropshipper_id: dropForNeg.id, items: [{ variation_id: prodNeg2.varId, size_id: prodNeg2.sizeId, quantity: 1 }],
    client_name: "__T6 Клієнт17", client_phone: "+380501120017", client_city: "Київ", client_warehouse: "Відділення №1",
    cod_amount: 200, note: "__T6"
  }) });
  const negOrderId2 = orderNeg2.b.order_id;
  await api("/api/orders/" + negOrderId2 + "/status", { method: "PUT", body: JSON.stringify({ status: "delivered" }) });
  const negReq2 = await api("/api/payouts/request", { method: "POST", body: JSON.stringify({ dropshipper_id: dropForNeg.id }) });
  ok(negReq2.s === 200 && negReq2.b.request_id, "запит на виплату для I2b сформовано (" + JSON.stringify(negReq2.b) + ")");
  const negPrId2 = negReq2.b.request_id;
  const negPr2Before = db.prepare("SELECT total_amount FROM payout_requests WHERE id=?").get(negPrId2);
  ok(negPr2Before && negPr2Before.total_amount === 140, "сума заявки I2b = 140 (200 наложка − 60 дроп-ціна) (" + (negPr2Before && negPr2Before.total_amount) + ")");

  const apply2Res = await api("/api/payouts/" + negPrId2 + "/apply-balance", { method: "POST" });
  ok(apply2Res.s === 200 && round2(apply2Res.b.final_total) === 0, "залік знову обмежений сумою заявки, підсумок 0 (" + JSON.stringify(apply2Res.b) + ")");

  // Замовлення, яке дало суму заявки, "повертають" — статус більше не
  // delivered. total_amount у payout_requests лишається старим, поки
  // заявку не синхронізують — це станеться всередині /paid.
  const revertRes = await api("/api/orders/" + negOrderId2 + "/status", { method: "PUT", body: JSON.stringify({ status: "refused" }) });
  ok(revertRes.s === 200, "замовлення заявки I2b відкочене зі статусу delivered (" + JSON.stringify(revertRes.b) + ")");

  const pay2Res = await api("/api/payouts/" + negPrId2 + "/paid", { method: "PUT", body: JSON.stringify({}) });
  ok(pay2Res.s === 400, "виплата з підсумком, що пішов у мінус ПІСЛЯ заліку, і далі блокується (" + pay2Res.s + ", " + JSON.stringify(pay2Res.b) + ")");
  const msg2 = (pay2Res.b && pay2Res.b.error) || "";
  ok(!/зменшіть залік/i.test(msg2), "текст помилки більше не радить неможливу дію \"зменшіть залік\" (" + msg2 + ")");
  ok(/доставлять|нових замовлень|заявк/i.test(msg2), "текст помилки вказує на дію, яку адмін реально може виконати (" + msg2 + ")");
  const statusAfterNeg2 = db.prepare("SELECT status FROM payout_requests WHERE id=?").get(negPrId2).status;
  ok(statusAfterNeg2 === "pending", "запит I2b лишився pending, не позначений paid (" + statusAfterNeg2 + ")");
  const movesAfterPay2 = db.prepare("SELECT COUNT(*) c FROM cash_moves WHERE ref_type='payout' AND ref_id=?").get(negPrId2).c;
  ok(movesAfterPay2 === 0, "фантомний прихід у касу не з'явився (" + movesAfterPay2 + ")");

  // ── мінор: onDropPayoutPaid має власний захисний ранній вихід на
  // від'ємну суму, не покладаючись лише на блокування в /paid — маршрут
  // сам туди від'ємну суму не пускає, тож перевіряємо хелпер напряму на
  // штучно зведеному запиті (в обхід маршруту) ─────────────────────────
  const guardPrId = db.prepare(`INSERT INTO payout_requests(dropshipper_id,status,total_amount,balance_applied,paid_at)
    VALUES(?,'paid',50,-200,datetime('now','localtime'))`).run(dropForNeg.id).lastInsertRowid;
  finance.onDropPayoutPaid(guardPrId);
  const guardMoveCount = db.prepare("SELECT COUNT(*) c FROM cash_moves WHERE ref_type='payout' AND ref_id=?").get(guardPrId).c;
  ok(guardMoveCount === 0, "onDropPayoutPaid не пише рух каси для штучно зведеного від'ємного підсумку, навіть в обхід маршруту (" + guardMoveCount + ")");
  db.prepare("DELETE FROM payout_requests WHERE id=?").run(guardPrId);

  // прибирання фікстур I2a + I2b
  db.prepare("DELETE FROM payout_items WHERE payout_request_id IN (?,?)").run(negPrId, negPrId2);
  db.prepare("DELETE FROM payout_requests WHERE id IN (?,?)").run(negPrId, negPrId2);
  db.prepare("DELETE FROM order_items WHERE order_id IN (?,?)").run(negOrderId, negOrderId2);
  db.prepare("DELETE FROM cash_moves WHERE ref_type='order' AND ref_id IN (?,?)").run(negOrderId, negOrderId2);
  db.prepare("DELETE FROM cash_moves WHERE ref_type='payout' AND ref_id IN (?,?)").run(negPrId, negPrId2);
  db.prepare("DELETE FROM orders WHERE id IN (?,?)").run(negOrderId, negOrderId2);
  removeTestProduct(prodNeg);
  removeTestProduct(prodNeg2);
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

// Фіксуємо DB_PATH до значення за замовчуванням ДО будь-якого require db.js
// нижче (перевірка міграції вимагає повторно ініціалізувати схему в цьому ж
// процесі) — без цього db.js, вимогнаний напряму, а не через запущений
// сервер, впав би на власний дефолтний шлях (живий crm.db поруч), а не на
// тестову копію. Живу базу цей файл чіпати не повинен ні за яких обставин.
process.env.DB_PATH = process.env.DB_PATH || "/tmp/fin-test.db";
const { api, ok, login, createTestProduct, removeTestProduct } = require("./_helpers");
const db = require("../../node_modules/better-sqlite3")(process.env.DB_PATH);
const today = db.prepare("SELECT date('now','localtime') d").get().d;

// Каса тепер рахує «як у банку»: рух каси — реальні гроші на рахунку
// (наложка/передоплата), а не заробіток складу (дроп-ціна). Раніше в касу
// писалась дроп-ціна під kind='income', і окремо ще й віднімалась виплата
// дроперу — тобто його частка віднімалась двічі. Перевіряємо, що тепер:
//  - COD-замовлення несе в касу наложку (cod_amount), а не дроп-ціну;
//  - повна передоплата несе прихід у день СТВОРЕННЯ, а не отримання;
//  - оплата з балансу дропера взагалі не рухає касу (грошей на рахунок
//    у цей момент не приходить);
//  - типу kind='income' у касі більше нема, і разова міграція його прибирає.

(async () => {
  await login("admin");
  const drop = db.prepare("SELECT id,balance_enabled FROM users WHERE role='dropshipper' ORDER BY id LIMIT 1").get();
  ok(!!drop, "є дропер для перевірки");

  // ── A: COD-замовлення — прихід за наложкою, не за дроп-ціною ──────
  const prodA = createTestProduct(200);
  const createA = await api("/api/orders", { method: "POST", body: JSON.stringify({
    dropshipper_id: drop.id, items: [{ variation_id: prodA.varId, size_id: prodA.sizeId, quantity: 1 }],
    client_name: "__T5 Клієнт", client_phone: "+380501110001", client_city: "Київ", client_warehouse: "Відділення №1",
    cod_amount: 500, note: "__T5"
  }) });
  ok(createA.s === 200, "COD-замовлення створено (" + JSON.stringify(createA.b) + ")");
  const orderA = createA.b.order_id;

  let r = await api("/api/orders/" + orderA + "/status", { method: "PUT", body: JSON.stringify({ status: "delivered" }) });
  ok(r.s === 200, "статус змінено на delivered");

  const rowA = db.prepare("SELECT delivered_at,cod_amount,total_drop_price FROM orders WHERE id=?").get(orderA);
  ok(!!rowA.delivered_at, "delivered_at проставлено: " + rowA.delivered_at);
  ok(rowA.cod_amount === 500 && rowA.total_drop_price === 200, "фікстура: наложка 500, дроп-ціна 200");

  const movesA = db.prepare("SELECT * FROM cash_moves WHERE ref_type='order' AND ref_id=?").all(orderA);
  ok(movesA.length === 1, "рух каси один (" + movesA.length + ")");
  ok(movesA[0] && movesA[0].kind === "cod", "тип руху cod, не income (" + (movesA[0] && movesA[0].kind) + ")");
  ok(movesA[0] && movesA[0].amount === rowA.cod_amount, "сума руху = наложка, не дроп-ціна (" + (movesA[0] && movesA[0].amount) + " vs cod " + rowA.cod_amount + ")");
  ok(movesA[0] && movesA[0].date === rowA.delivered_at.slice(0, 10), "дата — день отримання");

  // повторний перехід не має подвоїти рух каси
  await api("/api/orders/" + orderA + "/status", { method: "PUT", body: JSON.stringify({ status: "shipped" }) });
  await api("/api/orders/" + orderA + "/status", { method: "PUT", body: JSON.stringify({ status: "delivered" }) });
  const againA = db.prepare("SELECT COUNT(*) c FROM cash_moves WHERE ref_type='order' AND ref_id=?").get(orderA).c;
  ok(againA === 1, "повторне отримання не подвоїло рух каси (" + againA + ")");

  // ── B: повна передоплата — прихід у день СТВОРЕННЯ, не отримання ──
  const prodB = createTestProduct(150);
  const createB = await api("/api/orders", { method: "POST", body: JSON.stringify({
    dropshipper_id: drop.id, items: [{ variation_id: prodB.varId, size_id: prodB.sizeId, quantity: 1 }],
    client_name: "__T5 Клієнт2", client_phone: "+380501110002", client_city: "Київ", client_warehouse: "Відділення №1",
    is_prepaid: true, receipt_photo: "__T5.jpg", note: "__T5"
  }) });
  ok(createB.s === 200, "передоплачене замовлення створено (" + JSON.stringify(createB.b) + ")");
  const orderB = createB.b.order_id;
  const rowB = db.prepare("SELECT is_prepaid,paid_from_balance,total_drop_price,created_at FROM orders WHERE id=?").get(orderB);
  ok(rowB.is_prepaid === 1 && !rowB.paid_from_balance, "фікстура: is_prepaid=1, не з балансу");

  const movesB = db.prepare("SELECT * FROM cash_moves WHERE ref_type='order' AND ref_id=?").all(orderB);
  ok(movesB.length === 1 && movesB[0].kind === "prepaid", "передоплата лягла в касу приходом одразу при створенні (" + JSON.stringify(movesB[0]) + ")");
  ok(movesB[0] && movesB[0].amount === rowB.total_drop_price, "сума = дроп-ціна (" + (movesB[0] && movesB[0].amount) + ")");
  ok(movesB[0] && movesB[0].date === rowB.created_at.slice(0, 10), "дата — день створення, не отримання (" + (movesB[0] && movesB[0].date) + ")");

  await api("/api/orders/" + orderB + "/status", { method: "PUT", body: JSON.stringify({ status: "delivered" }) });
  const movesAfterDeliverB = db.prepare("SELECT COUNT(*) c FROM cash_moves WHERE ref_type='order' AND ref_id=?").get(orderB).c;
  ok(movesAfterDeliverB === 1, "отримання передоплаченого не додало ще один рух каси — наложки нема (" + movesAfterDeliverB + ")");

  // ── C: оплата з балансу дропера — рухів каси взагалі нема ─────────
  ok(!!drop.balance_enabled, "фікстура дропера має балансовий режим увімкнено (для тесту C)");
  const prodC = createTestProduct(120);
  const createC = await api("/api/orders", { method: "POST", body: JSON.stringify({
    dropshipper_id: drop.id, items: [{ variation_id: prodC.varId, size_id: prodC.sizeId, quantity: 1 }],
    client_name: "__T5 Клієнт3", client_phone: "+380501110003", client_city: "Київ", client_warehouse: "Відділення №1",
    is_prepaid: true, pay_from_balance: true, note: "__T5"
  }) });
  ok(createC.s === 200, "замовлення з оплатою з балансу створено (" + JSON.stringify(createC.b) + ")");
  const orderC = createC.b.order_id;
  const rowC = db.prepare("SELECT paid_from_balance FROM orders WHERE id=?").get(orderC);
  ok(rowC.paid_from_balance === 1, "paid_from_balance=1 — фікстура вірна");
  const movesC = db.prepare("SELECT COUNT(*) c FROM cash_moves WHERE ref_type='order' AND ref_id=?").get(orderC).c;
  ok(movesC === 0, "оплата з балансу не рухає касу — грошей на рахунок не прийшло (" + movesC + ")");

  // ── D: типу income більше нема, і міграція його прибирає ──────────
  const leftover = db.prepare("SELECT COUNT(*) c FROM cash_moves WHERE kind='income'").get().c;
  ok(leftover === 0, "рухів каси типу income більше немає (" + leftover + ")");

  // Перевіряємо саму міграцію (а не тільки її наслідок на вже мігрованій
  // базі): підкладаємо старий рух income, знімаємо прапорець і повторно
  // ініціалізуємо схему (як при рестарті сервера) — рух має зникнути.
  db.prepare("DELETE FROM settings WHERE key='cash_income_kind_removed_v1'").run();
  const leftoverId = db.prepare("INSERT INTO cash_moves(date,amount,kind,ref_type,note)VALUES(?,?,?,?,?)")
    .run(today, 12345, "income", "", "__T5 leftover").lastInsertRowid;
  delete require.cache[require.resolve("../../db.js")];
  require("../../db.js");
  const afterMigration = db.prepare("SELECT id FROM cash_moves WHERE id=?").get(leftoverId);
  ok(!afterMigration, "повторна ініціалізація схеми прибирає залишковий рух kind=income");
  const flagRow = db.prepare("SELECT value FROM settings WHERE key='cash_income_kind_removed_v1'").get();
  ok(!!flagRow, "прапорець одноразової міграції виставлено");

  // ── прибирання фікстур ─────────────────────────────────────────
  // Замовлення C списало собівартість із балансу дропера при створенні —
  // повертаємо баланс назад, інакше він назавжди просяде на 120₴.
  const balTx = db.prepare("SELECT COALESCE(SUM(amount),0) s FROM balance_transactions WHERE order_id=?").get(orderC).s;
  if (balTx) db.prepare("UPDATE users SET balance=ROUND(balance-?,2) WHERE id=?").run(balTx, drop.id);
  db.prepare("DELETE FROM balance_transactions WHERE order_id=?").run(orderC);
  db.prepare("DELETE FROM cash_moves WHERE ref_type='order' AND ref_id IN (?,?,?)").run(orderA, orderB, orderC);
  db.prepare("DELETE FROM order_items WHERE order_id IN (?,?,?)").run(orderA, orderB, orderC);
  db.prepare("DELETE FROM orders WHERE id IN (?,?,?)").run(orderA, orderB, orderC);
  [prodA, prodB, prodC].forEach(removeTestProduct);
})();

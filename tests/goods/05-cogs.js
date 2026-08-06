// FIFO при продажу, брак, повернення, у дорозі. Стиль — за зразком
// tests/finance/08-delivered.js: прямі INSERT у orders/order_items (в обхід
// повного POST /api/orders із його знижками/наложкою — тут перевіряється
// лише товарна лінія), рух статусу через реальний PUT /api/orders/:id/status,
// щоб перевірити саме підключені хуки, а не логіку goods.js в ізоляції.
const { api, ok, login } = require("../finance/_helpers");
const db = require("../../node_modules/better-sqlite3")(process.env.DB_PATH || "/tmp/fin-test.db");
const goods = require("../../goods");
const round2 = v => Math.round((v || 0) * 100) / 100;

// Мінімальний ланцюжок товару: категорія → модель → базовий товар → варіація
// (без print_id — "готовий товар", повернення йде на базу, не на полицю
// повернень; для товарної лінії полиця однаково влаштована, менше фікстур).
function makeProduct(nameSuffix) {
  const catId = db.prepare("INSERT INTO categories(name)VALUES(?)").run("__T5Cat" + nameSuffix).lastInsertRowid;
  const modelId = db.prepare("INSERT INTO models(name,category_id)VALUES(?,?)").run("__T5Model" + nameSuffix, catId).lastInsertRowid;
  const bpId = db.prepare("INSERT INTO base_products(model_id,name)VALUES(?,?)").run(modelId, "__T5BP" + nameSuffix).lastInsertRowid;
  const varId = db.prepare("INSERT INTO variations(base_product_id,name)VALUES(?,?)").run(bpId, "__T5Var" + nameSuffix).lastInsertRowid;
  const sizeId = db.prepare("SELECT id FROM sizes LIMIT 1").get().id;
  return { catId, modelId, bpId, varId, sizeId };
}
function seedStockBase(p, qty) {
  db.prepare("INSERT INTO stock_base(base_product_id,size_id,quantity,quantity_actual)VALUES(?,?,?,?)").run(p.bpId, p.sizeId, qty, qty);
}
function seedLot(p, qty, unitCost, createdAt) {
  return db.prepare(`INSERT INTO inventory_lots(base_product_id,size_id,qty_left,unit_cost,source,shelf,valued,created_at)
    VALUES(?,?,?,?,?,?,1,?)`).run(p.bpId, p.sizeId, qty, unitCost, "purchase", "base", createdAt).lastInsertRowid;
}
function makeOrder(dropId, p, qty) {
  const orderId = db.prepare(`INSERT INTO orders(dropshipper_id,status,client_name,client_phone,client_city,client_warehouse,cod_amount,total_drop_price,payout_amount,is_prepaid,note)
    VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(dropId, "new", "__T5Клієнт", "+380501110099", "Київ", "Відділення №1", 0, 0, 0, 1, "__T5").lastInsertRowid;
  const itemId = db.prepare("INSERT INTO order_items(order_id,variation_id,size_id,quantity,drop_price,from_returns)VALUES(?,?,?,?,0,0)")
    .run(orderId, p.varId, p.sizeId, qty).lastInsertRowid;
  return { orderId, itemId };
}
function cleanupProduct(p) {
  // Спершу споживання (lot_id посилається на inventory_lots без каскаду —
  // навмисно, це журнал і видалення партії не повинно тихо стерти слід), потім партії.
  db.prepare("DELETE FROM inventory_consumptions WHERE base_product_id=?").run(p.bpId);
  db.prepare("DELETE FROM inventory_lots WHERE base_product_id=?").run(p.bpId);
  db.prepare("DELETE FROM stock_base WHERE base_product_id=?").run(p.bpId);
  db.prepare("DELETE FROM stock_defect WHERE base_product_id=?").run(p.bpId);
  db.prepare("DELETE FROM stock_log WHERE base_product_id=?").run(p.bpId);
  db.prepare("DELETE FROM recount_items WHERE base_product_id=?").run(p.bpId);
  db.prepare("DELETE FROM variations WHERE id=?").run(p.varId);
  db.prepare("DELETE FROM base_products WHERE id=?").run(p.bpId);
  db.prepare("DELETE FROM models WHERE id=?").run(p.modelId);
  db.prepare("DELETE FROM categories WHERE id=?").run(p.catId);
}

(async () => {
  await login("admin");
  const drop = db.prepare("SELECT id FROM users WHERE role='dropshipper' ORDER BY id LIMIT 1").get();
  ok(!!drop, "є дропер для перевірки");

  // ══ 1. Дві партії з різною ціною — 450 шт бере 400 зі старої, 50 з нової ══
  const p1 = makeProduct("Fifo");
  const oldLot = seedLot(p1, 400, 10, "2026-08-01 09:00:00");
  const newLot = seedLot(p1, 100, 20, "2026-08-05 09:00:00");
  const fifo = goods.consumeLotsFifo(p1.bpId, p1.sizeId, 450, "base");
  ok(fifo.consumed.length === 2, "списання торкнулось рівно двох партій (" + fifo.consumed.length + ")");
  const c1 = fifo.consumed.find(c => c.lot_id === oldLot), c2 = fifo.consumed.find(c => c.lot_id === newLot);
  ok(c1 && c1.qty === 400, "зі старої партії взято 400 (" + (c1 && c1.qty) + ")");
  ok(c2 && c2.qty === 50, "з нової партії взято 50 (" + (c2 && c2.qty) + ")");
  ok(fifo.cost === round2(400 * 10 + 50 * 20), "сума точна: 400×10+50×20=5000 (" + fifo.cost + ")");
  ok(db.prepare("SELECT qty_left FROM inventory_lots WHERE id=?").get(oldLot).qty_left === 0, "стара партія вичерпана");
  ok(db.prepare("SELECT qty_left FROM inventory_lots WHERE id=?").get(newLot).qty_left === 50, "з нової лишилось 50 (100-50)");
  cleanupProduct(p1);

  // ══ 2 і 6. cogs фіксується при отриманні, не перераховується, "у дорозі" видно окремо ══
  const p2 = makeProduct("Cogs");
  seedStockBase(p2, 5);
  const lot2 = seedLot(p2, 5, 30, "2026-08-01 09:00:00");
  const { orderId: o2, itemId: i2 } = makeOrder(drop.id, p2, 2);

  let r = await api(`/api/orders/${o2}/status`, { method: "PUT", body: JSON.stringify({ status: "collected" }) });
  ok(r.s === 200, "замовлення переведено в 'Зібрано' — товар пішов з полиці (" + r.s + ")");

  let itemRow = db.prepare("SELECT cogs FROM order_items WHERE id=?").get(i2);
  ok(itemRow.cogs === 0, "cogs ще 0 — товар лише 'у дорозі', продаж не підтверджений (" + itemRow.cogs + ")");
  let lotRow = db.prepare("SELECT qty_left FROM inventory_lots WHERE id=?").get(lot2);
  ok(lotRow.qty_left === 3, "партія складу зменшилась на 2 (" + lotRow.qty_left + ")");
  let transit = db.prepare("SELECT * FROM inventory_consumptions WHERE order_item_id=? AND status='in_transit'").all(i2);
  ok(transit.length === 1 && transit[0].qty === 2 && transit[0].unit_cost === 30,
    "вартість 'у дорозі' зафіксована окремо: 2×30=60, не зникла (" + JSON.stringify(transit) + ")");

  r = await api(`/api/orders/${o2}/status`, { method: "PUT", body: JSON.stringify({ status: "delivered" }) });
  ok(r.s === 200, "замовлення отримано (" + r.s + ")");
  itemRow = db.prepare("SELECT cogs FROM order_items WHERE id=?").get(i2);
  ok(itemRow.cogs === 60, "cogs зафіксовано в момент отримання: 2×30=60 (" + itemRow.cogs + ")");
  ok(db.prepare("SELECT COUNT(*) c FROM inventory_consumptions WHERE order_item_id=? AND status='sold'").get(i2).c === 1,
    "рядок 'у дорозі' перейшов у 'продано'");

  // Прийшла дорожча партія — вже зафіксований cogs не повинен зрушити.
  seedLot(p2, 100, 999, "2026-08-06 09:00:00");
  itemRow = db.prepare("SELECT cogs FROM order_items WHERE id=?").get(i2);
  ok(itemRow.cogs === 60, "нова дорожча партія не перерахувала вже зафіксовану собівартість (" + itemRow.cogs + ")");

  // Повторний виклик 'delivered' (напр. НП підтвердила статус ще раз) — не
  // повинен обнулити або задвоїти вже зафіксовану цифру.
  r = await api(`/api/orders/${o2}/status`, { method: "PUT", body: JSON.stringify({ status: "delivered" }) });
  ok(r.s === 200, "повторне 'отримано' прийняте (" + r.s + ")");
  itemRow = db.prepare("SELECT cogs FROM order_items WHERE id=?").get(i2);
  ok(itemRow.cogs === 60, "повторне підтвердження 'отримано' не чіпає вже зафіксований cogs (" + itemRow.cogs + ")");
  db.prepare("DELETE FROM order_items WHERE order_id=?").run(o2);
  db.prepare("DELETE FROM orders WHERE id=?").run(o2);
  cleanupProduct(p2);

  // ══ 3. Повернення посилки повертає вартість на полицю тією ж ціною ══
  const p3 = makeProduct("Return");
  seedStockBase(p3, 5);
  const lot3 = seedLot(p3, 5, 45, "2026-08-01 09:00:00");
  const { orderId: o3, itemId: i3 } = makeOrder(drop.id, p3, 2);
  r = await api(`/api/orders/${o3}/status`, { method: "PUT", body: JSON.stringify({ status: "collected" }) });
  ok(r.s === 200, "замовлення 3 зібрано (" + r.s + ")");
  ok(db.prepare("SELECT qty_left FROM inventory_lots WHERE id=?").get(lot3).qty_left === 3, "партія 3 зменшилась на 2");

  r = await api(`/api/order-items/${i3}/return-to-stock`, { method: "POST", body: JSON.stringify({ condition: "good" }) });
  ok(r.s === 200, "повернення на полицю проведене (" + JSON.stringify(r.b) + ")");
  const returnedLot = db.prepare("SELECT * FROM inventory_lots WHERE base_product_id=? AND source='return'").get(p3.bpId);
  ok(!!returnedLot && returnedLot.unit_cost === 45 && returnedLot.qty_left === 2,
    "нова партія на полиці тією ж ціною, якою списалась: 45₴, 2 шт (" + JSON.stringify(returnedLot) + ")");
  ok(db.prepare("SELECT cogs FROM order_items WHERE id=?").get(i3).cogs === 0, "cogs лишився 0 — продажу не було");
  const totalP3 = round2(db.prepare("SELECT qty_left FROM inventory_lots WHERE id=?").get(lot3).qty_left * 45 + returnedLot.qty_left * 45);
  ok(totalP3 === 225, "загальна вартість товару 3 збереглась: 5×45=225 (" + totalP3 + ")");
  db.prepare("DELETE FROM order_items WHERE order_id=?").run(o3);
  db.prepare("DELETE FROM orders WHERE id=?").run(o3);
  cleanupProduct(p3);

  // ══ 4. Брак списує партію по вартості своєї полиці у втрати ══
  const p4 = makeProduct("Defect");
  seedStockBase(p4, 5);
  const lot4 = seedLot(p4, 5, 12, "2026-08-01 09:00:00");
  r = await api("/api/stock/defect", { method: "POST", body: JSON.stringify({ source: "base", base_product_id: p4.bpId, size_id: p4.sizeId, quantity: 2, note: "__T5" }) });
  ok(r.s === 200, "брак списаний (" + r.s + ")");
  ok(db.prepare("SELECT qty_left FROM inventory_lots WHERE id=?").get(lot4).qty_left === 3, "партія 4 зменшилась на 2 (брак)");
  const defectCons = db.prepare("SELECT * FROM inventory_consumptions WHERE base_product_id=? AND ref_type='defect'").get(p4.bpId);
  ok(!!defectCons && defectCons.status === "lost" && defectCons.qty === 2 && defectCons.unit_cost === 12,
    "брак списаний у втрати по вартості партії: 2×12=24 (" + JSON.stringify(defectCons) + ")");
  cleanupProduct(p4);

  // ══ 5. Недостача переобліку списує партію у втрати ══
  const p5 = makeProduct("Recount");
  seedStockBase(p5, 5);
  const lot5 = seedLot(p5, 5, 8, "2026-08-01 09:00:00");
  r = await api("/api/recount/apply", { method: "POST", body: JSON.stringify({ adjustments: [{ base_product_id: p5.bpId, size_id: p5.sizeId, actual_quantity: 3 }] }) });
  ok(r.s === 200, "переоблік застосовано (" + JSON.stringify(r.b) + ")");
  ok(db.prepare("SELECT qty_left FROM inventory_lots WHERE id=?").get(lot5).qty_left === 3, "партія 5 зменшилась на недостачу 2 (5-3)");
  const recountCons = db.prepare("SELECT * FROM inventory_consumptions WHERE base_product_id=? AND ref_type='recount'").get(p5.bpId);
  ok(!!recountCons && recountCons.status === "lost" && recountCons.qty === 2 && recountCons.unit_cost === 8,
    "недостача списана у втрати по вартості партії: 2×8=16 (" + JSON.stringify(recountCons) + ")");

  // Перестача (surplus) НЕ вигадує вартість: жодної нової партії, наявна не займана.
  r = await api("/api/recount/apply", { method: "POST", body: JSON.stringify({ adjustments: [{ base_product_id: p5.bpId, size_id: p5.sizeId, actual_quantity: 9 }] }) });
  ok(r.s === 200, "перестача застосована (" + JSON.stringify(r.b) + ")");
  const lotsAfterSurplus = db.prepare("SELECT COUNT(*) c FROM inventory_lots WHERE base_product_id=?").get(p5.bpId).c;
  ok(lotsAfterSurplus === 1, "перестача не породила нову партію — вартість не вигадується (" + lotsAfterSurplus + " партій)");
  ok(db.prepare("SELECT qty_left FROM inventory_lots WHERE id=?").get(lot5).qty_left === 3, "наявна партія перестачею не займана");
  cleanupProduct(p5);
})();

// Переоблік не має спалювати вартість товару, який лежить на полиці.
// Сценарій із життя: щоденний переоблік, під час якого дропер робить
// замовлення. Товар ще на полиці — його лише зарезервували, — тож фізичної
// недостачі немає, і жодна партія списуватись не повинна.
const { api, ok, login } = require("../finance/_helpers");
const { checkInvariant } = require("./_invariant");
const db = require("../../node_modules/better-sqlite3")(process.env.DB_PATH || "/tmp/fin-test.db");

(async () => {
  await login("admin");

  // ── фікстури: товар із партією на 10 шт по 100₴ ─────────────────
  const catId = db.prepare("INSERT INTO categories(name)VALUES('__T6iCat')").run().lastInsertRowid;
  const modelId = db.prepare("INSERT INTO models(name,category_id)VALUES('__T6iModel',?)").run(catId).lastInsertRowid;
  const bpId = db.prepare("INSERT INTO base_products(model_id,name)VALUES(?,'__T6iBP')").run(modelId).lastInsertRowid;
  const varId = db.prepare("INSERT INTO variations(base_product_id,name)VALUES(?,'__T6iVar')").run(bpId).lastInsertRowid;
  const sizeId = db.prepare("SELECT id FROM sizes LIMIT 1").get().id;
  db.prepare("INSERT INTO stock_base(base_product_id,size_id,quantity,quantity_actual)VALUES(?,?,10,10)").run(bpId, sizeId);
  db.prepare(`INSERT INTO inventory_lots(base_product_id,size_id,qty_left,unit_cost,source,shelf,valued)
    VALUES(?,?,10,100,'purchase','base',1)`).run(bpId, sizeId);

  checkInvariant(ok, "старт", bpId, sizeId);

  // ── переоблік із замовленням під час заморозки ──────────────────
  const sessId = db.prepare(`INSERT INTO recount_sessions(category_id,status,scope,started_by)
    VALUES(NULL,'active','base',1)`).run().lastInsertRowid;
  db.prepare("UPDATE stock_base SET recount_session_id=? WHERE base_product_id=? AND size_id=?").run(sessId, bpId, sizeId);

  // Замовлення, зроблене під час заморозки: списану кількість воно не
  // зменшило (позиція заморожена), товар фізично лежить на полиці.
  const dropId = db.prepare("SELECT id FROM users WHERE role='dropshipper' LIMIT 1").get().id;
  const ordId = db.prepare(`INSERT INTO orders(dropshipper_id,client_name,status,total_drop_price)
    VALUES(?,'__T6iOrder','new',0)`).run(dropId).lastInsertRowid;
  db.prepare(`INSERT INTO order_items(order_id,variation_id,size_id,quantity,recount_session_id)
    VALUES(?,?,?,3,?)`).run(ordId, varId, sizeId, sessId);

  const lossBefore = db.prepare(`SELECT COUNT(*) c FROM inventory_consumptions WHERE base_product_id=? AND status='lost'`).get(bpId).c;

  // Порахували 10 — рівно стільки, скільки й лежить.
  const r = await api("/api/recount/apply", { method: "POST", body: JSON.stringify({
    adjustments: [{ base_product_id: bpId, size_id: sizeId, actual_quantity: 10 }] }) });
  ok(r.s === 200, "переоблік застосовано (" + r.s + ")");

  const lossAfter = db.prepare(`SELECT COUNT(*) c FROM inventory_consumptions WHERE base_product_id=? AND status='lost'`).get(bpId).c;
  ok(lossAfter === lossBefore, "фізичної недостачі не було — вартість не списана (списань: " + (lossAfter - lossBefore) + ")");

  const lots = db.prepare("SELECT COALESCE(SUM(qty_left),0) q FROM inventory_lots WHERE base_product_id=? AND shelf='base'").get(bpId).q;
  ok(lots === 10, "партії лишились цілими (" + lots + " з 10)");
  checkInvariant(ok, "після переобліку із замовленням", bpId, sizeId);

  // ── контроль: справжня недостача таки списується ────────────────
  const r2 = await api("/api/recount/apply", { method: "POST", body: JSON.stringify({
    adjustments: [{ base_product_id: bpId, size_id: sizeId, actual_quantity: 8 }] }) });
  ok(r2.s === 200, "другий переоблік застосовано (" + r2.s + ")");
  const lots2 = db.prepare("SELECT COALESCE(SUM(qty_left),0) q FROM inventory_lots WHERE base_product_id=? AND shelf='base'").get(bpId).q;
  ok(lots2 === 8, "справжня недостача списала рівно 2 шт (лишилось " + lots2 + ")");
  checkInvariant(ok, "після справжньої недостачі", bpId, sizeId);

  // ── прибирання ─────────────────────────────────────────────────
  db.prepare("DELETE FROM inventory_consumptions WHERE base_product_id=?").run(bpId);
  db.prepare("DELETE FROM inventory_lots WHERE base_product_id=?").run(bpId);
  db.prepare("DELETE FROM order_items WHERE order_id=?").run(ordId);
  db.prepare("DELETE FROM orders WHERE id=?").run(ordId);
  db.prepare("DELETE FROM stock_base WHERE base_product_id=?").run(bpId);
  db.prepare("DELETE FROM recount_items WHERE session_id=?").run(sessId);
  db.prepare("DELETE FROM recount_sessions WHERE id=?").run(sessId);
  db.prepare("DELETE FROM variations WHERE id=?").run(varId);
  db.prepare("DELETE FROM base_products WHERE id=?").run(bpId);
  db.prepare("DELETE FROM models WHERE id=?").run(modelId);
  db.prepare("DELETE FROM categories WHERE id=?").run(catId);
})();

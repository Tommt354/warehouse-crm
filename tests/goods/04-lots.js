// Крій → склад, партії готового товару. Стиль — за зразком tests/goods/03-cut-cost.js:
// прямі фікстури в базі, рух товару через наявні маршрути (stock-cuts/incoming,
// stock/incoming-bulk), перевірка через прямі SELECT.
const { api, ok, login } = require("../finance/_helpers");
const db = require("../../node_modules/better-sqlite3")(process.env.DB_PATH || "/tmp/fin-test.db");
const round2 = v => Math.round((v || 0) * 100) / 100;

(async () => {
  await login("admin");

  // ── фікстури: товар, розмір, цех ───────────────────────────────
  const catId = db.prepare("INSERT INTO categories(name)VALUES('__T4Cat')").run().lastInsertRowid;
  const modelId = db.prepare("INSERT INTO models(name,category_id)VALUES('__T4Model',?)").run(catId).lastInsertRowid;
  const bpId = db.prepare("INSERT INTO base_products(model_id,name)VALUES(?,'__T4BP')").run(modelId).lastInsertRowid;
  const sizeId = db.prepare("SELECT id FROM sizes LIMIT 1").get().id;
  const wsId = db.prepare("INSERT INTO workshops(name)VALUES('__T4Workshop')").run().lastInsertRowid;
  db.prepare("INSERT INTO stock_base(base_product_id,size_id,quantity,quantity_actual)VALUES(?,?,0,0)").run(bpId, sizeId);

  // Рулон тканини для оцінки партії крою А.
  const matId = db.prepare("INSERT INTO materials(name,unit)VALUES('__T4Тканина','kg')").run().lastInsertRowid;
  const lotId = db.prepare(`INSERT INTO material_lots(material_id,color,roll_no,qty_total,qty_left,price_usd,fx_rate,price_uah)
    VALUES(?,?,?,?,?,?,?,?)`).run(matId, "чорний", "R-T4", 50, 50, 5, 20, 100).lastInsertRowid; // 100 ₴/кг

  // ── партія крою А: оцінена (10 шт, 5 кг × 100 ₴/кг = 500 ₴, без пошиву/фурнітури) ──
  let r = await api("/api/stock-cuts/incoming", {
    method: "POST",
    body: JSON.stringify({ base_product_id: bpId, workshop_id: wsId, items: [{ size_id: sizeId, quantity: 10 }] })
  });
  ok(r.s === 200, "партія крою А додана (" + JSON.stringify(r.b) + ")");
  const cutA = db.prepare("SELECT * FROM cut_incoming WHERE base_product_id=? ORDER BY id DESC LIMIT 1").get(bpId);
  ok(cutA.qty_left === 10, "qty_left партії А виставлено при вставці (" + cutA.qty_left + ")");

  r = await api(`/api/goods/cuts/${cutA.id}/value`, {
    method: "POST",
    body: JSON.stringify({ usages: [{ lot_id: lotId, qty: 5 }], sewing_price: 0, notions_cost: 0 })
  });
  ok(r.s === 200 && r.b.unit_cost === 50, "партія А оцінена, unit_cost=50 (" + JSON.stringify(r.b) + ")");

  // ── партія крою Б: НЕ оцінена (6 шт) ────────────────────────────
  r = await api("/api/stock-cuts/incoming", {
    method: "POST",
    body: JSON.stringify({ base_product_id: bpId, workshop_id: wsId, items: [{ size_id: sizeId, quantity: 6 }] })
  });
  ok(r.s === 200, "партія крою Б додана (" + JSON.stringify(r.b) + ")");
  const cutB = db.prepare("SELECT * FROM cut_incoming WHERE base_product_id=? AND id!=? ORDER BY id DESC LIMIT 1").get(bpId, cutA.id);
  ok(!cutB.valued, "партія Б лишилась неоціненою");

  // ── 1. крій А → база: партія складу з тією ж unit_cost, сума не змінюється ──
  const totalBefore = round2(cutA.qty_left === undefined ? 0 : db.prepare("SELECT qty_left,unit_cost FROM cut_incoming WHERE id=?").get(cutA.id).qty_left * 50);
  r = await api("/api/stock/incoming-bulk", {
    method: "POST",
    body: JSON.stringify({ base_product_id: bpId, items: [{ size_id: sizeId, quantity: 10 }] })
  });
  ok(r.s === 200, "крій А → база пройшло (" + JSON.stringify(r.b) + ")");

  const cutAAfter = db.prepare("SELECT qty_left,unit_cost FROM cut_incoming WHERE id=?").get(cutA.id);
  ok(cutAAfter.qty_left === 0, "qty_left партії крою А обнулився (" + cutAAfter.qty_left + ")");

  const lotFromA = db.prepare("SELECT * FROM inventory_lots WHERE base_product_id=? AND size_id=? AND source='cut' AND ref_id=?").get(bpId, sizeId, cutA.id);
  ok(!!lotFromA, "партія складу з крою А створена");
  ok(lotFromA.unit_cost === 50, "unit_cost партії складу = unit_cost партії крою (" + lotFromA.unit_cost + ")");
  ok(lotFromA.qty_left === 10, "qty_left партії складу = перенесена кількість (" + lotFromA.qty_left + ")");
  ok(lotFromA.shelf === "base" && lotFromA.valued === 1, "партія на полиці бази, оцінена");

  const totalAfter = round2(cutAAfter.qty_left * cutAAfter.unit_cost + lotFromA.qty_left * lotFromA.unit_cost);
  ok(totalBefore === totalAfter && totalAfter === 500, "загальна вартість крій+склад не змінилась при переміщенні (" + totalBefore + " -> " + totalAfter + ")");

  // ── 2. крій Б (неоцінений) → база: партія складу неоцінена, видима в unvalued ──
  r = await api("/api/stock/incoming-bulk", {
    method: "POST",
    body: JSON.stringify({ base_product_id: bpId, items: [{ size_id: sizeId, quantity: 6 }] })
  });
  ok(r.s === 200, "крій Б → база пройшло (" + JSON.stringify(r.b) + ")");

  const lotFromB = db.prepare("SELECT * FROM inventory_lots WHERE base_product_id=? AND size_id=? AND source='cut' AND ref_id=?").get(bpId, sizeId, cutB.id);
  ok(!!lotFromB, "партія складу з крою Б створена");
  ok(lotFromB.unit_cost === 0 && lotFromB.valued === 0, "партія складу з неоціненого крою лишається неоціненою, unit_cost=0 (" + JSON.stringify(lotFromB) + ")");

  r = await api("/api/goods/lots-stock?unvalued=1");
  ok(r.s === 200 && r.b.lots.some(l => l.id === lotFromB.id), "неоцінена партія видима в списку unvalued");
  ok(!r.b.lots.some(l => l.id === lotFromA.id), "оцінена партія А НЕ потрапляє у список unvalued");

  // ── 3. закупний товар: собівартість із картки товару (cost_price) ──
  const bpPurchaseId = db.prepare("INSERT INTO base_products(model_id,name,cost_price)VALUES(?,?,?)").run(modelId, "__T4BPPurchase", 75).lastInsertRowid;
  db.prepare("INSERT INTO stock_base(base_product_id,size_id,quantity,quantity_actual)VALUES(?,?,0,0)").run(bpPurchaseId, sizeId);
  r = await api("/api/stock/incoming-bulk", {
    method: "POST",
    body: JSON.stringify({ base_product_id: bpPurchaseId, no_workshop: true, items: [{ size_id: sizeId, quantity: 4 }] })
  });
  ok(r.s === 200, "прихід закупного товару пройшов (" + JSON.stringify(r.b) + ")");
  const purchaseLot = db.prepare("SELECT * FROM inventory_lots WHERE base_product_id=? AND source='purchase'").get(bpPurchaseId);
  ok(!!purchaseLot && purchaseLot.unit_cost === 75 && purchaseLot.valued === 1, "партія закупки взяла собівартість із картки товару (" + JSON.stringify(purchaseLot) + ")");

  // Закупний товар без вписаної собівартості (cost_price=0) — партія чесно неоцінена.
  const bpPurchase2Id = db.prepare("INSERT INTO base_products(model_id,name)VALUES(?,?)").run(modelId, "__T4BPPurchase2").lastInsertRowid;
  db.prepare("INSERT INTO stock_base(base_product_id,size_id,quantity,quantity_actual)VALUES(?,?,0,0)").run(bpPurchase2Id, sizeId);
  r = await api("/api/stock/incoming-bulk", {
    method: "POST",
    body: JSON.stringify({ base_product_id: bpPurchase2Id, no_workshop: true, items: [{ size_id: sizeId, quantity: 3 }] })
  });
  ok(r.s === 200, "прихід закупного товару без ціни пройшов (" + JSON.stringify(r.b) + ")");
  const purchaseLot2 = db.prepare("SELECT * FROM inventory_lots WHERE base_product_id=? AND source='purchase'").get(bpPurchase2Id);
  ok(!!purchaseLot2 && purchaseLot2.valued === 0, "без cost_price партія лишається неоціненою, а не отримує тихий нуль-як-ціну");

  // ── 4. головна перевірка цілісності: сума qty_left = stock_base.quantity_actual ──
  const stockRow = db.prepare("SELECT quantity_actual FROM stock_base WHERE base_product_id=? AND size_id=?").get(bpId, sizeId);
  const lotsSum = db.prepare("SELECT COALESCE(SUM(qty_left),0) as s FROM inventory_lots WHERE base_product_id=? AND size_id=? AND shelf='base'").get(bpId, sizeId).s;
  ok(stockRow.quantity_actual === 16, "фактичний залишок бази = 10+6=16 (" + stockRow.quantity_actual + ")");
  ok(lotsSum === 16 && lotsSum === stockRow.quantity_actual, "сума qty_left партій збігається з stock_base.quantity_actual (" + lotsSum + " = " + stockRow.quantity_actual + ")");

  // ── доступ ──────────────────────────────────────────────────────
  await login("packer");
  r = await api("/api/goods/lots-stock");
  ok(r.s === 403, "не-адміну закрито: lots-stock (" + r.s + ")");

  // ── прибирання ───────────────────────────────────────────────────
  await login("admin");
  db.prepare("DELETE FROM inventory_lots WHERE base_product_id IN (?,?,?)").run(bpId, bpPurchaseId, bpPurchase2Id);
  db.prepare("DELETE FROM inventory_consumptions WHERE base_product_id IN (?,?,?)").run(bpId, bpPurchaseId, bpPurchase2Id);
  db.prepare("DELETE FROM stock_cuts WHERE base_product_id=?").run(bpId);
  db.prepare("DELETE FROM stock_log WHERE base_product_id IN (?,?,?)").run(bpId, bpPurchaseId, bpPurchase2Id);
  db.prepare("DELETE FROM stock_incoming WHERE base_product_id IN (?,?,?)").run(bpId, bpPurchaseId, bpPurchase2Id);
  db.prepare("DELETE FROM cut_material_usage WHERE cut_incoming_id=?").run(cutA.id);
  db.prepare("DELETE FROM notions_pool WHERE ref_type='cut_incoming' AND ref_id IN (?,?)").run(cutA.id, cutB.id);
  db.prepare("DELETE FROM cut_incoming WHERE id IN (?,?)").run(cutA.id, cutB.id);
  db.prepare("DELETE FROM stock_base WHERE base_product_id IN (?,?,?)").run(bpId, bpPurchaseId, bpPurchase2Id);
  db.prepare("DELETE FROM base_products WHERE id IN (?,?,?)").run(bpId, bpPurchaseId, bpPurchase2Id);
  db.prepare("DELETE FROM models WHERE id=?").run(modelId);
  db.prepare("DELETE FROM categories WHERE id=?").run(catId);
  db.prepare("DELETE FROM workshops WHERE id=?").run(wsId);
  db.prepare("DELETE FROM material_lots WHERE id=?").run(lotId);
  db.prepare("DELETE FROM materials WHERE id=?").run(matId);
})();

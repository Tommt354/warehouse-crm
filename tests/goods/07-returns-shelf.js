// Полиця повернень має жити за тими самими правилами, що й склад: кількість
// і вартість рухаються разом. До цього вона була поза лінією вартості —
// обнулив полицю переобліком, а гроші висіли в «Товар зараз» назавжди.
const { api, ok, login } = require("../finance/_helpers");
const { checkInvariant } = require("./_invariant");
const db = require("../../node_modules/better-sqlite3")(process.env.DB_PATH || "/tmp/fin-test.db");

const lotsOn = (bp, sz) => db.prepare(`SELECT COALESCE(SUM(qty_left),0) q, COALESCE(SUM(qty_left*unit_cost),0) c
  FROM inventory_lots WHERE base_product_id=? AND size_id=? AND shelf='returns'`).get(bp, sz);

(async () => {
  await login("admin");

  const catId = db.prepare("INSERT INTO categories(name)VALUES('__T7rCat')").run().lastInsertRowid;
  const modelId = db.prepare("INSERT INTO models(name,category_id,cost_price)VALUES('__T7rModel',?,120)").run(catId).lastInsertRowid;
  const bpId = db.prepare("INSERT INTO base_products(model_id,name,cost_price)VALUES(?,'__T7rBP',150)").run(modelId).lastInsertRowid;
  const printId = db.prepare("INSERT INTO prints(name)VALUES('__T7rPrint')").run().lastInsertRowid;
  const varId = db.prepare("INSERT INTO variations(base_product_id,print_id,name)VALUES(?,?,'__T7rVar')").run(bpId, printId).lastInsertRowid;
  const sizeId = db.prepare("SELECT id FROM sizes LIMIT 1").get().id;
  db.prepare("INSERT INTO stock_base(base_product_id,size_id,quantity,quantity_actual)VALUES(?,?,0,0)").run(bpId, sizeId);
  db.prepare("INSERT INTO stock_returns(variation_id,size_id,quantity)VALUES(?,?,0)").run(varId, sizeId);

  // ── ручне додавання повернення ─────────────────────────────────
  let r = await api("/api/stock-returns/add", { method: "POST", body: JSON.stringify({ variation_id: varId, size_id: sizeId, quantity: 10 }) });
  ok(r.s === 200, "повернення додано вручну (" + r.s + ")");
  let l = lotsOn(bpId, sizeId);
  ok(l.q === 10, "партія повернень з'явилась (" + l.q + ")");
  ok(l.c === 1500, "оцінена собівартістю з картки: 10 × 150 = " + l.c);
  checkInvariant(ok, "після ручного додавання", bpId, sizeId);

  // ── списання з повернень ───────────────────────────────────────
  r = await api("/api/stock-returns/write-off", { method: "POST", body: JSON.stringify({ variation_id: varId, size_id: sizeId, quantity: 4 }) });
  ok(r.s === 200, "списання з повернень пройшло (" + r.s + ")");
  l = lotsOn(bpId, sizeId);
  ok(l.q === 6, "партії зменшились рівно на списане (" + l.q + ")");
  checkInvariant(ok, "після списання", bpId, sizeId);
  const lost = db.prepare(`SELECT COALESCE(SUM(qty*unit_cost),0) c FROM inventory_consumptions
    WHERE base_product_id=? AND status='lost'`).get(bpId).c;
  ok(lost === 600, "вартість списаного пішла у втрати: 4 × 150 = " + lost);

  // ── ручне виставлення залишку ──────────────────────────────────
  r = await api("/api/stock-returns/set", { method: "POST", body: JSON.stringify({ variation_id: varId, size_id: sizeId, quantity: 2 }) });
  ok(r.s === 200, "залишок виставлено вручну (" + r.s + ")");
  l = lotsOn(bpId, sizeId);
  ok(l.q === 2, "партії підтягнулись під новий залишок (" + l.q + ")");
  checkInvariant(ok, "після ручного виставлення", bpId, sizeId);

  // ── переоблік повернень (обнулення полиці) ─────────────────────
  r = await api("/api/stock-returns/clear", { method: "POST", body: JSON.stringify({ keep: [] }) });
  ok(r.s === 200, "переоблік повернень пройшов (" + r.s + ")");
  l = lotsOn(bpId, sizeId);
  ok(l.q === 0, "полиця обнулена і вартість не висить (" + l.q + " шт, " + l.c + "₴)");
  checkInvariant(ok, "після переобліку повернень", bpId, sizeId);

  // ── звірка бачить полицю повернень ─────────────────────────────
  db.prepare("UPDATE stock_returns SET quantity=5 WHERE variation_id=? AND size_id=?").run(varId, sizeId);
  const rec = await api("/api/goods/reconcile");
  ok(rec.s === 200, "звірка віддається (" + rec.s + ")");
  const mine = (rec.b.mismatches_returns || []).find(m => m.base_product_id === bpId);
  ok(!!mine && mine.fact === 5 && mine.lots === 0, "розходження на полиці повернень видно у звірці (" + JSON.stringify(mine) + ")");
  db.prepare("UPDATE stock_returns SET quantity=0 WHERE variation_id=? AND size_id=?").run(varId, sizeId);

  // ── прибирання ─────────────────────────────────────────────────
  db.prepare("DELETE FROM inventory_consumptions WHERE base_product_id=?").run(bpId);
  db.prepare("DELETE FROM inventory_lots WHERE base_product_id=?").run(bpId);
  db.prepare("DELETE FROM stock_returns WHERE variation_id=?").run(varId);
  db.prepare("DELETE FROM stock_base WHERE base_product_id=?").run(bpId);
  db.prepare("DELETE FROM stock_log WHERE base_product_id=?").run(bpId);
  db.prepare("DELETE FROM recount_items WHERE base_product_id=?").run(bpId);
  db.prepare("DELETE FROM variations WHERE id=?").run(varId);
  db.prepare("DELETE FROM prints WHERE id=?").run(printId);
  db.prepare("DELETE FROM base_products WHERE id=?").run(bpId);
  db.prepare("DELETE FROM models WHERE id=?").run(modelId);
  db.prepare("DELETE FROM categories WHERE id=?").run(catId);
})();

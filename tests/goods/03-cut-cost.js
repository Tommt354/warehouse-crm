// Списання тканини на крій і вартість партії крою. Стиль — за зразком
// tests/finance/04-expenses.js: прямі фікстури в базі (крій, рулони, товар
// уже існують як сутності — тут перевіряється лише оцінка вартості).
const { api, ok, login } = require("../finance/_helpers");
const db = require("../../node_modules/better-sqlite3")(process.env.DB_PATH || "/tmp/fin-test.db");
const round2 = v => Math.round((v || 0) * 100) / 100;

(async () => {
  await login("admin");

  // ── фікстури ────────────────────────────────────────────────────
  const matId = db.prepare("INSERT INTO materials(name,unit)VALUES('__T3Тканина','kg')").run().lastInsertRowid;
  // price_usd × fx_rate підібрані так, щоб price_uah вийшла рівно 258 і 215
  // ₴/кг — саме числа з опису задачі в плані.
  const lot1 = db.prepare(`INSERT INTO material_lots(material_id,color,roll_no,qty_total,qty_left,price_usd,fx_rate,price_uah)
    VALUES(?,?,?,?,?,?,?,?)`).run(matId, "чорний", "R-10", 50, 50, 6, 43, 258).lastInsertRowid;
  const lot2 = db.prepare(`INSERT INTO material_lots(material_id,color,roll_no,qty_total,qty_left,price_usd,fx_rate,price_uah)
    VALUES(?,?,?,?,?,?,?,?)`).run(matId, "чорний", "R-11", 50, 50, 5, 43, 215).lastInsertRowid;

  const catId = db.prepare("INSERT INTO categories(name)VALUES('__T3Cat')").run().lastInsertRowid;
  const modelId = db.prepare("INSERT INTO models(name,category_id)VALUES('__T3Model',?)").run(catId).lastInsertRowid;
  const bpId = db.prepare("INSERT INTO base_products(model_id,name,notions_cost,sewing_cost)VALUES(?,?,?,?)")
    .run(modelId, "__T3BP", 15, 40).lastInsertRowid;
  const sizeId = db.prepare("SELECT id FROM sizes LIMIT 1").get().id;
  const wsId = db.prepare("INSERT INTO workshops(name)VALUES('__T3Workshop')").run().lastInsertRowid;
  const cutIds = [];
  function makeCut(qty) {
    const id = db.prepare("INSERT INTO cut_incoming(base_product_id,size_id,workshop_id,quantity)VALUES(?,?,?,?)")
      .run(bpId, sizeId, wsId, qty).lastInsertRowid;
    cutIds.push(id);
    return id;
  }

  // ── 1. списання одного рулону, ставки з тіла запиту ───────────────
  const cut1 = makeCut(20);
  let r = await api(`/api/goods/cuts/${cut1}/value`, {
    method: "POST", body: JSON.stringify({ usages: [{ lot_id: lot1, qty: 13.6 }], sewing_price: 40, notions_cost: 15 })
  });
  ok(r.s === 200, "оцінка партії пройшла (" + JSON.stringify(r.b) + ")");
  ok(Math.abs(r.b.material_cost - 3508.8) < 0.001, "13.6 кг × 258 ₴/кг = 3508.80 ₴ (" + r.b.material_cost + ")");
  let lotRow = db.prepare("SELECT qty_left FROM material_lots WHERE id=?").get(lot1);
  ok(Math.abs(lotRow.qty_left - (50 - 13.6)) < 0.001, "qty_left рулону зменшився рівно на списане (" + lotRow.qty_left + ")");

  const expTotal1 = round2(3508.8 + 40 * 20 + 15 * 20); // матеріал + пошив×кількість + фурнітура×кількість
  const expUnit1 = round2(expTotal1 / 20);
  let cutRow = db.prepare("SELECT * FROM cut_incoming WHERE id=?").get(cut1);
  ok(cutRow.valued === 1, "партія позначена оціненою");
  ok(Math.abs(cutRow.sewing_cost - 800) < 0.001, "sewing_cost = ставка × кількість = 800 (" + cutRow.sewing_cost + ")");
  ok(Math.abs(cutRow.notions_cost - 300) < 0.001, "notions_cost = норматив × кількість = 300 (" + cutRow.notions_cost + ")");
  ok(Math.abs(cutRow.unit_cost - expUnit1) < 0.001, "unit_cost = разом÷кількість = " + expUnit1 + " (" + cutRow.unit_cost + ")");

  const pool1 = db.prepare("SELECT * FROM notions_pool WHERE ref_type='cut_incoming' AND ref_id=?").get(cut1);
  ok(pool1 && Math.abs(pool1.amount + 300) < 0.001, "нарахування фурнітури пише мінус 300 у котел (" + (pool1 && pool1.amount) + ")");

  // ── 2. списати більше залишку не можна ─────────────────────────
  const cut2 = makeCut(5);
  const leftBefore = db.prepare("SELECT qty_left FROM material_lots WHERE id=?").get(lot1).qty_left;
  r = await api(`/api/goods/cuts/${cut2}/value`, { method: "POST", body: JSON.stringify({ usages: [{ lot_id: lot1, qty: 999 }] }) });
  ok(r.s === 400, "списання понад залишок відхилене (" + r.s + ")");
  const leftAfter = db.prepare("SELECT qty_left FROM material_lots WHERE id=?").get(lot1).qty_left;
  ok(leftAfter === leftBefore, "відхилена спроба не зачепила залишок рулону (" + leftAfter + ")");
  cutRow = db.prepare("SELECT valued FROM cut_incoming WHERE id=?").get(cut2);
  ok(!cutRow.valued, "партія лишилась неоціненою після відмови");

  // ── 3. брак усередині партії: та сама сума матеріалу, менша кількість
  // → вища собівартість одиниці. Ставки пошиву/фурнітури свідомо нульові —
  // ізолюємо саме ефект дільника (кількості), а не додаткові доданки.
  const cut3a = makeCut(10);
  r = await api(`/api/goods/cuts/${cut3a}/value`, { method: "POST", body: JSON.stringify({ usages: [{ lot_id: lot2, qty: 5 }], sewing_price: 0, notions_cost: 0 }) });
  ok(r.s === 200, "партія А (10 придатних шт) оцінена (" + JSON.stringify(r.b) + ")");
  const unitA = r.b.unit_cost;

  const cut3b = makeCut(5);
  r = await api(`/api/goods/cuts/${cut3b}/value`, { method: "POST", body: JSON.stringify({ usages: [{ lot_id: lot2, qty: 5 }], sewing_price: 0, notions_cost: 0 }) });
  ok(r.s === 200, "партія Б (5 придатних шт, та сама сума матеріалу) оцінена (" + JSON.stringify(r.b) + ")");
  const unitB = r.b.unit_cost;
  ok(unitA === 1075 / 10 && unitB === 1075 / 5, "та сама сума матеріалу поділена на різну кількість (" + unitA + " / " + unitB + ")");
  ok(unitB > unitA, "менша фактична кількість при тій самій сумі → вища собівартість одиниці (" + unitB + " > " + unitA + ")");

  // ── 4. списання з двох рулонів в одній партії ───────────────────
  const cut4 = makeCut(8);
  r = await api(`/api/goods/cuts/${cut4}/value`, {
    method: "POST", body: JSON.stringify({ usages: [{ lot_id: lot1, qty: 2 }, { lot_id: lot2, qty: 3 }], sewing_price: 40, notions_cost: 15 })
  });
  ok(r.s === 200, "списання з двох рулонів пройшло (" + JSON.stringify(r.b) + ")");
  const usageRows = db.prepare("SELECT * FROM cut_material_usage WHERE cut_incoming_id=? ORDER BY lot_id").all(cut4);
  ok(usageRows.length === 2, "два рядки списання (" + usageRows.length + ")");
  ok(usageRows.some(u => u.lot_id === lot1 && Math.abs(u.qty - 2) < 0.001) && usageRows.some(u => u.lot_id === lot2 && Math.abs(u.qty - 3) < 0.001),
    "кожен рядок зі своїм рулоном і кількістю");

  // ── 5. повторна оцінка тієї самої партії — явна відмова, не подвійне списання
  const leftLot1Before = db.prepare("SELECT qty_left FROM material_lots WHERE id=?").get(lot1).qty_left;
  r = await api(`/api/goods/cuts/${cut1}/value`, { method: "POST", body: JSON.stringify({ usages: [{ lot_id: lot1, qty: 1 }] }) });
  ok(r.s === 400, "повторна оцінка вже оціненої партії відхилена (" + r.s + ")");
  const leftLot1After = db.prepare("SELECT qty_left FROM material_lots WHERE id=?").get(lot1).qty_left;
  ok(leftLot1After === leftLot1Before, "тканина не списалась удруге (" + leftLot1After + ")");

  // ── 6. неоцінена партія в unvalued, оцінена зникає ──────────────
  r = await api("/api/goods/cuts/unvalued");
  ok(r.s === 200 && r.b.cuts.some(c => c.id === cut2), "неоцінена партія у списку unvalued");
  ok(!r.b.cuts.some(c => c.id === cut1), "оцінена партія зникла зі списку unvalued");

  // ── доступ ──────────────────────────────────────────────────────
  await login("packer");
  r = await api("/api/goods/cuts/unvalued");
  ok(r.s === 403, "не-адміну закрито: список неоцінених (" + r.s + ")");
  r = await api(`/api/goods/cuts/${cut2}/value`, { method: "POST", body: JSON.stringify({ usages: [{ lot_id: lot1, qty: 1 }] }) });
  ok(r.s === 403, "не-адміну закрито: оцінка партії (" + r.s + ")");

  // ── прибирання ───────────────────────────────────────────────────
  db.prepare(`DELETE FROM cut_material_usage WHERE cut_incoming_id IN (${cutIds.map(() => "?").join(",")})`).run(...cutIds);
  db.prepare(`DELETE FROM notions_pool WHERE ref_type='cut_incoming' AND ref_id IN (${cutIds.map(() => "?").join(",")})`).run(...cutIds);
  db.prepare(`DELETE FROM cut_incoming WHERE id IN (${cutIds.map(() => "?").join(",")})`).run(...cutIds);
  db.prepare("DELETE FROM base_products WHERE id=?").run(bpId);
  db.prepare("DELETE FROM models WHERE id=?").run(modelId);
  db.prepare("DELETE FROM categories WHERE id=?").run(catId);
  db.prepare("DELETE FROM workshops WHERE id=?").run(wsId);
  db.prepare("DELETE FROM material_lots WHERE id IN (?,?)").run(lot1, lot2);
  db.prepare("DELETE FROM materials WHERE id=?").run(matId);
})();

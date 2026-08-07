// Головний інваріант лінії товару: сума залишків партій має дорівнювати
// фактичному залишку, який веде склад. Розійшовшись один раз, ці числа вже
// ніколи не сходяться самі — і саме через відсутність такої перевірки десять
// розходжень свого часу лишились непоміченими. Тому кожен сценарій руху
// товару в тестах закінчується викликом цієї функції.
const db = require("../../node_modules/better-sqlite3")(process.env.DB_PATH || "/tmp/fin-test.db");

// Полиця бази: партії проти stock_base.quantity_actual.
// Полиця повернень: партії проти суми stock_returns по всіх варіаціях товару.
function checkInvariant(ok, label, bpId, sizeId) {
  const lotsBase = db.prepare(`SELECT COALESCE(SUM(qty_left),0) q FROM inventory_lots
    WHERE base_product_id=? AND size_id=? AND shelf='base'`).get(bpId, sizeId).q;
  const stockBase = db.prepare(`SELECT COALESCE(quantity_actual,0) q FROM stock_base
    WHERE base_product_id=? AND size_id=?`).get(bpId, sizeId)?.q || 0;
  ok(lotsBase === stockBase,
    label + " — база: партії " + lotsBase + " = факт " + stockBase);

  const lotsRet = db.prepare(`SELECT COALESCE(SUM(qty_left),0) q FROM inventory_lots
    WHERE base_product_id=? AND size_id=? AND shelf='returns'`).get(bpId, sizeId).q;
  const stockRet = db.prepare(`SELECT COALESCE(SUM(sr.quantity),0) q FROM stock_returns sr
    JOIN variations v ON sr.variation_id=v.id
    WHERE v.base_product_id=? AND sr.size_id=?`).get(bpId, sizeId).q;
  ok(lotsRet === stockRet,
    label + " — повернення: партії " + lotsRet + " = факт " + stockRet);
}

module.exports = { checkInvariant };

// Чистий аркуш для старту обліку: стираємо операційну й фінансову історію,
// але лишаємо каталог товарів і фактичні залишки на полицях — їх власник
// перераховувати руками не буде.
//
// Запуск: node scripts/wipe-fresh-start.js /шлях/до/crm.db
// Без аргументу нічого не робить — щоб випадковий запуск не зачепив базу.
const path = process.argv[2];
if (!path) { console.error("Вкажіть шлях до бази: node scripts/wipe-fresh-start.js /data/crm.db"); process.exit(1); }
const db = require("better-sqlite3")(path);
db.pragma("foreign_keys = OFF");

const before = t => { try { return db.prepare("SELECT COUNT(*) c FROM " + t).get().c } catch (e) { return null } };

// Що стираємо: замовлення й усе, що з них випливає, гроші, виплати, зарплату,
// переобліки, рух товару й партії вартості.
const WIPE = [
  "order_items", "orders",
  "cash_moves", "cash_checks", "expense_payments", "expenses",
  "payout_items", "payout_requests",
  "wholesale_shipments", "wholesale_orders",
  "inventory_consumptions", "inventory_lots",
  "cut_material_usage", "material_lots",
  "notions_pool",
  "recount_items", "recount_sessions",
  "cycle_task_items", "cycle_tasks",
  "stock_log", "stock_incoming", "stock_defect",
  "worker_payroll", "worker_payouts", "shift_workers", "shifts",
  "balance_transactions", "scan_log", "manager_rates",
  "notifications"
];

const counts = {};
WIPE.forEach(t => { counts[t] = before(t); });

db.transaction(() => {
  WIPE.forEach(t => { try { db.prepare("DELETE FROM " + t).run() } catch (e) {} });

  // Баланси дроперів — у нуль разом з їхньою історією.
  try { db.prepare("UPDATE users SET balance=0").run() } catch (e) {}

  // Крій лишається на полицях цехів (stock_cuts), але його вартість скидаємо:
  // старі оцінки спирались на партії тканини, яких більше немає. Власник
  // оцінить ці партії заново, і вони підуть на склад уже з реальною ціною.
  try {
    db.prepare(`UPDATE cut_incoming SET material_cost=0, notions_cost=0, sewing_price=0,
      sewing_cost=0, unit_cost=0, valued=0, qty_left=quantity`).run();
  } catch (e) {}

  // Налаштування обліку — щоб власник виставив їх заново, свідомо й по порядку.
  ["cash_opening_balance", "cash_opening_date", "novapay_percent", "goods_legacy_lots_done"]
    .forEach(k => { try { db.prepare("DELETE FROM settings WHERE key=?").run(k) } catch (e) {} });

  // Партії вартості під фактичні залишки заводимо заново за собівартістю з
  // картки товару: полиці лишились повними, і без партій кожен продаж давав
  // би собівартість нуль. Де в картці нуль — партія лишається неоціненою і
  // видимою у звірці, а не отримує вигадану ціну.
  const seedBase = db.prepare(`INSERT INTO inventory_lots(base_product_id,size_id,qty_left,qty_total,unit_cost,source,shelf,valued)
    SELECT sb.base_product_id, sb.size_id, sb.quantity_actual, sb.quantity_actual,
      COALESCE(NULLIF(bp.cost_price,0), m.cost_price, 0), 'legacy', 'base',
      CASE WHEN COALESCE(NULLIF(bp.cost_price,0), m.cost_price, 0) > 0 THEN 1 ELSE 0 END
    FROM stock_base sb JOIN base_products bp ON sb.base_product_id=bp.id JOIN models m ON bp.model_id=m.id
    WHERE sb.quantity_actual > 0`).run().changes;
  const seedRet = db.prepare(`INSERT INTO inventory_lots(base_product_id,size_id,qty_left,qty_total,unit_cost,source,shelf,valued)
    SELECT v.base_product_id, sr.size_id, SUM(sr.quantity), SUM(sr.quantity),
      COALESCE(NULLIF(bp.cost_price,0), m.cost_price, 0), 'legacy', 'returns',
      CASE WHEN COALESCE(NULLIF(bp.cost_price,0), m.cost_price, 0) > 0 THEN 1 ELSE 0 END
    FROM stock_returns sr JOIN variations v ON sr.variation_id=v.id
    JOIN base_products bp ON v.base_product_id=bp.id JOIN models m ON bp.model_id=m.id
    WHERE sr.quantity > 0 GROUP BY v.base_product_id, sr.size_id`).run().changes;
  db.prepare("INSERT OR REPLACE INTO settings(key,value)VALUES('goods_legacy_lots_done',?)")
    .run(new Date().toISOString().slice(0, 10));

  console.log("Партії заведено заново: база " + seedBase + ", повернення " + seedRet);
})();

console.log("\nСтерто:");
Object.entries(counts).filter(([, c]) => c).forEach(([t, c]) => console.log("  " + t + ": " + c));

console.log("\nЛишилось:");
["models", "base_products", "variations", "users", "workshops", "fin_categories", "suppliers"]
  .forEach(t => console.log("  " + t + ": " + before(t)));
const sb = db.prepare("SELECT COUNT(*) c, COALESCE(SUM(quantity_actual),0) q FROM stock_base").get();
const sr = db.prepare("SELECT COALESCE(SUM(quantity),0) q FROM stock_returns").get();
const sc = db.prepare("SELECT COALESCE(SUM(quantity),0) q FROM stock_cuts").get();
const il = db.prepare("SELECT COUNT(*) c, COALESCE(SUM(qty_left*unit_cost),0) v FROM inventory_lots").get();
console.log("  склад: " + sb.q + " шт, повернення: " + sr.q + " шт, крій: " + sc.q + " шт");
console.log("  партій вартості: " + il.c + " на " + Math.round(il.v * 100) / 100 + "₴");

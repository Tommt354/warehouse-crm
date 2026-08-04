const db = require("../../node_modules/better-sqlite3")(process.env.DB_PATH || "/tmp/fin-test.db");
const need = {
  fin_categories: ["id","name","kind","is_goods","sort_order","active"],
  suppliers: ["id","name","note","active"],
  expenses: ["id","date","amount","category_id","supplier_id","workshop_id","note","created_by","created_at"],
  expense_payments: ["id","expense_id","date","amount","created_at"],
  cash_moves: ["id","date","amount","kind","ref_type","ref_id","wholesale_id","note","created_at"],
  cash_checks: ["id","date","actual_balance","calc_balance","diff","note","created_at"]
};
let bad = 0;
for (const [t, cols] of Object.entries(need)) {
  const have = db.prepare(`PRAGMA table_info(${t})`).all().map(r => r.name);
  const miss = cols.filter(c => !have.includes(c));
  console.log((miss.length ? "❌" : "✅") + " " + t + (miss.length ? " немає: " + miss.join(",") : ""));
  if (miss.length) bad++;
}
const ord = db.prepare("PRAGMA table_info(orders)").all().map(r => r.name);
["delivered_at","refunded_amount","refunded_at"].forEach(c => {
  const ok = ord.includes(c); console.log((ok ? "✅" : "❌") + " orders." + c); if (!ok) bad++;
});
const mgr = db.prepare("PRAGMA table_info(manager_rates)").all().map(r => r.name);
["id","name","percent","from_date"].forEach(c => {
  const okc = mgr.includes(c); console.log((okc ? "✅" : "❌") + " manager_rates." + c); if (!okc) bad++;
});
const cats = db.prepare("SELECT COUNT(*) c FROM fin_categories").get().c;
const goods = db.prepare("SELECT COUNT(*) c FROM fin_categories WHERE is_goods=1").get().c;
const kinds = db.prepare("SELECT COUNT(DISTINCT kind) c FROM fin_categories").get().c;
console.log((cats >= 12 && goods >= 4 && kinds === 4 ? "✅" : "❌") + " категорії засіяні: " + cats + " всього, " + goods + " товарних, " + kinds + " типів логіки");
if (cats < 12 || goods < 4 || kinds !== 4) bad++;
const mismatch = db.prepare("SELECT COUNT(*) c FROM fin_categories WHERE is_goods <> (kind <> 'expense')").get().c;
console.log((mismatch === 0 ? "✅" : "❌") + " is_goods узгоджений з kind (розбіжностей: " + mismatch + ")");
if (mismatch) bad++;
const wsOwn = db.prepare("PRAGMA table_info(workshops)").all().some(r => r.name === "is_own");
console.log((wsOwn ? "✅" : "❌") + " workshops.is_own");
if (!wsOwn) bad++;
const bf = db.prepare("SELECT COUNT(*) c FROM orders WHERE status='delivered' AND COALESCE(delivered_at,'')=''").get().c;
console.log((bf === 0 ? "✅" : "❌") + " delivered_at заповнено для наявних отриманих: лишилось " + bf);
if (bf) bad++;
process.exit(bad ? 1 : 0);

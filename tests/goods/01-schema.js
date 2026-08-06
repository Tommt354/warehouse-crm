// Схема для заходу 2 «Товар»: партії тканини, крою, готового товару.
// Стиль і структура — за зразком tests/finance/01-schema.js.
const db = require("../../node_modules/better-sqlite3")(process.env.DB_PATH || "/tmp/goods-test.db");
const need = {
  materials: ["id", "name", "unit", "active"],
  material_lots: ["id", "material_id", "color", "roll_no", "qty_total", "qty_left", "price_usd", "fx_rate", "price_uah", "supplier_id", "expense_id", "note", "created_at"],
  cut_material_usage: ["id", "cut_incoming_id", "lot_id", "qty", "cost"],
  inventory_lots: ["id", "base_product_id", "size_id", "qty_left", "unit_cost", "source", "ref_id", "created_at"],
  notions_pool: ["id", "date", "amount", "ref_type", "ref_id", "note"]
};
let bad = 0;
for (const [t, cols] of Object.entries(need)) {
  const have = db.prepare(`PRAGMA table_info(${t})`).all().map(r => r.name);
  const miss = cols.filter(c => !have.includes(c));
  console.log((miss.length ? "❌" : "✅") + " " + t + (miss.length ? " немає: " + miss.join(",") : ""));
  if (miss.length) bad++;
}

const bp = db.prepare("PRAGMA table_info(base_products)").all().map(r => r.name);
["notions_cost", "sewing_cost", "material_id", "material_norm"].forEach(c => {
  const okc = bp.includes(c); console.log((okc ? "✅" : "❌") + " base_products." + c); if (!okc) bad++;
});

const ci = db.prepare("PRAGMA table_info(cut_incoming)").all().map(r => r.name);
["material_cost", "notions_cost", "sewing_price", "sewing_cost", "unit_cost", "valued"].forEach(c => {
  const okc = ci.includes(c); console.log((okc ? "✅" : "❌") + " cut_incoming." + c); if (!okc) bad++;
});

const oi = db.prepare("PRAGMA table_info(order_items)").all().map(r => r.name);
const okCogs = oi.includes("cogs");
console.log((okCogs ? "✅" : "❌") + " order_items.cogs"); if (!okCogs) bad++;

// materials.unit приймає лише kg/m — перевіряємо CHECK-обмеженням, а не
// прикладним значенням: вставка з невідомою одиницею має впасти.
try {
  db.prepare("INSERT INTO materials(name,unit) VALUES ('__TestUnitBad','box')").run();
  console.log("❌ materials.unit прийняв невідому одиницю 'box' — CHECK не працює");
  bad++;
} catch (e) {
  console.log("✅ materials.unit відхилив невідому одиницю ('" + e.message + "')");
}
db.prepare("DELETE FROM materials WHERE name='__TestUnitBad'").run();

["kg", "m"].forEach(u => {
  try {
    const id = db.prepare("INSERT INTO materials(name,unit) VALUES (?,?)").run("__TestUnit_" + u, u).lastInsertRowid;
    console.log("✅ materials.unit приймає '" + u + "'");
    db.prepare("DELETE FROM materials WHERE id=?").run(id);
  } catch (e) {
    console.log("❌ materials.unit відхилив дозволену одиницю '" + u + "' (" + e.message + ")");
    bad++;
  }
});

process.exit(bad ? 1 : 0);

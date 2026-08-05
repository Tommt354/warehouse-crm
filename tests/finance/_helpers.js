// Спільні хелпери для тестів фінмодуля: кожна задача підключає той самий
// тестовий сервер і той самий стиль перевірок, тож логіку login/api/ok
// тримаємо в одному місці, а не копіюємо у кожен тест-файл.
// Фіксуємо DB_PATH тут, до першого відкриття з'єднання: якщо якийсь тест
// нижче за течією вимогне db.js напряму (перевірка міграції), він має
// впасти на той самий шлях, а не на дефолтний живий crm.db поруч.
process.env.DB_PATH = process.env.DB_PATH || "/tmp/fin-test.db";
const db = require("../../node_modules/better-sqlite3")(process.env.DB_PATH);
const B = "http://localhost:3100";
let cookie = "";

async function api(u, o = {}) {
  const r = await fetch(B + u, { ...o, headers: { "Content-Type": "application/json", cookie, ...(o.headers || {}) } });
  const sc = r.headers.getSetCookie ? r.headers.getSetCookie() : [];
  if (sc.length) cookie = sc.map(s => s.split(";")[0]).join("; ");
  let b = null; try { b = await r.json() } catch (e) {}
  return { s: r.status, b };
}

const ok = (c, m) => { console.log((c ? "✅" : "❌ FAIL") + " " + m); if (!c) process.exitCode = 1; };

// Скидає збережене cookie й логінить під потрібною роллю (dev quick login).
async function login(role) {
  cookie = "";
  return api("/api/auth/dev-login/" + role, { method: "POST" });
}

// Мінімальний ланцюжок товару (категорія → модель → базовий товар →
// варіація), потрібний, коли тесту треба справжнє замовлення через реальний
// POST /api/orders (а не прямий INSERT у orders), напр. щоб задіяти хук
// finance.onOrderCreated. allow_negative_order=1 (дефолт variations) — тож
// рядок stock_base не потрібен, залишок ніхто не перевіряє.
function createTestProduct(dropPrice) {
  const color = db.prepare("SELECT id FROM colors LIMIT 1").get();
  const catId = db.prepare("INSERT INTO categories(name)VALUES('__TestFin')").run().lastInsertRowid;
  const modelId = db.prepare("INSERT INTO models(name,category_id,drop_price)VALUES('__TestFin',?,?)").run(catId, dropPrice).lastInsertRowid;
  const bpId = db.prepare("INSERT INTO base_products(model_id,color_id,name)VALUES(?,?,'__TestFin')").run(modelId, color ? color.id : null).lastInsertRowid;
  const varId = db.prepare("INSERT INTO variations(base_product_id,name)VALUES(?,'__TestFin')").run(bpId).lastInsertRowid;
  const sizeId = db.prepare("SELECT id FROM sizes LIMIT 1").get().id;
  return { catId, modelId, bpId, varId, sizeId };
}

function removeTestProduct(p) {
  db.prepare("DELETE FROM variations WHERE id=?").run(p.varId);
  db.prepare("DELETE FROM base_products WHERE id=?").run(p.bpId);
  db.prepare("DELETE FROM models WHERE id=?").run(p.modelId);
  db.prepare("DELETE FROM categories WHERE id=?").run(p.catId);
}

module.exports = { B, api, ok, login, createTestProduct, removeTestProduct };

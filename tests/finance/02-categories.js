const { api, ok, login } = require("./_helpers");
// Пряма робота з базою потрібна тому, що ендпоінта створення витрат ще
// немає (він у наступній задачі) — рядок у expenses вставляємо напряму,
// так само як це роблять tests/finance/01-schema.js.
const db = require("../../node_modules/better-sqlite3")(process.env.DB_PATH || "/tmp/fin-test.db");

(async () => {
  await login("admin");
  let r = await api("/api/finance/categories");
  ok(r.s === 200 && r.b.categories.length >= 10, "список категорій: " + (r.b.categories || []).length);

  r = await api("/api/finance/categories", { method: "POST", body: JSON.stringify({ name: "__TestКат", kind: "material" }) });
  ok(r.s === 200 && r.b.id, "категорія створена");
  const id = r.b.id;
  let found = (await api("/api/finance/categories")).b.categories.find(c => c.id === id);
  ok(found && found.kind === "material" && found.is_goods === 1, "material дав is_goods=1 автоматично");

  r = await api("/api/finance/categories/" + id, { method: "PUT", body: JSON.stringify({ name: "__TestКат2", kind: "expense", active: 1 }) });
  ok(r.s === 200, "категорія перейменована");
  found = (await api("/api/finance/categories")).b.categories.find(c => c.id === id);
  ok(found && found.name === "__TestКат2" && found.kind === "expense" && found.is_goods === 0, "зміни збереглись, is_goods перерахувався");

  r = await api("/api/finance/categories", { method: "POST", body: JSON.stringify({ name: "", kind: "expense" }) });
  ok(r.s === 400, "порожня назва не приймається");

  r = await api("/api/finance/categories", { method: "POST", body: JSON.stringify({ name: "__TestКат3", kind: "вигаданий" }) });
  ok(r.s === 400, "невідомий тип логіки не приймається");

  r = await api("/api/finance/categories/" + id, { method: "DELETE" });
  ok(r.s === 200, "категорія видалена");
  r = await api("/api/finance/categories");
  ok(!r.b.categories.some(c => c.id === id), "її більше немає у списку");

  // Категорію, на якій висить хоч одна витрата, видаляти фізично не можна —
  // історія витрат втратила б назву. Перевіряємо саме цю гілку: створюємо
  // окрему категорію, прив'язуємо до неї витрату напряму в базі й дивимось,
  // що DELETE ховає (active=0), а не стирає рядок.
  r = await api("/api/finance/categories", { method: "POST", body: JSON.stringify({ name: "__TestКатВикор", kind: "expense" }) });
  ok(r.s === 200 && r.b.id, "категорія для перевірки приховування створена");
  const usedId = r.b.id;
  const expIns = db.prepare("INSERT INTO expenses(date,amount,category_id) VALUES (?,?,?)")
    .run("2026-08-04", 100, usedId);
  const expId = expIns.lastInsertRowid;

  r = await api("/api/finance/categories/" + usedId, { method: "DELETE" });
  ok(r.s === 200 && r.b.hidden === true, "категорію з витратами не видалено, а сховано (hidden=" + r.b.hidden + ")");
  r = await api("/api/finance/categories");
  ok(!r.b.categories.some(c => c.id === usedId), "схована категорія зникла зі списку активних");
  const rawCat = db.prepare("SELECT active FROM fin_categories WHERE id=?").get(usedId);
  ok(rawCat && rawCat.active === 0, "рядок фізично лишився в fin_categories з active=0");

  db.prepare("DELETE FROM expenses WHERE id=?").run(expId);
  db.prepare("DELETE FROM fin_categories WHERE id=?").run(usedId);

  await login("packer");
  r = await api("/api/finance/categories");
  ok(r.s === 403, "не-адміну закрито (" + r.s + ")");
})();

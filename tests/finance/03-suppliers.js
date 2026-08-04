const { api, ok, login } = require("./_helpers");
const db = require("../../node_modules/better-sqlite3")(process.env.DB_PATH || "/tmp/fin-test.db");

(async () => {
  await login("admin");

  let r = await api("/api/finance/suppliers", { method: "POST", body: JSON.stringify({ name: "__TestПостач", note: "тканина" }) });
  ok(r.s === 200 && r.b.id, "постачальник створений");
  const id = r.b.id;

  r = await api("/api/finance/suppliers");
  const f = r.b.suppliers.find(s => s.id === id);
  ok(f && f.name === "__TestПостач" && f.debt === 0, "у списку, борг нульовий");

  r = await api("/api/finance/suppliers", { method: "POST", body: JSON.stringify({ name: "" }) });
  ok(r.s === 400, "порожня назва не приймається");

  r = await api("/api/finance/suppliers/" + id, { method: "PUT", body: JSON.stringify({ name: "__TestПостач2", note: "", active: 0 }) });
  ok(r.s === 200, "оновлено");
  r = await api("/api/finance/suppliers");
  ok(!r.b.suppliers.some(s => s.id === id), "прихований більше не показується");

  db.prepare("DELETE FROM suppliers WHERE id=?").run(id);

  await login("packer");
  r = await api("/api/finance/suppliers");
  ok(r.s === 403, "не-адміну закрито (" + r.s + ")");
})();

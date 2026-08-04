const { api, ok, login } = require("./_helpers");

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

  await login("packer");
  r = await api("/api/finance/categories");
  ok(r.s === 403, "не-адміну закрито (" + r.s + ")");
})();

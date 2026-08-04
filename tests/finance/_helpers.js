// Спільні хелпери для тестів фінмодуля: кожна задача підключає той самий
// тестовий сервер і той самий стиль перевірок, тож логіку login/api/ok
// тримаємо в одному місці, а не копіюємо у кожен тест-файл.
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

module.exports = { B, api, ok, login };

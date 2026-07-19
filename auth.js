const jwt = require("jsonwebtoken");
const crypto = require("crypto");

let SECRET = process.env.JWT_SECRET;
if (!SECRET) {
  SECRET = crypto.randomBytes(32).toString("hex");
  console.warn("⚠️  JWT_SECRET не задано в env — згенеровано тимчасовий секрет на цей запуск. Токени стануть недійсними після рестарту сервера. Задайте JWT_SECRET у .env для стабільних сесій.");
}

function createToken(user) {
  return jwt.sign({ id: user.id, username: user.username, role: user.role, name: user.name }, SECRET, { expiresIn: "7d" });
}

function verifyToken(token) {
  try { return jwt.verify(token, SECRET); } catch(e) { return null; }
}

function authMiddleware(req, res, next) {
  const token = req.cookies?.token || req.headers.authorization?.replace("Bearer ", "");
  if (!token) return res.status(401).json({ error: "Не авторизований" });
  const user = verifyToken(token);
  if (!user) return res.status(401).json({ error: "Токен недійсний" });
  req.user = user; next();
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) return res.status(403).json({ error: "Недостатньо прав" });
    next();
  };
}

module.exports = { createToken, verifyToken, authMiddleware, requireRole };

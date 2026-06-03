const express = require("express");
const cookieParser = require("cookie-parser");
const bcrypt = require("bcryptjs");
const path = require("path");
const fs = require("fs");
const db = require("./db");
const { createToken, authMiddleware, requireRole } = require("./auth");

const app = express();
const PORT = process.env.PORT || 3000;
const PHOTO_DIR = process.env.DB_PATH ? path.join(path.dirname(process.env.DB_PATH), "photos") : path.join(__dirname, "photos");
if (!fs.existsSync(PHOTO_DIR)) fs.mkdirSync(PHOTO_DIR, { recursive: true });

app.use(express.json({ limit: "10mb" }));
app.use(cookieParser());
app.use("/photos", express.static(PHOTO_DIR));
app.use("/public", express.static(path.join(__dirname, "public")));

// ── AUTH ──────────────────────────────────────────────────────────
app.post("/api/auth/login", (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: "Введіть логін і пароль" });
  const user = db.prepare("SELECT * FROM users WHERE username=? AND active=1").get(username.trim().toLowerCase());
  if (!user || !bcrypt.compareSync(password, user.password_hash)) return res.status(401).json({ error: "Невірний логін або пароль" });
  db.prepare("UPDATE users SET last_login=datetime('now','localtime') WHERE id=?").run(user.id);
  res.cookie("token", createToken(user), { httpOnly: true, maxAge: 7*24*3600000, sameSite: "lax" });
  res.json({ ok: true, user: { id: user.id, username: user.username, role: user.role, name: user.name } });
});
app.get("/api/auth/me", authMiddleware, (req, res) => {
  const u = db.prepare("SELECT id,username,role,name,phone,email,telegram,discount_percent,discount_fixed,worker_role,payout_details FROM users WHERE id=?").get(req.user.id);
  if (!u) return res.status(401).json({ error: "Не знайдено" });
  res.json({ user: u });
});
app.post("/api/auth/logout", (req, res) => { res.clearCookie("token"); res.json({ ok: true }); });

// ── USERS ────────────────────────────────────────────────────────
app.get("/api/users", authMiddleware, requireRole("admin"), (req, res) => {
  const r = req.query.role;
  res.json({ users: r ? db.prepare("SELECT id,username,role,name,phone,email,telegram,discount_percent,discount_fixed,worker_role,worker_rate,active,created_at,last_login FROM users WHERE role=? ORDER BY name").all(r) : db.prepare("SELECT id,username,role,name,phone,email,telegram,discount_percent,discount_fixed,worker_role,worker_rate,active,created_at,last_login FROM users ORDER BY role,name").all() });
});
app.get("/api/users/:id", authMiddleware, requireRole("admin"), (req, res) => {
  const u = db.prepare("SELECT id,username,role,name,phone,email,telegram,discount_percent,discount_fixed,worker_role,worker_rate,payout_details,active FROM users WHERE id=?").get(req.params.id);
  if (!u) return res.status(404).json({ error: "Не знайдено" });
  res.json({ user: u });
});
app.post("/api/users", authMiddleware, requireRole("admin"), (req, res) => {
  const { username, password, role, name, phone, email, telegram, discount_percent, discount_fixed, worker_role, worker_rate } = req.body;
  if (!username || !password || !role) return res.status(400).json({ error: "Логін, пароль і роль обов'язкові" });
  if (password.length < 4) return res.status(400).json({ error: "Мін 4 символи" });
  if (db.prepare("SELECT id FROM users WHERE username=?").get(username.trim().toLowerCase())) return res.status(409).json({ error: "Логін зайнятий" });
  const r = db.prepare("INSERT INTO users(username,password_hash,role,name,phone,email,telegram,discount_percent,discount_fixed,worker_role,worker_rate)VALUES(?,?,?,?,?,?,?,?,?,?,?)").run(username.trim().toLowerCase(),bcrypt.hashSync(password,10),role,(name||"").trim(),(phone||""),(email||""),(telegram||""),parseFloat(discount_percent)||0,parseFloat(discount_fixed)||0,worker_role||"",parseFloat(worker_rate)||0);
  res.json({ ok: true, user: db.prepare("SELECT id,username,role,name FROM users WHERE id=?").get(r.lastInsertRowid) });
});
app.put("/api/users/:id", authMiddleware, requireRole("admin"), (req, res) => {
  const { name, phone, email, telegram, discount_percent, discount_fixed, worker_role, worker_rate, active, password } = req.body;
  db.prepare("UPDATE users SET name=?,phone=?,email=?,telegram=?,discount_percent=?,discount_fixed=?,worker_role=?,worker_rate=?,active=? WHERE id=?").run((name||""),(phone||""),(email||""),(telegram||""),parseFloat(discount_percent)||0,parseFloat(discount_fixed)||0,worker_role||"",parseFloat(worker_rate)||0,active!==undefined?(active?1:0):1,req.params.id);
  if(password&&password.length>=4)db.prepare("UPDATE users SET password_hash=? WHERE id=?").run(bcrypt.hashSync(password,10),req.params.id);
  res.json({ ok: true });
});
app.delete("/api/users/:id", authMiddleware, requireRole("admin"), (req, res) => {
  if(parseInt(req.params.id)===req.user.id)return res.status(400).json({error:"Не можна видалити себе"});
  db.prepare("DELETE FROM users WHERE id=?").run(req.params.id);res.json({ok:true});
});

// ── SETTINGS ─────────────────────────────────────────────────────
app.get("/api/settings", authMiddleware, (req, res) => {
  const s={};db.prepare("SELECT key,value FROM settings").all().forEach(r=>s[r.key]=r.value);res.json({settings:s});
});
app.put("/api/settings", authMiddleware, requireRole("admin"), (req, res) => {
  const st=db.prepare("INSERT OR REPLACE INTO settings(key,value)VALUES(?,?)");
  db.transaction(()=>Object.entries(req.body).forEach(([k,v])=>st.run(k,String(v))))();res.json({ok:true});
});

// ── DIRECTORIES ──────────────────────────────────────────────────
function dirRoutes(table, route) {
  app.get(`/api/${route}`, authMiddleware, (req, res) => {
    const q = req.query.q;
    const items = q ? db.prepare(`SELECT * FROM ${table} WHERE name LIKE ? ORDER BY sort_order,id`).all(`%${q}%`) : db.prepare(`SELECT * FROM ${table} ORDER BY sort_order,id`).all();
    res.json({ items });
  });
  app.post(`/api/${route}`, authMiddleware, requireRole("admin"), (req, res) => {
    const { name, hex_code, photo, sort_order } = req.body;
    if (!name?.trim()) return res.status(400).json({ error: "Назва обов'язкова" });
    const cols=["name","sort_order"],vals=[name.trim(),parseInt(sort_order)||0];
    if(hex_code!==undefined){cols.push("hex_code");vals.push(hex_code)}
    if(photo!==undefined){cols.push("photo");vals.push(photo)}
    const r=db.prepare(`INSERT INTO ${table}(${cols.join(",")})VALUES(${cols.map(()=>"?").join(",")})`).run(...vals);
    res.json({ok:true,item:db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(r.lastInsertRowid)});
  });
  app.put(`/api/${route}/:id`, authMiddleware, requireRole("admin"), (req, res) => {
    const{name,hex_code,photo,sort_order,active}=req.body;const s=[],v=[];
    if(name!==undefined){s.push("name=?");v.push(name.trim())}
    if(hex_code!==undefined){s.push("hex_code=?");v.push(hex_code)}
    if(photo!==undefined){s.push("photo=?");v.push(photo)}
    if(sort_order!==undefined){s.push("sort_order=?");v.push(parseInt(sort_order)||0)}
    if(active!==undefined){s.push("active=?");v.push(active?1:0)}
    if(s.length){v.push(req.params.id);db.prepare(`UPDATE ${table} SET ${s.join(",")} WHERE id=?`).run(...v)}
    res.json({ok:true});
  });
  app.delete(`/api/${route}/:id`, authMiddleware, requireRole("admin"), (req, res) => {
    db.prepare(`DELETE FROM ${table} WHERE id=?`).run(req.params.id);res.json({ok:true});
  });
}
dirRoutes("colors","colors");dirRoutes("sizes","sizes");dirRoutes("prints","prints");dirRoutes("patches","patches");

// ── CATEGORIES ───────────────────────────────────────────────────
app.get("/api/categories", authMiddleware, (req, res) => {
  const parent_id = req.query.parent_id;
  const all = db.prepare("SELECT * FROM categories ORDER BY sort_order,name").all();
  const flat = all;
  // If parent_id specified, return children of that parent
  let children;
  if (parent_id === "" || parent_id === undefined) {
    children = all.filter(c => !c.parent_id);
  } else {
    children = all.filter(c => c.parent_id === parseInt(parent_id));
  }
  // Build breadcrumb
  const breadcrumb = [];
  if (parent_id && parseInt(parent_id)) {
    let cur = all.find(c => c.id === parseInt(parent_id));
    while (cur) {
      breadcrumb.unshift(cur);
      cur = cur.parent_id ? all.find(c => c.id === cur.parent_id) : null;
    }
  }
  res.json({ categories: children, breadcrumb, flat: all });
});

app.post("/api/categories", authMiddleware, requireRole("admin"), (req, res) => {
  const { name, parent_id, photo, hidden_from_drop, sort_order } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: "Назва обов'язкова" });
  const r = db.prepare("INSERT INTO categories(name,parent_id,photo,hidden_from_drop,sort_order)VALUES(?,?,?,?,?)").run(name.trim(),parent_id||null,photo||"",hidden_from_drop?1:0,parseInt(sort_order)||0);
  res.json({ ok: true, category: db.prepare("SELECT * FROM categories WHERE id=?").get(r.lastInsertRowid) });
});

app.put("/api/categories/:id", authMiddleware, requireRole("admin"), (req, res) => {
  const { name, parent_id, photo, hidden_from_drop, sort_order } = req.body;
  const s=[],v=[];
  if(name!==undefined){s.push("name=?");v.push(name.trim())}
  if(parent_id!==undefined){s.push("parent_id=?");v.push(parent_id||null)}
  if(photo!==undefined){s.push("photo=?");v.push(photo)}
  if(hidden_from_drop!==undefined){s.push("hidden_from_drop=?");v.push(hidden_from_drop?1:0)}
  if(sort_order!==undefined){s.push("sort_order=?");v.push(parseInt(sort_order)||0)}
  if(s.length){v.push(req.params.id);db.prepare(`UPDATE categories SET ${s.join(",")} WHERE id=?`).run(...v)}
  res.json({ ok: true });
});

app.delete("/api/categories/:id", authMiddleware, requireRole("admin"), (req, res) => {
  db.prepare("DELETE FROM categories WHERE id=?").run(req.params.id);res.json({ ok: true });
});

// ── PHOTOS ───────────────────────────────────────────────────────
app.post("/api/photos/upload", authMiddleware, (req, res) => {
  const { data } = req.body;
  if (!data) return res.status(400).json({ error: "No data" });
  const m = data.match(/^data:image\/([\w]+);base64,(.+)$/);
  if (!m) return res.status(400).json({ error: "Invalid format" });
  const ext = m[1]==="jpeg"?"jpg":m[1];
  const fname = `${Date.now()}_${Math.random().toString(36).slice(2,8)}.${ext}`;
  fs.writeFileSync(path.join(PHOTO_DIR, fname), Buffer.from(m[2], "base64"));
  res.json({ ok: true, url: `/photos/${fname}` });
});

// ── MODELS ───────────────────────────────────────────────────────
app.get("/api/models", authMiddleware, (req, res) => {
  const models = db.prepare("SELECT m.*,c.name as category_name FROM models m LEFT JOIN categories c ON m.category_id=c.id ORDER BY m.created_at DESC").all();
  models.forEach(m => {
    m.colors = db.prepare("SELECT c.* FROM model_colors mc JOIN colors c ON mc.color_id=c.id WHERE mc.model_id=?").all(m.id);
    m.sizes = db.prepare("SELECT s.* FROM model_sizes ms JOIN sizes s ON ms.size_id=s.id WHERE ms.model_id=?").all(m.id);
    m.prints = db.prepare("SELECT p.* FROM model_prints mp JOIN prints p ON mp.print_id=p.id WHERE mp.model_id=?").all(m.id);
    m.patches = db.prepare("SELECT p.* FROM model_patches mp JOIN patches p ON mp.patch_id=p.id WHERE mp.model_id=?").all(m.id);
    m.workers = db.prepare("SELECT mw.*,u.name as worker_name FROM model_workers mw JOIN users u ON mw.user_id=u.id WHERE mw.model_id=?").all(m.id);
    m.base_products_count = db.prepare("SELECT COUNT(*) as c FROM base_products WHERE model_id=?").get(m.id).c;
    m.variations_count = db.prepare("SELECT COUNT(*) as c FROM variations v JOIN base_products bp ON v.base_product_id=bp.id WHERE bp.model_id=?").get(m.id).c;
  });
  res.json({ models });
});

app.get("/api/models/:id", authMiddleware, (req, res) => {
  const m = db.prepare("SELECT m.*,c.name as category_name FROM models m LEFT JOIN categories c ON m.category_id=c.id WHERE m.id=?").get(req.params.id);
  if (!m) return res.status(404).json({ error: "Не знайдено" });
  m.colors = db.prepare("SELECT c.* FROM model_colors mc JOIN colors c ON mc.color_id=c.id WHERE mc.model_id=?").all(m.id);
  m.sizes = db.prepare("SELECT s.* FROM model_sizes ms JOIN sizes s ON ms.size_id=s.id WHERE ms.model_id=?").all(m.id);
  m.prints = db.prepare("SELECT p.* FROM model_prints mp JOIN prints p ON mp.print_id=p.id WHERE mp.model_id=?").all(m.id);
  m.patches = db.prepare("SELECT p.* FROM model_patches mp JOIN patches p ON mp.patch_id=p.id WHERE mp.model_id=?").all(m.id);
  m.workers = db.prepare("SELECT mw.*,u.name as worker_name FROM model_workers mw JOIN users u ON mw.user_id=u.id WHERE mw.model_id=?").all(m.id);
  m.base_products = db.prepare("SELECT bp.*,cl.name as color_name,cl.hex_code FROM base_products bp LEFT JOIN colors cl ON bp.color_id=cl.id WHERE bp.model_id=? ORDER BY cl.sort_order").all(m.id);
  const modelSizes = db.prepare("SELECT size_id FROM model_sizes WHERE model_id=?").all(m.id).map(r=>r.size_id);
  m.base_products.forEach(bp => {
    bp.stock = db.prepare("SELECT sb.size_id,sb.quantity,s.name as size_name FROM stock_base sb JOIN sizes s ON sb.size_id=s.id WHERE sb.base_product_id=? ORDER BY s.sort_order").all(bp.id);
    bp.variations = db.prepare("SELECT v.*,p.name as print_name,p.photo as print_photo FROM variations v LEFT JOIN prints p ON v.print_id=p.id WHERE v.base_product_id=?").all(bp.id);
    bp.variations.forEach(v => {
      v.stock_returns = db.prepare("SELECT sr.size_id,sr.quantity,s.name as size_name FROM stock_returns sr JOIN sizes s ON sr.size_id=s.id WHERE sr.variation_id=? ORDER BY s.sort_order").all(v.id);
    });
  });
  res.json({ model: m });
});

app.post("/api/models", authMiddleware, requireRole("admin"), (req, res) => {
  const { name, category_id, is_ready_product, cost_price, drop_price, color_ids, size_ids, print_ids, patch_ids, workers } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: "Назва обов'язкова" });
  if (!color_ids?.length) return res.status(400).json({ error: "Оберіть кольори" });
  if (!size_ids?.length) return res.status(400).json({ error: "Оберіть розміри" });
  if (!is_ready_product && !print_ids?.length) return res.status(400).json({ error: "Оберіть принти" });

  const result = db.transaction(() => {
    const r = db.prepare("INSERT INTO models(name,category_id,is_ready_product,cost_price,drop_price)VALUES(?,?,?,?,?)").run(name.trim(),category_id||null,is_ready_product?1:0,parseFloat(cost_price)||0,parseFloat(drop_price)||0);
    const mid = r.lastInsertRowid;
    const lc=db.prepare("INSERT INTO model_colors(model_id,color_id)VALUES(?,?)");
    const ls=db.prepare("INSERT INTO model_sizes(model_id,size_id)VALUES(?,?)");
    const lp=db.prepare("INSERT INTO model_prints(model_id,print_id)VALUES(?,?)");
    const lpa=db.prepare("INSERT INTO model_patches(model_id,patch_id)VALUES(?,?)");
    const lw=db.prepare("INSERT INTO model_workers(model_id,user_id,amount)VALUES(?,?,?)");
    color_ids.forEach(id=>lc.run(mid,id));
    size_ids.forEach(id=>ls.run(mid,id));
    if(print_ids)print_ids.forEach(id=>lp.run(mid,id));
    if(patch_ids)patch_ids.forEach(id=>lpa.run(mid,id));
    if(workers)workers.forEach(w=>lw.run(mid,w.user_id,parseFloat(w.amount)||0));

    const colors=db.prepare("SELECT * FROM colors WHERE id IN("+color_ids.join(",")+")").all();
    const sizes=db.prepare("SELECT * FROM sizes WHERE id IN("+size_ids.join(",")+")").all();
    const prints=print_ids?.length?db.prepare("SELECT * FROM prints WHERE id IN("+print_ids.join(",")+")").all():[];
    const cbp=db.prepare("INSERT INTO base_products(model_id,color_id,name)VALUES(?,?,?)");
    const cv=db.prepare("INSERT INTO variations(base_product_id,print_id,name)VALUES(?,?,?)");
    const csb=db.prepare("INSERT INTO stock_base(base_product_id,size_id,quantity)VALUES(?,?,0)");
    const csr=db.prepare("INSERT INTO stock_returns(variation_id,size_id,quantity)VALUES(?,?,0)");
    let bc=0,vc=0;
    for(const col of colors){
      const bpn=`${name.trim()} ${col.name}`;
      const bp=cbp.run(mid,col.id,bpn);bc++;
      for(const sz of sizes)csb.run(bp.lastInsertRowid,sz.id);
      if(is_ready_product){cv.run(bp.lastInsertRowid,null,bpn);vc++}
      else{for(const pr of prints){const v=cv.run(bp.lastInsertRowid,pr.id,`${bpn} — ${pr.name}`);vc++;for(const sz of sizes)csr.run(v.lastInsertRowid,sz.id)}}
    }
    return{mid,bc,vc};
  })();
  res.json({ok:true,model_id:result.mid,base_products_created:result.bc,variations_created:result.vc});
});

// Update model + sync names/prices to all products
app.put("/api/models/:id", authMiddleware, requireRole("admin"), (req, res) => {
  const mid = parseInt(req.params.id);
  const { name, category_id, cost_price, drop_price, active, sync_products } = req.body;
  const model = db.prepare("SELECT * FROM models WHERE id=?").get(mid);
  if (!model) return res.status(404).json({ error: "Не знайдено" });

  db.transaction(() => {
    const s=[],v=[];
    if(name!==undefined){s.push("name=?");v.push(name.trim())}
    if(category_id!==undefined){s.push("category_id=?");v.push(category_id||null)}
    if(cost_price!==undefined){s.push("cost_price=?");v.push(parseFloat(cost_price)||0)}
    if(drop_price!==undefined){s.push("drop_price=?");v.push(parseFloat(drop_price)||0)}
    if(active!==undefined){s.push("active=?");v.push(active?1:0)}
    if(s.length){v.push(mid);db.prepare(`UPDATE models SET ${s.join(",")} WHERE id=?`).run(...v)}

    // Update workers
    if(req.body.workers){
      db.prepare("DELETE FROM model_workers WHERE model_id=?").run(mid);
      const lw=db.prepare("INSERT INTO model_workers(model_id,user_id,amount)VALUES(?,?,?)");
      req.body.workers.forEach(w=>lw.run(mid,w.user_id,parseFloat(w.amount)||0));
    }

    // Sync product names and prices if requested
    if(sync_products && name){
      const bps = db.prepare("SELECT bp.*,c.name as color_name FROM base_products bp LEFT JOIN colors c ON bp.color_id=c.id WHERE bp.model_id=?").all(mid);
      for(const bp of bps){
        const newBpName = `${name.trim()} ${bp.color_name||""}`.trim();
        db.prepare("UPDATE base_products SET name=? WHERE id=?").run(newBpName, bp.id);
        // Update variation names
        const vars = db.prepare("SELECT v.*,p.name as print_name FROM variations v LEFT JOIN prints p ON v.print_id=p.id WHERE v.base_product_id=?").all(bp.id);
        for(const v of vars){
          const newVarName = v.print_name ? `${newBpName} — ${v.print_name}` : newBpName;
          db.prepare("UPDATE variations SET name=? WHERE id=?").run(newVarName, v.id);
        }
      }
    }
  })();
  res.json({ok:true});
});

// Full regenerate — deletes all products and recreates
app.post("/api/models/:id/regenerate", authMiddleware, requireRole("admin"), (req, res) => {
  const mid = parseInt(req.params.id);
  const model = db.prepare("SELECT * FROM models WHERE id=?").get(mid);
  if (!model) return res.status(404).json({ error: "Не знайдено" });

  const result = db.transaction(() => {
    // Delete all existing products (cascade deletes variations, stock)
    db.prepare("DELETE FROM base_products WHERE model_id=?").run(mid);

    // Get current model attributes
    const colors = db.prepare("SELECT c.* FROM model_colors mc JOIN colors c ON mc.color_id=c.id WHERE mc.model_id=?").all(mid);
    const sizes = db.prepare("SELECT s.* FROM model_sizes ms JOIN sizes s ON ms.size_id=s.id WHERE ms.model_id=?").all(mid);
    const prints = db.prepare("SELECT p.* FROM model_prints mp JOIN prints p ON mp.print_id=p.id WHERE mp.model_id=?").all(mid);

    const cbp=db.prepare("INSERT INTO base_products(model_id,color_id,name)VALUES(?,?,?)");
    const cv=db.prepare("INSERT INTO variations(base_product_id,print_id,name)VALUES(?,?,?)");
    const csb=db.prepare("INSERT INTO stock_base(base_product_id,size_id,quantity)VALUES(?,?,0)");
    const csr=db.prepare("INSERT INTO stock_returns(variation_id,size_id,quantity)VALUES(?,?,0)");
    let bc=0,vc=0;

    for(const col of colors){
      const bpn=`${model.name} ${col.name}`;
      const bp=cbp.run(mid,col.id,bpn);bc++;
      for(const sz of sizes)csb.run(bp.lastInsertRowid,sz.id);
      if(model.is_ready_product){cv.run(bp.lastInsertRowid,null,bpn);vc++}
      else{for(const pr of prints){const v=cv.run(bp.lastInsertRowid,pr.id,`${bpn} — ${pr.name}`);vc++;for(const sz of sizes)csr.run(v.lastInsertRowid,sz.id)}}
    }
    return{bc,vc};
  })();
  res.json({ok:true,base_products_created:result.bc,variations_created:result.vc});
});

app.delete("/api/models/:id", authMiddleware, requireRole("admin"), (req, res) => {
  db.prepare("DELETE FROM models WHERE id=?").run(req.params.id);res.json({ok:true});
});

// Delete base product
app.delete("/api/base-products/:id", authMiddleware, requireRole("admin"), (req, res) => {
  db.prepare("DELETE FROM base_products WHERE id=?").run(req.params.id);res.json({ok:true});
});

// Delete variation
app.delete("/api/variations/:id", authMiddleware, requireRole("admin"), (req, res) => {
  db.prepare("DELETE FROM variations WHERE id=?").run(req.params.id);res.json({ok:true});
});

// Add print/color to existing model
app.post("/api/models/:id/add-print", authMiddleware, requireRole("admin"), (req, res) => {
  const mid=parseInt(req.params.id);const{print_id}=req.body;
  const model=db.prepare("SELECT * FROM models WHERE id=?").get(mid);
  if(!model)return res.status(404).json({error:"Не знайдено"});
  if(model.is_ready_product)return res.status(400).json({error:"Готовий товар"});
  if(db.prepare("SELECT 1 FROM model_prints WHERE model_id=? AND print_id=?").get(mid,print_id))return res.status(409).json({error:"Вже додано"});
  const print=db.prepare("SELECT * FROM prints WHERE id=?").get(print_id);
  if(!print)return res.status(404).json({error:"Принт не знайдено"});
  db.transaction(()=>{
    db.prepare("INSERT INTO model_prints(model_id,print_id)VALUES(?,?)").run(mid,print_id);
    const sizes=db.prepare("SELECT size_id FROM model_sizes WHERE model_id=?").all(mid);
    db.prepare("SELECT * FROM base_products WHERE model_id=?").all(mid).forEach(bp=>{
      const cn=db.prepare("SELECT name FROM colors WHERE id=?").get(bp.color_id)?.name||"";
      const v=db.prepare("INSERT INTO variations(base_product_id,print_id,name)VALUES(?,?,?)").run(bp.id,print_id,`${model.name} ${cn} — ${print.name}`);
      sizes.forEach(s=>db.prepare("INSERT OR IGNORE INTO stock_returns(variation_id,size_id,quantity)VALUES(?,?,0)").run(v.lastInsertRowid,s.id));
    });
  })();
  res.json({ok:true});
});

app.post("/api/models/:id/add-color", authMiddleware, requireRole("admin"), (req, res) => {
  const mid=parseInt(req.params.id);const{color_id}=req.body;
  const model=db.prepare("SELECT * FROM models WHERE id=?").get(mid);
  if(!model)return res.status(404).json({error:"Не знайдено"});
  const color=db.prepare("SELECT * FROM colors WHERE id=?").get(color_id);
  if(!color)return res.status(404).json({error:"Колір не знайдено"});
  if(db.prepare("SELECT 1 FROM model_colors WHERE model_id=? AND color_id=?").get(mid,color_id))return res.status(409).json({error:"Вже додано"});
  db.transaction(()=>{
    db.prepare("INSERT INTO model_colors(model_id,color_id)VALUES(?,?)").run(mid,color_id);
    const sizes=db.prepare("SELECT size_id FROM model_sizes WHERE model_id=?").all(mid);
    const prints=db.prepare("SELECT print_id FROM model_prints WHERE model_id=?").all(mid);
    const bpn=`${model.name} ${color.name}`;
    const bp=db.prepare("INSERT INTO base_products(model_id,color_id,name)VALUES(?,?,?)").run(mid,color_id,bpn);
    sizes.forEach(s=>db.prepare("INSERT OR IGNORE INTO stock_base(base_product_id,size_id,quantity)VALUES(?,?,0)").run(bp.lastInsertRowid,s.id));
    if(model.is_ready_product){db.prepare("INSERT INTO variations(base_product_id,print_id,name)VALUES(?,NULL,?)").run(bp.lastInsertRowid,bpn)}
    else{prints.forEach(p=>{const pn=db.prepare("SELECT name FROM prints WHERE id=?").get(p.print_id)?.name||"";const v=db.prepare("INSERT INTO variations(base_product_id,print_id,name)VALUES(?,?,?)").run(bp.lastInsertRowid,p.print_id,`${bpn} — ${pn}`);sizes.forEach(s=>db.prepare("INSERT OR IGNORE INTO stock_returns(variation_id,size_id,quantity)VALUES(?,?,0)").run(v.lastInsertRowid,s.id))})}
  })();
  res.json({ok:true});
});

// ── BASE PRODUCTS ────────────────────────────────────────────────
app.get("/api/base-products", authMiddleware, (req, res) => {
  const cat = req.query.category_id;
  let q = `SELECT bp.*,m.name as model_name,m.cost_price,m.drop_price,m.is_ready_product,m.category_id,c.name as color_name,c.hex_code,cat.name as category_name FROM base_products bp JOIN models m ON bp.model_id=m.id LEFT JOIN colors c ON bp.color_id=c.id LEFT JOIN categories cat ON m.category_id=cat.id WHERE bp.active=1`;
  const params = [];
  if (cat) { q += " AND m.category_id=?"; params.push(parseInt(cat)); }
  q += " ORDER BY m.name,c.sort_order";
  const products = db.prepare(q).all(...params);
  const sizes = db.prepare("SELECT * FROM sizes ORDER BY sort_order").all();
  products.forEach(p => {
    p.stock = {};
    db.prepare("SELECT size_id,quantity FROM stock_base WHERE base_product_id=?").all(p.id).forEach(r => p.stock[r.size_id] = r.quantity);
    p.total_stock = Object.values(p.stock).reduce((s, q) => s + q, 0);
  });
  res.json({ products, sizes });
});

app.get("/api/base-products/:id", authMiddleware, (req, res) => {
  const p = db.prepare("SELECT bp.*,m.name as model_name,m.cost_price,m.drop_price,m.is_ready_product,c.name as color_name FROM base_products bp JOIN models m ON bp.model_id=m.id LEFT JOIN colors c ON bp.color_id=c.id WHERE bp.id=?").get(req.params.id);
  if (!p) return res.status(404).json({ error: "Не знайдено" });
  p.stock = db.prepare("SELECT sb.*,s.name as size_name FROM stock_base sb JOIN sizes s ON sb.size_id=s.id WHERE sb.base_product_id=? ORDER BY s.sort_order").all(p.id);
  p.variations = db.prepare("SELECT v.*,pr.name as print_name FROM variations v LEFT JOIN prints pr ON v.print_id=pr.id WHERE v.base_product_id=?").all(p.id);
  res.json({ product: p });
});

app.put("/api/base-products/:id", authMiddleware, requireRole("admin"), (req, res) => {
  const { name, photo, active } = req.body;
  const s=[],v=[];
  if(name!==undefined){s.push("name=?");v.push(name)}
  if(photo!==undefined){s.push("photo=?");v.push(photo)}
  if(active!==undefined){s.push("active=?");v.push(active?1:0)}
  if(s.length){v.push(req.params.id);db.prepare(`UPDATE base_products SET ${s.join(",")} WHERE id=?`).run(...v)}
  res.json({ ok: true });
});

// ── VARIATIONS ───────────────────────────────────────────────────
app.get("/api/variations", authMiddleware, (req, res) => {
  const cat = req.query.category_id;
  let q = `SELECT v.*,bp.model_id,bp.color_id,bp.name as base_name,m.name as model_name,m.drop_price as model_drop_price,m.is_ready_product,m.category_id,c.name as color_name,p.name as print_name,p.photo as print_photo FROM variations v JOIN base_products bp ON v.base_product_id=bp.id JOIN models m ON bp.model_id=m.id LEFT JOIN colors c ON bp.color_id=c.id LEFT JOIN prints p ON v.print_id=p.id WHERE v.active=1 AND bp.active=1 AND m.active=1`;
  const params = [];
  if (cat) { q += " AND m.category_id=?"; params.push(parseInt(cat)); }
  q += " ORDER BY m.name,c.sort_order,p.sort_order";
  const variations = db.prepare(q).all(...params);
  const sizes = db.prepare("SELECT * FROM sizes ORDER BY sort_order").all();
  const modelSizes = {};
  variations.forEach(v => {
    if (!modelSizes[v.model_id]) modelSizes[v.model_id] = db.prepare("SELECT size_id FROM model_sizes WHERE model_id=?").all(v.model_id).map(r=>r.size_id);
    v.stock = {}; v.total_stock = 0;
    for (const sid of modelSizes[v.model_id]) {
      const base = db.prepare("SELECT quantity FROM stock_base WHERE base_product_id=? AND size_id=?").get(v.base_product_id, sid)?.quantity || 0;
      const ret = v.print_id ? (db.prepare("SELECT quantity FROM stock_returns WHERE variation_id=? AND size_id=?").get(v.id, sid)?.quantity || 0) : 0;
      v.stock[sid] = v.print_id ? base + ret : base;
      v.total_stock += v.stock[sid];
    }
    v.drop_price = v.drop_price_override || v.model_drop_price;
  });
  res.json({ variations, sizes });
});

app.get("/api/variations/:id", authMiddleware, (req, res) => {
  const v = db.prepare("SELECT v.*,bp.model_id,bp.name as base_name,m.name as model_name,m.drop_price as model_drop_price,c.name as color_name,p.name as print_name FROM variations v JOIN base_products bp ON v.base_product_id=bp.id JOIN models m ON bp.model_id=m.id LEFT JOIN colors c ON bp.color_id=c.id LEFT JOIN prints p ON v.print_id=p.id WHERE v.id=?").get(req.params.id);
  if (!v) return res.status(404).json({ error: "Не знайдено" });
  res.json({ variation: v });
});

app.put("/api/variations/:id", authMiddleware, requireRole("admin"), (req, res) => {
  const { name, photo, drop_price_override, active } = req.body;
  const s=[],v=[];
  if(name!==undefined){s.push("name=?");v.push(name)}
  if(photo!==undefined){s.push("photo=?");v.push(photo)}
  if(drop_price_override!==undefined){s.push("drop_price_override=?");v.push(drop_price_override===null?null:parseFloat(drop_price_override))}
  if(active!==undefined){s.push("active=?");v.push(active?1:0)}
  if(s.length){v.push(req.params.id);db.prepare(`UPDATE variations SET ${s.join(",")} WHERE id=?`).run(...v)}
  res.json({ ok: true });
});

// ── STOCK INCOMING ───────────────────────────────────────────────
app.post("/api/stock/incoming-bulk", authMiddleware, (req, res) => {
  const { base_product_id, items, note } = req.body;
  if (!base_product_id || !items?.length) return res.status(400).json({ error: "Немає даних" });
  db.transaction(() => {
    for (const item of items) {
      const qty = parseInt(item.quantity);
      if (qty > 0) {
        db.prepare("INSERT INTO stock_incoming(base_product_id,size_id,quantity,note,created_by)VALUES(?,?,?,?,?)").run(base_product_id,item.size_id,qty,note||"",req.user.id);
        db.prepare("UPDATE stock_base SET quantity=quantity+? WHERE base_product_id=? AND size_id=?").run(qty,base_product_id,item.size_id);
      }
    }
  })();
  res.json({ ok: true });
});

// ── DASHBOARD ────────────────────────────────────────────────────
app.get("/api/dashboard", authMiddleware, (req, res) => {
  if (req.user.role === "admin") {
    res.json({ dropshippers: db.prepare("SELECT COUNT(*) as c FROM users WHERE role='dropshipper' AND active=1").get().c, warehouse_workers: db.prepare("SELECT COUNT(*) as c FROM users WHERE role='warehouse' AND active=1").get().c, models: db.prepare("SELECT COUNT(*) as c FROM models WHERE active=1").get().c, base_products: db.prepare("SELECT COUNT(*) as c FROM base_products WHERE active=1").get().c, variations: db.prepare("SELECT COUNT(*) as c FROM variations WHERE active=1").get().c, orders_today: db.prepare("SELECT COUNT(*) as c FROM orders WHERE date(created_at)=date('now','localtime')").get().c, orders_new: db.prepare("SELECT COUNT(*) as c FROM orders WHERE status='new'").get().c });
  } else if (req.user.role === "dropshipper") {
    res.json({ my_orders_total: db.prepare("SELECT COUNT(*) as c FROM orders WHERE dropshipper_id=?").get(req.user.id).c, my_orders_new: db.prepare("SELECT COUNT(*) as c FROM orders WHERE dropshipper_id=? AND status='new'").get(req.user.id).c, my_payout: db.prepare("SELECT COALESCE(SUM(payout_amount),0) as s FROM orders WHERE dropshipper_id=? AND status='delivered'").get(req.user.id).s });
  } else {
    res.json({ orders_new: db.prepare("SELECT COUNT(*) as c FROM orders WHERE status='new'").get().c, orders_in_progress: db.prepare("SELECT COUNT(*) as c FROM orders WHERE status='in_progress'").get().c, orders_packed: db.prepare("SELECT COUNT(*) as c FROM orders WHERE status='packed'").get().c });
  }
});

// ── PAGES ────────────────────────────────────────────────────────
function pageAuth(req,res,next){const t=req.cookies?.token;if(!t)return res.redirect("/login");const{verifyToken}=require("./auth");const u=verifyToken(t);if(!u)return res.redirect("/login");req.user=u;next()}
function pageRole(...r){return(req,res,next)=>{if(!r.includes(req.user.role))return res.redirect("/login");next()}}
app.get("/login",(req,res)=>res.sendFile(path.join(__dirname,"public","login.html")));
app.get("/",(req,res)=>{const t=req.cookies?.token;if(!t)return res.redirect("/login");const{verifyToken}=require("./auth");const u=verifyToken(t);if(!u)return res.redirect("/login");res.redirect({admin:"/admin",dropshipper:"/drop",warehouse:"/warehouse"}[u.role]||"/login")});
app.get("/admin",pageAuth,pageRole("admin"),(req,res)=>res.sendFile(path.join(__dirname,"public","admin.html")));
app.get("/admin/*",pageAuth,pageRole("admin"),(req,res)=>res.sendFile(path.join(__dirname,"public","admin.html")));
app.get("/drop",pageAuth,pageRole("dropshipper"),(req,res)=>res.sendFile(path.join(__dirname,"public","drop.html")));
app.get("/warehouse",pageAuth,pageRole("warehouse"),(req,res)=>res.sendFile(path.join(__dirname,"public","warehouse.html")));
app.get("*",(req,res)=>{if(req.path.startsWith("/api/"))return res.status(404).json({error:"Not found"});res.redirect("/login")});

app.listen(PORT, () => console.log(`✅ CRM on http://localhost:${PORT}`));

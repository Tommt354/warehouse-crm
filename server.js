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
  const u = db.prepare("SELECT id,username,role,name,phone,email,telegram,discount_percent,discount_fixed,worker_role,payout_details,payment_type,payment_card,payment_iban,edrpou,full_name,payment_purpose FROM users WHERE id=?").get(req.user.id);
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
  const scope = req.query.scope;
  const all = scope ? db.prepare("SELECT * FROM categories WHERE scope=? ORDER BY sort_order,name").all(scope) : db.prepare("SELECT * FROM categories ORDER BY sort_order,name").all();
  let children;
  if (parent_id === "" || parent_id === undefined) {
    children = all.filter(c => !c.parent_id);
  } else {
    children = all.filter(c => c.parent_id === parseInt(parent_id));
  }
  const breadcrumb = [];
  if (parent_id && parseInt(parent_id)) {
    let cur = all.find(c => c.id === parseInt(parent_id));
    while (cur) { breadcrumb.unshift(cur); cur = cur.parent_id ? all.find(c => c.id === cur.parent_id) : null; }
  }
  res.json({ categories: children, breadcrumb, flat: all });
});

app.post("/api/categories", authMiddleware, requireRole("admin"), (req, res) => {
  const { name, parent_id, photo, hidden_from_drop, sort_order, scope } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: "Назва обов'язкова" });
  const r = db.prepare("INSERT INTO categories(name,parent_id,photo,hidden_from_drop,sort_order,scope)VALUES(?,?,?,?,?,?)").run(name.trim(),parent_id||null,photo||"",hidden_from_drop?1:0,parseInt(sort_order)||0,scope||"base");
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
  const { name, category_id, category_drop_id, is_ready_product, cost_price, drop_price, drop_channel, color_ids, size_ids, print_ids, patch_ids, workers } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: "Назва обов'язкова" });
  if (!color_ids?.length) return res.status(400).json({ error: "Оберіть кольори" });
  if (!size_ids?.length) return res.status(400).json({ error: "Оберіть розміри" });
  if (!is_ready_product && !print_ids?.length) return res.status(400).json({ error: "Оберіть принти" });

  const result = db.transaction(() => {
    const r = db.prepare("INSERT INTO models(name,category_id,category_drop_id,is_ready_product,cost_price,drop_price,drop_channel)VALUES(?,?,?,?,?,?,?)").run(name.trim(),category_id||null,category_drop_id||null,is_ready_product?1:0,parseFloat(cost_price)||0,parseFloat(drop_price)||0,drop_channel||"hot");
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
    const cbp=db.prepare("INSERT INTO base_products(model_id,color_id,name,cost_price,drop_price)VALUES(?,?,?,?,?)");
    const cv=db.prepare("INSERT INTO variations(base_product_id,print_id,name)VALUES(?,?,?)");
    const csb=db.prepare("INSERT INTO stock_base(base_product_id,size_id,quantity)VALUES(?,?,0)");
    const csr=db.prepare("INSERT INTO stock_returns(variation_id,size_id,quantity)VALUES(?,?,0)");
    let bc=0,vc=0;
    const cp=parseFloat(cost_price)||0,dp=parseFloat(drop_price)||0;
    for(const col of colors){
      const bpn=`${name.trim()} ${col.name}`;
      const bp=cbp.run(mid,col.id,bpn,cp,dp);bc++;
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
  const isReady = req.query.is_ready;
  let q = `SELECT bp.*,m.name as model_name,m.is_ready_product,m.drop_channel,m.category_id,c.name as color_name,c.hex_code,cat.name as category_name FROM base_products bp JOIN models m ON bp.model_id=m.id LEFT JOIN colors c ON bp.color_id=c.id LEFT JOIN categories cat ON m.category_id=cat.id WHERE bp.active=1`;
  const params = [];
  if (cat) { q += " AND m.category_id=?"; params.push(parseInt(cat)); }
  if (isReady === "1") { q += " AND m.is_ready_product=1"; }
  if (isReady === "0") { q += " AND m.is_ready_product=0"; }
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
  const p = db.prepare("SELECT bp.*,m.name as model_name,m.cost_price,m.drop_price,m.is_ready_product,m.id as mid,c.name as color_name,c.hex_code FROM base_products bp JOIN models m ON bp.model_id=m.id LEFT JOIN colors c ON bp.color_id=c.id WHERE bp.id=?").get(req.params.id);
  if (!p) return res.status(404).json({ error: "Не знайдено" });
  p.stock = db.prepare("SELECT sb.*,s.name as size_name FROM stock_base sb JOIN sizes s ON sb.size_id=s.id WHERE sb.base_product_id=? ORDER BY s.sort_order").all(p.id);
  p.variations = db.prepare("SELECT v.*,pr.name as print_name FROM variations v LEFT JOIN prints pr ON v.print_id=pr.id WHERE v.base_product_id=?").all(p.id);
  p.workers = db.prepare("SELECT mw.*,u.name as worker_name FROM model_workers mw JOIN users u ON mw.user_id=u.id WHERE mw.model_id=?").all(p.mid);
  p.all_colors = db.prepare("SELECT * FROM colors ORDER BY sort_order").all();
  res.json({ product: p });
});

app.put("/api/base-products/:id", authMiddleware, requireRole("admin"), (req, res) => {
  const { name, photo, active, color_id, cost_price, drop_price } = req.body;
  const s=[],v=[];
  if(name!==undefined){s.push("name=?");v.push(name)}
  if(photo!==undefined){s.push("photo=?");v.push(photo)}
  if(active!==undefined){s.push("active=?");v.push(active?1:0)}
  if(color_id!==undefined){s.push("color_id=?");v.push(color_id)}
  if(cost_price!==undefined){s.push("cost_price=?");v.push(parseFloat(cost_price)||0)}
  if(drop_price!==undefined){s.push("drop_price=?");v.push(parseFloat(drop_price)||0)}
  if(s.length){v.push(req.params.id);db.prepare(`UPDATE base_products SET ${s.join(",")} WHERE id=?`).run(...v)}
  res.json({ ok: true });
});

// Directly set stock quantity for a product+size
app.post("/api/stock/set", authMiddleware, (req, res) => {
  const { base_product_id, size_id, quantity } = req.body;
  if(!base_product_id || !size_id) return res.status(400).json({ error: "Missing fields" });
  const qty = parseInt(quantity) || 0;
  db.prepare("UPDATE stock_base SET quantity=? WHERE base_product_id=? AND size_id=?").run(qty, base_product_id, size_id);
  res.json({ ok: true });
});

// Update model workers from product context
app.put("/api/model-workers/:model_id", authMiddleware, requireRole("admin"), (req, res) => {
  const mid = parseInt(req.params.model_id);
  const { workers } = req.body;
  if(!workers) return res.status(400).json({ error: "No workers" });
  db.transaction(() => {
    db.prepare("DELETE FROM model_workers WHERE model_id=?").run(mid);
    const lw = db.prepare("INSERT INTO model_workers(model_id,user_id,amount)VALUES(?,?,?)");
    workers.forEach(w => lw.run(mid, w.user_id, parseFloat(w.amount)||0));
  })();
  res.json({ ok: true });
});

// ── VARIATIONS ───────────────────────────────────────────────────
app.get("/api/variations", authMiddleware, (req, res) => {
  const cat = req.query.category_id;
  const channel = req.query.channel;
  let q = `SELECT v.*,bp.model_id,bp.color_id,bp.name as base_name,m.name as model_name,m.drop_price as model_drop_price,m.is_ready_product,m.category_drop_id,m.drop_channel,c.name as color_name,p.name as print_name,p.photo as print_photo FROM variations v JOIN base_products bp ON v.base_product_id=bp.id JOIN models m ON bp.model_id=m.id LEFT JOIN colors c ON bp.color_id=c.id LEFT JOIN prints p ON v.print_id=p.id WHERE v.active=1 AND bp.active=1 AND m.active=1`;
  const params = [];
  if (cat) { q += " AND m.category_drop_id=?"; params.push(parseInt(cat)); }
  if (channel) { q += " AND m.drop_channel=?"; params.push(channel); }
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
  const v = db.prepare("SELECT v.*,bp.model_id,bp.color_id,bp.name as base_name,bp.cost_price as base_cost,bp.drop_price as base_drop,m.name as model_name,m.drop_price as model_drop_price,m.id as mid,c.name as color_name,c.hex_code,p.name as print_name,p.photo as print_photo FROM variations v JOIN base_products bp ON v.base_product_id=bp.id JOIN models m ON bp.model_id=m.id LEFT JOIN colors c ON bp.color_id=c.id LEFT JOIN prints p ON v.print_id=p.id WHERE v.id=?").get(req.params.id);
  if (!v) return res.status(404).json({ error: "Не знайдено" });
  v.drop_price = v.drop_price_override || v.model_drop_price;
  // Stock: base + returns per size
  const modelSizes = db.prepare("SELECT s.id,s.name FROM model_sizes ms JOIN sizes s ON ms.size_id=s.id WHERE ms.model_id=? ORDER BY s.sort_order").all(v.mid);
  v.stock_detail = modelSizes.map(s => {
    const base = db.prepare("SELECT quantity FROM stock_base WHERE base_product_id=? AND size_id=?").get(v.base_product_id, s.id)?.quantity || 0;
    const ret = v.print_id ? (db.prepare("SELECT quantity FROM stock_returns WHERE variation_id=? AND size_id=?").get(v.id, s.id)?.quantity || 0) : 0;
    return { size_id: s.id, size_name: s.name, base_qty: base, return_qty: ret, total: base + ret };
  });
  v.workers = db.prepare("SELECT mw.*,u.name as worker_name FROM model_workers mw JOIN users u ON mw.user_id=u.id WHERE mw.model_id=?").all(v.mid);
  v.all_prints = db.prepare("SELECT * FROM prints WHERE active=1 ORDER BY sort_order").all();
  res.json({ variation: v });
});

app.put("/api/variations/:id", authMiddleware, requireRole("admin"), (req, res) => {
  const { name, photo, drop_price_override, active, print_id, allow_negative_order } = req.body;
  const s=[],v=[];
  if(name!==undefined){s.push("name=?");v.push(name)}
  if(photo!==undefined){s.push("photo=?");v.push(photo)}
  if(drop_price_override!==undefined){s.push("drop_price_override=?");v.push(drop_price_override===null?null:parseFloat(drop_price_override))}
  if(active!==undefined){s.push("active=?");v.push(active?1:0)}
  if(print_id!==undefined){s.push("print_id=?");v.push(print_id||null)}
  if(allow_negative_order!==undefined){s.push("allow_negative_order=?");v.push(allow_negative_order?1:0)}
  if(s.length){v.push(req.params.id);db.prepare(`UPDATE variations SET ${s.join(",")} WHERE id=?`).run(...v)}
  res.json({ ok: true });
});

// Set stock_returns quantity
app.post("/api/stock-returns/set", authMiddleware, (req, res) => {
  const { variation_id, size_id, quantity } = req.body;
  if(!variation_id || !size_id) return res.status(400).json({ error: "Missing fields" });
  db.prepare("UPDATE stock_returns SET quantity=? WHERE variation_id=? AND size_id=?").run(parseInt(quantity)||0, variation_id, size_id);
  res.json({ ok: true });
});

// Duplicate base product
app.post("/api/base-products/:id/duplicate", authMiddleware, requireRole("admin"), (req, res) => {
  const orig = db.prepare("SELECT * FROM base_products WHERE id=?").get(req.params.id);
  if(!orig) return res.status(404).json({ error: "Не знайдено" });
  const r = db.prepare("INSERT INTO base_products(model_id,color_id,name,photo,cost_price,drop_price,active)VALUES(?,?,?,?,?,?,?)").run(orig.model_id,orig.color_id,orig.name+" (копія)",orig.photo,orig.cost_price,orig.drop_price,orig.active);
  // Copy stock entries
  const stocks = db.prepare("SELECT * FROM stock_base WHERE base_product_id=?").all(orig.id);
  stocks.forEach(s => db.prepare("INSERT INTO stock_base(base_product_id,size_id,quantity)VALUES(?,?,?)").run(r.lastInsertRowid,s.size_id,s.quantity));
  // Copy variations
  const vars = db.prepare("SELECT * FROM variations WHERE base_product_id=?").all(orig.id);
  vars.forEach(v => {
    const nv = db.prepare("INSERT INTO variations(base_product_id,print_id,name,photo,drop_price_override,active)VALUES(?,?,?,?,?,?)").run(r.lastInsertRowid,v.print_id,v.name+" (копія)",v.photo,v.drop_price_override,v.active);
    const rets = db.prepare("SELECT * FROM stock_returns WHERE variation_id=?").all(v.id);
    rets.forEach(sr => db.prepare("INSERT INTO stock_returns(variation_id,size_id,quantity)VALUES(?,?,?)").run(nv.lastInsertRowid,sr.size_id,sr.quantity));
  });
  res.json({ ok: true, new_id: r.lastInsertRowid });
});

// Export stock as CSV
app.get("/api/export/stock", authMiddleware, (req, res) => {
  const products = db.prepare("SELECT bp.*,m.name as model_name,c.name as color_name FROM base_products bp JOIN models m ON bp.model_id=m.id LEFT JOIN colors c ON bp.color_id=c.id WHERE bp.active=1 ORDER BY m.name").all();
  const sizes = db.prepare("SELECT * FROM sizes ORDER BY sort_order").all();
  let csv = "\uFEFF" + "Товар;Колір;Собівартість;Дроп-ціна;" + sizes.map(s=>s.name).join(";") + ";Всього\n";
  products.forEach(p => {
    const stocks = {};
    db.prepare("SELECT size_id,quantity FROM stock_base WHERE base_product_id=?").all(p.id).forEach(s=>stocks[s.size_id]=s.quantity);
    const total = Object.values(stocks).reduce((a,b)=>a+b,0);
    csv += `${p.name};${p.color_name||""};${p.cost_price};${p.drop_price};${sizes.map(s=>stocks[s.id]||0).join(";")};${total}\n`;
  });
  res.setHeader("Content-Type","text/csv;charset=utf-8");
  res.setHeader("Content-Disposition",`attachment;filename=stock_${new Date().toISOString().slice(0,10)}.csv`);
  res.send(csv);
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
        db.prepare("INSERT INTO stock_log(type,base_product_id,size_id,quantity,note,user_id)VALUES('incoming',?,?,?,?,?)").run(base_product_id,item.size_id,qty,note||"",req.user.id);
      }
    }
  })();
  res.json({ ok: true });
});

// Write-off stock (списання)
app.post("/api/stock/write-off", authMiddleware, (req, res) => {
  const { base_product_id, size_id, quantity, note } = req.body;
  if (!base_product_id || !size_id || !quantity) return res.status(400).json({ error: "Всі поля обов'язкові" });
  const qty = parseInt(quantity);
  if (qty <= 0) return res.status(400).json({ error: "Кількість має бути більше 0" });
  db.prepare("UPDATE stock_base SET quantity=quantity-? WHERE base_product_id=? AND size_id=?").run(qty, base_product_id, size_id);
  db.prepare("INSERT INTO stock_incoming(base_product_id,size_id,quantity,note,created_by)VALUES(?,?,?,?,?)").run(base_product_id, size_id, -qty, "Списання: "+(note||""), req.user.id);
  db.prepare("INSERT INTO stock_log(type,base_product_id,size_id,quantity,note,user_id)VALUES('writeoff',?,?,?,?,?)").run(base_product_id,size_id,qty,"Списання: "+(note||""),req.user.id);
  res.json({ ok: true });
});

// Swap size (заміна розміру)
app.post("/api/stock/swap-size", authMiddleware, (req, res) => {
  const { base_product_id, from_size_id, to_size_id, quantity } = req.body;
  if (!base_product_id || !from_size_id || !to_size_id || !quantity) return res.status(400).json({ error: "Всі поля обов'язкові" });
  if (from_size_id === to_size_id) return res.status(400).json({ error: "Розміри однакові" });
  const qty = parseInt(quantity);
  if (qty <= 0) return res.status(400).json({ error: "Кількість має бути більше 0" });
  db.transaction(() => {
    db.prepare("UPDATE stock_base SET quantity=quantity-? WHERE base_product_id=? AND size_id=?").run(qty, base_product_id, from_size_id);
    db.prepare("UPDATE stock_base SET quantity=quantity+? WHERE base_product_id=? AND size_id=?").run(qty, base_product_id, to_size_id);
    db.prepare("INSERT INTO stock_incoming(base_product_id,size_id,quantity,note,created_by)VALUES(?,?,?,?,?)").run(base_product_id, from_size_id, -qty, "Заміна розміру", req.user.id);
    db.prepare("INSERT INTO stock_incoming(base_product_id,size_id,quantity,note,created_by)VALUES(?,?,?,?,?)").run(base_product_id, to_size_id, qty, "Заміна розміру", req.user.id);
    const fromName = db.prepare("SELECT name FROM sizes WHERE id=?").get(from_size_id)?.name||"";
    const toName = db.prepare("SELECT name FROM sizes WHERE id=?").get(to_size_id)?.name||"";
    db.prepare("INSERT INTO stock_log(type,base_product_id,size_id,quantity,note,user_id)VALUES('swap',?,?,?,?,?)").run(base_product_id,from_size_id,qty,fromName+" → "+toName,req.user.id);
  })();
  res.json({ ok: true });
});

// Stock log API
app.get("/api/stock-log", authMiddleware, (req, res) => {
  const logs = db.prepare(`SELECT sl.*,bp.name as product_name,s.name as size_name,u.name as user_name 
    FROM stock_log sl LEFT JOIN base_products bp ON sl.base_product_id=bp.id 
    LEFT JOIN sizes s ON sl.size_id=s.id LEFT JOIN users u ON sl.user_id=u.id 
    ORDER BY sl.created_at DESC LIMIT 200`).all();
  res.json({ logs });
});

app.get("/api/kits", authMiddleware, (req, res) => {
  const cat = req.query.category_id;
  let q = "SELECT k.*,c.name as category_name FROM kits k LEFT JOIN categories c ON k.category_drop_id=c.id WHERE k.active=1";
  const params = [];
  if (cat) { q += " AND k.category_drop_id=?"; params.push(parseInt(cat)); }
  q += " ORDER BY k.name";
  const kits = db.prepare(q).all(...params);
  const sizes = db.prepare("SELECT * FROM sizes ORDER BY sort_order").all();

  kits.forEach(k => {
    k.items = db.prepare("SELECT ki.*,v.name as var_name,v.photo as var_photo,v.base_product_id,v.print_id,bp.name as base_name,c.name as color_name FROM kit_items ki JOIN variations v ON ki.variation_id=v.id JOIN base_products bp ON v.base_product_id=bp.id LEFT JOIN colors c ON bp.color_id=c.id WHERE ki.kit_id=?").all(k.id);
    // Stock = min across all components per size
    // Get all model sizes from first component
    if (k.items.length) {
      const firstVar = k.items[0];
      const bp = db.prepare("SELECT model_id FROM base_products WHERE id=?").get(firstVar.base_product_id);
      const modelSizes = bp ? db.prepare("SELECT size_id FROM model_sizes WHERE model_id=?").all(bp.model_id).map(r=>r.size_id) : [];
      k.stock = {};
      k.total_stock = 0;
      for (const sid of modelSizes) {
        let minStock = Infinity;
        for (const item of k.items) {
          const base = db.prepare("SELECT quantity FROM stock_base WHERE base_product_id=? AND size_id=?").get(item.base_product_id, sid)?.quantity || 0;
          const ret = item.print_id ? (db.prepare("SELECT quantity FROM stock_returns WHERE variation_id=? AND size_id=?").get(item.variation_id, sid)?.quantity || 0) : 0;
          minStock = Math.min(minStock, base + ret);
        }
        if (minStock === Infinity) minStock = 0;
        k.stock[sid] = minStock;
        k.total_stock += minStock;
      }
    } else {
      k.stock = {}; k.total_stock = 0;
    }
    k.is_kit = true;
  });
  res.json({ kits, sizes });
});

app.get("/api/kits/:id", authMiddleware, (req, res) => {
  const k = db.prepare("SELECT * FROM kits WHERE id=?").get(req.params.id);
  if (!k) return res.status(404).json({ error: "Не знайдено" });
  k.items = db.prepare("SELECT ki.*,v.name as var_name,v.photo as var_photo,v.id as vid FROM kit_items ki JOIN variations v ON ki.variation_id=v.id WHERE ki.kit_id=?").all(k.id);
  res.json({ kit: k });
});

app.post("/api/kits", authMiddleware, requireRole("admin"), (req, res) => {
  const { name, photo, category_drop_id, drop_price, cost_price, variation_ids } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: "Назва обов'язкова" });
  if (!variation_ids?.length) return res.status(400).json({ error: "Додайте товари до комплекту" });

  const r = db.transaction(() => {
    const k = db.prepare("INSERT INTO kits(name,photo,category_drop_id,drop_price,cost_price)VALUES(?,?,?,?,?)").run(name.trim(), photo||"", category_drop_id||null, parseFloat(drop_price)||0, parseFloat(cost_price)||0);
    const addItem = db.prepare("INSERT INTO kit_items(kit_id,variation_id)VALUES(?,?)");
    variation_ids.forEach(vid => addItem.run(k.lastInsertRowid, vid));
    return k.lastInsertRowid;
  })();
  res.json({ ok: true, kit_id: r });
});

app.put("/api/kits/:id", authMiddleware, requireRole("admin"), (req, res) => {
  const { name, photo, category_drop_id, drop_price, cost_price, active } = req.body;
  const s=[],v=[];
  if(name!==undefined){s.push("name=?");v.push(name.trim())}
  if(photo!==undefined){s.push("photo=?");v.push(photo)}
  if(category_drop_id!==undefined){s.push("category_drop_id=?");v.push(category_drop_id||null)}
  if(drop_price!==undefined){s.push("drop_price=?");v.push(parseFloat(drop_price)||0)}
  if(cost_price!==undefined){s.push("cost_price=?");v.push(parseFloat(cost_price)||0)}
  if(active!==undefined){s.push("active=?");v.push(active?1:0)}
  if(s.length){v.push(req.params.id);db.prepare(`UPDATE kits SET ${s.join(",")} WHERE id=?`).run(...v)}
  res.json({ ok: true });
});

app.delete("/api/kits/:id", authMiddleware, requireRole("admin"), (req, res) => {
  db.prepare("DELETE FROM kits WHERE id=?").run(req.params.id);res.json({ ok: true });
});

// ── ORDERS ────────────────────────────────────────────────────────

// Create order (dropshipper)
app.post("/api/orders", authMiddleware, (req, res) => {
  const { items, client_name, client_phone, client_city, client_warehouse, cod_amount, note } = req.body;
  if (!items?.length) return res.status(400).json({ error: "Додайте товари" });
  if (!client_name?.trim()) return res.status(400).json({ error: "Вкажіть ПІБ клієнта" });
  if (!client_phone?.trim()) return res.status(400).json({ error: "Вкажіть телефон" });

  const dropId = req.user.role === "admin" ? (req.body.dropshipper_id || req.user.id) : req.user.id;
  // Get dropshipper discount
  const drop = db.prepare("SELECT discount_percent,discount_fixed FROM users WHERE id=?").get(dropId);

  const result = db.transaction(() => {
    let totalDrop = 0;
    const orderItems = [];

    for (const item of items) {
      const qty = parseInt(item.quantity) || 1;

      if (item.kit_id) {
        // Kit order — expand into components
        const kit = db.prepare("SELECT * FROM kits WHERE id=?").get(item.kit_id);
        if (!kit) throw new Error("Комплект не знайдено");
        let kitPrice = kit.drop_price;
        if (drop?.discount_percent) kitPrice = kitPrice * (1 - drop.discount_percent / 100);
        if (drop?.discount_fixed) kitPrice = Math.max(0, kitPrice - drop.discount_fixed);
        kitPrice = Math.round(kitPrice * 100) / 100;
        totalDrop += kitPrice * qty;

        const kitComps = db.prepare("SELECT ki.variation_id FROM kit_items ki WHERE ki.kit_id=?").all(item.kit_id);
        for (const comp of kitComps) {
          const v = db.prepare("SELECT v.*,bp.id as bpid FROM variations v JOIN base_products bp ON v.base_product_id=bp.id WHERE v.id=?").get(comp.variation_id);
          if (!v) continue;
          db.prepare("UPDATE stock_base SET quantity=MAX(0,quantity-?) WHERE base_product_id=? AND size_id=?").run(qty, v.bpid, item.size_id);
          orderItems.push({ variation_id: v.id, size_id: item.size_id, quantity: qty, drop_price: 0, from_returns: 0, kit_id: item.kit_id });
        }
        // First component gets the kit price for display
        if (orderItems.length && orderItems[orderItems.length - kitComps.length]) {
          orderItems[orderItems.length - kitComps.length].drop_price = kitPrice;
        }
      } else {
        // Regular item
        const v = db.prepare("SELECT v.*,bp.drop_price as bp_drop,m.drop_price as m_drop FROM variations v JOIN base_products bp ON v.base_product_id=bp.id JOIN models m ON bp.model_id=m.id WHERE v.id=?").get(item.variation_id);
        if (!v) throw new Error("Варіація не знайдена");

        // Check stock if negative orders not allowed
        if (!v.allow_negative_order) {
          const stock = db.prepare("SELECT quantity FROM stock_base WHERE base_product_id=? AND size_id=?").get(v.base_product_id, item.size_id);
          if (!stock || stock.quantity < qty) throw new Error(v.name + " — недостатньо на складі");
        }

        let dropPrice = v.drop_price_override || v.bp_drop || v.m_drop || 0;
        if (drop?.discount_percent) dropPrice = dropPrice * (1 - drop.discount_percent / 100);
        if (drop?.discount_fixed) dropPrice = Math.max(0, dropPrice - drop.discount_fixed);
        dropPrice = Math.round(dropPrice * 100) / 100;
        totalDrop += dropPrice * qty;

        db.prepare("UPDATE stock_base SET quantity=quantity-? WHERE base_product_id=? AND size_id=?").run(qty, v.base_product_id, item.size_id);
        orderItems.push({ variation_id: v.id, size_id: item.size_id, quantity: qty, drop_price: dropPrice, from_returns: 0, kit_id: null });
      }
    }

    const cod = parseFloat(cod_amount) || 0;
    const isPrepaid = req.body.is_prepaid ? 1 : 0;
    const payout = isPrepaid ? 0 : Math.round((cod - totalDrop) * 100) / 100;

    // Detect channel from first variation
    let orderChannel = "";
    if (orderItems.length) {
      const firstVar = db.prepare("SELECT m.drop_channel FROM variations v JOIN base_products bp ON v.base_product_id=bp.id JOIN models m ON bp.model_id=m.id WHERE v.id=?").get(orderItems[0].variation_id);
      orderChannel = firstVar?.drop_channel || "";
    }

    const o = db.prepare("INSERT INTO orders(dropshipper_id,client_name,client_phone,client_city,client_warehouse,cod_amount,total_drop_price,payout_amount,note,drop_channel,is_prepaid,receipt_photo,declared_value)VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)")
      .run(dropId, client_name.trim(), client_phone.trim(), client_city||"", client_warehouse||"", cod, totalDrop, payout, note||"", orderChannel, req.body.is_prepaid?1:0, req.body.receipt_photo||"", parseFloat(req.body.declared_value)||0);

    const addItem = db.prepare("INSERT INTO order_items(order_id,variation_id,size_id,quantity,drop_price,from_returns,kit_id)VALUES(?,?,?,?,?,?,?)");
    orderItems.forEach(i => addItem.run(o.lastInsertRowid, i.variation_id, i.size_id, i.quantity, i.drop_price, i.from_returns, i.kit_id));

    return { order_id: o.lastInsertRowid, total_drop: totalDrop, payout, is_prepaid: req.body.is_prepaid?1:0 };
  })();

  // Auto-generate TTN for COD orders (not prepaid)
  if (!result.is_prepaid && result.order_id) {
    try {
      const apiKey = db.prepare("SELECT value FROM settings WHERE key='np_api_key'").get()?.value;
      const sender = db.prepare("SELECT * FROM np_senders WHERE is_active=1").get();
      console.log("Auto-TTN check:", "key:", !!apiKey, "sender:", sender?.name, "order:", result.order_id);
      if (apiKey && sender) {
        setTimeout(async () => {
          try {
            const o2 = db.prepare("SELECT o.*,u.name as drop_name FROM orders o JOIN users u ON o.dropshipper_id=u.id WHERE o.id=?").get(result.order_id);
            if (!o2 || o2.ttn) { console.log("Auto-TTN skip"); return; }
            console.log("Auto-TTN for #"+o2.id, "city:", o2.client_city, "wh:", o2.client_warehouse);
            const cityRes = await npApi(apiKey, "Address", "searchSettlements", { CityName: o2.client_city, Limit: 1 });
            const cityData = cityRes.data?.[0]?.Addresses?.[0];
            if (!cityData) { console.log("Auto-TTN: city not found"); return; }
            console.log("Auto-TTN city OK:", cityData.MainDescription);
            const whMatch = o2.client_warehouse.match(/№?\s*(\d+)/);
            const whNum = whMatch ? whMatch[1] : "";
            const whRes = await npApi(apiKey, "Address", "getWarehouses", { CityRef: cityData.DeliveryCity || cityData.Ref, FindByString: whNum || o2.client_warehouse, Limit: "5" });
            const whData = whRes.data?.[0];
            if (!whData) { console.log("Auto-TTN: warehouse not found"); return; }
            console.log("Auto-TTN wh OK:", whData.Description);
            const itemsCount = db.prepare("SELECT SUM(quantity) as c FROM order_items WHERE order_id=?").get(o2.id).c || 1;
            const cleanPhone = (p) => p.replace(/[^\d]/g, "").replace(/^(\+?38)?/, "38");

            // Get sender city from counterparty addresses
            const senderAddrs = await npApi(apiKey, "Counterparty", "getCounterpartyAddresses", { Ref: sender.sender_ref, CounterpartyProperty: "Sender" });
            const senderAddr = senderAddrs.data?.find(a => a.Ref === sender.address_ref) || senderAddrs.data?.[0];
            const senderCity = senderAddr?.CityRef || "";
            console.log("Auto-TTN sender city:", senderCity, senderAddr?.Description);

            // Create recipient counterparty
            const nameParts = o2.client_name.trim().split(/\s+/);
            const recipRes = await npApi(apiKey, "Counterparty", "save", {
              FirstName: nameParts[1] || nameParts[0] || "Клієнт",
              MiddleName: nameParts[2] || "",
              LastName: nameParts[0] || "Клієнт",
              Phone: cleanPhone(o2.client_phone),
              Email: "",
              CounterpartyType: "PrivatePerson",
              CounterpartyProperty: "Recipient"
            });
            if (!recipRes.success || !recipRes.data?.[0]) {
              console.log("Auto-TTN: recipient create error:", JSON.stringify(recipRes.errors||[]));
              return;
            }
            const recipRef = recipRes.data[0].Ref;
            const recipContact = recipRes.data[0].ContactPerson?.data?.[0]?.Ref || "";
            console.log("Auto-TTN recipient OK:", recipRef, "contact:", recipContact);

            const docData = {
              PayerType: "Recipient", PaymentMethod: "Cash",
              DateTime: new Date().toLocaleDateString("uk-UA", { day: "2-digit", month: "2-digit", year: "numeric" }),
              CargoType: "Parcel", Weight: String(Math.max(0.5, itemsCount * 0.3)),
              ServiceType: "WarehouseWarehouse", SeatsAmount: "1", Description: "Одяг",
              Cost: String(o2.cod_amount || 300),
              AfterpaymentOnGoodsCost: o2.cod_amount > 0 ? String(o2.cod_amount) : undefined,
              CitySender: senderCity,
              Sender: sender.sender_ref,
              SenderAddress: sender.address_ref,
              ContactSender: sender.contact_ref,
              SendersPhone: cleanPhone(sender.phone),
              CityRecipient: cityData.DeliveryCity || cityData.Ref,
              Recipient: recipRef,
              RecipientAddress: whData.Ref,
              ContactRecipient: recipContact,
              RecipientsPhone: cleanPhone(o2.client_phone),
            };
            console.log("Auto-TTN sending doc...");
            let r2 = await npApi(apiKey, "InternetDocument", "save", docData);
            // Retry without COD if PostPay unavailable
            if (!r2.success && JSON.stringify(r2.errors||[]).includes("Післяплата") || JSON.stringify(r2.errors||[]).includes("Afterpayment") || JSON.stringify(r2.errors||[]).includes("Контроль")) {
              console.log("Auto-TTN: COD not available at this branch, retrying without COD...");
              delete docData.BackwardDeliveryData;
              delete docData.AfterpaymentOnGoodsCost;
              r2 = await npApi(apiKey, "InternetDocument", "save", docData);
            }
            if (r2.success && r2.data?.[0]) {
              db.prepare("UPDATE orders SET ttn=?,np_ref=?,updated_at=datetime('now','localtime') WHERE id=?").run(r2.data[0].IntDocNumber, r2.data[0].Ref, o2.id);
              console.log("Auto-TTN SUCCESS:", r2.data[0].IntDocNumber);
            } else {
              console.log("Auto-TTN NP error:", JSON.stringify(r2.errors||r2.warnings||[]));
            }
          } catch(e) { console.log("Auto-TTN error:", e.message); }
        }, 1000);
      } else {
        console.log("Auto-TTN: no API key or sender");
      }
    } catch(e) { console.log("Auto-TTN init err:", e.message); }
  }

  res.json({ ok: true, ...result });
});

// List orders
app.get("/api/orders", authMiddleware, (req, res) => {
  const { status, limit, ready, channel, date_from, date_to, ttn_search } = req.query;
  let q = "SELECT o.*,u.name as drop_name FROM orders o JOIN users u ON o.dropshipper_id=u.id";
  const params = [];
  const where = [];

  if (req.user.role === "dropshipper") { where.push("o.dropshipper_id=?"); params.push(req.user.id); }
  if (status) { where.push("o.status=?"); params.push(status); }
  if (channel) { where.push("o.drop_channel=?"); params.push(channel); }
  if (date_from) { where.push("o.created_at>=?"); params.push(date_from); }
  if (date_to) { where.push("o.created_at<=?"); params.push(date_to + " 23:59:59"); }
  if (ttn_search) { where.push("o.ttn LIKE ?"); params.push("%" + ttn_search + "%"); }

  if (where.length) q += " WHERE " + where.join(" AND ");
  q += " ORDER BY o.created_at DESC";
  if (limit) { q += " LIMIT ?"; params.push(parseInt(limit)); }

  const orders = db.prepare(q).all(...params);
  orders.forEach(o => {
    o.items_count = db.prepare("SELECT SUM(quantity) as c FROM order_items WHERE order_id=?").get(o.id).c || 0;
    const readyCount = db.prepare("SELECT COUNT(*) as c FROM order_items oi JOIN variations v ON oi.variation_id=v.id JOIN base_products bp ON v.base_product_id=bp.id JOIN models m ON bp.model_id=m.id WHERE oi.order_id=? AND m.is_ready_product=1").get(o.id).c;
    o.has_ready_items = readyCount > 0;
  });

  // Filter by ready if requested
  let filtered = orders;
  if (ready === "1") filtered = orders.filter(o => o.has_ready_items);
  else if (ready === "0") filtered = orders.filter(o => !o.has_ready_items);

  res.json({ orders: filtered });
});

// Single order with items + return availability
app.get("/api/orders/:id", authMiddleware, (req, res) => {
  const o = db.prepare("SELECT o.*,u.name as drop_name,u.phone as drop_phone FROM orders o JOIN users u ON o.dropshipper_id=u.id WHERE o.id=?").get(req.params.id);
  if (!o) return res.status(404).json({ error: "Не знайдено" });
  if (req.user.role === "dropshipper" && o.dropshipper_id !== req.user.id) return res.status(403).json({ error: "Немає доступу" });

  o.items = db.prepare(`SELECT oi.*,v.name as var_name,v.photo as var_photo,bp.photo as bp_photo,p.photo as print_photo,v.print_id,v.base_product_id,s.name as size_name,p.name as print_name,m.is_ready_product
    FROM order_items oi JOIN variations v ON oi.variation_id=v.id JOIN sizes s ON oi.size_id=s.id LEFT JOIN prints p ON v.print_id=p.id JOIN base_products bp ON v.base_product_id=bp.id JOIN models m ON bp.model_id=m.id
    WHERE oi.order_id=?`).all(o.id);

  // Check return availability and current stock for each item
  o.items.forEach(i => {
    i.return_available = 0;
    if (i.print_id && !i.from_returns) {
      const ret = db.prepare("SELECT quantity FROM stock_returns WHERE variation_id=? AND size_id=?").get(i.variation_id, i.size_id);
      if (ret && ret.quantity > 0) i.return_available = Math.min(ret.quantity, i.quantity);
    }
    const stk = db.prepare("SELECT quantity FROM stock_base WHERE base_product_id=? AND size_id=?").get(i.base_product_id, i.size_id);
    i.current_stock = stk ? stk.quantity : 0;
  });
  res.json({ order: o });
});

// Use return instead of base for an order item
app.post("/api/order-items/:id/use-return", authMiddleware, (req, res) => {

// Swap size in order item
app.post("/api/order-items/:id/swap-size", authMiddleware, (req, res) => {
  const { new_size_id } = req.body;
  const item = db.prepare("SELECT oi.*,v.base_product_id FROM order_items oi JOIN variations v ON oi.variation_id=v.id WHERE oi.id=?").get(req.params.id);
  if (!item) return res.status(404).json({ error: "Не знайдено" });
  const stock = db.prepare("SELECT quantity FROM stock_base WHERE base_product_id=? AND size_id=?").get(item.base_product_id, new_size_id);
  db.prepare("UPDATE order_items SET size_id=? WHERE id=?").run(new_size_id, item.id);
  res.json({ ok: true, new_stock: stock?.quantity || 0 });
});

// Get available sizes for a variation
app.get("/api/order-items/:id/available-sizes", authMiddleware, (req, res) => {
  const item = db.prepare("SELECT oi.*,v.base_product_id FROM order_items oi JOIN variations v ON oi.variation_id=v.id WHERE oi.id=?").get(req.params.id);
  if (!item) return res.status(404).json({ error: "Не знайдено" });
  const sizes = db.prepare(`SELECT s.id,s.name,COALESCE(sb.quantity,0) as stock 
    FROM stock_base sb JOIN sizes s ON sb.size_id=s.id 
    WHERE sb.base_product_id=? ORDER BY s.sort_order`).all(item.base_product_id);
  res.json({ sizes, current_size_id: item.size_id });
});
  const item = db.prepare("SELECT oi.*,v.print_id,v.base_product_id FROM order_items oi JOIN variations v ON oi.variation_id=v.id WHERE oi.id=?").get(req.params.id);
  if (!item) return res.status(404).json({ error: "Не знайдено" });
  if (!item.print_id) return res.status(400).json({ error: "Готовий товар не має повернень" });
  if (item.from_returns >= item.quantity) return res.status(400).json({ error: "Вже списано з повернень" });

  const qty = Math.min(item.quantity - item.from_returns, parseInt(req.body.quantity) || item.quantity);

  // Check returns available
  const ret = db.prepare("SELECT quantity FROM stock_returns WHERE variation_id=? AND size_id=?").get(item.variation_id, item.size_id);
  if (!ret || ret.quantity < qty) return res.status(400).json({ error: "Недостатньо повернень" });

  db.transaction(() => {
    // Deduct from returns
    db.prepare("UPDATE stock_returns SET quantity=quantity-? WHERE variation_id=? AND size_id=?").run(qty, item.variation_id, item.size_id);
    // Return to base (since we took from base at order creation)
    db.prepare("UPDATE stock_base SET quantity=quantity+? WHERE base_product_id=? AND size_id=?").run(qty, item.base_product_id, item.size_id);
    // Mark item
    db.prepare("UPDATE order_items SET from_returns=from_returns+? WHERE id=?").run(qty, item.id);
  })();

  res.json({ ok: true });
});

// Update order status
app.put("/api/orders/:id/status", authMiddleware, (req, res) => {

// Manually set TTN
app.put("/api/orders/:id/ttn", authMiddleware, (req, res) => {
  const { ttn } = req.body;
  db.prepare("UPDATE orders SET ttn=?,updated_at=datetime('now','localtime') WHERE id=?").run(ttn||"", req.params.id);
  res.json({ ok: true });
});
  const { status } = req.body;
  const validStatuses = ['new','in_progress','packed','shipped','delivering','delivered','refused','return_transit','return_warehouse','return_received','cancelled'];
  if (!validStatuses.includes(status)) return res.status(400).json({ error: "Невірний статус" });

  const updates = ["status=?","updated_at=datetime('now','localtime')"];
  const vals = [status];

  if (status === "in_progress" || status === "packed") {
    updates.push("packed_by=?"); vals.push(req.user.id);
    if (status === "packed") { updates.push("packed_at=datetime('now','localtime')"); }
  }

  vals.push(req.params.id);
  db.prepare(`UPDATE orders SET ${updates.join(",")} WHERE id=?`).run(...vals);
  res.json({ ok: true });
});

// Cancel order (return stock)
app.post("/api/orders/:id/cancel", authMiddleware, (req, res) => {
  const o = db.prepare("SELECT * FROM orders WHERE id=?").get(req.params.id);
  if (!o) return res.status(404).json({ error: "Не знайдено" });
  if (o.status === "cancelled") return res.status(400).json({ error: "Вже скасовано" });

  db.transaction(() => {
    // Return stock
    const items = db.prepare("SELECT oi.*,v.base_product_id,v.print_id FROM order_items oi JOIN variations v ON oi.variation_id=v.id WHERE oi.order_id=?").all(o.id);
    items.forEach(i => {
      if (i.from_returns > 0 && i.print_id) {
        db.prepare("UPDATE stock_returns SET quantity=quantity+? WHERE variation_id=? AND size_id=?").run(i.from_returns, i.variation_id, i.size_id);
      }
      const toBase = i.quantity - (i.from_returns || 0);
      if (toBase > 0) {
        db.prepare("UPDATE stock_base SET quantity=quantity+? WHERE base_product_id=? AND size_id=?").run(toBase, i.base_product_id, i.size_id);
      }
    });
    db.prepare("UPDATE orders SET status='cancelled',updated_at=datetime('now','localtime') WHERE id=?").run(o.id);
  })();
  res.json({ ok: true });
});

// Delete order
app.delete("/api/orders/:id", authMiddleware, requireRole("admin"), (req, res) => {
  db.prepare("DELETE FROM orders WHERE id=?").run(req.params.id);
  res.json({ ok: true });
});

// ── RETURNS (повернення) ──────────────────────────────────────────

// List stock returns (for admin view)
app.get("/api/stock-returns", authMiddleware, (req, res) => {
  const items = db.prepare(`SELECT sr.*, v.name as var_name, v.photo as var_photo, s.name as size_name, 
    p.name as print_name, p.photo as print_photo, bp.name as base_name, c.name as color_name, bp.color_id, c.hex_code
    FROM stock_returns sr 
    JOIN variations v ON sr.variation_id=v.id 
    JOIN sizes s ON sr.size_id=s.id 
    JOIN base_products bp ON v.base_product_id=bp.id
    LEFT JOIN prints p ON v.print_id=p.id 
    LEFT JOIN colors c ON bp.color_id=c.id
    WHERE sr.quantity > 0
    ORDER BY v.name, s.sort_order`).all();
  res.json({ items });
});

// Find order by TTN
app.get("/api/orders/by-ttn/:ttn", authMiddleware, (req, res) => {
  const o = db.prepare("SELECT o.*,u.name as drop_name FROM orders o JOIN users u ON o.dropshipper_id=u.id WHERE o.ttn=? OR o.ttn_return=?").get(req.params.ttn, req.params.ttn);
  if (!o) return res.status(404).json({ error: "Замовлення з такою ТТН не знайдено" });
  o.items = db.prepare(`SELECT oi.*,v.name as var_name,v.photo as var_photo,bp.photo as bp_photo,p.photo as print_photo,v.print_id,v.base_product_id,s.name as size_name,p.name as print_name,m.is_ready_product
    FROM order_items oi JOIN variations v ON oi.variation_id=v.id JOIN sizes s ON oi.size_id=s.id LEFT JOIN prints p ON v.print_id=p.id JOIN base_products bp ON v.base_product_id=bp.id JOIN models m ON bp.model_id=m.id
    WHERE oi.order_id=?`).all(o.id);
  res.json({ order: o });
});

// Register return for specific item (checkbox in packer UI)
app.post("/api/order-items/:id/return-to-stock", authMiddleware, (req, res) => {
  const item = db.prepare("SELECT oi.*,v.print_id,v.base_product_id FROM order_items oi JOIN variations v ON oi.variation_id=v.id WHERE oi.id=?").get(req.params.id);
  if (!item) return res.status(404).json({ error: "Не знайдено" });
  if (item.returned_to_stock) return res.status(400).json({ error: "Вже повернуто" });

  db.transaction(() => {
    if (item.print_id) {
      // Has print → goes to returns stock as variation+size
      db.prepare("UPDATE stock_returns SET quantity=quantity+? WHERE variation_id=? AND size_id=?").run(item.quantity, item.variation_id, item.size_id);
    } else {
      // Ready product → goes back to base stock
      db.prepare("UPDATE stock_base SET quantity=quantity+? WHERE base_product_id=? AND size_id=?").run(item.quantity, item.base_product_id, item.size_id);
    }
    db.prepare("UPDATE order_items SET returned_to_stock=1 WHERE id=?").run(item.id);
  })();
  res.json({ ok: true });
});

// Seed test order (for testing returns)
app.post("/api/seed-test-order", authMiddleware, requireRole("admin"), (req, res) => {
  const drop = db.prepare("SELECT id FROM users WHERE role='dropshipper' LIMIT 1").get();
  if (!drop) return res.status(400).json({ error: "Немає дропшиперів" });
  const v = db.prepare("SELECT v.id,v.base_product_id FROM variations v JOIN base_products bp ON v.base_product_id=bp.id LIMIT 1").get();
  if (!v) return res.status(400).json({ error: "Немає варіацій" });
  const sz = db.prepare("SELECT size_id FROM stock_base WHERE base_product_id=? AND quantity>0 LIMIT 1").get(v.base_product_id);
  if (!sz) return res.status(400).json({ error: "Немає залишків" });

  const ttn = "2050" + Math.floor(Math.random()*10000000000).toString().padStart(10,"0");
  const o = db.prepare("INSERT INTO orders(dropshipper_id,status,client_name,client_phone,client_city,client_warehouse,cod_amount,total_drop_price,payout_amount,ttn)VALUES(?,?,?,?,?,?,?,?,?,?)").run(drop.id,"refused","Тест Клієнт","+380991234567","Київ","Відділення №1",500,300,200,ttn);
  db.prepare("INSERT INTO order_items(order_id,variation_id,size_id,quantity,drop_price)VALUES(?,?,?,?,?)").run(o.lastInsertRowid,v.id,sz.size_id,1,300);
  res.json({ ok: true, order_id: o.lastInsertRowid, ttn });
});

// ── NOVA POSHTA API ───────────────────────────────────────────────

async function npApi(apiKey, model, method, props) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify({ apiKey, modelName: model, calledMethod: method, methodProperties: props });
    const req = require("https").request("https://api.novaposhta.ua/v2.0/json/", { method: "POST", headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } }, res => {
      let body = ""; res.on("data", c => body += c); res.on("end", () => { try { resolve(JSON.parse(body)) } catch (e) { reject(e) } });
    });
    req.on("error", reject); req.write(data); req.end();
  });
}

// NP Senders CRUD
app.get("/api/np-senders", authMiddleware, (req, res) => {
  res.json({ senders: db.prepare("SELECT * FROM np_senders ORDER BY is_active DESC, name").all() });
});

app.post("/api/np-senders", authMiddleware, requireRole("admin"), async (req, res) => {
  const { name, phone } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: "Назва обов'язкова" });

  const apiKey = db.prepare("SELECT value FROM settings WHERE key='np_api_key'").get()?.value;
  if (!apiKey) return res.status(400).json({ error: "Спочатку збережіть API ключ НП в налаштуваннях" });

  try {
    // Auto-detect refs from NP API
    const cp = await npApi(apiKey, "Counterparty", "getCounterparties", { CounterpartyProperty: "Sender", Page: "1" });
    let sender = null;
    if (phone) {
      // Try to find by phone
      for (const s of (cp.data || [])) {
        const contacts = await npApi(apiKey, "Counterparty", "getCounterpartyContactPersons", { Ref: s.Ref });
        const match = (contacts.data || []).find(c => c.Phones?.includes(phone.replace(/[^\d]/g, "")));
        if (match) { sender = { ref: s.Ref, contact: match.Ref, desc: s.Description }; break; }
      }
    }
    if (!sender && cp.data?.length) {
      const s = cp.data[0];
      const contacts = await npApi(apiKey, "Counterparty", "getCounterpartyContactPersons", { Ref: s.Ref });
      sender = { ref: s.Ref, contact: contacts.data?.[0]?.Ref || "", desc: s.Description };
    }
    if (!sender) return res.status(400).json({ error: "Контрагент не знайдено в НП" });

    const addrs = await npApi(apiKey, "Counterparty", "getCounterpartyAddresses", { Ref: sender.ref, CounterpartyProperty: "Sender" });
    const addr = addrs.data?.[0];

    const isFirst = !db.prepare("SELECT id FROM np_senders LIMIT 1").get();
    const r = db.prepare("INSERT INTO np_senders(name,phone,sender_ref,address_ref,contact_ref,address_description,is_active)VALUES(?,?,?,?,?,?,?)").run(
      name.trim(), phone || "", sender.ref, addr?.Ref || "", sender.contact, addr?.Description || "", isFirst ? 1 : 0
    );
    res.json({ ok: true, id: r.lastInsertRowid });
  } catch (e) { res.status(500).json({ error: e.message }) }
});

app.put("/api/np-senders/:id/activate", authMiddleware, requireRole("admin"), (req, res) => {
  db.prepare("UPDATE np_senders SET is_active=0").run();
  db.prepare("UPDATE np_senders SET is_active=1 WHERE id=?").run(req.params.id);
  res.json({ ok: true });
});

app.delete("/api/np-senders/:id", authMiddleware, requireRole("admin"), (req, res) => {
  db.prepare("DELETE FROM np_senders WHERE id=?").run(req.params.id);
  res.json({ ok: true });
});

// Create TTN for an order
app.post("/api/nova-poshta/create-ttn/:order_id", authMiddleware, async (req, res) => {
  try {
    const o = db.prepare("SELECT o.*,u.name as drop_name FROM orders o JOIN users u ON o.dropshipper_id=u.id WHERE o.id=?").get(req.params.order_id);
    if (!o) return res.status(404).json({ error: "Замовлення не знайдено" });
    if (o.ttn) return res.status(400).json({ error: "ТТН вже створено: " + o.ttn });

    const apiKey = db.prepare("SELECT value FROM settings WHERE key='np_api_key'").get()?.value;
    if (!apiKey) return res.status(400).json({ error: "Налаштуйте API ключ НП" });

    // Get active sender
    const sender = db.prepare("SELECT * FROM np_senders WHERE is_active=1").get();
    if (!sender) return res.status(400).json({ error: "Додайте контрагента НП і позначте його активним" });

    // Find recipient city
    const cityRes = await npApi(apiKey, "Address", "searchSettlements", { CityName: o.client_city, Limit: 1 });
    const cityData = cityRes.data?.[0]?.Addresses?.[0];
    if (!cityData) return res.status(400).json({ error: "Місто не знайдено в НП: " + o.client_city });

    // Find recipient warehouse
    const whMatch = o.client_warehouse.match(/№?\s*(\d+)/);
    const whNum = whMatch ? whMatch[1] : "";
    const whRes = await npApi(apiKey, "Address", "getWarehouses", { CityRef: cityData.DeliveryCity || cityData.Ref, FindByString: whNum || o.client_warehouse, Limit: "5" });
    const whData = whRes.data?.[0];
    if (!whData) return res.status(400).json({ error: "Відділення не знайдено: " + o.client_warehouse });

    // Get items count and weight
    const itemsCount = db.prepare("SELECT SUM(quantity) as c FROM order_items WHERE order_id=?").get(o.id).c || 1;
    const weight = Math.max(0.5, itemsCount * 0.3);
    const cleanPhone = (p) => p.replace(/[^\d]/g, "").replace(/^(\+?38)?/, "38");

    // Get sender city from counterparty addresses
    const senderAddrs = await npApi(apiKey, "Counterparty", "getCounterpartyAddresses", { Ref: sender.sender_ref, CounterpartyProperty: "Sender" });
    const senderAddr = senderAddrs.data?.find(a => a.Ref === sender.address_ref) || senderAddrs.data?.[0];
    const senderCity = senderAddr?.CityRef || "";

    // Create recipient counterparty
    const nameParts = o.client_name.trim().split(/\s+/);
    const recipRes = await npApi(apiKey, "Counterparty", "save", {
      FirstName: nameParts[1] || nameParts[0] || "Клієнт",
      MiddleName: nameParts[2] || "",
      LastName: nameParts[0] || "Клієнт",
      Phone: cleanPhone(o.client_phone),
      Email: "",
      CounterpartyType: "PrivatePerson",
      CounterpartyProperty: "Recipient"
    });
    if (!recipRes.success || !recipRes.data?.[0]) {
      return res.status(400).json({ error: "Помилка створення отримувача: " + (recipRes.errors?.join(", ")||"") });
    }
    const recipRef = recipRes.data[0].Ref;
    const recipContact = recipRes.data[0].ContactPerson?.data?.[0]?.Ref || "";

    // Create internet document
    const docData = {
      PayerType: "Recipient", PaymentMethod: "Cash",
      DateTime: new Date().toLocaleDateString("uk-UA", { day: "2-digit", month: "2-digit", year: "numeric" }),
      CargoType: "Parcel", Weight: String(weight),
      ServiceType: "WarehouseWarehouse", SeatsAmount: "1", Description: "Одяг",
      Cost: String(o.cod_amount || 300),
      AfterpaymentOnGoodsCost: o.cod_amount > 0 ? String(o.cod_amount) : undefined,
      CitySender: senderCity,
      Sender: sender.sender_ref,
      SenderAddress: sender.address_ref,
      ContactSender: sender.contact_ref,
      SendersPhone: cleanPhone(sender.phone),
      CityRecipient: cityData.DeliveryCity || cityData.Ref,
      Recipient: recipRef,
      RecipientAddress: whData.Ref,
      ContactRecipient: recipContact,
      RecipientsPhone: cleanPhone(o.client_phone),
    };

    const result = await npApi(apiKey, "InternetDocument", "save", docData);
    if (!result.success || !result.data?.[0]) {
      return res.status(400).json({ error: "Помилка НП: " + (result.errors?.join(", ") || JSON.stringify(result.warnings || result)) });
    }

    const ttn = result.data[0].IntDocNumber;
    const npRef = result.data[0].Ref;

    db.prepare("UPDATE orders SET ttn=?,np_ref=?,updated_at=datetime('now','localtime') WHERE id=?").run(ttn, npRef, o.id);
    res.json({ ok: true, ttn, np_ref: npRef });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Print TTN label
app.get("/api/nova-poshta/print/:order_id", authMiddleware, (req, res) => {
  const o = db.prepare("SELECT ttn,np_ref FROM orders WHERE id=?").get(req.params.order_id);
  if (!o || !o.np_ref) return res.status(400).json({ error: "ТТН не створено" });
  // NP print URL format
  const printUrl = `https://my.novaposhta.ua/orders/printMarkings/orders[]/${o.np_ref}/type/pdf/apiKey/${db.prepare("SELECT value FROM settings WHERE key='np_api_key'").get()?.value || ""}`;
  res.json({ url: printUrl });
});

// Track all shipped orders and update statuses
app.post("/api/nova-poshta/track-all", authMiddleware, async (req, res) => {
  try {
    const apiKey = db.prepare("SELECT value FROM settings WHERE key='np_api_key'").get()?.value;
    if (!apiKey) return res.status(400).json({ error: "Немає API ключа" });

    const orders = db.prepare("SELECT id,ttn,status FROM orders WHERE ttn IS NOT NULL AND ttn!='' AND status IN ('shipped','delivering')").all();
    let updated = 0;

    for (const o of orders) {
      try {
        const r = await npApi(apiKey, "TrackingDocument", "getStatusDocuments", { Documents: [{ DocumentNumber: o.ttn }] });
        const st = r.data?.[0];
        if (!st) continue;

        const code = parseInt(st.StatusCode);
        let newStatus = null;
        if (code >= 7 && code <= 8) newStatus = "delivering";
        if (code === 9 || code === 10 || code === 11) newStatus = "delivered";
        if (code === 17 || code === 102 || code === 103) newStatus = "refused";
        if (code === 106) newStatus = "return_transit";

        if (newStatus && newStatus !== o.status) {
          db.prepare("UPDATE orders SET status=?,updated_at=datetime('now','localtime') WHERE id=?").run(newStatus, o.id);
          updated++;
        }
      } catch (e) { /* skip individual errors */ }
    }
    res.json({ ok: true, checked: orders.length, updated });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Search NP cities
app.post("/api/nova-poshta/search-city", authMiddleware, async (req, res) => {
  try {
    const apiKey = db.prepare("SELECT value FROM settings WHERE key='np_api_key'").get()?.value;
    if (!apiKey) return res.status(400).json({ error: "Немає API ключа" });
    const r = await npApi(apiKey, "Address", "searchSettlements", { CityName: req.body.query, Limit: 10 });
    res.json({ cities: r.data?.[0]?.Addresses || [] });
  } catch (e) { res.status(500).json({ error: e.message }) }
});

// Search NP warehouses
app.post("/api/nova-poshta/search-warehouse", authMiddleware, async (req, res) => {
  try {
    const apiKey = db.prepare("SELECT value FROM settings WHERE key='np_api_key'").get()?.value;
    if (!apiKey) return res.status(400).json({ error: "Немає API ключа" });
    // Try CityRef first, then SettlementRef for villages
    let r = await npApi(apiKey, "Address", "getWarehouses", { CityRef: req.body.city_ref, FindByString: req.body.query || "", Limit: 20 });
    if (!r.data?.length && req.body.settle_ref) {
      r = await npApi(apiKey, "Address", "getWarehouses", { SettlementRef: req.body.settle_ref, FindByString: req.body.query || "", Limit: 20 });
    }
    if (!r.data?.length) {
      r = await npApi(apiKey, "Address", "getWarehouses", { SettlementRef: req.body.city_ref, FindByString: req.body.query || "", Limit: 20 });
    }
    res.json({ warehouses: r.data || [] });
  } catch (e) { res.status(500).json({ error: e.message }) }
});

// Auto-detect sender refs
app.post("/api/nova-poshta/detect-sender", authMiddleware, requireRole("admin"), async (req, res) => {
  try {
    const { api_key, phone } = req.body;
    // Get counterparties
    const cp = await npApi(api_key, "Counterparty", "getCounterparties", { CounterpartyProperty: "Sender", Page: "1" });
    if (!cp.data?.length) return res.status(400).json({ error: "Контрагент не знайдено" });
    const sender = cp.data[0];
    // Get contact persons
    const contacts = await npApi(api_key, "Counterparty", "getCounterpartyContactPersons", { Ref: sender.Ref, Page: "1" });
    const contact = contacts.data?.[0];
    // Get addresses
    const addrs = await npApi(api_key, "Counterparty", "getCounterpartyAddresses", { Ref: sender.Ref, CounterpartyProperty: "Sender" });
    const addr = addrs.data?.[0];
    res.json({ sender_ref: sender.Ref, contact_ref: contact?.Ref || "", address_ref: addr?.Ref || "", sender_name: sender.Description, address_desc: addr?.Description || "" });
  } catch (e) { res.status(500).json({ error: e.message }) }
});

// ── DASHBOARD ────────────────────────────────────────────────────

// Update user profile
app.put("/api/auth/profile", authMiddleware, (req, res) => {
  const { payment_type, payment_card, payment_iban, edrpou, full_name, payment_purpose, phone, telegram } = req.body;
  db.prepare("UPDATE users SET payment_type=?,payment_card=?,payment_iban=?,edrpou=?,full_name=?,payment_purpose=?,phone=?,telegram=? WHERE id=?")
    .run(payment_type||"card", payment_card||"", payment_iban||"", edrpou||"", full_name||"", payment_purpose||"", phone||"", telegram||"", req.user.id);
  res.json({ ok: true });
});

// ── PAYOUTS ──────────────────────────────────────────────────────

// Get payout data for dropshipper
app.get("/api/payouts/my", authMiddleware, (req, res) => {
  const uid = req.user.id;
  // Orders delivered but not in any payout
  const unpaid = db.prepare(`SELECT o.* FROM orders o WHERE o.dropshipper_id=? AND o.status='delivered' AND o.id NOT IN (SELECT order_id FROM payout_items) AND o.is_prepaid=0`).all(uid);
  // Returns not in any payout
  const returns = db.prepare(`SELECT o.* FROM orders o WHERE o.dropshipper_id=? AND o.status IN ('refused','return_transit') AND o.id NOT IN (SELECT order_id FROM payout_items) AND o.is_prepaid=0`).all(uid);
  // Active (pending) payout request
  const active = db.prepare(`SELECT * FROM payout_requests WHERE dropshipper_id=? AND status='pending' ORDER BY id DESC LIMIT 1`).get(uid);
  let activeItems = [];
  if (active) activeItems = db.prepare(`SELECT pi.*,o.cod_amount,o.payout_amount,o.client_name,o.ttn,o.status as order_status FROM payout_items pi JOIN orders o ON pi.order_id=o.id WHERE pi.payout_request_id=?`).all(active.id);
  // History
  const history = db.prepare(`SELECT * FROM payout_requests WHERE dropshipper_id=? ORDER BY id DESC`).all(uid);
  res.json({ unpaid, returns, active, activeItems, history });
});

// Create or add to payout request
app.post("/api/payouts/request", authMiddleware, (req, res) => {
  const uid = req.user.id;
  const { comment } = req.body;
  // Find or create active request
  let pr = db.prepare(`SELECT * FROM payout_requests WHERE dropshipper_id=? AND status='pending' ORDER BY id DESC LIMIT 1`).get(uid);
  if (!pr) {
    const r = db.prepare("INSERT INTO payout_requests(dropshipper_id,comment)VALUES(?,?)").run(uid, comment || "");
    pr = { id: r.lastInsertRowid };
  } else if (comment) {
    db.prepare("UPDATE payout_requests SET comment=? WHERE id=?").run(comment, pr.id);
  }
  // Add delivered orders not yet in any payout
  const unpaid = db.prepare(`SELECT o.* FROM orders o WHERE o.dropshipper_id=? AND o.status='delivered' AND o.id NOT IN (SELECT order_id FROM payout_items) AND o.is_prepaid=0`).all(uid);
  const returns = db.prepare(`SELECT o.* FROM orders o WHERE o.dropshipper_id=? AND o.status IN ('refused','return_transit') AND o.id NOT IN (SELECT order_id FROM payout_items) AND o.is_prepaid=0`).all(uid);
  const ins = db.prepare("INSERT OR IGNORE INTO payout_items(payout_request_id,order_id,amount,is_return)VALUES(?,?,?,?)");
  unpaid.forEach(o => ins.run(pr.id, o.id, o.payout_amount, 0));
  returns.forEach(o => ins.run(pr.id, o.id, -(o.payout_amount || 0), 1));
  // Recalc total
  const total = db.prepare("SELECT SUM(amount) as s FROM payout_items WHERE payout_request_id=?").get(pr.id).s || 0;
  db.prepare("UPDATE payout_requests SET total_amount=? WHERE id=?").run(total, pr.id);
  res.json({ ok: true, request_id: pr.id, total });
});

// Admin: list all payout requests
app.get("/api/payouts/all", authMiddleware, requireRole("admin"), (req, res) => {
  const requests = db.prepare(`SELECT pr.*,u.name as drop_name,u.payment_type,u.payment_card,u.payment_iban,u.full_name,u.phone FROM payout_requests pr JOIN users u ON pr.dropshipper_id=u.id ORDER BY CASE WHEN pr.status='pending' THEN 0 ELSE 1 END, pr.created_at DESC`).all();
  requests.forEach(r => {
    r.items = db.prepare(`SELECT pi.*,o.cod_amount,o.client_name,o.ttn,o.status as order_status FROM payout_items pi JOIN orders o ON pi.order_id=o.id WHERE pi.payout_request_id=?`).all(r.id);
  });
  res.json({ requests });
});

// Admin: mark payout as paid
app.put("/api/payouts/:id/paid", authMiddleware, requireRole("admin"), (req, res) => {
  db.prepare("UPDATE payout_requests SET status='paid',paid_at=datetime('now','localtime') WHERE id=?").run(req.params.id);
  res.json({ ok: true });
});
app.get("/api/dashboard", authMiddleware, (req, res) => {
  const { period } = req.query; // today, yesterday, week, month, all
  let dateFilter = "";
  if (period === "today") dateFilter = "AND date(created_at)=date('now','localtime')";
  else if (period === "yesterday") dateFilter = "AND date(created_at)=date('now','localtime','-1 day')";
  else if (period === "week") dateFilter = "AND created_at>=datetime('now','localtime','-7 days')";
  else if (period === "month") dateFilter = "AND created_at>=datetime('now','localtime','-30 days')";

  if (req.user.role === "admin") {
    res.json({ dropshippers: db.prepare("SELECT COUNT(*) as c FROM users WHERE role='dropshipper' AND active=1").get().c, warehouse_workers: db.prepare("SELECT COUNT(*) as c FROM users WHERE role='warehouse' AND active=1").get().c, models: db.prepare("SELECT COUNT(*) as c FROM models WHERE active=1").get().c, base_products: db.prepare("SELECT COUNT(*) as c FROM base_products WHERE active=1").get().c, variations: db.prepare("SELECT COUNT(*) as c FROM variations WHERE active=1").get().c, orders_today: db.prepare("SELECT COUNT(*) as c FROM orders WHERE date(created_at)=date('now','localtime')").get().c, orders_new: db.prepare("SELECT COUNT(*) as c FROM orders WHERE status='new'").get().c });
  } else if (req.user.role === "dropshipper") {
    const uid = req.user.id;
    res.json({
      my_orders_total: db.prepare("SELECT COUNT(*) as c FROM orders WHERE dropshipper_id=? "+dateFilter).get(uid).c,
      my_orders_new: db.prepare("SELECT COUNT(*) as c FROM orders WHERE dropshipper_id=? AND status='new' "+dateFilter).get(uid).c,
      my_orders_delivered: db.prepare("SELECT COUNT(*) as c FROM orders WHERE dropshipper_id=? AND status='delivered' "+dateFilter).get(uid).c,
      my_orders_refused: db.prepare("SELECT COUNT(*) as c FROM orders WHERE dropshipper_id=? AND status='refused' "+dateFilter).get(uid).c,
      my_cod_total: db.prepare("SELECT COALESCE(SUM(cod_amount),0) as s FROM orders WHERE dropshipper_id=? "+dateFilter).get(uid).s,
      my_payout: db.prepare("SELECT COALESCE(SUM(payout_amount),0) as s FROM orders WHERE dropshipper_id=? AND status='delivered' "+dateFilter).get(uid).s,
      my_drop_total: db.prepare("SELECT COALESCE(SUM(total_drop_price),0) as s FROM orders WHERE dropshipper_id=? "+dateFilter).get(uid).s
    });
  } else {
    res.json({ orders_new: db.prepare("SELECT COUNT(*) as c FROM orders WHERE status='new'").get().c, orders_in_progress: db.prepare("SELECT COUNT(*) as c FROM orders WHERE status='in_progress'").get().c, orders_packed: db.prepare("SELECT COUNT(*) as c FROM orders WHERE status='packed'").get().c });
  }
});

// Edit order (admin)
app.put("/api/orders/:id/edit", authMiddleware, requireRole("admin"), (req, res) => {
  const { client_name, client_phone, client_city, client_warehouse, cod_amount, declared_value, note } = req.body;
  const o = db.prepare("SELECT * FROM orders WHERE id=?").get(req.params.id);
  if (!o) return res.status(404).json({ error: "Not found" });
  const cod = parseFloat(cod_amount) ?? o.cod_amount;
  const payout = o.is_prepaid ? 0 : Math.round((cod - o.total_drop_price) * 100) / 100;
  db.prepare("UPDATE orders SET client_name=?,client_phone=?,client_city=?,client_warehouse=?,cod_amount=?,declared_value=?,note=?,payout_amount=?,updated_at=datetime('now','localtime') WHERE id=?")
    .run(client_name||o.client_name, client_phone||o.client_phone, client_city||o.client_city, client_warehouse||o.client_warehouse, cod, parseFloat(declared_value)||o.declared_value, note??o.note, payout, o.id);
  res.json({ ok: true });
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

// Auto-track NP statuses every 15 minutes
async function autoTrackNP(){
  try{
    const apiKey=db.prepare("SELECT value FROM settings WHERE key='np_api_key'").get()?.value;
    if(!apiKey)return;
    const orders=db.prepare("SELECT id,ttn,status FROM orders WHERE ttn IS NOT NULL AND ttn!='' AND status IN ('shipped','delivering')").all();
    if(!orders.length)return;
    for(const o of orders){
      try{
        const r=await npApi(apiKey,"TrackingDocument","getStatusDocuments",{Documents:[{DocumentNumber:o.ttn}]});
        const st=r.data?.[0];if(!st)continue;
        const code=parseInt(st.StatusCode);
        let ns=null;
        if(code>=7&&code<=8)ns="delivering";
        if(code===9||code===10||code===11)ns="delivered";
        if(code===17||code===102||code===103)ns="refused";
        if(code===106)ns="return_transit";
        if(ns&&ns!==o.status)db.prepare("UPDATE orders SET status=?,updated_at=datetime('now','localtime') WHERE id=?").run(ns,o.id);
      }catch(e){}
    }
    console.log(`🔄 NP auto-track: checked ${orders.length} orders`);
  }catch(e){}
}
setInterval(autoTrackNP,15*60*1000);
setTimeout(autoTrackNP,30000); // First check 30s after start

app.listen(PORT, () => console.log(`✅ CRM on http://localhost:${PORT}`));

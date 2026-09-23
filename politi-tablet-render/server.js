const express = require("express");
const session = require("express-session");
const pgSession = require("connect-pg-simple")(session);
const { Pool } = require("pg");
const bcrypt = require("bcryptjs");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

if (!process.env.DATABASE_URL) {
  console.warn("DATABASE_URL is missing. Configure it in Render.");
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : false
});

app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(session({
  store: new pgSession({ pool, tableName: "user_sessions", createTableIfMissing: true }),
  secret: process.env.SESSION_SECRET || "dev-only-change-me",
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: 8 * 60 * 60 * 1000
  }
}));
app.use(express.static(path.join(__dirname, "public")));

async function q(text, params = []) {
  return pool.query(text, params);
}

async function initDb() {
  await q(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      username VARCHAR(80) UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      full_name VARCHAR(120) NOT NULL,
      rank VARCHAR(120) NOT NULL DEFAULT 'Betjent',
      badge_number VARCHAR(40),
      role VARCHAR(30) NOT NULL DEFAULT 'officer',
      active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS persons (
      id SERIAL PRIMARY KEY,
      name VARCHAR(160) NOT NULL,
      address TEXT,
      phone VARCHAR(60),
      birth_date DATE,
      gender VARCHAR(30),
      notes TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS vehicles (
      id SERIAL PRIMARY KEY,
      plate VARCHAR(30) UNIQUE NOT NULL,
      owner_id INTEGER REFERENCES persons(id) ON DELETE SET NULL,
      make VARCHAR(80),
      model VARCHAR(80),
      category VARCHAR(80),
      color VARCHAR(50),
      status VARCHAR(40) NOT NULL DEFAULT 'Normal',
      notes TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS cases (
      id SERIAL PRIMARY KEY,
      case_number VARCHAR(40) UNIQUE NOT NULL,
      person_id INTEGER REFERENCES persons(id) ON DELETE CASCADE,
      officer_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      title VARCHAR(180) NOT NULL,
      description TEXT,
      fine_dkk INTEGER NOT NULL DEFAULT 0,
      prison_days INTEGER NOT NULL DEFAULT 0,
      license_points INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS warrants (
      id SERIAL PRIMARY KEY,
      person_id INTEGER REFERENCES persons(id) ON DELETE CASCADE,
      vehicle_id INTEGER REFERENCES vehicles(id) ON DELETE CASCADE,
      type VARCHAR(40) NOT NULL,
      title VARCHAR(180) NOT NULL,
      description TEXT,
      active BOOLEAN NOT NULL DEFAULT TRUE,
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS fines (
      id SERIAL PRIMARY KEY,
      category VARCHAR(100) NOT NULL,
      code VARCHAR(40),
      title VARCHAR(180) NOT NULL,
      price_dkk INTEGER NOT NULL DEFAULT 0,
      points INTEGER NOT NULL DEFAULT 0,
      description TEXT
    );

    CREATE TABLE IF NOT EXISTS board_posts (
      id SERIAL PRIMARY KEY,
      title VARCHAR(180) NOT NULL,
      body TEXT NOT NULL,
      author_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      pinned BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS applications (
      id SERIAL PRIMARY KEY,
      applicant_name VARCHAR(160) NOT NULL,
      type VARCHAR(100) NOT NULL,
      status VARCHAR(40) NOT NULL DEFAULT 'Afventer',
      message TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS audit_logs (
      id BIGSERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      action VARCHAR(80) NOT NULL,
      title VARCHAR(180) NOT NULL,
      description TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS settings (
      key VARCHAR(100) PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  const admin = await q("SELECT id FROM users WHERE username='admin'");
  if (!admin.rowCount) {
    const hash = await bcrypt.hash("admin123", 12);
    await q(
      `INSERT INTO users(username,password_hash,full_name,rank,badge_number,role)
       VALUES($1,$2,$3,$4,$5,$6)`,
      ["admin", hash, "Administrator", "Rigspolitichef", "00-01", "admin"]
    );
  }

  const p = await q("SELECT COUNT(*)::int AS c FROM persons");
  if (p.rows[0].c === 0) {
    await q(`INSERT INTO persons(name,address,phone,birth_date,gender,notes)
             VALUES
             ('Mikkel Hansen','Fantastisk Plads 1','60799831','2003-03-02','Mand','Testperson'),
             ('Test Person','Politi HQ 2','12345678','1999-08-15','Mand','Demodata')`);
  }

  const f = await q("SELECT COUNT(*)::int AS c FROM fines");
  if (f.rows[0].c === 0) {
    await q(`INSERT INTO fines(category,code,title,price_dkk,points,description) VALUES
      ('Færdselsloven','FL-001','Hastighedsovertrædelse',1500,1,'Kørsel over hastighedsgrænsen'),
      ('Færdselsloven','FL-002','Kørsel uden sele',1000,0,'Manglende sikkerhedssele'),
      ('Straffeloven','SL-001','Ulovlig besiddelse',5000,0,'Testtakst til RP-server')`);
  }

  const s = await q("SELECT COUNT(*)::int AS c FROM settings");
  if (s.rows[0].c === 0) {
    await q(`INSERT INTO settings(key,value) VALUES
      ('language','da'),
      ('site_name','POLITI'),
      ('frakendelse_years','3')`);
  }
}

function requireAuth(req, res, next) {
  if (!req.session.user) return res.status(401).json({ error: "Ikke logget ind" });
  next();
}
function requireAdmin(req, res, next) {
  if (!req.session.user || req.session.user.role !== "admin") {
    return res.status(403).json({ error: "Ingen adgang" });
  }
  next();
}

async function logAction(userId, action, title, description = "") {
  await q("INSERT INTO audit_logs(user_id,action,title,description) VALUES($1,$2,$3,$4)",
    [userId, action, title, description]);
}

app.get("/api/health", async (_req, res) => {
  try { await q("SELECT 1"); res.json({ ok: true, database: "connected" }); }
  catch (e) { res.status(503).json({ ok: false, error: e.message }); }
});

app.post("/api/login", async (req, res) => {
  const { username, password } = req.body;
  const r = await q("SELECT * FROM users WHERE username=$1 AND active=true", [username]);
  if (!r.rowCount || !(await bcrypt.compare(password || "", r.rows[0].password_hash))) {
    return res.status(401).json({ error: "Forkert brugernavn eller adgangskode" });
  }
  const u = r.rows[0];
  req.session.user = { id: u.id, username: u.username, full_name: u.full_name, rank: u.rank, badge_number: u.badge_number, role: u.role };
  await logAction(u.id, "LOGIN", "Login", `Bruger ${u.username} loggede ind`);
  res.json({ user: req.session.user });
});

app.post("/api/logout", requireAuth, async (req,res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get("/api/me", requireAuth, (req,res) => res.json({ user: req.session.user }));

app.get("/api/dashboard", requireAuth, async (_req,res) => {
  const [persons, vehicles, cases, warrants, employees, apps] = await Promise.all([
    q("SELECT COUNT(*)::int c FROM persons"),
    q("SELECT COUNT(*)::int c FROM vehicles"),
    q("SELECT COUNT(*)::int c FROM cases"),
    q("SELECT COUNT(*)::int c FROM warrants WHERE active=true"),
    q("SELECT COUNT(*)::int c FROM users WHERE active=true"),
    q("SELECT COUNT(*)::int c FROM applications WHERE status='Afventer'")
  ]);
  res.json({
    persons: persons.rows[0].c, vehicles: vehicles.rows[0].c, cases: cases.rows[0].c,
    warrants: warrants.rows[0].c, employees: employees.rows[0].c, applications: apps.rows[0].c
  });
});

app.get("/api/persons", requireAuth, async (req,res) => {
  const term = `%${req.query.search || ""}%`;
  const r = await q(`SELECT * FROM persons WHERE name ILIKE $1 OR COALESCE(phone,'') ILIKE $1 ORDER BY name`, [term]);
  res.json(r.rows);
});

app.post("/api/persons", requireAuth, async (req,res) => {
  const { name,address,phone,birth_date,gender,notes } = req.body;
  const r = await q(`INSERT INTO persons(name,address,phone,birth_date,gender,notes)
                     VALUES($1,$2,$3,$4,$5,$6) RETURNING *`,
                     [name,address||null,phone||null,birth_date||null,gender||null,notes||null]);
  await logAction(req.session.user.id,"CREATE","Opret person",`Person ${name}`);
  res.status(201).json(r.rows[0]);
});

app.get("/api/persons/:id", requireAuth, async (req,res) => {
  const p = await q("SELECT * FROM persons WHERE id=$1",[req.params.id]);
  if (!p.rowCount) return res.status(404).json({error:"Person ikke fundet"});
  const [cases, vehicles, warrants] = await Promise.all([
    q(`SELECT c.*, u.full_name officer_name FROM cases c LEFT JOIN users u ON u.id=c.officer_id WHERE person_id=$1 ORDER BY c.created_at DESC`,[req.params.id]),
    q("SELECT * FROM vehicles WHERE owner_id=$1 ORDER BY plate",[req.params.id]),
    q("SELECT * FROM warrants WHERE person_id=$1 ORDER BY created_at DESC",[req.params.id])
  ]);
  res.json({person:p.rows[0],cases:cases.rows,vehicles:vehicles.rows,warrants:warrants.rows});
});

app.post("/api/persons/:id/cases", requireAuth, async (req,res) => {
  const {title,description,fine_dkk=0,prison_days=0,license_points=0}=req.body;
  const caseNumber = `SAG-${new Date().getFullYear()}-${Date.now().toString().slice(-6)}`;
  const r = await q(`INSERT INTO cases(case_number,person_id,officer_id,title,description,fine_dkk,prison_days,license_points)
                     VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
                     [caseNumber,req.params.id,req.session.user.id,title,description||"",Number(fine_dkk),Number(prison_days),Number(license_points)]);
  await logAction(req.session.user.id,"CREATE","Opret sag",caseNumber);
  res.status(201).json(r.rows[0]);
});

app.get("/api/vehicles", requireAuth, async (req,res) => {
  const term = `%${req.query.search || ""}%`;
  const r = await q(`SELECT v.*, p.name owner_name FROM vehicles v LEFT JOIN persons p ON p.id=v.owner_id
                     WHERE v.plate ILIKE $1 OR COALESCE(v.make,'') ILIKE $1 OR COALESCE(v.model,'') ILIKE $1
                     ORDER BY v.plate`, [term]);
  res.json(r.rows);
});

app.post("/api/vehicles", requireAuth, async (req,res) => {
  const {plate,owner_id,make,model,category,color,status="Normal",notes}=req.body;
  const r=await q(`INSERT INTO vehicles(plate,owner_id,make,model,category,color,status,notes)
                   VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
                   [plate,owner_id||null,make||null,model||null,category||null,color||null,status,notes||null]);
  await logAction(req.session.user.id,"CREATE","Opret køretøj",plate);
  res.status(201).json(r.rows[0]);
});

app.get("/api/warrants", requireAuth, async (_req,res) => {
  const r=await q(`SELECT w.*, p.name person_name, v.plate FROM warrants w
                   LEFT JOIN persons p ON p.id=w.person_id
                   LEFT JOIN vehicles v ON v.id=w.vehicle_id
                   ORDER BY w.active DESC,w.created_at DESC`);
  res.json(r.rows);
});

app.post("/api/warrants", requireAuth, async (req,res) => {
  const {person_id,vehicle_id,type="Person",title,description}=req.body;
  const r=await q(`INSERT INTO warrants(person_id,vehicle_id,type,title,description,created_by)
                   VALUES($1,$2,$3,$4,$5,$6) RETURNING *`,
                   [person_id||null,vehicle_id||null,type,title,description||"",req.session.user.id]);
  await logAction(req.session.user.id,"CREATE","Opret efterlysning",title);
  res.status(201).json(r.rows[0]);
});

app.get("/api/fines", requireAuth, async (req,res) => {
  const term=`%${req.query.search||""}%`;
  const r=await q(`SELECT * FROM fines WHERE title ILIKE $1 OR category ILIKE $1 OR COALESCE(code,'') ILIKE $1 ORDER BY category,title`,[term]);
  res.json(r.rows);
});

app.get("/api/board", requireAuth, async (_req,res) => {
  const r=await q(`SELECT b.*,u.full_name author_name,u.rank FROM board_posts b LEFT JOIN users u ON u.id=b.author_id ORDER BY b.pinned DESC,b.created_at DESC`);
  res.json(r.rows);
});

app.post("/api/board", requireAuth, async (req,res) => {
  const r=await q(`INSERT INTO board_posts(title,body,author_id,pinned) VALUES($1,$2,$3,$4) RETURNING *`,
    [req.body.title,req.body.body,req.session.user.id,!!req.body.pinned]);
  await logAction(req.session.user.id,"CREATE","Nyt opslag",req.body.title);
  res.status(201).json(r.rows[0]);
});

app.get("/api/employees", requireAuth, async (_req,res) => {
  const r=await q("SELECT id,username,full_name,rank,badge_number,role,active,created_at FROM users ORDER BY active DESC,rank,full_name");
  res.json(r.rows);
});

app.get("/api/applications", requireAuth, async (_req,res) => {
  const r=await q("SELECT * FROM applications ORDER BY created_at DESC");
  res.json(r.rows);
});

app.get("/api/logs", requireAdmin, async (_req,res) => {
  const r=await q(`SELECT l.*,u.full_name FROM audit_logs l LEFT JOIN users u ON u.id=l.user_id ORDER BY l.created_at DESC LIMIT 250`);
  res.json(r.rows);
});

app.get("/api/settings", requireAdmin, async (_req,res) => {
  const r=await q("SELECT * FROM settings ORDER BY key");
  res.json(Object.fromEntries(r.rows.map(x=>[x.key,x.value])));
});

app.post("/api/settings", requireAdmin, async (req,res) => {
  for (const [key,value] of Object.entries(req.body || {})) {
    await q(`INSERT INTO settings(key,value) VALUES($1,$2)
             ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value`,[key,String(value)]);
  }
  await logAction(req.session.user.id,"UPDATE","Opdater indstillinger","Systemindstillinger ændret");
  res.json({ok:true});
});

app.get("*", (_req,res) => res.sendFile(path.join(__dirname,"public","index.html")));

initDb()
  .then(()=>app.listen(PORT,()=>console.log(`POLITI Tablet running on port ${PORT}`)))
  .catch(err=>{ console.error("Database initialization failed:",err); process.exit(1); });

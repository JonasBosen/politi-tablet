const express = require("express");
const session = require("express-session");
const pgSession = require("connect-pg-simple")(session);
const { Pool } = require("pg");
const bcrypt = require("bcryptjs");
const path = require("path");
const crypto = require("crypto");
const fs = require("fs");

const app = express();
const PORT = process.env.PORT || 3000;
// Render terminates TLS at its proxy; trust its forwarded HTTPS header so
// secure session cookies are issued on production requests.
app.set("trust proxy", 1);

// Express 4 does not forward rejected async route handlers to error middleware.
const wrapAsync = handler => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
for (const method of ["get", "post", "patch", "delete"]) {
  const original = app[method].bind(app);
  app[method] = (route, ...handlers) => original(route, ...handlers.map(h => h.length === 3 ? h : wrapAsync(h)));
}

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
      employment_status VARCHAR(30) NOT NULL DEFAULT 'Aktiv',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    ALTER TABLE users ADD COLUMN IF NOT EXISTS employment_status VARCHAR(30) NOT NULL DEFAULT 'Aktiv';
    UPDATE users SET employment_status='Inaktiv' WHERE active=false AND employment_status='Aktiv';

    CREATE TABLE IF NOT EXISTS ranks (
      id SERIAL PRIMARY KEY,
      name VARCHAR(120) UNIQUE NOT NULL,
      level INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS user_preferences (
      user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      font_scale INTEGER NOT NULL DEFAULT 100 CHECK (font_scale BETWEEN 80 AND 150),
      text_color VARCHAR(7) NOT NULL DEFAULT '#eef0f5',
      tablet_color VARCHAR(7) NOT NULL DEFAULT '#181b22',
      profile_image TEXT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    ALTER TABLE user_preferences ADD COLUMN IF NOT EXISTS profile_image TEXT;

    CREATE TABLE IF NOT EXISTS persons (
      id SERIAL PRIMARY KEY,
      name VARCHAR(160) NOT NULL,
      address TEXT,
      phone VARCHAR(60),
      birth_date DATE,
      gender VARCHAR(30),
      notes TEXT,
      external_id VARCHAR(200),
      source VARCHAR(40) NOT NULL DEFAULT 'manual',
      last_seen_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    ALTER TABLE persons ADD COLUMN IF NOT EXISTS external_id VARCHAR(200);
    ALTER TABLE persons ADD COLUMN IF NOT EXISTS source VARCHAR(40) NOT NULL DEFAULT 'manual';
    ALTER TABLE persons ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ;
    CREATE UNIQUE INDEX IF NOT EXISTS persons_external_id_unique_idx ON persons(external_id) WHERE external_id IS NOT NULL;

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

    CREATE TABLE IF NOT EXISTS fleet_vehicles (
      id SERIAL PRIMARY KEY,
      call_sign VARCHAR(40) UNIQUE NOT NULL,
      plate VARCHAR(30) UNIQUE NOT NULL,
      model VARCHAR(120) NOT NULL,
      status VARCHAR(30) NOT NULL DEFAULT 'Ledig',
      assigned_to INTEGER REFERENCES users(id) ON DELETE SET NULL,
      location_x NUMERIC(10,2),
      location_y NUMERIC(10,2),
      notes TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS dispatch_calls (
      id BIGSERIAL PRIMARY KEY,
      external_id VARCHAR(160) UNIQUE,
      caller_name VARCHAR(160) NOT NULL DEFAULT 'Ukendt',
      caller_phone VARCHAR(60),
      category VARCHAR(80) NOT NULL DEFAULT '112',
      message TEXT NOT NULL,
      coord_x NUMERIC(10,2) NOT NULL,
      coord_y NUMERIC(10,2) NOT NULL,
      coord_z NUMERIC(10,2) NOT NULL DEFAULT 0,
      status VARCHAR(20) NOT NULL DEFAULT 'pending',
      claimed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      accepted_at TIMESTAMPTZ,
      closed_at TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS dispatch_calls_status_created_idx ON dispatch_calls(status,created_at DESC);

    CREATE TABLE IF NOT EXISTS cases (
      id SERIAL PRIMARY KEY,
      case_number VARCHAR(40) UNIQUE NOT NULL,
      person_id INTEGER REFERENCES persons(id) ON DELETE CASCADE,
      officer_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      title VARCHAR(180) NOT NULL,
      description TEXT,
      fine_dkk INTEGER NOT NULL DEFAULT 0,
      prison_days INTEGER NOT NULL DEFAULT 0,
      prison_months INTEGER NOT NULL DEFAULT 0,
      license_points INTEGER NOT NULL DEFAULT 0,
      penalties JSONB NOT NULL DEFAULT '[]'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    ALTER TABLE cases ADD COLUMN IF NOT EXISTS penalties JSONB NOT NULL DEFAULT '[]'::jsonb;
    ALTER TABLE cases ADD COLUMN IF NOT EXISTS prison_months INTEGER NOT NULL DEFAULT 0;

    CREATE TABLE IF NOT EXISTS seized_items (
      id SERIAL PRIMARY KEY,
      person_id INTEGER NOT NULL REFERENCES persons(id) ON DELETE CASCADE,
      case_id INTEGER REFERENCES cases(id) ON DELETE SET NULL,
      item_name VARCHAR(180) NOT NULL,
      description TEXT,
      officer_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
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
      prison_days INTEGER NOT NULL DEFAULT 0,
      prison_months INTEGER NOT NULL DEFAULT 0,
      description TEXT
    );
    ALTER TABLE fines ADD COLUMN IF NOT EXISTS prison_days INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE fines ADD COLUMN IF NOT EXISTS prison_months INTEGER NOT NULL DEFAULT 0;

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

  const rankLadder = await q("SELECT value FROM settings WHERE key='rank_ladder_initialized'");
  if (rankLadder.rows[0]?.value !== "true") {
    const defaultRanks = [
      {name:"Politi-Elev",level:1},{name:"Politibetjent",level:2},{name:"Politiassistent",level:3},
      {name:"Politiassistent 1 Grad",level:4},{name:"Politikommissær",level:5},{name:"Vicepolitiinspektør",level:6},
      {name:"Vicepolitimester",level:7},{name:"Chefpolitiinspektør",level:8},{name:"Politidirektør",level:9},
      {name:"Rigspolitichef",level:10},{name:"Admin",level:11}
    ];
    await q(`INSERT INTO ranks(name,level)
             SELECT r.name,r.level FROM jsonb_to_recordset($1::jsonb) AS r(name text,level integer)
             ON CONFLICT(name) DO UPDATE SET level=EXCLUDED.level`, [JSON.stringify(defaultRanks)]);
    await q(`UPDATE users SET rank=CASE
               WHEN role='admin' THEN 'Admin'
               WHEN rank IN ('Politi-Elev','Politibetjent','Politiassistent','Politiassistent 1 Grad','Politikommissær','Vicepolitiinspektør','Vicepolitimester','Chefpolitiinspektør','Politidirektør','Rigspolitichef','Admin') THEN rank
               ELSE 'Politi-Elev' END`);
    await q("DELETE FROM ranks WHERE level NOT BETWEEN 1 AND 11 OR name NOT IN ('Politi-Elev','Politibetjent','Politiassistent','Politiassistent 1 Grad','Politikommissær','Vicepolitiinspektør','Vicepolitimester','Chefpolitiinspektør','Politidirektør','Rigspolitichef','Admin')");
    await q("INSERT INTO settings(key,value) VALUES('rank_ladder_initialized','true') ON CONFLICT(key) DO UPDATE SET value='true'");
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
    await q(`INSERT INTO fines(category,code,title,price_dkk,points,prison_days,description) VALUES
      ('Færdselsloven','FL-001','Hastighedsovertrædelse',1500,1,0,'Kørsel over hastighedsgrænsen'),
      ('Færdselsloven','FL-002','Kørsel uden sele',1000,0,0,'Manglende sikkerhedssele'),
      ('Straffeloven','SL-001','Ulovlig besiddelse',5000,0,0,'Testtakst til RP-server')`);
  }

  // Import the supplied Danish RP tariff list idempotently; existing/custom rates stay untouched.
  const tariffRows = JSON.parse(fs.readFileSync(path.join(__dirname, "data", "offenses-da.json"), "utf8"));
  await q(`INSERT INTO fines(category,code,title,price_dkk,points,prison_days,prison_months,description)
           SELECT tariff.category,tariff.code,tariff.title,tariff.price_dkk,tariff.points,0,tariff.prison_months,tariff.description
           FROM jsonb_to_recordset($1::jsonb) AS tariff(category text,code text,title text,price_dkk integer,points integer,prison_months integer,description text)
           WHERE NOT EXISTS (SELECT 1 FROM fines f WHERE f.category=tariff.category AND f.code=tariff.code)`,
           [JSON.stringify(tariffRows)]);

  await q(`INSERT INTO settings(key,value) VALUES
    ('language','da'),('site_name','POLITI'),('frakendelse_years','3')
    ON CONFLICT(key) DO NOTHING`);
}

async function requireAuth(req, res, next) {
  if (!req.session.user) return res.status(401).json({ error: "Ikke logget ind" });
  try {
    const result=await q("SELECT active FROM users WHERE id=$1",[req.session.user.id]);
    if(!result.rowCount||!result.rows[0].active){req.session.destroy(()=>{});return res.status(401).json({error:"Brugeren er ikke aktiv"});}
    next();
  } catch(error) { next(error); }
}
async function accessFor(req) {
  if (!req.session.user) return null;
  const result=await q(`SELECT u.role,COALESCE(r.level,0)::int rank_level
                        FROM users u LEFT JOIN ranks r ON r.name=u.rank
                        WHERE u.id=$1 AND u.active=true`,[req.session.user.id]);
  if(!result.rowCount)return null;
  const user=result.rows[0];
  return {...user,full:user.role==="admin"||user.rank_level>=10,staffManager:user.role==="admin"||user.rank_level>=8};
}
function requireRankAtLeast(level) {
  return async (req,res,next)=>{
    try {
      const access=await accessFor(req);
      if(!access)return res.status(401).json({error:"Brugeren er ikke aktiv eller logget ind"});
      req.access=access;
      if(access.role!=="admin"&&access.rank_level<level)return res.status(403).json({error:"Du har ikke den nødvendige rang til denne handling"});
      next();
    } catch(error) { next(error); }
  };
}
function requireAdmin(req,res,next) {
  return requireRankAtLeast(10)(req,res,next);
}

async function logAction(userId, action, title, description = "") {
  await q("INSERT INTO audit_logs(user_id,action,title,description) VALUES($1,$2,$3,$4)",
    [userId, action, title, description]);
}

function requireFeature(key) {
  return (req,res,next) => q("SELECT value FROM settings WHERE key=$1",[key]).then(r=>{
    if(r.rows[0]?.value==="false") return res.status(403).json({error:"Denne funktion er slået fra i systemindstillingerne"});
    next();
  }).catch(next);
}

function requireFiveMKey(req,res,next) {
  const expected=process.env.FIVEM_API_KEY;
  const authorization=req.get("authorization")||"";
  const supplied=authorization.match(/^Bearer\s+(.+)$/i)?.[1]||"";
  if(!expected) return res.status(503).json({error:"FiveM-integrationen er ikke konfigureret på serveren."});
  const a=Buffer.from(supplied),b=Buffer.from(expected);
  if(a.length!==b.length||!crypto.timingSafeEqual(a,b)) return res.status(401).json({error:"Ugyldig integrationsnøgle."});
  next();
}

function callCoordinates(body={}) {
  const coords=body.coords||body.location||{};
  const x=Number(body.x??coords.x),y=Number(body.y??coords.y),z=Number(body.z??coords.z??0);
  if(!Number.isFinite(x)||!Number.isFinite(y)||!Number.isFinite(z)||Math.abs(x)>100000||Math.abs(y)>100000||Math.abs(z)>100000) {
    const error=new Error("Opkaldet skal have gyldige X- og Y-koordinater.");error.status=400;throw error;
  }
  return {x,y,z};
}

function normalizeBirthDate(value) {
  if(value===undefined||value===null||String(value).trim()==="") return null;
  const raw=String(value).trim();
  let match=raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if(!match) {
    const dmy=raw.match(/^(\d{2})[./-](\d{2})[./-](\d{4})$/);
    if(dmy) match=[raw,dmy[3],dmy[2],dmy[1]];
  }
  if(!match) {const error=new Error("Fødselsdato skal være YYYY-MM-DD eller DD-MM-YYYY.");error.status=400;throw error;}
  const iso=`${match[1]}-${match[2]}-${match[3]}`;
  const d=new Date(`${iso}T00:00:00Z`);
  if(Number.isNaN(d.getTime())||d.toISOString().slice(0,10)!==iso) {const error=new Error("Fødselsdatoen er ugyldig.");error.status=400;throw error;}
  return iso;
}

async function insertDispatchCall(body={},userId=null) {
  const caller=String(body.caller_name||body.player_name||"Ukendt").trim().slice(0,160)||"Ukendt";
  const phone=String(body.caller_phone||body.phone||"").trim().slice(0,60)||null;
  const category=String(body.category||"112").trim().slice(0,80)||"112";
  const message=String(body.message||body.description||"").trim();
  if(!message) {const error=new Error("Skriv en besked om opkaldet.");error.status=400;throw error;}
  const {x,y,z}=callCoordinates(body);
  const externalId=String(body.external_id||body.call_id||"").trim().slice(0,160)||null;
  const result=await q(`INSERT INTO dispatch_calls(external_id,caller_name,caller_phone,category,message,coord_x,coord_y,coord_z,created_by)
                        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(external_id) DO NOTHING RETURNING *`,
    [externalId,caller,phone,category,message,x,y,z,userId]);
  if(result.rowCount) return {call:result.rows[0],duplicate:false};
  const existing=await q("SELECT * FROM dispatch_calls WHERE external_id=$1",[externalId]);
  return {call:existing.rows[0],duplicate:true};
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
  const access=await q("SELECT COALESCE(level,0)::int rank_level FROM ranks WHERE name=$1",[u.rank]);
  req.session.user = { id: u.id, username: u.username, full_name: u.full_name, rank: u.rank, badge_number: u.badge_number, role: u.role, rank_level:access.rows[0]?.rank_level||0 };
  await logAction(u.id, "LOGIN", "Login", `Bruger ${u.username} loggede ind`);
  res.json({ user: req.session.user });
});

app.post("/api/logout", requireAuth, async (req,res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get("/api/me", requireAuth, async (req,res) => {
  const result=await q(`SELECT u.id,u.username,u.full_name,u.rank,u.badge_number,u.role,u.active,COALESCE(r.level,0)::int rank_level
                        FROM users u LEFT JOIN ranks r ON r.name=u.rank WHERE u.id=$1 AND u.active=true`,[req.session.user.id]);
  if(!result.rowCount){req.session.destroy(()=>{});return res.status(401).json({error:"Brugeren er ikke aktiv"});}
  const user=result.rows[0];req.session.user={...req.session.user,...user};
  res.json({user:{...user,full:user.role==="admin"||user.rank_level>=10,staff_manager:user.role==="admin"||user.rank_level>=8}});
});

app.get("/api/preferences", requireAuth, async (req,res) => {
  const r=await q("SELECT font_scale,text_color,tablet_color,profile_image FROM user_preferences WHERE user_id=$1",[req.session.user.id]);
  res.json(r.rows[0]||{font_scale:100,text_color:"#eef0f5",tablet_color:"#181b22",profile_image:null});
});

app.post("/api/profile-image", requireAuth, async (req,res) => {
  const image=String(req.body.image||"");
  const match=image.match(/^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/);
  if(!match)return res.status(400).json({error:"Vælg et PNG-, JPG- eller WEBP-billede."});
  const bytes=Buffer.from(match[2],"base64");
  if(bytes.length>512*1024)return res.status(413).json({error:"Profilbilledet må højst være 512 KB."});
  if(!bytes.length||bytes.toString("base64")!==match[2])return res.status(400).json({error:"Billedfilen kunne ikke læses."});
  await q(`INSERT INTO user_preferences(user_id,profile_image,updated_at) VALUES($1,$2,NOW())
           ON CONFLICT(user_id) DO UPDATE SET profile_image=EXCLUDED.profile_image,updated_at=NOW()`,[req.session.user.id,image]);
  res.json({ok:true,profile_image:image});
});
app.delete("/api/profile-image", requireAuth, async (req,res) => {
  await q(`INSERT INTO user_preferences(user_id,profile_image,updated_at) VALUES($1,NULL,NOW())
           ON CONFLICT(user_id) DO UPDATE SET profile_image=NULL,updated_at=NOW()`,[req.session.user.id]);
  res.json({ok:true});
});

app.post("/api/preferences", requireAuth, async (req,res) => {
  const fontScale=Number(req.body.font_scale);
  const textColor=String(req.body.text_color||"");
  const tabletColor=String(req.body.tablet_color||"");
  if(!Number.isInteger(fontScale)||fontScale<80||fontScale>150) return res.status(400).json({error:"Tekststørrelsen skal være mellem 80 og 150 %."});
  if(!/^#[0-9a-f]{6}$/i.test(textColor)||!/^#[0-9a-f]{6}$/i.test(tabletColor)) return res.status(400).json({error:"Vælg gyldige farver."});
  const r=await q(`INSERT INTO user_preferences(user_id,font_scale,text_color,tablet_color,updated_at)
                   VALUES($1,$2,$3,$4,NOW())
                   ON CONFLICT(user_id) DO UPDATE SET font_scale=EXCLUDED.font_scale,text_color=EXCLUDED.text_color,tablet_color=EXCLUDED.tablet_color,updated_at=NOW()
                   RETURNING font_scale,text_color,tablet_color`,[req.session.user.id,fontScale,textColor.toLowerCase(),tabletColor.toLowerCase()]);
  res.json(r.rows[0]);
});

app.get("/api/public-settings", async (_req,res) => {
  const r=await q("SELECT key,value FROM settings WHERE key = ANY($1)",[["site_name","applications_enabled","warrants_enabled","board_enabled","custom_fines_enabled"]]);
  res.json(Object.fromEntries(r.rows.map(x=>[x.key,x.value])));
});

app.get("/api/dashboard", requireAuth, async (_req,res) => {
  const [persons, vehicles, cases, warrants, employees, apps, fleet, activeCalls] = await Promise.all([
    q("SELECT COUNT(*)::int c FROM persons"),
    q("SELECT COUNT(*)::int c FROM vehicles"),
    q("SELECT COUNT(*)::int c FROM cases"),
    q("SELECT COUNT(*)::int c FROM warrants WHERE active=true"),
    q("SELECT COUNT(*)::int c FROM users WHERE active=true"),
    q("SELECT COUNT(*)::int c FROM applications WHERE status='Afventer'"),
    q("SELECT COUNT(*)::int c FROM fleet_vehicles WHERE status='Ledig'"),
    q("SELECT COUNT(*)::int c FROM dispatch_calls WHERE status<>'closed'")
  ]);
  const [recentCases, pendingApps, recentPosts] = await Promise.all([
    q(`SELECT c.id,c.case_number,c.title,c.fine_dkk,c.prison_days,c.created_at,p.name person_name,u.full_name officer_name
       FROM cases c LEFT JOIN persons p ON p.id=c.person_id LEFT JOIN users u ON u.id=c.officer_id ORDER BY c.created_at DESC LIMIT 5`),
    q("SELECT id,applicant_name,type,status,created_at FROM applications WHERE status='Afventer' ORDER BY created_at DESC LIMIT 5"),
    q("SELECT id,title,body,pinned,created_at FROM board_posts ORDER BY pinned DESC,created_at DESC LIMIT 3")
  ]);
  res.json({
    persons: persons.rows[0].c, vehicles: vehicles.rows[0].c, cases: cases.rows[0].c,
    warrants: warrants.rows[0].c, employees: employees.rows[0].c, applications: apps.rows[0].c,
    fleetAvailable: fleet.rows[0].c, activeCalls: activeCalls.rows[0].c,
    recentCases: recentCases.rows, pendingApplications: pendingApps.rows, announcements: recentPosts.rows
  });
});

app.get("/api/cases", requireAuth, async (_req,res) => {
  const r=await q(`SELECT c.*,p.name person_name,u.full_name officer_name FROM cases c
                   LEFT JOIN persons p ON p.id=c.person_id LEFT JOIN users u ON u.id=c.officer_id
                   ORDER BY c.created_at DESC LIMIT 250`);
  res.json(r.rows);
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

app.patch("/api/persons/:id", requireAuth, async (req,res) => {
  const {name,address,phone,birth_date,gender,notes}=req.body;
  const r=await q(`UPDATE persons SET name=$1,address=$2,phone=$3,birth_date=$4,gender=$5,notes=$6 WHERE id=$7 RETURNING *`,
    [name,address||null,phone||null,birth_date||null,gender||null,notes||null,req.params.id]);
  if(!r.rowCount) return res.status(404).json({error:"Person ikke fundet"});
  await logAction(req.session.user.id,"UPDATE","Opdater person",`Person ${name}`); res.json(r.rows[0]);
});

app.get("/api/persons/:id", requireAuth, async (req,res) => {
  const p = await q("SELECT * FROM persons WHERE id=$1",[req.params.id]);
  if (!p.rowCount) return res.status(404).json({error:"Person ikke fundet"});
  const [cases, vehicles, warrants, seizedItems] = await Promise.all([
    q(`SELECT c.*, u.full_name officer_name FROM cases c LEFT JOIN users u ON u.id=c.officer_id WHERE person_id=$1 ORDER BY c.created_at DESC`,[req.params.id]),
    q("SELECT * FROM vehicles WHERE owner_id=$1 ORDER BY plate",[req.params.id]),
    q("SELECT * FROM warrants WHERE person_id=$1 ORDER BY created_at DESC",[req.params.id]),
    q(`SELECT s.*,c.case_number,u.full_name officer_name FROM seized_items s
       LEFT JOIN cases c ON c.id=s.case_id LEFT JOIN users u ON u.id=s.officer_id
       WHERE s.person_id=$1 ORDER BY s.created_at DESC`,[req.params.id])
  ]);
  res.json({person:p.rows[0],cases:cases.rows,vehicles:vehicles.rows,warrants:warrants.rows,seizedItems:seizedItems.rows});
});

app.post("/api/persons/:id/evidence", requireRankAtLeast(2), async (req,res) => {
  const itemName=String(req.body.item_name||"").trim(),description=String(req.body.description||"").trim();
  const caseId=req.body.case_id?Number(req.body.case_id):null;
  if(!itemName||itemName.length>180)return res.status(400).json({error:"Angiv genstanden, der beslaglægges"});
  if(caseId!==null&&(!Number.isInteger(caseId)||caseId<1))return res.status(400).json({error:"Ugyldigt sagsnummer"});
  if(caseId!==null){const linked=await q("SELECT 1 FROM cases WHERE id=$1 AND person_id=$2",[caseId,req.params.id]);if(!linked.rowCount)return res.status(400).json({error:"Sagen tilhører ikke denne person"});}
  const r=await q(`INSERT INTO seized_items(person_id,case_id,item_name,description,officer_id)
                   VALUES($1,$2,$3,$4,$5) RETURNING *`,[req.params.id,caseId,itemName,description||null,req.session.user.id]);
  await logAction(req.session.user.id,"CREATE","Beslaglæg bevis",`${itemName} · person #${req.params.id}`);
  res.status(201).json(r.rows[0]);
});

app.delete("/api/persons/:id/cases/:caseId", requireAuth, async (req,res) => {
  const personId=Number(req.params.id),caseId=Number(req.params.caseId);
  if(!Number.isInteger(personId)||personId<1||!Number.isInteger(caseId)||caseId<1)
    return res.status(400).json({error:"Ugyldigt person- eller sagsnummer"});
  const existing=await q("SELECT id,case_number,title,officer_id FROM cases WHERE id=$1 AND person_id=$2",[caseId,personId]);
  if(!existing.rowCount)return res.status(404).json({error:"Sagen blev ikke fundet på personen"});
  const record=existing.rows[0];
  const access=await accessFor(req);
  if(!access)return res.status(401).json({error:"Brugeren er ikke aktiv"});
  if(!access.full&&access.rank_level<2)return res.status(403).json({error:"Elevrangen kan ikke slette sager"});
  await q("DELETE FROM cases WHERE id=$1 AND person_id=$2",[caseId,personId]);
  await logAction(req.session.user.id,"DELETE","Slet sag",`${record.case_number} · ${record.title}`);
  res.json({ok:true,case_number:record.case_number});
});

app.delete("/api/cases/:id", requireAuth, async (req,res) => {
  const access=await accessFor(req);
  if(!access)return res.status(401).json({error:"Brugeren er ikke aktiv"});
  if(!access.full&&access.rank_level<2)return res.status(403).json({error:"Elevrangen kan ikke slette sager"});
  const result=await q("DELETE FROM cases WHERE id=$1 RETURNING id,case_number,title",[req.params.id]);
  if(!result.rowCount)return res.status(404).json({error:"Sagen blev ikke fundet"});
  await logAction(req.session.user.id,"DELETE","Slet sag",`${result.rows[0].case_number} · ${result.rows[0].title}`);
  res.json({ok:true,case_number:result.rows[0].case_number});
});

app.post("/api/persons/:id/cases", requireAuth, async (req,res) => {
  const {title,description,fine_dkk=0,prison_days=0,license_points=0}=req.body;
  if(req.body.penalties!==undefined&&!Array.isArray(req.body.penalties))
    return res.status(400).json({error:"Listen over bøder og straffe har et ugyldigt format"});
  let penalties=[];
  if(Array.isArray(req.body.penalties)&&req.body.penalties.length){
    const requested=new Map();
    for(const row of req.body.penalties){
      const id=Number(row.fine_id),quantity=Number(row.quantity);
      if(!Number.isInteger(id)||id<1||!Number.isInteger(quantity)||quantity<1||quantity>999)
        return res.status(400).json({error:"En bødetakst eller mængde er ugyldig"});
      requested.set(id,(requested.get(id)||0)+quantity);
      if(requested.get(id)>999)return res.status(400).json({error:"Der kan højst tilføjes 999 af samme takst"});
    }
    const ids=[...requested.keys()];
    const rates=await q("SELECT id,category,code,title,price_dkk,points,prison_days,prison_months FROM fines WHERE id=ANY($1::int[])",[ids]);
    if(rates.rowCount!==ids.length)return res.status(400).json({error:"En eller flere valgte bødetakster findes ikke længere"});
    const byId=new Map(rates.rows.map(rate=>[rate.id,rate]));
    penalties=ids.map(id=>{const rate=byId.get(id),quantity=requested.get(id);return {fine_id:id,code:rate.code,category:rate.category,title:rate.title,quantity,price_dkk:Number(rate.price_dkk)||0,points:Number(rate.points)||0,prison_days:Number(rate.prison_days)||0,prison_months:Number(rate.prison_months)||0,line_total_dkk:(Number(rate.price_dkk)||0)*quantity,line_total_points:(Number(rate.points)||0)*quantity,line_total_prison_days:(Number(rate.prison_days)||0)*quantity,line_total_prison_months:(Number(rate.prison_months)||0)*quantity}});
  }
  const totals=penalties.length?{
    fine_dkk:penalties.reduce((sum,p)=>sum+p.line_total_dkk,0),
    license_points:penalties.reduce((sum,p)=>sum+p.line_total_points,0),
    prison_days:penalties.reduce((sum,p)=>sum+p.line_total_prison_days,0),
    prison_months:penalties.reduce((sum,p)=>sum+p.line_total_prison_months,0)
  }:{fine_dkk:Number(fine_dkk)||0,license_points:Number(license_points)||0,prison_days:Number(prison_days)||0,prison_months:Number(req.body.prison_months)||0};
  const caseNumber = `SAG-${new Date().getFullYear()}-${Date.now().toString().slice(-6)}`;
  const r = await q(`INSERT INTO cases(case_number,person_id,officer_id,title,description,fine_dkk,prison_days,prison_months,license_points,penalties)
                     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb) RETURNING *`,
                     [caseNumber,req.params.id,req.session.user.id,title,description||"",totals.fine_dkk,totals.prison_days,totals.prison_months,totals.license_points,JSON.stringify(penalties)]);
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
  const access=await accessFor(req);
  if(!access)return res.status(401).json({error:"Brugeren er ikke aktiv"});
  if(status==="Beslaglagt"&&!access.full&&access.rank_level<2)return res.status(403).json({error:"Elevrangen kan ikke beslaglægge køretøjer"});
  const r=await q(`INSERT INTO vehicles(plate,owner_id,make,model,category,color,status,notes)
                   VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
                   [plate,owner_id||null,make||null,model||null,category||null,color||null,status,notes||null]);
  await logAction(req.session.user.id,"CREATE","Opret køretøj",plate);
  res.status(201).json(r.rows[0]);
});

app.patch("/api/vehicles/:id", requireAuth, async (req,res) => {
  const {plate,owner_id,make,model,category,color,status="Normal",notes}=req.body;
  const access=await accessFor(req);
  if(!access)return res.status(401).json({error:"Brugeren er ikke aktiv"});
  if(!access.full&&access.rank_level<2){
    const current=await q("SELECT status FROM vehicles WHERE id=$1",[req.params.id]);
    if((status==="Beslaglagt"&&current.rows[0]?.status!=="Beslaglagt")||(current.rows[0]?.status==="Beslaglagt"&&status!=="Beslaglagt"))return res.status(403).json({error:"Elevrangen kan ikke beslaglægge eller frigive køretøjer"});
  }
  const r=await q(`UPDATE vehicles SET plate=$1,owner_id=$2,make=$3,model=$4,category=$5,color=$6,status=$7,notes=$8 WHERE id=$9 RETURNING *`,
    [plate,owner_id||null,make||null,model||null,category||null,color||null,status,notes||null,req.params.id]);
  if(!r.rowCount) return res.status(404).json({error:"Køretøj ikke fundet"});
  await logAction(req.session.user.id,"UPDATE","Opdater køretøj",plate); res.json(r.rows[0]);
});

const fleetStatuses=["Ledig","På vagt","På patrulje","På værksted"];
app.get("/api/fleet", requireAuth, async (req,res) => {
  const term=`%${req.query.search||""}%`;
  const r=await q(`SELECT f.*,u.full_name assigned_name,u.badge_number assigned_badge
                   FROM fleet_vehicles f LEFT JOIN users u ON u.id=f.assigned_to
                   WHERE f.call_sign ILIKE $1 OR f.plate ILIKE $1 OR f.model ILIKE $1 OR COALESCE(u.full_name,'') ILIKE $1
                   ORDER BY CASE f.status WHEN 'På patrulje' THEN 1 WHEN 'På vagt' THEN 2 WHEN 'Ledig' THEN 3 ELSE 4 END,f.call_sign`,[term]);
  res.json(r.rows);
});
app.post("/api/fleet", requireAdmin, async (req,res) => {
  const {call_sign,plate,model,status="Ledig",assigned_to,notes}=req.body||{};
  if(!call_sign||!plate||!model) return res.status(400).json({error:"Kaldesignal, nummerplade og model skal udfyldes."});
  if(!fleetStatuses.includes(status)) return res.status(400).json({error:"Ugyldig flådestatus."});
  const r=await q(`INSERT INTO fleet_vehicles(call_sign,plate,model,status,assigned_to,notes)
                   VALUES($1,$2,$3,$4,$5,$6) RETURNING *`,[String(call_sign).trim(),String(plate).trim().toUpperCase(),String(model).trim(),status,assigned_to||null,notes||null]);
  await logAction(req.session.user.id,"CREATE","Tilføj flådekøretøj",String(call_sign));res.status(201).json(r.rows[0]);
});
app.patch("/api/fleet/:id", requireAdmin, async (req,res) => {
  const {call_sign,plate,model,status="Ledig",assigned_to,notes}=req.body||{};
  if(!call_sign||!plate||!model) return res.status(400).json({error:"Kaldesignal, nummerplade og model skal udfyldes."});
  if(!fleetStatuses.includes(status)) return res.status(400).json({error:"Ugyldig flådestatus."});
  const r=await q(`UPDATE fleet_vehicles SET call_sign=$1,plate=$2,model=$3,status=$4,assigned_to=$5,notes=$6,updated_at=NOW()
                   WHERE id=$7 RETURNING *`,[String(call_sign).trim(),String(plate).trim().toUpperCase(),String(model).trim(),status,assigned_to||null,notes||null,req.params.id]);
  if(!r.rowCount)return res.status(404).json({error:"Flådekøretøj ikke fundet."});
  await logAction(req.session.user.id,"UPDATE","Opdater flådekøretøj",String(call_sign));res.json(r.rows[0]);
});
app.patch("/api/fleet/:id/status", requireAuth, async (req,res) => {
  const {status}=req.body||{};
  if(!fleetStatuses.includes(status))return res.status(400).json({error:"Ugyldig flådestatus."});
  const assignedTo=status==="Ledig"||status==="På værksted"?null:req.session.user.id;
  const r=await q(`UPDATE fleet_vehicles SET status=$1,assigned_to=$2,updated_at=NOW()
                   WHERE id=$3 AND (assigned_to IS NULL OR assigned_to=$4 OR $5='admin') RETURNING *`,[status,assignedTo,req.params.id,req.session.user.id,req.session.user.role]);
  if(!r.rowCount)return res.status(409).json({error:"Køretøjet er allerede tildelt en anden medarbejder."});
  await logAction(req.session.user.id,"UPDATE","Flådestatus",`${r.rows[0].call_sign}: ${status}`);res.json(r.rows[0]);
});
app.patch("/api/fleet/:id/location", requireAuth, async (req,res) => {
  const {x,y}=callCoordinates(req.body||{});
  const r=await q(`UPDATE fleet_vehicles SET location_x=$1,location_y=$2,updated_at=NOW() WHERE id=$3
                   AND (assigned_to IS NULL OR assigned_to=$4 OR $5='admin') RETURNING *`,[x,y,req.params.id,req.session.user.id,req.session.user.role]);
  if(!r.rowCount)return res.status(409).json({error:"Køretøjet er ukendt eller tildelt en anden medarbejder."});
  res.json(r.rows[0]);
});
app.delete("/api/fleet/:id", requireAdmin, async (req,res) => {
  const r=await q("DELETE FROM fleet_vehicles WHERE id=$1 RETURNING call_sign",[req.params.id]);
  if(!r.rowCount)return res.status(404).json({error:"Flådekøretøj ikke fundet."});
  await logAction(req.session.user.id,"DELETE","Slet flådekøretøj",r.rows[0].call_sign);res.json({ok:true});
});

app.get("/api/calls", requireAuth, async (req,res) => {
  const status=req.query.status||"open";
  const r=await q(`SELECT c.*,u.full_name claimed_name,u.rank claimed_rank
                   FROM dispatch_calls c LEFT JOIN users u ON u.id=c.claimed_by
                   WHERE ($1='all' OR ($1='open' AND c.status<>'closed') OR ($1='closed' AND c.status='closed'))
                   ORDER BY CASE c.status WHEN 'pending' THEN 1 WHEN 'accepted' THEN 2 ELSE 3 END,c.created_at DESC LIMIT 500`,[status]);
  res.json(r.rows);
});
app.post("/api/calls", requireAuth, async (req,res) => {
  const result=await insertDispatchCall(req.body||{},req.session.user.id);
  if(!result.duplicate)await logAction(req.session.user.id,"CREATE","Nyt opkald",result.call.category);
  res.status(result.duplicate?200:201).json(result);
});
app.patch("/api/calls/:id", requireAuth, async (req,res) => {
  const {action}=req.body||{};let r;const access=await accessFor(req);if(!access)return res.status(401).json({error:"Brugeren er ikke aktiv"});
  if(action==="accept") {
    r=await q(`UPDATE dispatch_calls SET status='accepted',claimed_by=$1,accepted_at=COALESCE(accepted_at,NOW())
               WHERE id=$2 AND (status='pending' OR (status='accepted' AND claimed_by=$1)) RETURNING *`,[req.session.user.id,req.params.id]);
  } else if(action==="release") {
    r=await q(`UPDATE dispatch_calls SET status='pending',claimed_by=NULL,accepted_at=NULL WHERE id=$1 AND status='accepted'
               AND (claimed_by=$2 OR $3::boolean) RETURNING *`,[req.params.id,req.session.user.id,access.full]);
  } else if(action==="close") {
    r=await q(`UPDATE dispatch_calls SET status='closed',closed_at=NOW() WHERE id=$1 AND status<>'closed'
               AND (claimed_by IS NULL OR claimed_by=$2 OR $3::boolean) RETURNING *`,[req.params.id,req.session.user.id,access.full]);
  } else return res.status(400).json({error:"Vælg om opkaldet skal overtages, frigives eller afsluttes."});
  if(!r.rowCount)return res.status(409).json({error:"Opkaldet er allerede afsluttet eller håndteres af en anden medarbejder."});
  const title=action==="accept"?"Overtag opkald":action==="release"?"Frigiv opkald":"Afslut opkald";
  await logAction(req.session.user.id,"UPDATE",title,`Opkald #${r.rows[0].id}`);res.json(r.rows[0]);
});

app.post("/api/integrations/calls", requireFiveMKey, async (req,res) => {
  const result=await insertDispatchCall(req.body||{});
  if(!result.duplicate)await logAction(null,"CREATE","FiveM-opkald",`${result.call.category}: ${result.call.message.slice(0,120)}`);
  res.status(result.duplicate?200:201).json(result);
});
app.get("/api/integrations/fleet", requireFiveMKey, async (_req,res) => {
  const r=await q(`SELECT f.call_sign,f.plate,f.model,f.status,f.location_x,f.location_y,u.full_name assigned_name
                   FROM fleet_vehicles f LEFT JOIN users u ON u.id=f.assigned_to ORDER BY f.call_sign`);
  res.json(r.rows);
});
app.patch("/api/integrations/fleet/:callSign/location", requireFiveMKey, async (req,res) => {
  const {x,y}=callCoordinates(req.body||{});
  const r=await q("UPDATE fleet_vehicles SET location_x=$1,location_y=$2,updated_at=NOW() WHERE call_sign=$3 RETURNING call_sign,location_x,location_y,updated_at",[x,y,req.params.callSign]);
  if(!r.rowCount)return res.status(404).json({error:"Kaldesignal ikke fundet."});
  res.json(r.rows[0]);
});
app.get("/api/integrations/calls/active", requireFiveMKey, async (_req,res) => {
  const r=await q(`SELECT id,external_id,caller_name,caller_phone,category,message,coord_x,coord_y,coord_z,status,created_at
                   FROM dispatch_calls WHERE status<>'closed' ORDER BY created_at ASC LIMIT 100`);
  res.json(r.rows);
});

app.post("/api/integrations/persons", requireFiveMKey, async (req,res) => {
  const body=req.body||{};
  const externalId=String(body.external_id||body.citizenid||body.identifier||"").trim().slice(0,200);
  const name=String(body.name||body.character_name||`${body.firstname||""} ${body.lastname||""}`).trim().replace(/\s+/g," ").slice(0,160);
  if(!externalId||!name) return res.status(400).json({error:"Karakterens stabile ID og fulde navn skal medsendes."});
  const birthDate=normalizeBirthDate(body.birth_date??body.dateofbirth??body.birthdate);
  const address=String(body.address||"").trim().slice(0,1000)||null;
  const phone=String(body.phone||body.phone_number||body.phoneNumber||"").trim().slice(0,60)||null;
  const gender=String(body.gender||body.sex||"").trim().slice(0,30)||null;
  const source=String(body.source||"FiveM").trim().slice(0,40)||"FiveM";
  const r=await q(`INSERT INTO persons(external_id,source,name,address,phone,birth_date,gender,last_seen_at)
                   VALUES($1,$2,$3,$4,$5,$6,$7,NOW())
                   ON CONFLICT(external_id) WHERE external_id IS NOT NULL DO UPDATE SET
                     source=EXCLUDED.source,name=EXCLUDED.name,
                     address=COALESCE(EXCLUDED.address,persons.address),
                     phone=COALESCE(EXCLUDED.phone,persons.phone),
                     birth_date=COALESCE(EXCLUDED.birth_date,persons.birth_date),
                     gender=COALESCE(EXCLUDED.gender,persons.gender),last_seen_at=NOW()
                   RETURNING id,external_id,source,name,address,phone,birth_date,gender,last_seen_at,(xmax=0) AS created`,
    [externalId,source,name,address,phone,birthDate,gender]);
  const {created,...person}=r.rows[0];
  res.status(created?201:200).json({person,created});
});

app.get("/api/warrants", requireAuth, requireFeature("warrants_enabled"), async (_req,res) => {
  const r=await q(`SELECT w.*, p.name person_name, v.plate FROM warrants w
                   LEFT JOIN persons p ON p.id=w.person_id
                   LEFT JOIN vehicles v ON v.id=w.vehicle_id
                   ORDER BY w.active DESC,w.created_at DESC`);
  res.json(r.rows);
});

app.post("/api/warrants", requireAuth, requireFeature("warrants_enabled"), async (req,res) => {
  const {person_id,vehicle_id,type="Person",title,description}=req.body;
  const r=await q(`INSERT INTO warrants(person_id,vehicle_id,type,title,description,created_by)
                   VALUES($1,$2,$3,$4,$5,$6) RETURNING *`,
                   [person_id||null,vehicle_id||null,type,title,description||"",req.session.user.id]);
  await logAction(req.session.user.id,"CREATE","Opret efterlysning",title);
  res.status(201).json(r.rows[0]);
});

app.patch("/api/warrants/:id", requireAuth, requireFeature("warrants_enabled"), async (req,res) => {
  const r=await q("UPDATE warrants SET active=$1 WHERE id=$2 RETURNING *",[!!req.body.active,req.params.id]);
  if(!r.rowCount) return res.status(404).json({error:"Efterlysning ikke fundet"});
  await logAction(req.session.user.id,"UPDATE",r.rows[0].active?"Genåbn efterlysning":"Luk efterlysning",String(req.params.id));
  res.json(r.rows[0]);
});

app.get("/api/fines", requireAuth, async (req,res) => {
  const term=`%${req.query.search||""}%`;
  const r=await q(`SELECT * FROM fines WHERE title ILIKE $1 OR category ILIKE $1 OR COALESCE(code,'') ILIKE $1 OR COALESCE(description,'') ILIKE $1
    ORDER BY CASE category WHEN 'Færdselsloven' THEN 1 WHEN 'Straffeloven' THEN 2 WHEN 'Bek. euf. stoffer' THEN 3 WHEN 'Våben og Knivlov' THEN 4 WHEN 'Ordensbekendtgørelsen' THEN 5 WHEN 'Kommune straf' THEN 6 ELSE 99 END,category,
    CASE WHEN code ~ '^§[0-9]+:[0-9]+$' THEN split_part(split_part(code,'§',2),':',1)::int END NULLS LAST,
    CASE WHEN code ~ '^§[0-9]+:[0-9]+$' THEN split_part(code,':',2)::int END NULLS LAST,title`,[term]);
  res.json(r.rows);
});

app.post("/api/fines", requireAdmin, async (req,res) => {
  const enabled=await q("SELECT value FROM settings WHERE key='custom_fines_enabled'");
  if(enabled.rows[0]?.value==="false") return res.status(403).json({error:"Egne bødetakster er slået fra i indstillingerne"});
  const {category,code,title,price_dkk=0,points=0,prison_days=0,prison_months=0,description=""}=req.body;
  const r=await q("INSERT INTO fines(category,code,title,price_dkk,points,prison_days,prison_months,description) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *",
    [category,code||null,title,Number(price_dkk),Number(points),Number(prison_days),Number(prison_months),description]);
  await logAction(req.session.user.id,"CREATE","Opret bødetakst",title); res.status(201).json(r.rows[0]);
});
app.patch("/api/fines/:id", requireAdmin, async (req,res) => {
  const enabled=await q("SELECT value FROM settings WHERE key='custom_fines_enabled'");
  if(enabled.rows[0]?.value==="false") return res.status(403).json({error:"Egne bødetakster er slået fra i indstillingerne"});
  const {category,code,title,price_dkk=0,points=0,prison_days=0,prison_months=0,description=""}=req.body;
  const r=await q("UPDATE fines SET category=$1,code=$2,title=$3,price_dkk=$4,points=$5,prison_days=$6,prison_months=$7,description=$8 WHERE id=$9 RETURNING *",
    [category,code||null,title,Number(price_dkk),Number(points),Number(prison_days),Number(prison_months),description,req.params.id]);
  if(!r.rowCount) return res.status(404).json({error:"Bødetakst ikke fundet"});
  await logAction(req.session.user.id,"UPDATE","Opdater bødetakst",title); res.json(r.rows[0]);
});
app.delete("/api/fines/:id", requireAdmin, async (req,res) => {
  const enabled=await q("SELECT value FROM settings WHERE key='custom_fines_enabled'");
  if(enabled.rows[0]?.value==="false") return res.status(403).json({error:"Egne bødetakster er slået fra i indstillingerne"});
  const r=await q("DELETE FROM fines WHERE id=$1 RETURNING title",[req.params.id]);
  if(!r.rowCount) return res.status(404).json({error:"Bødetakst ikke fundet"});
  await logAction(req.session.user.id,"DELETE","Slet bødetakst",r.rows[0].title); res.json({ok:true});
});

app.get("/api/board", requireAuth, requireFeature("board_enabled"), async (_req,res) => {
  const r=await q(`SELECT b.*,u.full_name author_name,u.rank FROM board_posts b LEFT JOIN users u ON u.id=b.author_id ORDER BY b.pinned DESC,b.created_at DESC`);
  res.json(r.rows);
});

app.post("/api/board", requireAuth, requireFeature("board_enabled"), async (req,res) => {
  const r=await q(`INSERT INTO board_posts(title,body,author_id,pinned) VALUES($1,$2,$3,$4) RETURNING *`,
    [req.body.title,req.body.body,req.session.user.id,!!req.body.pinned]);
  await logAction(req.session.user.id,"CREATE","Nyt opslag",req.body.title);
  res.status(201).json(r.rows[0]);
});

app.patch("/api/board/:id", requireAuth, requireFeature("board_enabled"), async (req,res) => {
  const existing=await q("SELECT author_id FROM board_posts WHERE id=$1",[req.params.id]);
  if(!existing.rowCount) return res.status(404).json({error:"Opslag ikke fundet"});
  const access=await accessFor(req);
  if(!access?.full && existing.rows[0].author_id!==req.session.user.id) return res.status(403).json({error:"Du kan kun redigere dine egne opslag"});
  const {title,body,pinned=false}=req.body;
  const r=await q("UPDATE board_posts SET title=$1,body=$2,pinned=$3 WHERE id=$4 RETURNING *",[title,body,!!pinned,req.params.id]);
  if(!r.rowCount) return res.status(404).json({error:"Opslag ikke fundet"});
  await logAction(req.session.user.id,"UPDATE","Opdater opslag",title); res.json(r.rows[0]);
});
app.delete("/api/board/:id", requireAuth, requireFeature("board_enabled"), async (req,res) => {
  const existing=await q("SELECT author_id FROM board_posts WHERE id=$1",[req.params.id]);
  if(!existing.rowCount) return res.status(404).json({error:"Opslag ikke fundet"});
  const access=await accessFor(req);
  if(!access?.full && existing.rows[0].author_id!==req.session.user.id) return res.status(403).json({error:"Du kan kun slette dine egne opslag"});
  const r=await q("DELETE FROM board_posts WHERE id=$1 RETURNING title",[req.params.id]);
  if(!r.rowCount) return res.status(404).json({error:"Opslag ikke fundet"});
  await logAction(req.session.user.id,"DELETE","Slet opslag",r.rows[0].title); res.json({ok:true});
});

app.get("/api/ranks", requireAuth, async (_req,res) => {
  const r=await q(`SELECT r.id,r.name,r.level,r.created_at,COUNT(u.id)::int employee_count
                   FROM ranks r LEFT JOIN users u ON u.rank=r.name
                   GROUP BY r.id ORDER BY r.level DESC,r.name ASC`);
  res.json(r.rows);
});

app.post("/api/ranks", requireAdmin, async (req,res) => {
  res.status(403).json({error:"Der skal altid være præcis 11 rangtrin. Rediger navnet på et eksisterende trin."});
});

app.patch("/api/ranks/:id", requireAdmin, async (req,res) => {
  const id=Number(req.params.id),name=String(req.body.name||"").trim();
  if(!Number.isInteger(id)||id<1||!name||name.length>120)return res.status(400).json({error:"Indtast et gyldigt rangnavn"});
  const duplicate=await q("SELECT 1 FROM ranks WHERE LOWER(name)=LOWER($1) AND id<>$2",[name,id]);
  if(duplicate.rowCount)return res.status(409).json({error:"Rangen findes allerede"});
  const r=await q(`WITH old_rank AS MATERIALIZED (SELECT name FROM ranks WHERE id=$2),
      updated_rank AS (UPDATE ranks SET name=$1 WHERE id=$2 RETURNING id,name,level,created_at),
      updated_staff AS (UPDATE users SET rank=(SELECT name FROM updated_rank) WHERE rank=(SELECT name FROM old_rank))
      SELECT * FROM updated_rank`,[name,id]);
  if(!r.rowCount)return res.status(404).json({error:"Rangen blev ikke fundet"});
  await logAction(req.session.user.id,"UPDATE","Opdater rang",name);
  const count=await q("SELECT COUNT(*)::int employee_count FROM users WHERE rank=$1",[name]);
  res.json({...r.rows[0],employee_count:count.rows[0].employee_count});
});

app.delete("/api/ranks/:id", requireAdmin, async (req,res) => {
  res.status(403).json({error:"Der skal altid være præcis 11 rangtrin. Et rangtrin kan ikke slettes."});
});

app.get("/api/employees", requireAuth, async (_req,res) => {
  const r=await q("SELECT u.id,u.username,u.full_name,u.rank,COALESCE(r.level,0)::int rank_level,u.badge_number,u.role,u.active,u.employment_status,u.created_at FROM users u LEFT JOIN ranks r ON r.name=u.rank ORDER BY u.active DESC,r.level DESC,u.full_name");
  res.json(r.rows);
});

app.post("/api/employees", requireRankAtLeast(8), async (req,res) => {
  const {username,password,full_name,rank="Politi-Elev",badge_number,role="officer"}=req.body;
  if(!password || password.length<8) return res.status(400).json({error:"Adgangskoden skal være mindst 8 tegn"});
  const rankName=String(rank||"").trim();
  const targetRank=await q("SELECT level FROM ranks WHERE name=$1",[rankName]);
  if(!targetRank.rowCount)return res.status(400).json({error:"Vælg en rang, der findes i rangadministrationen"});
  if(!req.access.full&&targetRank.rows[0].level>=req.access.rank_level)return res.status(403).json({error:"Du kan kun ansætte medarbejdere under dit eget rangniveau"});
  if(role==="admin"&&!req.access.full)return res.status(403).json({error:"Kun Admin og Rang 10 kan tildele Admin-adgang"});
  const hash=await bcrypt.hash(password,12);
  const r=await q(`INSERT INTO users(username,password_hash,full_name,rank,badge_number,role) VALUES($1,$2,$3,$4,$5,$6)
    RETURNING id,username,full_name,rank,badge_number,role,active,created_at`,[username,hash,full_name,rankName,badge_number||null,role]);
  await logAction(req.session.user.id,"CREATE","Opret ansat",full_name); res.status(201).json(r.rows[0]);
});
app.patch("/api/employees/:id", requireRankAtLeast(8), async (req,res) => {
  const existing=await q("SELECT id,role,rank,active,employment_status FROM users WHERE id=$1",[req.params.id]);
  if(!existing.rowCount)return res.status(404).json({error:"Ansat ikke fundet"});
  const {full_name,rank,badge_number}=req.body;
  const allowedStatuses=["Aktiv","Inaktiv","Syg","Ferie","Suspenderet"];
  const employmentStatus=req.body.employment_status===undefined?existing.rows[0].employment_status:String(req.body.employment_status);
  if(!allowedStatuses.includes(employmentStatus))return res.status(400).json({error:"Vælg en gyldig medarbejderstatus"});
  const accountActive=!['Inaktiv','Suspenderet'].includes(employmentStatus);
  const role=req.access.full?(req.body.role||existing.rows[0].role):existing.rows[0].role;
  if(String(req.params.id)===String(req.session.user.id) && (role!=="admin"||["Inaktiv","Suspenderet"].includes(employmentStatus))) return res.status(400).json({error:"Du kan ikke fjerne eller suspendere din egen administratorkonto"});
  const targetExistingRank=await q("SELECT level FROM ranks WHERE name=$1",[existing.rows[0].rank]);
  if(!req.access.full&&(existing.rows[0].role==="admin"||Number(targetExistingRank.rows[0]?.level)>=req.access.rank_level))return res.status(403).json({error:"Du kan kun administrere medarbejdere under dit eget rangniveau"});
  const rankName=String(rank||existing.rows[0].rank).trim();
  const targetRank=await q("SELECT level FROM ranks WHERE name=$1",[rankName]);
  if(!targetRank.rowCount)return res.status(400).json({error:"Vælg en rang, der findes i rangadministrationen"});
  if(!req.access.full&&targetRank.rows[0].level>=req.access.rank_level)return res.status(403).json({error:"Du kan kun tildele rang under dit eget niveau"});
  const r=await q(`UPDATE users SET full_name=COALESCE($1,full_name),rank=$2,badge_number=$3,role=$4,employment_status=$5,active=$6 WHERE id=$7
    RETURNING id,username,full_name,rank,badge_number,role,active,employment_status,created_at`,
    [full_name||null,rankName,badge_number===undefined?null:(badge_number||null),role,employmentStatus,accountActive,req.params.id]);
  if(!r.rowCount) return res.status(404).json({error:"Ansat ikke fundet"});
  await logAction(req.session.user.id,"UPDATE","Opdater ansat",full_name); res.json(r.rows[0]);
});
app.delete("/api/employees/:id", requireRankAtLeast(8), async (req,res) => {
  const existing=await q("SELECT id,username,full_name,role,rank FROM users WHERE id=$1",[req.params.id]);
  if(!existing.rowCount)return res.status(404).json({error:"Ansat ikke fundet"});
  const employee=existing.rows[0];
  if(Number(employee.id)===Number(req.session.user.id))return res.status(400).json({error:"Du kan ikke fjerne din egen konto"});
  const employeeRank=await q("SELECT level FROM ranks WHERE name=$1",[employee.rank]);
  if(!req.access.full&&(employee.role==="admin"||Number(employeeRank.rows[0]?.level)>=req.access.rank_level))
    return res.status(403).json({error:"Du kan kun fjerne medarbejdere under dit eget rangniveau"});
  await q("DELETE FROM users WHERE id=$1",[employee.id]);
  await logAction(req.session.user.id,"DELETE","Fjern ansat fra tabletten",`${employee.full_name} (${employee.username})`);
  res.json({ok:true,full_name:employee.full_name});
});

app.get("/api/applications", requireAuth, requireFeature("applications_enabled"), async (_req,res) => {
  const r=await q("SELECT * FROM applications ORDER BY created_at DESC");
  res.json(r.rows);
});
app.post("/api/applications", requireAuth, requireFeature("applications_enabled"), async (req,res) => {
  const {applicant_name,type="Civilpolitiet",message=""}=req.body;
  const r=await q("INSERT INTO applications(applicant_name,type,message) VALUES($1,$2,$3) RETURNING *",[applicant_name,type,message]);
  await logAction(req.session.user.id,"CREATE","Ny ansøgning",applicant_name); res.status(201).json(r.rows[0]);
});
app.patch("/api/applications/:id", requireAuth, requireFeature("applications_enabled"), async (req,res) => {
  const allowed=["Afventer","Godkendt","Afvist"];
  if(!allowed.includes(req.body.status)) return res.status(400).json({error:"Ugyldig status"});
  const r=await q("UPDATE applications SET status=$1 WHERE id=$2 RETURNING *",[req.body.status,req.params.id]);
  if(!r.rowCount) return res.status(404).json({error:"Ansøgning ikke fundet"});
  await logAction(req.session.user.id,"UPDATE","Behandl ansøgning",`${r.rows[0].applicant_name}: ${req.body.status}`); res.json(r.rows[0]);
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

app.use((err,req,res,_next)=>{
  console.error("Request failed:",err);
  if(res.headersSent) return;
  const status=err.status || (err.code==="23505"?409:500);
  const error=status===409?"En post med samme identifikation findes allerede.":status<500?err.message:"Der opstod en serverfejl. Prøv igen.";
  res.status(status).json({error});
});

initDb()
  .then(()=>app.listen(PORT,()=>console.log(`POLITI Tablet running on port ${PORT}`)))
  .catch(err=>{ console.error("Database initialization failed:",err); process.exit(1); });


const $=s=>document.querySelector(s);
const content=$("#content");
let me=null;

async function api(url,opts={}){
  const r=await fetch(url,{headers:{"Content-Type":"application/json",...(opts.headers||{})},...opts});
  const data=await r.json().catch(()=>({}));
  if(!r.ok) throw new Error(data.error||"Fejl");
  return data;
}
function esc(v){return String(v??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]))}
function modal(title,html,onSubmit){
  const el=document.createElement("div");el.className="modal";
  el.innerHTML=`<div class="modalbox"><button class="close">×</button><h2>${title}</h2>${html}</div>`;
  document.body.appendChild(el);el.querySelector(".close").onclick=()=>el.remove();
  const form=el.querySelector("form");if(form)form.onsubmit=async e=>{e.preventDefault();try{await onSubmit(new FormData(form));el.remove();await route(location.hash.slice(1)||"dashboard")}catch(x){alert(x.message)}};
}
function layout(title,body){content.innerHTML=`<h1>${title}</h1>${body}`}
async function dashboard(){
 const d=await api("/api/dashboard");
 layout("Dashboard",`<div class="grid">
 ${stat("Sager",d.cases,"cases")}${stat("Efterlysninger",d.warrants,"warrants")}${stat("Personer",d.persons,"persons")}${stat("Køretøjer",d.vehicles,"vehicles")}
 </div><div class="two section" style="margin-top:18px">
 <div class="card"><h2>System</h2><p class="muted">Aktive ansatte: ${d.employees}</p><p class="muted">Afventende ansøgninger: ${d.applications}</p></div>
 <div class="card"><h2>Dagens Besked</h2><p>Velkommen til POLITI-tabletten.</p><span class="tag">${esc(me.rank)}</span></div>
 </div>`);
}
function stat(t,n,p){return `<div class="card"><div class="muted">${t}</div><div class="stat">${n}</div><button class="btn" onclick="location.hash='${p}'">Åbn</button></div>`}
async function persons(){
 const rows=await api("/api/persons?search="+encodeURIComponent(new URLSearchParams(location.search).get("q")||""));
 layout("Person Register",`<div class="toolbar"><input class="search" id="ps" placeholder="Søg person..."><button onclick="searchPersons()">Søg</button><button class="green" onclick="newPerson()">+ Opret person</button></div>
 <table class="table"><thead><tr><th>Navn</th><th>Fødselsdato</th><th>Telefon</th><th>Adresse</th><th></th></tr></thead><tbody>
 ${rows.map(p=>`<tr><td>${esc(p.name)}</td><td>${esc(p.birth_date||"")}</td><td>${esc(p.phone||"")}</td><td>${esc(p.address||"")}</td><td><button class="btn" onclick="person(${p.id})">Åbn</button></td></tr>`).join("")}</tbody></table>`);
}
function searchPersons(){location.search="?q="+encodeURIComponent($("#ps").value)}
function newPerson(){modal("Opret person",`<form class="form"><label>Navn<input name="name" required></label><label>Adresse<input name="address"></label><label>Telefon<input name="phone"></label><label>Fødselsdato<input type="date" name="birth_date"></label><label>Køn<input name="gender"></label><label>Noter<textarea name="notes"></textarea></label><button class="primary">Opret</button></form>`,async f=>api("/api/persons",{method:"POST",body:JSON.stringify(Object.fromEntries(f))}))}
async function person(id){
 const d=await api("/api/persons/"+id);
 layout("Person Register",`<div class="card section"><h2>${esc(d.person.name)}</h2><p>${esc(d.person.address||"")} · ${esc(d.person.phone||"")}</p><p class="muted">Født: ${esc(d.person.birth_date||"-")} · Køn: ${esc(d.person.gender||"-")}</p><p>${esc(d.person.notes||"")}</p><button class="btn" onclick="newCase(${id})">+ Opret sigtelse/sag</button></div>
 <div class="section"><h2>Tidligere Sager</h2>${table(["Sagsnummer","Titel","Bøde","Fængsel","Dato"],d.cases.map(c=>[c.case_number,c.title,c.fine_dkk+" DKK",c.prison_days+" dage",new Date(c.created_at).toLocaleDateString("da-DK")]))}</div>
 <div class="section"><h2>Køretøjer</h2>${table(["Nummerplade","Mærke","Model","Status"],d.vehicles.map(v=>[v.plate,v.make,v.model,v.status]))}</div>
 <div class="section"><h2>Efterlysninger</h2>${table(["Type","Titel","Status"],d.warrants.map(w=>[w.type,w.title,w.active?"Aktiv":"Lukket"]))}`);
}
function table(headers,rows){return `<table class="table"><thead><tr>${headers.map(h=>`<th>${h}</th>`).join("")}</tr></thead><tbody>${rows.map(r=>`<tr>${r.map(x=>`<td>${esc(x)}</td>`).join("")}</tr>`).join("")}</tbody></table>`}
function newCase(id){modal("Opret sag",`<form class="form"><label>Titel<input name="title" required></label><label>Beskrivelse<textarea name="description"></textarea></label><label>Bøde DKK<input type="number" name="fine_dkk" value="0"></label><label>Fængsel dage<input type="number" name="prison_days" value="0"></label><label>Klip<input type="number" name="license_points" value="0"></label><button class="primary">Opret sag</button></form>`,async f=>api("/api/persons/"+id+"/cases",{method:"POST",body:JSON.stringify(Object.fromEntries(f))}))}
async function vehicles(){
 const rows=await api("/api/vehicles");
 layout("Køretøjs Database",`<div class="toolbar"><input class="search" id="vs" placeholder="Søg nummerplade, mærke eller model"><button onclick="vehicleSearch()">Søg</button><button class="green" onclick="newVehicle()">+ Opret køretøj</button></div>${table(["Nummerplade","Ejer","Mærke","Model","Kategori","Status"],rows.map(v=>[v.plate,v.owner_name||"-",v.make||"",v.model||"",v.category||"",v.status]))}`);
}
function vehicleSearch(){/* filtering can be added without changing API */ alert("Søgning er klar til næste udvidelse.")}
function newVehicle(){modal("Opret køretøj",`<form class="form"><label>Nummerplade<input name="plate" required></label><label>Ejer ID<input name="owner_id" type="number"></label><label>Mærke<input name="make"></label><label>Model<input name="model"></label><label>Kategori<input name="category"></label><label>Farve<input name="color"></label><label>Status<input name="status" value="Normal"></label><label>Noter<textarea name="notes"></textarea></label><button class="primary">Opret</button></form>`,async f=>api("/api/vehicles",{method:"POST",body:JSON.stringify(Object.fromEntries(f))}))}
async function warrants(){
 const rows=await api("/api/warrants");
 layout("Efterlysninger",`<div class="toolbar"><button class="green" onclick="newWarrant()">+ Opret efterlysning</button></div>${table(["Type","Person","Nummerplade","Titel","Status","Oprettet"],rows.map(w=>[w.type,w.person_name||"-",w.plate||"-",w.title,w.active?"Aktiv":"Lukket",new Date(w.created_at).toLocaleDateString("da-DK")]))}`);
}
function newWarrant(){modal("Opret efterlysning",`<form class="form"><label>Person ID<input name="person_id" type="number"></label><label>Køretøj ID<input name="vehicle_id" type="number"></label><label>Type<select name="type"><option>Person</option><option>Køretøj</option></select></label><label>Titel<input name="title" required></label><label>Beskrivelse<textarea name="description"></textarea></label><button class="primary">Opret</button></form>`,async f=>api("/api/warrants",{method:"POST",body:JSON.stringify(Object.fromEntries(f))}))}
async function fines(){const rows=await api("/api/fines");layout("Bødetakster",`${table(["Kategori","Kode","Titel","Pris","Klip"],rows.map(f=>[f.category,f.code,f.title,f.price_dkk+" DKK",f.points]))}`)}
async function board(){const rows=await api("/api/board");layout("Opslagstavle",`<div class="toolbar"><button class="green" onclick="newPost()">+ Nyt opslag</button></div><div class="grid">${rows.map(p=>`<div class="card"><h2>${esc(p.title)}</h2><p>${esc(p.body)}</p><small class="muted">${esc(p.author_name||"Ukendt")} · ${new Date(p.created_at).toLocaleString("da-DK")}</small></div>`).join("")}</div>`)}
function newPost(){modal("Nyt opslag",`<form class="form"><label>Titel<input name="title" required></label><label>Tekst<textarea name="body" required></textarea></label><label><input type="checkbox" name="pinned"> Fastgør</label><button class="primary">Opret</button></form>`,async f=>{const o=Object.fromEntries(f);o.pinned=f.get("pinned")==="on";return api("/api/board",{method:"POST",body:JSON.stringify(o)})})}
async function employees(){const rows=await api("/api/employees");layout("Ansatte",table(["Navn","Rang","Badge","Rolle","Aktiv"],rows.map(e=>[e.full_name,e.rank,e.badge_number||"-",e.role,e.active?"YES":"NO"])));}
async function applications(){const rows=await api("/api/applications");layout("Ansøgninger",`<div class="card"><h2>Civilpolitiet</h2><p class="muted">Ansøgning til civilpolitiet.</p></div><br>${table(["Ansøger","Type","Status","Dato"],rows.map(a=>[a.applicant_name,a.type,a.status,new Date(a.created_at).toLocaleDateString("da-DK")]))}`)}
async function logs(){const rows=await api("/api/logs");layout("Logs",table(["Handling","Titel","Beskrivelse","Udført af","Dato"],rows.map(l=>[l.action,l.title,l.description,l.full_name||"-",new Date(l.created_at).toLocaleString("da-DK")])));}
async function settings(){const s=await api("/api/settings");layout("Admin Indstillinger",`<div class="card form"><label>Systemnavn<input id="site" value="${esc(s.site_name||"POLITI")}"></label><label>Sprog<input id="lang" value="${esc(s.language||"da")}"></label><label>Frakendelse år<input id="years" type="number" value="${esc(s.frakendelse_years||3)}"></label><button class="primary" onclick="saveSettings()">Gem</button></div>`)}
async function saveSettings(){await api("/api/settings",{method:"POST",body:JSON.stringify({site_name:$("#site").value,language:$("#lang").value,frakendelse_years:$("#years").value})});alert("Gemt");}
const pages={dashboard,persons,vehicles,warrants,board,fines,employees,applications,logs,settings};
async function route(p){try{(pages[p]||dashboard)()}catch(e){content.innerHTML=`<div class="card error">${esc(e.message)}</div>`}}
document.querySelectorAll("#nav button").forEach(b=>b.onclick=()=>location.hash=b.dataset.page);
window.addEventListener("hashchange",()=>route(location.hash.slice(1)||"dashboard"));
$("#loginForm").onsubmit=async e=>{e.preventDefault();$("#loginError").textContent="";try{const r=await api("/api/login",{method:"POST",body:JSON.stringify({username:$("#username").value,password:$("#password").value})});me=r.user;$("#userName").textContent=`${me.full_name} · ${me.rank}`;document.querySelectorAll(".adminOnly").forEach(x=>x.classList.toggle("hidden",me.role!=="admin"));$("#login").classList.add("hidden");$("#app").classList.remove("hidden");location.hash="dashboard"}catch(x){$("#loginError").textContent=x.message}};
$("#logout").onclick=async()=>{await api("/api/logout",{method:"POST"});location.reload()};
api("/api/me").then(r=>{me=r.user;$("#userName").textContent=`${me.full_name} · ${me.rank}`;$("#login").classList.add("hidden");$("#app").classList.remove("hidden");document.querySelectorAll(".adminOnly").forEach(x=>x.classList.toggle("hidden",me.role!=="admin"));route(location.hash.slice(1)||"dashboard")}).catch(()=>{});

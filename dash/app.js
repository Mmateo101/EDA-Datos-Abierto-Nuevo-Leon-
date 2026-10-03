// ============================================================
// Datos Abiertos Nuevo León — dashboard app logic
// ============================================================
// Los datos viajan cifrados (AES, CryptoJS) dentro del HTML y solo se descifran
// en el navegador si se ingresa la contraseña correcta. startApp(DATA) arranca
// toda la app una vez que los datos ya están en claro (ver el candado al final
// de este archivo).
function startApp(DATA){
const DB = DATA.databases;
const VARS = DATA.variables;
const TAGGRAPH = DATA.tag_graph;
const EDGES = DATA.shared_var_edges;
const VARFREQ = DATA.var_freq;
const META = DATA.meta;
// Variable names used by more than 15 databases — hidden by default in the Mapa de variables
// network (they'd connect almost every node and drown out the more specific, meaningful links).
const GENERIC_VAR_NAMES = Object.entries(VARFREQ).filter(([,c]) => c > 15).sort((a,b)=>b[1]-a[1]).map(([v])=>v);

const dbById = new Map(DB.map(d => [d.id, d]));
const ORANGE = getComputedStyle(document.documentElement); // placeholder, colors read live below

function cssVar(name){ return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }

// ---------------- THEME ----------------
function applyStoredTheme(){
  try{
    const t = localStorage.getItem('nl-theme');
    if(t === 'dark' || t === 'light') document.documentElement.setAttribute('data-theme', t);
  }catch(e){}
}
function toggleTheme(){
  const cur = document.documentElement.getAttribute('data-theme');
  const sysDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  const curEffective = cur || (sysDark ? 'dark' : 'light');
  const next = curEffective === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', next);
  try{ localStorage.setItem('nl-theme', next); }catch(e){}
  // redraw charts that bake in colors
  renderTimeline(); renderTagNetwork(); renderVarNetwork();
}
applyStoredTheme();

// ---------------- NAV ----------------
const pages = Array.from(document.querySelectorAll('.page'));
const navlinks = Array.from(document.querySelectorAll('.navlink'));
function showPage(i){
  pages.forEach(p => p.classList.toggle('active', p.id === 'page-' + i));
  navlinks.forEach(a => a.classList.toggle('active', a.dataset.page === String(i)));
  document.getElementById('nav').classList.remove('open');
  window.scrollTo(0,0);
  if(i === '1' || i === 1){ renderTimeline(); renderTagNetwork(); }
  if(i === '4' || i === 4){ renderVarNetwork(); }
  try{ history.replaceState(null,'', '#p' + i); }catch(e){}
}
navlinks.forEach(a => a.addEventListener('click', () => showPage(a.dataset.page)));

// ---------------- TOOLTIP ----------------
const tip = document.getElementById('tooltip');
function showTip(html, evt){
  tip.innerHTML = html;
  tip.style.opacity = 1;
  moveTip(evt);
}
function moveTip(evt){
  const x = evt.clientX, y = evt.clientY;
  tip.style.left = Math.min(x + 14, window.innerWidth - 270) + 'px';
  tip.style.top = Math.min(y + 14, window.innerHeight - 60) + 'px';
}
function hideTip(){ tip.style.opacity = 0; }

// ---------------- HELPERS ----------------
function esc(s){ return (s==null?'':String(s)).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
const MESES = ['enero','febrero','marzo','abril','mayo','junio','julio','agosto','septiembre','octubre','noviembre','diciembre'];
function mesNombre(i, abrev){ const m = MESES[i]||''; return abrev ? (m.slice(0,3)) : m; }
function cap(s){ return s ? s[0].toUpperCase()+s.slice(1) : s; }
// Formats an ISO 'YYYY-MM-DD' (or 'YYYY-MM-DDTHH:mm:ss') string as "12 de septiembre de 2026".
// Anything that isn't an ISO date (e.g. free-text periodicity values) is returned unchanged.
function fmtDate(d){
  if(!d) return '—';
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(d);
  if(!m) return d;
  const [, y, mo, day] = m;
  return `${parseInt(day,10)} de ${mesNombre(parseInt(mo,10)-1)} de ${y}`;
}
function scoreColor(score){
  if(score >= 80) return cssVar('--good');
  if(score >= 50) return cssVar('--oxido');
  return cssVar('--bad');
}
// Recomputes the 5 score criteria for one database (mirrors the notebook's score_completitud formula)
// so the dashboard can explain WHY a database got its score, not just show the number.
function scoreCriteria(d){
  const wc = (d.descripcion||'').trim().split(/\s+/).filter(Boolean).length;
  return [
    {label:'Tiene diccionario de variables', ok: d.diccionario === 'Si', detail: d.diccionario === 'Si' ? 'Diccionario (Si/No) = "Sí"' : 'Diccionario (Si/No) = "No"'},
    {label:'Tiene etiquetas', ok: !!(d.etiquetas && d.etiquetas.length), detail: (d.etiquetas && d.etiquetas.length) ? `${d.etiquetas.length} etiqueta(s) asignada(s)` : 'Sin etiquetas'},
    {label:'Tiene grupo o categoría', ok: !!(d.grupos && d.grupos.length), detail: (d.grupos && d.grupos.length) ? `${d.grupos.length} grupo(s) asignado(s)` : 'Sin grupo asignado'},
    {label:'Descripción completa', ok: wc > 5, detail: `${wc} palabra(s) en la descripción (se requieren más de 5)`},
    {label:'Vigente', ok: !d.vencida, detail: d.vencida ? 'Vencida: su próxima actualización esperada ya pasó' : 'Vigente según su periodicidad declarada'},
  ];
}
function scoreBreakdownHtml(d){
  const crit = scoreCriteria(d);
  const rows = crit.map(c => `
    <tr>
      <td>${c.ok ? '<span class="pill good">Cumple</span>' : '<span class="pill bad">No cumple</span>'}</td>
      <td>${esc(c.label)}</td>
      <td class="mono">${c.ok ? 20 : 0}/20</td>
      <td class="hint" style="margin:0">${esc(c.detail)}</td>
    </tr>`).join('');
  return `<div class="tablewrap"><table><thead><tr><th></th><th>Criterio</th><th>Puntos</th><th>Detalle</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}
function barRows(container, data, opts={}){
  // data: [{label, value}], opts.max, opts.fmt, opts.color, opts.onClick
  const max = opts.max || d3.max(data, d => d.value) || 1;
  container.innerHTML = '';
  data.forEach(d => {
    const row = document.createElement('div');
    row.className = 'bar-row';
    const pct = Math.max(2, (d.value / max) * 100);
    row.innerHTML = `<div class="lbl">${esc(d.label)}</div>
      <div class="bar-track"><div class="bar-fill ${opts.colorClass||''}" style="width:${pct}%; background:${opts.color ? (typeof opts.color==='function'? opts.color(d):opts.color) : ''}"></div></div>
      <div class="bar-val mono">${opts.fmt ? opts.fmt(d.value) : d.value}</div>`;
    if(opts.onClick){
      row.style.cursor = 'pointer';
      row.addEventListener('click', () => opts.onClick(d));
    }
    container.appendChild(row);
  });
}

// ============================================================
// PAGE 0 — PORTADA
// ============================================================
function renderPortada(){
  document.getElementById('m-bases').textContent = META.total_bases;
  document.getElementById('m-orgs').textContent = META.total_organizaciones;
  document.getElementById('m-vars').textContent = META.total_variables;
  document.getElementById('m-fecha').textContent = fmtDate(META.fecha_referencia);
  document.getElementById('ref-date-foot').textContent = 'Ref. ' + fmtDate(META.fecha_referencia);

  const links = [
    {n:'01', page:1, t:'Generalidades', d:'Volumen, organizaciones, etiquetas y vigencia de la plataforma completa.'},
    {n:'02', page:2, t:'Grupos', d:'Cumplimiento y composición por área temática.'},
    {n:'03', page:3, t:'Análisis por base de datos', d:'Ficha completa de metadatos de cualquier base de datos.'},
    {n:'04', page:4, t:'Mapa de variables', d:'Qué bases de datos comparten estructura entre sí.'},
    {n:'05', page:5, t:'Análisis de variables', d:'Diccionario de datos: rango, descripción y % faltante.'},
    {n:'06', page:6, t:'Buscador', d:'Encuentra bases de datos por nombre, etiqueta o año.'},
    {n:'07', page:7, t:'GeoStats e ideas', d:'Categorías útiles y propuestas de proyecto para GeoStats.'},
  ];
  const wrap = document.getElementById('portada-links');
  wrap.innerHTML = links.map(l => `
    <div class="linkcard" data-page="${l.page}">
      <div class="n">${l.n}</div>
      <h3>${l.t}</h3>
      <p>${l.d}</p>
    </div>`).join('');
  wrap.querySelectorAll('.linkcard').forEach(el => el.addEventListener('click', () => showPage(el.dataset.page)));
}

// ============================================================
// PAGE 1 — GENERALIDADES
// ============================================================
function renderGeneralidades(){
  document.getElementById('s-bases').textContent = META.total_bases;
  document.getElementById('s-orgs').textContent = META.total_organizaciones;
  document.getElementById('s-sindicc').textContent = META.sin_diccionario;
  document.getElementById('s-vencidas').textContent = META.vencidas;
  document.getElementById('s-fecha-ref').textContent = fmtDate(META.fecha_referencia);
  document.getElementById('vencidas-fecha-ref').textContent = fmtDate(META.fecha_referencia);

  // orgs bar chart
  const orgCounts = d3.rollups(DB, v => v.length, d => d.organizacion)
    .filter(d => d[0])
    .sort((a,b) => b[1]-a[1]).slice(0,12)
    .map(d => ({label:d[0], value:d[1]}));
  barRows(document.getElementById('chart-orgs'), orgCounts, {color: cssVar('--blue')});

  // sin diccionario table
  const nodict = DB.filter(d => d.diccionario === 'No');
  document.getElementById('nodict-sub').textContent = nodict.length + ' de ' + DB.length + ' bases de datos';
  document.querySelector('#tbl-nodict tbody').innerHTML = nodict.map(d =>
    `<tr><td>${esc(d.nombre)}</td><td>${esc(d.organizacion||'—')}</td></tr>`).join('') || '<tr><td colspan=2 class="empty">Ninguna</td></tr>';

  // vencidas table
  const venc = DB.filter(d => d.vencida).sort((a,b)=>(a.expected_next_update||'').localeCompare(b.expected_next_update||''));
  document.querySelector('#tbl-vencidas tbody').innerHTML = venc.map(d =>
    `<tr><td>${esc(d.nombre)}</td><td>${esc(d.periodo_actualizacion||'—')}</td><td>${fmtDate(d.expected_next_update)}</td></tr>`).join('') || '<tr><td colspan=3 class="empty">Ninguna</td></tr>';

  renderTimeline();
  renderTagNetwork();
}

function renderTimeline(){
  const el = document.getElementById('chart-timeline');
  el.innerHTML = '';
  const w = el.clientWidth || 500, h = 220, m = {t:10,r:16,b:26,l:40};
  const svg = d3.select(el).append('svg').attr('viewBox', `0 0 ${w} ${h}`).attr('width','100%').attr('height',h);

  const dated = DB.filter(d => d.fecha_creacion).map(d => ({date: new Date(d.fecha_creacion)})).sort((a,b)=>a.date-b.date);
  const cum = dated.map((d,i) => ({date:d.date, count:i+1}));
  const x = d3.scaleTime().domain(d3.extent(cum, d=>d.date)).range([m.l, w-m.r]);
  const y = d3.scaleLinear().domain([0, d3.max(cum,d=>d.count)]).nice().range([h-m.b, m.t]);

  svg.append('g').attr('class','axis').attr('transform',`translate(0,${h-m.b})`)
    .call(d3.axisBottom(x).ticks(d3.timeMonth.every(4)).tickSizeOuter(0)
      .tickFormat(d => `${cap(mesNombre(d.getMonth(), true))} '${String(d.getFullYear()).slice(2)}`));
  svg.append('g').attr('class','axis').attr('transform',`translate(${m.l},0)`)
    .call(d3.axisLeft(y).ticks(5).tickSizeOuter(0));

  const area = d3.area().x(d=>x(d.date)).y0(h-m.b).y1(d=>y(d.count)).curve(d3.curveMonotoneX);
  const line = d3.line().x(d=>x(d.date)).y(d=>y(d.count)).curve(d3.curveMonotoneX);

  svg.append('path').datum(cum).attr('d', area).attr('fill', cssVar('--orange')).attr('opacity', 0.14);
  svg.append('path').datum(cum).attr('d', line).attr('fill','none').attr('stroke', cssVar('--orange')).attr('stroke-width', 2);

  svg.selectAll('circle').data(cum.filter((d,i)=> i===cum.length-1)).enter().append('circle')
    .attr('cx', d=>x(d.date)).attr('cy', d=>y(d.count)).attr('r', 3.5).attr('fill', cssVar('--orange'));

  svg.on('mousemove', function(evt){
    const [mx] = d3.pointer(evt);
    const date0 = x.invert(mx);
    const bisect = d3.bisector(d=>d.date).left;
    const i = Math.min(cum.length-1, Math.max(0, bisect(cum, date0)));
    const d = cum[i];
    if(!d) return;
    showTip(`<b>${cap(mesNombre(d.date.getMonth()))} ${d.date.getFullYear()}</b><br>${d.count} bases de datos acumuladas`, evt);
  }).on('mouseleave', hideTip);
}

// ---------------- Zoom/pan helper for network graphs ----------------
function enableZoom(svg, zoomGroup, w, h, resetBtnId){
  const zoom = d3.zoom()
    .scaleExtent([0.4, 6])
    .on('zoom', (evt) => zoomGroup.attr('transform', evt.transform));
  svg.call(zoom).call(zoom.transform, d3.zoomIdentity);
  if(resetBtnId){
    const btn = document.getElementById(resetBtnId);
    if(btn){
      btn.onclick = () => svg.transition().duration(300).call(zoom.transform, d3.zoomIdentity);
    }
  }
  return zoom;
}

// ---------------- Tag <-> DB network ----------------
let tagSelected = null, dbSelected = null;
function renderTagNetwork(){
  const el = document.getElementById('tag-network');
  el.innerHTML = '';
  const w = el.clientWidth || 900, h = 460;
  const svg = d3.select(el).append('svg').attr('viewBox',`0 0 ${w} ${h}`).attr('width','100%').attr('height',h);
  const gZoom = svg.append('g');
  const gLinks = gZoom.append('g'), gNodes = gZoom.append('g');
  enableZoom(svg, gZoom, w, h, 'tag-network-reset');

  const tagNodes = TAGGRAPH.map(t => ({id:'tag:'+t.tag, type:'tag', label:t.tag, count:t.count, dbs:t.dbs}));
  const dbNodes = DB.map(d => ({id:'db:'+d.id, type:'db', label:d.nombre, dbid:d.id}));
  const nodes = tagNodes.concat(dbNodes);
  const links = [];
  TAGGRAPH.forEach(t => t.dbs.forEach(dbid => links.push({source:'tag:'+t.tag, target:'db:'+dbid})));

  const sim = d3.forceSimulation(nodes)
    .force('link', d3.forceLink(links).id(d=>d.id).distance(l => 34).strength(0.35))
    .force('charge', d3.forceManyBody().strength(d => d.type==='tag' ? -70 - d.count*3 : -30))
    .force('center', d3.forceCenter(w/2, h/2))
    .force('collide', d3.forceCollide(d => d.type==='tag' ? 6+Math.sqrt(d.count)*2 : 4))
    .stop();
  for(let i=0;i<220;i++) sim.tick();

  const link = gLinks.selectAll('line').data(links).enter().append('line')
    .attr('x1',d=>d.source.x).attr('y1',d=>d.source.y).attr('x2',d=>d.target.x).attr('y2',d=>d.target.y)
    .attr('stroke', cssVar('--line')).attr('stroke-width', 0.6).attr('opacity',0.5);

  const node = gNodes.selectAll('circle').data(nodes).enter().append('circle')
    .attr('cx', d=>d.x).attr('cy', d=>d.y)
    .attr('r', d => d.type==='tag' ? 4+Math.sqrt(d.count)*1.6 : 3)
    .attr('fill', d => d.type==='tag' ? cssVar('--orange') : cssVar('--blue'))
    .attr('opacity', d => d.type==='tag' ? 0.88 : 0.55)
    .attr('stroke', cssVar('--surface')).attr('stroke-width', 0.6)
    .style('cursor','pointer');

  node.on('mousemove', function(evt,d){
    if(d.type==='db') showTip(`<b>${esc(d.label)}</b>`, evt);
    else showTip(`<b>#${esc(d.label)}</b><br>${d.count} base(s) de datos`, evt);
  }).on('mouseleave', hideTip)
  .on('click', function(evt,d){
    if(d.type==='tag'){ tagSelected = (tagSelected===d.label) ? null : d.label; dbSelected = null; }
    else { dbSelected = (dbSelected===d.dbid) ? null : d.dbid; tagSelected = null; }
    applyTagNetworkHighlight();
  });

  function applyTagNetworkHighlight(){
    const info = document.getElementById('tag-network-info');
    if(tagSelected){
      const t = TAGGRAPH.find(t=>t.tag===tagSelected);
      const dbset = new Set(t.dbs);
      node.attr('opacity', d => d.type==='tag' ? (d.label===tagSelected?1:0.15) : (dbset.has(d.dbid)?1:0.08))
          .attr('r', d => d.type==='db' && dbset.has(d.dbid) ? 5 : (d.type==='tag' ? 4+Math.sqrt(d.count)*1.6 : 3));
      link.attr('opacity', l => l.source.label===tagSelected ? 0.9 : 0.04)
          .attr('stroke', l => l.source.label===tagSelected ? cssVar('--orange') : cssVar('--line'));
      info.innerHTML = `Etiqueta <b>#${esc(tagSelected)}</b> — <b>${t.count}</b> base(s) de datos: ${t.dbs.map(id=>esc(dbById.get(id)?.nombre||id)).join(', ')}`;
    } else if(dbSelected){
      const d = dbById.get(dbSelected);
      const tags = new Set((d.etiquetas||[]).map(t=>t.toLowerCase()));
      node.attr('opacity', n => n.type==='db' ? (n.dbid===dbSelected?1:0.08) : (tags.has(n.label)?1:0.12))
          .attr('r', n => n.type==='db' ? (n.dbid===dbSelected?5:3) : 4+Math.sqrt(n.count)*1.6);
      link.attr('opacity', l => l.target.dbid===dbSelected ? 0.9 : 0.04)
          .attr('stroke', l => l.target.dbid===dbSelected ? cssVar('--blue') : cssVar('--line'));
      info.innerHTML = tags.size ? `<b>${esc(d.nombre)}</b> pertenece a: ${[...tags].map(t=>'#'+esc(t)).join(', ')}` : `<b>${esc(d.nombre)}</b> no tiene etiquetas asignadas.`;
    } else {
      node.attr('opacity', d => d.type==='tag'?0.88:0.55).attr('r', d => d.type==='tag' ? 4+Math.sqrt(d.count)*1.6 : 3);
      link.attr('opacity',0.5).attr('stroke', cssVar('--line'));
      info.textContent = 'Sin selección — haz clic en cualquier nodo para explorar.';
    }
  }
  applyTagNetworkHighlight();
}

// ============================================================
// PAGE 2 — GRUPOS
// ============================================================
function groupStats(){
  const map = new Map();
  DB.forEach(d => {
    (d.grupos||[]).forEach(g => {
      if(!map.has(g)) map.set(g, {grupo:g, dbs:[], vencidasEval:0, totalEval:0, scoreSum:0});
      const o = map.get(g);
      o.dbs.push(d);
      o.scoreSum += d.score_completitud||0;
      if(d.periodo_actualizacion && d.periodo_actualizacion !== 'documento único'){
        o.totalEval++; if(d.vencida) o.vencidasEval++;
      }
    });
  });
  return [...map.values()].map(o => ({...o, count:o.dbs.length, avgScore: o.scoreSum/o.dbs.length, pctVencidas: o.totalEval? (o.vencidasEval/o.totalEval*100):0}));
}
function renderGrupos(){
  const gs = groupStats().sort((a,b)=>b.count-a.count);
  barRows(document.getElementById('chart-groups'), gs.map(g=>({label:g.grupo, value:g.count, _g:g})), {
    color: cssVar('--blue'), onClick: d => selectGroup(d._g.grupo)
  });
  const gv = gs.filter(g=>g.totalEval>0).sort((a,b)=>b.pctVencidas-a.pctVencidas);
  barRows(document.getElementById('chart-groups-vencidas'), gv.map(g=>({label:g.grupo, value:Math.round(g.pctVencidas*10)/10, _g:g})), {
    color: cssVar('--bad'), fmt: v=>v+'%', max:100, onClick: d => selectGroup(d._g.grupo)
  });
  const gscore = gs.slice().sort((a,b)=>b.avgScore-a.avgScore);
  barRows(document.getElementById('chart-groups-score'), gscore.map(g=>({label:g.grupo, value:Math.round(g.avgScore*10)/10, _g:g})), {
    color: d => scoreColor(d.value), max:100, fmt: v=>v, onClick: d => selectGroup(d._g.grupo)
  });
  if(gs.length) selectGroup(gs[0].grupo);
}
function selectGroup(gname){
  const gs = groupStats();
  const g = gs.find(x=>x.grupo===gname);
  if(!g) return;
  document.getElementById('group-detail-title').textContent = gname;
  document.getElementById('group-detail-sub').textContent =
    `${g.count} bases de datos · score promedio ${g.avgScore.toFixed(0)}/100 · ${g.pctVencidas.toFixed(0)}% vencidas`;
  document.querySelector('#tbl-group-detail tbody').innerHTML = g.dbs
    .sort((a,b)=>(b.score_completitud||0)-(a.score_completitud||0))
    .map(d => `<tr>
      <td>${esc(d.nombre)}</td>
      <td>${esc(d.organizacion||'—')}</td>
      <td class="mono">${d.score_completitud ?? '—'}</td>
      <td>${d.vencida ? '<span class="pill bad">Vencida</span>' : '<span class="pill good">Vigente</span>'}</td>
    </tr>`).join('');
}

// ============================================================
// PAGE 3 — ANALISIS POR BASE DE DATOS
// ============================================================
function renderDbSelect(){
  const sel = document.getElementById('db-select');
  sel.innerHTML = DB.slice().sort((a,b)=>a.nombre.localeCompare(b.nombre))
    .map(d => `<option value="${d.id}">${esc(d.nombre)}</option>`).join('');
  sel.addEventListener('change', () => renderDbDetail(sel.value));
  renderDbDetail(sel.value);
}
function renderDbDetail(id){
  const d = dbById.get(id);
  if(!d) return;
  const el = document.getElementById('db-detail');
  const statusPill = d.vencida ? '<span class="pill bad">Vencida</span>' : '<span class="pill good">Vigente</span>';
  const dictPill = d.diccionario==='Si' ? '<span class="pill good">Con diccionario</span>' : '<span class="pill bad">Sin diccionario</span>';
  el.innerHTML = `
    <div class="card" style="margin-bottom:16px">
      <div style="display:flex; justify-content:space-between; align-items:flex-start; gap:16px; flex-wrap:wrap">
        <div style="flex:1; min-width:260px">
          <h3 style="font-size:18px">${esc(d.nombre)}</h3>
          <p class="sub" style="margin-bottom:10px">${esc(d.descripcion) || 'Sin descripción disponible.'}</p>
          <div>${statusPill} ${dictPill} <span class="pill">Score ${d.score_completitud ?? '—'}/100</span></div>
        </div>
        <div class="stat" style="min-width:120px">
          <div class="num mono" style="color:${scoreColor(d.score_completitud||0)}">${d.score_completitud ?? '—'}</div>
          <div class="lbl">Score /100</div>
        </div>
      </div>
    </div>
    <div class="card" style="margin-bottom:16px">
      <h3>Desglose del score</h3>
      <p class="sub">Por qué esta base de datos obtuvo ${d.score_completitud ?? '—'}/100 — ver la fórmula completa en <a onclick="showPage(2)">Grupos</a></p>
      ${scoreBreakdownHtml(d)}
    </div>
    <div class="grid g2">
      <div class="card">
        <h3>Metadatos</h3>
        <dl class="kv">
          <dt>Organización</dt><dd>${esc(d.organizacion)||'—'}</dd>
          <dt>Autor</dt><dd>${esc(d.autor)||'—'}</dd>
          <dt>Mantenedor</dt><dd>${esc(d.mantenedor)||'—'}</dd>
          <dt>Fuente</dt><dd>${esc(d.fuente)||'—'}</dd>
          <dt>Licencia</dt><dd>${esc(d.licencia)||'—'}</dd>
          <dt>Formatos</dt><dd>${esc(d.formatos)||'—'}</dd>
          <dt>Fecha de creación</dt><dd class="mono">${fmtDate(d.fecha_creacion)}</dd>
          <dt>Última actualización</dt><dd class="mono">${fmtDate(d.ultima_actualizacion)}</dd>
          <dt>Periodo de actualización</dt><dd>${esc(d.periodo_actualizacion)||'—'}</dd>
          <dt>Próxima actualización</dt><dd>${esc(d.proxima_actualizacion)||'—'}</dd>
        </dl>
      </div>
      <div class="card">
        <h3>Estructura de datos</h3>
        <dl class="kv" style="margin-bottom:14px">
          <dt>Número de variables</dt><dd class="mono">${d.num_variables ?? 'No disponible'}</dd>
          <dt>Número de rows</dt><dd>No disponible — el catálogo scrapeado solo contiene metadatos, no las bases de datos completas.</dd>
          <dt>% promedio faltante</dt><dd class="mono">${d.avg_pct_nulls!=null ? d.avg_pct_nulls+'%' : '—'}</dd>
        </dl>
        <h3 style="margin-top:14px">Etiquetas</h3>
        <div style="margin-bottom:12px">${(d.etiquetas||[]).map(t=>`<span class="chip orange">#${esc(t)}</span>`).join('') || '<span class="hint">Sin etiquetas</span>'}</div>
        <h3>Grupos</h3>
        <div>${(d.grupos||[]).map(g=>`<span class="chip">${esc(g)}</span>`).join('') || '<span class="hint">Sin grupo asignado</span>'}</div>
      </div>
    </div>`;
}
function jumpToDb(id){
  showPage(3);
  const sel = document.getElementById('db-select');
  sel.value = id;
  renderDbDetail(id);
}

// ============================================================
// PAGE 4 — MAPA DE VARIABLES
// ============================================================
function renderVarNetwork(){
  const el = document.getElementById('var-network');
  const minShared = +document.getElementById('minshared').value;
  const hideGeneric = document.getElementById('hide-generic').checked;
  document.getElementById('minshared-val').textContent = minShared;
  document.getElementById('generic-names-hint').textContent = GENERIC_VAR_NAMES.join(', ') || 'ninguno';

  let edges = EDGES.filter(e => e.weight >= minShared);
  if(hideGeneric){
    edges = edges.map(e => ({...e, vars: e.vars.filter(v => VARFREQ[v] <= 15)}))
                 .map(e => ({...e, weight: e.vars.length}))
                 .filter(e => e.weight >= 1);
  }
  const nodeIds = new Set();
  edges.forEach(e => { nodeIds.add(e.source); nodeIds.add(e.target); });
  const nodes = [...nodeIds].map(id => ({id, label: dbById.get(id)?.nombre || id, nv: dbById.get(id)?.num_variables || 1, score: dbById.get(id)?.score_completitud||0}));

  el.innerHTML = '';
  if(!nodes.length){
    el.innerHTML = '<p class="empty">Ninguna conexión con este umbral. Reduce el mínimo de variables compartidas.</p>';
    return;
  }
  const w = el.clientWidth || 900, h = 520;
  const svg = d3.select(el).append('svg').attr('viewBox',`0 0 ${w} ${h}`).attr('width','100%').attr('height',h);
  const gZoom = svg.append('g');
  const gLinks = gZoom.append('g'), gNodes = gZoom.append('g');
  enableZoom(svg, gZoom, w, h, 'var-network-reset');

  const linkObjs = edges.map(e => ({...e}));
  const sim = d3.forceSimulation(nodes)
    .force('link', d3.forceLink(linkObjs).id(d=>d.id).distance(50).strength(0.25))
    .force('charge', d3.forceManyBody().strength(-90))
    .force('center', d3.forceCenter(w/2,h/2))
    .force('collide', d3.forceCollide(8))
    .stop();
  for(let i=0;i<260;i++) sim.tick();

  const link = gLinks.selectAll('line').data(linkObjs).enter().append('line')
    .attr('x1',d=>d.source.x).attr('y1',d=>d.source.y).attr('x2',d=>d.target.x).attr('y2',d=>d.target.y)
    .attr('stroke', cssVar('--blue')).attr('stroke-width', d=>0.6+Math.sqrt(d.weight)).attr('opacity',0.35);

  const node = gNodes.selectAll('circle').data(nodes).enter().append('circle')
    .attr('cx',d=>d.x).attr('cy',d=>d.y)
    .attr('r', d => 3+Math.sqrt(d.nv))
    .attr('fill', d => scoreColor(d.score)).attr('opacity',0.85)
    .attr('stroke', cssVar('--surface')).attr('stroke-width',0.7)
    .style('cursor','pointer');

  let fixedSel = null;
  node.on('mousemove', function(evt,d){
    if(fixedSel) return;
    showTip(`<b>${esc(d.label)}</b><br>${d.nv} variable(s) en su diccionario · score ${d.score}/100`, evt);
  }).on('mouseleave', function(){ if(!fixedSel) hideTip(); })
  .on('click', function(evt,d){
    fixedSel = (fixedSel===d.id) ? null : d.id;
    highlightVar();
  });

  function highlightVar(){
    const info = document.getElementById('var-network-info');
    if(!fixedSel){
      node.attr('opacity',0.85); link.attr('opacity',0.35).attr('stroke', cssVar('--blue'));
      info.textContent = 'Pasa el cursor por un nodo para ver la base de datos; haz clic para fijar el detalle de sus conexiones.';
      hideTip();
      return;
    }
    const connected = new Set([fixedSel]);
    const details = [];
    linkObjs.forEach(l => {
      if(l.source.id===fixedSel || l.target.id===fixedSel){
        const other = l.source.id===fixedSel ? l.target : l.source;
        connected.add(other.id);
        details.push(`<li><b>${esc(other.label)}</b> — comparte: ${l.vars.slice(0,8).join(', ')}${l.vars.length>8?'…':''} (${l.weight})</li>`);
      }
    });
    node.attr('opacity', d => connected.has(d.id)?1:0.08);
    link.attr('opacity', l => (l.source.id===fixedSel||l.target.id===fixedSel) ? 0.85 : 0.03)
        .attr('stroke', l => (l.source.id===fixedSel||l.target.id===fixedSel) ? cssVar('--orange') : cssVar('--blue'));
    const d = dbById.get(fixedSel);
    info.innerHTML = `<b>${esc(d.nombre)}</b> comparte variables con ${details.length} base(s):<ul style="margin:6px 0 0; padding-left:18px">${details.join('')}</ul>`;
  }
  highlightVar();
}
document.getElementById('minshared').addEventListener('input', renderVarNetwork);
document.getElementById('hide-generic').addEventListener('change', renderVarNetwork);

// ============================================================
// PAGE 5 — ANALISIS DE VARIABLES
// ============================================================
function renderVarAnalysis(){
  const dbFilter = document.getElementById('var-db-filter');
  dbFilter.innerHTML = '<option value="">Todas las bases de datos</option>' +
    DB.slice().sort((a,b)=>a.nombre.localeCompare(b.nombre)).map(d=>`<option value="${esc(d.nombre)}">${esc(d.nombre)}</option>`).join('');

  function uniqueVarNames(dbName){
    const pool = dbName ? VARS.filter(v=>v.base_datos===dbName) : VARS;
    const names = [...new Set(pool.map(v=>v.nombre).filter(Boolean))].sort((a,b)=>a.localeCompare(b));
    return names;
  }
  const nameSel = document.getElementById('var-name-select');
  function refreshNames(){
    const names = uniqueVarNames(dbFilter.value);
    nameSel.innerHTML = names.map(n=>`<option value="${esc(n)}">${esc(n)}</option>`).join('');
    if(names.length) renderVarDetail(names[0]);
  }
  dbFilter.addEventListener('change', refreshNames);
  nameSel.addEventListener('change', () => renderVarDetail(nameSel.value));
  refreshNames();
  // default: pick a common, informative variable if present
  if([...nameSel.options].some(o=>o.value==='municipio')){ nameSel.value='municipio'; renderVarDetail('municipio'); }
}
function renderVarDetail(name){
  const rows = VARS.filter(v => v.nombre === name);
  if(!rows.length) return;
  const tipos = [...new Set(rows.map(r=>r.tipo))];
  const el = document.getElementById('var-detail');
  el.innerHTML = `
    <h3>${esc(name)}</h3>
    <p class="sub">Aparece en ${rows.length} base(s) de datos</p>
    <dl class="kv">
      <dt>Tipo</dt><dd>${tipos.map(esc).join(', ')}</dd>
      <dt>Descripción</dt><dd>${esc(rows[0].descripcion) || 'Varía según la base de datos (ver tabla)'}</dd>
      <dt>Rango / valores</dt><dd>${esc(rows[0].rango) || 'Varía según la base de datos (ver tabla)'}</dd>
      <dt>% faltante (primer caso)</dt><dd class="mono">${rows[0].pct_faltante ?? '—'}%</dd>
    </dl>`;
  document.getElementById('var-count-sub').textContent = `${rows.length} ocurrencia(s) de "${name}"`;
  document.querySelector('#tbl-var-occurrences tbody').innerHTML = rows.map(r => `
    <tr><td>${esc(r.base_datos)}</td><td>${esc(r.rango)||'—'}</td><td class="mono">${r.pct_faltante ?? '—'}%</td></tr>
  `).join('');
}

// ============================================================
// PAGE 6 — BUSCADOR
// ============================================================
function renderBuscador(){
  const tagSel = document.getElementById('search-tag');
  const allTags = TAGGRAPH.map(t=>t.tag).sort();
  tagSel.innerHTML = '<option value="">Todas</option>' + allTags.map(t=>`<option value="${esc(t)}">#${esc(t)}</option>`).join('');

  const yearSel = document.getElementById('search-year');
  const years = [...new Set(DB.map(d=>d.fecha_creacion).filter(Boolean).map(d=>d.slice(0,4)))].sort();
  yearSel.innerHTML = '<option value="">Todos</option>' + years.map(y=>`<option value="${y}">${y}</option>`).join('');

  const nameInput = document.getElementById('search-name');
  [nameInput, tagSel, yearSel].forEach(elm => elm.addEventListener('input', runSearch));
  runSearch();
}
function runSearch(){
  const q = document.getElementById('search-name').value.trim().toLowerCase();
  const tag = document.getElementById('search-tag').value;
  const year = document.getElementById('search-year').value;
  let res = DB.filter(d => {
    if(q && !(d.nombre.toLowerCase().includes(q) || (d.descripcion||'').toLowerCase().includes(q))) return false;
    if(tag && !(d.etiquetas||[]).map(t=>t.toLowerCase()).includes(tag)) return false;
    if(year && !(d.fecha_creacion||'').startsWith(year)) return false;
    return true;
  }).sort((a,b)=>(b.score_completitud||0)-(a.score_completitud||0));

  document.getElementById('search-count').textContent = `${res.length} resultado(s)`;
  const wrap = document.getElementById('search-results');
  if(!res.length){ wrap.innerHTML = '<p class="empty">Sin resultados con esos filtros.</p>'; return; }
  wrap.innerHTML = res.map(d => `
    <div class="search-card" data-id="${d.id}">
      <div class="col1">
        <h4><span class="score-dot" style="background:${d.vencida ? cssVar('--oxido') : cssVar('--good')}" title="${d.vencida?'Vencida':'Vigente'}"></span>${esc(d.nombre)}</h4>
        <p>${esc(d.descripcion) || 'Sin descripción.'}</p>
        <div class="meta">${esc(d.organizacion)||'—'} · creada ${fmtDate(d.fecha_creacion)} · ${(d.grupos||[]).join(', ')||'sin grupo'} · Score ${d.score_completitud ?? '—'}/100</div>
      </div>
    </div>`).join('');
  wrap.querySelectorAll('.search-card').forEach(el => el.addEventListener('click', () => jumpToDb(el.dataset.id)));
}

// ============================================================
// PAGE 7 — GEOSTATS E IDEAS DE PROYECTOS
// ============================================================
const GEOSTATS_PROTOTYPES = [
  {t:'Contaminación ZMM', d:'Monitoreo de contaminación en la Zona Metropolitana de Monterrey.'},
  {t:'Rastreo del Agua NL', d:'Seguimiento de la disponibilidad y uso del agua en el estado.'},
  {t:'Probabilidad de feminicidios', d:'Modelo de riesgo a partir de datos de seguridad y género.'},
  {t:'Red de Monitoreo de Calidad del Aire SPGG', d:'Calidad del aire en tiempo real por zona.'},
  {t:'Análisis predictivo de acceso a salud', d:'Predicción de acceso a servicios de salud por municipio.'},
  {t:'Propuesta de mejora de espacio público', d:'Identificación de oportunidades de mejora urbana.'},
];
const PROJECT_IDEAS = [
  {t:'Necesidad social × cobertura de infraestructura', d:'Cruzar Asistencia Social con Infraestructura — los dos grupos más grandes y mejor calificados del catálogo — para ubicar zonas con alta necesidad social y baja cobertura de servicios. Extiende el prototipo de mejora de espacio público.'},
  {t:'Tablero de acceso a servicios públicos', d:'Combinar Educación y Atención Ciudadana para mapear el acceso a servicios por municipio, en la línea del prototipo de acceso predictivo a salud.'},
  {t:'Monitor de vigencia de Movilidad y Transporte', d:'Este grupo tiene la peor tasa de actualización del catálogo. Un tablero que la vigile, combinado con datos de tránsito, extendería la Red de Monitoreo de Calidad del Aire.'},
  {t:'Participación deportiva', d:'Deportes tiene solo 4 bases pero con score perfecto y hoy es invisible en la navegación del portal. Son datos listos para un prototipo sobre uso de instalaciones deportivas públicas.'},
  {t:'Salud del catálogo', d:'Un tablero público que muestre qué bases de datos están vencidas y por cuánto tiempo, generando presión positiva sobre las dependencias publicadoras.'},
];
function renderGeostats(){
  document.getElementById('geostats-prototypes').innerHTML = GEOSTATS_PROTOTYPES.map(p => `
    <div class="card"><h3 style="font-size:13.5px">${esc(p.t)}</h3><p class="sub" style="margin:0">${esc(p.d)}</p></div>`).join('');

  const gs = groupStats();
  const byCount = gs.slice().sort((a,b)=>b.count-a.count);
  barRows(document.getElementById('chart-ideas-count'), byCount.map(g=>({label:g.grupo, value:g.count})), {color: cssVar('--blue')});

  const byScore = gs.slice().sort((a,b)=>b.avgScore-a.avgScore);
  barRows(document.getElementById('chart-ideas-score'), byScore.map(g=>({label:g.grupo, value:Math.round(g.avgScore*10)/10})), {
    color: d => scoreColor(d.value), max:100
  });

  document.getElementById('project-ideas').innerHTML = PROJECT_IDEAS.map(p => `
    <div class="card"><h3 style="font-size:13.5px">${esc(p.t)}</h3><p class="sub" style="margin:0">${esc(p.d)}</p></div>`).join('');
}

// ============================================================
// INIT
// ============================================================
window.addEventListener('resize', () => { renderTimeline(); if(document.getElementById('page-1').classList.contains('active')) renderTagNetwork(); if(document.getElementById('page-4').classList.contains('active')) renderVarNetwork(); });

renderPortada();
renderGeneralidades();
renderGrupos();
renderDbSelect();
renderVarAnalysis();
renderBuscador();
renderGeostats();

const initial = (location.hash.match(/^#p(\d)/) || [,'0'])[1];
showPage(initial);

// Exponer al scope global las funciones que el HTML llama con onclick="..."
window.showPage = showPage;
window.toggleTheme = toggleTheme;
}

// ============================================================
// CANDADO — pantalla de contraseña
// ============================================================
// El JSON de datos se cifró con CryptoJS (AES) antes de incrustarlo en el HTML,
// así que aunque alguien vea el código fuente no encuentra los datos en claro,
// solo el texto cifrado. Esta parte corre siempre (sin contraseña no hay DATA),
// pide la contraseña y, si es correcta, descifra y llama a startApp(DATA).
(function(){
  const encPayload = document.getElementById('data-payload').textContent.trim();
  const lockScreen = document.getElementById('lock-screen');
  const lockForm = document.getElementById('lock-form');
  const lockInput = document.getElementById('lock-password');
  const lockError = document.getElementById('lock-error');

  function tryUnlock(password){
    try{
      const bytes = CryptoJS.AES.decrypt(encPayload, password);
      const text = bytes.toString(CryptoJS.enc.Utf8);
      if(!text) return null;
      return JSON.parse(text);
    }catch(e){ return null; }
  }

  lockForm.addEventListener('submit', function(e){
    e.preventDefault();
    const data = tryUnlock(lockInput.value);
    if(data){
      document.body.classList.remove('locked');
      lockScreen.remove();
      startApp(data);
    }else{
      lockError.style.display = 'block';
      lockInput.value = '';
      lockInput.focus();
    }
  });

  lockInput.focus();
})();

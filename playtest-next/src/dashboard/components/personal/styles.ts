/**
 * Personal space look: always dark and cinematic, colored by the active scene's accent (--acc / --acc-rgb).
 * Everything is scoped under .ps-root. Motion is switched off for "reduce motion".
 */
export const PS_CSS = `
.ps-root{--bg:#05070c;--ink:#eef3ff;--dim:#93a1bd;--line:rgba(255,255,255,.08);--gold:#ffd166;--red:#ff6b81;--pink:#f472b6;
  position:relative;background:var(--bg);color:var(--ink);overflow:hidden;isolation:isolate}
.ps-root::before{content:'';position:absolute;inset:0;z-index:-1;pointer-events:none;
  background:radial-gradient(900px 600px at 85% 900px, rgba(var(--acc-rgb),.10), transparent 70%),radial-gradient(700px 500px at 0% 1400px, rgba(var(--acc-rgb),.07), transparent 70%)}
.ps-display{font-family:'Poppins','Roboto',system-ui,sans-serif;font-weight:800}

/* ---------- hero */
.ps-hero{position:relative;height:560px;overflow:hidden}
@media(min-width:768px){.ps-hero{height:620px}}
.ps-hero-img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;transform-origin:60% 40%;
  animation:ps-fade 1.1s ease-out both, ps-kenburns 28s ease-in-out 1.1s infinite alternate}
@keyframes ps-fade{from{opacity:0;transform:scale(1.06)}to{opacity:1;transform:scale(1)}}
@keyframes ps-kenburns{from{transform:scale(1)}to{transform:scale(1.08) translate(-1.2%,-1%)}}
.ps-mesh{position:absolute;inset:-25%;background:radial-gradient(circle at 68% 38%, rgba(var(--acc-rgb),.42), transparent 32%),
  radial-gradient(circle at 82% 70%, rgba(167,139,250,.30), transparent 36%),radial-gradient(circle at 30% 20%, rgba(var(--acc-rgb),.12), transparent 40%),#070b16;
  animation:ps-mesh 22s ease-in-out infinite alternate}
@keyframes ps-mesh{from{transform:rotate(0) scale(1)}to{transform:rotate(9deg) scale(1.12)}}
.ps-shade{position:absolute;inset:0;pointer-events:none;
  background:linear-gradient(0deg,var(--bg) 4%,rgba(5,7,12,.7) 40%,rgba(5,7,12,.08) 70%,rgba(5,7,12,.5) 100%),
  radial-gradient(ellipse at 10% 100%, rgba(var(--acc-rgb),.28), transparent 60%)}
@media(min-width:768px){.ps-shade{background:
  linear-gradient(90deg,rgba(5,7,12,.94) 0%,rgba(5,7,12,.62) 36%,rgba(5,7,12,.08) 68%,rgba(5,7,12,.3) 100%),
  linear-gradient(0deg,var(--bg) 0%,rgba(5,7,12,0) 42%),linear-gradient(180deg,rgba(5,7,12,.7) 0%,transparent 20%),
  radial-gradient(ellipse at 12% 100%, rgba(var(--acc-rgb),.26), transparent 55%)}}
.ps-grain{position:absolute;inset:0;pointer-events:none;opacity:.07;mix-blend-mode:overlay;
  background-image:repeating-linear-gradient(0deg,rgba(255,255,255,.5) 0 1px,transparent 1px 3px)}
.ps-spark{position:absolute;bottom:-12px;border-radius:50%;background:rgb(var(--acc-rgb));box-shadow:0 0 10px 2px rgba(var(--acc-rgb),.8);
  opacity:0;animation:ps-rise linear infinite;pointer-events:none}
@keyframes ps-rise{0%{transform:translate(0,0);opacity:0}12%{opacity:.95}80%{opacity:.6}100%{transform:translate(var(--drift),-660px);opacity:0}}

.ps-top{position:absolute;top:0;left:0;right:0;z-index:2;display:flex;align-items:center;gap:12px;padding:18px 16px}
@media(min-width:768px){.ps-top{padding:22px 40px}}
.ps-kicker{font-size:11px;letter-spacing:.32em;text-transform:uppercase;color:rgb(var(--acc-rgb));font-weight:700;display:flex;align-items:center;gap:8px;white-space:nowrap}
.ps-kicker i{width:7px;height:7px;transform:rotate(45deg);background:rgb(var(--acc-rgb));box-shadow:0 0 10px rgb(var(--acc-rgb))}
.ps-scenes{margin-left:auto;display:flex;align-items:center;gap:8px;overflow-x:auto;max-width:62vw;padding:4px;scrollbar-width:none}
.ps-scene{flex:none;width:44px;height:44px;border-radius:12px;overflow:hidden;border:1px solid rgba(255,255,255,.18);background:rgba(255,255,255,.06);
  display:grid;place-items:center;color:var(--ink);cursor:pointer;transition:transform .2s,border-color .2s,box-shadow .2s;backdrop-filter:blur(8px)}
@media(min-width:768px){.ps-scene{width:52px;height:52px}}
.ps-scene img{width:100%;height:100%;object-fit:cover}
.ps-scene:hover{transform:translateY(-2px);border-color:rgba(var(--acc-rgb),.7)}
.ps-scene.on{border:2px solid rgb(var(--acc-rgb));box-shadow:0 0 0 3px rgba(var(--acc-rgb),.25),0 0 18px rgba(var(--acc-rgb),.6)}
.ps-scene.add{border-style:dashed}
.ps-scene-name{font-size:11px;color:var(--dim);letter-spacing:.12em;text-transform:uppercase;white-space:nowrap;display:none}
@media(min-width:1024px){.ps-scene-name{display:block}}

.ps-copy{position:absolute;left:0;right:0;bottom:0;z-index:2;padding:0 16px 84px}
@media(min-width:768px){.ps-copy{padding:0 40px 96px;max-width:780px}}
.ps-levelrow{display:flex;align-items:flex-end;gap:18px;margin-top:14px}
.ps-level-label{font-size:12px;letter-spacing:.42em;color:var(--dim);font-weight:700}
.ps-level{font-size:clamp(84px,12vw,148px);line-height:.82;letter-spacing:-.02em;
  background:linear-gradient(180deg,#fff 35%,rgb(var(--acc-rgb)) 100%);-webkit-background-clip:text;background-clip:text;color:transparent;
  filter:drop-shadow(0 0 26px rgba(var(--acc-rgb),.45))}
.ps-rank{width:74px;height:84px;flex:none;display:grid;place-items:center;clip-path:polygon(50% 0,100% 25%,100% 75%,50% 100%,0 75%,0 25%);
  font-size:38px;color:#070b16;margin-bottom:6px}
@media(min-width:768px){.ps-rank{width:92px;height:104px;font-size:48px}}
.ps-xp{margin-top:18px;max-width:460px}
.ps-xp-track{height:6px;border-radius:999px;background:rgba(255,255,255,.1);overflow:hidden}
.ps-xp-fill{height:100%;border-radius:999px;background:linear-gradient(90deg,rgba(var(--acc-rgb),.6),rgb(var(--acc-rgb)),#fff);
  box-shadow:0 0 14px rgba(var(--acc-rgb),.9);transition:width 1.2s cubic-bezier(.2,.8,.2,1)}
.ps-xp-text{display:flex;justify-content:space-between;font-size:12px;color:var(--dim);margin-top:6px}
.ps-next{margin-top:14px;font-size:14px;color:var(--ink);display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.ps-next b{color:rgb(var(--acc-rgb));letter-spacing:.2em;font-size:11px}
.ps-next .d{font-family:'Poppins',system-ui;font-weight:800;color:var(--gold)}
.ps-actions{display:flex;gap:10px;flex-wrap:wrap;margin-top:20px}

/* buttons */
.ps-cta{display:inline-flex;align-items:center;gap:8px;height:42px;padding:0 20px;border-radius:999px;font-weight:700;font-size:14px;
  color:#05070c;background:rgb(var(--acc-rgb));box-shadow:0 8px 30px rgba(var(--acc-rgb),.45);transition:transform .2s,box-shadow .2s}
.ps-cta:hover{transform:translateY(-2px);box-shadow:0 12px 40px rgba(var(--acc-rgb),.65)}
.ps-seg{display:inline-flex;height:42px;padding:4px;border-radius:999px;background:rgba(255,255,255,.07);border:1px solid rgba(255,255,255,.12);backdrop-filter:blur(10px)}
.ps-seg button{display:inline-flex;align-items:center;gap:6px;padding:0 14px;border-radius:999px;font-size:13px;font-weight:600;color:var(--dim);transition:all .2s}
.ps-seg button.on{background:rgba(255,255,255,.12);color:var(--ink);box-shadow:inset 0 0 0 1px rgba(var(--acc-rgb),.5)}
.ps-btn{display:inline-flex;align-items:center;gap:6px;height:28px;padding:0 11px;border-radius:999px;font-size:12px;font-weight:600;
  color:var(--ink);background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.12);transition:all .15s}
.ps-btn:hover{border-color:rgba(var(--acc-rgb),.7);background:rgba(var(--acc-rgb),.12)}
.ps-btn.gold{color:var(--gold);border-color:rgba(255,209,102,.45)}
.ps-btn.gold:hover{background:rgba(255,209,102,.14);border-color:var(--gold)}
.ps-btn.icon{width:28px;padding:0;justify-content:center;color:var(--dim)}

.ps-drop{position:absolute;inset:14px;z-index:5;border:2px dashed rgb(var(--acc-rgb));border-radius:20px;display:grid;place-items:center;
  background:rgba(5,7,12,.7);font-size:18px;font-weight:700;letter-spacing:.06em;backdrop-filter:blur(4px)}
.ps-empty-art{position:absolute;right:40px;top:50%;transform:translateY(-50%);z-index:2;width:300px;padding:26px;border-radius:20px;text-align:center;
  border:1.5px dashed rgba(var(--acc-rgb),.6);background:rgba(5,7,12,.45);backdrop-filter:blur(8px);cursor:pointer;display:none;transition:border-color .2s}
.ps-empty-art:hover{border-color:rgb(var(--acc-rgb))}
@media(min-width:1024px){.ps-empty-art{display:block}}

/* stats strip */
.ps-stats{position:relative;z-index:3;margin-top:-56px;padding:0 16px;display:grid;grid-template-columns:repeat(2,1fr);gap:12px}
@media(min-width:768px){.ps-stats{padding:0 40px;grid-template-columns:repeat(4,1fr);gap:16px}}
.ps-stat{padding:16px 18px;border-radius:18px;background:rgba(14,18,30,.66);border:1px solid var(--line);backdrop-filter:blur(14px);
  box-shadow:0 20px 50px rgba(0,0,0,.35)}
.ps-stat .k{font-size:11px;letter-spacing:.22em;text-transform:uppercase;color:var(--dim)}
.ps-stat .v{font-size:34px;line-height:1.1;margin-top:4px}
.ps-stat .h{font-size:12px;color:var(--dim)}

/* ---------- chronicle */
.ps-section{position:relative;padding:72px 16px 40px;text-align:center}
@media(min-width:768px){.ps-section{padding:96px 40px 48px}}
.ps-watermark{position:absolute;left:50%;top:34px;transform:translateX(-50%);white-space:nowrap;pointer-events:none;
  font-size:clamp(64px,15vw,200px);line-height:1;color:transparent;-webkit-text-stroke:1px rgba(255,255,255,.07);letter-spacing:.06em}
.ps-eyebrow{position:relative;display:inline-flex;align-items:center;gap:8px;font-size:12px;letter-spacing:.32em;text-transform:uppercase;color:rgb(var(--acc-rgb));font-weight:700}
.ps-h2{position:relative;font-size:clamp(26px,4vw,44px);line-height:1.15;margin-top:10px}
.ps-h2 span{background:linear-gradient(90deg,rgb(var(--acc-rgb)),#fff);-webkit-background-clip:text;background-clip:text;color:transparent}
.ps-sub{position:relative;color:var(--dim);max-width:560px;margin:10px auto 0;font-size:14px}
.ps-filters{position:relative;display:flex;flex-wrap:wrap;justify-content:center;gap:8px;margin-top:24px}
.ps-filter{display:inline-flex;align-items:center;gap:6px;height:34px;padding:0 14px;border-radius:999px;font-size:13px;color:var(--dim);
  background:rgba(255,255,255,.04);border:1px solid var(--line);transition:all .2s}
.ps-filter:hover{color:var(--ink);border-color:rgba(255,255,255,.2)}
.ps-filter.on{color:var(--ink);border-color:rgba(var(--acc-rgb),.7);background:rgba(var(--acc-rgb),.14);box-shadow:0 0 18px rgba(var(--acc-rgb),.25)}
.ps-filter small{opacity:.7}

.ps-count{display:flex;gap:14px;overflow-x:auto;padding:4px 16px 8px;scroll-snap-type:x mandatory;scrollbar-width:thin}
@media(min-width:768px){.ps-count{padding:4px 40px 8px;justify-content:center;flex-wrap:wrap;overflow:visible}}
.ps-countcard{flex:none;scroll-snap-align:start;min-width:200px;text-align:left;padding:16px 18px;border-radius:18px;cursor:pointer;
  background:linear-gradient(160deg,rgba(244,114,182,.16),rgba(14,18,30,.7));border:1px solid rgba(244,114,182,.35);transition:transform .2s}
.ps-countcard:hover{transform:translateY(-3px)}
.ps-countcard .d{font-size:36px;line-height:1;background:linear-gradient(90deg,#f9a8d4,#fff);-webkit-background-clip:text;background-clip:text;color:transparent}

.ps-line{position:relative;padding:28px 16px 24px;max-width:1180px;margin:0 auto}
@media(min-width:768px){.ps-line{padding:36px 40px 24px}}
.ps-row{display:grid;grid-template-columns:36px minmax(0,1fr);column-gap:14px}
.ps-axis{grid-column:1;grid-row:1;position:relative;display:flex;justify-content:center;align-items:flex-start}
.ps-axis::before{content:'';position:absolute;top:0;bottom:0;left:50%;width:2px;transform:translateX(-50%);
  background:linear-gradient(rgba(var(--acc-rgb),.95),rgba(var(--acc-rgb),.55));box-shadow:0 0 12px rgba(var(--acc-rgb),.55)}
.ps-row.future .ps-axis::before{background:repeating-linear-gradient(to bottom,rgba(var(--acc-rgb),.5) 0 7px,transparent 7px 14px);box-shadow:none}
.ps-row.first .ps-axis::before{top:28px}
.ps-row.last .ps-axis::before{bottom:auto;height:30px}
.ps-body{grid-column:2;grid-row:1;position:relative;padding-bottom:30px;min-width:0}
.ps-body::before{content:'';position:absolute;top:30px;left:-14px;width:14px;height:1px;background:rgba(var(--acc-rgb),.6)}
.ps-row.mark .ps-body::before{display:none}
@media(min-width:768px){
  .ps-row{grid-template-columns:minmax(0,1fr) 72px minmax(0,1fr);column-gap:0}
  .ps-axis{grid-column:2}
  .ps-row.l .ps-body{grid-column:1;padding-right:30px}
  .ps-row.r .ps-body{grid-column:3;padding-left:30px}
  .ps-row.l .ps-body::before{left:auto;right:0;width:30px;background:linear-gradient(90deg,transparent,rgba(var(--acc-rgb),.7))}
  .ps-row.r .ps-body::before{left:0;width:30px;background:linear-gradient(90deg,rgba(var(--acc-rgb),.7),transparent)}
  .ps-row.mark .ps-body{grid-column:1 / -1;text-align:center;z-index:1}
  /* Year / Someday labels are chapter breaks: the line pauses there. */
  .ps-row.mark:not(.now) .ps-axis::before{opacity:0}
}

.ps-node{position:relative;z-index:1;margin-top:21px;width:18px;height:18px;border-radius:50%;display:grid;place-items:center;
  background:var(--bg);border:2px solid rgba(var(--acc-rgb),.8)}
.ps-node.achieved{transform:rotate(45deg);border-radius:4px;background:var(--gold);border-color:#fff3c4;box-shadow:0 0 16px rgba(255,209,102,.85)}
.ps-node.in_progress{background:rgb(var(--acc-rgb));border-color:#fff}
.ps-node.in_progress::after{content:'';position:absolute;inset:-6px;border-radius:50%;border:2px solid rgb(var(--acc-rgb));animation:ps-ping 1.8s ease-out infinite}
.ps-node.event{border-color:var(--pink);box-shadow:0 0 12px rgba(244,114,182,.6)}
.ps-node.late{border-color:var(--red);box-shadow:0 0 12px rgba(255,107,129,.6)}
.ps-node.dropped{border-color:#4b5563;background:#1f2937}
@keyframes ps-ping{0%{transform:scale(.6);opacity:1}100%{transform:scale(1.9);opacity:0}}

.ps-mark{display:inline-block;padding:6px 18px;font-size:clamp(40px,6vw,76px);line-height:1;letter-spacing:.06em;
  color:transparent;-webkit-text-stroke:1.2px rgba(var(--acc-rgb),.75)}
.ps-mark.small{font-size:clamp(22px,3vw,30px);letter-spacing:.3em;-webkit-text-stroke:0;color:var(--dim)}
.ps-axis .ps-tick{margin-top:22px;width:10px;height:10px;border-radius:50%;background:rgba(var(--acc-rgb),.6);position:relative;z-index:1}
@media(min-width:768px){.ps-row.mark .ps-axis .ps-tick{display:none}}

.ps-now{position:relative;display:inline-flex;align-items:center;gap:12px;padding:10px 22px;border-radius:999px;
  background:linear-gradient(90deg,rgba(var(--acc-rgb),.22),rgba(var(--acc-rgb),.08)),var(--bg);border:1px solid rgba(var(--acc-rgb),.75);
  box-shadow:0 0 30px rgba(var(--acc-rgb),.35),inset 0 0 20px rgba(var(--acc-rgb),.15)}
.ps-now b{font-size:14px;letter-spacing:.45em;font-weight:800}
.ps-now span{font-size:12px;color:var(--dim)}
.ps-now::before{content:'';position:absolute;inset:-7px;border-radius:999px;border:1px solid rgba(var(--acc-rgb),.45);animation:ps-breath 2.6s ease-in-out infinite}
@keyframes ps-breath{0%,100%{opacity:.2;transform:scale(.98)}50%{opacity:1;transform:scale(1.02)}}
.ps-row.now .ps-body{padding-top:8px;padding-bottom:40px}

.ps-card{position:relative;text-align:left;padding:18px 20px;border-radius:20px;background:linear-gradient(160deg,rgba(255,255,255,.055),rgba(255,255,255,.02));
  border:1px solid var(--line);backdrop-filter:blur(14px);transition:transform .25s,border-color .25s,box-shadow .25s;overflow:hidden}
.ps-card::before{content:'';position:absolute;left:0;right:0;top:0;height:2px;background:linear-gradient(90deg,var(--cat),transparent)}
.ps-card:hover{transform:translateY(-4px);border-color:rgba(var(--acc-rgb),.45);box-shadow:0 18px 50px rgba(0,0,0,.45),0 0 0 1px rgba(var(--acc-rgb),.15)}
.ps-card.achieved{background:linear-gradient(160deg,rgba(255,209,102,.09),rgba(255,255,255,.02));border-color:rgba(255,209,102,.28)}
.ps-card.achieved::before{background:linear-gradient(90deg,var(--gold),transparent)}
.ps-card.in_progress{border-color:rgba(var(--acc-rgb),.6);box-shadow:0 0 30px rgba(var(--acc-rgb),.18);animation:ps-glow 3s ease-in-out infinite}
@keyframes ps-glow{0%,100%{box-shadow:0 0 18px rgba(var(--acc-rgb),.12)}50%{box-shadow:0 0 36px rgba(var(--acc-rgb),.32)}}
.ps-card.late{border-color:rgba(255,107,129,.5)}
.ps-card.dropped{opacity:.5}
.ps-card.dropped .ps-title{text-decoration:line-through}
.ps-card-top{display:flex;justify-content:space-between;gap:10px;align-items:flex-start}
.ps-date{font-size:20px;line-height:1.1;letter-spacing:.02em}
.ps-date small{font-size:12px;color:var(--dim);font-weight:500;margin-left:6px;letter-spacing:.1em}
.ps-when{font-size:12px;color:var(--dim);margin-top:2px}
.ps-when.late{color:var(--red)}
.ps-when.gold{color:var(--gold);font-weight:700;letter-spacing:.14em;text-transform:uppercase;font-size:11px}
.ps-when.live{color:rgb(var(--acc-rgb));font-weight:700;letter-spacing:.14em;text-transform:uppercase;font-size:11px}
.ps-chip{flex:none;display:inline-flex;align-items:center;gap:6px;height:26px;padding:0 10px;border-radius:999px;font-size:12px;font-weight:600;
  color:var(--cat);background:color-mix(in srgb,var(--cat) 14%,transparent);border:1px solid color-mix(in srgb,var(--cat) 40%,transparent)}
.ps-title{font-size:17px;font-weight:700;margin-top:12px;cursor:pointer;line-height:1.3}
.ps-title:hover{color:rgb(var(--acc-rgb))}
.ps-desc{font-size:13px;color:var(--dim);margin-top:6px;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}
.ps-foot{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:14px}
.ps-xpchip{font-size:12px;font-weight:700;color:var(--gold)}
.ps-foot .acts{margin-left:auto;display:flex;gap:6px}

.ps-reveal{opacity:0;transform:translate(var(--dx,0),28px);transition:opacity .7s ease,transform .7s cubic-bezier(.2,.8,.2,1)}
.ps-reveal.in{opacity:1;transform:none}

.ps-endcap{text-align:center;padding:24px 16px 80px}
.ps-endcap p{color:var(--dim);font-size:14px;margin-bottom:14px}

@media (prefers-reduced-motion: reduce){
  .ps-hero-img,.ps-mesh,.ps-node.in_progress::after,.ps-now::before,.ps-card.in_progress{animation:none}
  .ps-spark{display:none}
  .ps-reveal{opacity:1;transform:none;transition:none}
}
`;

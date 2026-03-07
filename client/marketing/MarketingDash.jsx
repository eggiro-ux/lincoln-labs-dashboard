import { useState, useCallback, useEffect } from "react";
import { ComposedChart, Bar, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Cell } from "recharts";

const C = {
  bg:"#0f0f0e", surface:"#191917", border:"#2a2a27",
  text:"#e8e6e0", muted:"#7a7870", positive:"#4ade80",
  negative:"#f87171", tooltip:"#111110",
  paid:"#22c55e", organic:"#3b82f6", partner:"#a855f7",
  referral:"#f97316", prospecting:"#eab308",
  social:"#06b6d4", tradeshow:"#e879f9",
};
const MONO  = { fontFamily:"'DM Mono', monospace" };
const SERIF = { fontFamily:"'Fraunces', serif" };

// ── Breakpoints ───────────────────────────────────────────────────────────────
// Mobile: ≤430 (iPhone 17 Pro = 393px logical)
// Tablet: 431–1024 (iPad Pro 13" = 1024px)
// Desktop: 1025+
function useBreakpoint() {
  const [bp, setBp] = useState(() => {
    const w = typeof window !== "undefined" ? window.innerWidth : 1200;
    return w <= 430 ? "mobile" : w <= 1024 ? "tablet" : "desktop";
  });
  useEffect(() => {
    const fn = () => {
      const w = window.innerWidth;
      setBp(w <= 430 ? "mobile" : w <= 1024 ? "tablet" : "desktop");
    };
    window.addEventListener("resize", fn);
    return () => window.removeEventListener("resize", fn);
  }, []);
  return bp;
}

// ── Helpers ───────────────────────────────────────────────────────────────────
const fmt  = n => n != null ? Number(n).toLocaleString() : "—";
const fmtK = n => n >= 1000 ? `${(n/1000).toFixed(1)}k` : `${n}`;
function buildChartData(view, leadSeries) {
  const { months, mql2025, sql2025, mql2026, sql2026 } = leadSeries;
  const cmb2025 = mql2025.map((v,i)=>v+(sql2025[i]||0));
  const cmb2026 = mql2026.map((v,i)=>v!=null?v+(sql2026[i]||0):null);
  const goal2026 = cmb2025.map(v=>Math.max(Math.round(v*1.35),10));
  const a25 = view==="mql"?mql2025:view==="sql"?sql2025:cmb2025;
  const a26 = view==="mql"?mql2026:view==="sql"?sql2026:cmb2026;
  const g26 = view==="mql"?mql2025.map(v=>Math.round(v*1.35)):view==="sql"?sql2025.map(v=>Math.round(v*1.35)):goal2026;
  return months.map((month,i)=>({ month, "2025 Actuals":a25[i]??0, "2026 Actuals":a26[i], "2026 Goal":g26[i] }));
}
// Win rate → background tint (dark → brighter as rate rises, grayscale)
function wrBg(wr) {
  if (wr == null) return "transparent";
  if (wr >= 65) return "#252523";
  if (wr >= 55) return "#1e1e1c";
  if (wr >= 45) return "#181816";
  return "transparent";
}
// Win rate → text brightness
function wrTextColor(wr) {
  if (wr == null) return "#555";
  if (wr >= 65) return C.text;
  if (wr >= 55) return C.muted;
  return "#5a5a56";
}

// ── Primitives ────────────────────────────────────────────────────────────────
function Tab({label,active,onClick,small}) {
  return (
    <div onClick={onClick} style={{
      ...MONO, cursor:"pointer", userSelect:"none",
      padding: small ? "10px 14px" : "10px 24px",
      fontSize: small ? "0.62rem" : "0.72rem",
      letterSpacing:"0.06em", textTransform:"uppercase",
      color:active?C.text:C.muted,
      borderBottom:`2px solid ${active?C.text:"transparent"}`,
      marginBottom:-1, transition:"color 0.15s",
      whiteSpace:"nowrap",
    }}>{label}</div>
  );
}
function SegToggle({options,value,onChange,small,wrap}) {
  return (
    <div style={{display:"flex",flexWrap:wrap?"wrap":"nowrap"}}>
      {options.map(([v,l],i)=>(
        <button key={v} onClick={()=>onChange(v)} style={{
          ...MONO, background:C.surface,
          border:`1px solid ${value===v?C.muted:C.border}`,
          borderRight: (!wrap && i<options.length-1 && value!==v) ? "none" : `1px solid ${value===v?C.muted:C.border}`,
          color:value===v?C.text:C.muted,
          fontSize:small?"0.65rem":"0.68rem",
          padding:small?"5px 10px":"6px 14px",
          cursor:"pointer", letterSpacing:"0.06em", textTransform:"uppercase",
          transition:"color 0.15s, border-color 0.15s",
          marginBottom: wrap ? 1 : 0,
        }}>{l}</button>
      ))}
    </div>
  );
}
function ChartTooltip({active,payload,label}) {
  if(!active||!payload?.length) return null;
  return (
    <div style={{background:C.tooltip,border:`1px solid ${C.border}`,padding:"12px 16px",minWidth:200}}>
      <div style={{...MONO,fontSize:"0.7rem",color:C.muted,letterSpacing:"0.08em",textTransform:"uppercase",marginBottom:10,paddingBottom:8,borderBottom:`1px solid ${C.border}`}}>{label}</div>
      {payload.filter(p=>p.value!=null).map((p,i)=>(
        <div key={i} style={{display:"flex",justifyContent:"space-between",gap:16,padding:"3px 0"}}>
          <span style={{...MONO,fontSize:"0.72rem",color:C.muted,display:"flex",alignItems:"center",gap:6}}>
            <span style={{width:7,height:7,borderRadius:"50%",background:p.color,display:"inline-block",flexShrink:0}}/>{p.name}
          </span>
          <span style={{...MONO,fontSize:"0.75rem",color:C.text}}>{fmt(p.value)}</span>
        </div>
      ))}
    </div>
  );
}
function AlertBar({type="info",children}) {
  const s=type==="warn"?{bg:"#2a1515",border:"#5a2020",color:"#f87171"}:{bg:"#0f1a12",border:"#1a3320",color:C.muted};
  return <div style={{background:s.bg,border:`1px solid ${s.border}`,padding:"10px 14px",...MONO,fontSize:"0.72rem",color:s.color,display:"flex",gap:10,alignItems:"flex-start",lineHeight:1.6}}>{children}</div>;
}

// ── Source card ───────────────────────────────────────────────────────────────
function SourceCard({s, maxVal}) {
  const wr = s.won+s.lost>0 ? Math.round((s.won/(s.won+s.lost))*100) : null;
  const bars=[
    {label:"MQL",   val:s.mqls,  fill:"#4a4a46"},
    {label:"SQL",   val:s.sqls,  fill:"#4a4a46"},
    {label:"Deals", val:s.deals, fill:"#7a7870"},
  ];
  return (
    <div style={{background:C.surface,padding:"20px 20px",borderTop:`2px solid ${s.color}`}}>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:18}}>
        <div style={{display:"flex",alignItems:"center",gap:7}}>
          <span style={{width:7,height:7,borderRadius:"50%",background:s.color,flexShrink:0,display:"inline-block"}}/>
          <span style={{...MONO,fontSize:"0.74rem",color:s.color}}>{s.name}</span>
        </div>
        <div style={{textAlign:"right"}}>
          <div style={{...SERIF,fontWeight:600,fontSize:"1.3rem",letterSpacing:"-0.02em",color:C.text,lineHeight:1}}>
            {fmt(s.deals)}<span style={{...MONO,fontWeight:400,fontSize:"0.56rem",color:C.muted,marginLeft:3}}>deals</span>
          </div>
          <div style={{...MONO,fontSize:"0.62rem",color:C.muted,marginTop:2}}>{fmtK(s.revenue)}</div>
        </div>
      </div>
      <div style={{display:"flex",flexDirection:"column",gap:10,marginBottom:18}}>
        {bars.map((bar,j)=>(
          <div key={j}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"baseline",marginBottom:4}}>
              <span style={{...MONO,fontSize:"0.58rem",color:C.muted,textTransform:"uppercase",letterSpacing:"0.08em"}}>{bar.label}</span>
              <span style={{...MONO,fontSize:"0.64rem",color:bar.val>0?C.text:"#444"}}>{fmt(bar.val)}</span>
            </div>
            <div style={{background:C.border,height:4}}>
              <div style={{width:`${maxVal>0?Math.max((bar.val/maxVal)*100,bar.val>0?1.5:0):0}%`,background:bar.val>0?bar.fill:"#2a2a27",height:"100%",transition:"width 0.4s ease"}}/>
            </div>
          </div>
        ))}
      </div>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",paddingTop:12,borderTop:`1px solid ${C.border}`,marginBottom:12}}>
        <div>
          <div style={{...MONO,fontSize:"0.56rem",color:C.muted,textTransform:"uppercase",letterSpacing:"0.08em",marginBottom:3}}>Avg deal</div>
          <div style={{...SERIF,fontWeight:600,fontSize:"0.95rem",color:s.deals>0?C.text:"#555"}}>{s.deals>0?`${Math.round(s.revenue/s.deals).toLocaleString()}`:"—"}</div>
        </div>
        {wr!==null&&(
          <div style={{textAlign:"right"}}>
            <div style={{...MONO,fontSize:"0.56rem",color:C.muted,textTransform:"uppercase",letterSpacing:"0.08em",marginBottom:3}}>Win rate</div>
            <div style={{...SERIF,fontWeight:600,fontSize:"0.95rem",color:wrTextColor(wr)}}>{wr}%</div>
            <div style={{...MONO,fontSize:"0.54rem",color:"#444",marginTop:2}}>{s.won}W · {s.lost}L</div>
          </div>
        )}
      </div>
      <div style={{...MONO,fontSize:"0.58rem",color:"#555",marginBottom:8}}><span style={{color:"#444"}}>Sources: </span>{s.sources}</div>
      <div style={{...MONO,fontSize:"0.62rem",color:C.muted,lineHeight:1.7,borderTop:`1px solid ${C.border}`,paddingTop:9}}>{s.note}</div>
    </div>
  );
}


// ── LTV channel card ──────────────────────────────────────────────────────────
function LtvCard({d, rank}) {
  const scoreColor = d.score>=80?C.positive:d.score>=70?"#a3e635":d.score>=60?C.text:C.muted;
  const dimBars = [
    { label:"Win rate",         val:d.s_wr,   raw:`${d.win_rate}%`,                    color:C.referral },
    { label:"Avg deal size",    val:d.s_deal, raw:`${d.avg_deal.toLocaleString()}`,   color:C.organic },
    { label:"Relationship age", val:d.s_ret,  raw:`${d.avg_days} days`,               color:C.social, provisional:true },
    { label:"Deal volume",      val:d.s_vol,  raw:`${d.deals} deals`,                 color:C.muted },
  ];
  return (
    <div style={{background:C.surface,padding:"26px 28px",borderLeft:`3px solid ${d.color}`,position:"relative"}}>
      <div style={{position:"absolute",top:18,right:20,...MONO,fontSize:"0.56rem",color:C.muted,letterSpacing:"0.1em",textTransform:"uppercase"}}>#{rank}</div>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:18,paddingRight:28}}>
        <div style={{display:"flex",alignItems:"center",gap:9,flexWrap:"wrap"}}>
          <span style={{width:8,height:8,borderRadius:"50%",background:d.color,flexShrink:0,display:"inline-block"}}/>
          <span style={{...MONO,fontSize:"0.85rem",color:C.text}}>{d.name}</span>
          {!d.active_flag&&<span style={{...MONO,fontSize:"0.56rem",letterSpacing:"0.08em",textTransform:"uppercase",color:C.muted,background:C.border,padding:"2px 6px"}}>inactive 2026</span>}
        </div>
        <div style={{textAlign:"right",flexShrink:0}}>
          <div style={{...SERIF,fontWeight:600,fontSize:"1.45rem",letterSpacing:"-0.03em",lineHeight:1,color:scoreColor}}>{d.score}</div>
          <div style={{...MONO,fontSize:"0.56rem",color:C.muted,marginTop:3}}>channel score</div>
        </div>
      </div>
      <div style={{display:"flex",flexDirection:"column",gap:9,marginBottom:20}}>
        {dimBars.map((bar,i)=>(
          <div key={i} style={{opacity:bar.provisional?0.38:1}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"baseline",marginBottom:4}}>
              <span style={{...MONO,fontSize:"0.58rem",color:C.muted,textTransform:"uppercase",letterSpacing:"0.08em",display:"flex",alignItems:"baseline",gap:4}}>
                {bar.label}
                {bar.provisional&&<span style={{fontSize:"0.5rem",letterSpacing:"0.04em",textTransform:"none",color:"#4a4a46"}}>(pending)</span>}
              </span>
              <span style={{...MONO,fontSize:"0.66rem",color:bar.color}}>{bar.raw}</span>
            </div>
            <div style={{background:C.border,height:4}}>
              <div style={{width:`${bar.val}%`,background:bar.color,height:"100%",transition:"width 0.5s ease",opacity:0.85}}/>
            </div>
          </div>
        ))}
      </div>
      <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:7,marginBottom:18}}>
        {[["2024",d.y2024],["2025",d.y2025],["2026 YTD",d.y2026]].map(([yr,val])=>(
          <div key={yr} style={{background:C.bg,padding:"9px 11px"}}>
            <div style={{...MONO,fontSize:"0.54rem",color:C.muted,textTransform:"uppercase",letterSpacing:"0.08em",marginBottom:3}}>{yr}</div>
            <div style={{...SERIF,fontWeight:600,fontSize:"1.0rem",color:C.text,lineHeight:1}}>{val}</div>
            <div style={{...MONO,fontSize:"0.54rem",color:C.muted,marginTop:2}}>deals</div>
          </div>
        ))}
      </div>
      {d.warning&&(
        <div style={{...MONO,fontSize:"0.6rem",color:C.negative,background:"#2a1515",border:"1px solid #5a2020",padding:"6px 11px",marginBottom:12,lineHeight:1.5}}>⚠ {d.warning}</div>
      )}
      <div style={{...MONO,fontSize:"0.64rem",color:C.muted,lineHeight:1.75,borderTop:`1px solid ${C.border}`,paddingTop:13}}>{d.verdict}</div>
    </div>
  );
}


// ── Mini vertical bar chart: solid current, dashed outline prior ──────────────
// Single shared tooltip per chart pair, labels below chart area (not overlapping)
function MiniBarChart({curVal, cmpVal, curLabel, cmpLabel, metricLabel}) {
  const [showTip, setShowTip] = useState(false);
  const max   = Math.max(curVal, cmpVal, 1);
  const delta = curVal - cmpVal;
  const up    = delta >= 0;
  const dClr  = delta === 0 ? C.muted : up ? C.positive : C.negative;

  const CHART_H = 130; // bar drawing area height
  const LABEL_H = 36;  // reserved below bars for x-axis labels — never overlaps
  const BAR_W   = 44;
  const GAP     = 16;
  const AXIS_W  = 28;

  const curH = Math.max((curVal / max) * CHART_H, curVal > 0 ? 5 : 0);
  const cmpH = Math.max((cmpVal / max) * CHART_H, cmpVal > 0 ? 5 : 0);
  const ticks = [...new Set([0, Math.round(max * 0.5), max])];

  return (
    <div style={{position:"relative", userSelect:"none"}}
      onMouseEnter={()=>setShowTip(true)} onMouseLeave={()=>setShowTip(false)}>

      {/* Tooltip — left-anchored, sizes to content, never clips */}
      {showTip && (
        <div style={{
          position:"absolute",
          bottom: LABEL_H + CHART_H + 8,
          left: 0,
          background:C.tooltip, border:`1px solid ${C.border}`,
          padding:"14px 16px", zIndex:30, minWidth:220, pointerEvents:"none",
          boxShadow:"0 4px 20px rgba(0,0,0,0.5)", whiteSpace:"nowrap",
        }}>
          {/* Header */}
          <div style={{...MONO,fontSize:"0.6rem",color:C.muted,letterSpacing:"0.1em",
            textTransform:"uppercase",marginBottom:10,paddingBottom:8,
            borderBottom:`1px solid ${C.border}`}}>
            {metricLabel}
          </div>
          {/* Current */}
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",gap:24,marginBottom:6}}>
            <span style={{display:"flex",alignItems:"center",gap:7,...MONO,fontSize:"0.68rem",color:C.text}}>
              <span style={{width:8,height:8,background:C.text,display:"inline-block",flexShrink:0}}/>
              {curLabel}
            </span>
            <span style={{...MONO,fontSize:"0.72rem",color:C.text}}>{curVal}</span>
          </div>
          {/* Prior */}
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",gap:24,marginBottom:10}}>
            <span style={{display:"flex",alignItems:"center",gap:7,...MONO,fontSize:"0.68rem",color:C.muted}}>
              <span style={{width:8,height:8,border:`1.5px dashed ${C.muted}`,display:"inline-block",flexShrink:0}}/>
              {cmpLabel}
            </span>
            <span style={{...MONO,fontSize:"0.72rem",color:C.muted}}>{cmpVal}</span>
          </div>
          {/* Delta */}
          <div style={{borderTop:`1px solid ${C.border}`,paddingTop:8,
            display:"flex",justifyContent:"space-between",alignItems:"center"}}>
            <span style={{...MONO,fontSize:"0.68rem",color:C.muted}}>Delta</span>
            <span style={{...MONO,fontSize:"0.75rem",color:dClr}}>
              {delta >= 0 ? "+" : ""}{delta}
            </span>
          </div>
        </div>
      )}

      {/* Chart area: CHART_H tall + LABEL_H below */}
      <div style={{position:"relative", height:CHART_H + LABEL_H}}>

        {/* Y-axis gridlines + labels */}
        {ticks.map(t => {
          const y = CHART_H - (t / max) * CHART_H;
          return (
            <div key={t} style={{position:"absolute",left:0,right:0,top:y,
              display:"flex",alignItems:"center",pointerEvents:"none"}}>
              <span style={{...MONO,fontSize:"0.52rem",color:C.muted,width:AXIS_W,
                textAlign:"right",paddingRight:6,flexShrink:0,lineHeight:1}}>
                {t}
              </span>
              <div style={{flex:1,borderTop:`1px solid ${C.border}`,opacity:t===0?1:0.35}}/>
            </div>
          );
        })}

        {/* Bars — sit in CHART_H zone, anchored to bottom of that zone */}
        <div style={{position:"absolute",left:AXIS_W,top:0,height:CHART_H,
          display:"flex",alignItems:"flex-end",gap:GAP}}>

          {/* Current bar — solid white */}
          <div style={{width:BAR_W,height:"100%",display:"flex",flexDirection:"column",
            alignItems:"center",justifyContent:"flex-end",position:"relative"}}>
            {/* Delta label above bar */}
            {(curVal > 0 || cmpVal > 0) && delta !== 0 && (
              <div style={{...MONO,fontSize:"0.58rem",color:dClr,
                marginBottom:4,whiteSpace:"nowrap",lineHeight:1}}>
                {delta > 0 ? "+" : ""}{delta}
              </div>
            )}
            <div style={{width:"100%",height:curH,background:C.text,
              transition:"height 0.45s ease",flexShrink:0}}/>
          </div>

          {/* Prior bar — dashed outline */}
          <div style={{width:BAR_W,height:"100%",display:"flex",flexDirection:"column",
            alignItems:"center",justifyContent:"flex-end"}}>
            <div style={{width:"100%",height:cmpH,background:"transparent",
              border:`1.5px dashed ${C.muted}`,boxSizing:"border-box",
              transition:"height 0.45s ease",flexShrink:0}}/>
          </div>
        </div>

        {/* X-axis labels — sit in LABEL_H zone, always below bars */}
        <div style={{position:"absolute",left:AXIS_W,top:CHART_H,height:LABEL_H,
          display:"flex",gap:GAP,alignItems:"flex-start",paddingTop:6}}>
          {[[curLabel, C.text],[cmpLabel, C.muted]].map(([l, clr], i) => (
            <div key={i} style={{width:BAR_W,textAlign:"center",
              ...MONO,fontSize:"0.52rem",color:clr,lineHeight:1.3}}>
              {l}
            </div>
          ))}
        </div>

      </div>
    </div>
  );
}

// ── Split MQL/SQL mini bar chart ─────────────────────────────────────────────
function SplitLeadChart({curMql, cmpMql, curSql, cmpSql, curLabel, cmpLabel}) {
  const [showTip, setShowTip] = useState(false);
  const CHART_H = 130;
  const LABEL_H = 36;
  const BAR_W   = 32;
  const GAP_IN  = 5;
  const GAP_OUT = 18;
  const AXIS_W  = 28;

  const max = Math.max(curMql, cmpMql, curSql, cmpSql, 1);
  const ticks = [...new Set([0, Math.round(max * 0.5), max])];

  const mqlH    = Math.max((curMql / max) * CHART_H, curMql > 0 ? 5 : 0);
  const mqlCmpH = Math.max((cmpMql / max) * CHART_H, cmpMql > 0 ? 5 : 0);
  const sqlH    = Math.max((curSql / max) * CHART_H, curSql > 0 ? 5 : 0);
  const sqlCmpH = Math.max((cmpSql / max) * CHART_H, cmpSql > 0 ? 5 : 0);

  const mqlDelta = curMql - cmpMql;
  const sqlDelta = curSql - cmpSql;
  const mqlDClr  = mqlDelta === 0 ? C.muted : mqlDelta > 0 ? C.positive : C.negative;
  const sqlDClr  = sqlDelta === 0 ? C.muted : sqlDelta > 0 ? C.positive : C.negative;

  return (
    <div style={{position:"relative", userSelect:"none"}}
      onMouseEnter={()=>setShowTip(true)} onMouseLeave={()=>setShowTip(false)}>

      {showTip && (
        <div style={{
          position:"absolute", bottom: LABEL_H + CHART_H + 8,
          left: 0,
          background:C.tooltip, border:`1px solid ${C.border}`,
          padding:"14px 16px", zIndex:30, minWidth:260, pointerEvents:"none",
          boxShadow:"0 4px 20px rgba(0,0,0,0.5)", whiteSpace:"nowrap",
        }}>
          {/* Header */}
          <div style={{...MONO,fontSize:"0.6rem",color:C.muted,letterSpacing:"0.1em",textTransform:"uppercase",marginBottom:10,paddingBottom:8,borderBottom:`1px solid ${C.border}`}}>
            Lead Generation
          </div>
          {/* Column headers: label col + MQL + SQL */}
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:6,gap:16}}>
            <span style={{...MONO,fontSize:"0.56rem",color:"transparent",userSelect:"none"}}>——</span>
            <div style={{display:"flex",gap:20}}>
              <span style={{...MONO,fontSize:"0.58rem",color:C.muted,width:32,textAlign:"right",letterSpacing:"0.06em"}}>MQL</span>
              <span style={{...MONO,fontSize:"0.58rem",color:C.muted,width:32,textAlign:"right",letterSpacing:"0.06em"}}>SQL</span>
            </div>
          </div>
          {/* Current row */}
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",gap:16,marginBottom:5}}>
            <span style={{display:"flex",alignItems:"center",gap:7,...MONO,fontSize:"0.68rem",color:C.text}}>
              <span style={{width:8,height:8,background:C.text,display:"inline-block",flexShrink:0}}/>
              {curLabel}
            </span>
            <div style={{display:"flex",gap:20}}>
              <span style={{...MONO,fontSize:"0.72rem",color:C.text,width:32,textAlign:"right"}}>{curMql}</span>
              <span style={{...MONO,fontSize:"0.72rem",color:C.text,width:32,textAlign:"right"}}>{curSql}</span>
            </div>
          </div>
          {/* Prior row */}
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",gap:16,marginBottom:10}}>
            <span style={{display:"flex",alignItems:"center",gap:7,...MONO,fontSize:"0.68rem",color:C.muted}}>
              <span style={{width:8,height:8,border:`1.5px dashed ${C.muted}`,display:"inline-block",flexShrink:0}}/>
              {cmpLabel}
            </span>
            <div style={{display:"flex",gap:20}}>
              <span style={{...MONO,fontSize:"0.72rem",color:C.muted,width:32,textAlign:"right"}}>{cmpMql}</span>
              <span style={{...MONO,fontSize:"0.72rem",color:C.muted,width:32,textAlign:"right"}}>{cmpSql}</span>
            </div>
          </div>
          {/* Delta row */}
          <div style={{borderTop:`1px solid ${C.border}`,paddingTop:8,display:"flex",justifyContent:"space-between",alignItems:"center",gap:16}}>
            <span style={{...MONO,fontSize:"0.68rem",color:C.muted}}>Delta</span>
            <div style={{display:"flex",gap:20}}>
              <span style={{...MONO,fontSize:"0.75rem",color:mqlDClr,width:32,textAlign:"right"}}>{mqlDelta>=0?"+":""}{mqlDelta}</span>
              <span style={{...MONO,fontSize:"0.75rem",color:sqlDClr,width:32,textAlign:"right"}}>{sqlDelta>=0?"+":""}{sqlDelta}</span>
            </div>
          </div>
        </div>
      )}

      <div style={{position:"relative", height:CHART_H + LABEL_H}}>
        {/* Y-axis gridlines */}
        {ticks.map(t => {
          const y = CHART_H - (t / max) * CHART_H;
          return (
            <div key={t} style={{position:"absolute",left:0,right:0,top:y,display:"flex",alignItems:"center",pointerEvents:"none"}}>
              <span style={{...MONO,fontSize:"0.52rem",color:C.muted,width:AXIS_W,textAlign:"right",paddingRight:6,flexShrink:0,lineHeight:1}}>{t}</span>
              <div style={{flex:1,borderTop:`1px solid ${C.border}`,opacity:t===0?1:0.35}}/>
            </div>
          );
        })}

        {/* Grouped bars */}
        <div style={{position:"absolute",left:AXIS_W,top:0,height:CHART_H,display:"flex",alignItems:"flex-end"}}>
          {/* MQL group */}
          <div style={{display:"flex",alignItems:"flex-end",gap:GAP_IN}}>
            <div style={{width:BAR_W,height:CHART_H,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"flex-end"}}>
              {mqlDelta !== 0 && <div style={{...MONO,fontSize:"0.54rem",color:mqlDClr,marginBottom:4,whiteSpace:"nowrap",lineHeight:1}}>{mqlDelta>0?"+":""}{mqlDelta}</div>}
              <div style={{width:"100%",height:mqlH,background:C.text,transition:"height 0.45s ease",flexShrink:0}}/>
            </div>
            <div style={{width:BAR_W,height:CHART_H,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"flex-end"}}>
              <div style={{width:"100%",height:mqlCmpH,background:"transparent",border:`1.5px dashed ${C.muted}`,boxSizing:"border-box",transition:"height 0.45s ease",flexShrink:0}}/>
            </div>
          </div>
          <div style={{width:GAP_OUT}}/>
          {/* SQL group */}
          <div style={{display:"flex",alignItems:"flex-end",gap:GAP_IN}}>
            <div style={{width:BAR_W,height:CHART_H,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"flex-end"}}>
              {sqlDelta !== 0 && <div style={{...MONO,fontSize:"0.54rem",color:sqlDClr,marginBottom:4,whiteSpace:"nowrap",lineHeight:1}}>{sqlDelta>0?"+":""}{sqlDelta}</div>}
              <div style={{width:"100%",height:sqlH,background:C.text,transition:"height 0.45s ease",flexShrink:0}}/>
            </div>
            <div style={{width:BAR_W,height:CHART_H,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"flex-end"}}>
              <div style={{width:"100%",height:sqlCmpH,background:"transparent",border:`1.5px dashed ${C.muted}`,boxSizing:"border-box",transition:"height 0.45s ease",flexShrink:0}}/>
            </div>
          </div>
        </div>

        {/* X-axis group labels */}
        <div style={{position:"absolute",left:AXIS_W,top:CHART_H,height:LABEL_H,display:"flex",alignItems:"flex-start",paddingTop:6}}>
          <div style={{width:BAR_W+GAP_IN+BAR_W,textAlign:"center",...MONO,fontSize:"0.52rem",color:C.muted}}>MQL</div>
          <div style={{width:GAP_OUT}}/>
          <div style={{width:BAR_W+GAP_IN+BAR_W,textAlign:"center",...MONO,fontSize:"0.52rem",color:C.muted}}>SQL</div>
        </div>
      </div>
    </div>
  );
}

function PeriodCompareCard({title, current, compare, currentLabel, compareLabel, note}) {
  const curLeads = (current.mqls ?? 0) + (current.sqls ?? 0);
  const cmpLeads = (compare.mqls ?? 0) + (compare.sqls ?? 0);
  const leadDelta = curLeads - cmpLeads;
  const up = leadDelta >= 0;

  return (
    // height:100% so sibling cards in the same grid row stretch to match each other
    <div style={{background:C.surface, padding:"22px 24px", display:"flex", flexDirection:"column", height:"100%", boxSizing:"border-box"}}>

      {/* Period header */}
      <div style={{marginBottom:20, paddingBottom:16, borderBottom:`1px solid ${C.border}`, flexShrink:0}}>
        <div style={{...MONO,fontSize:"0.56rem",color:C.muted,letterSpacing:"0.1em",textTransform:"uppercase",marginBottom:10}}>{title}</div>
        <div style={{display:"flex",alignItems:"baseline",gap:10,flexWrap:"wrap"}}>
          <span style={{...SERIF,fontWeight:600,fontSize:"1.05rem",color:C.text,letterSpacing:"-0.01em"}}>{currentLabel}</span>
          <span style={{...MONO,fontSize:"0.6rem",color:C.muted}}>vs</span>
          <span style={{...MONO,fontSize:"0.78rem",color:C.muted}}>{compareLabel}</span>
          <span style={{...MONO,fontSize:"0.64rem",
            color:up?C.positive:leadDelta<0?C.negative:C.muted,
            background:up?"#0f2a14":leadDelta<0?"#2a1515":C.bg,
            border:`1px solid ${up?"#1a4a24":leadDelta<0?"#5a2020":C.border}`,
            padding:"1px 8px",marginLeft:4}}>
            {leadDelta>0?"+":""}{leadDelta} leads {leadDelta>0?"↑":leadDelta<0?"↓":"→"}
          </span>
        </div>
      </div>

      {/* Charts — flex-grow so they fill remaining space equally regardless of note */}
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:20,flexGrow:1}}>
        <div>
          <div style={{...MONO,fontSize:"0.58rem",color:C.muted,textTransform:"uppercase",letterSpacing:"0.08em",marginBottom:10}}>
            Lead Generation <span style={{color:"#444",fontSize:"0.52rem"}}>MQL · SQL</span>
          </div>
          <SplitLeadChart
            curMql={current.mqls ?? 0}
            cmpMql={compare.mqls ?? 0}
            curSql={current.sqls ?? 0}
            cmpSql={compare.sqls ?? 0}
            curLabel={currentLabel}
            cmpLabel={compareLabel}
          />
        </div>
        <div>
          <div style={{...MONO,fontSize:"0.58rem",color:C.muted,textTransform:"uppercase",letterSpacing:"0.08em",marginBottom:10}}>
            Deals Closed
          </div>
          <MiniBarChart
            curVal={current.deals ?? 0}
            cmpVal={compare.deals ?? 0}
            curLabel={currentLabel}
            cmpLabel={compareLabel}
            metricLabel="Deals Closed"
          />
        </div>
      </div>

      {/* Note — always at bottom, separated by a border, same position in every card */}
      <div style={{flexShrink:0, marginTop:16, paddingTop:12, borderTop:`1px solid ${C.border}`, minHeight:40}}>
        {note
          ? <div style={{...MONO,fontSize:"0.58rem",color:"#555",lineHeight:1.6}}>⚠ {note}</div>
          : <div style={{height:"0.58rem"}}/>  /* phantom spacer so border sits at same Y */
        }
      </div>
    </div>
  );
}

function InsightChip({label, value, sub, trend}) {
  const trendColor = trend==="up" ? C.positive : trend==="down" ? C.negative : C.muted;
  const trendIcon  = trend==="up" ? "↑" : trend==="down" ? "↓" : "→";
  return (
    <div style={{background:C.surface,padding:"16px 18px",borderLeft:`2px solid ${trendColor}`}}>
      <div style={{...MONO,fontSize:"0.58rem",color:C.muted,textTransform:"uppercase",letterSpacing:"0.08em",marginBottom:6}}>{label}</div>
      <div style={{...SERIF,fontWeight:600,fontSize:"1.25rem",letterSpacing:"-0.02em",color:C.text,lineHeight:1,marginBottom:5}}>
        {value}
        <span style={{...MONO,fontWeight:400,fontSize:"0.65rem",color:trendColor,marginLeft:7}}>{trendIcon}</span>
      </div>
      <div style={{...MONO,fontSize:"0.6rem",color:C.muted,lineHeight:1.5}}>{sub}</div>
    </div>
  );
}

function CurrentPeriodTab({isMobile, isTablet, cp, insights}) {
  const cols2 = isMobile ? 1 : 2;
  const cols4 = isMobile ? 1 : isTablet ? 2 : 4;
  const { monthToDate, quarters } = cp;
  const now = new Date();
  const day = now.getDate();
  const monthName = now.toLocaleDateString("en-US", { month: "long" });
  const year = now.getFullYear();
  const daysInMonth = new Date(year, now.getMonth() + 1, 0).getDate();
  const daySubtitle = `${monthName} 1–${day}, ${year} · day ${day} of ${daysInMonth}`;

  return (<>
    {/* Section 1: Month to date */}
    <div style={{marginBottom:8}}>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"baseline",marginBottom:16,flexWrap:"wrap",gap:8}}>
        <div>
          <p style={{...MONO,fontSize:"0.68rem",letterSpacing:"0.08em",textTransform:"uppercase",color:C.muted,marginBottom:3}}>Month to date</p>
          <p style={{...MONO,fontSize:"0.62rem",color:"#555"}}>{daySubtitle}</p>
        </div>
      </div>
      <div style={{display:"grid",gridTemplateColumns:`repeat(${cols2},1fr)`,gap:1,background:C.border,marginBottom:28,alignItems:"stretch"}}>
        <PeriodCompareCard
          title="This month vs last month (same days)"
          current={monthToDate.current}
          compare={monthToDate.lastMonth}
          currentLabel={monthToDate.current.label}
          compareLabel={monthToDate.lastMonth.label}
          note={null}
        />
        <PeriodCompareCard
          title="This month vs last year same month"
          current={monthToDate.current}
          compare={monthToDate.lastYear}
          currentLabel={`${monthToDate.current.label}, ${year}`}
          compareLabel={monthToDate.lastYear.label}
          note="March 2025 near-zero — HubSpot MQL tracking configured April 2025. Deal count more reliable than MQL for this comparison."
        />
      </div>
    </div>

    {/* Section 2: Quarter comparisons */}
    <div style={{marginBottom:8}}>
      <div style={{marginBottom:16}}>
        <p style={{...MONO,fontSize:"0.68rem",letterSpacing:"0.08em",textTransform:"uppercase",color:C.muted,marginBottom:3}}>Quarter performance</p>
        <p style={{...MONO,fontSize:"0.62rem",color:"#555"}}>Q1 2026 YTD vs prior periods</p>
      </div>
      <div style={{display:"grid",gridTemplateColumns:`repeat(${cols2},1fr)`,gap:1,background:C.border,marginBottom:28,alignItems:"stretch"}}>
        <PeriodCompareCard
          title="This quarter vs last quarter"
          current={quarters.q1_26_ytd}
          compare={quarters.q4_25}
          currentLabel={`${quarters.q1_26_ytd.label} (${quarters.q1_26_ytd.sublabel})`}
          compareLabel={`${quarters.q4_25.label} (${quarters.q4_25.sublabel})`}
          note="Q1 YTD vs Q4 full — Q1 still in progress. MQL + SQL combined for both quarters."
        />
        <PeriodCompareCard
          title="This quarter vs last year same quarter"
          current={quarters.q1_26_ytd}
          compare={quarters.q1_25}
          currentLabel={`${quarters.q1_26_ytd.label} (${quarters.q1_26_ytd.sublabel})`}
          compareLabel={`${quarters.q1_25.label} (${quarters.q1_25.sublabel})`}
          note="Q1 2025 MQL count near-zero due to tracking gap (HubSpot configured April 2025). Revenue and deals are reliable comparisons."
        />
      </div>
    </div>

    {/* Section 3: Insight chips */}
    <div style={{marginBottom:16}}>
      <p style={{...MONO,fontSize:"0.68rem",letterSpacing:"0.08em",textTransform:"uppercase",color:C.muted,marginBottom:3}}>Key metrics</p>
      <p style={{...MONO,fontSize:"0.62rem",color:"#555",marginBottom:16}}>Notable signals and trends across the full dataset</p>
      <div style={{display:"grid",gridTemplateColumns:`repeat(${cols4},1fr)`,gap:1,background:C.border}}>
        {insights.map((d,i)=><InsightChip key={i} {...d}/>)}
      </div>
    </div>

    <AlertBar type="info">
      <span style={{flexShrink:0}}>→</span>
      <span>
        <strong style={{color:C.text}}>Lead pace:</strong> Q1 YTD combined MQL + SQL puts 2026 on track to exceed 2025's full-year volume.{" "}
        <strong style={{color:C.text}}>Signal:</strong> Feb 2026 was the highest single MQL month ever. March is early, but Organic intent quality remains high.
      </span>
    </AlertBar>
  </>);
}

// ── Main ──────────────────────────────────────────────────────────────────────
const EMPTY_CP = {
  monthToDate: {
    current:   { label:'', mqls:0, sqls:0, deals:0, revenue:0 },
    lastMonth: { label:'', mqls:0, sqls:0, deals:0, revenue:0 },
    lastYear:  { label:'', mqls:0, sqls:0, deals:0, revenue:0 },
  },
  quarters: {
    q1_26_ytd: { label:'Q1 2026 YTD', sublabel:'', mqls:0, sqls:0, deals:0, revenue:0 },
    q4_25:     { label:'Q4 2025',     sublabel:'', mqls:0, sqls:0, deals:0, revenue:0 },
    q1_25:     { label:'Q1 2025',     sublabel:'', mqls:0, sqls:0, deals:0, revenue:0 },
  },
};

export default function Dashboard() {
  const bp = useBreakpoint();
  const isMobile  = bp === "mobile";
  const isTablet  = bp === "tablet";
  const isDesktop = bp === "desktop";

  const [tab,         setTab]         = useState("trend");
  const [view,        setView]        = useState("combined");
  const [srcPeriod,   setSrcPeriod]   = useState("y2026");
  const [ltvSort,     setLtvSort]     = useState("score");
  const [refreshing,  setRefreshing]  = useState(false);
  const [lastRefresh, setLastRefresh] = useState("—");
  const [data,        setData]        = useState(null);
  const [loading,     setLoading]     = useState(true);
  const [error,       setError]       = useState(null);

  const fetchData = useCallback(async () => {
    try {
      const res = await fetch('/api/marketing-summary');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      setData(json);
      setLastRefresh(new Date(json.lastRefresh).toLocaleDateString("en-US",{month:"short",day:"numeric",year:"numeric"}));
      setError(null);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchData(); }, [fetchData]);

  const handleRefresh = useCallback(()=>{
    setRefreshing(true);
    fetchData().finally(()=>setRefreshing(false));
  },[fetchData]);

  const leadSeries = data?.leadSeries ?? { months:[], mql2025:[], sql2025:[], mql2026:[], sql2026:[] };
  const sourceData = data?.sourceData ?? { alltime:[], y2025:[], y2026:[] };
  const ltvData    = data?.ltvData    ?? [];
  const cp         = data?.currentPeriod ?? EMPTY_CP;
  const insights   = data?.insights   ?? [];

  const chartData = buildChartData(view, leadSeries);

  const sources=sourceData[srcPeriod]??[];
  const maxVal=Math.max(...sources.map(s=>Math.max(s.mqls,s.sqls,s.deals)),1);
  const srcLabel={alltime:"All time",y2025:"2025",y2026:"2026 YTD"};

  const maxWr      = Math.max(...ltvData.map(d=>d.win_rate), 1);
  const maxAvgDeal = Math.max(...ltvData.map(d=>d.avg_deal), 1);
  const maxAvgDays = Math.max(...ltvData.map(d=>d.avg_days), 1);
  const maxDeals   = Math.max(...ltvData.map(d=>d.deals),    1);

  const ltvSorted=[...ltvData].sort((a,b)=>{
    if(ltvSort==="score")   return b.score-a.score;
    if(ltvSort==="revenue") return b.rev-a.rev;
    if(ltvSort==="winrate") return b.win_rate-a.win_rate;
    return b.avg_days-a.avg_days;
  });

  if (loading && !data) return <div style={{...MONO,color:C.muted,padding:40,textAlign:"center"}}>Loading HubSpot data…</div>;
  if (error && !data)   return <div style={{...MONO,color:C.negative,padding:40,textAlign:"center"}}>Error: {error}</div>;

  // Responsive layout values
  const pad   = isMobile ? "20px 16px" : isTablet ? "28px 28px" : "40px 48px";
  const tabSmall = isMobile || isTablet;

  // Column counts for grids
  const srcCardCols  = isMobile ? 1 : isTablet ? 2 : 4;
  const ltvCardCols  = isMobile ? 1 : 2;
  const verdictCols  = isMobile ? 1 : isTablet ? 1 : 3;

  return (
    <div style={{background:C.bg,minHeight:"100vh",color:C.text,...MONO,padding:pad,fontSize:"0.82rem",lineHeight:1.5}}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=DM+Mono:wght@400;500&family=Fraunces:ital,wght@0,300;0,600;1,300&display=swap');
        *{box-sizing:border-box;margin:0;padding:0;}button{cursor:pointer;}
        @keyframes spin{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}
        .tab-scroll{display:flex;overflow-x:auto;-webkit-overflow-scrolling:touch;scrollbar-width:none;}
        .tab-scroll::-webkit-scrollbar{display:none;}
        .src-table{display:grid;gap:1px;background:#2a2a27;overflow-x:auto;}
        .ltv-matrix{display:grid;gap:1px;background:#1a3020;overflow-x:auto;}
      `}</style>

      {/* ── HEADER ─────────────────────────────────────────────────────────── */}
      <header style={{display:"flex",justifyContent:"space-between",alignItems:"flex-end",marginBottom:isMobile?20:32,paddingBottom:isMobile?16:24,borderBottom:`1px solid ${C.border}`,flexWrap:"wrap",gap:12}}>
        <div>
          <h1 style={{...SERIF,fontWeight:300,fontSize:isMobile?"1.7rem":"2.4rem",letterSpacing:"-0.02em",lineHeight:1}}>
            Civille <em style={{color:C.muted}}>Marketing</em>
          </h1>
          <p style={{...MONO,fontSize:"0.66rem",letterSpacing:"0.08em",textTransform:"uppercase",color:C.muted,marginTop:5}}>
            Channel Performance · Lead Generation · Revenue & Lifetime Value
          </p>
        </div>
        <div style={{display:"flex",flexDirection:"column",alignItems:"flex-end",gap:8}}>
          <button onClick={handleRefresh} disabled={refreshing} style={{...MONO,background:"transparent",border:`1px solid ${C.border}`,color:refreshing?C.muted:C.text,fontSize:"0.66rem",padding:"6px 12px",letterSpacing:"0.06em",textTransform:"uppercase",cursor:refreshing?"default":"pointer",display:"flex",alignItems:"center",gap:6,transition:"border-color 0.15s, color 0.15s"}}>
            <span style={{display:"inline-block",animation:refreshing?"spin 1s linear infinite":"none"}}>↻</span>
            {refreshing?"Refreshing…":"Refresh Data"}
          </button>
          <span style={{...MONO,fontSize:"0.64rem",color:C.muted}}>HubSpot CRM · {lastRefresh}</span>
        </div>
      </header>

      {/* ── TAB BAR — horizontally scrollable on mobile ─────────────────────── */}
      <div className="tab-scroll" style={{marginBottom:isMobile?18:24,borderBottom:`1px solid ${C.border}`}}>
        <Tab label="Monthly Trend"       active={tab==="trend"}  onClick={()=>setTab("trend")}  small={tabSmall}/>
        <Tab label="Current Period"       active={tab==="yoy"}    onClick={()=>setTab("yoy")}    small={tabSmall}/>
        <Tab label="Source Intelligence" active={tab==="source"} onClick={()=>setTab("source")} small={tabSmall}/>
        <Tab label="Lifetime Value"      active={tab==="ltv"}    onClick={()=>setTab("ltv")}    small={tabSmall}/>
      </div>

      {/* ── MONTHLY TREND ──────────────────────────────────────────────────── */}
      {tab==="trend"&&(<>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",flexWrap:"wrap",gap:10,marginBottom:14}}>
          <div style={{display:"flex",gap:isMobile?12:20,flexWrap:"wrap",alignItems:"center"}}>
            {[{c:C.paid,l:"2025 Actuals"},{c:C.organic,l:"2026 Actuals"}].map(({c,l})=>(
              <div key={l} style={{display:"flex",alignItems:"center",gap:7,...MONO,fontSize:"0.68rem",color:C.muted}}>
                <span style={{width:9,height:9,borderRadius:"50%",background:c,display:"inline-block"}}/>{l}
              </div>
            ))}
            <div style={{display:"flex",alignItems:"center",gap:7,...MONO,fontSize:"0.68rem",color:C.muted}}>
              <span style={{display:"inline-block",width:16,borderTop:"2px dashed #f97316",opacity:.85}}/>2026 Goal
            </div>
          </div>
          <SegToggle options={[["combined","MQL + SQL"],["mql","MQL"],["sql","SQL"]]} value={view} onChange={setView} small/>
        </div>
        <div style={{background:C.surface,border:`1px solid ${C.border}`,padding:isMobile?"16px 12px 12px":"28px 28px 16px",marginBottom:6}}>
          <p style={{...MONO,fontSize:"0.68rem",letterSpacing:"0.06em",textTransform:"uppercase",color:C.muted,marginBottom:16}}>
            Monthly {view==="mql"?"MQLs":view==="sql"?"SQLs":"MQL + SQL"} — 2025 vs 2026 vs goal
          </p>
          <ResponsiveContainer width="100%" height={isMobile?220:300}>
            <ComposedChart data={chartData} margin={{top:8,right:8,left:0,bottom:0}}>
              <CartesianGrid strokeDasharray="3 3" stroke={C.border} vertical={false}/>
              <XAxis dataKey="month" tick={{fill:C.muted,fontSize:isMobile?8:10,fontFamily:"DM Mono,monospace"}} axisLine={false} tickLine={false}/>
              <YAxis tick={{fill:C.muted,fontSize:isMobile?8:10,fontFamily:"DM Mono,monospace"}} axisLine={false} tickLine={false} width={32}/>
              <Tooltip content={<ChartTooltip/>}/>
              <Bar dataKey="2025 Actuals" fill={C.paid} fillOpacity={0.25} barSize={isMobile?6:10}/>
              <Bar dataKey="2026 Actuals" fill={C.organic} barSize={isMobile?6:10}/>
              <Line type="monotone" dataKey="2026 Goal" stroke="#f97316" strokeWidth={1.5} dot={false} strokeDasharray="5 3"/>
            </ComposedChart>
          </ResponsiveContainer>
        </div>
        <div style={{background:C.surface,border:`1px solid ${C.border}`,borderTop:"none",padding:"10px 16px",marginBottom:10}}>
          <span style={{...MONO,fontSize:"0.63rem",color:C.muted,lineHeight:1.75,display:"block"}}>
            <span style={{color:"#555",letterSpacing:"0.06em",textTransform:"uppercase",fontSize:"0.58rem",marginRight:8}}>Note</span>
            2026 Goal = 2025 actuals × 1.35. 2025 baseline excludes trade show and referral leads not consistently entered in HubSpot. Goal will recalibrate as historical data normalizes.
          </span>
        </div>
        <div style={{display:"flex",flexDirection:"column",gap:4}}>
          <AlertBar type="warn"><span style={{flexShrink:0}}>⚠</span><span><strong style={{color:"#f87171"}}>MQL tracking gap:</strong> Jan–Mar 2025 near-zero reflects HubSpot configuration date, not actual lead volume. Reliable YoY starts April 2026.</span></AlertBar>
          <AlertBar type="info"><span style={{flexShrink:0}}>→</span><span><strong style={{color:C.text}}>Jan '26 SQL (5):</strong> Highest single month on record. LeadEngine AI / cold calling ramp. Feb (4) continuing at pace.</span></AlertBar>
        </div>
      </>)}

      {/* ── CURRENT PERIOD ─────────────────────────────────────────────────── */}
      {tab==="yoy"&&(<CurrentPeriodTab isMobile={isMobile} isTablet={isTablet} cp={cp} insights={insights}/>)}

      {/* ── SOURCE INTELLIGENCE ────────────────────────────────────────────── */}
      {tab==="source"&&(<>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:24,flexWrap:"wrap",gap:10}}>
          <div>
            <p style={{...MONO,fontSize:"0.68rem",letterSpacing:"0.06em",textTransform:"uppercase",color:C.muted,marginBottom:3}}>Source intelligence · <span style={{color:C.text}}>{srcLabel[srcPeriod]}</span></p>
            <p style={{...MONO,fontSize:"0.65rem",color:"#555"}}>Grouped by <span style={{color:C.muted}}>parent_lead_channel</span> · matches HubSpot Deal Performance</p>
          </div>
          <SegToggle options={[["alltime","All Time"],["y2025","2025"],["y2026","2026 YTD"]]} value={srcPeriod} onChange={setSrcPeriod} small wrap={isMobile}/>
        </div>

        {/* Channel summary table — scrollable on mobile */}
        <div style={{background:C.surface,border:`1px solid ${C.border}`,padding:"18px 18px",marginBottom:12,overflowX:"auto"}}>
          <div style={{...MONO,fontSize:"0.6rem",letterSpacing:"0.1em",textTransform:"uppercase",color:C.muted,marginBottom:10}}>Channel summary · {srcLabel[srcPeriod]}</div>
          <div style={{...MONO,fontSize:"0.6rem",color:"#555",marginBottom:14,lineHeight:1.7,borderBottom:`1px solid ${C.border}`,paddingBottom:12}}>
            <strong style={{color:"#666"}}>MQL</strong> = marketing leads &nbsp;·&nbsp; <strong style={{color:"#666"}}>SQL</strong> = sales-generated leads &nbsp;·&nbsp; parallel tracks, not sequential<br/>
            <strong style={{color:"#666"}}>Win rate</strong> = Won ÷ (Won + Lost) · period-matched · Referral/Tradeshows may show 0 MQLs — these enter HubSpot as direct deals
          </div>
          <div style={{minWidth:580}}>
            <div style={{display:"grid",gridTemplateColumns:"1.5fr repeat(7,1fr)",gap:1,background:C.border}}>
              {[{h:"Channel",sub:null},{h:"MQL",sub:"mktg leads"},{h:"SQL",sub:"sales leads"},{h:"Won",sub:"closed-won"},{h:"Lost",sub:"closed-lost"},{h:"Win Rate",sub:"won÷(won+lost)"},{h:"Revenue",sub:"from won"},{h:"Avg Deal",sub:"rev÷won"}].map(({h,sub},i)=>(
                <div key={i} style={{background:C.bg,padding:"9px 9px"}}>
                  <div style={{...MONO,fontSize:"0.58rem",color:C.muted,letterSpacing:"0.08em",textTransform:"uppercase"}}>{h}</div>
                  {sub&&<div style={{...MONO,fontSize:"0.52rem",color:"#444",marginTop:2}}>{sub}</div>}
                </div>
              ))}
              {[...sources].sort((a,b)=>b.won-a.won).map((s,i)=>{
                const wr = s.won+s.lost>0 ? Math.round((s.won/(s.won+s.lost))*100) : null;
                const dim="#444";
                return [
                  <div key={`n${i}`} style={{background:C.surface,padding:"11px 9px",...MONO,fontSize:"0.68rem",color:C.text,display:"flex",alignItems:"center",gap:6}}>
                    <span style={{width:5,height:5,borderRadius:"50%",background:s.color,flexShrink:0,display:"inline-block"}}/>
                    <span style={{color:s.color}}>{s.name}</span>
                  </div>,
                  <div key={`m${i}`} style={{background:C.surface,padding:"11px 9px",...SERIF,fontWeight:600,fontSize:"0.85rem",color:s.mqls>0?C.text:dim}}>{fmt(s.mqls)}</div>,
                  <div key={`sq${i}`} style={{background:C.surface,padding:"11px 9px",...SERIF,fontWeight:600,fontSize:"0.85rem",color:s.sqls>0?C.text:dim}}>{fmt(s.sqls)}</div>,
                  <div key={`w${i}`} style={{background:C.surface,padding:"11px 9px",...SERIF,fontWeight:600,fontSize:"0.85rem",color:s.won>0?C.text:dim}}>{fmt(s.won)}</div>,
                  <div key={`l${i}`} style={{background:C.surface,padding:"11px 9px",...SERIF,fontWeight:600,fontSize:"0.85rem",color:s.lost>0?C.muted:dim}}>{fmt(s.lost)}</div>,
                  // Win rate cell — graduated background tint
                  <div key={`wr${i}`} style={{background:wrBg(wr),padding:"11px 9px",display:"flex",flexDirection:"column",gap:3}}>
                    <span style={{...SERIF,fontWeight:600,fontSize:"0.85rem",color:wrTextColor(wr)}}>{wr!=null?`${wr}%`:"—"}</span>
                    {wr!=null&&<span style={{...MONO,fontSize:"0.52rem",color:"#555"}}>{s.won}W · {s.lost}L</span>}
                  </div>,
                  <div key={`r${i}`} style={{background:C.surface,padding:"11px 9px",...MONO,fontSize:"0.68rem",color:s.revenue>0?C.text:dim}}>{s.revenue>0?fmtK(s.revenue):"—"}</div>,
                  <div key={`a${i}`} style={{background:C.surface,padding:"11px 9px",...MONO,fontSize:"0.68rem",color:s.won>0?C.muted:dim}}>{s.won>0?`${Math.round(s.revenue/s.won).toLocaleString()}`:"—"}</div>,
                ];
              })}
            </div>
          </div>
        </div>

        {/* Revenue Insight */}
        <div style={{background:C.surface,border:`1px solid ${C.border}`,padding:"18px 20px",marginBottom:32}}>
          <div style={{...MONO,fontSize:"0.6rem",letterSpacing:"0.1em",textTransform:"uppercase",color:C.positive,marginBottom:9}}>→ Revenue Insight</div>
          <div style={{...MONO,fontSize:"0.74rem",color:C.muted,lineHeight:1.8}}>
            <strong style={{color:C.text}}>Partnerships</strong> leads in deal volume at $1,392 avg. Partner distribution — Grow Law Firm, Clio, Smokeball — is the most consistent pipeline.{" "}
            <strong style={{color:C.text}}>Organic</strong> produced the largest single deal YTD: Just Criminal Law Group at $5,996 (closed 2/27).{" "}
            <strong style={{color:C.text}}>Referral</strong> has the highest win rate and above-avg deal size.{" "}
            Win rate = won ÷ (won + lost), period-matched to the selected range, with both figures in the table above.
          </div>
        </div>

        {/* Full funnel cards */}
        <div style={{marginBottom:14}}>
          <p style={{...MONO,fontSize:"0.68rem",letterSpacing:"0.06em",textTransform:"uppercase",color:C.muted,marginBottom:5}}>Full funnel by channel · {srcLabel[srcPeriod]}</p>
          <div style={{...MONO,fontSize:"0.63rem",color:"#555",marginBottom:16}}>MQL · SQL · Deals · bars scale relative to largest value across channels</div>
        </div>
        <div style={{display:"grid",gridTemplateColumns:`repeat(${srcCardCols},1fr)`,gap:1,background:C.border}}>
          {sources.map((s,i)=><SourceCard key={i} s={s} maxVal={maxVal}/>)}
        </div>
      </>)}

      {/* ── LIFETIME VALUE ─────────────────────────────────────────────────── */}
      {tab==="ltv"&&(<>

        {/* ① Ranking matrix */}
        <div style={{background:"#0b120d",border:`1px solid #1a3020`,padding:isMobile?"16px 16px":"24px 28px",marginBottom:24,overflowX:"auto"}}>
          <div style={{...MONO,fontSize:"0.6rem",letterSpacing:"0.12em",textTransform:"uppercase",color:C.positive,marginBottom:14}}>
            ✦ Channel value ranking · all four dimensions · active channels prioritized
          </div>
          <div style={{minWidth:480}}>
            <div style={{display:"grid",gridTemplateColumns:"1.4fr repeat(5,1fr)",gap:1,background:"#1a3020",marginBottom:14}}>
              {[{h:"Channel",sub:null},{h:"Score",sub:"composite"},{h:"Win Rate",sub:"won÷(won+lost)"},{h:"Avg Deal",sub:"all-time"},{h:"Retention",sub:"avg days",pending:true},{h:"Volume",sub:"deals"}].map(({h,sub,pending},i)=>(
                <div key={i} style={{background:"#0b120d",padding:"8px 10px"}}>
                  <div style={{...MONO,fontSize:"0.6rem",color:"#4a8a5a",letterSpacing:"0.08em",textTransform:"uppercase",display:"flex",alignItems:"baseline",gap:5}}>
                    {h}{pending&&<span style={{fontSize:"0.5rem",color:"#4a6a4a",letterSpacing:"0.04em",textTransform:"none"}}>(pending)</span>}
                  </div>
                  {sub&&<div style={{...MONO,fontSize:"0.52rem",color:"#345040",marginTop:2}}>{sub}</div>}
                </div>
              ))}
              {[...ltvData].sort((a,b)=>b.score-a.score).map((d,i)=>{
                const isTop=i<3&&d.active_flag;
                const bg=isTop?"#0f1a14":"#0b120d";
                const scoreColor=d.score>=80?C.positive:d.score>=70?"#86efac":d.score>=60?C.text:C.muted;
                return [
                  <div key={`n${i}`} style={{background:bg,padding:"11px 10px",display:"flex",alignItems:"center",gap:7,flexWrap:"wrap"}}>
                    <span style={{...MONO,fontSize:"0.58rem",color:"#345040",minWidth:14}}>#{i+1}</span>
                    <span style={{width:5,height:5,borderRadius:"50%",background:d.color,flexShrink:0,display:"inline-block"}}/>
                    <span style={{...MONO,fontSize:"0.72rem",color:d.active_flag?C.text:C.muted}}>{d.name}</span>
                    {!d.active_flag&&<span style={{...MONO,fontSize:"0.5rem",color:C.muted,background:C.border,padding:"1px 4px"}}>0 in 2026</span>}
                  </div>,
                  <div key={`sc${i}`} style={{background:bg,padding:"11px 10px"}}>
                    <span style={{...SERIF,fontWeight:600,fontSize:"1.05rem",letterSpacing:"-0.02em",color:scoreColor}}>{d.score}</span>
                    {isTop&&<div style={{...MONO,fontSize:"0.52rem",color:C.positive,marginTop:3}}>▲ top pick</div>}
                  </div>,
                  <div key={`wr${i}`} style={{background:bg,padding:"11px 10px"}}>
                    <div style={{...SERIF,fontWeight:600,fontSize:"0.9rem",color:wrTextColor(d.win_rate)}}>{d.win_rate}%</div>
                    <div style={{background:C.border,height:3,marginTop:4,width:"80%"}}>
                      <div style={{width:`${(d.win_rate/maxWr)*100}%`,background:"#4a4a46",height:"100%"}}/>
                    </div>
                  </div>,
                  <div key={`ad${i}`} style={{background:bg,padding:"11px 10px"}}>
                    <div style={{...SERIF,fontWeight:600,fontSize:"0.9rem",color:C.text}}>${d.avg_deal.toLocaleString()}</div>
                    <div style={{background:C.border,height:3,marginTop:4,width:"80%"}}>
                      <div style={{width:`${(d.avg_deal/maxAvgDeal)*100}%`,background:"#4a4a46",height:"100%"}}/>
                    </div>
                  </div>,
                  <div key={`ret${i}`} style={{background:bg,padding:"11px 10px"}}>
                    <div style={{...SERIF,fontWeight:600,fontSize:"0.9rem",color:C.text}}>{d.avg_days}d</div>
                    <div style={{background:C.border,height:3,marginTop:4,width:"80%"}}>
                      <div style={{width:`${(d.avg_days/maxAvgDays)*100}%`,background:"#4a4a46",height:"100%"}}/>
                    </div>
                  </div>,
                  <div key={`vol${i}`} style={{background:bg,padding:"11px 10px"}}>
                    <div style={{...SERIF,fontWeight:600,fontSize:"0.9rem",color:C.text}}>{d.deals}</div>
                    <div style={{background:C.border,height:3,marginTop:4,width:"80%"}}>
                      <div style={{width:`${(d.deals/maxDeals)*100}%`,background:"#4a4a46",height:"100%"}}/>
                    </div>
                  </div>,
                ];
              })}
            </div>
          </div>
          <div style={{...MONO,fontSize:"0.62rem",color:"#4a6a4a",lineHeight:1.7}}>
            Score = win rate (30%) + avg deal size (30%) + relationship age (30%) + deal volume (10%) · normalized 0–100 per dimension
          </div>
          <div style={{...MONO,fontSize:"0.6rem",color:C.muted,lineHeight:1.7,marginTop:8,opacity:0.55,borderTop:"1px solid #1a3020",paddingTop:8}}>
            ⚠ Retention scores are temporarily based on sales cycle length and do not reflect actual customer relationship age. QuickBooks billing integration is in progress and will replace this metric.
          </div>
        </div>

        {/* ② Takeaway cards */}
        <div style={{display:"grid",gridTemplateColumns:`repeat(${verdictCols},1fr)`,gap:1,background:C.border,marginBottom:24}}>
          {[
            {ch:"Referral",     color:C.referral, headline:"Best active channel",        body:"Highest win rate (69%), $1,497 avg deal, consistent 2024–2026 deal flow. A structured referral program is the highest-ROI investment."},
            {ch:"Organic",      color:C.organic,  headline:"Highest deal value (active)", body:"$1,551 avg deal and strong 375-day retention. 2026 includes a $5,996 close. Content investment and site rebuild compound this channel."},
            {ch:"Partnerships", color:C.partner,  headline:"Highest revenue engine",     body:"$47k total revenue, 35 deals. Rapid 2025 growth makes it the volume leader. Worth protecting and deepening."},
          ].map(({ch,color,headline,body})=>(
            <div key={ch} style={{background:C.surface,padding:"18px 20px",borderTop:`2px solid ${color}`}}>
              <div style={{display:"flex",alignItems:"center",gap:7,marginBottom:9}}>
                <span style={{width:6,height:6,borderRadius:"50%",background:color,flexShrink:0,display:"inline-block"}}/>
                <span style={{...MONO,fontSize:"0.75rem",color:C.text}}>{ch}</span>
              </div>
              <div style={{...SERIF,fontStyle:"italic",fontWeight:300,fontSize:"0.9rem",color:color,marginBottom:10,lineHeight:1.3}}>{headline}</div>
              <div style={{...MONO,fontSize:"0.63rem",color:C.muted,lineHeight:1.75}}>{body}</div>
            </div>
          ))}
        </div>

        {/* ③ Sort + legend */}
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:14,flexWrap:"wrap",gap:10}}>
          <div>
            <p style={{...MONO,fontSize:"0.68rem",letterSpacing:"0.06em",textTransform:"uppercase",color:C.muted,marginBottom:3}}>Channel detail · all-time · <span style={{color:C.text}}>{ltvData.reduce((s,d)=>s+d.deals,0)} deals · {ltvData.length} channels</span></p>
            <p style={{...MONO,fontSize:"0.64rem",color:"#555"}}>All four value dimensions shown per card</p>
          </div>
          <SegToggle options={[["score","Score"],["revenue","Revenue"],["winrate","Win Rate"],["age","Retention"]]} value={ltvSort} onChange={setLtvSort} small wrap={isMobile}/>
        </div>
        <div style={{display:"flex",gap:16,marginBottom:16,flexWrap:"wrap"}}>
          {[{c:C.referral,l:"Win rate"},{c:C.organic,l:"Avg deal size"},{c:C.social,l:"Relationship age"},{c:C.muted,l:"Deal volume"}].map(({c,l})=>(
            <div key={l} style={{display:"flex",alignItems:"center",gap:5,...MONO,fontSize:"0.62rem",color:C.muted}}>
              <span style={{width:10,height:4,background:c,display:"inline-block",opacity:0.85}}/>{l}
            </div>
          ))}
        </div>

        {/* ④ Channel cards */}
        <div style={{display:"grid",gridTemplateColumns:`repeat(${ltvCardCols},1fr)`,gap:14,marginBottom:28}}>
          {ltvSorted.map((d,i)=><LtvCard key={d.name} d={d} rank={i+1}/>)}
        </div>

        {/* ⑤ Revenue chart */}
        <div style={{background:C.surface,border:`1px solid ${C.border}`,padding:"20px 20px",marginBottom:12}}>
          <div style={{...MONO,fontSize:"0.6rem",letterSpacing:"0.1em",textTransform:"uppercase",color:C.muted,marginBottom:16}}>Revenue + deal count · all-time</div>
          <ResponsiveContainer width="100%" height={isMobile?160:200}>
            <ComposedChart data={ltvSorted.map(d=>({name:d.name,"Revenue":d.rev,"Deals":d.deals}))} margin={{top:8,right:8,left:0,bottom:0}}>
              <CartesianGrid strokeDasharray="3 3" stroke={C.border} vertical={false}/>
              <XAxis dataKey="name" tick={{fill:C.muted,fontSize:isMobile?7:9,fontFamily:"DM Mono,monospace"}} axisLine={false} tickLine={false}/>
              <YAxis yAxisId="rev" tick={{fill:C.muted,fontSize:9,fontFamily:"DM Mono,monospace"}} axisLine={false} tickLine={false} width={46} tickFormatter={v=>`${(v/1000).toFixed(0)}k`}/>
              <YAxis yAxisId="cnt" orientation="right" tick={{fill:C.muted,fontSize:9,fontFamily:"DM Mono,monospace"}} axisLine={false} tickLine={false} width={26}/>
              <Tooltip content={<ChartTooltip/>}/>
              <Bar yAxisId="rev" dataKey="Revenue" barSize={isMobile?12:18} fillOpacity={0.7}>
                {ltvSorted.map((d,i)=><Cell key={i} fill={d.color}/>)}
              </Bar>
              <Line yAxisId="cnt" type="monotone" dataKey="Deals" stroke="#f97316" strokeWidth={1.5} dot={{r:3,fill:"#f97316"}} strokeDasharray="4 2"/>
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      </>)}

      <div style={{...MONO,fontSize:"0.65rem",color:C.muted,marginTop:28,paddingTop:18,borderBottom:`1px solid ${C.border}`}}/>
      <div style={{...MONO,fontSize:"0.65rem",color:C.muted,marginTop:14}}>Civille · HubSpot CRM · {lastRefresh} · Lincoln Labs</div>
    </div>
  );
}

import React,{useEffect,useMemo,useState}from"react";
import{createRoot}from"react-dom/client";
import{supabase,supabaseConfigStatus}from"./lib/supabase";
import"./styles.css";

const demo=[];
const VALID_TABS=["home","schedule","mypage","events","members","session","draw","ranking","profile","settings"];
const PUBLIC_NAV=[
  ["home","홈","⌂"],
  ["schedule","예정된 게임",""],
  ["mypage","MY PAGE",""],
  ["events","클럽 행사",""],
  ["ranking","클럽 랭킹","▥"],
  ["session","대진 만들기","＋"],
  ["draw","경기 기록","♜"],
];
const ADMIN_NAV=[
  ["home","홈","⌂"],
  ["schedule","예정된 게임",""],
  ["mypage","MY PAGE",""],
  ["events","클럽 행사",""],
  ["ranking","클럽 랭킹","▥"],
  ["session","대진표 만들기","▣"],
  ["draw","경기 기록","♜"],
  ["members","회원 목록","♙"],
  ["settings","설정","⚙"]
];

const SCHEDULE_SLOTS=[
  {start:"18:30",end:"19:30",label:"1경기"},
  {start:"19:30",end:"20:30",label:"2경기"},
  {start:"20:30",end:"21:30",label:"3경기"},
];

function scheduleSlotLabel(startTime){
  const key=String(startTime||"").slice(0,5);
  const slot=SCHEDULE_SLOTS.find(x=>x.start===key);
  return slot?slot.label:"미배정";
}

function localIsoDate(d){
  return[
    d.getFullYear(),
    String(d.getMonth()+1).padStart(2,"0"),
    String(d.getDate()).padStart(2,"0")
  ].join("-");
}
function nextSundayISO(){
  const d=new Date();
  const add=(7-d.getDay())%7;
  d.setDate(d.getDate()+add);
  return localIsoDate(d);
}
function readStoredMemberIdentity(){
  try{
    const raw=sessionStorage.getItem("wktcMemberIdentityV2");
    if(!raw)return null;
    const parsed=JSON.parse(raw);
    return parsed?.member_id&&parsed?.name?parsed:null;
  }catch{return null;}
}
function sessionStartDateTime(session){
  if(!session?.session_date)return null;
  const t=String(session.start_time||"00:00").slice(0,5);
  const d=new Date(`${session.session_date}T${t}:00`);
  return Number.isNaN(d.getTime())?null:d;
}
function isOpenPickSessionLocked(session){
  const d=sessionStartDateTime(session);
  return d?Date.now()>=d.getTime():false;
}

function readRoute(){
  const p=new URLSearchParams(window.location.search);
  const rawTab=p.get("tab");
  const t=rawTab==="upcoming"?"schedule":rawTab;
  return{
    tab:VALID_TABS.includes(t)?t:"home",
    memberId:p.get("member")||null
  };
}
function urlFor(tab,memberId=null){
  const u=new URL(window.location.href);
  if(tab==="home"){
    u.searchParams.delete("tab");
    u.searchParams.delete("member");
  }else{
    u.searchParams.set("tab",tab);
    if(tab==="profile"&&memberId)u.searchParams.set("member",memberId);
    else u.searchParams.delete("member");
  }
  return u.pathname+u.search+u.hash;
}
function isReload(){
  return performance.getEntriesByType?.("navigation")?.[0]?.type==="reload";
}
function expected(playerRating,opponentAverage){
  return 1/(1+10**((opponentAverage-playerRating)/400));
}
function kFactor(gamesPlayed){
  if(gamesPlayed<=5)return 40;
  if(gamesPlayed<=15)return 34;
  if(gamesPlayed<=30)return 28;
  return 24;
}

function gameShare(scoreFor,scoreAgainst){
  const total=Number(scoreFor)+Number(scoreAgainst);
  return total>0?Number(scoreFor)/total:0.5;
}

function expectedGameShare(playerRating,opponentAverage){
  // Elo-like expectation centered on 50%.
  return 1/(1+10**((opponentAverage-playerRating)/400));
}

function calculateOtrChanges(teamA,teamB,scoreA,scoreB){
  const aShare=gameShare(scoreA,scoreB);
  const bShare=1-aShare;
  const avgA=teamA.reduce((s,p)=>s+p.rating,0)/teamA.length;
  const avgB=teamB.reduce((s,p)=>s+p.rating,0)/teamB.length;
  const raw=[];

  for(const p of teamA){
    const games=(p.wins||0)+(p.losses||0);
    const K=kFactor(games);
    const expectedShare=expectedGameShare(p.rating,avgB);
    const delta=Math.round(K*1.25*(aShare-expectedShare));
    raw.push({id:p.id,delta,before:p.rating,after:p.rating+delta,won:Number(scoreA)>Number(scoreB),games});
  }

  for(const p of teamB){
    const games=(p.wins||0)+(p.losses||0);
    const K=kFactor(games);
    const expectedShare=expectedGameShare(p.rating,avgA);
    const delta=Math.round(K*1.25*(bShare-expectedShare));
    raw.push({id:p.id,delta,before:p.rating,after:p.rating+delta,won:Number(scoreB)>Number(scoreA),games});
  }

  // V11.23: each player's OTR delta is final as calculated.
  // Do NOT force the total delta of all players back to zero.
  return raw;
}

function createRoundDraw(players,mode,format="doubles",partnerCounts={},opponentCounts={}){
  const playing=[...players];

  if(mode==="random"){
    for(let i=playing.length-1;i>0;i--){
      const j=Math.floor(Math.random()*(i+1));
      [playing[i],playing[j]]=[playing[j],playing[i]];
    }
  }else{
    playing.sort((a,b)=>{
      if(mode==="seasonForm"){
        const aw=a.season_win_rate||0,bw=b.season_win_rate||0;
        return(b.rating+bw*120)-(a.rating+aw*120);
      }
      if(mode==="form"){
        const aw=a.wins/(a.wins+a.losses||1),bw=b.wins/(b.wins+b.losses||1);
        return(b.rating+bw*120)-(a.rating+aw*120);
      }
      return b.rating-a.rating;
    });
  }

  const out=[];

  if(format==="singles"){
    for(let i=0;i<playing.length;i+=2){
      const g=playing.slice(i,i+2);
      if(g.length===2){
        out.push({a:[g[0]],b:[g[1]]});
        opponentCounts[`${g[0].id}|${g[1].id}`]=(opponentCounts[`${g[0].id}|${g[1].id}`]||0)+1;
      }
    }
    return out;
  }

  for(let i=0;i<playing.length;i+=4){
    const g=playing.slice(i,i+4);
    if(g.length!==4)continue;

    const pairings=[
      {a:[g[0],g[1]],b:[g[2],g[3]]},
      {a:[g[0],g[2]],b:[g[1],g[3]]},
      {a:[g[0],g[3]],b:[g[1],g[2]]}
    ];

    let best=null;

    for(const candidate of pairings){
      const [a1,a2]=candidate.a,[b1,b2]=candidate.b;
      const aSum=a1.rating+a2.rating;
      const bSum=b1.rating+b2.rating;
      const otrDiff=Math.abs(aSum-bSum);

      const partnerRepeat=
        (partnerCounts[`${a1.id}|${a2.id}`]||partnerCounts[`${a2.id}|${a1.id}`]||0)+
        (partnerCounts[`${b1.id}|${b2.id}`]||partnerCounts[`${b2.id}|${b1.id}`]||0);

      let opponentRepeat=0;
      for(const pa of candidate.a){
        for(const pb of candidate.b){
          opponentRepeat+=opponentCounts[`${pa.id}|${pb.id}`]||opponentCounts[`${pb.id}|${pa.id}`]||0;
        }
      }

      // Repeated teammates are heavily penalized.
      // OTR balance still matters, but a small OTR difference is preferred over repeating the same partner.
      const score=(partnerRepeat*180)+(opponentRepeat*8)+otrDiff;

      if(!best||score<best.score){
        best={...candidate,score};
      }
    }

    if(best){
      out.push({a:best.a,b:best.b});

      const [a1,a2]=best.a,[b1,b2]=best.b;
      partnerCounts[`${a1.id}|${a2.id}`]=(partnerCounts[`${a1.id}|${a2.id}`]||0)+1;
      partnerCounts[`${b1.id}|${b2.id}`]=(partnerCounts[`${b1.id}|${b2.id}`]||0)+1;

      for(const pa of best.a){
        for(const pb of best.b){
          opponentCounts[`${pa.id}|${pb.id}`]=(opponentCounts[`${pa.id}|${pb.id}`]||0)+1;
        }
      }
    }
  }

  return out;
}

function createMultiRoundDraw(players,mode,rounds=1,rotation=0,format="doubles"){
  const all=[...players];
  const unit=format==="singles"?2:4;
  const totalRounds=Math.max(1,Number(rounds)||1);

  // Singles needs at least 2. Doubles normally needs 4, but exactly 2 selected
  // is treated as an automatic singles match.
  if(format==="singles"&&all.length<2)return{matches:[],sitoutRounds:[{round_no:1,players:all}]};
  if(format==="doubles"&&all.length<4&&all.length!==2)return{matches:[],sitoutRounds:[{round_no:1,players:all}]};

  // In doubles mode, 2 / 6 / 10 / 14 / 18 ... players create a singles match
  // for the two-player remainder instead of sitouts.
  const autoSinglesRemainder=
    format==="doubles" &&
    all.length>=2 &&
    all.length%4===2;

  const playableCount=autoSinglesRemainder
    ?all.length
    :Math.floor(all.length/unit)*unit;
  const sitoutCount=autoSinglesRemainder
    ?0
    :all.length-playableCount;

  const sitoutCounts=Object.fromEntries(all.map(p=>[p.id,0]));
  const singlesCounts=Object.fromEntries(all.map(p=>[p.id,0]));
  const partnerCounts={};
  const opponentCounts={};
  const matches=[];
  const sitoutRounds=[];

  for(let r=0;r<totalRounds;r++){
    let sitouts=[];
    let singlesPlayers=[];

    if(autoSinglesRemainder){
      // Rotate who gets the singles match across rounds.
      // First priority: people who have played singles the fewest times.
      // Second priority: rotation order, so the same two are not repeatedly selected.
      const shift=(rotation+r)%all.length;
      const rotated=[...all.slice(shift),...all.slice(0,shift)];
      const rotationRank=new Map(rotated.map((p,i)=>[p.id,i]));

      const ranked=[...all].sort((a,b)=>{
        const countDiff=(singlesCounts[a.id]||0)-(singlesCounts[b.id]||0);
        if(countDiff!==0)return countDiff;
        return (rotationRank.get(a.id)||0)-(rotationRank.get(b.id)||0);
      });

      const minimum=singlesCounts[ranked[0]?.id]||0;
      const pool=ranked.filter(p=>(singlesCounts[p.id]||0)===minimum);

      if(mode==="random"){
        const shuffled=[...pool];
        for(let i=shuffled.length-1;i>0;i--){
          const j=Math.floor(Math.random()*(i+1));
          [shuffled[i],shuffled[j]]=[shuffled[j],shuffled[i]];
        }
        singlesPlayers=shuffled.slice(0,2);
      }else{
        // Among equally fair candidates, prefer a reasonably balanced singles pairing.
        let bestPair=null;
        const candidates=pool.length>=2?pool:ranked;
        for(let i=0;i<candidates.length;i++){
          for(let j=i+1;j<candidates.length;j++){
            const a=candidates[i],b=candidates[j];
            const balance=Math.abs(Number(a.rating||0)-Number(b.rating||0));
            const rotatePenalty=((rotationRank.get(a.id)||0)+(rotationRank.get(b.id)||0))*0.35;
            const score=balance+rotatePenalty;
            if(!bestPair||score<bestPair.score)bestPair={a,b,score};
          }
        }
        singlesPlayers=bestPair?[bestPair.a,bestPair.b]:ranked.slice(0,2);
      }

      singlesPlayers.forEach(p=>{singlesCounts[p.id]=(singlesCounts[p.id]||0)+1;});
    }else if(sitoutCount>0){
      // For odd remainders, keep the existing fair sitout rotation.
      const rotated=[...all.slice((rotation+r)%all.length),...all.slice(0,(rotation+r)%all.length)];
      sitouts=[...rotated]
        .sort((a,b)=>(sitoutCounts[a.id]-sitoutCounts[b.id]))
        .slice(0,sitoutCount);

      for(const p of sitouts)sitoutCounts[p.id]++;
    }

    const sitoutIds=new Set(sitouts.map(x=>x.id));
    const singlesIds=new Set(singlesPlayers.map(x=>x.id));
    const playing=all.filter(x=>!sitoutIds.has(x.id)&&!singlesIds.has(x.id));

    const roundMatches=createRoundDraw(
      playing,
      mode,
      format,
      partnerCounts,
      opponentCounts
    );

    roundMatches.forEach((m,i)=>{
      matches.push({
        ...m,
        round_no:r+1,
        court_no:i+1,
        match_format:format
      });
    });

    if(singlesPlayers.length===2){
      const courtNo=roundMatches.length+1;
      const [a,b]=singlesPlayers;
      matches.push({
        a:[a],
        b:[b],
        round_no:r+1,
        court_no:courtNo,
        match_format:"singles",
        auto_singles:true
      });
      opponentCounts[`${a.id}|${b.id}`]=(opponentCounts[`${a.id}|${b.id}`]||0)+1;
    }

    sitoutRounds.push({round_no:r+1,players:sitouts});
  }

  return{matches,sitoutRounds};
}
function balancedSeasonPairing(group,partnerCounts,opponentCounts){
  if(group.length!==4)return null;

  const candidates=[
    [[0,1],[2,3]],
    [[0,2],[1,3]],
    [[0,3],[1,2]]
  ];

  let best=null;

  for(const [aIdx,bIdx] of candidates){
    const a=aIdx.map(i=>group[i]),b=bIdx.map(i=>group[i]);
    const aSum=a.reduce((s,p)=>s+p.rating,0);
    const bSum=b.reduce((s,p)=>s+p.rating,0);
    const otrDiff=Math.abs(aSum-bSum);

    const partnerRepeat=
      (partnerCounts[`${a[0].id}|${a[1].id}`]||partnerCounts[`${a[1].id}|${a[0].id}`]||0)+
      (partnerCounts[`${b[0].id}|${b[1].id}`]||partnerCounts[`${b[1].id}|${b[0].id}`]||0);

    let opponentRepeat=0;
    for(const pa of a)for(const pb of b){
      opponentRepeat+=opponentCounts[`${pa.id}|${pb.id}`]||opponentCounts[`${pb.id}|${pa.id}`]||0;
    }

    // Team balance remains the main goal, while repeated partners are strongly discouraged.
    const score=otrDiff+(partnerRepeat*120)+(opponentRepeat*6);
    if(!best||score<best.score)best={a,b,score};
  }

  return best;
}

function combinations(arr,k){
  const out=[];
  function walk(start,pick){
    if(pick.length===k){out.push([...pick]);return;}
    for(let i=start;i<=arr.length-(k-pick.length);i++){
      pick.push(arr[i]);walk(i+1,pick);pick.pop();
    }
  }
  walk(0,[]);
  return out;
}

function supplementalHelperOtrFit(remainder,helpers){
  if(!remainder.length||!helpers.length)return 0;

  // With 2 remaining + 2 helpers, compare the two possible 1:1 OTR matches.
  // This strongly prefers helpers near each remaining player's actual OTR.
  if(remainder.length===2&&helpers.length===2){
    const [r1,r2]=remainder,[h1,h2]=helpers;
    return Math.min(
      Math.abs(r1.rating-h1.rating)+Math.abs(r2.rating-h2.rating),
      Math.abs(r1.rating-h2.rating)+Math.abs(r2.rating-h1.rating)
    );
  }

  // For 1 or 3 remaining players, use the remaining-group average as the
  // reference, then let team-balance scoring decide the final combination.
  const remAvg=remainder.reduce((s,p)=>s+Number(p.rating||0),0)/remainder.length;
  return helpers.reduce((s,p)=>s+Math.abs(Number(p.rating||0)-remAvg),0);
}

function supplementalPairingCandidates(group){
  if(group.length!==4)return[];
  return[
    [[0,1],[2,3]],
    [[0,2],[1,3]],
    [[0,3],[1,2]]
  ].map(([aIdx,bIdx])=>({
    a:aIdx.map(i=>group[i]),
    b:bIdx.map(i=>group[i])
  }));
}

function createSeasonSetDraw(players,rotation=0,format="doubles",helperTargetHistory={}){
  const all=[...players];
  const unit=format==="singles"?2:4;
  if(format==="singles"&&all.length<2)return{matches:[],helpers:[]};
  if(format==="doubles"&&all.length<4)return{matches:[],helpers:[]};

  // Supplemental-target selection is independent of skill and season performance.
  const rotateRank=new Map(all.map((p,i)=>[p.id,(i-rotation+all.length)%all.length]));
  const fairOrder=[...all].sort((a,b)=>{
    const ah=helperTargetHistory[a.id]||{count:0,last:-1};
    const bh=helperTargetHistory[b.id]||{count:0,last:-1};
    if(ah.count!==bh.count)return ah.count-bh.count;
    if(ah.last!==bh.last)return ah.last-bh.last;
    return (rotateRank.get(a.id)||0)-(rotateRank.get(b.id)||0);
  });
  const remainderCount=all.length%unit;
  const remainderIds=new Set(remainderCount?fairOrder.slice(0,remainderCount).map(x=>x.id):[]);
  const remainder=all.filter(p=>remainderIds.has(p.id));

  // Season performance only determines grouping among the regular credited players.
  const ordered=[...all].filter(p=>!remainderIds.has(p.id)).sort((a,b)=>{
    const perf=(b.season_adjusted_rate||0.5)-(a.season_adjusted_rate||0.5);
    if(Math.abs(perf)>0.000001)return perf;
    const games=(b.season_games||0)-(a.season_games||0);
    if(games!==0)return games;
    return b.rating-a.rating;
  });

  const matches=[];
  const helperIds=new Set();
  const partnerCounts={};
  const opponentCounts={};

  if(format==="singles"){
    const fullCount=Math.floor(ordered.length/2)*2;
    const regular=ordered.slice(0,fullCount);

    for(let i=0;i<regular.length;i+=2){
      const a=regular[i],b=regular[i+1];
      matches.push({
        a:[a],b:[b],
        round_no:1,court_no:(i/2)+1,
        season_credit_ids:[a.id,b.id],
        supplemental:false,
        match_format:"singles"
      });
      opponentCounts[`${a.id}|${b.id}`]=(opponentCounts[`${a.id}|${b.id}`]||0)+1;
    }

    if(remainder.length===1 && regular.length){
      const target=remainder[0];
      const helper=[...regular].sort((a,b)=>Math.abs(a.rating-target.rating)-Math.abs(b.rating-target.rating))[0];
      helperIds.add(helper.id);
      matches.push({
        a:[target],b:[helper],
        round_no:2,court_no:1,
        season_credit_ids:[target.id],
        supplemental:true,
        match_format:"singles"
      });
    }

    return{matches,helpers:[...helperIds]};
  }

  const fullCount=Math.floor(ordered.length/4)*4;
  const regular=ordered.slice(0,fullCount);

  // Standard season matches: everyone here gets exactly one season credit.
  for(let i=0;i<regular.length;i+=4){
    const group=regular.slice(i,i+4);
    const pairing=balancedSeasonPairing(group,partnerCounts,opponentCounts);
    if(!pairing)continue;

    matches.push({
      a:pairing.a,
      b:pairing.b,
      round_no:1,
      court_no:(i/4)+1,
      season_credit_ids:group.map(x=>x.id),
      supplemental:false,
      match_format:"doubles"
    });

    const [a1,a2]=pairing.a,[b1,b2]=pairing.b;
    partnerCounts[`${a1.id}|${a2.id}`]=(partnerCounts[`${a1.id}|${a2.id}`]||0)+1;
    partnerCounts[`${b1.id}|${b2.id}`]=(partnerCounts[`${b1.id}|${b2.id}`]||0)+1;
    for(const pa of pairing.a)for(const pb of pairing.b){
      opponentCounts[`${pa.id}|${pb.id}`]=(opponentCounts[`${pa.id}|${pb.id}`]||0)+1;
    }
  }

  // If 1, 2, or 3 members remain in doubles mode,
  // create one supplemental doubles match so every selected member
  // still receives exactly one season-credit result.
  //
  // Example with 6 players:
  //   - 4 players play the normal season doubles match.
  //   - the remaining 2 players are joined by 2 already-used helpers.
  //   - only the 2 remaining players receive season credit in the supplemental match.
  //   - the 2 helpers receive OTR/career W-L only, not a second season result.
  if(remainder.length>0 && regular.length>=4){
    const helperNeed=4-remainder.length;
    const helperChoices=combinations(regular,helperNeed);
    let best=null;

    for(const helpers of helperChoices){
      const group=[...remainder,...helpers];
      const helperFit=supplementalHelperOtrFit(remainder,helpers);

      for(const pairing of supplementalPairingCandidates(group)){
        const aSum=pairing.a.reduce((s,p)=>s+Number(p.rating||0),0);
        const bSum=pairing.b.reduce((s,p)=>s+Number(p.rating||0),0);
        const teamDiff=Math.abs(aSum-bSum);

        const partnerRepeat=
          (partnerCounts[`${pairing.a[0].id}|${pairing.a[1].id}`]||partnerCounts[`${pairing.a[1].id}|${pairing.a[0].id}`]||0)+
          (partnerCounts[`${pairing.b[0].id}|${pairing.b[1].id}`]||partnerCounts[`${pairing.b[1].id}|${pairing.b[0].id}`]||0);

        let opponentRepeat=0;
        for(const pa of pairing.a)for(const pb of pairing.b){
          opponentRepeat+=opponentCounts[`${pa.id}|${pb.id}`]||opponentCounts[`${pb.id}|${pa.id}`]||0;
        }

        // V11.26 supplemental priority:
        // 1) keep the two teams' total OTR as close as possible,
        // 2) choose helpers whose OTR is close to the remaining players,
        // 3) only then use repeated partner/opponent history as a light tie-breaker.
        //
        // Previously the repeat penalty could overpower OTR balance and make helper
        // selection look random. The new weights intentionally make OTR the main goal.
        const score=
          (teamDiff*10)+
          helperFit+
          (partnerRepeat*4)+
          opponentRepeat;

        if(!best||
          score<best.score||
          (score===best.score&&teamDiff<best.teamDiff)||
          (score===best.score&&teamDiff===best.teamDiff&&helperFit<best.helperFit)){
          best={pairing,helpers,score,teamDiff,helperFit};
        }
      }
    }

    if(best){
      best.helpers.forEach(x=>helperIds.add(x.id));
      matches.push({
        a:best.pairing.a,
        b:best.pairing.b,
        round_no:2,
        court_no:1,
        season_credit_ids:remainder.map(x=>x.id),
        supplemental:true,
        match_format:"doubles"
      });
    }
  }

  return{matches,helpers:[...helperIds]};
}

const PUBLIC_CACHE_KEY="wktcPublicCacheV1";
const WKTC_CLUB_ID="44444444-4444-4444-8444-444444444444";
const CURRENT_CLUB_ID=WKTC_CLUB_ID;
function readPublicCache(){
  try{
    const raw=localStorage.getItem(PUBLIC_CACHE_KEY);
    if(!raw)return null;
    const parsed=JSON.parse(raw);
    if(!parsed||typeof parsed!=="object")return null;
    return parsed;
  }catch{return null}
}
function writePublicCache(patch){
  try{
    const prev=readPublicCache()||{};
    localStorage.setItem(PUBLIC_CACHE_KEY,JSON.stringify({...prev,...patch,cached_at:Date.now()}));
  }catch{}
}

function withTimeout(promise,ms,message){
  let timer;
  const timeout=new Promise((_,reject)=>{
    timer=window.setTimeout(()=>reject(new Error(message)),ms);
  });
  return Promise.race([promise,timeout]).finally(()=>window.clearTimeout(timer));
}

function App(){
  const initialRoute=isReload()?{tab:"home",memberId:null}:readRoute();
  const initialPublicCache=readPublicCache();
  const[tab,setTab]=useState(initialRoute.tab);
  const[profileMemberId,setProfileMemberId]=useState(initialRoute.memberId);
  const[members,setMembers]=useState(supabase?(initialPublicCache?.members||[]):demo);
  const[selected,setSelected]=useState([]);
  const[mode,setMode]=useState("balanced");
  const[matchFormat,setMatchFormat]=useState("doubles");
  const[drawRotation,setDrawRotation]=useState(0);
  const[sitouts,setSitouts]=useState([]);
  const[manualMatches,setManualMatches]=useState([{a1:"",a2:"",b1:"",b2:""}]);
  const[matches,setMatches]=useState([]);
  const[scoreInputs,setScoreInputs]=useState({});
  const[form,setForm]=useState({name:"",gender:"M",rating:1000,membership_status:"regular"});
  const[session,setSession]=useState(()=>{
    const now=new Date();
    const localDate=[now.getFullYear(),String(now.getMonth()+1).padStart(2,"0"),String(now.getDate()).padStart(2,"0")].join("-");
    const localTime=`${String(now.getHours()).padStart(2,"0")}:${String(now.getMinutes()).padStart(2,"0")}`;
    return{date:localDate,time:localTime,courts:2,rounds:1};
  });
  const[dbConnected,setDbConnected]=useState(!!supabase);
  const[user,setUser]=useState(null);
  const[authReady,setAuthReady]=useState(!supabase);
  const[clubAdminAccess,setClubAdminAccess]=useState(null);
  const[adminAccessReady,setAdminAccessReady]=useState(!supabase);
  const[loginOpen,setLoginOpen]=useState(false);
  const[loginForm,setLoginForm]=useState({email:"",password:""});
  const[loginBusy,setLoginBusy]=useState(false);
  const[loginError,setLoginError]=useState("");
  const[adminPasswordForm,setAdminPasswordForm]=useState({current:"",next:"",confirm:""});
  const[adminPasswordBusy,setAdminPasswordBusy]=useState(false);
  const[adminPasswordError,setAdminPasswordError]=useState("");
  const[sessions,setSessions]=useState(initialPublicCache?.sessions||[]);
  const[historyMatches,setHistoryMatches]=useState(initialPublicCache?.historyMatches||[]);
  const[otrEvents,setOtrEvents]=useState(initialPublicCache?.otrEvents||[]);
  const[notice,setNotice]=useState("");
  const[mobileMenuOpen,setMobileMenuOpen]=useState(false);
  const[editingMember,setEditingMember]=useState(null);
  const[editMemberForm,setEditMemberForm]=useState({name:"",rating:1000,membership_status:"regular"});
  const[editingMatch,setEditingMatch]=useState(null);
  const[editScore,setEditScore]=useState({a:"",b:""});
  const[otrSeedRows,setOtrSeedRows]=useState([]);
  const[otrSeedPreview,setOtrSeedPreview]=useState(null);
  const[otrRebuildLoading,setOtrRebuildLoading]=useState(false);
  const[otrRebuildBusy,setOtrRebuildBusy]=useState(false);
  const[otrRebuildLastBackup,setOtrRebuildLastBackup]=useState(null);
  const[memberFilter,setMemberFilter]=useState("active");
  const[seasons,setSeasons]=useState(initialPublicCache?.seasons||[]);
  const[hall,setHall]=useState(initialPublicCache?.hall||[]);
  const[currentSeasonId,setCurrentSeasonId]=useState(null);
  const[seasonView,setSeasonView]=useState(null);
  const[rankView,setRankView]=useState("club");
  const[showAllClubRank,setShowAllClubRank]=useState(false);
  const[showAllSeasonRank,setShowAllSeasonRank]=useState(false);
  const[historyFilter,setHistoryFilter]=useState("all");
  const[matchType,setMatchType]=useState("friendly");
  const[memberIdentity,setMemberIdentity]=useState(()=>readStoredMemberIdentity());
  const[memberPin,setMemberPin]=useState(()=>sessionStorage.getItem("wktcPersonalMemberPinV2")||"");
  const[memberUnlocked,setMemberUnlocked]=useState(()=>!!readStoredMemberIdentity());
  const[hallForm,setHallForm]=useState({season_id:"",champion_name:"",runner_up_name:""});
  const[memberPinStatus,setMemberPinStatus]=useState({});
  const[clubs,setClubs]=useState([]);
  const[clubMemberships,setClubMemberships]=useState([]);
  const[clubPublicStatuses,setClubPublicStatuses]=useState([]);
  const[clubFoundationLoaded,setClubFoundationLoaded]=useState(false);
  const[clubSiteSettings,setClubSiteSettings]=useState(null);
  const[clubFoundationSnapshot,setClubFoundationSnapshot]=useState(null);
  const[clubFoundationError,setClubFoundationError]=useState("");
  const[pinEditMember,setPinEditMember]=useState(null);
  const[personalPinForm,setPersonalPinForm]=useState({pin:"",confirm:""});
  const[personalPinBusy,setPersonalPinBusy]=useState(false);
  const[openPickPublic,setOpenPickPublic]=useState({leaderboard:[],match_stats:[]});
  const[openPickMyPicks,setOpenPickMyPicks]=useState({});
  const[openPickBusy,setOpenPickBusy]=useState(false);
  const[openPickSavingMatchId,setOpenPickSavingMatchId]=useState(null);
  const[myPageData,setMyPageData]=useState({member:null,rackets:[],memo:""});
  const[myPageBusy,setMyPageBusy]=useState(false);
  const[myRacketName,setMyRacketName]=useState("");
  const[myStringForms,setMyStringForms]=useState({});
  const[myMemo,setMyMemo]=useState("");
  const[myPageSaving,setMyPageSaving]=useState(false);

  const[financeCharges,setFinanceCharges]=useState([]);
  const[financePayments,setFinancePayments]=useState([]);
  const[financeTransactions,setFinanceTransactions]=useState([]);
  const[financeBusy,setFinanceBusy]=useState(false);
  const[duesDetailMemberId,setDuesDetailMemberId]=useState(null);
  const[editingChargeId,setEditingChargeId]=useState(null);
  const[editingChargeAmount,setEditingChargeAmount]=useState("");
  const[attendanceForm,setAttendanceForm]=useState({
    date:new Date().toISOString().slice(0,10),
    selected:[],
    amounts:{},
    received:{},
    note:""
  });
  const[paymentForm,setPaymentForm]=useState({member_id:"",date:new Date().toISOString().slice(0,10),amount:"30",note:""});
  const[monthlyFeeMonth,setMonthlyFeeMonth]=useState(()=>localIsoDate(new Date()).slice(0,7));
  const[globalPlayerSearch,setGlobalPlayerSearch]=useState("");
  const[globalPlayerResults,setGlobalPlayerResults]=useState([]);
  const[globalPlayerSearchBusy,setGlobalPlayerSearchBusy]=useState(false);
  const[transactionForm,setTransactionForm]=useState({type:"expense",date:new Date().toISOString().slice(0,10),category:"코트비",amount:"",note:""});
  const[clubEvents,setClubEvents]=useState(initialPublicCache?.clubEvents||[]);
  const[eventForm,setEventForm]=useState({id:null,date:new Date().toISOString().slice(0,10),title:"",details:""});
  const[clubPromo,setClubPromo]=useState(initialPublicCache?.clubPromo||{title:"WKTC",content:"Wellington Korean Tennis Club과 함께 즐겁고 매너 있는 테니스를 만들어갑니다."});
  const[promoForm,setPromoForm]=useState({title:"",content:""});
  const[scheduleDate,setScheduleDate]=useState(()=>localIsoDate(new Date()));
  const[scheduleDateManual,setScheduleDateManual]=useState(false);
  const[scheduleAssignments,setScheduleAssignments]=useState([]);
  const[scheduleLessonParticipants,setScheduleLessonParticipants]=useState([]);
  const[scheduleDay,setScheduleDay]=useState({schedule_date:localIsoDate(new Date()),lesson_court_no:null});
  const[scheduleSelectedMatchId,setScheduleSelectedMatchId]=useState(null);
  const[scheduleFindMemberId,setScheduleFindMemberId]=useState("");
  const[scheduleBusy,setScheduleBusy]=useState(false);
  const[lessonEditSlot,setLessonEditSlot]=useState(null);
  const[lessonMemberId,setLessonMemberId]=useState("");
  const[focusMatchId,setFocusMatchId]=useState(null);


  const isAdmin=!!user&&!!clubAdminAccess?.allowed;
  const isSystemAdmin=!!user&&!!clubAdminAccess?.system_admin;
  const nav=isAdmin?ADMIN_NAV:PUBLIC_NAV;
  const activeMembers=useMemo(()=>members.filter(m=>m.active!==false),[members]);
  const clubMap=useMemo(()=>Object.fromEntries((clubs||[]).map(c=>[c.id,c])),[clubs]);

  const membershipsByMember=useMemo(()=>{
    const out={};
    for(const row of clubMemberships||[]){
      if(!out[row.member_id])out[row.member_id]=[];
      out[row.member_id].push(row);
    }
    return out;
  },[clubMemberships]);

  const publicStatusByMember=useMemo(()=>{
    const out={};
    for(const row of clubPublicStatuses||[]){
      if(row.club_id===CURRENT_CLUB_ID&&row.active!==false)out[row.member_id]=row;
    }
    return out;
  },[clubPublicStatuses]);

  function currentClubMembershipRow(memberId){
    return (membershipsByMember[memberId]||[]).find(x=>x.club_id===CURRENT_CLUB_ID)||null;
  }

  function currentClubMembershipStatus(memberId){
    const row=currentClubMembershipRow(memberId);
    if(!row)return "guest";
    if(row.membership_type==="regular"||row.membership_type==="associate")return row.membership_type;
    return "guest";
  }

  function membershipAdminLabel(status){
    return status==="regular"?"정회원":status==="associate"?"준회원":"게스트";
  }

  function publicMemberType(member){
    if(!member)return "guest";
    if(!clubFoundationLoaded)return (member.member_type||"member")==="guest"?"guest":"member";
    return publicStatusByMember[member.id]?"member":"guest";
  }

  function publicMemberLabel(member){
    return publicMemberType(member)==="guest"?"게스트":"회원";
  }

  const openCourtRegularCount=useMemo(
    ()=>clubMemberships.filter(x=>x.club_id===CURRENT_CLUB_ID&&x.membership_type==="regular"&&x.active!==false).length,
    [clubMemberships]
  );
  const openCourtAssociateCount=useMemo(
    ()=>clubMemberships.filter(x=>x.club_id===CURRENT_CLUB_ID&&x.membership_type==="associate"&&x.active!==false).length,
    [clubMemberships]
  );

  function memberClubLabel(memberId){
    const rows=(membershipsByMember[memberId]||[])
      .filter(x=>(x.membership_type==="regular"||x.membership_type==="associate")&&x.active!==false);
    if(!rows.length)return "-";
    const primary=rows.find(x=>x.membership_type==="regular")||rows.find(x=>x.is_primary)||rows[0];
    const others=rows.filter(x=>x!==primary);
    const base=clubMap[primary.club_id]?.short_name||clubMap[primary.club_id]?.name||"소속 클럽";
    return others.length?`${base} +${others.length}`:base;
  }

  const inactiveMembers=useMemo(()=>members.filter(m=>m.active===false),[members]);
  const filteredMembers=useMemo(()=>{
    const src=memberFilter==="all"?members:memberFilter==="inactive"?inactiveMembers:activeMembers;
    return [...src].sort((a,b)=>b.rating-a.rating);
  },[members,activeMembers,inactiveMembers,memberFilter]);
  const ranked=useMemo(()=>[...activeMembers].sort((a,b)=>b.rating-a.rating),[activeMembers]);
  const memberRanked=useMemo(()=>activeMembers
    .filter(m=>publicMemberType(m)==="member")
    .sort((a,b)=>b.rating-a.rating),[activeMembers,clubPublicStatuses,clubFoundationLoaded]);
  const pickerMembers=useMemo(
    ()=>activeMembers.map(m=>({...m,member_type:publicMemberType(m)})),
    [activeMembers,clubPublicStatuses,clubFoundationLoaded]
  );
  const avgRating=activeMembers.length?Math.round(activeMembers.reduce((s,m)=>s+m.rating,0)/activeMembers.length):0;
  const totalGames=Math.floor(members.reduce((s,m)=>s+m.wins+m.losses,0)/2);
  const memberMap=useMemo(()=>Object.fromEntries(members.map(m=>[m.id,m])),[members]);
  const sessionMap=useMemo(()=>Object.fromEntries(sessions.map(s=>[s.id,s])),[sessions]);
  const otrSeedPreviewMap=useMemo(()=>Object.fromEntries((otrSeedPreview?.members||[]).map(x=>[x.member_id,x])),[otrSeedPreview]);
  const currentSeason=useMemo(()=>seasons.find(x=>x.id===currentSeasonId)||seasons.find(x=>x.is_current)||null,[seasons,currentSeasonId]);
  const openPickStatsMap=useMemo(()=>Object.fromEntries((openPickPublic?.match_stats||[]).map(x=>[x.match_id,x])),[openPickPublic]);
  const openPickLeaderboard=openPickPublic?.leaderboard||[];
  const openPickSeasonSessions=useMemo(()=>{
    if(!currentSeasonId)return[];
    return sessions
      .filter(s=>s.match_type==="season"&&s.season_id===currentSeasonId&&historyMatches.some(m=>m.session_id===s.id))
      .sort((a,b)=>`${a.session_date||""}T${String(a.start_time||"00:00")}`.localeCompare(`${b.session_date||""}T${String(b.start_time||"00:00")}`));
  },[sessions,historyMatches,currentSeasonId]);
  const openPickCurrentSession=useMemo(()=>{
    if(!openPickSeasonSessions.length)return null;
    const unfinished=openPickSeasonSessions.find(s=>historyMatches.some(m=>m.session_id===s.id&&!m.winner));
    return unfinished||openPickSeasonSessions[openPickSeasonSessions.length-1];
  },[openPickSeasonSessions,historyMatches]);
  const openPickCurrentMatches=useMemo(()=>{
    if(!openPickCurrentSession)return[];
    return historyMatches.filter(m=>m.session_id===openPickCurrentSession.id).sort((a,b)=>(Number(a.round_no)||1)-(Number(b.round_no)||1)||(Number(a.court_no)||1)-(Number(b.court_no)||1));
  },[historyMatches,openPickCurrentSession]);
  const championCountByName=useMemo(()=>{
    const counts={};
    for(const h of hall||[]){
      const name=(h.champion_name||"").trim();
      if(name)counts[name]=(counts[name]||0)+1;
    }
    return counts;
  },[hall]);

  const financeSummary=useMemo(()=>{
    const income=financeTransactions.filter(x=>x.type==="income").reduce((s,x)=>s+Number(x.amount||0),0);
    const expense=financeTransactions.filter(x=>x.type==="expense").reduce((s,x)=>s+Number(x.amount||0),0);
    return{income,expense,balance:income-expense};
  },[financeTransactions]);

  const memberDues=useMemo(()=>{
    return activeMembers
      .map(m=>{
        const charged=financeCharges.filter(x=>x.member_id===m.id).reduce((s,x)=>s+Number(x.amount||0),0);
        const paid=financePayments.filter(x=>x.member_id===m.id).reduce((s,x)=>s+Number(x.amount||0),0);
        const attendance=financeCharges.filter(x=>x.member_id===m.id).length;
        const isGuest=publicMemberType(m)==="guest";
        return{member:m,charged,paid,due:Math.max(0,charged-paid),attendance,isGuest};
      })
      .sort((a,b)=>b.due-a.due||a.member.name.localeCompare(b.member.name));
  },[activeMembers,financeCharges,financePayments]);

  const upcomingClubEvents=useMemo(()=>{
    const today=new Date();
    const todayKey=[
      today.getFullYear(),
      String(today.getMonth()+1).padStart(2,"0"),
      String(today.getDate()).padStart(2,"0")
    ].join("-");
    return [...clubEvents]
      .filter(x=>String(x.event_date||"")>=todayKey)
      .sort((a,b)=>String(a.event_date).localeCompare(String(b.event_date))||String(a.created_at||"").localeCompare(String(b.created_at||"")));
  },[clubEvents]);

  const pendingMatches=useMemo(()=>{
    return historyMatches
      .filter(m=>!m.winner)
      .map(m=>({
        ...m,
        a:[memberMap[m.team_a_member_1],memberMap[m.team_a_member_2]].filter(Boolean),
        b:[memberMap[m.team_b_member_1],memberMap[m.team_b_member_2]].filter(Boolean)
      }))
      .sort((a,b)=>{
        const sa=sessionMap[a.session_id],sb=sessionMap[b.session_id];
        const ak=`${sa?.session_date||""}T${String(sa?.start_time||"00:00")}`;
        const bk=`${sb?.session_date||""}T${String(sb?.start_time||"00:00")}`;

        // Newer sessions first.
        if(ak!==bk)return bk.localeCompare(ak);

        // Within the same session, always show Round 1 -> Round 2 -> Round 3...
        const roundDiff=(Number(a.round_no)||1)-(Number(b.round_no)||1);
        if(roundDiff!==0)return roundDiff;

        // If a round has multiple courts, Court 1 -> Court 2 -> Court 3...
        return (Number(a.court_no)||1)-(Number(b.court_no)||1);
      });
  },[historyMatches,memberMap,sessionMap]);

  const scheduleDateMatches=useMemo(()=>historyMatches
    .filter(m=>sessionMap[m.session_id]?.session_date===scheduleDate)
    .sort((a,b)=>{
      const sa=sessionMap[a.session_id],sb=sessionMap[b.session_id];
      const timeDiff=String(sa?.start_time||"").localeCompare(String(sb?.start_time||""));
      if(timeDiff!==0)return timeDiff;
      const roundDiff=(Number(a.round_no)||1)-(Number(b.round_no)||1);
      if(roundDiff!==0)return roundDiff;
      return (Number(a.court_no)||1)-(Number(b.court_no)||1);
    }),[historyMatches,sessionMap,scheduleDate]);

  const scheduleAssignmentByMatch=useMemo(()=>Object.fromEntries(
    scheduleAssignments
      .filter(a=>SCHEDULE_SLOTS.some(slot=>slot.start===String(a.start_time||"").slice(0,5)))
      .map(a=>[a.match_id,a])
  ),[scheduleAssignments]);

  const unassignedScheduleMatches=useMemo(()=>scheduleDateMatches.filter(
    m=>!m.winner&&!scheduleAssignmentByMatch[m.id]
  ),[scheduleDateMatches,scheduleAssignmentByMatch]);

  const scheduleFindAssignments=useMemo(()=>{
    if(!scheduleFindMemberId)return[];
    return scheduleAssignments
      .filter(a=>SCHEDULE_SLOTS.some(slot=>slot.start===String(a.start_time||"").slice(0,5)))
      .map(a=>({assignment:a,match:historyMatches.find(m=>m.id===a.match_id)}))
      .filter(x=>x.match&&[
        x.match.team_a_member_1,x.match.team_a_member_2,
        x.match.team_b_member_1,x.match.team_b_member_2
      ].includes(scheduleFindMemberId))
      .sort((a,b)=>String(a.assignment.start_time).localeCompare(String(b.assignment.start_time)));
  },[scheduleAssignments,historyMatches,scheduleFindMemberId]);

  useEffect(()=>{
    const reload=isReload();
    const route=reload?{tab:"home",memberId:null}:readRoute();
    setTab(route.tab);
    setProfileMemberId(route.memberId);
    window.history.replaceState({tab:route.tab,memberId:route.memberId},"",urlFor(route.tab,route.memberId));

    const onPop=e=>{
      const routeState=e.state||readRoute();
      setTab(VALID_TABS.includes(routeState.tab)?routeState.tab:"home");
      setProfileMemberId(routeState.memberId||null);
    };
    window.addEventListener("popstate",onPop);
    return()=>window.removeEventListener("popstate",onPop);
  },[]);

  useEffect(()=>{
    if(!supabase)return;
    supabase.auth.getSession().then(({data})=>{
      setUser(data.session?.user||null);
      setAuthReady(true);
    });
    const{data:{subscription}}=supabase.auth.onAuthStateChange((_event,s)=>{
      setUser(s?.user||null);
      setAuthReady(true);
    });
    return()=>subscription.unsubscribe();
  },[]);

  useEffect(()=>{
    if(!supabase||!authReady||loginBusy)return;
    if(!user){
      setClubAdminAccess(null);
      setAdminAccessReady(true);
      return;
    }
    if(clubAdminAccess?.allowed){
      setAdminAccessReady(true);
      return;
    }
    resolveAdminAccess(true).catch(err=>{
      console.error("클럽 관리자 권한 확인 실패",err);
      setClubAdminAccess(null);
      setAdminAccessReady(true);
    });
  },[authReady,user?.id,loginBusy]);

  useEffect(()=>{
    if(authReady&&adminAccessReady&&!isAdmin&&["members","settings"].includes(tab))navigate("home",null,true);
  },[authReady,adminAccessReady,isAdmin]);

  useEffect(()=>{
    if(!supabase||!authReady)return;
    Promise.all([loadMembers(),loadHistory(),loadClubEvents(),loadClubPromo(),loadClubFoundation()]).catch(err=>console.error("화면 최신화 실패",err));
    if(false&&(isAdmin||memberUnlocked))loadFinance();
  },[tab,authReady,isAdmin,memberUnlocked]);

  useEffect(()=>{
    if(isAdmin&&tab==="members")loadMemberPinStatus();
  },[tab,isAdmin]);

  useEffect(()=>{
    if(isSystemAdmin&&tab==="settings")loadOtrRebuildEditor();
  },[tab,isSystemAdmin]);

  useEffect(()=>{
    if(tab!=="profile")return;
    const timer=window.setTimeout(()=>{
      window.scrollTo({top:0,left:0,behavior:"auto"});
      document.documentElement.scrollTop=0;
      document.body.scrollTop=0;
    },0);
    return()=>window.clearTimeout(timer);
  },[tab,profileMemberId]);

  useEffect(()=>{
    if(tab==="mypage"&&memberUnlocked&&memberPin)loadMyPage();
  },[tab,memberUnlocked]);

  function flash(text){
    setNotice(text);
    window.setTimeout(()=>setNotice(""),4200);
  }
  function navigate(next,memberId=null,replace=false){
    if(!VALID_TABS.includes(next))return;
    setMobileMenuOpen(false);
    setTab(next);
    setProfileMemberId(next==="profile"?memberId:null);
    window.history[replace?"replaceState":"pushState"]({tab:next,memberId:next==="profile"?memberId:null},"",urlFor(next,memberId));
  }

  // Main navigation intentionally performs a real page load.
  // This clears temporary UI state (selected players, open forms, stale screen state)
  // and reloads the newest DB data whenever the user changes a main menu page.
  function navigateFresh(next){
    if(!VALID_TABS.includes(next))return;
    setMobileMenuOpen(false);
    window.location.assign(urlFor(next));
  }

  function openProfile(id){navigate("profile",id)}

  async function resolveAdminAccess(allowBootstrap=false){
    if(!supabase||!user){
      setClubAdminAccess(null);
      setAdminAccessReady(true);
      return null;
    }
    setAdminAccessReady(false);
    const{data,error}=await supabase.rpc("club_admin_access",{
      p_club_id:CURRENT_CLUB_ID,
      p_allow_bootstrap:!!allowBootstrap
    });
    if(error){
      setClubAdminAccess(null);
      setAdminAccessReady(true);
      throw error;
    }
    const access=data||{allowed:false,system_admin:false};
    setClubAdminAccess(access);
    setAdminAccessReady(true);
    return access;
  }

  function requireAdmin(){
    if(isAdmin)return true;
    if(user&&adminAccessReady&&!isAdmin){
      alert("이 계정에는 WKTC 관리자 권한이 없습니다.");
      return false;
    }
    setLoginOpen(true);
    return false;
  }

  async function findPreferredScheduleDate(){
    if(!supabase)return null;

    const{data:assignmentRows,error:aErr}=await supabase
      .from("schedule_assignments")
      .select("schedule_date,match_id")
      .eq("club_id",CURRENT_CLUB_ID)
      .order("schedule_date",{ascending:true});
    if(aErr)throw aErr;
    if(!assignmentRows?.length)return null;

    const matchIds=[...new Set(assignmentRows.map(x=>x.match_id).filter(Boolean))];
    let winnerMap={};

    if(matchIds.length){
      const{data:matchRows,error:mErr}=await supabase
        .from("matches")
        .select("id,winner")
        .eq("club_id",CURRENT_CLUB_ID)
        .in("id",matchIds);
      if(mErr)throw mErr;
      winnerMap=Object.fromEntries((matchRows||[]).map(x=>[x.id,x.winner]));
    }

    const dates=[...new Set(assignmentRows.map(x=>x.schedule_date).filter(Boolean))].sort();

    // The earliest stored schedule with at least one unfinished scheduled match wins.
    // Clock time and weekday do not matter. A Friday schedule stays active until
    // every scheduled match on Friday has a result, then the next stored schedule appears.
    const unfinishedDate=dates.find(date=>
      assignmentRows.some(x=>x.schedule_date===date&&!winnerMap[x.match_id])
    );
    if(unfinishedDate)return unfinishedDate;

    // If every stored schedule is already complete, prefer the next dated schedule
    // if one exists; otherwise keep the most recently stored completed schedule visible.
    const today=localIsoDate(new Date());
    return dates.find(date=>date>=today)||dates[dates.length-1]||null;
  }

  async function loadSchedule(date=scheduleDate){
    if(!supabase)return;
    setScheduleBusy(true);
    try{
      const[
        {data:assignments,error:aErr},
        {data:day,error:dErr},
        {data:lessonRows,error:lErr}
      ]=await Promise.all([
        supabase.from("schedule_assignments")
          .select("*")
          .eq("club_id",CURRENT_CLUB_ID)
          .eq("schedule_date",date)
          .order("start_time",{ascending:true})
          .order("court_no",{ascending:true}),
        supabase.from("schedule_days")
          .select("*")
          .eq("club_id",CURRENT_CLUB_ID)
          .eq("schedule_date",date)
          .maybeSingle(),
        supabase.from("schedule_lesson_participants")
          .select("*")
          .eq("club_id",CURRENT_CLUB_ID)
          .eq("schedule_date",date)
          .order("start_time",{ascending:true})
          .order("created_at",{ascending:true})
      ]);
      if(aErr)throw aErr;
      if(dErr)throw dErr;
      if(lErr)throw lErr;
      setScheduleAssignments(assignments||[]);
      setScheduleLessonParticipants(lessonRows||[]);
      setScheduleDay(day||{schedule_date:date,lesson_court_no:null});
    }catch(err){
      console.error("스케줄 불러오기 실패",err);
      if(tab==="schedule")alert("스케줄 정보를 불러오지 못했습니다. V11.18 / V11.21 SQL 적용 여부를 확인해주세요.");
    }finally{
      setScheduleBusy(false);
    }
  }

  async function saveLessonCourt(courtNo){
    if(!requireAdmin())return;
    const nextCourt=courtNo?Number(courtNo):null;
    const occupied=nextCourt?scheduleAssignments.filter(a=>Number(a.court_no)===nextCourt):[];
    if(occupied.length){
      if(!confirm(`${nextCourt}코트에 이미 ${occupied.length}경기가 배치되어 있습니다.\n배치를 해제하고 레슨코트로 지정할까요?`))return;
      const{error:delErr}=await supabase.from("schedule_assignments")
        .delete()
        .eq("club_id",CURRENT_CLUB_ID)
        .eq("schedule_date",scheduleDate)
        .eq("court_no",nextCourt);
      if(delErr){alert("기존 경기 배치 해제 실패: "+delErr.message);return;}
    }
    const currentCourt=Number(scheduleDay?.lesson_court_no)||null;

    if(currentCourt!==nextCourt&&scheduleLessonParticipants.length){
      if(nextCourt){
        const{error:moveErr}=await supabase.from("schedule_lesson_participants")
          .update({court_no:nextCourt})
          .eq("club_id",CURRENT_CLUB_ID)
          .eq("schedule_date",scheduleDate);
        if(moveErr){alert("레슨 참가자 코트 이동 실패: "+moveErr.message);return;}
      }else{
        const{error:clearErr}=await supabase.from("schedule_lesson_participants")
          .delete()
          .eq("club_id",CURRENT_CLUB_ID)
          .eq("schedule_date",scheduleDate);
        if(clearErr){alert("레슨 참가자 배정 해제 실패: "+clearErr.message);return;}
      }
    }

    const{error}=await supabase.from("schedule_days").upsert({
      club_id:CURRENT_CLUB_ID,
      schedule_date:scheduleDate,
      lesson_court_no:nextCourt,
      updated_at:new Date().toISOString()
    },{onConflict:"club_id,schedule_date"});
    if(error){alert("레슨코트 저장 실패: "+error.message);return;}
    setLessonEditSlot(null);
    setLessonMemberId("");
    await loadSchedule(scheduleDate);
    flash(nextCourt?`${nextCourt}코트를 레슨코트로 지정했습니다.`:"레슨코트 지정을 해제했습니다.");
  }

  function openLessonEditor(slot,courtNo){
    if(!requireAdmin())return;
    setLessonMemberId("");
    setLessonEditSlot({slot,courtNo:Number(courtNo)});
  }

  async function addLessonParticipant(e){
    e?.preventDefault();
    if(!requireAdmin())return;
    if(!lessonEditSlot||!lessonMemberId)return alert("레슨 참가자를 선택해주세요.");

    const exists=scheduleLessonParticipants.some(x=>
      x.member_id===lessonMemberId&&
      String(x.start_time||"").slice(0,5)===lessonEditSlot.slot.start&&
      Number(x.court_no)===Number(lessonEditSlot.courtNo)
    );
    if(exists)return alert("이미 이 레슨 줄에 들어있는 참가자입니다.");

    const{error}=await supabase.from("schedule_lesson_participants").insert({
      club_id:CURRENT_CLUB_ID,
      schedule_date:scheduleDate,
      start_time:lessonEditSlot.slot.start,
      court_no:Number(lessonEditSlot.courtNo),
      member_id:lessonMemberId
    });
    if(error){alert("레슨 참가자 추가 실패: "+error.message);return;}

    setLessonMemberId("");
    await loadSchedule(scheduleDate);
    flash(`${lessonEditSlot.slot.label} 레슨 참가자를 추가했습니다.`);
  }

  async function removeLessonParticipant(id){
    if(!requireAdmin())return;
    const{error}=await supabase.from("schedule_lesson_participants").delete().eq("club_id",CURRENT_CLUB_ID).eq("id",id);
    if(error){alert("레슨 참가자 삭제 실패: "+error.message);return;}
    await loadSchedule(scheduleDate);
    flash("레슨 참가자를 삭제했습니다.");
  }

  async function assignScheduleMatch(matchId,slot,courtNo){
    if(!requireAdmin())return;
    if(!matchId)return alert("먼저 미배정 경기에서 배치할 경기를 선택해주세요.");
    if(Number(scheduleDay?.lesson_court_no)===Number(courtNo)){
      alert(`${courtNo}코트는 레슨코트입니다.`);
      return;
    }
    const occupied=scheduleAssignments.find(a=>
      String(a.start_time).slice(0,5)===slot.start&&Number(a.court_no)===Number(courtNo)&&a.match_id!==matchId
    );
    if(occupied){
      alert("해당 경기 순서/코트에는 이미 다른 경기가 배치되어 있습니다.");
      return;
    }

    const{error}=await supabase.from("schedule_assignments").upsert({
      club_id:CURRENT_CLUB_ID,
      match_id:matchId,
      schedule_date:scheduleDate,
      start_time:slot.start,
      end_time:slot.end,
      court_no:Number(courtNo),
      updated_at:new Date().toISOString()
    },{onConflict:"match_id"});
    if(error){alert("경기 배치 실패: "+error.message);return;}
    setScheduleSelectedMatchId(null);
    await loadSchedule(scheduleDate);
    flash(`${slot.label} · ${courtNo}코트에 배치했습니다.`);
  }

  async function removeScheduleAssignment(id){
    if(!requireAdmin())return;
    const{error}=await supabase.from("schedule_assignments").delete().eq("club_id",CURRENT_CLUB_ID).eq("id",id);
    if(error){alert("배치 해제 실패: "+error.message);return;}
    await loadSchedule(scheduleDate);
    flash("경기 배치를 해제했습니다.");
  }

  function openScheduledMatch(matchId){
    const match=historyMatches.find(m=>m.id===matchId);
    if(!match)return;
    if(match.winner){
      navigate("draw");
      return;
    }
    setFocusMatchId(matchId);
    navigate("schedule");
  }

  function scheduleTeamText(match,side){
    const ids=side==="A"
      ?[match.team_a_member_1,match.team_a_member_2]
      :[match.team_b_member_1,match.team_b_member_2];
    return ids.filter(Boolean).map(id=>memberMap[id]?.name||"").filter(Boolean).join(" / ");
  }

  async function loadClubFoundation(){
    if(!supabase)return;

    const membershipQuery=isAdmin
      ?supabase.from("club_memberships").select("*").order("created_at",{ascending:true})
      :Promise.resolve({data:[],error:null});

    const[
      {data:cData,error:cErr},
      {data:pData,error:pErr},
      {data:sData,error:sErr},
      {data:mData,error:mErr},
      {data:snapshotData,error:snapshotErr}
    ]=await Promise.all([
      supabase.from("clubs").select("*").order("name",{ascending:true}),
      supabase.from("club_membership_public").select("*").eq("club_id",CURRENT_CLUB_ID),
      supabase.from("club_site_settings").select("*").eq("club_id",CURRENT_CLUB_ID).maybeSingle(),
      membershipQuery,
      supabase.rpc("club_foundation_snapshot",{p_club_id:CURRENT_CLUB_ID})
    ]);

    const err=cErr||pErr||sErr||snapshotErr||(isAdmin?mErr:null);
    if(err){
      setClubFoundationLoaded(false);
      setClubFoundationError(err.message||"클럽 기반 정보를 불러오지 못했습니다.");
      console.error("Multi Club Foundation load failed",err);
      return;
    }

    setClubFoundationError("");
    setClubs(cData||[]);
    setClubPublicStatuses(pData||[]);
    setClubMemberships(isAdmin?(mData||[]):[]);
    setClubSiteSettings(sData||null);
    setClubFoundationSnapshot(snapshotData||null);
    setClubFoundationLoaded(true);
  }

  async function setCurrentClubMembership(memberId,status,active=true){
    if(!supabase||!memberId)return;
    const normalized=["regular","associate","guest"].includes(status)?status:"guest";
    const{data,error}=await supabase.rpc("admin_set_club_membership",{
      p_member_id:memberId,
      p_club_id:CURRENT_CLUB_ID,
      p_status:normalized,
      p_active:active!==false
    });
    if(error)throw error;
    return data;
  }

  async function loadMembers(){
    const{data,error}=await supabase
      .from("club_roster_directory")
      .select("*")
      .eq("club_id",CURRENT_CLUB_ID)
      .order("rating",{ascending:false});
    if(error){setDbConnected(false);console.error(error);return;}
    setDbConnected(true);
    setMembers(data||[]);
    writePublicCache({members:data||[]});
    setSelected(prev=>{
      const ids=(data||[]).filter(x=>x.active!==false).map(x=>x.id);
      return prev.filter(id=>ids.includes(id));
    });
  }

  async function loadHistory(){
    const[{data:sData,error:sErr},{data:mData,error:mErr},{data:eData,error:eErr}]=await Promise.all([
      supabase.from("sessions").select("*").eq("club_id",CURRENT_CLUB_ID).order("session_date",{ascending:false}).order("start_time",{ascending:false}),
      supabase.from("matches").select("*").eq("club_id",CURRENT_CLUB_ID).order("created_at",{ascending:false}),
      supabase.from("club_player_otr_timeline").select("*").eq("viewer_club_id",CURRENT_CLUB_ID).order("created_at",{ascending:true})
    ]);
    if(!sErr)setSessions(sData||[]);
    if(!mErr)setHistoryMatches(mData||[]);
    if(!eErr)setOtrEvents(eData||[]);
    writePublicCache({
      ...(!sErr?{sessions:sData||[]}:{}),
      ...(!mErr?{historyMatches:mData||[]}:{}),
      ...(!eErr?{otrEvents:eData||[]}:{}),
    });
  }


  async function loadSeasonData(){
    const[{data:ss},{data:hf}]=await Promise.all([
      supabase.from("seasons").select("*").eq("club_id",CURRENT_CLUB_ID).order("season_no",{ascending:true}),
      supabase.from("hall_of_fame").select("*").eq("club_id",CURRENT_CLUB_ID).order("created_at",{ascending:false})
    ]);
    const list=ss||[];
    setSeasons(list);setHall(hf||[]);
    writePublicCache({seasons:list,hall:hf||[]});
    const cur=list.find(x=>x.is_current)||list[list.length-1];
    if(cur){setCurrentSeasonId(cur.id);setSeasonView(v=>v||cur.id);}
  }

  async function loadClubPromo(){
    if(!supabase)return;
    const{data,error}=await supabase.from("club_promo").select("*").eq("club_id",CURRENT_CLUB_ID).eq("id",1).maybeSingle();
    if(error){
      console.error("클럽 홍보글 불러오기 실패",error);
      return;
    }
    if(data){
      const next={title:data.title||"WKTC",content:data.content||""};
      setClubPromo(next);
      setPromoForm(next);
      writePublicCache({clubPromo:next});
    }
  }

  async function saveClubPromo(e){
    e.preventDefault();
    if(!requireAdmin())return;
    const title=promoForm.title.trim();
    const content=promoForm.content.trim();
    if(!title||!content){
      alert("홍보글 제목과 내용을 입력해주세요.");
      return;
    }
    const{error}=await supabase.from("club_promo").upsert({
      club_id:CURRENT_CLUB_ID,id:1,title,content,updated_at:new Date().toISOString()
    },{onConflict:"club_id,id"});
    if(error){
      alert("홍보글 저장 실패: "+error.message);
      return;
    }
    await loadClubPromo();
    flash("클럽 홍보글을 저장했습니다.");
  }

  async function loadClubEvents(){
    if(!supabase)return;
    const{data,error}=await supabase
      .from("club_events")
      .select("*")
      .eq("club_id",CURRENT_CLUB_ID)
      .order("event_date",{ascending:true})
      .order("created_at",{ascending:true});
    if(error){
      console.error("경기 행사 불러오기 실패",error);
      return;
    }
    setClubEvents(data||[]);
    writePublicCache({clubEvents:data||[]});
  }

  async function addClubEvent(e){
    e.preventDefault();
    if(!requireAdmin())return;
    const title=eventForm.title.trim();
    if(!eventForm.date||!title){
      alert("행사 날짜와 행사명을 입력해주세요.");
      return;
    }

    let error;
    if(eventForm.id){
      ({error}=await supabase.from("club_events").update({
        event_date:eventForm.date,
        title,
        details:eventForm.details.trim()||null
      }).eq("club_id",CURRENT_CLUB_ID).eq("id",eventForm.id));
    }else{
      ({error}=await supabase.from("club_events").insert({
        club_id:CURRENT_CLUB_ID,
        event_date:eventForm.date,
        title,
        details:eventForm.details.trim()||null
      }));
    }

    if(error){
      alert((eventForm.id?"행사 수정 실패: ":"행사 저장 실패: ")+error.message);
      return;
    }

    const wasEditing=!!eventForm.id;
    setEventForm({id:null,date:eventForm.date,title:"",details:""});
    await loadClubEvents();
    flash(wasEditing?"클럽 행사를 수정했습니다.":"클럽 행사를 등록했습니다.");
  }

  function editClubEvent(ev){
    if(!requireAdmin())return;
    setEventForm({
      id:ev.id,
      date:ev.event_date,
      title:ev.title||"",
      details:ev.details||""
    });
  }

  function cancelClubEventEdit(){
    setEventForm({id:null,date:new Date().toISOString().slice(0,10),title:"",details:""});
  }

  async function deleteClubEvent(id){
    if(!requireAdmin())return;
    if(!confirm("이 경기 행사를 삭제할까요?"))return;
    const{error}=await supabase.from("club_events").delete().eq("club_id",CURRENT_CLUB_ID).eq("id",id);
    if(error){
      alert("행사 삭제 실패: "+error.message);
      return;
    }
    await loadClubEvents();
    flash("경기 행사를 삭제했습니다.");
  }

  async function authenticateMemberPin(){
    const pin=String(memberPin||"").trim();
    if(!/^\d{4}$/.test(pin)){
      alert("개인 PIN은 숫자 4자리로 입력해주세요.");
      return null;
    }
    const{data,error}=await supabase.rpc("member_login_for_club",{p_pin:pin,p_club_id:CURRENT_CLUB_ID});
    if(error||!data?.member_id){
      alert("WKTC 개인 PIN이 올바르지 않거나 아직 설정되지 않았습니다.");
      return null;
    }
    const identity={member_id:data.member_id,name:data.name};
    sessionStorage.setItem("wktcPersonalMemberPinV2",pin);
    sessionStorage.setItem("wktcMemberIdentityV2",JSON.stringify(identity));
    sessionStorage.removeItem("wktcMemberPin");
    sessionStorage.removeItem("wktcMemberUnlocked");
    setMemberPin(pin);
    setMemberIdentity(identity);
    setMemberUnlocked(true);
    return identity;
  }

  function clearMemberAccess(){
    sessionStorage.removeItem("wktcPersonalMemberPinV2");
    sessionStorage.removeItem("wktcMemberIdentityV2");
    sessionStorage.removeItem("wktcMemberPin");
    sessionStorage.removeItem("wktcMemberUnlocked");
    setMemberPin("");
    setMemberIdentity(null);
    setMemberUnlocked(false);
    setOpenPickMyPicks({});
    setMyPageData({member:null,rackets:[],memo:""});
    setMyMemo("");
    setMyStringForms({});
    setFinanceCharges([]);setFinancePayments([]);setFinanceTransactions([]);
    setMobileMenuOpen(false);
    flash("회원 인증을 해제했습니다.");
  }

  async function unlockMemberMode(e){
    e?.preventDefault();
    const identity=await authenticateMemberPin();
    if(!identity)return;
    flash(`${identity.name}님으로 회원 인증되었습니다.`);
  }

  async function loadFinance(pinOverride=null){
    if(!supabase)return;
    setFinanceBusy(true);
    try{
      if(isAdmin){
        const[{data:c,error:ce},{data:p,error:pe},{data:t,error:te}]=await Promise.all([
          supabase.from("finance_charges").select("*").eq("club_id",CURRENT_CLUB_ID).order("charge_date",{ascending:false}),
          supabase.from("finance_payments").select("*").eq("club_id",CURRENT_CLUB_ID).order("payment_date",{ascending:false}),
          supabase.from("finance_transactions").select("*").eq("club_id",CURRENT_CLUB_ID).order("transaction_date",{ascending:false}).order("created_at",{ascending:false})
        ]);
        if(ce)throw ce;if(pe)throw pe;if(te)throw te;
        setFinanceCharges(c||[]);setFinancePayments(p||[]);setFinanceTransactions(t||[]);
      }else{
        const pin=pinOverride||memberPin;
        if(memberUnlocked&&pin){
          const{data,error}=await supabase.rpc("member_read_finance_for_club",{p_pin:pin,p_club_id:CURRENT_CLUB_ID});
          if(error)throw error;
          setFinanceCharges(data?.charges||[]);
          setFinancePayments(data?.payments||[]);
          setFinanceTransactions(data?.transactions||[]);
        }
      }
    }catch(err){
      console.error(err);
      if(tab==="accounting")alert("회계 정보를 불러오지 못했습니다: "+err.message);
    }finally{
      setFinanceBusy(false);
    }
  }

  async function unlockAccounting(e){
    e?.preventDefault();
    const identity=await authenticateMemberPin();
    if(!identity)return;
    await loadFinance(String(memberPin||"").trim());
    flash(`${identity.name}님 회계 열람 권한이 확인되었습니다.`);
  }

  async function loadMemberPinStatus(){
    if(!supabase||!isAdmin)return;
    const{data,error}=await supabase.rpc("admin_member_pin_status_for_club",{p_club_id:CURRENT_CLUB_ID});
    if(error){console.error("회원 PIN 상태 조회 실패",error);return;}
    setMemberPinStatus(Object.fromEntries((data||[]).map(x=>[x.member_id,!!x.has_pin])));
  }

  function openMemberPinEditor(member){
    if(!requireAdmin())return;
    if(publicMemberType(member)!=="member"){
      alert("개인 PIN은 이 클럽의 정회원 또는 준회원에게 설정할 수 있습니다.");
      return;
    }
    setPinEditMember(member);
    setPersonalPinForm({pin:"",confirm:""});
  }

  async function saveMemberPersonalPin(e){
    e.preventDefault();
    if(!pinEditMember||!requireAdmin())return;
    const pin=personalPinForm.pin.trim();
    if(!/^\d{4}$/.test(pin)){
      alert("개인 PIN은 3212 또는 9873처럼 숫자 4자리로 설정해주세요.");
      return;
    }
    if(pin!==personalPinForm.confirm.trim()){
      alert("PIN 확인 값이 일치하지 않습니다.");
      return;
    }
    setPersonalPinBusy(true);
    const{error}=await supabase.rpc("admin_set_member_pin_for_club",{
      p_club_id:CURRENT_CLUB_ID,
      p_member_id:pinEditMember.id,
      p_new_pin:pin
    });
    setPersonalPinBusy(false);
    if(error){alert("개인 PIN 설정 실패: "+error.message);return;}
    const name=pinEditMember.name;
    setPinEditMember(null);
    setPersonalPinForm({pin:"",confirm:""});
    await loadMemberPinStatus();
    flash(`${name} 회원의 WKTC 전용 PIN을 설정했습니다.`);
  }

  async function loadOpenPick(pinOverride=null){
    if(!supabase||!currentSeasonId)return;
    setOpenPickBusy(true);
    try{
      const publicReq=supabase.rpc("open_pick_public_state_for_club",{
        p_club_id:CURRENT_CLUB_ID,p_season_id:currentSeasonId
      });
      const pin=pinOverride||memberPin;
      const memberReq=(memberUnlocked&&pin)
        ?supabase.rpc("open_pick_member_picks_for_club",{
          p_pin:pin,p_club_id:CURRENT_CLUB_ID,p_season_id:currentSeasonId
        })
        :Promise.resolve({data:null,error:null});
      const[{data:pub,error:pubErr},{data:mine,error:mineErr}]=await Promise.all([publicReq,memberReq]);
      if(pubErr)throw pubErr;
      if(mineErr)throw mineErr;
      setOpenPickPublic(pub||{leaderboard:[],match_stats:[]});
      setOpenPickMyPicks(Object.fromEntries((mine?.picks||[]).map(x=>[x.match_id,x.pick])));
      if(mine?.member?.member_id&&!memberIdentity){
        const identity={member_id:mine.member.member_id,name:mine.member.name};
        setMemberIdentity(identity);
      }
    }catch(err){
      console.error("OPEN PICK 불러오기 실패",err);
      if(tab==="openpick")alert("OPEN PICK 정보를 불러오지 못했습니다: "+err.message);
    }finally{setOpenPickBusy(false);}
  }

  async function unlockOpenPick(e){
    e?.preventDefault();
    const identity=await authenticateMemberPin();
    if(!identity)return;
    await loadOpenPick(String(memberPin||"").trim());
    flash(`${identity.name}님 OPEN PICK 인증 완료`);
  }

  async function saveOpenPick(matchId,pick){
    if(!memberUnlocked||!memberPin){
      alert("먼저 본인의 개인 PIN 4자리로 인증해주세요.");
      return;
    }
    setOpenPickSavingMatchId(matchId);
    const{error}=await supabase.rpc("open_pick_save_for_club",{
      p_pin:memberPin,p_club_id:CURRENT_CLUB_ID,p_match_id:matchId,p_pick:pick
    });
    setOpenPickSavingMatchId(null);
    if(error){
      alert("PICK 저장 실패: "+error.message);
      return;
    }
    setOpenPickMyPicks(prev=>({...prev,[matchId]:pick}));
    await loadOpenPick();
    flash("PICK을 저장했습니다. 경기 시작 전까지 변경할 수 있습니다.");
  }

  async function loadMyPage(pinOverride=null){
    if(!supabase)return;
    const pin=String(pinOverride||memberPin||"").trim();
    if(!/^\d{4}$/.test(pin))return;
    setMyPageBusy(true);
    try{
      const{data,error}=await supabase.rpc("member_personal_page_for_club",{p_pin:pin,p_club_id:CURRENT_CLUB_ID});
      if(error)throw error;
      const next={member:data?.member||null,rackets:data?.rackets||[],memo:data?.memo||""};
      setMyPageData(next);
      setMyMemo(next.memo);
      if(data?.member?.member_id&&!memberIdentity){
        setMemberIdentity({member_id:data.member.member_id,name:data.member.name});
      }
    }catch(err){
      console.error("MY PAGE 불러오기 실패",err);
      if(tab==="mypage"){
        const msg=String(err?.message||"");
        if(msg.toLowerCase().includes("invalid personal pin")){
          alert("이 회원의 WKTC 개인 PIN 연결을 확인할 수 없습니다. 관리자에게 회원 목록에서 WKTC PIN을 다시 설정해달라고 요청해주세요.");
        }else{
          alert("MY PAGE 정보를 불러오지 못했습니다: "+msg);
        }
      }
    }finally{setMyPageBusy(false);}
  }

  async function unlockMyPage(e){
    e?.preventDefault();
    const identity=await authenticateMemberPin();
    if(!identity)return;
    await loadMyPage(String(memberPin||"").trim());
    flash(`${identity.name}님의 MY PAGE를 열었습니다.`);
  }

  async function addMyRacket(e){
    e.preventDefault();
    const name=myRacketName.trim();
    if(!name){alert("라켓 이름이나 모델명을 입력해주세요.");return;}
    setMyPageSaving(true);
    const{error}=await supabase.rpc("member_add_racket_for_club",{p_pin:memberPin,p_club_id:CURRENT_CLUB_ID,p_racket_name:name});
    setMyPageSaving(false);
    if(error){
      const msg=String(error.message||"");
      if(msg.toLowerCase().includes("invalid personal pin")){
        alert("라켓 추가 실패: WKTC 개인 PIN 연결이 없습니다. 관리자에게 회원 목록에서 PIN을 다시 설정해주세요.");
      }else{
        alert("라켓 추가 실패: "+msg);
      }
      return;
    }
    setMyRacketName("");
    await loadMyPage();
    flash("라켓을 MY PAGE에 추가했습니다.");
  }

  async function renameMyRacket(racket){
    const next=prompt("라켓 이름 또는 모델명을 입력하세요.",racket.racket_name||"");
    if(next===null)return;
    const name=next.trim();
    if(!name)return;
    const{error}=await supabase.rpc("member_rename_racket_for_club",{p_pin:memberPin,p_club_id:CURRENT_CLUB_ID,p_racket_id:racket.id,p_racket_name:name});
    if(error){alert("라켓 이름 변경 실패: "+error.message);return;}
    await loadMyPage();
    flash("라켓 이름을 변경했습니다.");
  }

  async function deleteMyRacket(racket){
    if(!confirm(`${racket.racket_name} 라켓과 연결된 스트링 기록을 모두 삭제할까요?`))return;
    const{error}=await supabase.rpc("member_delete_racket_for_club",{p_pin:memberPin,p_club_id:CURRENT_CLUB_ID,p_racket_id:racket.id});
    if(error){alert("라켓 삭제 실패: "+error.message);return;}
    await loadMyPage();
    flash("라켓을 삭제했습니다.");
  }

  function myStringForm(racketId){
    return myStringForms[racketId]||{string_name:"",tension:"",strung_date:localIsoDate(new Date()),note:""};
  }

  function updateMyStringForm(racketId,key,value){
    setMyStringForms(prev=>({
      ...prev,
      [racketId]:{...myStringForm(racketId),[key]:value}
    }));
  }

  async function addMyStringRecord(e,racketId){
    e.preventDefault();
    const f=myStringForm(racketId);
    if(!f.string_name.trim()||!f.tension.trim()||!f.strung_date){
      alert("스트링, 텐션, 작업 날짜를 입력해주세요.");
      return;
    }
    setMyPageSaving(true);
    const{error}=await supabase.rpc("member_add_string_record_for_club",{
      p_pin:memberPin,
      p_club_id:CURRENT_CLUB_ID,
      p_racket_id:racketId,
      p_string_name:f.string_name.trim(),
      p_tension:f.tension.trim(),
      p_strung_date:f.strung_date,
      p_note:f.note.trim()||null
    });
    setMyPageSaving(false);
    if(error){alert("스트링 기록 저장 실패: "+error.message);return;}
    setMyStringForms(prev=>({...prev,[racketId]:{string_name:"",tension:"",strung_date:localIsoDate(new Date()),note:""}}));
    await loadMyPage();
    flash("스트링 기록을 저장했습니다.");
  }

  async function deleteMyStringRecord(recordId){
    if(!confirm("이 스트링 기록을 삭제할까요?"))return;
    const{error}=await supabase.rpc("member_delete_string_record_for_club",{p_pin:memberPin,p_club_id:CURRENT_CLUB_ID,p_record_id:recordId});
    if(error){alert("스트링 기록 삭제 실패: "+error.message);return;}
    await loadMyPage();
    flash("스트링 기록을 삭제했습니다.");
  }

  async function saveMyMemo(){
    setMyPageSaving(true);
    const{error}=await supabase.rpc("member_save_private_memo_for_club",{p_pin:memberPin,p_club_id:CURRENT_CLUB_ID,p_memo:myMemo});
    setMyPageSaving(false);
    if(error){alert("메모 저장 실패: "+error.message);return;}
    setMyPageData(prev=>({...prev,memo:myMemo}));
    flash("개인 메모를 저장했습니다.");
  }

  async function generateVktcMonthlyDues(e){
    e?.preventDefault();
    if(!requireAdmin())return;
    if(!/^\d{4}-\d{2}$/.test(monthlyFeeMonth)){
      alert("회비 월을 선택해주세요.");
      return;
    }
    const{data,error}=await supabase.rpc("wktc_generate_monthly_dues",{
      p_month:`${monthlyFeeMonth}-01`
    });
    if(error){
      alert("월회비 생성 실패: "+error.message);
      return;
    }
    await loadFinance();
    flash(`${monthlyFeeMonth} 월회비 $30 · ${Number(data?.created||0)}명 청구를 생성했습니다.`);
  }

  async function addAttendanceBatch(e){
    e.preventDefault();
    if(!requireAdmin())return;

    const selectedIds=attendanceForm.selected.filter(id=>{
      const member=memberMap[id];
      return member&&publicMemberType(member)==="guest";
    });
    if(!selectedIds.length){
      alert("게스트를 한 명 이상 선택해주세요.");
      return;
    }

    const alreadyRecorded=new Set(
      financeCharges
        .filter(x=>x.charge_date===attendanceForm.date&&Number(x.amount)===15)
        .map(x=>x.member_id)
    );
    const newIds=selectedIds.filter(id=>!alreadyRecorded.has(id));
    const skipped=selectedIds.length-newIds.length;

    if(!newIds.length){
      alert("선택한 게스트는 모두 이 날짜에 이미 참가비 기록이 있습니다.");
      return;
    }

    const chargeRows=[];
    const paymentRows=[];
    const transactionRows=[];

    for(const id of newIds){
      const member=memberMap[id];
      const amount=15;
      const note=attendanceForm.note.trim()||"WKTC 게스트 참가비";

      chargeRows.push({
        club_id:CURRENT_CLUB_ID,
        member_id:id,
        charge_date:attendanceForm.date,
        amount,
        note
      });

      if(attendanceForm.received[id]!==false){
        paymentRows.push({
          club_id:CURRENT_CLUB_ID,
          member_id:id,
          payment_date:attendanceForm.date,
          amount,
          note
        });
        transactionRows.push({
          club_id:CURRENT_CLUB_ID,
          transaction_date:attendanceForm.date,
          type:"income",
          category:"게스트 참가비",
          amount,
          note:`${member.name} ${note}`,
          member_id:id
        });
      }
    }

    const{error:cErr}=await supabase.from("finance_charges").insert(chargeRows);
    if(cErr){alert("게스트 참가비 청구 저장 실패: "+cErr.message);return;}

    if(paymentRows.length){
      const{error:pErr}=await supabase.from("finance_payments").insert(paymentRows);
      if(pErr){alert("게스트 참가비 수납 저장 실패: "+pErr.message);return;}
    }

    if(transactionRows.length){
      const{error:tErr}=await supabase.from("finance_transactions").insert(transactionRows);
      if(tErr){alert("게스트 참가비 수입 저장 실패: "+tErr.message);return;}
    }

    setAttendanceForm({
      date:attendanceForm.date,
      selected:[],
      amounts:{},
      received:{},
      note:""
    });
    await loadFinance();
    flash(`${newIds.length}명의 게스트 참가비 $15 기록을 저장했습니다.${skipped?` 중복 ${skipped}명 제외`:""}`);
  }

  function toggleAttendanceMember(member,checked){
    if(publicMemberType(member)!=="guest")return;
    setAttendanceForm(prev=>({
      ...prev,
      selected:checked?[...new Set([...prev.selected,member.id])]:prev.selected.filter(id=>id!==member.id),
      amounts:{...prev.amounts,[member.id]:15},
      received:{...prev.received,[member.id]:checked?(prev.received[member.id]??true):false}
    }));
  }

  function toggleAllAttendance(checked){
    setAttendanceForm(prev=>{
      if(!checked)return{...prev,selected:[],received:{}};
      const guests=activeMembers.filter(m=>publicMemberType(m)==="guest");
      const selected=guests.map(m=>m.id);
      const amounts={...prev.amounts};
      const received={...prev.received};
      for(const m of guests){
        amounts[m.id]=15;
        if(received[m.id]===undefined)received[m.id]=true;
      }
      return{...prev,selected,amounts,received};
    });
  }


  async function saveFinanceChargeAmount(charge){
    if(!requireAdmin())return;
    const amount=Number(editingChargeAmount);
    if(!Number.isFinite(amount)||amount<0){
      alert("금액을 확인해주세요.");
      return;
    }
    const{error}=await supabase.from("finance_charges").update({amount}).eq("club_id",CURRENT_CLUB_ID).eq("id",charge.id);
    if(error){
      alert("회비 금액 수정 실패: "+error.message);
      return;
    }
    setEditingChargeId(null);
    setEditingChargeAmount("");
    await loadFinance();
    flash("회비 발생 금액을 수정했습니다.");
  }

  async function settleMemberDues(memberId){
    if(!requireAdmin())return;
    const member=memberMap[memberId];
    if(!member)return;

    const dueRow=memberDues.find(x=>x.member.id===memberId);
    const due=Number(dueRow?.due||0);
    const isGuest=publicMemberType(member)==="guest";
    if(!(due>0)){
      alert(`${member.name}님의 결제 대기 금액이 없습니다.`);
      return;
    }

    const amount=due;
    const label=isGuest?"게스트 참가비":"월회비";
    if(!confirm(`${member.name}님에게서 ${label} $${amount.toFixed(2)}을 받은 것으로 처리할까요?`))return;

    const paymentDate=localIsoDate(new Date());
    const{error:pErr}=await supabase.from("finance_payments").insert({
      club_id:CURRENT_CLUB_ID,
      member_id:member.id,
      payment_date:paymentDate,
      amount,
      note:`WKTC ${label} $${amount.toFixed(2)} 수납`
    });
    if(pErr){alert(label+" 수납 저장 실패: "+pErr.message);return;}

    const{error:tErr}=await supabase.from("finance_transactions").insert({
      club_id:CURRENT_CLUB_ID,
      transaction_date:paymentDate,
      type:"income",
      category:isGuest?"게스트 참가비":"회원 월회비",
      amount,
      note:`${member.name} ${label} $${amount.toFixed(2)} 수납`,
      member_id:member.id
    });
    if(tErr){alert("수입 저장 실패: "+tErr.message);return;}

    await loadFinance();
    flash(`${member.name} ${label} $${amount.toFixed(2)} 수납을 기록했습니다.`);
  }


  async function addFinanceTransaction(e){
    e.preventDefault();
    if(!requireAdmin())return;
    const amount=Number(transactionForm.amount);
    if(!(amount>0))return alert("금액을 확인해주세요.");
    const{error}=await supabase.from("finance_transactions").insert({
      club_id:CURRENT_CLUB_ID,
      transaction_date:transactionForm.date,type:transactionForm.type,
      category:transactionForm.category.trim()||"기타",amount,
      note:transactionForm.note.trim()||null,member_id:null
    });
    if(error){alert("거래 저장 실패: "+error.message);return;}
    setTransactionForm(f=>({...f,amount:"",note:""}));
    await loadFinance();
    flash("수입/지출 내역을 저장했습니다.");
  }

  async function deleteFinanceTransaction(id){
    if(!requireAdmin())return;
    if(!confirm("이 수입/지출 내역을 삭제할까요?"))return;
    const{error}=await supabase.from("finance_transactions").delete().eq("club_id",CURRENT_CLUB_ID).eq("id",id);
    if(error){alert(error.message);return;}
    await loadFinance();
  }


  function seasonStats(seasonId){
    const ss=sessions.filter(x=>x.season_id===seasonId&&x.match_type==="season");
    const ids=new Set(ss.map(x=>x.id));
    const completed=historyMatches.filter(m=>ids.has(m.session_id)&&m.winner&&m.score_a!=null&&m.score_b!=null);
    const stats={};
    for(const m of activeMembers)stats[m.id]={member:m,games:0,wins:0,losses:0};
    for(const m of completed){
      const a=[m.team_a_member_1,m.team_a_member_2].filter(Boolean);
      const b=[m.team_b_member_1,m.team_b_member_2].filter(Boolean);
      const credited=[
        m.season_credit_a1!==false?m.team_a_member_1:null,
        m.season_credit_a2!==false?m.team_a_member_2:null,
        m.season_credit_b1!==false?m.team_b_member_1:null,
        m.season_credit_b2!==false?m.team_b_member_2:null
      ].filter(Boolean);

      for(const id of credited){
        if(!stats[id]&&memberMap[id])stats[id]={member:memberMap[id],games:0,wins:0,losses:0};
        if(!stats[id])continue;
        const won=m.winner==="A"?a.includes(id):b.includes(id);
        stats[id].games++;stats[id].wins+=won?1:0;stats[id].losses+=won?0:1;
      }
    }
    return Object.values(stats).map(x=>{
      const wr=x.games?x.wins/x.games:0;
      return {...x,winRate:wr,seasonPoints:Math.round(x.wins*(1+wr)*100)/10};
    }).sort((a,b)=>b.seasonPoints-a.seasonPoints||b.wins-a.wins||b.winRate-a.winRate||b.games-a.games);
  }

  async function addHallEntry(e){
    e.preventDefault();if(!requireAdmin())return;
    if(!hallForm.season_id||!hallForm.champion_name.trim())return;
    const{error}=await supabase.from("hall_of_fame").upsert({
      season_id:hallForm.season_id,champion_name:hallForm.champion_name.trim(),
      runner_up_name:hallForm.runner_up_name.trim()||null
    },{onConflict:"season_id"});
    if(error){alert(error.message);return;}
    setHallForm({season_id:"",champion_name:"",runner_up_name:""});await loadSeasonData();flash("명예의 전당이 업데이트되었습니다.");
  }

  async function signIn(e){
    e.preventDefault();
    if(loginBusy)return;
    setLoginBusy(true);
    setLoginError("");

    if(!supabase){
      setLoginBusy(false);
      setLoginError(
        `Supabase 환경변수 감지 실패 · URL: ${supabaseConfigStatus.hasUrl?"감지됨":"없음"} · KEY: ${supabaseConfigStatus.hasKey?"감지됨":"없음"}${supabaseConfigStatus.keySource?` (${supabaseConfigStatus.keySource})`:""}`
      );
      return;
    }

    try{
      const{data,error}=await withTimeout(
        supabase.auth.signInWithPassword({
          email:loginForm.email.trim(),
          password:loginForm.password
        }),
        15000,
        "로그인 서버 응답이 지연되고 있습니다. 잠시 후 다시 시도해주세요."
      );

      if(error){
        setLoginError("로그인 실패: 이메일 또는 비밀번호를 확인하세요.");
        return;
      }

      const signedUser=data?.user||data?.session?.user||null;
      if(!signedUser){
        setLoginError("로그인 세션을 만들지 못했습니다. 다시 시도해주세요.");
        return;
      }

      setUser(signedUser);
      setAdminAccessReady(false);

      const{data:accessData,error:accessError}=await withTimeout(
        supabase.rpc("club_admin_access",{
          p_club_id:CURRENT_CLUB_ID,
          p_allow_bootstrap:false
        }),
        15000,
        "WKTC 관리자 권한 확인 응답이 지연되고 있습니다."
      );

      if(accessError)throw accessError;

      const access=accessData||{allowed:false,system_admin:false};
      if(!access.allowed){
        try{
          await withTimeout(supabase.auth.signOut(),5000,"");
        }catch{}
        setUser(null);
        setClubAdminAccess(null);
        setAdminAccessReady(true);
        setLoginError("이 계정에는 WKTC 관리자 권한이 없습니다.");
        return;
      }

      setClubAdminAccess(access);
      setAdminAccessReady(true);
      setLoginOpen(false);
      setLoginForm({email:"",password:""});
      flash("WKTC 관리자 모드로 전환되었습니다.");
    }catch(err){
      setAdminAccessReady(true);
      setLoginError("관리자 로그인 확인 실패: "+(err?.message||"알 수 없는 오류"));
    }finally{
      setLoginBusy(false);
    }
  }
  async function signOut(){
    await supabase.auth.signOut();
    setUser(null);
    setClubAdminAccess(null);
    setAdminAccessReady(true);
    navigate("home",null,true);
    flash("관리자 로그아웃되었습니다.");
  }

  async function changeAdminPassword(e){
    e.preventDefault();
    if(!supabase||!user?.email||!isAdmin)return;

    const current=adminPasswordForm.current;
    const next=adminPasswordForm.next;
    const confirm=adminPasswordForm.confirm;

    setAdminPasswordError("");

    if(!current||!next||!confirm){
      setAdminPasswordError("현재 비밀번호와 새 비밀번호를 모두 입력해주세요.");
      return;
    }
    if(next.length<8){
      setAdminPasswordError("새 비밀번호는 8자 이상으로 설정해주세요.");
      return;
    }
    if(next!==confirm){
      setAdminPasswordError("새 비밀번호 확인이 일치하지 않습니다.");
      return;
    }
    if(current===next){
      setAdminPasswordError("현재 비밀번호와 다른 새 비밀번호를 입력해주세요.");
      return;
    }

    setAdminPasswordBusy(true);
    try{
      const{error:verifyError}=await supabase.auth.signInWithPassword({
        email:user.email,
        password:current
      });
      if(verifyError){
        setAdminPasswordError("현재 비밀번호가 맞지 않습니다.");
        return;
      }

      const{error:updateError}=await supabase.auth.updateUser({password:next});
      if(updateError)throw updateError;

      setAdminPasswordForm({current:"",next:"",confirm:""});
      await supabase.auth.signOut();
      setUser(null);
      setClubAdminAccess(null);
      setAdminAccessReady(true);
      navigate("home",null,true);
      setLoginOpen(true);
      flash("관리자 비밀번호가 변경되었습니다. 새 비밀번호로 다시 로그인해주세요.");
    }catch(err){
      setAdminPasswordError("비밀번호 변경 실패: "+(err?.message||"알 수 없는 오류"));
    }finally{
      setAdminPasswordBusy(false);
    }
  }

  async function searchGlobalPlayers(e){
    e?.preventDefault();
    if(!requireAdmin())return;
    const q=globalPlayerSearch.trim();
    if(q.length<2){
      alert("이름을 2글자 이상 입력해주세요.");
      return;
    }
    setGlobalPlayerSearchBusy(true);
    const{data,error}=await supabase
      .from("global_player_directory")
      .select("member_id,name,gender,rating,primary_club_id,primary_club_name,primary_club_short_name")
      .ilike("name",`%${q}%`)
      .order("name",{ascending:true})
      .limit(30);
    setGlobalPlayerSearchBusy(false);
    if(error){
      alert("공용 선수 검색 실패: "+error.message);
      return;
    }
    const localIds=new Set(members.map(m=>m.id));
    setGlobalPlayerResults((data||[]).filter(x=>!localIds.has(x.member_id)));
  }

  async function linkGlobalPlayerToVktc(player,status){
    if(!requireAdmin())return;
    const label=status==="regular"?"정회원":status==="associate"?"준회원":"게스트";
    const{error}=await supabase.rpc("admin_set_club_membership",{
      p_member_id:player.member_id,
      p_club_id:CURRENT_CLUB_ID,
      p_status:status,
      p_active:true
    });
    if(error){
      alert(`${label} 등록 실패: `+error.message);
      return;
    }
    await Promise.all([loadMembers(),loadClubFoundation()]);
    setGlobalPlayerResults(rows=>rows.filter(x=>x.member_id!==player.member_id));
    flash(`${player.name} 선수를 WKTC ${label}으로 연결했습니다.`);
  }

  async function addMember(e){
    e.preventDefault();
    if(!requireAdmin()||!form.name.trim())return;

    const status=form.membership_status||"regular";
    const rating=Number(form.rating);
    if(!Number.isFinite(rating)){
      alert("시작 OTR을 확인해주세요.");
      return;
    }

    const{data,error}=await supabase.rpc("admin_create_player_for_club",{
      p_club_id:CURRENT_CLUB_ID,
      p_name:form.name.trim(),
      p_gender:form.gender,
      p_rating:rating,
      p_status:status
    });
    if(error){
      alert("선수 추가 실패: "+error.message);
      return;
    }

    await Promise.all([loadMembers(),loadClubFoundation()]);
    setForm({name:"",gender:"M",rating:1000,membership_status:"regular"});
    const label=status==="regular"?"정회원":status==="associate"?"준회원":"게스트";
    flash(`${data?.name||form.name.trim()} ${label}을(를) 추가했습니다.`);
  }

  async function deactivateMember(id){
    if(!requireAdmin())return;
    const member=members.find(m=>m.id===id);
    if(!member)return;
    if(!confirm(`${member.name}을(를) WKTC에서 비활동 상태로 변경할까요?
다른 클럽의 소속/활동 상태와 글로벌 OTR은 영향을 받지 않습니다.`))return;

    try{
      const status=currentClubMembershipStatus(id);
      await setCurrentClubMembership(id,status,false);
    }catch(err){
      alert("비활성화 실패: "+err.message);
      return;
    }

    setSelected(x=>x.filter(v=>v!==id));
    await Promise.all([loadMembers(),loadClubFoundation()]);
    flash("WKTC에서 비활동 상태로 변경했습니다.");
  }

  async function reactivateMember(id){
    if(!requireAdmin())return;
    const member=members.find(m=>m.id===id);
    if(!member)return;

    try{
      const row=currentClubMembershipRow(id);
      const status=row?.membership_type==="associate"
        ?"associate"
        :row?.membership_type==="regular"
          ?"regular"
          :"guest";
      await setCurrentClubMembership(id,status,true);
    }catch(err){
      alert("활동 복구 실패: "+err.message);
      return;
    }

    await Promise.all([loadMembers(),loadClubFoundation()]);
    flash("WKTC 활동 선수로 복구했습니다.");
  }


  async function permanentlyDeleteInactiveMember(id){
    if(!requireAdmin())return;
    const member=members.find(m=>m.id===id);
    if(!member||member.active!==false)return;

    if(!confirm(`${member.name}을(를) WKTC 선수 목록에서 제거할까요?

공용 선수 DB 자체는 삭제하지 않습니다.
다른 클럽의 소속, 글로벌 OTR, 다른 클럽 경기 기록은 그대로 유지됩니다.
WKTC 과거 기록이 있는 선수는 기록 보존을 위해 제거가 거부됩니다.`))return;

    const{error}=await supabase.rpc("admin_remove_player_from_club",{
      p_member_id:id,
      p_club_id:CURRENT_CLUB_ID
    });
    if(error){
      alert("목록 제거 실패: "+error.message);
      return;
    }

    await Promise.all([loadMembers(),loadClubFoundation()]);
    flash("WKTC 선수 목록에서 제거했습니다. 공용 선수 데이터는 유지됩니다.");
  }

  function startEditMember(member){
    if(!requireAdmin())return;
    setEditingMember(member);
    setEditMemberForm({
      name:member.name,
      rating:member.rating,
      membership_status:currentClubMembershipStatus(member.id)
    });
  }

  async function saveMemberEdit(e){
    e.preventDefault();
    if(!editingMember||!requireAdmin())return;
    const newRating=Number(editMemberForm.rating);
    if(!editMemberForm.name.trim()||!Number.isFinite(newRating))return;

    const{error}=await supabase.rpc("admin_update_player_for_club",{
      p_club_id:CURRENT_CLUB_ID,
      p_member_id:editingMember.id,
      p_name:editMemberForm.name.trim(),
      p_rating:newRating,
      p_status:editMemberForm.membership_status
    });
    if(error){
      alert("회원 수정 실패: "+error.message);
      return;
    }

    setEditingMember(null);
    await Promise.all([loadMembers(),loadHistory(),loadClubFoundation()]);
    flash("회원 정보가 수정되었습니다.");
  }

  function addManualMatch(){
    setManualMatches(ms=>[...ms,{a1:"",a2:"",b1:"",b2:""}]);
  }

  function removeManualMatch(index){
    setManualMatches(ms=>ms.filter((_,i)=>i!==index));
  }

  function updateManualMatch(index,key,value){
    setManualMatches(ms=>ms.map((m,i)=>i===index?{...m,[key]:value}:m));
  }

  function manualDrawObjects(){
    const chosenIds=new Set();
    const rows=[];
    for(let i=0;i<manualMatches.length;i++){
      const m=manualMatches[i];

      if(matchFormat==="singles"){
        const ids=[m.a1,m.b1];
        if(ids.some(x=>!x))throw new Error(`${i+1}번째 단식 경기에서 2명을 모두 선택해주세요.`);
        if(new Set(ids).size!==2)throw new Error(`${i+1}번째 경기에서 같은 선수를 두 번 선택할 수 없습니다.`);
        for(const id of ids){
          if(chosenIds.has(id))throw new Error(`한 대진표 안에서 같은 선수가 두 경기 이상 배정되어 있습니다.`);
          chosenIds.add(id);
        }
        const a=[memberMap[m.a1]],b=[memberMap[m.b1]];
        if(a.some(x=>!x)||b.some(x=>!x))throw new Error("선수 정보를 찾을 수 없습니다.");
        rows.push({a,b});
      }else{
        const ids=[m.a1,m.a2,m.b1,m.b2];
        if(ids.some(x=>!x))throw new Error(`${i+1}번째 복식 경기에서 4명을 모두 선택해주세요.`);
        if(new Set(ids).size!==4)throw new Error(`${i+1}번째 경기에서 같은 선수를 두 번 선택할 수 없습니다.`);
        for(const id of ids){
          if(chosenIds.has(id))throw new Error(`한 대진표 안에서 같은 선수가 두 경기 이상 배정되어 있습니다.`);
          chosenIds.add(id);
        }
        const a=[memberMap[m.a1],memberMap[m.a2]],b=[memberMap[m.b1],memberMap[m.b2]];
        if(a.some(x=>!x)||b.some(x=>!x))throw new Error("선수 정보를 찾을 수 없습니다.");
        rows.push({a,b});
      }
    }
    return rows;
  }

  function currentSeasonPerformance(memberId){
    const row=currentSeasonId?seasonStats(currentSeasonId).find(x=>x.member?.id===memberId):null;
    const wins=row?.wins||0;
    const games=row?.games||0;

    // Small-sample correction for a ~10-match season.
    // Equivalent to starting everyone with a neutral 2-2 prior.
    const adjustedRate=(wins+2)/(games+4);

    return{
      wins,
      games,
      rawRate:games?wins/games:0,
      adjustedRate
    };
  }

  function seasonSupplementalTargetHistory(){
    const history={};
    const seasonSessionIds=new Set(sessions.filter(s=>s.match_type==="season"&&s.season_id===currentSeasonId).map(s=>s.id));
    const orderedMatches=[...matches].filter(m=>seasonSessionIds.has(m.session_id)&&m.supplemental).sort((a,b)=>{
      const sa=sessionMap[a.session_id],sb=sessionMap[b.session_id];
      return `${sa?.session_date||""}T${String(sa?.start_time||"00:00")}`.localeCompare(`${sb?.session_date||""}T${String(sb?.start_time||"00:00")}`);
    });
    orderedMatches.forEach((m,index)=>{
      const slots=[[m.team_a_member_1,m.season_credit_a1],[m.team_a_member_2,m.season_credit_a2],[m.team_b_member_1,m.season_credit_b1],[m.team_b_member_2,m.season_credit_b2]];
      for(const [id,credited] of slots){
        if(!id||credited===false)continue;
        if(!history[id])history[id]={count:0,last:-1};
        history[id].count++; history[id].last=index;
      }
    });
    return history;
  }

  async function makeDraw(){
    if(!isAdmin&&!memberUnlocked){alert("비정규 경기를 만들려면 회원 PIN을 입력해주세요.");return;}
    if(!isAdmin)setMatchType("friendly");

    let generated=[];
    let chosen=[];
    let generatedSitoutRounds=[];
    try{
      const isSeasonFair=isAdmin&&matchType==="season";

      if(isSeasonFair){
        chosen=activeMembers.filter(m=>selected.includes(m.id));
        const seasonPlayers=chosen.map(m=>{
          const perf=currentSeasonPerformance(m.id);
          return{
            ...m,
            season_games:perf.games,
            season_wins:perf.wins,
            season_raw_rate:perf.rawRate,
            season_adjusted_rate:perf.adjustedRate
          };
        });

        const drawResult=createSeasonSetDraw(
          seasonPlayers,
          drawRotation,
          matchFormat,
          seasonSupplementalTargetHistory()
        );
        generated=drawResult.matches;
        generatedSitoutRounds=[];
        setSitouts([]);
        setDrawRotation(x=>x+1);
      }else if(mode==="manual"){
        generatedSitoutRounds=[];
        setSitouts([]);
        generated=manualDrawObjects();
        const ids=[...new Set(generated.flatMap(m=>[...m.a,...m.b].map(x=>x.id)))];
        chosen=activeMembers.filter(m=>ids.includes(m.id));
      }else{
        chosen=activeMembers.filter(m=>selected.includes(m.id));
        const drawResult=createMultiRoundDraw(
          chosen,
          mode,
          Number(session.rounds)||1,
          drawRotation,
          matchFormat
        );
        generated=drawResult.matches;
        generatedSitoutRounds=drawResult.sitoutRounds||[];
        setSitouts(generatedSitoutRounds);
        setDrawRotation(x=>x+Math.max(1,Number(session.rounds)||1));
      }
    }catch(err){
      alert(err.message);
      return;
    }

    if(!generated.length){
      alert("대진에 참가할 선수를 선택해주세요.");
      return;
    }

    let savedSession,savedMatches;
    const effectiveType="friendly";
    const seasonId=effectiveType==="season"?currentSeasonId:null;
    const savedMode=effectiveType==="season"?"seasonFair":mode;
    const sitoutPayload=effectiveType==="friendly"
      ?generatedSitoutRounds
        .filter(r=>r.players?.length>0)
        .map(r=>({round_no:r.round_no,player_ids:r.players.map(p=>p.id)}))
      :[];
    const matchPayload=generated.map((m,i)=>{
      const creditIds=new Set(m.season_credit_ids||[]);
      const a1=m.a[0]?.id||null,a2=m.a[1]?.id||null,b1=m.b[0]?.id||null,b2=m.b[1]?.id||null;
      return{
        round_no:m.round_no||1,
        court_no:m.court_no||((i%(+session.courts||1))+1),
        a1,a2,b1,b2,
        match_format:m.match_format||matchFormat,
        supplemental:!!m.supplemental,
        season_credit_a1:effectiveType==="season"?creditIds.has(a1):false,
        season_credit_a2:effectiveType==="season"&&a2?creditIds.has(a2):false,
        season_credit_b1:effectiveType==="season"?creditIds.has(b1):false,
        season_credit_b2:effectiveType==="season"&&b2?creditIds.has(b2):false
      };
    });

    if(!isAdmin){
      const{data,error}=await supabase.rpc("member_create_friendly_session_for_club",{
        p_pin:memberPin,p_club_id:CURRENT_CLUB_ID,p_date:session.date,p_time:session.time,p_courts:+session.courts||1,
        p_mode:mode,p_match_format:matchFormat,p_matches:matchPayload,p_sitouts:sitoutPayload
      });
      if(error){alert("비정규 경기 생성 실패: "+error.message);return;}
      savedSession={...data.session,sitout_rounds:sitoutPayload};
      savedMatches=data.matches;
    }else{
      const{data,error:sError}=await supabase.from("sessions").insert({
        club_id:CURRENT_CLUB_ID,
        session_date:session.date,start_time:session.time,courts:+session.courts||1,rounds:+session.rounds||1,mode:savedMode,
        match_type:effectiveType,season_id:seasonId,match_format:matchFormat,sitout_rounds:sitoutPayload
      }).select().single();
      if(sError){alert("세션 저장 실패: "+sError.message);return;}
      savedSession={...data,sitout_rounds:sitoutPayload};
      const{error:pError}=await supabase.from("session_players").insert(chosen.map(m=>({club_id:CURRENT_CLUB_ID,session_id:savedSession.id,member_id:m.id})));
      if(pError){alert("참가자 저장 실패: "+pError.message);return;}
      const rows=matchPayload.map(x=>({
        club_id:CURRENT_CLUB_ID,
        session_id:savedSession.id,round_no:x.round_no,court_no:x.court_no,
        team_a_member_1:x.a1,team_a_member_2:x.a2||null,team_b_member_1:x.b1,team_b_member_2:x.b2||null,
        match_format:x.match_format,
        supplemental:x.supplemental,
        season_credit_a1:x.season_credit_a1,
        season_credit_a2:x.season_credit_a2,
        season_credit_b1:x.season_credit_b1,
        season_credit_b2:x.season_credit_b2
      }));
      const{data:matchData,error:mError}=await supabase.from("matches").insert(rows).select();
      if(mError){alert("대진 저장 실패: "+mError.message);return;}
      savedMatches=matchData;
    }

    const hydrated=(savedMatches||[]).map(row=>({...row,a:[memberMap[row.team_a_member_1],memberMap[row.team_a_member_2]].filter(Boolean),b:[memberMap[row.team_b_member_1],memberMap[row.team_b_member_2]].filter(Boolean)}));
    setMatches(hydrated);
    setScoreInputs(Object.fromEntries(hydrated.map((m,i)=>[m.id||i,{a:"",b:""}])));

    // Fetch the DB, then explicitly merge the just-created session back in.
    // This prevents a newly-created session from appearing one creation late
    // if the immediate history fetch returns before the newest row is visible.
    await loadHistory();

    setSessions(prev=>[
      savedSession,
      ...prev.filter(s=>s.id!==savedSession.id)
    ]);

    setHistoryMatches(prev=>[
      ...(savedMatches||[]),
      ...prev.filter(m=>!(savedMatches||[]).some(n=>n.id===m.id))
    ]);

    if(savedMatches?.[0]?.id)setFocusMatchId(savedMatches[0].id);
    navigate("schedule");
    flash("대진표가 저장되었습니다. 스케줄 아래 예정된 게임에서 확인하세요.");
  }

  async function applyMatchResult(match,scoreA,scoreB){
    const a=[memberMap[match.team_a_member_1],memberMap[match.team_a_member_2]].filter(Boolean);
    const b=[memberMap[match.team_b_member_1],memberMap[match.team_b_member_2]].filter(Boolean);
    const expectedSize=match.match_format==="singles"?1:2;
    if(a.length!==expectedSize||b.length!==expectedSize)throw new Error("경기 참가자 정보를 찾을 수 없습니다.");
    const changes=calculateOtrChanges(a,b,scoreA,scoreB);
    const winner=Number(scoreA)>Number(scoreB)?"A":"B";

    for(const c of changes){
      const member=memberMap[c.id];
      const{error}=await supabase.from("members").update({
        rating:c.after,
        wins:member.wins+(c.won?1:0),
        losses:member.losses+(c.won?0:1)
      }).eq("id",c.id);
      if(error)throw error;
    }

    const{error:mError}=await supabase.from("matches").update({
      winner,score_a:Number(scoreA),score_b:Number(scoreB)
    }).eq("id",match.id);
    if(mError)throw mError;

    const eventRows=changes.map(c=>({
      club_id:CURRENT_CLUB_ID,
      member_id:c.id,
      match_id:match.id,
      event_type:"match",
      rating_before:c.before,
      rating_after:c.after,
      delta:c.delta,
      note:`${scoreA}-${scoreB}`
    }));
    const{error:eError}=await supabase.from("otr_events").insert(eventRows);
    if(eError)throw eError;

    return{winner,changes};
  }


  async function deletePendingMatch(match){
    if(!requireAdmin())return;
    if(match.winner||match.score_a!=null||match.score_b!=null){
      alert("이미 결과가 입력된 경기는 경기 기록에서 삭제해주세요.");
      return;
    }
    const ss=sessionMap[match.session_id];
    const typeLabel=ss?.match_type==="season"?"시즌 정규경기":"비정규 경기";
    if(!confirm(`이 예정된 ${typeLabel}를 삭제할까요?\n아직 결과가 없는 경기만 삭제됩니다.`))return;

    const{error}=await supabase.from("matches").delete().eq("club_id",CURRENT_CLUB_ID).eq("id",match.id);
    if(error){
      alert("예정 경기 삭제 실패: "+error.message);
      return;
    }
    await loadHistory();
    flash("예정된 경기를 삭제했습니다.");
  }

  async function cancelFriendlyMatch(match){
    if(!memberUnlocked&&!isAdmin){
      alert("비정규 경기 취소에는 회원 PIN 인증이 필요합니다.");
      return;
    }

    const ss=sessionMap[match.session_id];
    if(!ss||ss.match_type!=="friendly"){
      alert("회원은 비정규 경기만 취소할 수 있습니다.");
      return;
    }

    if(match.winner||match.score_a!=null||match.score_b!=null){
      alert("이미 결과가 입력된 경기는 회원이 취소할 수 없습니다. 관리자에게 수정/삭제를 요청해주세요.");
      return;
    }

    if(!confirm("이 비정규 대진을 취소하고 삭제할까요?\n아직 결과가 없는 경기만 삭제됩니다."))return;

    const{error}=await supabase.rpc("member_cancel_friendly_match_for_club",{
      p_pin:memberPin,
      p_club_id:CURRENT_CLUB_ID,
      p_match_id:match.id
    });

    if(error){
      alert("경기 취소 실패: "+error.message);
      return;
    }

    await loadHistory();
    flash("비정규 대진이 취소되었습니다.");
  }

  async function submitCurrentScore(match,index){
    if(!isAdmin&&!memberUnlocked){alert("회원 PIN을 입력해주세요.");return;}

    const key=match.id||index;
    const v=scoreInputs[key]||{};
    const a=Number(v.a),b=Number(v.b);
    if(!Number.isFinite(a)||!Number.isFinite(b)||a<0||b<0||a===b){
      alert("A와 B의 서로 다른 스코어를 입력해주세요. 예: 6 / 4");
      return;
    }
    if(match.winner){alert("이미 결과가 저장된 경기입니다. 경기 기록에서 수정해주세요.");return;}
    try{
      if(isAdmin)await applyMatchResult(match,a,b);
      else{
        const{error}=await supabase.rpc("member_submit_match_result_for_club",{
          p_pin:memberPin,p_club_id:CURRENT_CLUB_ID,p_match_id:match.id,p_score_a:a,p_score_b:b
        });
        if(error)throw error;
      }
      await Promise.all([loadMembers(),loadHistory()]);
      flash("스코어, 승패, 개인별 OTR 변화가 저장되었습니다.");
      // Home / automatic Schedule view will re-check the preferred stored schedule
      // after historyMatches refreshes. It advances only when every scheduled match
      // on the current date has been completed.
    }catch(err){alert("경기 저장 실패: "+err.message);}
  }

  async function reverseMatchResult(match){
    if(!match.winner)return true;
    const events=otrEvents.filter(e=>e.match_id===match.id&&e.event_type==="match");
    const aIds=[match.team_a_member_1,match.team_a_member_2].filter(Boolean);
    const bIds=[match.team_b_member_1,match.team_b_member_2].filter(Boolean);

    if(events.length){
      for(const e of events){
        const member=members.find(x=>x.id===e.member_id);
        if(!member)continue;
        const isA=aIds.includes(e.member_id);
        const wasWinner=match.winner==="A"?isA:!isA;
        const{error}=await supabase.from("members").update({
          rating:e.rating_before,
          wins:Math.max(0,member.wins-(wasWinner?1:0)),
          losses:Math.max(0,member.losses-(wasWinner?0:1))
        }).eq("id",e.member_id);
        if(error){alert("기존 결과 되돌리기 실패: "+error.message);return false;}
      }
      await supabase.from("otr_events").delete().eq("match_id",match.id).eq("event_type","match");
      return true;
    }

    // Compatibility for older V1.4 records that stored one team-wide rating_delta.
    const fallbackDelta=Number(match.rating_delta||0);
    for(const id of [...aIds,...bIds]){
      const member=members.find(x=>x.id===id);
      if(!member)continue;
      const isA=aIds.includes(id);
      const wasWinner=match.winner==="A"?isA:!isA;
      const rating=member.rating+(wasWinner?-fallbackDelta:fallbackDelta);
      const{error}=await supabase.from("members").update({
        rating,
        wins:Math.max(0,member.wins-(wasWinner?1:0)),
        losses:Math.max(0,member.losses-(wasWinner?0:1))
      }).eq("id",id);
      if(error){alert("기존 결과 되돌리기 실패: "+error.message);return false;}
    }
    return true;
  }

  function openMatchEdit(match){
    if(!requireAdmin())return;
    setEditingMatch(match);
    setEditScore({a:match.score_a??"",b:match.score_b??""});
  }

  async function saveMatchEdit(e){
    e.preventDefault();
    if(!editingMatch)return;
    const a=Number(editScore.a),b=Number(editScore.b);
    if(!Number.isFinite(a)||!Number.isFinite(b)||a<0||b<0||a===b){
      alert("서로 다른 스코어를 입력해주세요.");
      return;
    }

    const reversed=await reverseMatchResult(editingMatch);
    if(!reversed)return;
    await loadMembers();

    const{data:fresh,error:freshError}=await supabase.from("members").select("*");
    if(freshError){alert(freshError.message);return;}
    const freshMap=Object.fromEntries((fresh||[]).map(x=>[x.id,x]));
    const aTeam=[freshMap[editingMatch.team_a_member_1],freshMap[editingMatch.team_a_member_2]].filter(Boolean);
    const bTeam=[freshMap[editingMatch.team_b_member_1],freshMap[editingMatch.team_b_member_2]].filter(Boolean);
    const changes=calculateOtrChanges(aTeam,bTeam,a,b);
    const winner=a>b?"A":"B";

    for(const c of changes){
      const m=freshMap[c.id];
      const{error}=await supabase.from("members").update({
        rating:c.after,wins:m.wins+(c.won?1:0),losses:m.losses+(c.won?0:1)
      }).eq("id",c.id);
      if(error){alert("회원 전적 수정 실패: "+error.message);return;}
    }
    const{error:mError}=await supabase.from("matches").update({winner,score_a:a,score_b:b}).eq("club_id",CURRENT_CLUB_ID).eq("id",editingMatch.id);
    if(mError){alert("경기 수정 실패: "+mError.message);return;}

    const{error:eError}=await supabase.from("otr_events").insert(changes.map(c=>({
      club_id:CURRENT_CLUB_ID,
      member_id:c.id,match_id:editingMatch.id,event_type:"match",
      rating_before:c.before,rating_after:c.after,delta:c.delta,note:`${a}-${b}`
    })));
    if(eError){alert("OTR 기록 저장 실패: "+eError.message);return;}

    setEditingMatch(null);
    await Promise.all([loadMembers(),loadHistory()]);
    flash("경기 스코어와 OTR을 다시 계산했습니다.");
  }

  async function deleteMatch(match){
    if(!requireAdmin())return;
    if(!confirm("이 경기 기록을 삭제할까요?\n승/패와 OTR 변화도 함께 되돌아갑니다."))return;
    const reversed=await reverseMatchResult(match);
    if(!reversed)return;
    const{error}=await supabase.from("matches").delete().eq("club_id",CURRENT_CLUB_ID).eq("id",match.id);
    if(error){alert("경기 삭제 실패: "+error.message);return;}
    await Promise.all([loadMembers(),loadHistory()]);
    flash("경기 기록과 해당 경기의 전적/OTR 변화를 삭제했습니다.");
  }


  async function loadOtrRebuildEditor(){
    if(!supabase||!isAdmin)return;
    setOtrRebuildLoading(true);
    try{
      const[
        {data:memberRows,error:mErr},
        {data:seedRows,error:sErr},
        {data:backupRows,error:bErr}
      ]=await Promise.all([
        supabase.from("members").select("id,name,rating,wins,losses,member_type,active").order("name",{ascending:true}),
        supabase.from("otr_seeds").select("member_id,seed_rating"),
        supabase.from("otr_rebuild_backups").select("id,created_at,note,restored_at").order("created_at",{ascending:false}).limit(1)
      ]);
      if(mErr)throw mErr;
      if(sErr)throw sErr;
      if(bErr)throw bErr;

      const seedMap=Object.fromEntries((seedRows||[]).map(x=>[x.member_id,Number(x.seed_rating)]));
      setOtrSeedRows((memberRows||[]).map(m=>({
        member_id:m.id,
        name:m.name,
        member_type:m.member_type||"member",
        active:m.active!==false,
        current_rating:Number(m.rating||1000),
        seed_rating:Number(seedMap[m.id]??m.rating??1000)
      })));
      setOtrSeedPreview(null);
      setOtrRebuildLastBackup((backupRows||[])[0]||null);
    }catch(err){
      console.error("OTR 시작점 재설정 도구 불러오기 실패",err);
      if(tab==="settings")alert("OTR 재계산 도구를 불러오지 못했습니다. V11.38 SQL 적용 여부를 확인해주세요.\n\n"+err.message);
    }finally{
      setOtrRebuildLoading(false);
    }
  }

  function updateOtrSeed(memberId,value){
    const clean=String(value??"").replace(/[^0-9]/g,"").slice(0,4);
    setOtrSeedRows(rows=>rows.map(r=>r.member_id===memberId?{...r,seed_rating:clean}:r));
    setOtrSeedPreview(null);
  }

  function otrSeedPayload(){
    const payload=[];
    for(const row of otrSeedRows){
      const seed=Number(row.seed_rating);
      if(!Number.isInteger(seed)||seed<100||seed>3000){
        throw new Error(`${row.name}의 시작 OTR을 100~3000 사이 정수로 입력해주세요.`);
      }
      payload.push({member_id:row.member_id,seed_rating:seed});
    }
    return payload;
  }

  async function previewOtrRebuild(){
    if(!requireAdmin())return;
    let payload;
    try{payload=otrSeedPayload();}catch(err){alert(err.message);return;}
    setOtrRebuildBusy(true);
    try{
      const{data,error}=await supabase.rpc("admin_rebuild_otr_from_seeds",{
        p_seeds:payload,
        p_apply:false
      });
      if(error)throw error;
      setOtrSeedPreview(data||null);
      flash(`완료 경기 ${Number(data?.matches||0)}경기를 새 시작 OTR 기준으로 미리 계산했습니다.`);
    }catch(err){
      alert("OTR 재계산 미리보기 실패: "+err.message);
    }finally{
      setOtrRebuildBusy(false);
    }
  }

  async function applyOtrRebuild(){
    if(!requireAdmin())return;
    if(!otrSeedPreview){
      alert("먼저 '재계산 미리보기'를 실행해주세요.");
      return;
    }

    let payload;
    try{payload=otrSeedPayload();}catch(err){alert(err.message);return;}

    const ok=confirm(
      `전체 OTR을 새 시작점에서 다시 계산합니다.\n\n`+
      `• 완료 경기 ${Number(otrSeedPreview.matches||0)}경기 전체 재생\n`+
      `• 단식/복식 · 시즌/비정규 모두 포함\n`+
      `• 현재 no-zero-sum 공식 사용\n`+
      `• 경기 스코어와 시즌 기록은 변경하지 않음\n`+
      `• 기존 수동 OTR 조정 기록은 새 계산에서 제외\n\n`+
      `실행 직전 상태는 자동 백업됩니다. 계속할까요?`
    );
    if(!ok)return;

    setOtrRebuildBusy(true);
    try{
      const{data,error}=await supabase.rpc("admin_rebuild_otr_from_seeds",{
        p_seeds:payload,
        p_apply:true
      });
      if(error)throw error;

      await Promise.all([loadMembers(),loadHistory()]);
      await loadOtrRebuildEditor();
      flash(`새 시작 OTR 기준으로 ${Number(data?.matches||0)}경기를 다시 계산했습니다.`);
    }catch(err){
      alert("전체 OTR 재계산 실패: "+err.message);
    }finally{
      setOtrRebuildBusy(false);
    }
  }

  async function restoreLastOtrRebuild(){
    if(!requireAdmin())return;
    const backup=otrRebuildLastBackup;
    if(!backup||backup.restored_at){
      alert("되돌릴 수 있는 최근 OTR 재계산 백업이 없습니다.");
      return;
    }
    if(!confirm("가장 최근 OTR 전체 재계산 직전 상태로 되돌릴까요?\n\n시작 OTR, 현재 OTR, 승/패, OTR 그래프 기록이 모두 재계산 직전 상태로 복구됩니다."))return;

    setOtrRebuildBusy(true);
    try{
      const{data,error}=await supabase.rpc("admin_restore_otr_rebuild",{
        p_backup_id:backup.id
      });
      if(error)throw error;
      await Promise.all([loadMembers(),loadHistory()]);
      await loadOtrRebuildEditor();
      flash("OTR을 재계산 직전 상태로 되돌렸습니다.");
    }catch(err){
      alert("OTR 백업 복원 실패: "+err.message);
    }finally{
      setOtrRebuildBusy(false);
    }
  }


  function chronologicalMatches(){
    const sMap=Object.fromEntries(sessions.map(s=>[s.id,s]));
    return [...historyMatches]
      .filter(m=>m.score_a!=null&&m.score_b!=null&&m.winner)
      .sort((a,b)=>{
        const sa=sMap[a.session_id],sb=sMap[b.session_id];
        const aKey=`${sa?.session_date||""}T${String(sa?.start_time||"00:00")}`;
        const bKey=`${sb?.session_date||""}T${String(sb?.start_time||"00:00")}`;
        if(aKey!==bKey)return aKey.localeCompare(bKey);
        return String(a.created_at||"").localeCompare(String(b.created_at||""));
      });
  }


  function seasonCreditFor(match,memberId){
    if(!match||!memberId)return true;
    if(sessionMap[match.session_id]?.match_type!=="season")return true;
    if(match.team_a_member_1===memberId)return match.season_credit_a1!==false;
    if(match.team_a_member_2===memberId)return match.season_credit_a2!==false;
    if(match.team_b_member_1===memberId)return match.season_credit_b1!==false;
    if(match.team_b_member_2===memberId)return match.season_credit_b2!==false;
    return true;
  }

  const mockHomeSeasonId=currentSeasonId||seasons.find(x=>x.is_current)?.id||seasons[seasons.length-1]?.id||null;
  const mockHomeSeason=seasons.find(x=>x.id===mockHomeSeasonId);
  const mockHomeSeasonRows=mockHomeSeasonId?seasonStats(mockHomeSeasonId).filter(x=>publicMemberType(x.member)==="member").slice(0,5):[];
  const mockHomeClubRows=memberRanked.slice(0,5);
  const mockHomeRecent=historyMatches.filter(m=>m.winner).slice(0,4);

  const title=tab==="home"?"대시보드":tab==="profile"?"회원 상세":Object.fromEntries(ADMIN_NAV.map(x=>[x[0],x[1]]))[tab];

  return <div className="app wktcApp">
    <aside className="sidebar">
      <button className="brand" onClick={()=>navigateFresh("home")} aria-label="대시보드로 이동">
        <img src="/wktc-logo.png" alt="WKTC - Wellington Korean Tennis Club"/>
      </button>
      <div className="mobileTopRightQuickGroup">
        <button className="mobileMenuButton" aria-label="메뉴 열기" aria-expanded={mobileMenuOpen} onClick={()=>setMobileMenuOpen(v=>!v)}>
          <span></span><span></span><span></span>
        </button>
      </div>
      <nav className="navList">
        {nav.map(n=><button key={n[0]} className={tab===n[0]?"nav active":"nav"} onClick={()=>navigateFresh(n[0])}><span>{n[1]}</span></button>)}
      </nav>
      <div className="dbBox">
        <div className="dbStatus"><span className={dbConnected?"dot ok":"dot"}></span>{dbConnected?"DB 연결됨":"DB 확인 필요"}</div>
        <small>{isAdmin?"관리자 모드":"읽기 전용 모드"}</small>
        {isAdmin?<button className="adminLink" onClick={signOut}>관리자 로그아웃</button>:<button className="adminLink" onClick={()=>setLoginOpen(true)}>관리자 로그인</button>}
      </div>
    </aside>

    {mobileMenuOpen&&<div className="mobileMenuOverlay" onMouseDown={e=>{if(e.target===e.currentTarget)setMobileMenuOpen(false)}}>
      <div className="mobileMenuPanel">
        <div className="mobileMenuTop">
          <div><b>WKTC</b><span>메뉴</span></div>
          <button className="mobileMenuClose" onClick={()=>setMobileMenuOpen(false)} aria-label="메뉴 닫기">×</button>
        </div>
        <div className="mobileMenuGrid">
          {nav.map(n=><button key={n[0]} className={tab===n[0]?"mobileMenuItem active":"mobileMenuItem"} onClick={()=>navigateFresh(n[0])}>
            <b>{n[1]}</b>
          </button>)}
        </div>
        <div className="mobileMenuFooter">
          {!isAdmin&&memberUnlocked&&memberIdentity&&<div className="mobileMemberAuth">
            <div><b>{memberIdentity.name}</b><span>개인 PIN 인증됨</span></div>
            <button onClick={clearMemberAccess}>회원 인증 해제</button>
          </div>}
          <div className="mobileMenuAdminInfo">
            <b>{isAdmin?"관리자 모드":"관리자"}</b>
            <span>{isAdmin?"관리자 권한으로 접속 중입니다.":"관리자 기능을 사용하려면 로그인하세요."}</span>
          </div>
          <button className="mobileMenuAdminBtn" onClick={isAdmin?signOut:()=>{setMobileMenuOpen(false);setLoginOpen(true)}}>
            {isAdmin?"관리자 로그아웃":"관리자 로그인"}
          </button>
        </div>
      </div>
    </div>}

    {tab!=="mypage"&&<button
      type="button"
      className="mobileMyPageQuickButton"
      onClick={()=>navigateFresh("mypage")}
      aria-label="MY PAGE 바로가기"
      title="MY PAGE">
      <span aria-hidden="true">MY</span>
    </button>}

    {tab!=="session"&&<button
      type="button"
      className="mobileQuickDrawButton"
      onClick={()=>navigateFresh("session")}
      aria-label={isAdmin?"대진표 만들기":"비정규 대진 만들기"}
      title={isAdmin?"대진표 만들기":"비정규 대진 만들기"}>
      <span aria-hidden="true">＋</span>
    </button>}

    <main className="main">
      {tab!=="home"&&<div className="mobileTopBar">
        <button className="mobileHomeLogo" onClick={()=>navigateFresh("home")} aria-label="홈으로 이동">
          <img src="/wktc-logo.png" alt="WKTC"/>
        </button>
        <b className="mobilePageTitle">{title}</b>
      </div>}
      <header className={tab==="home"?"pageHeader homePageHeader":"pageHeader"}>
        {tab!=="home"&&<div><h1>{title}</h1><p>{tab==="profile"?"최근 경기와 OTR 변화를 확인하세요.":isAdmin?"관리자 모드입니다.":"회원용 읽기 전용 화면입니다."}</p></div>}
        <div className="headerActions">
          <label className="dateBox"><span>▣</span><input type="date" value={session.date} onChange={e=>setSession({...session,date:e.target.value})}/></label>
        </div>
      </header>

      {notice&&<div className="notice">{notice}</div>}

      {tab==="home"&&<>
        <div className="mockHomeMobileBrand">
          <img src="/wktc-logo.png" alt="WKTC"/>
          <span><b>WKTC</b><small>WELLINGTON KOREAN TENNIS CLUB</small></span>
        </div>

        <div className="mockHome">
          <section className="mockTopGrid">
            <article className="mockHero">
              <div className="mockHeroCopy">
                <span className="mockEyebrow">CLUB INTRO</span>
                <h1>클럽 소개</h1>
                <p>{clubPromo.content}</p>

                <div className="mockHeroMeta"><div><span>♙</span><b>클럽 운영</b><em>WKTC</em></div><div><span>◎</span><b>회계 기능</b><em>사용 안 함</em></div></div>

              </div>
              <div className="mockHeroImage" aria-hidden="true">
                <img src="/wktc-logo.png" alt=""/>
              </div>
            </article>

            <article className="mockCard wktcUpcomingHomeCard">
              <div className="mockCardHead">
                <h2>예정된 게임</h2>
                <button onClick={()=>navigate("schedule")}>전체 보기 ›</button>
              </div>

              <div className="wktcUpcomingHomeList">
                {pendingMatches.slice(0,4).map((m,i)=>{
                  const ss=sessionMap[m.session_id];
                  return <button className="wktcUpcomingHomeRow" key={m.id||i} onClick={()=>navigate("schedule")}>
                    <div className="wktcUpcomingDate">
                      <b>{String(ss?.session_date||"").slice(5).replace("-","/")||"-"}</b>
                      <small>{String(ss?.start_time||"").slice(0,5)||"--:--"}</small>
                    </div>
                    <div className="wktcUpcomingTeams">
                      <b>{m.a.map(x=>x.name).join(" / ")||"TEAM A"}</b>
                      <span>VS</span>
                      <b>{m.b.map(x=>x.name).join(" / ")||"TEAM B"}</b>
                    </div>
                    <small>{m.match_format==="singles"?"단식":"복식"} · Round {m.round_no||1}</small>
                  </button>;
                })}
                {!pendingMatches.length&&<div className="mockEmpty">현재 예정된 게임이 없습니다.</div>}
              </div>

              <button className="mockOutlineButton" onClick={()=>navigate("schedule")}>▦ 예정된 게임 목록</button>
            </article>
          </section>

          <section className="mockLowerGrid">
            <article className="mockCard mockEvents">
              <div className="mockCardHead">
                <h2>클럽 행사</h2>
                <button onClick={()=>navigate("events")}>전체 보기 ›</button>
              </div>
              <div className="mockEventList">
                {upcomingClubEvents.slice(0,2).map((ev,i)=><div className="mockEventRow" key={ev.id}>
                  <div className="mockDateTile event">
                    <b>{String(ev.event_date).slice(5).replace("-","/")}</b>
                    <small>{new Date(`${ev.event_date}T00:00:00`).toLocaleDateString("ko-KR",{weekday:"short"})}</small>
                  </div>
                  <div className="mockEventInfo">
                    <b>{ev.title}</b>
                    {ev.details&&<small>{ev.details}</small>}
                  </div>
                </div>)}
                {!upcomingClubEvents.length&&<div className="mockEmpty">예정된 클럽 행사가 없습니다.</div>}
              </div>
              <button className="mockOutlineButton" onClick={()=>navigate("events")}>▣ 모든 행사 보기</button>
            </article>

            <article className="mockCard mockHistory">
              <div className="mockCardHead">
                <h2>경기 기록</h2>
                <button onClick={()=>navigate("draw")}>전체 보기 ›</button>
              </div>
              <div className="mockHistoryList">
                {mockHomeRecent.map(m=>{
                  const a=[memberMap[m.team_a_member_1],memberMap[m.team_a_member_2]].filter(Boolean);
                  const b=[memberMap[m.team_b_member_1],memberMap[m.team_b_member_2]].filter(Boolean);
                  const ss=sessionMap[m.session_id];
                  return <div className="mockHistoryRow" key={m.id}>
                    <div className="mockHistoryTeams">
                      <span className={m.winner==="A"?"mockHistoryTeamName homeWinner":"mockHistoryTeamName"}>
                        <span className="mockHistoryNameGroup">{a.map((x,idx)=><React.Fragment key={x.id}><button onClick={()=>openProfile(x.id)}>{x.name}</button>{idx<a.length-1&&<i>/</i>}</React.Fragment>)}</span>
                        {m.winner==="A"&&<span className="mockNameWinBadge">승</span>}
                      </span>
                      <em>vs</em>
                      <span className={m.winner==="B"?"mockHistoryTeamName homeWinner":"mockHistoryTeamName"}>
                        <span className="mockHistoryNameGroup">{b.map((x,idx)=><React.Fragment key={x.id}><button onClick={()=>openProfile(x.id)}>{x.name}</button>{idx<b.length-1&&<i>/</i>}</React.Fragment>)}</span>
                        {m.winner==="B"&&<span className="mockNameWinBadge">승</span>}
                      </span>
                    </div>
                    <b>{m.score_a}:{m.score_b}</b>
                    <small>{String(ss?.session_date||"").slice(5).replace("-",".")}</small>
                  </div>;
                })}
                {!mockHomeRecent.length&&<div className="mockEmpty">아직 경기 기록이 없습니다.</div>}
              </div>
              <button className="mockOutlineButton" onClick={()=>navigate("draw")}>▤ 기록 더 보기</button>
            </article>

            <div className="mockRankColumn mockRankColumnSimple">
              <article className="mockCard mockCombinedHomeRank wktcHomeRankOnly">
                <section className="mockCombinedRankSection">
                  <div className="mockCardHead mockRankSectionHead">
                    <div className="mockRankTitleWrap"><h2>WKTC 랭킹 TOP5</h2></div>
                    <button onClick={()=>navigate("ranking")}>전체 보기 ›</button>
                  </div>
                  <div className="mockRankRows homeFive">
                    {mockHomeClubRows.map((m,i)=><div key={m.id}>
                      <span className={`n${i+1}`}>{i+1}</span>
                      <button onClick={()=>openProfile(m.id)}>{m.name}</button>
                      <b>{m.rating.toLocaleString()} OTR</b>
                    </div>)}
                    {!mockHomeClubRows.length&&<div className="mockRankEmpty">클럽 랭킹 기록이 없습니다.</div>}
                  </div>
                </section>
              </article>
            </div>
          </section>

          <section className="mockFooterStrip">
            <div className="mockMedal">♕</div>
            <div className="mockFooterIntro">
              <b>Wellington Korean Tennis Club</b>
              <small>웰링턴 한인 테니스 커뮤니티 WKTC.<br/>실력과 관계없이 함께 즐기고 성장하는 클럽을 만들어갑니다.</small>
            </div>
            <div className="mockFooterPoint"><span>♙</span><div><b>모두 환영해요</b><small>누구나 참여 가능</small></div></div>
            <div className="mockFooterPoint"><span>▣</span><div><b>회원제 운영</b><small>정회원 · 준회원</small></div></div>
            <div className="mockFooterPoint"><span>♧</span><div><b>매너 & 존중</b><small>함께 지켜요</small></div></div>
          </section>

          {isAdmin&&<section className="mockAdminEdit">
            <div className="mockCardHead"><h2>클럽 소개 관리</h2><span>관리자 전용</span></div>
            <form className="promoForm" onSubmit={saveClubPromo}>
              <label>제목<input value={promoForm.title} onChange={e=>setPromoForm({...promoForm,title:e.target.value})}/></label>
              <label>내용<textarea rows="3" value={promoForm.content} onChange={e=>setPromoForm({...promoForm,content:e.target.value})}/></label>
              <button className="primary">홍보글 저장</button>
            </form>
          </section>}
        </div>
      </>}
      {tab==="openpick"&&<div className="openPickPage">
        <section className="surface padded openPickHero">
          <div className="openPickHeroTop">
            <div>
              <span className="openPickEyebrow">♠ OPEN COURT EVENT</span>
              <h2>OPEN PICK</h2>
              <p>시즌 경기의 승리팀을 예측하고 PICK POINT를 모아보세요.</p>
            </div>
            <div className="openPickSeasonBadge">Season {currentSeason?.season_no||"-"}</div>
          </div>

          {!isAdmin&&!memberUnlocked
            ?<form className="openPickLogin" onSubmit={unlockOpenPick}>
              <div><b>내 PICK 참여하기</b><span>관리자가 설정한 본인의 숫자 4자리 개인 PIN을 입력하세요.</span></div>
              <div><input type="password" inputMode="numeric" maxLength="4" value={memberPin} onChange={e=>setMemberPin(e.target.value.replace(/\D/g,"").slice(0,4))} placeholder="4자리 PIN"/><button className="primary">인증</button></div>
            </form>
            :memberUnlocked&&memberIdentity&&<div className="openPickIdentity">
              <div><small>PLAYER</small><b>{memberIdentity.name}</b><span>개인 PIN 인증됨</span></div>
              <div><small>MY PICK POINT</small><b>{Number(openPickLeaderboard.find(x=>x.member_id===memberIdentity.member_id)?.points||0).toFixed(1)} P</b><span>{openPickLeaderboard.findIndex(x=>x.member_id===memberIdentity.member_id)>=0?`${openPickLeaderboard.findIndex(x=>x.member_id===memberIdentity.member_id)+1}위`:'아직 순위 없음'}</span></div>
              {!isAdmin&&<button onClick={clearMemberAccess}>인증 해제</button>}
            </div>}
        </section>

        <section className="surface padded openPickCurrent">
          <div className="sectionHead openPickSectionHead">
            <div><h2>THIS WEEK PICK</h2><small>{openPickCurrentSession?`${openPickCurrentSession.session_date} · ${String(openPickCurrentSession.start_time||"").slice(0,5)}`:"시즌 대진을 기다리는 중"}</small></div>
            {openPickCurrentSession&&<span className={isOpenPickSessionLocked(openPickCurrentSession)?"openPickLock locked":"openPickLock"}>{isOpenPickSessionLocked(openPickCurrentSession)?"PICK 마감":"PICK 진행중"}</span>}
          </div>

          {openPickCurrentSession&&<div className="openPickRules">
            <span>기본 10P</span><span>비인기 선택 적중 시 최대 3.0배</span><span>전 경기 적중 PERFECT PICK +10P</span>
            <small>다른 회원의 선택률과 배당은 경기 시작 후 공개됩니다. PICK은 해당 시즌 세션 시작 전까지 변경할 수 있습니다.</small>
          </div>}

          {openPickBusy&&<div className="emptyState">OPEN PICK 불러오는 중...</div>}
          {!openPickBusy&&openPickCurrentSession&&<div className="openPickMatchList">
            {openPickCurrentMatches.map((m,i)=>{
              const stat=openPickStatsMap[m.id]||{};
              const locked=!!stat.locked||isOpenPickSessionLocked(openPickCurrentSession)||!!m.winner;
              const myPick=openPickMyPicks[m.id]||"";
              const myCorrect=!!m.winner&&myPick===m.winner;
              const odds=myPick==="A"?Number(stat.a_odds||0):myPick==="B"?Number(stat.b_odds||0):0;
              const earned=myCorrect&&odds?Math.round(10*odds*10)/10:0;
              const aPct=stat.total_count?Math.round(Number(stat.a_count||0)/Number(stat.total_count)*100):0;
              const bPct=stat.total_count?Math.round(Number(stat.b_count||0)/Number(stat.total_count)*100):0;
              return <article className={m.winner?"openPickMatchCard completed":"openPickMatchCard"} key={m.id}>
                <div className="openPickMatchMeta"><b>MATCH {i+1}</b><span>{m.match_format==="singles"?"단식":"복식"} · Court {m.court_no||i+1}</span>{m.winner&&<em>{m.winner==="A"?"TEAM A":"TEAM B"} 승</em>}</div>
                <div className="openPickTeams">
                  <button type="button" disabled={locked||!memberUnlocked||openPickSavingMatchId===m.id} className={myPick==="A"?"openPickTeam selected":"openPickTeam"} onClick={()=>saveOpenPick(m.id,"A")}>
                    <small>TEAM A</small><b>{scheduleTeamText(m,"A")}</b>
                    {locked?<span>{stat.total_count?`${aPct}% · ${Number(stat.a_odds||0).toFixed(2)}x`:"선택 없음"}</span>:<span>{myPick==="A"?"내 PICK":"선택"}</span>}
                  </button>
                  <div className="openPickVs">VS</div>
                  <button type="button" disabled={locked||!memberUnlocked||openPickSavingMatchId===m.id} className={myPick==="B"?"openPickTeam selected":"openPickTeam"} onClick={()=>saveOpenPick(m.id,"B")}>
                    <small>TEAM B</small><b>{scheduleTeamText(m,"B")}</b>
                    {locked?<span>{stat.total_count?`${bPct}% · ${Number(stat.b_odds||0).toFixed(2)}x`:"선택 없음"}</span>:<span>{myPick==="B"?"내 PICK":"선택"}</span>}
                  </button>
                </div>
                <div className="openPickMatchFoot">
                  {!locked&&<span>배당 · 선택률은 마감 후 공개</span>}
                  {locked&&!m.winner&&<span>마감 완료 · 경기 결과 대기</span>}
                  {m.winner&&memberUnlocked&&myPick&&<span className={myCorrect?"pickResult correct":"pickResult wrong"}>{myCorrect?`적중 +${earned.toFixed(1)} P`:"미적중 0 P"}</span>}
                  {m.winner&&memberUnlocked&&!myPick&&<span>참여하지 않은 경기</span>}
                </div>
              </article>;
            })}
          </div>}
          {!openPickBusy&&!openPickCurrentSession&&<div className="emptyState">현재 시즌에 등록된 시즌 대진이 없습니다.</div>}
        </section>

        <section className="surface padded openPickRanking">
          <div className="sectionHead openPickSectionHead"><div><h2>PICK POINT RANKING</h2><small>Season {currentSeason?.season_no||"-"} 누적</small></div></div>
          <div className="openPickRankList">
            {openPickLeaderboard.map((row,i)=><div className={memberIdentity?.member_id===row.member_id?"openPickRankRow mine":"openPickRankRow"} key={row.member_id}>
              <span className={`openPickRankNo n${i+1}`}>{i+1}</span>
              <button onClick={()=>openProfile(row.member_id)}>{row.name}</button>
              <small>{row.correct||0} 적중 · PERFECT {row.perfects||0}</small>
              <b>{Number(row.points||0).toFixed(1)} P</b>
            </div>)}
            {!openPickLeaderboard.length&&<div className="emptyState">아직 PICK 참여 기록이 없습니다.</div>}
          </div>
        </section>

        <section className="surface padded openPickHistory">
          <div className="sectionHead openPickSectionHead"><div><h2>PICK HISTORY</h2><small>내 주차별 예측 기록</small></div></div>
          {!memberUnlocked&&<div className="emptyState">개인 PIN으로 인증하면 지난 PICK 기록을 볼 수 있습니다.</div>}
          {memberUnlocked&&<div className="openPickHistoryList">
            {[...openPickSeasonSessions].reverse().map(s=>{
              const ms=historyMatches.filter(m=>m.session_id===s.id);
              const picked=ms.filter(m=>openPickMyPicks[m.id]);
              if(!picked.length)return null;
              const completed=ms.filter(m=>m.winner);
              const correct=completed.filter(m=>openPickMyPicks[m.id]===m.winner);
              const base=correct.reduce((sum,m)=>{
                const st=openPickStatsMap[m.id]||{};
                const odd=openPickMyPicks[m.id]==="A"?Number(st.a_odds||0):Number(st.b_odds||0);
                return sum+(odd?10*odd:0);
              },0);
              const perfect=ms.length>0&&completed.length===ms.length&&picked.length===ms.length&&correct.length===ms.length;
              return <div className="openPickHistoryRow" key={s.id}>
                <div><b>{s.session_date}</b><span>{picked.length}/{ms.length}경기 PICK · {correct.length}경기 적중</span></div>
                {perfect&&<span className="perfectPickBadge">PERFECT PICK +10</span>}
                <strong>+{(base+(perfect?10:0)).toFixed(1)} P</strong>
              </div>;
            })}
            {!openPickSeasonSessions.some(s=>historyMatches.some(m=>m.session_id===s.id&&openPickMyPicks[m.id]))&&<div className="emptyState">아직 저장한 PICK이 없습니다.</div>}
          </div>}
        </section>
      </div>}

      {tab==="mypage"&&<div className="myPageWrap">
        <section className="surface padded myPageHero">
          <div className="myPageHeroCopy">
            <span>PERSONAL TENNIS SPACE</span>
            <h2>MY PAGE</h2>
            <p>내 라켓과 스트링 작업 기록, 개인 메모를 한곳에 보관하세요. 이 내용은 본인의 개인 PIN으로만 열 수 있습니다.</p>
          </div>

          {!memberUnlocked
            ?<form className="memberPinBox myPageLogin" onSubmit={unlockMyPage}>
              <b>내 페이지 열기</b>
              <p>관리자가 설정한 본인의 숫자 4자리 개인 PIN을 입력하세요.</p>
              <div><input type="password" inputMode="numeric" maxLength="4" value={memberPin} onChange={e=>setMemberPin(e.target.value.replace(/\D/g,"").slice(0,4))} placeholder="4자리 PIN"/><button className="primary">확인</button></div>
            </form>
            :memberIdentity&&<div className="myPageIdentity">
              <div><small>PLAYER</small><b>{memberIdentity.name}</b><span>개인 PIN 인증됨</span></div>
              <div><small>CURRENT OTR</small><b>{Number(memberMap[memberIdentity.member_id]?.rating||0).toLocaleString()}</b><span>{myPageData.rackets.length} RACKET</span></div>
              <button onClick={clearMemberAccess}>인증 해제</button>
            </div>}
        </section>

        {memberUnlocked&&<>
          <section className="surface padded myRacketsSection">
            <div className="sectionHead">
              <div><h2>MY RACKETS</h2><small>라켓별 스트링 · 텐션 · 작업 날짜 기록</small></div>
            </div>

            <form className="myRacketAddForm" onSubmit={addMyRacket}>
              <input value={myRacketName} onChange={e=>setMyRacketName(e.target.value)} maxLength="120" placeholder="라켓 이름 / 모델명 예: Yonex Ezone 98"/>
              <button className="primary" disabled={myPageSaving}>+ 라켓 추가</button>
            </form>

            {myPageBusy&&<div className="emptyState">MY PAGE 불러오는 중...</div>}
            {!myPageBusy&&<div className="myRacketGrid">
              {myPageData.rackets.map(r=>{
                const f=myStringForm(r.id);
                return <article className="myRacketCard" key={r.id}>
                  <div className="myRacketCardHead">
                    <div><small>RACKET</small><h3>{r.racket_name}</h3></div>
                    <div><button type="button" onClick={()=>renameMyRacket(r)}>이름 변경</button><button type="button" className="danger" onClick={()=>deleteMyRacket(r)}>삭제</button></div>
                  </div>

                  <form className="myStringForm" onSubmit={e=>addMyStringRecord(e,r.id)}>
                    <label>스트링<input value={f.string_name} onChange={e=>updateMyStringForm(r.id,"string_name",e.target.value)} maxLength="120" placeholder="예: Poly Tour Pro"/></label>
                    <label>텐션<input value={f.tension} onChange={e=>updateMyStringForm(r.id,"tension",e.target.value)} maxLength="40" placeholder="예: 48 lbs / 48-46"/></label>
                    <label>작업 날짜<input type="date" value={f.strung_date} onChange={e=>updateMyStringForm(r.id,"strung_date",e.target.value)}/></label>
                    <label className="myStringNoteField">메모<input value={f.note} onChange={e=>updateMyStringForm(r.id,"note",e.target.value)} maxLength="500" placeholder="선택사항 · 느낌, 스트링어 등"/></label>
                    <button className="primary" disabled={myPageSaving}>스트링 기록 추가</button>
                  </form>

                  <div className="myStringHistory">
                    <div className="myStringHistoryHead"><b>STRING HISTORY</b><span>{(r.string_records||[]).length}회</span></div>
                    {(r.string_records||[]).map(rec=><div className="myStringRecord" key={rec.id}>
                      <div className="myStringDate"><b>{rec.strung_date}</b><small>{rec.tension}</small></div>
                      <div className="myStringName"><b>{rec.string_name}</b>{rec.note&&<span>{rec.note}</span>}</div>
                      <button type="button" onClick={()=>deleteMyStringRecord(rec.id)}>삭제</button>
                    </div>)}
                    {!(r.string_records||[]).length&&<div className="myStringEmpty">아직 스트링 기록이 없습니다.</div>}
                  </div>
                </article>;
              })}
              {!myPageData.rackets.length&&<div className="emptyState">아직 등록한 라켓이 없습니다. 첫 라켓을 추가해보세요.</div>}
            </div>}
          </section>

          <section className="surface padded myPrivateMemoSection">
            <div className="sectionHead"><div><h2>PRIVATE MEMO</h2><small>테니스와 관련된 나만의 메모</small></div><span className="myPrivateBadge">PRIVATE</span></div>
            <textarea rows="8" maxLength="5000" value={myMemo} onChange={e=>setMyMemo(e.target.value)} placeholder="라켓 세팅, 다음에 바꿔볼 스트링, 레슨 메모, 경기에서 느낀 점 등 자유롭게 적어두세요."/>
            <div className="myMemoActions"><small>{myMemo.length}/5000</small><button className="primary" disabled={myPageSaving} onClick={saveMyMemo}>메모 저장</button></div>
          </section>
        </>}
      </div>}

      {tab==="events"&&<>
        <section className="surface padded clubEventsPage">
          <div className="sectionHead clubEventsPageHead">
            <div>
              <h2>클럽 행사</h2>
              <small>Open Court의 예정 행사와 모임 일정을 확인하세요.</small>
            </div>
            <span>{clubEvents.length}개 행사</span>
          </div>

          {isAdmin&&<form className="clubEventPageForm" onSubmit={addClubEvent}>
            <div className="clubEventPageFormTitle">
              <b>{eventForm.id?"행사 수정":"새 행사 추가"}</b>
              <small>관리자 전용</small>
            </div>
            <label>날짜<input type="date" value={eventForm.date} onChange={e=>setEventForm({...eventForm,date:e.target.value})}/></label>
            <label>행사명<input value={eventForm.title} onChange={e=>setEventForm({...eventForm,title:e.target.value})} placeholder="예: 클럽 교류전"/></label>
            <label className="clubEventPageDetails">내용<input value={eventForm.details} onChange={e=>setEventForm({...eventForm,details:e.target.value})} placeholder="시간, 장소, 준비물 등"/></label>
            <div className="clubEventPageFormActions">
              <button className="primary">{eventForm.id?"수정 저장":"행사 추가"}</button>
              {eventForm.id&&<button type="button" className="secondaryBtn" onClick={cancelClubEventEdit}>수정 취소</button>}
            </div>
          </form>}

          <div className="clubEventsPageList">
            {clubEvents.map(ev=>{
              const today=new Date();
              const todayKey=[today.getFullYear(),String(today.getMonth()+1).padStart(2,"0"),String(today.getDate()).padStart(2,"0")].join("-");
              const upcoming=String(ev.event_date)>=todayKey;
              return <article className={upcoming?"clubEventPageRow upcoming":"clubEventPageRow past"} key={ev.id}>
                <div className="clubEventPageDate">
                  <b>{String(ev.event_date).slice(5).replace("-","/")}</b>
                  <small>{new Date(`${ev.event_date}T00:00:00`).toLocaleDateString("ko-KR",{weekday:"short"})}</small>
                </div>
                <div className="clubEventPageInfo">
                  <div><b>{ev.title}</b><span className={upcoming?"eventStatus upcoming":"eventStatus"}>{upcoming?"예정":"지난 행사"}</span></div>
                  {ev.details&&<p>{ev.details}</p>}
                </div>
                {isAdmin&&<div className="clubEventPageActions">
                  <button className="clubEventEdit" onClick={()=>editClubEvent(ev)}>수정</button>
                  <button className="clubEventDelete" onClick={()=>deleteClubEvent(ev.id)}>삭제</button>
                </div>}
              </article>;
            })}
            {!clubEvents.length&&<div className="emptyState">등록된 클럽 행사가 없습니다.</div>}
          </div>
        </section>
      </>}

      {tab==="members"&&<>
        {isAdmin&&<section className="surface padded globalPlayerImportPanel">
          <div className="sectionHead">
            <div><h2>공용 선수 DB에서 불러오기</h2><small>다른 클럽에 이미 등록된 선수는 새로 만들지 말고 여기서 연결하세요.</small></div>
          </div>
          <form className="globalPlayerSearchForm" onSubmit={searchGlobalPlayers}>
            <input value={globalPlayerSearch} onChange={e=>setGlobalPlayerSearch(e.target.value)} placeholder="선수 이름 검색"/>
            <button className="primary" disabled={globalPlayerSearchBusy}>{globalPlayerSearchBusy?"검색 중...":"검색"}</button>
          </form>
          {!!globalPlayerResults.length&&<div className="globalPlayerResults">
            {globalPlayerResults.map(p=>{
              const hasOtherPrimary=!!p.primary_club_id&&p.primary_club_id!==CURRENT_CLUB_ID;
              return <div className="globalPlayerResultRow" key={p.member_id}>
                <div className="globalPlayerIdentity">
                  <b>{p.name}</b>
                  <span>{p.rating} OTR · {p.gender==="M"?"남":"여"}</span>
                  <small>{p.primary_club_name?`정회원 소속: ${p.primary_club_short_name||p.primary_club_name}`:"현재 정회원 소속 없음"}</small>
                </div>
                <div className="globalPlayerActions">
                  <button type="button" disabled={hasOtherPrimary} onClick={()=>linkGlobalPlayerToVktc(p,"regular")}>정회원</button>
                  <button type="button" onClick={()=>linkGlobalPlayerToVktc(p,"associate")}>준회원</button>
                  <button type="button" onClick={()=>linkGlobalPlayerToVktc(p,"guest")}>게스트</button>
                </div>
              </div>;
            })}
          </div>}
          {globalPlayerSearch.trim().length>=2&&!globalPlayerSearchBusy&&!globalPlayerResults.length&&
            <div className="globalPlayerSearchHint">검색 결과가 없으면 아래에서 새 선수를 등록하세요.</div>}
        </section>}

        {isAdmin&&<section className="surface padded">
          <div className="sectionHead">
            <div><h2>새 선수 등록</h2><small>공용 DB에 없는 선수만 새로 등록하세요.</small></div>
          </div>
          <form className="memberForm v15 membershipAdminForm" onSubmit={addMember}>
            <label>이름<input placeholder="이름" value={form.name} onChange={e=>setForm({...form,name:e.target.value})}/></label>
            <label>관리 등급<select value={form.membership_status} onChange={e=>setForm({...form,membership_status:e.target.value})}>
              <option value="regular">정회원</option>
              <option value="associate">준회원</option>
              <option value="guest">게스트</option>
            </select></label>
            <label>성별<select value={form.gender} onChange={e=>setForm({...form,gender:e.target.value})}><option value="M">남성</option><option value="F">여성</option></select></label>
            <label>시작 OTR<input type="number" value={form.rating} onChange={e=>setForm({...form,rating:e.target.value})}/></label>
            <button className="primary">추가</button>
          </form>
          <div className="membershipPrivacyNote">
            <b>회원 화면 표시</b>
            <span>정회원과 준회원은 대진표·프로필·선수 선택 등 일반 화면에서 모두 똑같이 <strong>회원</strong>으로 표시됩니다.</span>
          </div>
        </section>}

        <section className="surface padded">
          <div className="sectionHead memberListHead">
            <div><h2>회원 목록</h2><small>활동 {activeMembers.length}명 · 비활동 {inactiveMembers.length}명</small></div>
            <div className="memberFilters">
              <button className={memberFilter==="active"?"filterBtn on":"filterBtn"} onClick={()=>setMemberFilter("active")}>활동중</button>
              <button className={memberFilter==="inactive"?"filterBtn on":"filterBtn"} onClick={()=>setMemberFilter("inactive")}>비활동</button>
              <button className={memberFilter==="all"?"filterBtn on":"filterBtn"} onClick={()=>setMemberFilter("all")}>전체</button>
            </div>
          </div>
          <div className="tableWrap"><table><thead><tr><th>이름</th><th>상태</th><th>관리등급</th><th>성별</th><th>OTR</th><th>승</th><th>패</th><th>승률</th>{isAdmin&&<th>개인 PIN</th>}{isAdmin&&<th></th>}</tr></thead><tbody>
            {filteredMembers.map(m=>{const n=m.wins+m.losses;return <tr key={m.id} className={m.active===false?"inactiveRow":""}>
              <td className="memberCell">
                <button className="nameLink" onClick={()=>openProfile(m.id)}>{m.name}</button>
                {championCountByName[m.name]>0&&
                  <span className="championStars championStarsAfter" title={`시즌 우승 ${championCountByName[m.name]}회`}>
                    {Array.from({length:championCountByName[m.name]},(_,i)=><span key={i}>★</span>)}
                  </span>}
              </td>
              <td><span className={m.active===false?"statusBadge inactive":"statusBadge"}>{m.active===false?"비활동":"활동중"}</span></td>
              <td>{(()=>{
                const status=currentClubMembershipStatus(m.id);
                return <span className={`membershipAdminBadge ${status}`}>{membershipAdminLabel(status)}</span>;
              })()}</td>
              <td>{m.gender==="M"?"남":"여"}</td><td><strong>{m.rating}</strong></td><td>{m.wins}</td><td>{m.losses}</td><td>{n?Math.round(m.wins/n*100):0}%</td>
              {isAdmin&&<td>{currentClubMembershipStatus(m.id)!=="guest"
                ?<div className="memberPinCell"><span className={memberPinStatus[m.id]?"memberPinStatus set":"memberPinStatus"}>{memberPinStatus[m.id]?"설정됨":"미설정"}</span><button className="memberPinEditBtn" onClick={()=>openMemberPinEditor(m)}>{memberPinStatus[m.id]?"변경":"설정"}</button></div>
                :<span className="memberPinGuest">-</span>}</td>}
              {isAdmin&&<td><div className="rowActions">
                <button className="editBtn" onClick={()=>startEditMember(m)}>수정</button>
                {m.active===false
                  ?<>
                    <button className="restoreBtn" onClick={()=>reactivateMember(m.id)}>활동 복구</button>
                    <button className="hardDeleteBtn" onClick={()=>permanentlyDeleteInactiveMember(m.id)}>목록삭제</button>
                   </>
                  :<button className="danger" onClick={()=>deactivateMember(m.id)}>비활성화</button>}
              </div></td>}
            </tr>})}
          </tbody></table></div>
        </section>
      </>}

      {tab==="session"&&<div className="drawDesignPage">
        <section className="surface padded">
          <div className="sectionHead"><h2>{isAdmin?"대진표 설정":"회원 비정규 대진"}</h2></div>
          {!isAdmin&&!memberUnlocked&&<form className="memberPinBox" onSubmit={unlockMemberMode}><b>개인 PIN</b><p>본인의 4자리 PIN 하나로 대진 생성, 경기 결과 입력, 회계 열람, MY PAGE를 사용할 수 있습니다.</p><div><input type="password" inputMode="numeric" maxLength="4" value={memberPin} onChange={e=>setMemberPin(e.target.value.replace(/\D/g,"").slice(0,4))} placeholder="4자리 PIN"/><button className="primary">확인</button></div></form>}
          {(isAdmin||memberUnlocked)&&<div className="sessionForm">
            <label>경기 형식<select value={matchFormat} onChange={e=>{setMatchFormat(e.target.value);setSitouts([]);}}>
              <option value="doubles">복식</option>
              <option value="singles">단식</option>
            </select></label>
            {isAdmin&&<label>경기 구분<select value="friendly" disabled><option value="friendly">클럽 경기</option></select></label>}
            <label>날짜<input type="date" value={session.date} onChange={e=>setSession({...session,date:e.target.value})}/></label>
            <label>시간<input type="time" value={session.time} onChange={e=>setSession({...session,time:e.target.value})}/></label>
            <label>코트 수<input type="number" min="1" value={session.courts} onChange={e=>setSession({...session,courts:e.target.value})}/></label>
            {!(isAdmin&&matchType==="season")&&<label>라운드 수<input type="number" min="1" value={session.rounds} onChange={e=>setSession({...session,rounds:e.target.value})}/></label>}
          </div>}
        </section>
        {(isAdmin||memberUnlocked)&&<section className="surface padded">
          <div className="sectionHead"><h2>참가자 선택</h2><span>{selected.length}명</span></div>

          {!(isAdmin&&matchType==="season")&&<div className="modeBar modeBarBeforeParticipants">
            <b>대진 방식</b>
            <label><input type="radio" checked={mode==="balanced"} onChange={()=>setMode("balanced")}/> 실력 균형</label>
            <label><input type="radio" checked={mode==="form"} onChange={()=>setMode("form")}/> 최근 승률 반영</label>
            <label><input type="radio" checked={mode==="random"} onChange={()=>setMode("random")}/> 랜덤</label>
            <label><input type="radio" checked={mode==="manual"} onChange={()=>setMode("manual")}/> 직접 지정</label>
          </div>}

          <div className="people">{activeMembers.map(m=><button key={m.id} className={selected.includes(m.id)?"person on":"person"} onClick={()=>setSelected(s=>s.includes(m.id)?s.filter(x=>x!==m.id):[...s,m.id])}>
            <span className="check">{selected.includes(m.id)?"✓":""}</span><span className="avatar">{m.name[0]}</span><b>{m.name}<em className={publicMemberType(m)==="guest"?"participantType guest":"participantType"}>{publicMemberLabel(m)}</em></b><small>{m.rating} OTR</small>
          </button>)}</div>
          <div className="drawCountHint">
            {isAdmin&&matchType==="season"
              ?<>
                선택 {selected.length}명 · 대진표 생성 1회 = 참가자마다 시즌 기록 1경기
                {matchFormat==="doubles"&&selected.length>=4&&selected.length%4!==0&&<span>
                  남는 {selected.length%4}명도 시즌 기록 1경기를 가질 수 있도록,
                  이미 시즌 기록을 받은 참가자 중 필요한 인원의 보조선수를 자동 재투입합니다.
                  {selected.length%4===2&&" 남는 2명에는 보조선수 2명이 추가되어 복식 보조경기가 만들어집니다."}
                  보조선수는 남은 참가자의 OTR과 최대한 비슷하게 선택하고, 양 팀 총 OTR 차이도 최소화합니다.
                  보조선수의 추가 경기는 OTR·통산전적만 반영되고 시즌전적에는 두 번 들어가지 않습니다.
                </span>}
              </>
              :<>
                선택 {selected.length}명 · {matchFormat==="singles"?"단식은 2명":"복식은 4명"} 단위 · {session.rounds}라운드
                {matchFormat==="doubles"&&mode!=="manual"&&selected.length>=6&&selected.length%4===2&&<span className="autoSinglesHint">
                  {selected.length===2
                    ?"2명만 선택되어 자동으로 단식 1경기를 만듭니다."
                    :"복식으로 2명이 남으면 대기시키지 않고 자동으로 단식 1경기를 만듭니다."}
                </span>}
              </>}
          </div>
          {isAdmin&&matchType==="season"&&<div className="seasonFairMode">
            <div>
              <b>시즌 공정 대진</b>
              <span>현재 시즌 성적이 비슷한 회원을 우선 묶고, 그 안에서 OTR로 양 팀 전력을 최대한 비슷하게 만듭니다.</span>
            </div>
            <small>대진표를 한 번 생성할 때 선택한 모든 참가자는 시즌 기록을 정확히 1경기씩 받습니다. 복식 인원이 4명 단위로 맞지 않아 1명, 2명 또는 3명이 남으면 이미 시즌 경기를 받은 참가자 중 필요한 인원을 보조출전으로 자동 재투입해 복식 보조경기를 만듭니다. 예를 들어 6명이면 남은 2명 + 보조출전 2명으로 복식 1경기를 추가합니다. 이때 보조출전 선수는 남은 참가자와 OTR이 최대한 비슷한 선수부터 검토하고, 최종적으로 양 팀 총 OTR 차이가 가장 작아지도록 편성합니다. 보조출전의 추가 경기는 OTR·통산전적에만 반영되고 시즌전적에는 두 번 들어가지 않습니다.</small>
            <div className="seasonCreditLegend">
              <span className="seasonCreditBadge credited">시즌반영</span><span>이번 세트의 시즌 승패/포인트에 포함</span>
              <span className="seasonCreditBadge helper">보조출전</span><span>OTR·통산전적만 반영, 시즌 승패/포인트 제외</span>
            </div>
          </div>}

          {!(isAdmin&&matchType==="season")&&mode==="manual"&&<div className="manualBuilder">
            <div className="manualHead">
              <div><h3>직접 대진 지정</h3><p>A팀과 B팀 선수를 직접 선택하세요. 직접 지정은 추가한 경기 수만큼 저장됩니다.</p></div>
              <button className="secondaryBtn manualAddMatchBtn" onClick={addManualMatch}><span className="manualAddIcon">＋</span><span>경기 추가</span></button>
            </div>
            <div className="manualMatchList">
              {manualMatches.map((m,i)=><div className="manualMatchCard" key={i}>
                <div className="manualMatchTitle"><b>경기 {i+1}</b>{manualMatches.length>1&&<button className="miniDanger" onClick={()=>removeManualMatch(i)}>삭제</button>}</div>
                <div className="manualTeams">
                  <div className="manualTeam">
                    <span>{matchFormat==="singles"?"PLAYER A":"TEAM A"}</span>
                    <PersonPicker
                      members={pickerMembers}
                      value={m.a1}
                      onChange={id=>updateManualMatch(i,"a1",id)}
                      placeholder="선수 1 선택"
                    />
                    {matchFormat==="doubles"&&<PersonPicker
                      members={pickerMembers}
                      value={m.a2}
                      onChange={id=>updateManualMatch(i,"a2",id)}
                      placeholder="선수 2 선택"
                    />}
                  </div>
                  <div className="manualVs">VS</div>
                  <div className="manualTeam">
                    <span>{matchFormat==="singles"?"PLAYER B":"TEAM B"}</span>
                    <PersonPicker
                      members={pickerMembers}
                      value={m.b1}
                      onChange={id=>updateManualMatch(i,"b1",id)}
                      placeholder="선수 1 선택"
                    />
                    {matchFormat==="doubles"&&<PersonPicker
                      members={pickerMembers}
                      value={m.b2}
                      onChange={id=>updateManualMatch(i,"b2",id)}
                      placeholder="선수 2 선택"
                    />}
                  </div>
                </div>
              </div>)}
            </div>
          </div>}

          <button className="primary wide" disabled={(isAdmin&&matchType==="season")
            ?(matchFormat==="doubles"?selected.length<4:selected.length<2)
            :mode!=="manual"&&selected.length<2} onClick={makeDraw}>대진표 생성 + 저장</button>
        </section>}
      </div>}

      {tab==="schedule"&&<>
        <section className="surface padded wktcUpcomingIntro">
          <div className="sectionHead">
            <div>
              <h2>예정된 게임</h2>
              <small>대진표에서 만든 경기 중 아직 결과가 입력되지 않은 경기만 표시됩니다.</small>
            </div>
            {isAdmin&&<button onClick={()=>navigate("session")}>새 대진 만들기 ›</button>}
          </div>
        </section>

        {!isAdmin&&!memberUnlocked&&pendingMatches.length>0&&<section className="surface padded">
          <form className="memberPinBox" onSubmit={unlockMemberMode}>
            <b>스코어 입력</b>
            <p>예정된 게임 목록은 누구나 볼 수 있습니다. 결과를 입력하려면 본인의 4자리 개인 PIN으로 인증해주세요.</p>
            <div>
              <input type="password" inputMode="numeric" maxLength="4" value={memberPin} onChange={e=>setMemberPin(e.target.value.replace(/\D/g,"").slice(0,4))} placeholder="4자리 PIN"/>
              <button className="primary">확인</button>
            </div>
          </form>
        </section>}

        {pendingMatches.length>0&&<section className="surface padded">
          <div className="sectionHead">
            <h2>게임 목록</h2>
            <span>{pendingMatches.length}경기 예정</span>
          </div>
          <div className="matchGrid wktcPendingMatchGrid">{pendingMatches.map((m,i)=>{
            const key=m.id||i,v=scoreInputs[key]||{a:"",b:""};
            const ss=sessionMap[m.session_id];
            const canScore=isAdmin||memberUnlocked;
            return <div id={`pending-match-${m.id}`} className="matchCard friendlyPendingCard wktcPendingMatchCard" key={key}>
              <div className="matchTypeBanner">
                <span className="matchTypePill friendly">클럽 게임</span>
                <span className="matchTypeHint">예정 경기</span>
              </div>
              <div className="matchTitle">
                <b>{m.match_format==="singles"?"SINGLES":"DOUBLES"}</b>
                <span>Round {m.round_no||1}{m.court_no?` · Court ${m.court_no}`:""}</span>
              </div>
              {ss&&<div className="pendingSessionMeta">
                {ss.session_date} · {String(ss.start_time||"").slice(0,5)}
              </div>}
              <div className="teams">
                <Team title="TEAM A" p={m.a} onOpenProfile={openProfile} seasonMatch={false} creditFor={()=>true}/>
                <span className="vs">VS</span>
                <Team title="TEAM B" p={m.b} onOpenProfile={openProfile} seasonMatch={false} creditFor={()=>true}/>
              </div>

              {canScore
                ?<div className="scoreEntry">
                  <label>A<input type="number" min="0" value={v.a} onChange={e=>setScoreInputs(s=>({...s,[key]:{...v,a:e.target.value}}))}/></label>
                  <span>:</span>
                  <label>B<input type="number" min="0" value={v.b} onChange={e=>setScoreInputs(s=>({...s,[key]:{...v,b:e.target.value}}))}/></label>
                  <button className="primary" onClick={()=>submitCurrentScore(m,i)}>결과 저장</button>
                </div>
                :<div className="pendingPermissionNote friendly">회원 PIN 인증 후 스코어 입력 가능</div>}

              {isAdmin
                ?<button className="cancelFriendlyBtn pendingDeleteBtn" onClick={()=>deletePendingMatch(m)}>경기 삭제</button>
                :memberUnlocked&&<button className="cancelFriendlyBtn" onClick={()=>cancelFriendlyMatch(m)}>경기 취소 / 삭제</button>}
            </div>;
          })}</div>
        </section>}

        {pendingMatches.length===0&&<section className="surface padded">
          <div className="emptyState wktcUpcomingEmpty">
            <b>현재 예정된 게임이 없습니다.</b>
            <span>대진표를 만들면 아직 결과가 없는 게임이 이곳에 자동으로 표시됩니다.</span>
            {isAdmin&&<button className="primary" onClick={()=>navigate("session")}>대진표 만들기</button>}
          </div>
        </section>}
      </>}

      {tab==="draw"&&<section className="surface padded">
        <div className="sectionHead historyPageHead">
          <div>
            <h2>경기 기록</h2>
            <small>전체 {historyMatches.filter(m=>m.winner).length}경기</small>
          </div>
        </div>
        <History
          seasons={seasons}
          sessions={sessions}
          matches={historyMatches.filter(m=>{
            if(!m.winner)return false;
            if(historyFilter==="all")return true;
            return sessionMap[m.session_id]?.match_type===historyFilter;
          })}
          memberMap={memberMap}
          isAdmin={isAdmin}
          onEdit={openMatchEdit}
          onDelete={deleteMatch}
          otrEvents={otrEvents}
          onOpenProfile={openProfile}
          seasonCreditFor={seasonCreditFor}
        />
      </section>}

      {tab==="ranking"&&<div className="rankingPage exactRankingPage">
        <section className="rankingCombinedCard">
          <div className="rankingTopBar">
            <div className="rankingTopTabs">
              <button className="rankingTopTab active" type="button">WKTC 클럽 랭킹</button>
            </div>
          </div>

          <div id="club-ranking-section" className="rankingSectionBlock singleRankingBlock rankingAnchorSection">
            <div className="rankingSectionHead">
              <div><h3>클럽 랭킹 (통산) <span className="rankingInfo">ⓘ</span></h3></div>
              <div className="rankingSectionMeta">
                <b>기준: 글로벌 OTR</b>
                <span>회원 {memberRanked.length}명</span>
              </div>
            </div>

            <div className="tableWrap rankingTable exactRankingTable">
              <table>
                <thead>
                  <tr>
                    <th>순위</th><th>회원명</th><th>OTR</th><th>승</th><th>패</th><th>승률</th><th>경기 수</th>
                  </tr>
                </thead>
                <tbody>
                  {(showAllClubRank?memberRanked:memberRanked.slice(0,6)).map((m,i)=>{
                    const n=m.wins+m.losses;
                    return <tr key={m.id}>
                      <td><span className={`exactRank ${i===0?"gold":i===1?"silver":i===2?"bronze":""}`}>{i+1}</span></td>
                      <td className="memberCell"><button className="nameLink" onClick={()=>openProfile(m.id)}>{m.name}</button></td>
                      <td><b>{m.rating.toLocaleString()}</b></td>
                      <td>{m.wins}</td>
                      <td>{m.losses}</td>
                      <td>{n?Math.round(m.wins/n*100):0}%</td>
                      <td>{n}</td>
                    </tr>
                  })}
                </tbody>
              </table>
            </div>

            {memberRanked.length>6&&<div className="rankingMoreWrap">
              <button className="rankingMoreBtn" onClick={()=>setShowAllClubRank(v=>!v)}>
                {showAllClubRank?"상위 6명만 보기":"전체 클럽 랭킹 보기"} <span>{showAllClubRank?"↑":"→"}</span>
              </button>
            </div>}
          </div>
        </section>
      </div>}

      {false&&<>
        {!isAdmin&&!memberUnlocked
          ?<section className="surface padded accountingUnlock">
            <div className="sectionHead"><h2>회계</h2></div>
            <form className="memberPinBox" onSubmit={unlockAccounting}>
              <b>개인 PIN 확인</b>
              <p>수입 · 지출 · 회비 현황은 본인의 4자리 개인 PIN으로 인증한 회원만 열람할 수 있습니다.</p>
              <div><input type="password" inputMode="numeric" maxLength="4" value={memberPin} onChange={e=>setMemberPin(e.target.value.replace(/\D/g,"").slice(0,4))} placeholder="4자리 PIN"/><button className="primary">확인</button></div>
            </form>
          </section>
          :<>
            <div className={isAdmin?"financeMetrics":"financeMetrics memberFinanceMetrics"}>
              <div className="financeMetric"><small>현재 잔액</small><b>${financeSummary.balance.toFixed(2)}</b></div>
              <div className="financeMetric"><small>총 수입</small><b>${financeSummary.income.toFixed(2)}</b></div>
              <div className="financeMetric"><small>총 지출</small><b>${financeSummary.expense.toFixed(2)}</b></div>
              {isAdmin&&<div className="financeMetric"><small>미수 회비</small><b>${memberDues.reduce((s,x)=>s+x.due,0).toFixed(2)}</b></div>}
            </div>

            {isAdmin&&<section className="surface padded">
              <div className="sectionHead"><h2>회비 관리</h2><span>관리자 전용</span></div>
              <div className="financeAdminGrid wktcFinanceAdminGrid">
                <form className="financeForm wktcMonthlyFeeForm" onSubmit={generateVktcMonthlyDues}>
                  <h3>회원 월회비</h3>
                  <p>정회원과 준회원에게 매월 1회 $30을 청구합니다. 같은 월은 다시 눌러도 중복 청구되지 않습니다.</p>
                  <label>회비 월<input type="month" value={monthlyFeeMonth} onChange={e=>setMonthlyFeeMonth(e.target.value)}/></label>
                  <div className="wktcFeeRule"><b>$30</b><span>정회원 · 준회원 / 월</span></div>
                  <button className="primary">이 달 월회비 생성</button>
                </form>

                <form className="financeForm bulkAttendanceForm" onSubmit={addAttendanceBatch}>
                  <div className="bulkAttendanceHead">
                    <div><h3>게스트 참가비</h3><p>게스트 방문 1회당 $15입니다.</p></div>
                    <label>날짜<input type="date" value={attendanceForm.date} onChange={e=>setAttendanceForm({...attendanceForm,date:e.target.value})}/></label>
                  </div>

                  <div className="attendanceToolbar">
                    <label className="financeCheck">
                      <input
                        type="checkbox"
                        checked={activeMembers.filter(m=>publicMemberType(m)==="guest").length>0&&attendanceForm.selected.length===activeMembers.filter(m=>publicMemberType(m)==="guest").length}
                        onChange={e=>toggleAllAttendance(e.target.checked)}
                      />
                      게스트 전체 선택
                    </label>
                    <span>게스트 1회 $15</span>
                  </div>

                  <div className="attendanceList">
                    {activeMembers.filter(m=>publicMemberType(m)==="guest").map(m=>{
                      const checked=attendanceForm.selected.includes(m.id);
                      const received=attendanceForm.received[m.id]??true;
                      const already=financeCharges.some(x=>x.member_id===m.id&&x.charge_date===attendanceForm.date&&Number(x.amount)===15);
                      return <div className={checked?"attendanceRow selected":"attendanceRow"} key={m.id}>
                        <label className="attendancePerson">
                          <input type="checkbox" checked={checked} onChange={e=>toggleAttendanceMember(m,e.target.checked)}/>
                          <span><b>{m.name}</b><small>게스트 · $15{already?" · 오늘 기록 있음":""}</small></span>
                        </label>
                        <span className="wktcGuestFixedFee">$15</span>
                        <label className="attendanceReceived">
                          <input type="checkbox" disabled={!checked} checked={checked&&received} onChange={e=>setAttendanceForm(prev=>({...prev,received:{...prev.received,[m.id]:e.target.checked}}))}/>
                          받음
                        </label>
                      </div>
                    })}
                    {!activeMembers.some(m=>publicMemberType(m)==="guest")&&<div className="emptyState">활동중인 게스트가 없습니다.</div>}
                  </div>

                  <label>공통 메모<input value={attendanceForm.note} onChange={e=>setAttendanceForm({...attendanceForm,note:e.target.value})} placeholder="선택"/></label>
                  <button className="primary" disabled={!attendanceForm.selected.length}>선택한 {attendanceForm.selected.length}명 게스트 참가비 저장</button>
                </form>

                <form className="financeForm" onSubmit={addFinanceTransaction}>
                  <h3>기타 수입 / 지출</h3>
                  <label>구분<select value={transactionForm.type} onChange={e=>setTransactionForm({...transactionForm,type:e.target.value})}><option value="expense">지출</option><option value="income">수입</option></select></label>
                  <label>날짜<input type="date" value={transactionForm.date} onChange={e=>setTransactionForm({...transactionForm,date:e.target.value})}/></label>
                  <label>항목<input value={transactionForm.category} onChange={e=>setTransactionForm({...transactionForm,category:e.target.value})} placeholder="코트비 / 공 / 기타"/></label>
                  <label>금액<input type="number" min="0" step="0.01" value={transactionForm.amount} onChange={e=>setTransactionForm({...transactionForm,amount:e.target.value})}/></label>
                  <label>메모<input value={transactionForm.note} onChange={e=>setTransactionForm({...transactionForm,note:e.target.value})}/></label>
                  <button className="primary">거래 저장</button>
                </form>
              </div>
            </section>}

            {isAdmin&&<section className="surface padded">
              <div className="sectionHead"><h2>월회비 · 게스트 결제 현황</h2><span>관리자 전용</span></div>
              <div className="tableWrap financeTable"><table><thead><tr><th>회원</th><th>청구 건수</th><th>발생 금액</th><th>납부</th><th>미수</th><th>상태</th><th>내역</th></tr></thead><tbody>
                {memberDues.map(x=><React.Fragment key={x.member.id}>
                  <tr>
                    <td>
                      <button className="nameLink" onClick={()=>openProfile(x.member.id)}>{x.member.name}</button>
                      {x.isGuest&&<span className="financeGuestTag">게스트</span>}
                    </td>
                    <td>{x.attendance}건</td><td>${x.charged.toFixed(2)}</td><td>${x.paid.toFixed(2)}</td><td><b>${x.due.toFixed(2)}</b></td>
                    <td>
                      {x.due>0
                        ?<button className={x.isGuest?"duesPayBtn guestPending":"duesPayBtn"} onClick={()=>settleMemberDues(x.member.id)}>결제 대기</button>
                        :<span className="duesBadge paid">완납</span>}
                    </td>
                    <td><button className="duesDetailBtn" onClick={()=>setDuesDetailMemberId(v=>v===x.member.id?null:x.member.id)}>{duesDetailMemberId===x.member.id?"닫기":"내역 보기"}</button></td>
                  </tr>
                  {duesDetailMemberId===x.member.id&&<tr className="duesDetailTableRow"><td colSpan="7">
                    <div className="duesDetailPanel">
                      <div className="duesDetailHead"><b>{x.member.name} 회비 발생 내역</b><span>날짜별 발생 금액을 확인하고 수정할 수 있습니다.</span></div>
                      <div className="duesChargeList">
                        {financeCharges
                          .filter(c=>c.member_id===x.member.id)
                          .sort((a,b)=>String(b.charge_date).localeCompare(String(a.charge_date))||String(b.created_at||"").localeCompare(String(a.created_at||"")))
                          .map(c=><div className="duesChargeRow" key={c.id}>
                            <span className="duesChargeDate">{c.charge_date}</span>
                            <span className="duesChargeNote">{c.note||"회비"}</span>
                            {editingChargeId===c.id
                              ?<div className="duesChargeEdit">
                                <span>$</span><input type="number" min="0" step="0.01" value={editingChargeAmount} onChange={e=>setEditingChargeAmount(e.target.value)}/>
                                <button className="duesSaveBtn" onClick={()=>saveFinanceChargeAmount(c)}>저장</button>
                                <button className="duesCancelBtn" onClick={()=>{setEditingChargeId(null);setEditingChargeAmount("");}}>취소</button>
                              </div>
                              :<div className="duesChargeAmount">
                                <b>${Number(c.amount||0).toFixed(2)}</b>
                                <button onClick={()=>{setEditingChargeId(c.id);setEditingChargeAmount(String(c.amount??0));}}>수정</button>
                              </div>}
                          </div>)}
                        {!financeCharges.some(c=>c.member_id===x.member.id)&&<div className="emptyState">회비 발생 내역이 없습니다.</div>}
                      </div>
                    </div>
                  </td></tr>}
                </React.Fragment>)}
              </tbody></table></div>
            </section>}

            <section className="surface padded">
              <div className="sectionHead"><h2>수입 · 지출 내역</h2><span>{financeTransactions.length}건</span></div>
              {financeBusy?<div className="emptyState">불러오는 중...</div>:<div className="tableWrap financeTable"><table><thead><tr><th>날짜</th><th>구분</th><th>항목</th><th>내용</th><th>금액</th>{isAdmin&&<th></th>}</tr></thead><tbody>
                {financeTransactions.map(x=><tr key={x.id}>
                  <td>{x.transaction_date}</td>
                  <td><span className={x.type==="income"?"moneyType income":"moneyType expense"}>{x.type==="income"?"수입":"지출"}</span></td>
                  <td>{x.category}</td><td>{x.note||"-"}</td>
                  <td className={x.type==="income"?"money income":"money expense"}>{x.type==="income"?"+":"-"}${Number(x.amount).toFixed(2)}</td>
                  {isAdmin&&<td><button className="deleteRecord" onClick={()=>deleteFinanceTransaction(x.id)}>삭제</button></td>}
                </tr>)}
                {!financeTransactions.length&&<tr><td colSpan={isAdmin?6:5}>아직 수입/지출 내역이 없습니다.</td></tr>}
              </tbody></table></div>}
            </section>
          </>}
      </>}

      {tab==="hall"&&<>
        {isAdmin&&<section className="surface padded"><div className="sectionHead"><h2>명예의 전당 등록</h2></div><form className="hallForm" onSubmit={addHallEntry}><select value={hallForm.season_id} onChange={e=>setHallForm({...hallForm,season_id:e.target.value})}><option value="">시즌 선택</option>{seasons.map(x=><option key={x.id} value={x.id}>Season {x.season_no}</option>)}</select><input placeholder="우승자 이름" value={hallForm.champion_name} onChange={e=>setHallForm({...hallForm,champion_name:e.target.value})}/><input placeholder="준우승자 (선택)" value={hallForm.runner_up_name} onChange={e=>setHallForm({...hallForm,runner_up_name:e.target.value})}/><button className="primary">저장</button></form></section>}
        <section className="surface padded"><div className="sectionHead"><h2>Open Court Hall of Fame</h2></div><div className="hallGrid">{seasons.map(ss=>{const h=hall.find(x=>x.season_id===ss.id);return <div className="hallCard" key={ss.id}><span>♛</span><small>SEASON {ss.season_no}</small><h3>{h?.champion_name|| (ss.is_current?"진행 중":"기록 없음")}</h3>{h?.runner_up_name&&<p>준우승 {h.runner_up_name}</p>}</div>})}</div></section>
      </>}

{tab==="profile"&&<MemberProfile member={memberMap[profileMemberId]?{...memberMap[profileMemberId],member_type:publicMemberType(memberMap[profileMemberId])}:null} matches={historyMatches} sessions={sessionMap} memberMap={memberMap} events={otrEvents} seasons={seasons} onOpenProfile={openProfile}/>}

      {tab==="settings"&&isAdmin&&<>
        <section className="surface padded">
          <div className="sectionHead"><h2>설정</h2></div>
          <div className="settingsBlock">
            <b>클럽</b><p>WKTC (Wellington Korean Tennis Club)</p>
            <b>관리자</b><p>{user?.email}</p>
            <b>클럽 관리자 권한</b><p>{clubAdminAccess?.role==="owner"?"WKTC OWNER":clubAdminAccess?.role==="admin"?"WKTC ADMIN":"권한 없음"}</p>
            <b>시스템 권한</b><p>{isSystemAdmin?"GLOBAL OTR SYSTEM OWNER":"클럽 운영 권한만 사용"}</p>
            <b>공개 권한</b><p>회원은 로그인 없이 조회만 가능</p>
            <b>점수 명칭</b><p>OTR 2.0 (Open Tennis Rating)</p>

            <b>회원 개인 PIN</b>
            <p>회원 PIN은 클럽별로 따로 저장되고 인증됩니다. WKTC의 정회원 또는 준회원에게는 WKTC용 숫자 4자리 PIN을 설정하세요. 같은 선수가 OPEN COURT나 다른 클럽에서도 같은 번호를 원하면 같은 PIN을 사용할 수 있습니다. 다만 같은 클럽 안에서는 두 회원이 같은 PIN을 사용할 수 없습니다. WKTC PIN으로는 WKTC의 대진 생성 · 경기 결과 입력 · MY PAGE를 인증합니다.</p>
          </div>
        </section>

        <section className="surface padded adminPasswordPanel">
          <div className="sectionHead">
            <div>
              <h2>관리자 계정 비밀번호</h2>
              <small>현재 로그인한 관리자 본인의 비밀번호만 변경할 수 있습니다.</small>
            </div>
            <span className="adminPasswordEmail">{user?.email}</span>
          </div>

          <form className="adminPasswordForm" onSubmit={changeAdminPassword}>
            <label>현재 비밀번호
              <input
                type="password"
                autoComplete="current-password"
                value={adminPasswordForm.current}
                onChange={e=>setAdminPasswordForm({...adminPasswordForm,current:e.target.value})}
                placeholder="현재 비밀번호"
              />
            </label>
            <label>새 비밀번호
              <input
                type="password"
                autoComplete="new-password"
                value={adminPasswordForm.next}
                onChange={e=>setAdminPasswordForm({...adminPasswordForm,next:e.target.value})}
                placeholder="8자 이상"
              />
            </label>
            <label>새 비밀번호 확인
              <input
                type="password"
                autoComplete="new-password"
                value={adminPasswordForm.confirm}
                onChange={e=>setAdminPasswordForm({...adminPasswordForm,confirm:e.target.value})}
                placeholder="새 비밀번호 다시 입력"
              />
            </label>
            {adminPasswordError&&<div className="adminPasswordError">{adminPasswordError}</div>}
            <div className="adminPasswordActions">
              <p>변경이 완료되면 자동으로 로그아웃됩니다. 이후에는 새 비밀번호로 로그인해야 합니다.</p>
              <button className="primary" disabled={adminPasswordBusy}>
                {adminPasswordBusy?"변경 중...":"비밀번호 변경"}
              </button>
            </div>
          </form>
        </section>

        <section className="surface padded multiClubFoundationPanel">
          <div className="sectionHead">
            <div>
              <h2>공용 OTR · WKTC 독립 운영</h2>
              <small>V11.59 WKTC</small>
            </div>
            <span className="multiClubReadyBadge">{clubFoundationError?"확인 필요":isAdmin?"SECURED":"READY"}</span>
          </div>

          {clubFoundationError
            ?<div className="multiClubError">V11.40 SQL 적용 후 새로고침해주세요.<br/>{clubFoundationError}</div>
            :<>
              <div className="multiClubStats">
                <div><small>등록 클럽</small><b>{clubs.length}</b><span>같은 DB 안에서 클럽별 데이터 분리</span></div>
                <div><small>공용 선수 DB</small><b>{clubFoundationSnapshot?.global_players??"—"}</b><span>글로벌 선수/OTR 원장</span></div>
                <div><small>WKTC 선수 목록</small><b>{clubFoundationSnapshot?.roster_players??members.length}</b><span>이 사이트에서만 사용하는 로스터</span></div>
                <div><small>WKTC 정회원</small><b>{openCourtRegularCount}</b><span>4개 클럽 전체에서 정회원은 1곳만 가능</span></div>
                <div><small>WKTC 준회원</small><b>{openCourtAssociateCount}</b><span>일반 화면에서는 회원으로만 표시</span></div>
              </div>
              <div className="multiClubCurrentClub">
                <b>현재 사이트</b>
                <span>{clubMap[CURRENT_CLUB_ID]?.name||"Wellington Korean Tennis Club"}</span>
                <small>Club ID · {CURRENT_CLUB_ID}</small>
              </div>
              <div className="multiClubFoundationNote">
                <b>이번 단계에서 완료된 것</b>
                <p><b>관리자 권한:</b> Insunryu7399@gmail.com 계정을 WKTC 관리자 초대로 등록했습니다. 해당 Supabase Auth 계정으로 로그인하면 WKTC 관리자 권한이 연결됩니다.</p>
                <p><b>WKTC 전용 영역:</b> 경기 · 행사 · 회원소속은 WKTC Club ID로 분리됩니다. 별도 스케줄 배치 시스템은 사용하지 않고 예정된 게임 목록만 사용합니다. 시즌대회 · OPEN PICK · 명예의 전당은 사용하지 않습니다.</p>
                <p><b>회계 기능:</b> WKTC에서는 회계 메뉴와 회비/게스트비 기록 기능을 사용하지 않습니다.</p>
              </div>
            </>}
        </section>

        {isSystemAdmin&&<section className="surface padded otrRebuildPanel">
          <div className="sectionHead otrRebuildHead">
            <div>
              <h2>OTR 시작점 전체 재설정</h2>
              <small>시작 OTR을 바꾼 뒤 지금까지의 완료 경기를 처음부터 다시 재생합니다.</small>
            </div>
            <button type="button" onClick={loadOtrRebuildEditor} disabled={otrRebuildLoading||otrRebuildBusy}>새로고침</button>
          </div>

          <div className="otrRebuildWarning">
            <b>중요</b>
            <p>이 기능은 단순히 현재 OTR 숫자만 바꾸는 기능이 아닙니다. 각 선수의 새로운 시작 OTR에서 출발해 저장된 모든 완료 경기의 스코어를 날짜·라운드 순서대로 다시 계산합니다. 단식/복식, 시즌/비정규 경기가 모두 포함됩니다.</p>
            <p>경기 스코어, 승자, 시즌반영 여부, 시즌 기록 자체는 바꾸지 않습니다. 기존 관리자 수동 OTR 조정 이벤트는 새 타임라인에서 제외되며, 실행 직전 상태는 자동 백업됩니다.</p>
          </div>

          {otrRebuildLoading
            ?<div className="otrRebuildLoading">시작 OTR 정보를 불러오는 중...</div>
            :<>
              <div className="otrSeedTableWrap">
                <table className="otrSeedTable">
                  <thead>
                    <tr><th>선수</th><th>현재 OTR</th><th>새 시작 OTR</th><th>미리보기 현재 OTR</th><th>변화</th></tr>
                  </thead>
                  <tbody>
                    {otrSeedRows.map(row=>{
                      const pv=otrSeedPreviewMap[row.member_id];
                      const change=pv?Number(pv.change_from_current||0):null;
                      return <tr key={row.member_id}>
                        <td>
                          <b>{row.name}</b>
                          <small>{row.member_type==="guest"?"게스트":"회원"}{row.active?"":" · 비활동"}</small>
                        </td>
                        <td><strong>{Number(row.current_rating).toLocaleString()}</strong></td>
                        <td>
                          <input
                            type="number"
                            min="100"
                            max="3000"
                            step="1"
                            value={row.seed_rating}
                            onChange={e=>updateOtrSeed(row.member_id,e.target.value)}
                          />
                        </td>
                        <td>{pv?<strong className="otrProjectedValue">{Number(pv.projected_rating).toLocaleString()}</strong>:<span className="otrPreviewDash">—</span>}</td>
                        <td>{pv?<span className={change>0?"otrRebuildDelta plus":change<0?"otrRebuildDelta minus":"otrRebuildDelta"}>{change>0?"+":""}{change}</span>:<span className="otrPreviewDash">—</span>}</td>
                      </tr>;
                    })}
                  </tbody>
                </table>
              </div>

              {otrSeedPreview&&<div className="otrPreviewSummary">
                <div><small>재생할 완료 경기</small><b>{Number(otrSeedPreview.matches||0)}경기</b></div>
                <div><small>계산 대상 선수</small><b>{(otrSeedPreview.members||[]).length}명</b></div>
                <div><small>계산 공식</small><b>NO ZERO-SUM</b></div>
              </div>}

              <div className="otrRebuildActions">
                <button type="button" className="secondaryBtn" onClick={previewOtrRebuild} disabled={otrRebuildBusy||!otrSeedRows.length}>
                  {otrRebuildBusy?"계산 중...":"1. 재계산 미리보기"}
                </button>
                <button type="button" className="primary" onClick={applyOtrRebuild} disabled={otrRebuildBusy||!otrSeedPreview}>
                  2. 새 OTR 확정 적용
                </button>
              </div>

              <div className="otrRebuildBackupBox">
                <div>
                  <b>안전 백업</b>
                  {otrRebuildLastBackup
                    ?<small>최근 재계산: {new Date(otrRebuildLastBackup.created_at).toLocaleString("ko-KR")}{otrRebuildLastBackup.restored_at?" · 이미 되돌림":""}</small>
                    :<small>아직 OTR 전체 재계산 백업이 없습니다.</small>}
                </div>
                <button type="button" onClick={restoreLastOtrRebuild} disabled={otrRebuildBusy||!otrRebuildLastBackup||!!otrRebuildLastBackup.restored_at}>최근 재계산 되돌리기</button>
              </div>
            </>}
        </section>}

      </>}
    </main>

    {pinEditMember&&isAdmin&&<Modal onClose={()=>{setPinEditMember(null);setPersonalPinForm({pin:"",confirm:""});}}>
      <div className="modalHead">
        <div><h2>개인 PIN 설정</h2><p>{pinEditMember.name} 회원</p></div>
        <button onClick={()=>{setPinEditMember(null);setPersonalPinForm({pin:"",confirm:""});}}>×</button>
      </div>
      <form className="personalPinModal" onSubmit={saveMemberPersonalPin}>
        <p>이 PIN은 WKTC 사이트에서 사용하는 클럽 전용 PIN입니다. 같은 선수가 다른 클럽에서도 같은 숫자를 원하면 같은 PIN을 사용할 수 있습니다. 단, WKTC 안에서는 다른 회원과 같은 PIN을 사용할 수 없습니다.</p>
        <label>새 개인 PIN<input type="password" inputMode="numeric" maxLength="4" value={personalPinForm.pin} onChange={e=>setPersonalPinForm({...personalPinForm,pin:e.target.value.replace(/\D/g,"").slice(0,4)})} placeholder="예: 3212" autoFocus/></label>
        <label>PIN 확인<input type="password" inputMode="numeric" maxLength="4" value={personalPinForm.confirm} onChange={e=>setPersonalPinForm({...personalPinForm,confirm:e.target.value.replace(/\D/g,"").slice(0,4)})} placeholder="4자리 다시 입력"/></label>
        <button className="primary" disabled={personalPinBusy}>{personalPinBusy?"저장 중...":"개인 PIN 저장"}</button>
      </form>
    </Modal>}

    {lessonEditSlot&&isAdmin&&<Modal onClose={()=>{setLessonEditSlot(null);setLessonMemberId("");}}>
      <div className="modalHead">
        <div>
          <h2>레슨 참가자 배정</h2>
          <p>{lessonEditSlot.slot.label} · {lessonEditSlot.courtNo}코트</p>
        </div>
        <button onClick={()=>{setLessonEditSlot(null);setLessonMemberId("");}}>×</button>
      </div>

      <div className="lessonEditor">
        <p className="lessonEditorHelp">
          한 줄에 여러 명을 넣을 수 있습니다. 1시간 레슨처럼 길게 사용하는 경우 같은 이름을
          1경기와 2경기처럼 필요한 줄에 각각 추가하면 됩니다.
        </p>

        <form className="lessonEditorForm" onSubmit={addLessonParticipant}>
          <label>회원 / 게스트
            <PersonPicker
              members={[...pickerMembers].sort((a,b)=>a.name.localeCompare(b.name))}
              value={lessonMemberId}
              onChange={id=>setLessonMemberId(id)}
              placeholder="참가자를 선택하세요"
              showRating={false}
            />
          </label>
          <button className="primary" disabled={!lessonMemberId}>추가</button>
        </form>

        <div className="lessonEditorCurrent">
          <b>현재 배정</b>
          {(scheduleLessonParticipants||[])
            .filter(x=>String(x.start_time||"").slice(0,5)===lessonEditSlot.slot.start&&Number(x.court_no)===Number(lessonEditSlot.courtNo))
            .map(x=><div className="lessonEditorRow" key={x.id}>
              <span>{memberMap[x.member_id]?.name||"회원"}</span>
              <small>{publicMemberLabel(memberMap[x.member_id])}</small>
              <button onClick={()=>removeLessonParticipant(x.id)}>삭제</button>
            </div>)}
          {!scheduleLessonParticipants.some(x=>String(x.start_time||"").slice(0,5)===lessonEditSlot.slot.start&&Number(x.court_no)===Number(lessonEditSlot.courtNo))&&
            <div className="emptyState">아직 배정된 레슨 참가자가 없습니다.</div>}
        </div>
      </div>
    </Modal>}

    {loginOpen&&<Modal onClose={()=>setLoginOpen(false)}>
      <div className="modalHead"><div><h2>관리자 로그인</h2><p>일반 회원은 로그인할 필요가 없습니다.</p></div><button onClick={()=>setLoginOpen(false)}>×</button></div>
      <form className="modalForm" onSubmit={signIn}><label>이메일<input type="email" required value={loginForm.email} onChange={e=>setLoginForm({...loginForm,email:e.target.value})}/></label><label>비밀번호<input type="password" required value={loginForm.password} onChange={e=>setLoginForm({...loginForm,password:e.target.value})}/></label>{loginError&&<div className="loginError">{loginError}</div>}<button className="primary wide" disabled={loginBusy}>{loginBusy?"로그인 중...":"관리자 로그인"}</button></form>
    </Modal>}

    {editingMember&&<Modal onClose={()=>setEditingMember(null)}>
      <div className="modalHead"><div><h2>회원 정보 수정</h2><p>관리자는 정회원·준회원·게스트를 구분해서 관리합니다.</p></div><button onClick={()=>setEditingMember(null)}>×</button></div>
      <form className="modalForm" onSubmit={saveMemberEdit}>
        <label>이름<input value={editMemberForm.name} onChange={e=>setEditMemberForm({...editMemberForm,name:e.target.value})}/></label>
        <label>관리 등급<select value={editMemberForm.membership_status} onChange={e=>setEditMemberForm({...editMemberForm,membership_status:e.target.value})}>
          <option value="regular">정회원</option>
          <option value="associate">준회원</option>
          <option value="guest">게스트</option>
        </select></label>
        <div className="membershipModalHint">정회원은 4개 클럽 전체에서 1곳만 가능합니다. 이미 다른 클럽 정회원이면 저장이 거부됩니다. 정회원과 준회원은 일반 회원 화면에서는 모두 '회원'으로 표시됩니다.</div>
        <label>현재 OTR<input type="number" value={editMemberForm.rating} disabled={!isSystemAdmin} onChange={e=>setEditMemberForm({...editMemberForm,rating:e.target.value})}/></label>
        {!isSystemAdmin&&<div className="membershipModalHint">글로벌 OTR 수동 변경은 시스템 OWNER만 가능합니다. 클럽 관리자는 경기 결과를 통해서만 OTR을 변경할 수 있습니다.</div>}
        <button className="primary wide">저장</button>
      </form>
    </Modal>}

    {editingMatch&&<Modal onClose={()=>setEditingMatch(null)}>
      <div className="modalHead"><div><h2>경기 기록 수정</h2><p>스코어를 수정하면 승/패와 모든 선수의 OTR을 다시 계산합니다.</p></div><button onClick={()=>setEditingMatch(null)}>×</button></div>
      <form className="modalForm" onSubmit={saveMatchEdit}>
        <div className="editScoreRow"><label>Team A<input type="number" min="0" value={editScore.a} onChange={e=>setEditScore({...editScore,a:e.target.value})}/></label><b>:</b><label>Team B<input type="number" min="0" value={editScore.b} onChange={e=>setEditScore({...editScore,b:e.target.value})}/></label></div>
        <button className="primary wide">수정 저장</button>
      </form>
    </Modal>}
  </div>
}


function PersonPicker({members,value,onChange,placeholder="이름 선택",showRating=true,allowClear=false}){
  const[open,setOpen]=useState(false);
  const[query,setQuery]=useState("");
  const selected=(members||[]).find(m=>m.id===value);
  const filtered=(members||[]).filter(m=>m.name.toLowerCase().includes(query.trim().toLowerCase()));

  function choose(id){
    onChange?.(id);
    setOpen(false);
    setQuery("");
  }

  return <div className="personPicker">
    <button type="button" className={selected?"personPickerTrigger selected":"personPickerTrigger"} onClick={()=>setOpen(true)}>
      <span>{selected?selected.name:placeholder}</span>
      {selected&&showRating&&<small>{selected.rating} OTR</small>}
      <em>⌄</em>
    </button>

    {open&&<div className="personPickerOverlay" onMouseDown={e=>{if(e.target===e.currentTarget){setOpen(false);setQuery("");}}}>
      <div className="personPickerPanel">
        <div className="personPickerHead">
          <div><b>{placeholder}</b><small>이름을 한 번 누르면 바로 선택됩니다.</small></div>
          <button type="button" onClick={()=>{setOpen(false);setQuery("");}}>×</button>
        </div>

        <div className="personPickerSearch">
          <input
            autoFocus
            value={query}
            onChange={e=>setQuery(e.target.value)}
            placeholder="이름 검색"
          />
          {query&&<button type="button" onClick={()=>setQuery("")}>지우기</button>}
        </div>

        <div className="personPickerList">
          {allowClear&&<button type="button" className="personPickerClear" onClick={()=>choose("")}>
            <span>전체 보기</span><small>선택 해제</small>
          </button>}
          {filtered.map(m=><button type="button" key={m.id} className={m.id===value?"personPickerOption active":"personPickerOption"} onClick={()=>choose(m.id)}>
            <span className="personPickerAvatar">{m.name?.[0]||"?"}</span>
            <b>{m.name}</b>
            <small>{(m.member_type||"member")==="guest"?"게스트":"회원"}{showRating?` · ${m.rating} OTR`:""}</small>
            {m.id===value&&<em>✓</em>}
          </button>)}
          {!filtered.length&&<div className="personPickerEmpty">검색된 이름이 없습니다.</div>}
        </div>
      </div>
    </div>}
  </div>;
}

function Metric({icon,label,value,unit,desc}){return <div className="metric"><span className="metricIcon">{icon}</span><div><small>{label}</small><div className="metricValue">{value}<em>{unit}</em></div><p>{desc}</p></div></div>}
function RankRow({member,rank,onOpen}){const n=member.wins+member.losses;return <div className="rankRow"><span className={"rankBadge r"+rank}>{rank}</span><div className="rankInfo"><button className="nameLink" onClick={()=>onOpen(member.id)}>{member.name}</button><small>승률 {n?Math.round(member.wins/n*100):0}% ({member.wins}승 {member.losses}패)</small></div><div className="rankPoints"><b>{member.rating.toLocaleString()}</b><small>OTR</small></div></div>}
function Team({title,p,onOpenProfile,seasonMatch=false,creditFor=null}){return <div className={`team ${title==="TEAM A"?"teamA":"teamB"}`}><div className="teamHeader"><small>{title}</small><span>같은 팀</span></div><div className="teamPlayers">{(p||[]).filter(Boolean).map(x=>{const credited=!seasonMatch||!creditFor||creditFor(x.id);return <div className="player" key={x.id}><span className="avatar">{x.name[0]}</span><div className="pendingPlayerNameRow">{onOpenProfile?<button className="teamNameLink" onClick={()=>onOpenProfile(x.id)}>{x.name}</button>:<b>{x.name}</b>}{seasonMatch&&<span className={credited?"pendingSeasonCreditBadge credited":"pendingSeasonCreditBadge helper"}>{credited?"시즌반영":"보조출전"}</span>}</div><em>{x.rating} OTR</em></div>})}</div></div>}
function RecentMatches({matches,memberMap,onOpenProfile}){
  if(!matches.length)return <div className="emptyRow">아직 저장된 경기가 없습니다.</div>;
  return <div className="recentMatchList">{matches.map(m=>{
    const a=[memberMap[m.team_a_member_1],memberMap[m.team_a_member_2]].filter(Boolean);
    const b=[memberMap[m.team_b_member_1],memberMap[m.team_b_member_2]].filter(Boolean);
    const renderTeam=(players,label)=>players.length
      ?players.map((p,idx)=><React.Fragment key={p.id}>
          <button className="dashboardPlayerLink" onClick={()=>onOpenProfile?.(p.id)}>{p.name}</button>
          {idx<players.length-1&&<span className="dashboardTeamSep"> + </span>}
        </React.Fragment>)
      :label;
    return <div className="recentMatch" key={m.id}>
      <div>
        <b className="dashboardMatchNames">
          {renderTeam(a,"Team A")}
          <span className="dashboardVs"> vs </span>
          {renderTeam(b,"Team B")}
        </b>
        <small>{m.score_a!=null?`${m.score_a} - ${m.score_b}`:"결과 대기"}</small>
      </div>
      <span className={m.winner?"winnerTag":"pendingTag"}>{m.winner?`Team ${m.winner} 승`:"대기"}</span>
    </div>;
  })}</div>
}
function History({seasons,sessions,matches,memberMap,isAdmin,onEdit,onDelete,otrEvents,onOpenProfile,seasonCreditFor}){
  if(!matches.length)return <div className="emptyState">아직 저장된 경기 기록이 없습니다.</div>;
  const visibleSessionIds=new Set(matches.map(m=>m.session_id));
  const orderedSessions=sessions.filter(s=>visibleSessionIds.has(s.id)).sort((a,b)=>{
    const aKey=`${a.session_date||""}T${String(a.start_time||"00:00")}`;
    const bKey=`${b.session_date||""}T${String(b.start_time||"00:00")}`;
    return bKey.localeCompare(aKey);
  });

  // Sessions created separately on the same calendar day are displayed
  // inside one outer record card. Each session keeps its own original
  // date/time/type/count header and all match content unchanged.
  const dayGroups=[];
  for(const s of orderedSessions){
    const date=s.session_date||"";
    let group=dayGroups.find(g=>g.date===date);
    if(!group){
      group={date,sessions:[]};
      dayGroups.push(group);
    }
    group.sessions.push(s);
  }

  return <div className="historyList">{dayGroups.map(day=><div className="historySession historyDayGroup" key={day.date}>
    {day.sessions.map(s=>{
    const ms=matches.filter(m=>m.session_id===s.id).sort((a,b)=>(Number(a.round_no)||1)-(Number(b.round_no)||1)||(Number(a.court_no)||1)-(Number(b.court_no)||1));
    if(!ms.length)return null;
    let rawSitouts=s.sitout_rounds;
    if(typeof rawSitouts==="string"){
      try{rawSitouts=JSON.parse(rawSitouts);}catch{rawSitouts=[];}
    }
    const sitoutByRound=s.match_type==="friendly"
      ?Object.fromEntries((Array.isArray(rawSitouts)?rawSitouts:[]).map(r=>[
        Number(r.round_no)||1,
        (r.player_ids||[]).map(id=>memberMap[id]).filter(Boolean)
      ]))
      :{};
    return <div className="historySessionSegment" key={s.id}>
      <div className="historySessionHead"><b>{s.session_date} · {String(s.start_time||"").slice(0,5)}</b><div><span className={s.match_type==="friendly"?"gameType friendly":"gameType season"}>{s.match_type==="friendly"?"비정규":`Season ${seasons.find(x=>x.id===s.season_id)?.season_no||4}`}</span><span>{ms.length}경기</span></div></div>
      {ms.map((m,mi)=>{
        const a=[memberMap[m.team_a_member_1],memberMap[m.team_a_member_2]].filter(Boolean);
        const b=[memberMap[m.team_b_member_1],memberMap[m.team_b_member_2]].filter(Boolean);
        const roundNo=Number(m.round_no)||1;
        const nextRound=mi<ms.length-1?(Number(ms[mi+1].round_no)||1):null;
        const showSitout=s.match_type==="friendly"&&nextRound!==roundNo&&sitoutByRound[roundNo]?.length>0;
        return <React.Fragment key={m.id}><div className={`historyMatch v15history compactHistoryCard ${m.winner?`hasWinner winner${m.winner}`:""}`}>
          <div className="historyDesktopLayout">
            <div className="historyMatchMeta">
              <span className="courtLabel">Court {m.court_no}</span>
              <span className="historyFormatLabel">{m.match_format==="singles"?"단식":"복식"}{m.supplemental?" · 보조 경기":""}</span>
            </div>

            <div className="historyMatchTeamsRow">
              <div className={m.winner==="A"?"historyTeamCell winningTeam":"historyTeamCell"}>
                <div className="historyTeamTop">
                  <small>{m.match_format==="singles"?"PLAYER A":"TEAM A"}</small>
                  {m.winner==="A"&&<span className="historyWinBadge">승리</span>}
                </div>
                <div className="historyPlayerRows">
                  {a.length?a.map(x=><div className="historyPlayerRow" key={x.id}>
                    <button className="historyNameLink" onClick={()=>onOpenProfile(x.id)}>{x.name}</button>
                    {s.match_type==="season"&&<span className={seasonCreditFor(m,x.id)?"seasonCreditBadge credited":"seasonCreditBadge helper"}>{seasonCreditFor(m,x.id)?"시즌반영":"보조출전"}</span>}
                  </div>):<b>A</b>}
                </div>
              </div>

              <div className="historyScore">
                <b>{m.score_a!=null?`${m.score_a} : ${m.score_b}`:"-"}</b>
                <small>{m.winner?`Team ${m.winner} 승`:"결과 대기"}</small>
              </div>

              <div className={m.winner==="B"?"historyTeamCell winningTeam":"historyTeamCell"}>
                <div className="historyTeamTop">
                  <small>{m.match_format==="singles"?"PLAYER B":"TEAM B"}</small>
                  {m.winner==="B"&&<span className="historyWinBadge">승리</span>}
                </div>
                <div className="historyPlayerRows">
                  {b.length?b.map(x=><div className="historyPlayerRow" key={x.id}>
                    <button className="historyNameLink" onClick={()=>onOpenProfile(x.id)}>{x.name}</button>
                    {s.match_type==="season"&&<span className={seasonCreditFor(m,x.id)?"seasonCreditBadge credited":"seasonCreditBadge helper"}>{seasonCreditFor(m,x.id)?"시즌반영":"보조출전"}</span>}
                  </div>):<b>B</b>}
                </div>
              </div>
            </div>
          </div>

          <div className="historyMobileCompact">
            <div className="historyMobileMeta">
              <span>COURT {m.court_no}</span>
              <span>{m.match_format==="singles"?"단식":"복식"}{m.supplemental?" · 보조":""}</span>
            </div>

            <div className="historyMobileOneLine">
              <div className={m.winner==="A"?"mobileTeam mobileWinner":"mobileTeam"}>
                {m.winner==="A"&&<span className="mobileWinDot">승</span>}
                <div className={a.length===1?"mobileTeamNames single":"mobileTeamNames doubles"}>
                  {a.length?a.map((x,idx)=><React.Fragment key={x.id}>
                    <button className="historyNameLink mobileName" onClick={()=>onOpenProfile(x.id)}>{x.name}</button>
                    {idx<a.length-1&&<span>/</span>}
                  </React.Fragment>):"A"}
                </div>
              </div>

              <div className="mobileScoreBox">
                <b>{m.score_a!=null?`${m.score_a}:${m.score_b}`:"-"}</b>
              </div>

              <div className={m.winner==="B"?"mobileTeam mobileWinner":"mobileTeam"}>
                {m.winner==="B"&&<span className="mobileWinDot">승</span>}
                <div className={b.length===1?"mobileTeamNames single":"mobileTeamNames doubles"}>
                  {b.length?b.map((x,idx)=><React.Fragment key={x.id}>
                    <button className="historyNameLink mobileName" onClick={()=>onOpenProfile(x.id)}>{x.name}</button>
                    {idx<b.length-1&&<span>/</span>}
                  </React.Fragment>):"B"}
                </div>
              </div>
            </div>

            {s.match_type==="season"&&<div className="mobileSeasonCredits">
              <div>{a.map(x=><span key={x.id} className={seasonCreditFor(m,x.id)?"seasonCreditBadge credited":"seasonCreditBadge helper"}>{seasonCreditFor(m,x.id)?"시즌반영":"보조출전"}</span>)}</div>
              <div>{b.map(x=><span key={x.id} className={seasonCreditFor(m,x.id)?"seasonCreditBadge credited":"seasonCreditBadge helper"}>{seasonCreditFor(m,x.id)?"시즌반영":"보조출전"}</span>)}</div>
            </div>}
          </div>

          {isAdmin
            ?<div className="recordActions historyRecordActions">
              <button className="editBtn" onClick={()=>onEdit(m)}>수정</button>
              <button className="deleteRecord" onClick={()=>onDelete(m)}>삭제</button>
            </div>
            :<span className={m.winner?"winnerTag":"pendingTag"}>{m.winner?`Team ${m.winner} 승`:"대기"}</span>}
        </div>
        {showSitout&&<div className="historySitoutRow"><b>Round {roundNo} 대기</b><div>{sitoutByRound[roundNo].map((p,idx)=><React.Fragment key={p.id}><button className="historyNameLink" onClick={()=>onOpenProfile(p.id)}>{p.name}</button>{idx<sitoutByRound[roundNo].length-1&&<span> · </span>}</React.Fragment>)}</div></div>}
        </React.Fragment>
      })}
    </div>
    })}
  </div>)}</div>;
}
function MemberProfile({member,matches,sessions,memberMap,events,seasons,onOpenProfile}){
  const[matchFilter,setMatchFilter]=useState("all");
  if(!member)return <section className="surface padded"><div className="emptyState">회원 정보를 찾을 수 없습니다.</div></section>;
  const memberMatches=matches.filter(m=>[m.team_a_member_1,m.team_a_member_2,m.team_b_member_1,m.team_b_member_2].includes(member.id));
  const filteredMemberMatches=memberMatches.filter(m=>{
    if(matchFilter==="all")return true;
    return sessions[m.session_id]?.match_type===matchFilter;
  });
  const matchById=Object.fromEntries(matches.map(m=>[m.id,m]));
  function eventDateKey(e){
    if(e.match_id){
      const match=matchById[e.match_id];
      const s=match?sessions[match.session_id]:null;
      if(s?.session_date){
        return `${s.session_date}T${String(s.start_time||"00:00")}`;
      }
    }
    return e.created_at||"";
  }
  function compareOtrEvents(a,b){
    const ak=eventDateKey(a),bk=eventDateKey(b);
    if(ak!==bk)return ak.localeCompare(bk);
    const ac=String(a.created_at||""),bc=String(b.created_at||"");
    if(ac!==bc)return ac.localeCompare(bc);
    return String(a.id||"").localeCompare(String(b.id||""));
  }
  const graphStartDate="2026-08-16";
  const memberEvents=events
    .filter(e=>{
      if(e.member_id!==member.id)return false;

      // 그래프만 2026-08-16 이후 기록을 표시.
      // 경기 전적/승패/시즌 기록/OTR 현재값에는 영향을 주지 않음.
      const graphDate=eventDateKey(e).slice(0,10);
      if(!graphDate||graphDate<graphStartDate)return false;

      // 관리자 수동 OTR 조정도 시작일 이후 기록만 그래프에 표시.
      if(e.event_type==="manual")return true;

      // 경기 OTR 변화는 실제 결과가 확정된 경기만 표시.
      if(e.event_type==="match"){
        const match=e.match_id?matchById[e.match_id]:null;
        return !!(
          match &&
          match.winner &&
          match.score_a!==null &&
          match.score_a!==undefined &&
          match.score_b!==null &&
          match.score_b!==undefined
        );
      }

      return false;
    })
    .sort(compareOtrEvents);

  const completedMemberMatches=memberMatches.filter(m=>m.winner);

  const partnerStats={};
  const opponentStats={};

  for(const m of completedMemberMatches){
    const isA=[m.team_a_member_1,m.team_a_member_2].includes(member.id);
    const won=isA?m.winner==="A":m.winner==="B";

    if(m.match_format!=="singles"){
      const partnerId=isA
        ?(m.team_a_member_1===member.id?m.team_a_member_2:m.team_a_member_1)
        :(m.team_b_member_1===member.id?m.team_b_member_2:m.team_b_member_1);

      if(partnerId&&memberMap[partnerId]){
        if(!partnerStats[partnerId])partnerStats[partnerId]={member:memberMap[partnerId],wins:0,games:0};
        partnerStats[partnerId].games++;
        if(won)partnerStats[partnerId].wins++;
      }
    }

    const oppIds=(isA
      ?[m.team_b_member_1,m.team_b_member_2]
      :[m.team_a_member_1,m.team_a_member_2]
    ).filter(Boolean);

    for(const id of oppIds){
      if(!memberMap[id])continue;
      if(!opponentStats[id])opponentStats[id]={member:memberMap[id],wins:0,losses:0,games:0};
      opponentStats[id].games++;
      if(won)opponentStats[id].wins++;
      else opponentStats[id].losses++;
    }
  }

  const bestDuo=Object.values(partnerStats)
    .sort((a,b)=>b.wins-a.wins||b.games-a.games||a.member.name.localeCompare(b.member.name))[0]||null;
  const dominantOpponent=Object.values(opponentStats)
    .sort((a,b)=>b.wins-a.wins||b.games-a.games||a.member.name.localeCompare(b.member.name))[0]||null;
  const toughOpponent=Object.values(opponentStats)
    .sort((a,b)=>b.losses-a.losses||b.games-a.games||a.member.name.localeCompare(b.member.name))[0]||null;

  const n=member.wins+member.losses;
  return <>
    <div className="profileTop">
      <section className="surface padded profileSummary">
        <span className="bigAvatar">{member.name[0]}</span><div><h2>{member.name}</h2><p>{(member.member_type||"member")==="guest"?"게스트":"회원"} · {member.gender==="M"?"남성":"여성"} · {member.active===false?"비활동":"활동중"}</p></div>
        <div className="profileOtr"><small>현재 OTR</small><b>{member.rating.toLocaleString()}</b></div>
      </section>
      <div className="profileMetrics"><div><small>경기</small><b>{n}</b></div><div><small>승</small><b>{member.wins}</b></div><div><small>패</small><b>{member.losses}</b></div><div><small>승률</small><b>{n?Math.round(member.wins/n*100):0}%</b></div></div>
    </div>

    <section className="surface padded profileRelationshipSection">
      <div className="sectionHead">
        <div>
          <h2>플레이 관계</h2>
          <small>완료된 전체 경기 기준</small>
        </div>
      </div>
      <div className="profileRelationshipGrid">
        <div className="profileRelationshipCard duo">
          <small>베스트 듀오</small>
          {bestDuo
            ?<>
              <button className="profileRelationshipName" onClick={()=>onOpenProfile(bestDuo.member.id)}>{bestDuo.member.name}</button>
              <span>함께 <b>{bestDuo.wins}승</b> · 복식 {bestDuo.games}경기</span>
            </>
            :<><strong>-</strong><span>완료된 복식 기록 없음</span></>}
        </div>
        <div className="profileRelationshipCard edge">
          <small>우세 상대</small>
          {dominantOpponent
            ?<>
              <button className="profileRelationshipName" onClick={()=>onOpenProfile(dominantOpponent.member.id)}>{dominantOpponent.member.name}</button>
              <span>상대전 <b>{dominantOpponent.wins}승</b> · {dominantOpponent.games}경기</span>
            </>
            :<><strong>-</strong><span>완료된 상대 기록 없음</span></>}
        </div>
        <div className="profileRelationshipCard tough">
          <small>고전 상대</small>
          {toughOpponent
            ?<>
              <button className="profileRelationshipName" onClick={()=>onOpenProfile(toughOpponent.member.id)}>{toughOpponent.member.name}</button>
              <span>상대전 <b>{toughOpponent.losses}패</b> · {toughOpponent.games}경기</span>
            </>
            :<><strong>-</strong><span>완료된 상대 기록 없음</span></>}
        </div>
      </div>
    </section>

    <section className="surface padded">
      <div className="sectionHead"><h2>OTR 변화 그래프</h2><span>2026-08-16 이후 · 실제 OTR 증감 기준</span></div>
      <OtrChart
        events={memberEvents.map(e=>{
          const match=e.match_id?matchById[e.match_id]:null;
          let result="";
          if(match?.winner){
            const isA=[match.team_a_member_1,match.team_a_member_2].includes(member.id);
            const won=isA?match.winner==="A":match.winner==="B";
            result=won?"W":"L";
          }
          return{
            ...e,
            result,
            display_date:e.event_type==="match"&&e.match_id&&matchById[e.match_id]?.winner&&sessions[matchById[e.match_id].session_id]?.session_date
              ?sessions[matchById[e.match_id].session_id].session_date
              :(e.created_at?String(e.created_at).slice(0,10):"")
          };
        })}
        current={member.rating}
      />
    </section>

    <section className="surface padded">
      <div className="sectionHead"><h2>시즌별 성적</h2></div>
      <div className="profileSeasonGrid">
        {[...seasons].filter(ss=>ss.season_no>=4).sort((a,b)=>Number(b.season_no)-Number(a.season_no)).map(ss=>{
          const sms=memberMatches.filter(m=>{
            if(!(sessions[m.session_id]?.season_id===ss.id&&sessions[m.session_id]?.match_type==="season"&&m.winner))return false;
            if(m.team_a_member_1===member.id)return m.season_credit_a1!==false;
            if(m.team_a_member_2===member.id)return m.season_credit_a2!==false;
            if(m.team_b_member_1===member.id)return m.season_credit_b1!==false;
            if(m.team_b_member_2===member.id)return m.season_credit_b2!==false;
            return false;
          });
          let w=0;
          for(const m of sms){
            const isA=[m.team_a_member_1,m.team_a_member_2].includes(member.id);
            if(isA?m.winner==="A":m.winner==="B")w++;
          }
          const l=sms.length-w,wr=sms.length?w/sms.length:0,pts=Math.round(w*(1+wr)*100)/10;
          return <div className="seasonStat" key={ss.id}><b>Season {ss.season_no}</b><strong>{w}승 {l}패</strong><span>승률 {Math.round(wr*100)}% · {ss.season_no>=5?`${pts} pt`:"기록 보존"}</span></div>
        })}
      </div>
    </section>

    <section className="surface padded">
      <div className="sectionHead profileHistoryHead">
        <div>
          <h2>최근 경기 전적</h2>
          <small>{matchFilter==="all"?`전체 ${memberMatches.length}경기`:matchFilter==="friendly"?`비정규 ${filteredMemberMatches.length}경기`:`시즌 ${filteredMemberMatches.length}경기`}</small>
        </div>
        <div className="historyFilters profileHistoryFilters">
          <button className={matchFilter==="all"?"historyFilterBtn active":"historyFilterBtn"} onClick={()=>setMatchFilter("all")}>전체</button>
          <button className={matchFilter==="friendly"?"historyFilterBtn active":"historyFilterBtn"} onClick={()=>setMatchFilter("friendly")}>비정규</button>
          <button className={matchFilter==="season"?"historyFilterBtn active":"historyFilterBtn"} onClick={()=>setMatchFilter("season")}>시즌</button>
        </div>
      </div>
      <div className="profileMatchList">{filteredMemberMatches.slice(0,12).map(m=>{
        const isA=[m.team_a_member_1,m.team_a_member_2].includes(member.id);
        const partnerId=isA?(m.team_a_member_1===member.id?m.team_a_member_2:m.team_a_member_1):(m.team_b_member_1===member.id?m.team_b_member_2:m.team_b_member_1);
        const oppIds=isA?[m.team_b_member_1,m.team_b_member_2]:[m.team_a_member_1,m.team_a_member_2];
        const event=events.find(e=>e.match_id===m.id&&e.member_id===member.id);
        const won=m.winner&&(isA?m.winner==="A":m.winner==="B");
        const s=sessions[m.session_id];
        return <div className="profileMatch" key={m.id}>
          <span className={won?"wl win":"wl loss"}>{m.winner?(won?"W":"L"):"-"}</span>
          <div>
            <span className={s?.match_type==="season"?"profileMatchType season":"profileMatchType friendly"}>{s?.match_type==="season"?"시즌경기":"비정규"}</span>
            <b>
              {m.match_format==="singles"
                ?"단식"
                :memberMap[partnerId]
                  ?<><button className="profileNameLink" onClick={()=>onOpenProfile(memberMap[partnerId].id)}>{memberMap[partnerId].name}</button><span>와 함께</span></>
                  :"-"}
            </b>
            <small className="profileOpponents">
              <span>vs </span>
              {oppIds.filter(Boolean).map((id,idx)=>{
                const opp=memberMap[id];
                return <React.Fragment key={id}>
                  {opp?<button className="profileNameLink small" onClick={()=>onOpenProfile(opp.id)}>{opp.name}</button>:"-"}
                  {idx<oppIds.filter(Boolean).length-1&&<span> + </span>}
                </React.Fragment>
              })}
              <span> · {s?.session_date||""}</span>
            </small>
          </div>
          <div className="profileScore"><b>{m.score_a!=null?`${m.score_a}-${m.score_b}`:"-"}</b><span className={(event?.delta||0)>=0?"delta plus":"delta minus"}>{event?`${event.delta>=0?"+":""}${event.delta} OTR`:"-"}</span></div>
        </div>
      })}{!filteredMemberMatches.length&&<div className="emptyState">{matchFilter==="all"?"아직 경기 기록이 없습니다.":matchFilter==="friendly"?"비정규 경기 기록이 없습니다.":"시즌 경기 기록이 없습니다."}</div>}</div>
    </section>
  </>;
}
function OtrChart({events,current}){
  const points=events.slice(-20);

  if(!points.length){
    return <div className="chartEmpty"><b>{current} OTR</b><span>아직 OTR 변화 기록이 없습니다.</span></div>;
  }

  /*
   * Important:
   * The old graph trusted every stored rating_before/rating_after value.
   * If an older result had been edited/reversed, those historical snapshots
   * could become non-contiguous even though each event's delta was correct.
   *
   * Rebuild the line from the actual event deltas and anchor the LAST point
   * to the member's current OTR. This guarantees:
   * - +delta always moves upward
   * - -delta always moves downward
   * - the final point is exactly the current OTR shown on the profile
   */
  const deltas=points.map(e=>Number(e.delta||0));
  const reconstructed=[0];
  for(const d of deltas)reconstructed.push(reconstructed[reconstructed.length-1]+d);

  const offset=Number(current)-reconstructed[reconstructed.length-1];
  const values=reconstructed.map(v=>v+offset);

  const min=Math.min(...values),max=Math.max(...values);
  const spread=Math.max(20,max-min);
  const w=760,h=220,pad=30;

  const coords=values.map((v,i)=>{
    const x=pad+(i/(Math.max(1,values.length-1)))*(w-pad*2);
    const low=min-(spread*.1);
    const high=min+spread*1.2;
    const y=h-pad-((v-low)/(high-low))*(h-pad*2);
    return[x,Math.max(pad,Math.min(h-pad,y))];
  });

  const poly=coords.map(p=>p.join(",")).join(" ");

  return <div className="chartWrap">
    <svg viewBox={`0 0 ${w} ${h}`} role="img" aria-label={`현재 OTR ${current}. 최근 OTR 변화`}>
      <line x1={pad} y1={h-pad} x2={w-pad} y2={h-pad} className="axis"/>
      <polyline points={poly} fill="none" className="otrLine"/>
      {coords.map((p,i)=><circle key={i} cx={p[0]} cy={p[1]} r="4" className="otrDot"/>)}
      <text x={pad} y="20" className="chartLabel">최고 {max}</text>
      <text x={w-pad} y="20" textAnchor="end" className="chartLabel">현재 {current}</text>
    </svg>

    <div className="eventChips">
      {points.slice(-8).map(e=><span key={e.id} className={Number(e.delta)>=0?"plus":"minus"}>
        <small>{e.display_date?e.display_date.slice(5).replace("-","/"):""}</small>
        {e.result&&<b className={`resultMini ${e.result==="W"?"win":"loss"}`}>{e.result}</b>}
        {Number(e.delta)>=0?"+":""}{Number(e.delta)} OTR
      </span>)}
    </div>
  </div>;
}

function Modal({children,onClose}){return <div className="modalBackdrop" onMouseDown={e=>{if(e.target===e.currentTarget)onClose()}}><div className="loginModal">{children}</div></div>}

createRoot(document.getElementById("root")).render(<App/>);

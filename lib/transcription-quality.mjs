const regionWords=(words,region)=>(words||[]).filter(word=>word.end>region.start&&word.start<region.end);

export function speechCoverage(words,region){
  const inside=regionWords(words,region);
  if(!inside.length)return{words:inside,leadingGap:region.end-region.start,trailingGap:region.end-region.start,uncoveredEdges:(region.end-region.start)*2};
  const start=Math.max(region.start,Math.min(...inside.map(word=>word.start))),end=Math.min(region.end,Math.max(...inside.map(word=>word.end)));
  const leadingGap=Math.max(0,start-region.start),trailingGap=Math.max(0,region.end-end);
  return{words:inside,start,end,leadingGap,trailingGap,uncoveredEdges:leadingGap+trailingGap};
}

export function findWeakSpeechRegions(words,regions,{minimumDuration=.8,maximumEdgeGap=.55,maximumDensityDuration=5,minimumWordsPerSecond=3}={}){
  return(regions||[]).filter(region=>{
    const duration=region.end-region.start;
    if(!Number.isFinite(region.start)||!Number.isFinite(region.end)||duration<minimumDuration)return false;
    const coverage=speechCoverage(words,region),lowDensity=duration<=maximumDensityDuration&&coverage.words.length/duration<minimumWordsPerSecond,flagged=coverage.words.some(word=>word.needsReview||word.reviewStatus==='pending');
    return!coverage.words.length||coverage.leadingGap>maximumEdgeGap||coverage.trailingGap>maximumEdgeGap||lowDensity||flagged;
  });
}

const averageScore=words=>{
  const values=(words||[]).map(word=>word.reviewScore??word.rawConfidence??word.confidence).filter(Number.isFinite);
  return values.length?values.reduce((sum,value)=>sum+value,0)/values.length:null;
};

const hypothesisText=(words,region)=>(words||[]).filter(word=>word.end>region.start&&word.start<region.end).map(word=>word.text).join('').normalize('NFKC').toLocaleLowerCase('th').replace(/[^\p{L}\p{N}]+/gu,'');
const hypothesisLength=(words,region)=>{
  const text=hypothesisText(words,region);
  try{return[...new Intl.Segmenter('th',{granularity:'grapheme'}).segment(text)].length}
  catch{return[...text].length}
};

export function retryCandidateWins(existing,candidate,region,{minimumEdgeGain=.3,minimumTextGain=3,minimumSmallTextGain=2,minimumSmallEdgeGain=.12,maximumScoreDrop=.18}={}){
  if(!(candidate||[]).length)return false;
  const before=speechCoverage(existing,region),after=speechCoverage(candidate,region),edgeGain=before.uncoveredEdges-after.uncoveredEdges;
  const beforeText=hypothesisText(existing,region),afterText=hypothesisText(candidate,region),sameText=Boolean(beforeText&&beforeText===afterText);
  const textGain=hypothesisLength(candidate,region)-hypothesisLength(existing,region);
  // Thai tokenizers can split one uncertain word into several fragments. Counting
  // fragments as new words lets a weaker retry replace a cleaner hypothesis.
  // Better edge timing alone is safe only when both passes agree on the text.
  // When text differs, require actual added speech content before replacing.
  const improves=before.words.length===0||(sameText&&edgeGain>=minimumEdgeGain)||textGain>=minimumTextGain||(textGain>=minimumSmallTextGain&&edgeGain>=minimumSmallEdgeGain)||(textGain>=1&&edgeGain>=minimumEdgeGain);
  if(!improves)return false;
  const beforeScore=averageScore(before.words),afterScore=averageScore(after.words);
  return beforeScore==null||afterScore==null||afterScore>=beforeScore-maximumScoreDrop;
}

const wordKey=word=>String(word?.text||'').normalize('NFKC').toLocaleLowerCase('th').replace(/[^\p{L}\p{N}]+/gu,'');

function matchingPairs(before,after){
  const rows=before.length+1,cols=after.length+1,dp=Array.from({length:rows},()=>new Uint16Array(cols));
  for(let i=before.length-1;i>=0;i--)for(let j=after.length-1;j>=0;j--)dp[i][j]=wordKey(before[i])===wordKey(after[j])?dp[i+1][j+1]+1:Math.max(dp[i+1][j],dp[i][j+1]);
  const pairs=[];let i=0,j=0;
  while(i<before.length&&j<after.length){if(wordKey(before[i])===wordKey(after[j])){pairs.push([i,j]);i++;j++}else if(dp[i+1][j]>=dp[i][j+1])i++;else j++}
  return pairs;
}

export function hypothesesDisagree(existing,candidate,region){
  const before=hypothesisText(existing,region),after=hypothesisText(candidate,region);
  return Boolean(before&&after&&before!==after);
}

export function markSpeechRegionForReview(words,candidate,region,reason='pass-disagreement'){
  const inside=(words||[]).filter(word=>word.end>region.start&&word.start<region.end),matched=new Set(matchingPairs(inside,candidate||[]).map(([index])=>inside[index].id));
  return(words||[]).map(word=>word.end>region.start&&word.start<region.end&&!matched.has(word.id)&&word.reviewStatus!=='edited'?{...word,needsReview:true,reviewStatus:'pending',reviewReason:reason}:word);
}

export function replaceSpeechRegionWords(words,candidate,region){
  const existing=(words||[]).filter(word=>word.end>region.start&&word.start<region.end),pairs=matchingPairs(existing,candidate||[]),matched=new Map(pairs.map(([before,after])=>[after,existing[before]]));
  const kept=(words||[]).filter(word=>word.end<=region.start||word.start>=region.end);
  const retried=(candidate||[]).map((word,index)=>{
    const prior=matched.get(index);
    if(prior)return{...word,needsReview:prior.needsReview,reviewStatus:prior.reviewStatus,reviewReason:prior.reviewReason};
    return{...word,needsReview:true,reviewStatus:'pending',reviewReason:'coverage-retry'};
  });
  return[...kept,...retried].sort((a,b)=>a.start-b.start);
}

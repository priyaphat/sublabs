const languageLocale=language=>({thai:'th',english:'en'}[String(language).toLowerCase()]||language||'th');
const isThaiLanguage=language=>String(languageLocale(language)).toLowerCase().startsWith('th');
const thaiAutomaticRisk=text=>/^[\u0E30-\u0E3A\u0E47-\u0E4E]/u.test(String(text||''))||/^ๆ+$/u.test(String(text||''));
const attachesToPrevious=text=>/^[ๆฯ,.!?…]/u.test(String(text||''));

export function thaiWords(text, language = 'th') {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  if (!clean) return [];
  const locale = language === 'auto' ? 'th' : languageLocale(language);
  try {
    const parts = [...new Intl.Segmenter(locale, { granularity: 'word' }).segment(clean)];
    const words = [];
    for (const part of parts) {
      const value = part.segment.trim();
      if (!value) continue;
      if (!part.isWordLike && words.length) words.at(-1).text += value;
      else if (part.isWordLike) words.push({ text: value, spaceBefore: part.index > 0 && /\s/.test(clean[part.index - 1]) });
    }
    return words;
  } catch {
    return clean.split(/\s+/).map((text, index) => ({ text, spaceBefore: index > 0 }));
  }
}

function tokenText(token) {
  return String(token.text ?? token.token ?? '');
}

export function tokensToWords(tokens, language = 'th') {
  const cleanTokens = (tokens || []).filter(t => tokenText(t).length && Number.isFinite(t.start) && Number.isFinite(t.end));
  if (!cleanTokens.length) return [];
  const names={thai:'th',english:'en'},locale=names[String(language).toLowerCase()]||language||'th';
  let fullText='',previousTokenEnd=null;const spans=[],breakPositions=new Set(),isThai=String(locale).toLowerCase().startsWith('th');
  for(const token of cleanTokens){
    const text=tokenText(token);
    if(token.segmentBreak&&fullText){const gap=Number(token.start)-Number(previousTokenEnd);if(!isThai||!Number.isFinite(gap)||gap>=.18)breakPositions.add(fullText.length);if(!isThai&&!/\s$/.test(fullText)&&!/^\s/.test(text))fullText+=' '}
    const from=fullText.length;fullText+=text;spans.push({token,from,to:fullText.length});
    previousTokenEnd=token.end;
  }
  if(!fullText.trim())return[];
  let rawSegments;
  try { rawSegments=[...new Intl.Segmenter(locale,{granularity:'word'}).segment(fullText)]; }
  catch { rawSegments=[...new Intl.Segmenter('th',{granularity:'word'}).segment(fullText)]; }
  const segments=[];
  for(const item of rawSegments){
    if(item.isWordLike){const spaceBefore=!isThai&&item.index>0&&/\s/.test(fullText[item.index-1]);segments.push({text:item.segment.trim(),from:item.index,to:item.index+item.segment.length,spaceBefore,phraseBreak:isThai&&breakPositions.has(item.index)});}
    else if(item.segment.trim()&&segments.length){segments.at(-1).text+=item.segment.trim();segments.at(-1).to=item.index+item.segment.length;}
  }
  const output = [];
  for (const segment of segments) {
    const overlaps=spans.filter(span=>span.to>segment.from&&span.from<segment.to),start=overlaps[0]?.token.start,end=overlaps.at(-1)?.token.end;
    let confidenceTotal=0,confidenceCount=0,logprobTotal=0,logprobCount=0,noSpeechTotal=0;
    for(const span of overlaps){
      const raw=span.token.rawConfidence??span.token.confidence;
      if(Number.isFinite(raw)){confidenceTotal+=raw;confidenceCount++}
      if(Number.isFinite(span.token.segmentLogprob)){logprobTotal+=span.token.segmentLogprob;logprobCount++}
      if(Number.isFinite(span.token.noSpeechProbability))noSpeechTotal+=span.token.noSpeechProbability;
    }
    const rawConfidence=confidenceCount?confidenceTotal/confidenceCount:null;
    const logprobQuality=logprobCount?Math.max(0,Math.min(1,Math.exp(logprobTotal/logprobCount))):rawConfidence;
    const noSpeech=overlaps.length?noSpeechTotal/overlaps.length:0;
    const automaticRisk=isThai&&thaiAutomaticRisk(segment.text),reviewScore=rawConfidence==null?null:Math.max(0,Math.min(1,rawConfidence*.78+(logprobQuality??rawConfidence)*.22-noSpeech*.35-(automaticRisk ? .28 : 0))),needsReview=automaticRisk||reviewScore==null||reviewScore<.65;
    if (start != null) output.push({
      id: crypto.randomUUID(), text: segment.text, start, end: Math.max(start + .02, end ?? start + .2),
      rawConfidence, confidence: rawConfidence, reviewScore, needsReview,
      reviewStatus:needsReview?'pending':'approved',timingSource:'whisper',
      spaceBefore: segment.spaceBefore, phraseBreak: segment.phraseBreak,
    });
  }
  let previousEnd = 0;
  return output.map((word,index,array) => {
    const start = Math.max(word.start, previousEnd);
    const end = Math.max(start + .04, word.end);
    previousEnd = end;
    return { ...word, start, end };
  });
}

export function normalizeGlossary(glossary){
  const values=[];
  for(const item of Array.isArray(glossary)?glossary:String(glossary||'').split(/[,\n]/)){
    if(typeof item==='string')values.push(item);
    else if(item&&typeof item==='object')values.push(item.term,...(Array.isArray(item.aliases)?item.aliases:[]));
  }
  return [...new Set(values.map(value=>String(value||'').replace(/\s+/g,' ').trim()).filter(Boolean))].slice(0,200);
}

export function applyGlossary(words,glossary){
  const terms=normalizeGlossary(glossary).map(term=>({term,key:term.replace(/\s+/g,'').toLocaleLowerCase('th')})).sort((a,b)=>b.key.length-a.key.length);
  if(!terms.length)return words||[];
  const source=words||[],output=[];
  for(let index=0;index<source.length;){
    let match=null;
    for(let end=Math.min(source.length,index+10);end>index;end--){
      const key=source.slice(index,end).map(word=>word.text).join('').replace(/\s+/g,'').toLocaleLowerCase('th');
      const term=terms.find(candidate=>candidate.key===key);
      if(term){match={term,end};break}
    }
    if(!match){output.push(source[index++]);continue}
    const members=source.slice(index,match.end),scores=members.map(x=>x.reviewScore).filter(Number.isFinite),raw=members.map(x=>x.rawConfidence??x.confidence).filter(Number.isFinite);
    output.push({...members[0],id:crypto.randomUUID(),text:match.term.term,end:members.at(-1).end,
      rawConfidence:raw.length?raw.reduce((a,b)=>a+b,0)/raw.length:null,
      reviewScore:scores.length?scores.reduce((a,b)=>a+b,0)/scores.length:null,
      needsReview:members.some(x=>x.needsReview),phraseBreak:members[0].phraseBreak});
    index=match.end;
  }
  return output;
}

export function alignWordsToSpeechRegions(words,regions,{minimumDuration=.04,minimumOverlap=.45}={}){
  const speech=(regions||[]).filter(x=>Number.isFinite(x.start)&&Number.isFinite(x.end)&&x.end>x.start).sort((a,b)=>a.start-b.start);
  if(!speech.length)return words||[];
  const output=[];
  for(const original of words||[]){
    let best=null,bestOverlap=0;
    for(const region of speech){
      const overlap=Math.max(0,Math.min(original.end,region.end)-Math.max(original.start,region.start));
      if(overlap>bestOverlap){best=region;bestOverlap=overlap}
    }
    const originalDuration=original.end-original.start;
    if(!best||bestOverlap<=0||bestOverlap/Math.max(.001,originalDuration)<minimumOverlap)continue;
    let start=Math.max(original.start,best.start,output.at(-1)?.end??0),end=Math.min(original.end,best.end);
    if(end-start<minimumDuration){end=Math.min(best.end,start+minimumDuration)}
    if(end-start<minimumDuration)continue;
    const wasClamped=Math.abs(start-original.start)>.02||Math.abs(end-original.end)>.02,short=end-start<.09;
    const needsReview=Boolean(original.needsReview||wasClamped||short),manual=original.timingSource==='manual'||original.reviewStatus==='edited';
    output.push({...original,start,end,speechRegionId:best.id,needsReview,reviewStatus:needsReview&&!manual?'pending':original.reviewStatus,reviewScore:Number.isFinite(original.reviewScore)?Math.max(0,original.reviewScore-(wasClamped ? .12 : 0)-(short ? .08 : 0)):original.reviewScore});
  }
  return output;
}

export function wordsText(words) {
  return (words || []).map((word, index) => `${index ? (word.lineBreakBefore?'\n':word.spaceBefore !== false ? ' ' : '') : ''}${word.text}`).join('');
}

export function groupWords(words, groupSize = 5, pauseThreshold = .25) {
  const groups = [];
  let group = [];
  const flush = () => {
    if (!group.length) return;
    groups.push({ id: crypto.randomUUID(), start: group[0].start, end: group.at(-1).end, text: wordsText(group), words: group });
    group = [];
  };
  const source=words||[],maximum=groupSize===1?1:Math.max(groupSize,groupSize*2);
  for (let index=0;index<source.length;index++) {
    const word=source[index],next=source[index+1];
    const previous = group.at(-1);
    if (previous && (word.phraseBreak || word.start - previous.end > pauseThreshold || /[.!?…]|[。！？]$/.test(previous.text))) flush();
    group.push(word);
    const naturalBreak=!next||next.phraseBreak||next.start-word.end>pauseThreshold||/[.!?…]|[。！？]$/.test(word.text);
    if(naturalBreak||group.length>=maximum)flush();
  }
  flush();
  return groups;
}

export function capWordDurations(words) {
  const graphemeCount = text => {
    try { return [...new Intl.Segmenter('th', { granularity: 'grapheme' }).segment(String(text || ''))].length; }
    catch { return [...String(text || '')].length; }
  };
  return (words || []).map(word => {
    const maximum = Math.min(.72, Math.max(.42, .32 + graphemeCount(word.text) * .06));
    const duration = word.end - word.start;
    if (duration <= maximum) return word;
    return { ...word, end: word.start + maximum };
  });
}

export function snapWordsToSpeech(words, silences, minimumDuration = .015) {
  const quiet = (silences || [])
    .filter(x => Number.isFinite(x.start) && Number.isFinite(x.end) && x.end > x.start)
    .sort((a, b) => a.start - b.start);
  const output = [];
  for (const original of words || []) {
    let start = Number(original.start), end = Number(original.end), hidden = false;
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
    const originalDuration = end - start;
    for (const silence of quiet) {
      if (silence.end <= start) continue;
      if (silence.start >= end) break;
      if (start >= silence.start && end <= silence.end) {
        hidden = true;
        break;
      }
      if (start >= silence.start && start < silence.end && end > silence.end) start = silence.end;
      else if (start < silence.start && end > silence.start && end <= silence.end) end = silence.start;
      else if (start < silence.start && end > silence.end) {
        const speechBefore = silence.start - start, speechAfter = end - silence.end;
        if (speechBefore >= speechAfter) {
          end = silence.start;
          break;
        }
        start = silence.end;
      }
    }
    const duration = end - start;
    if (!hidden && duration >= minimumDuration && !(originalDuration > .25 && duration < .08)) output.push({ ...original, start, end });
  }
  return output;
}

export function normalizeEditedCaption(caption, language = 'th') {
  const pieces = thaiWords(caption.text, language);
  if (!pieces.length) return { ...caption, words: [] };
  const duration = Math.max(.04, caption.end - caption.start);
  const weights = pieces.map(x => Math.max(1, [...x.text].length));
  const total = weights.reduce((a, b) => a + b, 0);
  let cursor = caption.start;
  const words = pieces.map((piece, index) => {
    const end = index === pieces.length - 1 ? caption.end : cursor + duration * weights[index] / total;
    const word = { id: crypto.randomUUID(), text: piece.text, start: cursor, end, confidence: null, rawConfidence:null, reviewScore:null, needsReview:false, reviewStatus:'edited', timingSource:'manual', spaceBefore: piece.spaceBefore };
    cursor = end; return word;
  });
  return { ...caption, text: wordsText(words), words };
}

export function reconcileEditedCaption(caption,newText,language='th'){
  const pieces=thaiWords(newText,language),old=caption.words||[];
  if(!pieces.length)return{...caption,text:'',words:[]};
  if(!old.length)return normalizeEditedCaption({...caption,text:newText},language);
  const rows=old.length+1,cols=pieces.length+1,dp=Array.from({length:rows},()=>new Uint16Array(cols));
  for(let i=old.length-1;i>=0;i--)for(let j=pieces.length-1;j>=0;j--)dp[i][j]=old[i].text===pieces[j].text?dp[i+1][j+1]+1:Math.max(dp[i+1][j],dp[i][j+1]);
  const matches=[];let i=0,j=0;
  while(i<old.length&&j<pieces.length){if(old[i].text===pieces[j].text){matches.push({old:i,next:j});i++;j++}else if(dp[i+1][j]>=dp[i][j+1])i++;else j++}
  const mapped=new Map(matches.map(match=>[match.next,match.old])),words=new Array(pieces.length);
  for(const match of matches)words[match.next]={...old[match.old],text:pieces[match.next].text,spaceBefore:pieces[match.next].spaceBefore};
  const anchors=[{next:-1,old:-1},...matches,{next:pieces.length,old:old.length}];
  for(let a=0;a<anchors.length-1;a++){
    const left=anchors[a],right=anchors[a+1],newFrom=left.next+1,newTo=right.next,oldFrom=left.old+1,oldTo=right.old;
    const count=newTo-newFrom,oldCount=oldTo-oldFrom;if(!count)continue;
    if(count===oldCount&&oldCount>0){
      for(let offset=0;offset<count;offset++){const previous=old[oldFrom+offset];words[newFrom+offset]={...previous,id:crypto.randomUUID(),text:pieces[newFrom+offset].text,spaceBefore:pieces[newFrom+offset].spaceBefore,rawConfidence:null,confidence:null,reviewScore:null,needsReview:false,reviewStatus:'edited',timingSource:'manual'}}
      continue;
    }
    const start=left.next>=0?words[left.next].end:caption.start,end=right.next<pieces.length?words[right.next].start:caption.end;
    const available=Math.max(.04*count,end-start),weights=pieces.slice(newFrom,newTo).map(piece=>Math.max(1,[...piece.text].length)),total=weights.reduce((sum,value)=>sum+value,0);let cursor=start;
    for(let offset=0;offset<count;offset++){
      const wordEnd=offset===count-1?start+available:cursor+available*weights[offset]/total;
      words[newFrom+offset]={id:crypto.randomUUID(),text:pieces[newFrom+offset].text,spaceBefore:pieces[newFrom+offset].spaceBefore,start:cursor,end:Math.max(cursor+.04,wordEnd),rawConfidence:null,confidence:null,reviewScore:null,needsReview:false,reviewStatus:'edited',timingSource:'manual'};cursor=Math.max(cursor+.04,wordEnd);
    }
  }
  let previousEnd=caption.start;
  for(const word of words){word.start=Math.max(caption.start,word.start,previousEnd);word.end=Math.min(caption.end,Math.max(word.start+.04,word.end));previousEnd=word.end}
  return{...caption,text:wordsText(words),words};
}

export function validateCaptions(captions) {
  if (!Array.isArray(captions) || captions.length > 100000) throw new Error('รูปแบบคำบรรยายไม่ถูกต้อง');
  let previous = 0;
  return captions.map((caption, i) => {
    const start = Number(caption.start), end = Number(caption.end);
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start || start < previous - .01) throw new Error(`เวลา caption ${i + 1} ไม่ถูกต้อง`);
    const words=Array.isArray(caption.words)?caption.words.map((word,wordIndex)=>{
      const wordStart=Number(word.start),wordEnd=Number(word.end);
      if(!Number.isFinite(wordStart)||!Number.isFinite(wordEnd)||wordStart<start-.01||wordEnd>end+.01||wordEnd<=wordStart)throw new Error(`เวลาคำ ${wordIndex+1} ใน caption ${i+1} ไม่ถูกต้อง`);
      return{...word,id:String(word.id||crypto.randomUUID()),text:String(word.text||'').slice(0,300),start:wordStart,end:wordEnd,
        rawConfidence:Number.isFinite(word.rawConfidence)?word.rawConfidence:(Number.isFinite(word.confidence)?word.confidence:null),
        reviewScore:Number.isFinite(word.reviewScore)?word.reviewScore:null,needsReview:Boolean(word.needsReview),
        reviewStatus:['pending','approved','edited'].includes(word.reviewStatus)?word.reviewStatus:(word.needsReview?'pending':'approved'),
        timingSource:['whisper','estimated','manual'].includes(word.timingSource)?word.timingSource:'whisper',lineBreakBefore:Boolean(word.lineBreakBefore)};
    }):[];
    const text=String(caption.text||'').slice(0,1000);
    if(words.length&&wordsText(words)!==text)throw new Error(`ข้อความ caption ${i+1} ไม่ตรงกับคำรายคำ`);
    previous = end;
    return { ...caption,id:String(caption.id||crypto.randomUUID()),text,start,end,words };
  });
}

const graphemeCount=(text,language='th')=>{
  try{return[...new Intl.Segmenter(language==='auto'?'th':language,{granularity:'grapheme'}).segment(String(text||''))].length}
  catch{return[...String(text||'')].length}
};

function withAutomaticLineBreak(words,{maxCharsPerLine=32,language='th'}={}){
  const output=(words||[]).map(word=>({...word,lineBreakBefore:false}));
  const total=output.reduce((sum,word)=>sum+graphemeCount(word.text,language)+(word.spaceBefore?1:0),0);
  if(total<=maxCharsPerLine||output.length<2)return output;
  const target=total/2;let running=0,bestIndex=1,bestDistance=Infinity;
  for(let index=1;index<output.length;index++){
    running+=graphemeCount(output[index-1].text,language)+(output[index-1].spaceBefore?1:0);
    const distance=Math.abs(target-running);if(distance<bestDistance){bestDistance=distance;bestIndex=index}
  }
  output[bestIndex].lineBreakBefore=true;return output;
}

export function captionReadStats(caption,{cps=17,maxLines=2,maxCharsPerLine=32,language='th'}={}){
  const characters=graphemeCount(String(caption?.text||'').replace(/\s/g,''),language),duration=Math.max(.001,Number(caption?.end)-Number(caption?.start));
  const lines=String(caption?.text||'').split('\n').length,actualCps=characters/duration;
  return{characters,duration,cps:actualCps,lines,tooFast:actualCps>cps,overflow:lines>maxLines||characters>maxCharsPerLine*maxLines};
}

const unsafeWordBoundary=(previous,next,language)=>{
  if(!previous||!next||!isThaiLanguage(language))return false;
  if(attachesToPrevious(next.text)||thaiAutomaticRisk(next.text))return true;
  const gap=next.start-previous.end,duration=next.end-next.start;
  return gap<=.02&&duration<=.08&&graphemeCount(next.text,language)===1;
};

function balancedWordGroups(words,{maxWords,softPauseThreshold,maxDuration,maxLines,maxCharsPerLine,language}){
  if(!words.length)return[];
  const target=Math.max(1,Math.round(Number(maxWords)||5)),tolerance=target===1?0:Math.max(1,Math.round(target*.34)),preferredMaximum=target+tolerance,absoluteMaximum=preferredMaximum+2,n=words.length,dp=new Array(n+1).fill(null);
  dp[n]={cost:0,groups:[]};
  for(let start=n-1;start>=0;start--){
    let characters=0;
    for(let end=start+1;end<=Math.min(n,start+absoluteMaximum);end++){
      const word=words[end-1],size=end-start;
      characters+=graphemeCount(word.text,language)+(size>1&&word.spaceBefore?1:0);
      const duration=word.end-words[start].start,overLimit=duration>maxDuration||characters>maxCharsPerLine*maxLines;
      if(overLimit&&size>1)break;
      if(end<n&&unsafeWordBoundary(word,words[end],language))continue;
      if(!dp[end])continue;
      const deviation=(size-target)/Math.max(1,target);
      let cost=deviation*deviation*4;
      if(size>preferredMaximum)cost+=(size-preferredMaximum)*4;
      if(size===1&&n>1&&target>1)cost+=2.5;
      if(end<n){
        const gap=Math.max(0,words[end].start-word.end);
        cost-=Math.min(1.2,gap/Math.max(.01,softPauseThreshold)*.3);
        if(n-end===1&&target>1)cost+=1.5;
      }
      const total=cost+dp[end].cost,currentDistance=Math.abs(size-target),savedDistance=dp[start]?Math.abs(dp[start].groups[0].length-target):Infinity;
      if(!dp[start]||total<dp[start].cost-1e-6||Math.abs(total-dp[start].cost)<=1e-6&&currentDistance<savedDistance)dp[start]={cost:total,groups:[words.slice(start,end),...dp[end].groups]};
    }
  }
  return dp[0]?.groups||[words];
}

export function reflowWords(words,{maxWords=5,pauseThreshold=.25,softPauseThreshold=.08,cps=17,maxDuration=4,maxLines=2,maxCharsPerLine=32,language='th'}={}){
  const source=(words||[]).filter(word=>Number.isFinite(word.start)&&Number.isFinite(word.end)&&word.end>word.start).sort((a,b)=>a.start-b.start).map((word,index)=>attachesToPrevious(word.text)&&index?{...word,spaceBefore:false,phraseBreak:false}:{...word}),phrases=[];let phrase=[];
  const flushPhrase=()=>{if(phrase.length){phrases.push(phrase);phrase=[]}};
  for(const word of source){
    const previous=phrase.at(-1),gap=previous?word.start-previous.end:0,attached=previous&&attachesToPrevious(word.text),newSpeechRegion=previous&&word.speechRegionId&&previous.speechRegionId&&word.speechRegionId!==previous.speechRegionId,naturalBefore=previous&&!attached&&(newSpeechRegion||word.phraseBreak||gap>=pauseThreshold||/[.!?…。！？]$/.test(previous.text));
    if(naturalBefore)flushPhrase();
    phrase.push(word);
  }
  flushPhrase();
  return phrases.flatMap(wordsInPhrase=>balancedWordGroups(wordsInPhrase,{maxWords,softPauseThreshold,maxDuration,maxLines,maxCharsPerLine,language})).map(group=>{
    const lined=withAutomaticLineBreak(group,{maxCharsPerLine,language});
    return{id:crypto.randomUUID(),start:lined[0].start,end:lined.at(-1).end,text:wordsText(lined),words:lined};
  });
}

const subtitleTime=value=>{
  const match=String(value||'').trim().match(/^(?:(\d+):)?(\d{1,2}):(\d{2})[,.](\d{1,3})$/);
  if(!match)return null;return Number(match[1]||0)*3600+Number(match[2])*60+Number(match[3])+Number(match[4].padEnd(3,'0'))/1000;
};

export function parseSubtitle(text,{format='auto'}={}){
  const source=String(text||'').replace(/^\uFEFF/,'').replace(/\r\n?/g,'\n').trim();if(!source)return[];
  const blocks=source.replace(/^WEBVTT[^\n]*\n+/i,'').split(/\n{2,}/),cues=[];
  for(const block of blocks){
    const lines=block.split('\n').map(line=>line.trimEnd());if(!lines.length||/^NOTE(?:\s|$)/.test(lines[0]))continue;
    const timingIndex=lines.findIndex(line=>line.includes('-->'));if(timingIndex<0)continue;
    const timing=lines[timingIndex].match(/^\s*([^\s]+)\s*-->\s*([^\s]+)(?:\s+.*)?$/);if(!timing)throw new Error('รูปแบบเวลาในไฟล์ซับไม่ถูกต้อง');
    const start=subtitleTime(timing[1]),end=subtitleTime(timing[2]);if(start==null||end==null||end<=start)throw new Error('รูปแบบเวลาในไฟล์ซับไม่ถูกต้อง');
    const cueText=lines.slice(timingIndex+1).join('\n').replace(/<[^>]+>/g,'').trim();if(!cueText)continue;
    if(cues.length&&start<cues.at(-1).end-.001)throw new Error('ไฟล์ซับมีช่วงเวลาซ้อนกัน');
    cues.push({start,end,text:cueText});
  }
  if(!cues.length)throw new Error('ไม่พบคำบรรยายในไฟล์');return cues;
}

export function captionsFromSubtitle(text,{format='auto',language='th'}={}){
  return parseSubtitle(text,{format}).map(cue=>{
    const pieces=thaiWords(cue.text.replace(/\n+/g,' '),language),duration=cue.end-cue.start,weights=pieces.map(piece=>Math.max(1,graphemeCount(piece.text,language))),total=weights.reduce((a,b)=>a+b,0)||1;let cursor=cue.start;
    const words=pieces.map((piece,index)=>{const end=index===pieces.length-1?cue.end:cursor+duration*weights[index]/total,value={id:crypto.randomUUID(),text:piece.text,start:cursor,end,spaceBefore:piece.spaceBefore,rawConfidence:null,reviewScore:null,needsReview:true,reviewStatus:'pending',timingSource:'estimated'};cursor=end;return value});
    return{id:crypto.randomUUID(),start:cue.start,end:cue.end,text:wordsText(words),words};
  });
}

export function shiftCaptions(captions,offset,duration=Infinity){
  const source=captions||[];if(!source.length)return[];const requested=Number(offset)||0,minOffset=-Math.min(...source.map(caption=>caption.start)),maxOffset=Number.isFinite(duration)?duration-Math.max(...source.map(caption=>caption.end)):Infinity,amount=Math.max(minOffset,Math.min(maxOffset,requested));
  return source.map(caption=>({...caption,start:caption.start+amount,end:caption.end+amount,words:(caption.words||[]).map(word=>({...word,start:word.start+amount,end:word.end+amount,timingSource:word.timingSource==='estimated'?'estimated':'manual'}))}));
}

export function replaceCaptionsInRange(captions,candidateCaptions,range,options={}){
  const start=Number(range?.start),end=Number(range?.end);if(!Number.isFinite(start)||!Number.isFinite(end)||end<=start)throw new Error('ช่วงเวลาถอดเสียงใหม่ไม่ถูกต้อง');
  const keep=(captions||[]).flatMap(caption=>caption.words||[]).filter(word=>word.end<=start||word.start>=end),incoming=(candidateCaptions||[]).flatMap(caption=>caption.words||[]).filter(word=>word.end>start&&word.start<end).map(word=>({...word,start:Math.max(start,word.start),end:Math.min(end,word.end)})).filter(word=>word.end-word.start>=.04);
  return reflowWords([...keep,...incoming],options);
}

const cleanText=value=>String(value||'').replace(/\s+/g,' ').trim();

export function validateDubRange(project,startValue,endValue,{minimum=.2}={}){
  const start=Math.max(0,Number(startValue)),end=Math.min(Number(project?.duration)||0,Number(endValue));
  if(!Number.isFinite(start)||!Number.isFinite(end)||end-start<minimum)throw new Error(`ช่วงเสียงพากย์ต้องยาวอย่างน้อย ${minimum.toFixed(1)} วินาที`);
  return{start,end};
}

export function validateDubText(value){
  const text=cleanText(value);
  if(!text)throw new Error('กรุณาใส่บทพากย์');
  if(text.length>1000)throw new Error('บทพากย์ยาวเกิน 1,000 ตัวอักษร');
  return text;
}

export function findDubOverlap(clips,range,ignoreId=null){
  return(clips||[]).find(clip=>clip.id!==ignoreId&&Number(clip.end_time)>range.start+.001&&Number(clip.start_time)<range.end-.001)||null;
}

export function durationFitStatus(actualDuration,slotDuration,{maximumRate=1.18,tolerance=.04}={}){
  const actual=Number(actualDuration),slot=Number(slotDuration);
  if(!Number.isFinite(actual)||actual<=0||!Number.isFinite(slot)||slot<=0)return{status:'failed',rate:1};
  if(actual<=slot+tolerance)return{status:'fit',rate:1};
  const rate=actual/slot;
  return rate<=maximumRate?{status:'stretch',rate}:{status:'needs_edit',rate};
}

export function validateDubExport(clips){
  if(!(clips||[]).length)throw new Error('ยังไม่มีเสียงพากย์ในโปรเจกต์');
  const sorted=[...clips].sort((a,b)=>a.start_time-b.start_time);
  for(const [index,clip] of sorted.entries()){
    if(clip.status!=='ready'||!clip.audio_path)throw new Error(`เสียงพากย์ช่วง ${Number(clip.start_time).toFixed(2)}s ยังไม่พร้อม`);
    if(clip.fit_status==='needs_edit')throw new Error(`เสียงพากย์ช่วง ${Number(clip.start_time).toFixed(2)}s ยาวเกินช่วง`);
    if(index&&sorted[index-1].end_time>clip.start_time+.001)throw new Error('เสียงพากย์มีช่วงเวลาซ้อนกัน');
  }
  return sorted;
}

export function atempoChain(rate){
  let value=Number(rate)||1,parts=[];
  while(value>2){parts.push('atempo=2');value/=2}
  while(value<.5){parts.push('atempo=0.5');value*=2}
  parts.push(`atempo=${value.toFixed(5)}`);
  return parts.join(',');
}

const thaiDigits=['ศูนย์','หนึ่ง','สอง','สาม','สี่','ห้า','หก','เจ็ด','แปด','เก้า'];
function thaiInteger(value){
  const number=Math.trunc(Math.abs(Number(value)));
  if(!Number.isFinite(number))return String(value);
  if(number===0)return thaiDigits[0];
  if(number>=1_000_000)return`${thaiInteger(Math.floor(number/1_000_000))}ล้าน${number%1_000_000?thaiInteger(number%1_000_000):''}`;
  const places=['','สิบ','ร้อย','พัน','หมื่น','แสน'],digits=String(number).split('').map(Number),parts=[];
  for(let index=0;index<digits.length;index++){
    const digit=digits[index],place=digits.length-index-1;if(!digit)continue;
    if(place===1&&digit===1)parts.push('สิบ');
    else if(place===1&&digit===2)parts.push('ยี่สิบ');
    else if(place===0&&digit===1&&digits.length>1)parts.push('เอ็ด');
    else parts.push(`${thaiDigits[digit]}${places[place]}`);
  }
  return parts.join('');
}

export function numberToThaiWords(value){
  const source=String(value).replaceAll(',',''),[integer,decimal]=source.split('.');
  const main=thaiInteger(integer);
  return decimal?`${main}จุด${[...decimal].map(digit=>thaiDigits[Number(digit)]).join('')}`:main;
}

export function parsePronunciationRules(value){
  const lines=Array.isArray(value)?value:String(value||'').split(/\r?\n/);
  return lines.map(item=>{
    if(item&&typeof item==='object')return{from:cleanText(item.from),to:cleanText(item.to)};
    const match=String(item).match(/^\s*(.+?)\s*(?:=>|=|→)\s*(.+?)\s*$/);
    return match?{from:cleanText(match[1]),to:cleanText(match[2])}:null;
  }).filter(rule=>rule?.from&&rule?.to).slice(0,100);
}

export function prepareTtsText(value,rules=[]){
  let text=validateDubText(value);
  for(const {from,to} of parsePronunciationRules(rules)){
    text=text.replace(new RegExp(from.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'),'giu'),to);
  }
  return text.replace(/(?<![\p{L}\p{N}])\d[\d,]*(?:\.\d+)?(?![\p{L}\p{N}])/gu,numberToThaiWords);
}

export function validateDubControls({speed=1,pauseBefore=0,pauseAfter=0,slotDuration=Infinity}={}){
  const normalized={
    speed:Math.max(.85,Math.min(1.15,Number(speed)||1)),
    pauseBefore:Math.max(0,Math.min(1.5,Number(pauseBefore)||0)),
    pauseAfter:Math.max(0,Math.min(1.5,Number(pauseAfter)||0)),
  };
  if(normalized.pauseBefore+normalized.pauseAfter>=Number(slotDuration)-.2)throw new Error('ช่วงพักก่อนและหลังยาวเกินพื้นที่ของคลิป');
  return normalized;
}

import { effectDefinition } from '../public/effects.js';

const clamp=(n,min,max)=>Math.max(min,Math.min(max,Number(n)||0));
export const srtTime=s=>new Date(Math.max(0,s)*1000).toISOString().slice(11,23).replace('.',',');
export const assTime=s=>`${Math.floor(s/3600)}:${String(Math.floor(s/60)%60).padStart(2,'0')}:${String(Math.floor(s)%60).padStart(2,'0')}.${String(Math.floor((s%1)*100)).padStart(2,'0')}`;
export const assEsc=s=>String(s).replaceAll('\\','／').replaceAll('{','（').replaceAll('}','）').replaceAll('\r','').replaceAll('\n','\\N');
export const assColor=hex=>{const value=String(hex||'FFFFFF').replace('#','').replace(/[^0-9a-f]/gi,'').padEnd(6,'F').slice(0,6);return `&H00${value.match(/../g).reverse().join('')}`};
const safeFont=font=>String(font||'Leelawadee UI').replace(/[^\p{L}\p{N} ._-]/gu,'').slice(0,80)||'Leelawadee UI';
const spaced=(words,transform=w=>w.text)=>words.map((word,index)=>`${index&&word.spaceBefore!==false?' ':''}${transform(word)}`).join('');

function animationTag(style){
  const animation=style.animation,duration=Math.round(clamp(style.animationDuration??220,80,1000)),intensity=clamp(style.animationIntensity??100,20,180)/100;
  if(animation==='pop'){const start=Math.round(100-35*intensity),over=Math.round(100+8*intensity),turn=Math.round(duration*.62);return `{\\fad(40,70)\\fscx${start}\\fscy${start}\\t(0,${turn},\\fscx${over}\\fscy${over})\\t(${turn},${duration},\\fscx100\\fscy100)}`}
  if(animation==='bounce'){const start=Math.round(100-30*intensity),over=Math.round(100+18*intensity),turn=Math.round(duration*.5);return `{\\fad(35,70)\\fscy${start}\\t(0,${turn},\\fscy${over})\\t(${turn},${duration},\\fscy100)}`}
  if(animation==='fade'){const fade=style.animationDuration==null?180:duration;return `{\\fad(${fade},${fade})}`}
  return '';
}

function inlineAnimationTag(style){
  const animation=style.animation,duration=Math.round(clamp(style.animationDuration??220,80,1000)),intensity=clamp(style.animationIntensity??100,20,180)/100;
  if(animation==='pop'){const start=Math.round(100-35*intensity),over=Math.round(100+8*intensity),turn=Math.round(duration*.62);return `{\\fscx${start}\\fscy${start}\\t(0,${turn},\\fscx${over}\\fscy${over})\\t(${turn},${duration},\\fscx100\\fscy100)}`}
  if(animation==='bounce'){const start=Math.round(100-30*intensity),over=Math.round(100+18*intensity),turn=Math.round(duration*.5);return `{\\fscy${start}\\t(0,${turn},\\fscy${over})\\t(${turn},${duration},\\fscy100)}`}
  if(animation==='fade'){const fade=style.animationDuration==null?180:duration;return `{\\alpha&HFF&\\t(0,${fade},\\alpha&H00&)}`}
  return '';
}
const inlineReset='{\\fscx100\\fscy100\\alpha&H00&}';

export function dialogueLines(captions,style){
  const effect=style.effect||'sentence',definition=effectDefinition(effect),highlight=style.highlightColor||'B8FF38',base=style.color||'FFFFFF',anim=definition.animate==='highlight-only'?'':animationTag(style);
  const lines=[];
  for(const c of captions){
    const words=c.words?.length?c.words:[{text:c.text,start:c.start,end:c.end}];
    if(effect==='karaoke'){
      const body=words.map((w,index)=>`${index&&w.spaceBefore!==false?' ':''}{\\kf${Math.max(1,Math.round((w.end-w.start)*100))}}${assEsc(w.text)}`).join('');
      lines.push(`Dialogue: 0,${assTime(c.start)},${assTime(c.end)},Default,,0,0,0,,${anim}${body}`);
    }else if(effect==='word'){
      for(const w of words)lines.push(`Dialogue: 0,${assTime(w.start)},${assTime(w.end)},Default,,0,0,0,,${anim}{\\c${assColor(highlight)}}${assEsc(w.text)}`);
    }else if(effect==='progressive'){
      for(let i=0;i<words.length;i++){
        const prior=spaced(words.slice(0,i),w=>assEsc(w.text)),separator=i&&words[i].spaceBefore!==false?' ':'',active=`{\\c${assColor(highlight)}}${inlineAnimationTag(style)}${assEsc(words[i].text)}${inlineReset}{\\c${assColor(base)}}`,next=words[i+1]?.start,end=Number.isFinite(next)&&next>words[i].start?next:Math.max(words[i].end,c.end);
        lines.push(`Dialogue: 0,${assTime(words[i].start)},${assTime(end)},Default,,0,0,0,,${prior}${separator}${active}`);
      }
    }else lines.push(`Dialogue: 0,${assTime(c.start)},${assTime(c.end)},Default,,0,0,0,,${anim}${assEsc(c.text)}`);
  }
  return lines.join('\n');
}

export function makeAss({captions,style={},width,height}){
  const fontSize=Math.round(height*clamp(style.fontSizePct??6,1.5,18)/100),marginV=Math.round(height*clamp(style.bottomPct??12,1,60)/100);
  const align=[1,2,3].includes(Number(style.align))?Number(style.align):2,maxWidth=clamp(style.maxWidthPct??90,30,96),safe=clamp(style.safeAreaPct??5,0,15),marginH=Math.round(width*Math.max(safe,(100-maxWidth)/2)/100),borderStyle=style.backgroundEnabled?3:1,backColor=assColor(style.backgroundColor||'000000').replace('&H00','&H70');
  return `[Script Info]\nScriptType: v4.00+\nPlayResX: ${width}\nPlayResY: ${height}\nWrapStyle: 2\nScaledBorderAndShadow: yes\n[V4+ Styles]\nFormat: Name,Fontname,Fontsize,PrimaryColour,SecondaryColour,OutlineColour,BackColour,Bold,Italic,Underline,StrikeOut,ScaleX,ScaleY,Spacing,Angle,BorderStyle,Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding\nStyle: Default,${safeFont(style.font)},${fontSize},${assColor(style.color)},${assColor(style.highlightColor)},${assColor(style.outlineColor||'000000')},${backColor},${style.bold===false?0:-1},${style.italic?-1:0},0,0,${clamp(style.scaleX??100,60,160)},100,${clamp(style.spacing??0,-3,20)},${clamp(style.angle??0,-30,30)},${borderStyle},${clamp(style.outline??4,0,16)},${clamp(style.shadow??2,0,12)},${align},${marginH},${marginH},${marginV},1\n[Events]\nFormat: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text\n${dialogueLines(captions,style)}`;
}

export function makeSrt(captions){return captions.map((c,i)=>`${i+1}\n${srtTime(c.start)} --> ${srtTime(c.end)}\n${c.text}\n`).join('\n')}

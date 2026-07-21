import { spawn } from 'node:child_process';

export function runProcess(binary, args, { signal, onStderr } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { windowsHide: true, signal });
    let stderr = '';
    child.stderr.on('data', data => { const value=String(data); stderr=(stderr+value).slice(-12000); onStderr?.(value); });
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve({ stderr }) : reject(new Error(stderr.slice(-3000) || `Process exited ${code}`)));
  });
}

export function runProcessCapture(binary,args,{signal,onStderr,maxBytes=16*1024*1024}={}){
  return new Promise((resolve,reject)=>{
    const child=spawn(binary,args,{windowsHide:true,signal}),chunks=[];let size=0,stderr='';
    child.stdout.on('data',data=>{size+=data.length;if(size<=maxBytes)chunks.push(data);else child.kill()});
    child.stderr.on('data',data=>{const value=String(data);stderr=(stderr+value).slice(-12000);onStderr?.(value)});
    child.on('error',reject);
    child.on('close',code=>code===0?resolve({stdout:Buffer.concat(chunks),stderr}):reject(new Error(size>maxBytes?'ผลลัพธ์เกินขนาดที่รองรับ':stderr.slice(-3000)||`Process exited ${code}`)));
  });
}

export async function probeMedia(ffprobe, file) {
  let stdout='';
  await new Promise((resolve,reject)=>{
    const child=spawn(ffprobe,['-v','error','-show_entries','stream=codec_type,width,height:format=duration','-of','json',file],{windowsHide:true});
    let stderr=''; child.stdout.on('data',d=>stdout+=d); child.stderr.on('data',d=>stderr+=d);
    child.on('error',reject); child.on('close',c=>c===0?resolve():reject(new Error(stderr||'อ่านข้อมูลวิดีโอไม่ได้')));
  });
  const json=JSON.parse(stdout), stream=json.streams?.find(item=>item.codec_type==='video');
  const result={width:Number(stream?.width),height:Number(stream?.height),duration:Number(json.format?.duration),hasAudio:Boolean(json.streams?.some(item=>item.codec_type==='audio'))};
  if(!result.width||!result.height||!Number.isFinite(result.duration)||result.duration<=0)throw new Error('ไฟล์นี้ไม่มีวิดีโอที่รองรับ');
  return result;
}

export async function probeAudioDuration(ffprobe,file){
  let stdout='';
  await new Promise((resolve,reject)=>{
    const child=spawn(ffprobe,['-v','error','-show_entries','format=duration','-of','default=noprint_wrappers=1:nokey=1',file],{windowsHide:true});
    let stderr='';child.stdout.on('data',data=>stdout+=data);child.stderr.on('data',data=>stderr+=data);
    child.on('error',reject);child.on('close',code=>code===0?resolve():reject(new Error(stderr||'อ่านความยาวเสียงไม่ได้')));
  });
  const duration=Number(stdout.trim());
  if(!Number.isFinite(duration)||duration<=0)throw new Error('ไฟล์เสียงไม่มีความยาวที่ถูกต้อง');
  return duration;
}

export async function detectSilences(ffmpeg, file, { noiseDb = -38, duration = .22, signal } = {}) {
  let stderr = '';
  await runProcess(ffmpeg, [
    '-hide_banner', '-nostats', '-i', file,
    '-af', `silencedetect=noise=${noiseDb}dB:d=${duration}`,
    '-f', 'null', '-',
  ], { signal, onStderr: value => { stderr += value; } });
  const silences = [];
  let pendingStart = null;
  for (const line of stderr.split(/\r?\n/)) {
    const start = line.match(/silence_start:\s*([0-9.]+)/);
    if (start) pendingStart = Number(start[1]);
    const end = line.match(/silence_end:\s*([0-9.]+)/);
    if (end && pendingStart != null) {
      const value = Number(end[1]);
      if (Number.isFinite(value) && value > pendingStart) silences.push({ start: pendingStart, end: value });
      pendingStart = null;
    }
  }
  return silences;
}

export function speechRegionsFromSilences(duration,silences,{padding=.08}={}){
  const quiet=(silences||[]).filter(x=>Number.isFinite(x.start)&&Number.isFinite(x.end)&&x.end>x.start).sort((a,b)=>a.start-b.start),regions=[];
  let cursor=0,index=0;
  for(const silence of quiet){
    if(silence.start>cursor+.04)regions.push({id:`speech-fallback-${index++}`,start:Math.max(0,cursor-padding),end:Math.min(duration,silence.start+padding)});
    cursor=Math.max(cursor,silence.end);
  }
  if(duration>cursor+.04)regions.push({id:`speech-fallback-${index}`,start:Math.max(0,cursor-padding),end:duration});
  return regions;
}

export async function generateWaveformPeaks(ffmpeg,file,{buckets=2400,signal}={}){
  const {stdout}=await runProcessCapture(ffmpeg,['-hide_banner','-loglevel','error','-i',file,'-vn','-ac','1','-ar','100','-f','f32le','pipe:1'],{signal,maxBytes:32*1024*1024});
  const samples=new Float32Array(stdout.buffer,stdout.byteOffset,Math.floor(stdout.byteLength/4));
  if(!samples.length)return{peaks:[],normalized:true};
  const count=Math.max(200,Math.min(8000,Number(buckets)||2400)),raw=[];
  for(let i=0;i<count;i++){
    const from=Math.floor(i*samples.length/count),to=Math.max(from+1,Math.floor((i+1)*samples.length/count));let peak=0;
    for(let j=from;j<to&&j<samples.length;j++)peak=Math.max(peak,Math.abs(samples[j]));raw.push(peak);
  }
  const sorted=[...raw].sort((a,b)=>a-b),reference=sorted[Math.floor((sorted.length-1)*.95)]||Math.max(...raw)||1;
  return{peaks:raw.map(value=>Math.max(0,Math.min(1,value/reference))),normalized:true,sampleRate:100,buckets:count};
}

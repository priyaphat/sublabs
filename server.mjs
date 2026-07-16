import express from 'express';
import multer from 'multer';
import ffmpegPath from 'ffmpeg-static';
import ffprobeStatic from 'ffprobe-static';
import { mkdir, readdir, rename, rm, stat, statfs, writeFile } from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { openDatabase, projectStore } from './lib/db.mjs';
import { alignWordsToSpeechRegions, applyGlossary, normalizeGlossary, reflowWords, replaceCaptionsInRange, tokensToWords, validateCaptions } from './lib/captions.mjs';
import { detectSilences, generateWaveformPeaks, runProcess, probeMedia, speechRegionsFromSilences } from './lib/media.mjs';
import { WhisperService, extractSpeechRegions, extractTimedTokens } from './lib/whisper.mjs';
import { makeAss, makeSrt } from './lib/render.mjs';
import { findWeakSpeechRegions, hypothesesDisagree, markSpeechRegionForReview, replaceSpeechRegionWords, retryCandidateWins } from './lib/transcription-quality.mjs';

const root=path.dirname(fileURLToPath(import.meta.url)),dataDir=process.env.SUBLABS_DATA_DIR?path.resolve(process.env.SUBLABS_DATA_DIR):path.join(root,'data'),uploadDir=path.join(dataDir,'uploads'),outputDir=path.join(dataDir,'outputs'),tempDir=path.join(dataDir,'temp'),fontsDir=path.join(dataDir,'fonts');
await Promise.all([uploadDir,outputDir,tempDir,fontsDir,path.join(dataDir,'models')].map(dir=>mkdir(dir,{recursive:true})));
for(const directory of [outputDir,tempDir])for(const file of await readdir(directory)){const target=path.join(directory,file);try{if(Date.now()-(await stat(target)).mtimeMs>24*60*60*1000)await rm(target,{force:true})}catch{}}
const db=openDatabase(path.join(dataDir,'sublabs.db')),store=projectStore(db); store.recoverJobs();
const whisper=new WhisperService({root,models:{accurate:path.join(dataDir,'models','whisper-cpp','ggml-large-v3-turbo-q8_0.bin'),balanced:path.join(dataDir,'models','whisper-cpp','ggml-large-v3-turbo-q5_0.bin'),fast:path.join(dataDir,'models','whisper-cpp','ggml-large-v3-turbo-q5_0.bin')},vadModel:path.join(dataDir,'models','whisper-cpp','ggml-silero-v6.2.0.bin')});
const app=express();
app.disable('x-powered-by');
app.use((_,res,next)=>{res.set({'X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','Content-Security-Policy':"default-src 'self'; img-src 'self' blob: data:; media-src 'self' blob:; style-src 'self' 'unsafe-inline'; script-src 'self'"});next()});
app.use(express.json({limit:'20mb'})); app.use(express.static(path.join(root,'public'))); app.get('/shared/captions.mjs',(_,res)=>res.type('text/javascript').sendFile(path.join(root,'lib','captions.mjs'))); app.use('/media',express.static(dataDir,{fallthrough:false}));
const upload=multer({dest:tempDir,limits:{fileSize:2*1024*1024*1024,files:1},fileFilter:(_,file,cb)=>cb(null,/^(video|audio)\//.test(file.mimetype))});
const fontUpload=multer({dest:tempDir,limits:{fileSize:20*1024*1024,files:1},fileFilter:(_,file,cb)=>cb(null,/\.(ttf|otf)$/i.test(file.originalname))});

const repairFilename=value=>{const name=String(value||'');if(!/[à¸à¹Ã]/.test(name))return name;try{const repaired=Buffer.from(name,'latin1').toString('utf8');return repaired.includes('�')?name:repaired}catch{return name}};
const publicProject=p=>p&&({id:p.id,name:repairFilename(p.name),mediaUrl:p.media_url,width:p.width,height:p.height,duration:p.duration,captions:p.captions,style:p.style,language:p.language,wordsPerCaption:p.words_per_caption||5,speechRegions:p.speechRegions||[],schemaVersion:p.schema_version||1,createdAt:p.created_at,updatedAt:p.updated_at});
const publicProjectSummary=p=>p&&({id:p.id,name:repairFilename(p.name),width:p.width,height:p.height,duration:p.duration,captionCount:p.captions?.length||0,mediaUrl:p.media_url,createdAt:p.created_at,updatedAt:p.updated_at});
const publicJob=j=>j&&({id:j.id,projectId:j.project_id,status:j.status,step:j.step,progress:j.progress,label:j.label,error:j.status==='failed'?j.error:null,cancelRequested:Boolean(j.cancel_requested),createdAt:j.created_at,updatedAt:j.updated_at});
const publicExport=value=>value&&({id:value.id,projectId:value.project_id,status:value.status,progress:value.progress,label:value.label,error:value.status==='failed'?value.error:null,cancelRequested:Boolean(value.cancel_requested),downloadUrl:value.status==='complete'?`/api/exports/${value.id}/download`:null,createdAt:value.created_at,updatedAt:value.updated_at});
async function ensureDisk(bytes){const s=await statfs(dataDir);if(s.bavail*s.bsize<Math.max(bytes*2,1024**3))throw new Error('พื้นที่ดิสก์เหลือน้อยเกินไปสำหรับประมวลผลไฟล์นี้')}

app.post('/api/projects',upload.single('video'),async(req,res)=>{
  if(!req.file)return res.status(400).json({error:'กรุณาเลือกไฟล์วิดีโอที่รองรับ'});
  try{
    await ensureDisk(req.file.size); const media=await probeMedia(ffprobeStatic.path,req.file.path);
    if(media.duration>4*3600)throw new Error('รองรับวิดีโอความยาวสูงสุด 4 ชั่วโมง');
    const originalName=repairFilename(req.file.originalname),id=crypto.randomUUID(),ext=(path.extname(originalName)||'.mp4').toLowerCase(),target=path.join(uploadDir,id+ext); await rename(req.file.path,target);
    const project=store.create({id,name:path.basename(originalName),file:target,mediaUrl:`/media/uploads/${id}${ext}`,...media,createdAt:new Date().toISOString()});
    res.status(201).json(publicProject(project));
  }catch(error){await rm(req.file.path,{force:true});res.status(415).json({error:error.message})}
});
app.get('/api/projects/:id',(req,res)=>{const p=store.get(req.params.id);if(!p)return res.status(404).json({error:'ไม่พบโปรเจกต์'});res.json(publicProject(p))});
app.get('/api/projects',(_,res)=>res.json({projects:store.list().map(publicProjectSummary)}));
app.delete('/api/projects/:id',async(req,res)=>{const value=store.get(req.params.id);if(!value)return res.status(404).json({error:'ไม่พบโปรเจกต์'});for(const item of store.listExports(value.id))if(item.result_path)await rm(item.result_path,{force:true});store.delete(value.id);await rm(value.file_path,{force:true});res.json({ok:true})});
app.put('/api/projects/:id/captions',(req,res)=>{try{const p=store.get(req.params.id);if(!p)return res.status(404).json({error:'ไม่พบโปรเจกต์'});const captions=validateCaptions(req.body.captions);res.json(publicProject(store.updateCaptions(p.id,captions,req.body.language||p.language,req.body.wordsPerCaption)))}catch(e){res.status(400).json({error:e.message})}});
app.put('/api/projects/:id/style',(req,res)=>{const p=store.get(req.params.id);if(!p)return res.status(404).json({error:'ไม่พบโปรเจกต์'});res.json(publicProject(store.updateStyle(p.id,req.body.style||{})))});
app.get('/api/projects/:id/waveform',async(req,res)=>{const p=store.get(req.params.id);if(!p)return res.status(404).json({error:'ไม่พบโปรเจกต์'});try{let waveform=p.waveform;if(!waveform?.peaks?.length){waveform=await generateWaveformPeaks(ffmpegPath,p.file_path,{buckets:2400});store.updateAnalysis(p.id,{waveform})}res.json({...waveform,duration:p.duration,speechRegions:p.speechRegions||[]})}catch(error){res.status(500).json({error:error.message})}});

const queue=[]; let active=null;
const transcriptionEstimate=(duration,quality)=>{const rates={accurate:[.3,.9],balanced:[.55,1.6],fast:[.4,1.2]},rate=rates[quality]||rates.accurate;return{minimum:Math.max(8,Math.round(duration*rate[0])),maximum:Math.max(15,Math.round(duration*rate[1]))}};
function expandTranscriptionRange(range,speechRegions,duration){
  if(!range)return{start:0,end:duration};const regions=(speechRegions||[]).filter(region=>region.end>range.start&&region.start<range.end).sort((a,b)=>a.start-b.start),first=regions[0],last=regions.at(-1);
  return{start:Math.max(0,first?Math.max(first.start,range.start-.25):range.start-.25),end:Math.min(duration,last?Math.min(last.end,range.end+.25):range.end+.25)};
}
const offsetItems=(items,offset)=>items.map(item=>({...item,start:item.start+offset,end:item.end+offset}));

async function retryWeakRegions({words,speechRegions,wav,transcriptionLanguage,segmentationLanguage,glossary,prompt,quality,signal,jobId}){
  let improved=words;
  const weak=findWeakSpeechRegions(improved,speechRegions).slice(0,12);
  for(const [index,region] of weak.entries()){
    const retryWav=path.join(tempDir,`${jobId}-retry-${index}.wav`),duration=region.end-region.start;
    try{
      await runProcess(ffmpegPath,['-y','-ss',String(region.start),'-t',String(duration),'-i',wav,'-ac','1','-ar','16000','-c:a','pcm_s16le',retryWav],{signal});
      const prior=improved.filter(word=>word.end<=region.start),previous=prior.at(-1);
      // Do not feed a previous sentence across a VAD silence into the retry.
      // That propagates recognition mistakes and biases the next dialect phrase.
      const nearbyContext=previous&&region.start-previous.end<=.45?prior.slice(-16).map(word=>word.text).join(' '):'';
      const retryPrompt=[prompt,nearbyContext,...glossary].filter(Boolean).join(', ');
      const result=await whisper.transcribe(retryWav,{language:transcriptionLanguage,prompt:retryPrompt,signal,vad:false,quality});
      const candidate=alignWordsToSpeechRegions(applyGlossary(tokensToWords(offsetItems(extractTimedTokens(result),region.start),segmentationLanguage),glossary),[region]);
      if(retryCandidateWins(improved,candidate,region))improved=replaceSpeechRegionWords(improved,candidate,region);
      else if(hypothesesDisagree(improved,candidate,region))improved=markSpeechRegionForReview(improved,candidate,region);
    }finally{await rm(retryWav,{force:true})}
  }
  return improved;
}

async function runQueue(){
  if(active||!queue.length)return;const jobId=queue.shift(),job=store.getJob(jobId);if(!job||job.cancel_requested)return runQueue();
  const project=store.get(job.project_id),options=JSON.parse(job.options_json||'{}'),requestedRange=options.range||null,expandedRange=expandTranscriptionRange(requestedRange,project.speechRegions,project.duration),clipDuration=expandedRange.end-expandedRange.start,wav=path.join(tempDir,`${jobId}.wav`),controller=new AbortController();active={jobId,controller};
  try{
    store.updateJob(jobId,{status:'running',step:1,progress:5,label:requestedRange?'กำลังเตรียมเสียงช่วงที่เลือก':'กำลังแยกและปรับเสียงเป็น 16 kHz'});
    const inputArgs=requestedRange?['-ss',String(expandedRange.start),'-t',String(clipDuration),'-i',project.file_path]:['-i',project.file_path];
    await runProcess(ffmpegPath,['-y',...inputArgs,'-vn','-ac','1','-ar','16000','-af','highpass=f=70,lowpass=f=12000,loudnorm=I=-16:TP=-1.5:LRA=11','-c:a','pcm_s16le',wav],{signal:controller.signal});
    if(store.getJob(jobId).cancel_requested)throw new DOMException('ยกเลิกแล้ว','AbortError');
    store.updateJob(jobId,{step:2,progress:null,label:`กำลังโหลดโมเดลโหมด ${options.quality}`});await whisper.start(options.quality);
    const profile=whisper.status();store.updateJob(jobId,{step:3,progress:null,label:`กำลังถอดเสียง + DTW (${profile.mode.toUpperCase()} · ${profile.activeProfile})`});
    const glossary=normalizeGlossary(options.glossary||options.prompt),prompt=[options.prompt,...glossary].filter(Boolean).join(', '),[result,rawRegions]=await Promise.all([whisper.transcribe(wav,{language:options.language||'th',prompt,signal:controller.signal,vad:false,quality:options.quality}),whisper.detectSpeechRegions(wav,{signal:controller.signal}).catch(()=>[])]);
    store.updateJob(jobId,{step:4,progress:84,label:'กำลังตรวจช่วงเงียบและจัดเวลาของคำ'});
    const detected=result.language||result.detected_language||options.language||'th',languageMap={english:'en',thai:'th'},languageCode=languageMap[String(detected).toLowerCase()]||detected,offset=expandedRange.start;
    let localRegions=rawRegions;
    if(!localRegions.length){const silences=await detectSilences(ffmpegPath,wav,{noiseDb:-32,duration:.18,signal:controller.signal}),resultRegions=extractSpeechRegions(result);localRegions=resultRegions.length?resultRegions:speechRegionsFromSilences(clipDuration,silences)}
    const speechRegions=offsetItems(localRegions,offset).map((region,index)=>({...region,id:requestedRange?`partial-${jobId}-${index}`:region.id})),tokens=offsetItems(extractTimedTokens(result),offset);let allWords=alignWordsToSpeechRegions(applyGlossary(tokensToWords(tokens,detected),glossary),speechRegions);
    if(!requestedRange){
      const weakCount=findWeakSpeechRegions(allWords,speechRegions).length;
      if(weakCount){store.updateJob(jobId,{step:4,progress:88,label:`กำลังเทียบผลถอดเสียงซ้ำ ${Math.min(12,weakCount)} ช่วง`});allWords=await retryWeakRegions({words:allWords,speechRegions,wav,transcriptionLanguage:options.language||'th',segmentationLanguage:detected,glossary,prompt,quality:options.quality,signal:controller.signal,jobId})}
    }
    const words=requestedRange?allWords.filter(word=>word.end>requestedRange.start&&word.start<requestedRange.end).map(word=>({...word,start:Math.max(requestedRange.start,word.start),end:Math.min(requestedRange.end,word.end)})).filter(word=>word.end-word.start>=.04):allWords;
    const reflowOptions={maxWords:options.wordsPerCaption||5,pauseThreshold:.25,cps:17,maxDuration:4,maxLines:2,maxCharsPerLine:32,language:languageCode},captions=reflowWords(words,reflowOptions);
    if(!captions.length)throw new Error(String(result.text||'').trim()?'ถอดเสียงได้แต่ไม่สามารถจัดเวลาเป็นคำได้':'ไม่พบเสียงพูดที่ชัดเจนในช่วงนี้');
    const actualProfile=whisper.status();
    if(requestedRange){store.updateJob(jobId,{status:'complete',step:5,progress:100,label:'ผลถอดเสียงใหม่พร้อมตรวจ',error:null,result_json:{candidateCaptions:captions,range:requestedRange,expandedRange,languageCode,actualProfile,applied:false}})}
    else{store.updateCaptions(project.id,validateCaptions(captions),languageCode,options.wordsPerCaption);store.updateAnalysis(project.id,{speechRegions});store.updateJob(jobId,{status:'complete',step:5,progress:100,label:'ถอดเสียงและจัดเวลาคำเสร็จแล้ว',error:null,result_json:{actualProfile,applied:true}})}
  }catch(error){const cancelled=error?.name==='AbortError'||store.getJob(jobId)?.cancel_requested;store.updateJob(jobId,{status:cancelled?'cancelled':'failed',step:0,progress:cancelled?0:null,label:cancelled?'ยกเลิกแล้ว':'เกิดข้อผิดพลาด',error:cancelled?null:String(error.message||error)})}
  finally{await rm(wav,{force:true});active=null;setImmediate(runQueue)}
}

app.get('/api/transcriptions/:id',(req,res)=>{const job=store.getJob(req.params.id);if(!job)return res.status(404).json({error:'ไม่พบงาน'});const options=JSON.parse(job.options_json||'{}'),result=JSON.parse(job.result_json||'{}'),duration=options.range?options.range.end-options.range.start:(store.get(job.project_id)?.duration||0),output={...publicJob(job),settings:{quality:options.quality,vad:options.vad,range:options.range||null,estimateSeconds:transcriptionEstimate(duration,options.quality),actualProfile:result.actualProfile||(active?.jobId===job.id?whisper.status():null)}};if(job.status==='complete'){if(options.range){output.candidateCaptions=result.candidateCaptions||[];output.range=result.range;output.expandedRange=result.expandedRange;output.applied=Boolean(result.applied)}else output.project=publicProject(store.get(job.project_id))}if(job.status==='queued')output.queuePosition=queue.indexOf(job.id)+1;res.json(output)});
app.post('/api/transcriptions/:id/apply',(req,res)=>{try{const job=store.getJob(req.params.id);if(!job)return res.status(404).json({error:'ไม่พบงาน'});const options=JSON.parse(job.options_json||'{}'),result=JSON.parse(job.result_json||'{}');if(job.status!=='complete'||!options.range||!result.candidateCaptions)return res.status(409).json({error:'ผลถอดเสียงใหม่ยังไม่พร้อม'});if(result.applied)return res.status(409).json({error:'ผลนี้ถูกนำไปใช้แล้ว'});const project=store.get(job.project_id),captions=validateCaptions(replaceCaptionsInRange(project.captions,result.candidateCaptions,result.range,{maxWords:options.wordsPerCaption||5,pauseThreshold:.25,cps:17,maxDuration:4,maxLines:2,maxCharsPerLine:32,language:result.languageCode||project.language})),updated=store.updateCaptions(project.id,captions,result.languageCode||project.language,options.wordsPerCaption);store.updateJob(job.id,{label:'นำผลถอดเสียงใหม่ไปใช้แล้ว',result_json:{...result,applied:true}});res.json(publicProject(updated))}catch(error){res.status(400).json({error:error.message})}});

app.post('/api/projects/:id/transcriptions',(req,res)=>{
  const p=store.get(req.params.id);if(!p)return res.status(404).json({error:'ไม่พบโปรเจกต์'});
  const quality=['accurate','balanced','fast'].includes(req.body.quality)?req.body.quality:'accurate';let range=null;
  if(req.body.range){const start=Math.max(0,Number(req.body.range.start)),end=Math.min(p.duration,Number(req.body.range.end));if(!Number.isFinite(start)||!Number.isFinite(end)||end-start<.08)return res.status(400).json({error:'ช่วงเวลาถอดเสียงใหม่ไม่ถูกต้อง'});range={start,end}}
  const id=crypto.randomUUID(),now=new Date().toISOString(),options={language:req.body.language||'th',quality,range,prompt:String(req.body.prompt||'').slice(0,2000),glossary:normalizeGlossary(req.body.glossary||req.body.prompt),wordsPerCaption:Math.max(1,Math.min(12,Number(req.body.wordsPerCaption)||5)),vad:{threshold:.5,speechPaddingMs:80,minSilenceMs:180,maxSpeechSeconds:30}};
  const job=store.createJob({id,projectId:p.id,status:'queued',step:0,progress:0,label:'อยู่ในคิว',createdAt:now,options}); queue.push(id);setImmediate(runQueue);res.status(202).json(publicJob(job));
});
app.delete('/api/transcriptions/:id',async(req,res)=>{const j=store.getJob(req.params.id);if(!j)return res.status(404).json({error:'ไม่พบงาน'});store.updateJob(j.id,{cancel_requested:1,label:'กำลังยกเลิก'});const index=queue.indexOf(j.id);if(index>=0){queue.splice(index,1);store.updateJob(j.id,{status:'cancelled',label:'ยกเลิกแล้ว'})}if(active?.jobId===j.id){active.controller.abort();await whisper.cancel()}res.status(202).json({ok:true})});

const exportQueue=[];let activeExport=null;
async function runExportQueue(){
  if(activeExport||!exportQueue.length)return;
  const exportId=exportQueue.shift(),item=store.getExport(exportId);if(!item||item.cancel_requested)return runExportQueue();
  const project=store.get(item.project_id),options=JSON.parse(item.options_json||'{}'),assPath=path.join(tempDir,`${exportId}.ass`),out=path.join(outputDir,`${exportId}.mp4`),controller=new AbortController();activeExport={exportId,controller};
  try{
    store.updateExport(exportId,{status:'running',progress:2,label:'กำลังเตรียมคำบรรยาย'});
    const style={...project.style,...(options.style||{})};store.updateStyle(project.id,style);await writeFile(assPath,makeAss({captions:project.captions,style,width:project.width,height:project.height}),'utf8');
    const filterPath=assPath.replaceAll('\\','/').replace(':','\\:').replaceAll("'","\\'"),fontPath=fontsDir.replaceAll('\\','/').replace(':','\\:').replaceAll("'","\\'");let buffer='',lastProgress=0;
    await runProcess(ffmpegPath,['-y','-i',project.file_path,'-vf',`ass='${filterPath}':fontsdir='${fontPath}'`,'-c:v','libx264','-preset','fast','-crf','20','-c:a','aac','-b:a','192k','-movflags','+faststart','-progress','pipe:2','-nostats',out],{signal:controller.signal,onStderr:value=>{
      buffer=(buffer+value).slice(-5000);const matches=[...buffer.matchAll(/out_time_(?:ms|us)=(\d+)/g)],raw=Number(matches.at(-1)?.[1]);if(!Number.isFinite(raw))return;const progress=Math.max(4,Math.min(99,Math.round(raw/1e6/project.duration*100)));if(progress>=lastProgress+2){lastProgress=progress;store.updateExport(exportId,{progress,label:`กำลัง Render ${progress}%`})}
    }});
    store.updateExport(exportId,{status:'complete',progress:100,label:'Render เสร็จแล้ว',result_path:out,error:null});
  }catch(error){const cancelled=error?.name==='AbortError'||store.getExport(exportId)?.cancel_requested;await rm(out,{force:true});store.updateExport(exportId,{status:cancelled?'cancelled':'failed',progress:cancelled?0:null,label:cancelled?'ยกเลิกแล้ว':'Render ไม่สำเร็จ',error:cancelled?null:String(error.message||error)})}
  finally{await rm(assPath,{force:true});activeExport=null;setImmediate(runExportQueue)}
}
app.post('/api/projects/:id/exports',(req,res)=>{const project=store.get(req.params.id);if(!project)return res.status(404).json({error:'ไม่พบโปรเจกต์'});const id=crypto.randomUUID(),createdAt=new Date().toISOString(),value=store.createExport({id,projectId:project.id,status:'queued',progress:0,label:'อยู่ในคิว Render',createdAt,options:{style:req.body.style||{}}});exportQueue.push(id);setImmediate(runExportQueue);res.status(202).json(publicExport(value))});
app.get('/api/exports/:id',(req,res)=>{const value=store.getExport(req.params.id);if(!value)return res.status(404).json({error:'ไม่พบงาน Render'});res.json(publicExport(value))});
app.delete('/api/exports/:id',async(req,res)=>{const value=store.getExport(req.params.id);if(!value)return res.status(404).json({error:'ไม่พบงาน Render'});store.updateExport(value.id,{cancel_requested:1,label:'กำลังยกเลิก'});const index=exportQueue.indexOf(value.id);if(index>=0){exportQueue.splice(index,1);store.updateExport(value.id,{status:'cancelled',progress:0,label:'ยกเลิกแล้ว'})}if(activeExport?.exportId===value.id)activeExport.controller.abort();if(value.result_path){await rm(value.result_path,{force:true});store.updateExport(value.id,{status:'cancelled',progress:0,label:'ลบไฟล์ Render แล้ว',result_path:null})}res.status(202).json({ok:true})});
app.get('/api/exports/:id/download',(req,res)=>{const value=store.getExport(req.params.id),project=value&&store.get(value.project_id);if(!value||!project)return res.status(404).json({error:'ไม่พบงาน Render'});if(value.status!=='complete'||!value.result_path)return res.status(409).json({error:'ไฟล์ยังไม่พร้อม'});res.download(value.result_path,`${path.parse(project.name).name}-captioned.mp4`)});

app.post('/api/projects/:id/export/:type',async(req,res)=>{
  const p=store.get(req.params.id);if(!p)return res.status(404).json({error:'ไม่พบโปรเจกต์'});
  try{
    if(req.params.type==='srt'){res.type('application/x-subrip').attachment(`${path.parse(p.name).name}.srt`).send('\uFEFF'+makeSrt(p.captions));return}
    const style={...p.style,...(req.body.style||{})}; store.updateStyle(p.id,style);
    const exportId=crypto.randomUUID(),assPath=path.join(outputDir,`${exportId}.ass`),out=path.join(outputDir,`${exportId}.mp4`);await writeFile(assPath,makeAss({captions:p.captions,style,width:p.width,height:p.height}),'utf8');
    const filterPath=assPath.replaceAll('\\','/').replace(':','\\:').replaceAll("'","\\'"),fontPath=fontsDir.replaceAll('\\','/').replace(':','\\:').replaceAll("'","\\'");await runProcess(ffmpegPath,['-y','-i',p.file_path,'-vf',`ass='${filterPath}':fontsdir='${fontPath}'`,'-c:v','libx264','-preset','fast','-crf','20','-c:a','aac','-b:a','192k','-movflags','+faststart',out]);
    res.download(out,`${path.parse(p.name).name}-captioned.mp4`,async()=>{await Promise.all([rm(out,{force:true}),rm(assPath,{force:true})])});
  }catch(error){res.status(500).json({error:error.message})}
});
app.get('/api/fonts',async(_,res)=>{const files=await readdir(fontsDir);res.json({fonts:files.filter(name=>/\.(ttf|otf)$/i.test(name)).map(file=>{const family=file.replace(/^[^-]+--/,'').replace(/\.(ttf|otf)$/i,'');return{family,file,url:`/media/fonts/${encodeURIComponent(file)}`}})})});
app.post('/api/fonts',fontUpload.single('font'),async(req,res)=>{if(!req.file)return res.status(400).json({error:'รองรับไฟล์ฟอนต์ .ttf หรือ .otf'});const ext=path.extname(req.file.originalname).toLowerCase(),family=path.basename(req.file.originalname,ext).replace(/[^\p{L}\p{N} _.-]/gu,'').trim().slice(0,80)||'Custom Font',file=`${crypto.randomUUID()}--${family}${ext}`;await rename(req.file.path,path.join(fontsDir,file));res.status(201).json({family,file,url:`/media/fonts/${encodeURIComponent(file)}`})});
app.get('/api/health',(_,res)=>res.json({ok:true,ffmpeg:Boolean(ffmpegPath),database:true,whisper:whisper.status()}));
app.use((error,_,res,next)=>{if(res.headersSent)return next(error);res.status(error.code==='LIMIT_FILE_SIZE'?413:400).json({error:error.code==='LIMIT_FILE_SIZE'?'ไฟล์ใหญ่เกิน 2GB':error.message})});
const port=Number(process.env.PORT)||4173,server=app.listen(port,'127.0.0.1',()=>console.log(`SubLabs Local: http://127.0.0.1:${server.address().port}`));
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,async()=>{server.close();await whisper.stop();process.exit(0)});

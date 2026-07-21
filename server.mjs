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
import { detectSilences, generateWaveformPeaks, probeAudioDuration, runProcess, probeMedia, speechRegionsFromSilences } from './lib/media.mjs';
import { WhisperService, extractSpeechRegions, extractTimedTokens } from './lib/whisper.mjs';
import { makeAss, makeSrt } from './lib/render.mjs';
import { findWeakSpeechRegions, hypothesesDisagree, markSpeechRegionForReview, replaceSpeechRegionWords, retryCandidateWins } from './lib/transcription-quality.mjs';
import { atempoChain, durationFitStatus, findDubOverlap, parsePronunciationRules, prepareTtsText, validateDubControls, validateDubExport, validateDubRange, validateDubText } from './lib/dub.mjs';
import { LocalTtsService } from './lib/tts.mjs';
import { cropFilter, cropGeometry, normalizeCropStyle } from './lib/crop.mjs';

const root=path.dirname(fileURLToPath(import.meta.url)),dataDir=process.env.SUBLABS_DATA_DIR?path.resolve(process.env.SUBLABS_DATA_DIR):path.join(root,'data'),uploadDir=path.join(dataDir,'uploads'),outputDir=path.join(dataDir,'outputs'),tempDir=path.join(dataDir,'temp'),fontsDir=path.join(dataDir,'fonts'),voiceDir=path.join(dataDir,'voices'),dubDir=path.join(dataDir,'dubs');
await Promise.all([uploadDir,outputDir,tempDir,fontsDir,voiceDir,dubDir,path.join(dataDir,'models')].map(dir=>mkdir(dir,{recursive:true})));
for(const directory of [outputDir,tempDir])for(const file of await readdir(directory)){const target=path.join(directory,file);try{if(Date.now()-(await stat(target)).mtimeMs>24*60*60*1000)await rm(target,{force:true})}catch{}}
const db=openDatabase(path.join(dataDir,'sublabs.db')),store=projectStore(db); store.recoverJobs();
const whisper=new WhisperService({root,models:{accurate:path.join(dataDir,'models','whisper-cpp','ggml-large-v3-turbo-q8_0.bin'),balanced:path.join(dataDir,'models','whisper-cpp','ggml-large-v3-turbo-q5_0.bin'),fast:path.join(dataDir,'models','whisper-cpp','ggml-large-v3-turbo-q5_0.bin')},vadModel:path.join(dataDir,'models','whisper-cpp','ggml-silero-v6.2.0.bin')});
const tts=new LocalTtsService({root,dataDir});
const app=express();
app.disable('x-powered-by');
app.use((_,res,next)=>{res.set({'X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','Content-Security-Policy':"default-src 'self'; img-src 'self' blob: data:; media-src 'self' blob:; style-src 'self' 'unsafe-inline'; script-src 'self'"});next()});
app.use(express.json({limit:'20mb'})); app.use(express.static(path.join(root,'public'))); app.get('/shared/captions.mjs',(_,res)=>res.type('text/javascript').sendFile(path.join(root,'lib','captions.mjs'))); app.use('/media',express.static(dataDir,{fallthrough:false}));
const upload=multer({dest:tempDir,limits:{fileSize:2*1024*1024*1024,files:20},fileFilter:(_,file,cb)=>cb(null,/^(video|audio)\//.test(file.mimetype))});
const fontUpload=multer({dest:tempDir,limits:{fileSize:20*1024*1024,files:1},fileFilter:(_,file,cb)=>cb(null,/\.(ttf|otf)$/i.test(file.originalname))});
const voiceUpload=multer({dest:tempDir,limits:{fileSize:30*1024*1024,files:1},fileFilter:(_,file,cb)=>cb(null,/^audio\//.test(file.mimetype)||/\.(wav|mp3|m4a|aac|ogg|flac)$/i.test(file.originalname))});

const repairFilename=value=>{const name=String(value||'');if(!/[à¸à¹Ã]/.test(name))return name;try{const repaired=Buffer.from(name,'latin1').toString('utf8');return repaired.includes('�')?name:repaired}catch{return name}};
const publicProject=p=>p&&({id:p.id,name:repairFilename(p.name),mediaUrl:p.media_url,width:p.width,height:p.height,duration:p.duration,hasAudio:Boolean(p.has_audio),captions:p.captions,style:p.style,language:p.language,wordsPerCaption:p.words_per_caption||5,speechRegions:p.speechRegions||[],dubPronunciations:p.dubPronunciations||[],schemaVersion:p.schema_version||1,createdAt:p.created_at,updatedAt:p.updated_at});
const publicProjectSummary=p=>p&&({id:p.id,name:repairFilename(p.name),width:p.width,height:p.height,duration:p.duration,captionCount:p.captions?.length||0,mediaUrl:p.media_url,createdAt:p.created_at,updatedAt:p.updated_at});
const publicJob=j=>j&&({id:j.id,projectId:j.project_id,status:j.status,step:j.step,progress:j.progress,label:j.label,error:j.status==='failed'?j.error:null,cancelRequested:Boolean(j.cancel_requested),createdAt:j.created_at,updatedAt:j.updated_at});
const publicExport=value=>value&&({id:value.id,projectId:value.project_id,status:value.status,progress:value.progress,label:value.label,error:value.status==='failed'?value.error:null,cancelRequested:Boolean(value.cancel_requested),downloadUrl:value.status==='complete'?`/api/exports/${value.id}/download`:null,createdAt:value.created_at,updatedAt:value.updated_at});
const publicStylePreset=value=>value&&({id:value.id,name:value.name,style:value.style,source:value.source,createdAt:value.created_at,updatedAt:value.updated_at});
const publicVoiceStyle=value=>value&&({id:value.id,voiceId:value.voice_id,emotion:value.emotion,referenceText:value.reference_text,previewUrl:value.preview_url,createdAt:value.created_at,updatedAt:value.updated_at});
const publicVoice=value=>value&&({id:value.id,name:value.name,source:value.source,license:value.license,styles:(value.styles||[]).map(publicVoiceStyle),createdAt:value.created_at,updatedAt:value.updated_at});
const publicDubTake=value=>value&&({id:value.id,takeIndex:value.take_index,audioUrl:value.audio_url,actualDuration:value.actual_duration,fitStatus:value.fit_status,status:value.status,error:value.error,selected:false});
const publicDubClip=value=>value&&({id:value.id,projectId:value.project_id,start:value.start_time,end:value.end_time,text:value.text,spokenText:value.spoken_text||value.text,voiceStyleId:value.voice_style_id,speed:value.speed||1,pauseBefore:value.pause_before||0,pauseAfter:value.pause_after||0,selectedTakeId:value.selected_take_id,audioUrl:value.audio_url,actualDuration:value.actual_duration,fitStatus:value.fit_status,status:value.status,error:value.error,takes:(value.takes||[]).map(take=>({...publicDubTake(take),selected:take.id===value.selected_take_id})),createdAt:value.created_at,updatedAt:value.updated_at});
const publicDubJob=value=>value&&({id:value.id,projectId:value.project_id,clipId:value.clip_id,status:value.status,progress:value.progress,label:value.label,error:value.status==='failed'?value.error:null,cancelRequested:Boolean(value.cancel_requested),result:JSON.parse(value.result_json||'{}'),createdAt:value.created_at,updatedAt:value.updated_at});
const publicDubExport=value=>value&&({...publicExport(value),downloadUrl:value.status==='complete'?`/api/dub-exports/${value.id}/download`:null});
async function ensureDisk(bytes){const s=await statfs(dataDir);if(s.bavail*s.bsize<Math.max(bytes*2,1024**3))throw new Error('พื้นที่ดิสก์เหลือน้อยเกินไปสำหรับประมวลผลไฟล์นี้')}

const even=value=>Math.max(2,Math.round(Number(value)||2)&~1);
async function mergeUploadedVideos(files,mediaItems,target){
  const width=even(mediaItems[0].width),height=even(mediaItems[0].height),parts=[];
  try{
    for(let index=0;index<files.length;index++){
      const part=path.join(tempDir,`${crypto.randomUUID()}.mp4`),media=mediaItems[index],audioInput=media.hasAudio?[]:['-f','lavfi','-t',String(media.duration),'-i','anullsrc=channel_layout=stereo:sample_rate=48000'],audioIndex=media.hasAudio?'0:a:0':'1:a:0';
      await runProcess(ffmpegPath,['-y','-i',files[index].path,...audioInput,'-map','0:v:0','-map',audioIndex,'-vf',`scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:black,setsar=1,fps=30,format=yuv420p`,'-c:v','libx264','-preset','fast','-crf','20','-c:a','aac','-b:a','192k','-ar','48000','-ac','2','-shortest','-movflags','+faststart',part]);
      parts.push(part);
    }
    const list=path.join(tempDir,`${crypto.randomUUID()}.txt`);
    await writeFile(list,parts.map(file=>`file '${file.replaceAll("'","'\\''")}'`).join('\n'));
    try{await runProcess(ffmpegPath,['-y','-f','concat','-safe','0','-i',list,'-c','copy','-movflags','+faststart',target])}
    finally{await rm(list,{force:true})}
  }finally{await Promise.all(parts.map(file=>rm(file,{force:true})))}
}

app.post('/api/projects',upload.fields([{name:'video',maxCount:1},{name:'videos',maxCount:20}]),async(req,res)=>{
  const files=[...(req.files?.videos||[]),...(req.files?.video||[])];
  if(!files.length)return res.status(400).json({error:'กรุณาเลือกไฟล์วิดีโอที่รองรับ'});
  try{
    const totalBytes=files.reduce((sum,file)=>sum+file.size,0);
    if(totalBytes>2*1024**3)throw new Error('ไฟล์รวมใหญ่เกิน 2GB');
    await ensureDisk(totalBytes);const mediaItems=await Promise.all(files.map(file=>probeMedia(ffprobeStatic.path,file.path)));
    if(mediaItems.reduce((sum,media)=>sum+media.duration,0)>4*3600)throw new Error('ความยาววิดีโอรวมสูงสุด 4 ชั่วโมง');
    const originalName=repairFilename(files[0].originalname),id=crypto.randomUUID(),ext=files.length===1?(path.extname(originalName)||'.mp4').toLowerCase():'.mp4',target=path.join(uploadDir,id+ext);
    if(files.length===1)await rename(files[0].path,target);else await mergeUploadedVideos(files,mediaItems,target);
    const media=files.length===1?mediaItems[0]:await probeMedia(ffprobeStatic.path,target),name=files.length===1?path.basename(originalName):`รวม ${files.length} คลิป · ${path.parse(originalName).name}`;
    const project=store.create({id,name,file:target,mediaUrl:`/media/uploads/${id}${ext}`,...media,createdAt:new Date().toISOString()});
    res.status(201).json(publicProject(project));
  }catch(error){res.status(415).json({error:error.message})}
  finally{await Promise.all(files.map(file=>rm(file.path,{force:true})))}
});
app.get('/api/projects/:id',(req,res)=>{const p=store.get(req.params.id);if(!p)return res.status(404).json({error:'ไม่พบโปรเจกต์'});res.json(publicProject(p))});
app.get('/api/projects',(_,res)=>res.json({projects:store.list().map(publicProjectSummary)}));
app.delete('/api/projects/:id',async(req,res)=>{const value=store.get(req.params.id);if(!value)return res.status(404).json({error:'ไม่พบโปรเจกต์'});for(const item of store.listExports(value.id))if(item.result_path)await rm(item.result_path,{force:true});for(const file of store.projectDubFiles(value.id))await rm(file,{force:true});store.delete(value.id);await rm(value.file_path,{force:true});res.json({ok:true})});
app.put('/api/projects/:id/captions',(req,res)=>{try{const p=store.get(req.params.id);if(!p)return res.status(404).json({error:'ไม่พบโปรเจกต์'});const captions=validateCaptions(req.body.captions);res.json(publicProject(store.updateCaptions(p.id,captions,req.body.language||p.language,req.body.wordsPerCaption)))}catch(e){res.status(400).json({error:e.message})}});
app.put('/api/projects/:id/style',(req,res)=>{const p=store.get(req.params.id);if(!p)return res.status(404).json({error:'ไม่พบโปรเจกต์'});res.json(publicProject(store.updateStyle(p.id,normalizeCropStyle(req.body.style||{}))))});
const stylePresetKeys=['effect','animation','animationDuration','animationIntensity','font','color','highlightColor','outlineColor','fontSizePct','bottomPct','spacing','scaleX','angle','outline','shadow','align','bold','italic','maxWidthPct','lineHeight','safeAreaPct','backgroundEnabled','backgroundColor'];
const stylePresetValues=style=>Object.fromEntries(stylePresetKeys.filter(key=>style&&style[key]!==undefined).map(key=>[key,style[key]]));
app.get('/api/style-presets',(_,res)=>res.json({presets:store.listStylePresets().map(publicStylePreset)}));
app.post('/api/style-presets',(req,res)=>{
  const name=String(req.body.name||'').replace(/\s+/g,' ').trim().slice(0,50),style=stylePresetValues(req.body.style);
  if(!name)return res.status(400).json({error:'กรุณาตั้งชื่อ Preset'});
  if(!Object.keys(style).length)return res.status(400).json({error:'ไม่พบค่าสไตล์สำหรับบันทึก'});
  try{const now=new Date().toISOString(),value=store.createStylePreset({id:crypto.randomUUID(),name,style,source:'user',createdAt:now});res.status(201).json(publicStylePreset(value))}
  catch(error){res.status(String(error.message).includes('UNIQUE')?409:400).json({error:String(error.message).includes('UNIQUE')?'มี Preset ชื่อนี้แล้ว':error.message})}
});
app.delete('/api/style-presets/:id',(req,res)=>{
  const value=store.getStylePreset(req.params.id);if(!value)return res.status(404).json({error:'ไม่พบ Preset'});
  if(value.source!=='user')return res.status(403).json({error:'Preset หลักของระบบลบไม่ได้'});
  store.deleteStylePreset(value.id);res.json({ok:true});
});
app.put('/api/projects/:id/dub-settings',(req,res)=>{const p=store.get(req.params.id);if(!p)return res.status(404).json({error:'ไม่พบโปรเจกต์'});const pronunciations=parsePronunciationRules(req.body.pronunciations||[]);res.json(publicProject(store.updateDubSettings(p.id,{pronunciations})))});
app.post('/api/projects/:id/dub-pronunciation-preview',(req,res)=>{try{const p=store.get(req.params.id);if(!p)return res.status(404).json({error:'ไม่พบโปรเจกต์'});res.json({spokenText:prepareTtsText(req.body.text,p.dubPronunciations||[])})}catch(error){res.status(400).json({error:error.message})}});
app.get('/api/projects/:id/waveform',async(req,res)=>{const p=store.get(req.params.id);if(!p)return res.status(404).json({error:'ไม่พบโปรเจกต์'});try{let waveform=p.waveform;if(!waveform?.peaks?.length){waveform=await generateWaveformPeaks(ffmpegPath,p.file_path,{buckets:2400});store.updateAnalysis(p.id,{waveform})}res.json({...waveform,duration:p.duration,speechRegions:p.speechRegions||[]})}catch(error){res.status(500).json({error:error.message})}});

app.get('/api/voices',(_,res)=>res.json({voices:store.listVoices().map(publicVoice)}));
async function normalizeVoiceReference(source,target){
  await runProcess(ffmpegPath,['-y','-i',source,'-vn','-ac','1','-ar','24000','-af','highpass=f=60,lowpass=f=11500,loudnorm=I=-18:TP=-2:LRA=7','-c:a','pcm_s16le',target]);
  const duration=await probeAudioDuration(ffprobeStatic.path,target);
  if(duration<5||duration>10)throw new Error('เสียงอ้างอิงต้องยาว 5–10 วินาที');
  return duration;
}
app.post('/api/voices',voiceUpload.single('reference'),async(req,res)=>{
  if(!req.file)return res.status(400).json({error:'กรุณาเลือกไฟล์เสียงอ้างอิง'});
  const name=String(req.body.name||'').trim().slice(0,80),emotion=String(req.body.emotion||'ปกติ').trim().slice(0,40),referenceText=String(req.body.referenceText||'').replace(/\s+/g,' ').trim().slice(0,1000);
  if(!name||!emotion||!referenceText){await rm(req.file.path,{force:true});return res.status(400).json({error:'กรุณาใส่ชื่อเสียง อารมณ์ และข้อความต้นฉบับให้ครบ'})}
  const voiceId=crypto.randomUUID(),styleId=crypto.randomUUID(),target=path.join(voiceDir,`${styleId}.wav`),now=new Date().toISOString();
  try{
    await normalizeVoiceReference(req.file.path,target);
    store.createVoice({id:voiceId,name,source:'user',license:'user-provided',createdAt:now});
    store.createVoiceStyle({id:styleId,voiceId,emotion,referenceText,referencePath:target,previewUrl:`/media/voices/${styleId}.wav`,createdAt:now});
    res.status(201).json(publicVoice(store.getVoice(voiceId)));
  }catch(error){store.deleteVoice(voiceId);await rm(target,{force:true});res.status(400).json({error:error.message})}
  finally{await rm(req.file.path,{force:true})}
});
app.post('/api/voices/:id/styles',voiceUpload.single('reference'),async(req,res)=>{
  const voice=store.getVoice(req.params.id);if(!voice){if(req.file)await rm(req.file.path,{force:true});return res.status(404).json({error:'ไม่พบเสียงนี้'})}
  if(!req.file)return res.status(400).json({error:'กรุณาเลือกไฟล์เสียงอ้างอิง'});
  const emotion=String(req.body.emotion||'').trim().slice(0,40),referenceText=String(req.body.referenceText||'').replace(/\s+/g,' ').trim().slice(0,1000);
  if(!emotion||!referenceText){await rm(req.file.path,{force:true});return res.status(400).json({error:'กรุณาใส่อารมณ์และข้อความต้นฉบับ'})}
  if(voice.styles.some(style=>style.emotion.toLowerCase()===emotion.toLowerCase())){await rm(req.file.path,{force:true});return res.status(409).json({error:'เสียงนี้มีอารมณ์ชื่อนี้แล้ว'})}
  const styleId=crypto.randomUUID(),target=path.join(voiceDir,`${styleId}.wav`),now=new Date().toISOString();
  try{await normalizeVoiceReference(req.file.path,target);store.createVoiceStyle({id:styleId,voiceId:voice.id,emotion,referenceText,referencePath:target,previewUrl:`/media/voices/${styleId}.wav`,createdAt:now});res.status(201).json(publicVoice(store.getVoice(voice.id)))}
  catch(error){await rm(target,{force:true});res.status(400).json({error:error.message})}
  finally{await rm(req.file.path,{force:true})}
});
app.delete('/api/voice-styles/:id',async(req,res)=>{const style=store.getVoiceStyle(req.params.id);if(!style)return res.status(404).json({error:'ไม่พบอารมณ์เสียง'});if(store.voiceUsage(style.id))return res.status(409).json({error:'อารมณ์เสียงนี้กำลังถูกใช้ในโปรเจกต์'});store.deleteVoiceStyle(style.id);await rm(style.reference_path,{force:true});res.json({ok:true})});
app.delete('/api/voices/:id',async(req,res)=>{const voice=store.getVoice(req.params.id);if(!voice)return res.status(404).json({error:'ไม่พบเสียงนี้'});if(voice.styles.some(style=>store.voiceUsage(style.id)))return res.status(409).json({error:'เสียงนี้กำลังถูกใช้ในโปรเจกต์'});store.deleteVoice(voice.id);for(const style of voice.styles)await rm(style.reference_path,{force:true});res.json({ok:true})});

const queue=[],dubQueue=[]; let active=null,activeDub=null,modelTask=null;
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
  if(active||modelTask||!queue.length)return;const jobId=queue.shift(),job=store.getJob(jobId);if(!job||job.cancel_requested)return runQueue();
  modelTask='whisper';
  const project=store.get(job.project_id),options=JSON.parse(job.options_json||'{}'),requestedRange=options.range||null,expandedRange=expandTranscriptionRange(requestedRange,project.speechRegions,project.duration),clipDuration=expandedRange.end-expandedRange.start,wav=path.join(tempDir,`${jobId}.wav`),controller=new AbortController();active={jobId,controller};
  try{
    await tts.stop();
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
  finally{await rm(wav,{force:true});active=null;modelTask=null;setImmediate(runQueue);setImmediate(runDubQueue)}
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

function createDubJob(clip){
  const id=crypto.randomUUID(),createdAt=new Date().toISOString(),job=store.createDubJob({id,projectId:clip.project_id,clipId:clip.id,status:'queued',progress:0,label:'อยู่ในคิวสร้างเสียง',createdAt});
  dubQueue.push(id);setImmediate(runDubQueue);return job;
}
async function removeClipAudio(clip){
  const files=new Set([clip?.audio_path,...(clip?.takes||[]).map(take=>take.audio_path)].filter(Boolean));
  for(const file of files)await rm(file,{force:true});
  if(clip?.id)store.deleteDubTakes(clip.id);
}
async function runDubQueue(){
  if(activeDub||modelTask||!dubQueue.length)return;
  const jobId=dubQueue.shift(),job=store.getDubJob(jobId);if(!job||job.cancel_requested)return runDubQueue();
  const clip=store.getDubClip(job.clip_id),style=clip&&store.getVoiceStyle(clip.voice_style_id),project=clip&&store.get(clip.project_id);
  if(!clip||!style||!project){store.updateDubJob(jobId,{status:'failed',label:'สร้างเสียงไม่สำเร็จ',error:'ข้อมูลเสียงพากย์ไม่ครบ'});return setImmediate(runDubQueue)}
  modelTask='tts';activeDub={jobId};const createdFiles=[];
  try{
    await whisper.stop();
    store.updateDubClip(clip.id,{status:'generating',fitStatus:'pending',error:null});
    store.updateDubJob(jobId,{status:'running',progress:5,label:'กำลังโหลดโมเดลเสียงไทย'});
    const slot=clip.end_time-clip.start_time,speechSlot=slot-clip.pause_before-clip.pause_after,takes=[];
    for(let index=1;index<=3;index++){
      if(store.getDubJob(jobId)?.cancel_requested)throw new DOMException('ยกเลิกแล้ว','AbortError');
      const takeId=crypto.randomUUID(),seed=crypto.randomInt(1,2_147_483_647),raw=path.join(tempDir,`${jobId}-take-${index}-raw.wav`),out=path.join(dubDir,`${clip.id}-take-${index}.wav`),createdAt=new Date().toISOString();
      store.createDubTake({id:takeId,clipId:clip.id,takeIndex:index,status:'generating',seed,createdAt});
      try{
        store.updateDubJob(jobId,{progress:8+(index-1)*29,label:`กำลังสร้าง Take ${index} / 3`});
        await tts.synthesize({text:clip.spoken_text||clip.text,referencePath:style.reference_path,referenceText:style.reference_text,outputPath:raw,speed:clip.speed||1,seed});
        const rawDuration=await probeAudioDuration(ffprobeStatic.path,raw),fit=durationFitStatus(rawDuration,speechSlot),filters=[];
        if(fit.status==='stretch')filters.push(atempoChain(fit.rate));
        filters.push('highpass=f=65','lowpass=f=11500','loudnorm=I=-16:TP=-1.5:LRA=7');
        if(clip.pause_before>0)filters.push(`adelay=${Math.round(clip.pause_before*1000)}:all=1`);
        if(clip.pause_after>0)filters.push(`apad=pad_dur=${Number(clip.pause_after).toFixed(3)}`);
        await runProcess(ffmpegPath,['-y','-i',raw,'-vn','-ac','2','-ar','48000','-af',filters.join(','),'-c:a','pcm_s16le',out]);
        createdFiles.push(out);const actualDuration=await probeAudioDuration(ffprobeStatic.path,out),finalFit=fit.status==='needs_edit'||durationFitStatus(actualDuration,slot).status==='needs_edit'?'needs_edit':'fit';
        takes.push(store.updateDubTake(takeId,{audioPath:out,audioUrl:`/media/dubs/${path.basename(out)}`,actualDuration,fitStatus:finalFit,status:'ready',error:null}));
      }finally{await rm(raw,{force:true})}
    }
    const selected=takes.find(take=>take.fit_status==='fit')||takes[0],updated=store.updateDubClip(clip.id,{selectedTakeId:selected.id,audioPath:selected.audio_path,audioUrl:selected.audio_url,actualDuration:selected.actual_duration,fitStatus:selected.fit_status,status:'ready',error:null});
    store.updateDubJob(jobId,{status:'complete',progress:100,label:selected.fit_status==='needs_edit'?'สร้าง 3 Take แล้ว · ต้องแก้เวลา':'สร้าง 3 Take พร้อมเลือก',error:null,result_json:{mode:tts.mode,fitStatus:selected.fit_status,actualDuration:selected.actual_duration,takeCount:takes.length}});
    return updated;
  }catch(error){
    const cancelled=error?.name==='AbortError'||store.getDubJob(jobId)?.cancel_requested;
    for(const file of createdFiles)await rm(file,{force:true});store.deleteDubTakes(clip.id);store.updateDubClip(clip.id,{selectedTakeId:null,audioPath:null,audioUrl:null,actualDuration:null,status:cancelled?'cancelled':'failed',fitStatus:'failed',error:cancelled?null:String(error.message||error)});
    store.updateDubJob(jobId,{status:cancelled?'cancelled':'failed',progress:cancelled?0:null,label:cancelled?'ยกเลิกแล้ว':'สร้างเสียงไม่สำเร็จ',error:cancelled?null:String(error.message||error)});
  }finally{activeDub=null;modelTask=null;setImmediate(runDubQueue);setImmediate(runQueue)}
}

app.get('/api/projects/:id/dubs',(req,res)=>{const project=store.get(req.params.id);if(!project)return res.status(404).json({error:'ไม่พบโปรเจกต์'});res.json({clips:store.listDubClips(project.id).map(publicDubClip)})});
app.post('/api/projects/:id/dub-clips',(req,res)=>{
  try{
    const project=store.get(req.params.id);if(!project)return res.status(404).json({error:'ไม่พบโปรเจกต์'});
    const range=validateDubRange(project,req.body.start,req.body.end),text=validateDubText(req.body.text),style=store.getVoiceStyle(String(req.body.voiceStyleId||'')),controls=validateDubControls({...req.body,slotDuration:range.end-range.start}),spokenText=prepareTtsText(text,project.dubPronunciations||[]);
    if(!style)return res.status(400).json({error:'กรุณาเลือกเสียงและอารมณ์'});
    const overlap=findDubOverlap(store.listDubClips(project.id),range);if(overlap)return res.status(409).json({error:`ช่วงนี้ซ้อนกับเสียงพากย์ที่ ${Number(overlap.start_time).toFixed(2)}s`});
    const createdAt=new Date().toISOString(),clip=store.createDubClip({id:crypto.randomUUID(),projectId:project.id,start:range.start,end:range.end,text,spokenText,voiceStyleId:style.id,...controls,status:'queued',createdAt}),job=createDubJob(clip);
    res.status(202).json({clip:publicDubClip(clip),job:publicDubJob(job)});
  }catch(error){res.status(400).json({error:error.message})}
});
app.put('/api/dub-clips/:id',async(req,res)=>{
  try{
    const clip=store.getDubClip(req.params.id);if(!clip)return res.status(404).json({error:'ไม่พบเสียงพากย์'});
    const project=store.get(clip.project_id),range=validateDubRange(project,req.body.start??clip.start_time,req.body.end??clip.end_time),text=req.body.text==null?clip.text:validateDubText(req.body.text),styleId=String(req.body.voiceStyleId||clip.voice_style_id),controls=validateDubControls({speed:req.body.speed??clip.speed,pauseBefore:req.body.pauseBefore??clip.pause_before,pauseAfter:req.body.pauseAfter??clip.pause_after,slotDuration:range.end-range.start}),spokenText=prepareTtsText(text,project.dubPronunciations||[]);
    if(!store.getVoiceStyle(styleId))return res.status(400).json({error:'ไม่พบเสียงที่เลือก'});
    const overlap=findDubOverlap(store.listDubClips(project.id),range,clip.id);if(overlap)return res.status(409).json({error:`ช่วงนี้ซ้อนกับเสียงพากย์ที่ ${Number(overlap.start_time).toFixed(2)}s`});
    const regenerate=text!==clip.text||spokenText!==(clip.spoken_text||clip.text)||styleId!==clip.voice_style_id||controls.speed!==clip.speed||controls.pauseBefore!==clip.pause_before||controls.pauseAfter!==clip.pause_after;
    let fitStatus=clip.fit_status;if(!regenerate&&clip.actual_duration)fitStatus=durationFitStatus(clip.actual_duration,range.end-range.start).status==='needs_edit'?'needs_edit':'fit';
    if(regenerate){await removeClipAudio(clip);fitStatus='pending'}
    const updated=store.updateDubClip(clip.id,{start:range.start,end:range.end,text,spokenText,voiceStyleId:styleId,...controls,selectedTakeId:regenerate?null:clip.selected_take_id,fitStatus,status:regenerate?'queued':clip.status,audioPath:regenerate?null:clip.audio_path,audioUrl:regenerate?null:clip.audio_url,actualDuration:regenerate?null:clip.actual_duration,error:null});
    if(regenerate){const job=createDubJob(updated);return res.status(202).json({clip:publicDubClip(updated),job:publicDubJob(job)})}
    res.json({clip:publicDubClip(updated)});
  }catch(error){res.status(400).json({error:error.message})}
});
app.put('/api/dub-clips/:id/take',(req,res)=>{
  const clip=store.getDubClip(req.params.id);if(!clip)return res.status(404).json({error:'ไม่พบเสียงพากย์'});
  const take=store.getDubTake(String(req.body.takeId||''));if(!take||take.clip_id!==clip.id)return res.status(400).json({error:'ไม่พบ Take ที่เลือก'});
  if(take.status!=='ready'||!take.audio_path)return res.status(409).json({error:'Take นี้ยังไม่พร้อม'});
  const updated=store.updateDubClip(clip.id,{selectedTakeId:take.id,audioPath:take.audio_path,audioUrl:take.audio_url,actualDuration:take.actual_duration,fitStatus:take.fit_status,status:'ready',error:null});
  res.json({clip:publicDubClip(updated)});
});
app.delete('/api/dub-clips/:id',async(req,res)=>{const clip=store.getDubClip(req.params.id);if(!clip)return res.status(404).json({error:'ไม่พบเสียงพากย์'});if(activeDub&&store.getDubJob(activeDub.jobId)?.clip_id===clip.id)await tts.stop();const queued=dubQueue.filter(id=>store.getDubJob(id)?.clip_id===clip.id);for(const id of queued){const index=dubQueue.indexOf(id);if(index>=0)dubQueue.splice(index,1)}store.deleteDubClip(clip.id);await removeClipAudio(clip);res.json({ok:true})});
app.get('/api/dub-jobs/:id',(req,res)=>{const job=store.getDubJob(req.params.id);if(!job)return res.status(404).json({error:'ไม่พบงานสร้างเสียง'});const output=publicDubJob(job);if(job.status==='complete')output.clip=publicDubClip(store.getDubClip(job.clip_id));if(job.status==='queued')output.queuePosition=dubQueue.indexOf(job.id)+1;res.json(output)});
app.delete('/api/dub-jobs/:id',async(req,res)=>{const job=store.getDubJob(req.params.id);if(!job)return res.status(404).json({error:'ไม่พบงานสร้างเสียง'});store.updateDubJob(job.id,{cancel_requested:1,label:'กำลังยกเลิก'});const index=dubQueue.indexOf(job.id);if(index>=0){dubQueue.splice(index,1);store.updateDubJob(job.id,{status:'cancelled',progress:0,label:'ยกเลิกแล้ว'});store.updateDubClip(job.clip_id,{status:'cancelled',fitStatus:'failed'})}if(activeDub?.jobId===job.id)await tts.stop();res.status(202).json({ok:true})});
app.get('/api/tts/status',async(_,res)=>res.json({...tts.status(),installed:await tts.installed(),setupCommand:'powershell -ExecutionPolicy Bypass -File scripts\\setup-tts.ps1'}));

const exportQueue=[];let activeExport=null;
async function runExportQueue(){
  if(activeExport||!exportQueue.length)return;
  const exportId=exportQueue.shift(),item=store.getExport(exportId);if(!item||item.cancel_requested)return runExportQueue();
  const project=store.get(item.project_id),options=JSON.parse(item.options_json||'{}'),assPath=path.join(tempDir,`${exportId}.ass`),out=path.join(outputDir,`${exportId}.mp4`),controller=new AbortController();activeExport={exportId,controller};
  try{
    store.updateExport(exportId,{status:'running',progress:2,label:'กำลังเตรียมคำบรรยาย'});
    const style=normalizeCropStyle({...project.style,...(options.style||{})}),geometry=cropGeometry(project.width,project.height,style);store.updateStyle(project.id,style);await writeFile(assPath,makeAss({captions:project.captions,style,width:geometry.width,height:geometry.height}),'utf8');
    const filterPath=assPath.replaceAll('\\','/').replace(':','\\:').replaceAll("'","\\'"),fontPath=fontsDir.replaceAll('\\','/').replace(':','\\:').replaceAll("'","\\'"),videoFilter=[cropFilter(geometry),`ass='${filterPath}':fontsdir='${fontPath}'`].filter(Boolean).join(',');let buffer='',lastProgress=0;
    await runProcess(ffmpegPath,['-y','-i',project.file_path,'-vf',videoFilter,'-c:v','libx264','-preset','fast','-crf','20','-c:a','aac','-b:a','192k','-movflags','+faststart','-progress','pipe:2','-nostats',out],{signal:controller.signal,onStderr:value=>{
      buffer=(buffer+value).slice(-5000);const matches=[...buffer.matchAll(/out_time_(?:ms|us)=(\d+)/g)],raw=Number(matches.at(-1)?.[1]);if(!Number.isFinite(raw))return;const progress=Math.max(4,Math.min(99,Math.round(raw/1e6/project.duration*100)));if(progress>=lastProgress+2){lastProgress=progress;store.updateExport(exportId,{progress,label:`กำลัง Render ${progress}%`})}
    }});
    store.updateExport(exportId,{status:'complete',progress:100,label:'Render เสร็จแล้ว',result_path:out,error:null});
  }catch(error){const cancelled=error?.name==='AbortError'||store.getExport(exportId)?.cancel_requested;await rm(out,{force:true});store.updateExport(exportId,{status:cancelled?'cancelled':'failed',progress:cancelled?0:null,label:cancelled?'ยกเลิกแล้ว':'Render ไม่สำเร็จ',error:cancelled?null:String(error.message||error)})}
  finally{await rm(assPath,{force:true});activeExport=null;setImmediate(runExportQueue)}
}
app.post('/api/projects/:id/exports',(req,res)=>{const project=store.get(req.params.id);if(!project)return res.status(404).json({error:'ไม่พบโปรเจกต์'});const id=crypto.randomUUID(),createdAt=new Date().toISOString(),value=store.createExport({id,projectId:project.id,status:'queued',progress:0,label:'อยู่ในคิว Render',createdAt,options:{style:req.body.style||{}}});exportQueue.push(id);setImmediate(runExportQueue);res.status(202).json(publicExport(value))});
app.get('/api/exports/:id',(req,res)=>{const value=store.getExport(req.params.id);if(!value)return res.status(404).json({error:'ไม่พบงาน Render'});res.json(publicExport(value))});
app.delete('/api/exports/:id',async(req,res)=>{const value=store.getExport(req.params.id);if(!value)return res.status(404).json({error:'ไม่พบงาน Render'});store.updateExport(value.id,{cancel_requested:1,label:'กำลังยกเลิก'});const index=exportQueue.indexOf(value.id);if(index>=0){exportQueue.splice(index,1);store.updateExport(value.id,{status:'cancelled',progress:0,label:'ยกเลิกแล้ว'})}if(activeExport?.exportId===value.id)activeExport.controller.abort();if(value.result_path){await rm(value.result_path,{force:true});store.updateExport(value.id,{status:'cancelled',progress:0,label:'ลบไฟล์ Render แล้ว',result_path:null})}res.status(202).json({ok:true})});
app.get('/api/exports/:id/download',(req,res)=>{const value=store.getExport(req.params.id),project=value&&store.get(value.project_id);if(!value||!project)return res.status(404).json({error:'ไม่พบงาน Render'});if(value.status!=='complete'||!value.result_path)return res.status(409).json({error:'ไฟล์ยังไม่พร้อม'});res.download(path.basename(value.result_path),`${path.parse(project.name).name}-captioned.mp4`,{root:path.dirname(value.result_path)})});

const dubExportQueue=[];let activeDubExport=null;
function dubMixArguments(project,clips){
  const args=['-y','-i',project.file_path];for(const clip of clips)args.push('-i',clip.audio_path);
  const duration=Number(project.duration).toFixed(4),filters=[],labels=[];
  clips.forEach((clip,index)=>{const label=`dub${index}`,delay=Math.max(0,Math.round(clip.start_time*1000));filters.push(`[${index+1}:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,adelay=${delay}:all=1,apad=whole_dur=${duration},atrim=duration=${duration}[${label}]`);labels.push(`[${label}]`)});
  filters.push(`${labels.join('')}amix=inputs=${labels.length}:normalize=0:dropout_transition=0,alimiter=limit=0.92[dubmix]`);
  if(project.has_audio){
    filters.push(`[dubmix]asplit=2[dubkey][dubout]`);
    filters.push(`[0:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo[original]`);
    filters.push(`[original][dubkey]sidechaincompress=threshold=0.015:ratio=8:attack=80:release=180[ducked]`);
    filters.push(`[ducked][dubout]amix=inputs=2:normalize=0:duration=first,alimiter=limit=0.95[outa]`);
  }else filters.push(`[dubmix]alimiter=limit=0.95[outa]`);
  return[...args,'-filter_complex',filters.join(';'),'-map','0:v:0','-map','[outa]','-c:v','libx264','-preset','fast','-crf','20','-c:a','aac','-b:a','192k','-t',duration,'-movflags','+faststart'];
}
async function runDubExportQueue(){
  if(activeDubExport||!dubExportQueue.length)return;
  const exportId=dubExportQueue.shift(),item=store.getExport(exportId);if(!item||item.cancel_requested)return runDubExportQueue();
  const project=store.get(item.project_id),out=path.join(outputDir,`${exportId}-dubbed.mp4`),controller=new AbortController();activeDubExport={exportId,controller};
  try{
    const clips=validateDubExport(store.listDubClips(project.id));store.updateExport(exportId,{status:'running',progress:3,label:'กำลังเตรียมเสียงพากย์'});
    let buffer='',lastProgress=0,args=dubMixArguments(project,clips);args.push('-progress','pipe:2','-nostats',out);
    await runProcess(ffmpegPath,args,{signal:controller.signal,onStderr:value=>{
      buffer=(buffer+value).slice(-5000);const matches=[...buffer.matchAll(/out_time_(?:ms|us)=(\d+)/g)],raw=Number(matches.at(-1)?.[1]);if(!Number.isFinite(raw))return;const progress=Math.max(4,Math.min(99,Math.round(raw/1e6/project.duration*100)));if(progress>=lastProgress+2){lastProgress=progress;store.updateExport(exportId,{progress,label:`กำลังมิกซ์เสียง ${progress}%`})}
    }});
    store.updateExport(exportId,{status:'complete',progress:100,label:'วิดีโอพากย์พร้อมแล้ว',result_path:out,error:null});
  }catch(error){const cancelled=error?.name==='AbortError'||store.getExport(exportId)?.cancel_requested;await rm(out,{force:true});store.updateExport(exportId,{status:cancelled?'cancelled':'failed',progress:cancelled?0:null,label:cancelled?'ยกเลิกแล้ว':'มิกซ์เสียงไม่สำเร็จ',error:cancelled?null:String(error.message||error)})}
  finally{activeDubExport=null;setImmediate(runDubExportQueue)}
}
app.post('/api/projects/:id/dub-exports',(req,res)=>{
  try{
    const project=store.get(req.params.id);if(!project)return res.status(404).json({error:'ไม่พบโปรเจกต์'});
    validateDubExport(store.listDubClips(project.id));
    const id=crypto.randomUUID(),createdAt=new Date().toISOString(),value=store.createExport({id,projectId:project.id,status:'queued',progress:0,label:'อยู่ในคิวมิกซ์เสียง',createdAt,options:{kind:'dub',duckDb:-12,attackMs:80,releaseMs:180}});
    dubExportQueue.push(id);setImmediate(runDubExportQueue);res.status(202).json(publicDubExport(value));
  }catch(error){res.status(409).json({error:error.message})}
});
app.get('/api/dub-exports/:id',(req,res)=>{const value=store.getExport(req.params.id);if(!value)return res.status(404).json({error:'ไม่พบงานมิกซ์เสียง'});res.json(publicDubExport(value))});
app.delete('/api/dub-exports/:id',async(req,res)=>{const value=store.getExport(req.params.id);if(!value)return res.status(404).json({error:'ไม่พบงานมิกซ์เสียง'});store.updateExport(value.id,{cancel_requested:1,label:'กำลังยกเลิก'});const index=dubExportQueue.indexOf(value.id);if(index>=0){dubExportQueue.splice(index,1);store.updateExport(value.id,{status:'cancelled',progress:0,label:'ยกเลิกแล้ว'})}if(activeDubExport?.exportId===value.id)activeDubExport.controller.abort();if(value.result_path){await rm(value.result_path,{force:true});store.updateExport(value.id,{status:'cancelled',progress:0,label:'ลบไฟล์แล้ว',result_path:null})}res.status(202).json({ok:true})});
app.get('/api/dub-exports/:id/download',(req,res)=>{const value=store.getExport(req.params.id),project=value&&store.get(value.project_id);if(!value||!project)return res.status(404).json({error:'ไม่พบงานมิกซ์เสียง'});if(value.status!=='complete'||!value.result_path)return res.status(409).json({error:'ไฟล์ยังไม่พร้อม'});res.download(path.basename(value.result_path),`${path.parse(project.name).name}-dubbed.mp4`,{root:path.dirname(value.result_path)})});

app.post('/api/projects/:id/export/:type',async(req,res)=>{
  const p=store.get(req.params.id);if(!p)return res.status(404).json({error:'ไม่พบโปรเจกต์'});
  try{
    if(req.params.type==='srt'){res.type('application/x-subrip').attachment(`${path.parse(p.name).name}.srt`).send('\uFEFF'+makeSrt(p.captions));return}
    const style=normalizeCropStyle({...p.style,...(req.body.style||{})}),geometry=cropGeometry(p.width,p.height,style); store.updateStyle(p.id,style);
    const exportId=crypto.randomUUID(),assPath=path.join(outputDir,`${exportId}.ass`),out=path.join(outputDir,`${exportId}.mp4`);await writeFile(assPath,makeAss({captions:p.captions,style,width:geometry.width,height:geometry.height}),'utf8');
    const filterPath=assPath.replaceAll('\\','/').replace(':','\\:').replaceAll("'","\\'"),fontPath=fontsDir.replaceAll('\\','/').replace(':','\\:').replaceAll("'","\\'"),videoFilter=[cropFilter(geometry),`ass='${filterPath}':fontsdir='${fontPath}'`].filter(Boolean).join(',');await runProcess(ffmpegPath,['-y','-i',p.file_path,'-vf',videoFilter,'-c:v','libx264','-preset','fast','-crf','20','-c:a','aac','-b:a','192k','-movflags','+faststart',out]);
    res.download(out,`${path.parse(p.name).name}-captioned.mp4`,async()=>{await Promise.all([rm(out,{force:true}),rm(assPath,{force:true})])});
  }catch(error){res.status(500).json({error:error.message})}
});
app.get('/api/fonts',async(_,res)=>{const files=await readdir(fontsDir);res.json({fonts:files.filter(name=>/\.(ttf|otf)$/i.test(name)).map(file=>{const family=file.replace(/^[^-]+--/,'').replace(/\.(ttf|otf)$/i,'');return{family,file,url:`/media/fonts/${encodeURIComponent(file)}`}})})});
app.post('/api/fonts',fontUpload.single('font'),async(req,res)=>{if(!req.file)return res.status(400).json({error:'รองรับไฟล์ฟอนต์ .ttf หรือ .otf'});const ext=path.extname(req.file.originalname).toLowerCase(),family=path.basename(req.file.originalname,ext).replace(/[^\p{L}\p{N} _.-]/gu,'').trim().slice(0,80)||'Custom Font',file=`${crypto.randomUUID()}--${family}${ext}`;await rename(req.file.path,path.join(fontsDir,file));res.status(201).json({family,file,url:`/media/fonts/${encodeURIComponent(file)}`})});
app.get('/api/health',async(_,res)=>res.json({ok:true,ffmpeg:Boolean(ffmpegPath),database:true,whisper:whisper.status(),tts:{...tts.status(),installed:await tts.installed()}}));
app.use((error,_,res,next)=>{if(res.headersSent)return next(error);res.status(error.code==='LIMIT_FILE_SIZE'?413:400).json({error:error.code==='LIMIT_FILE_SIZE'?'ไฟล์ใหญ่เกิน 2GB':error.message})});
const port=Number(process.env.PORT)||4173,server=app.listen(port,'127.0.0.1',()=>console.log(`SubLabs Local: http://127.0.0.1:${server.address().port}`));
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,async()=>{server.close();await Promise.all([whisper.stop(),tts.stop()]);process.exit(0)});

import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {fileURLToPath} from 'node:url';
import ffmpeg from 'ffmpeg-static';
import {openDatabase,projectStore} from '../lib/db.mjs';

const root=path.dirname(path.dirname(fileURLToPath(import.meta.url))),dataDir=await mkdtemp(path.join(tmpdir(),'sublabs-api-')),sample=path.join(dataDir,'sample.mp4'),wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const run=(binary,args)=>new Promise((resolve,reject)=>{const child=spawn(binary,args,{windowsHide:true});let stderr='';child.stderr.on('data',data=>stderr+=String(data));child.on('error',reject);child.on('close',code=>code===0?resolve():reject(new Error(stderr)))});
const port=await new Promise((resolve,reject)=>{const server=net.createServer();server.on('error',reject);server.listen(0,'127.0.0.1',()=>{const value=server.address().port;server.close(()=>resolve(value))})}),base=`http://127.0.0.1:${port}`;
await run(ffmpeg,['-y','-loglevel','error','-f','lavfi','-i','color=c=black:s=320x240:d=1','-f','lavfi','-i','sine=frequency=440:duration=1','-shortest','-c:v','libx264','-pix_fmt','yuv420p','-c:a','aac',sample]);
const child=spawn(process.execPath,['server.mjs'],{cwd:root,windowsHide:true,env:{...process.env,PORT:String(port),SUBLABS_DATA_DIR:dataDir}});let logs='';child.stderr.on('data',data=>logs+=String(data));
const request=async(url,options={})=>{const response=await fetch(base+url,options);const data=await response.json();if(!response.ok)throw new Error(data.error||`HTTP ${response.status}`);return data};
try{
  for(let index=0;index<80;index++){try{if((await request('/api/health')).ok)break}catch{}if(index===79)throw new Error(`server did not start: ${logs}`);await wait(100)}
  const form=new FormData();form.append('video',new Blob([await readFile(sample)],{type:'video/mp4'}),'sample.mp4');const project=await request('/api/projects',{method:'POST',body:form});assert.equal(project.width,320);assert.equal(project.schemaVersion,3);
  const list=await request('/api/projects');assert.equal(list.projects.length,1);const waveform=await request(`/api/projects/${project.id}/waveform`);assert.equal(waveform.peaks.length,2400);
  const captions=[{id:'c',start:0,end:.8,text:'one old three',words:[{id:'a',text:'one',start:0,end:.2,rawConfidence:null,reviewScore:null,needsReview:false,reviewStatus:'approved',timingSource:'whisper',spaceBefore:false},{id:'b',text:'old',start:.2,end:.4,rawConfidence:.4,reviewScore:.4,needsReview:true,reviewStatus:'pending',timingSource:'whisper',spaceBefore:true},{id:'c',text:'three',start:.4,end:.8,rawConfidence:null,reviewScore:null,needsReview:false,reviewStatus:'approved',timingSource:'whisper',spaceBefore:true}]}];await request(`/api/projects/${project.id}/captions`,{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({captions,language:'en'})});
  const directDb=openDatabase(path.join(dataDir,'sublabs.db')),directStore=projectStore(directDb),partialNow=new Date().toISOString();directStore.createJob({id:'partial',projectId:project.id,status:'complete',step:5,progress:100,label:'ready',createdAt:partialNow,options:{range:{start:.2,end:.4},quality:'fast',language:'en',wordsPerCaption:5,vad:{threshold:.5}}});directStore.updateJob('partial',{result_json:{candidateCaptions:[{id:'new',start:.2,end:.4,text:'new',words:[{id:'x',text:'new',start:.2,end:.4,rawConfidence:.8,reviewScore:.8,needsReview:false,reviewStatus:'approved',timingSource:'whisper',spaceBefore:true}]}],range:{start:.2,end:.4},languageCode:'en',actualProfile:{mode:'cpu',activeProfile:'fast'},applied:false}});directDb.close();
  const partial=await request('/api/transcriptions/partial');assert.equal(partial.candidateCaptions[0].text,'new');const applied=await request('/api/transcriptions/partial/apply',{method:'POST',headers:{'content-type':'application/json'},body:'{}'}),appliedWords=applied.captions.flatMap(caption=>caption.words);assert.deepEqual(appliedWords.filter(word=>word.id!=='x').map(word=>[word.id,word.start,word.end]),[['a',0,.2],['c',.4,.8]]);
  let render=await request(`/api/projects/${project.id}/exports`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({style:{effect:'sentence',animation:'fade'}})});for(let index=0;index<100&&render.status!=='complete';index++){await wait(100);render=await request(`/api/exports/${render.id}`);if(render.status==='failed')throw new Error(render.error)}assert.equal(render.status,'complete');const download=await fetch(base+render.downloadUrl);assert.ok((await download.arrayBuffer()).byteLength>1000);
  await request(`/api/projects/${project.id}`,{method:'DELETE'});console.log('API smoke passed: project, waveform, caption persistence, partial preview/apply, render job, download, delete');
}finally{child.kill();await wait(200);await rm(dataDir,{recursive:true,force:true})}

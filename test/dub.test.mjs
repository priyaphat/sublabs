import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { atempoChain, durationFitStatus, findDubOverlap, numberToThaiWords, parsePronunciationRules, prepareTtsText, validateDubControls, validateDubExport, validateDubRange, validateDubText } from '../lib/dub.mjs';
import { openDatabase, projectStore } from '../lib/db.mjs';

test('dub validation accepts a standalone range without captions and rejects overlap',()=>{
  const project={duration:10},range=validateDubRange(project,1,2.5);
  assert.deepEqual(range,{start:1,end:2.5});
  assert.equal(validateDubText('  พูด เอง ได้เลย  '),'พูด เอง ได้เลย');
  assert.equal(findDubOverlap([{id:'a',start_time:2,end_time:4}],{start:3.5,end:5}).id,'a');
  assert.equal(findDubOverlap([{id:'a',start_time:2,end_time:4}],{start:4,end:5}),null);
});

test('duration fit only time-stretches inside the natural limit',()=>{
  assert.equal(durationFitStatus(2,3).status,'fit');
  assert.equal(durationFitStatus(3.3,3).status,'stretch');
  assert.equal(durationFitStatus(4,3).status,'needs_edit');
  assert.match(atempoChain(1.1),/^atempo=1\.10000$/);
});

test('pronunciation rules and Thai number reading prepare text before synthesis',()=>{
  const rules=parsePronunciationRules('SubLabs = ซับแล็บส์\nAI => เอไอ\nไม่ใช่กฎ');
  assert.deepEqual(rules,[{from:'SubLabs',to:'ซับแล็บส์'},{from:'AI',to:'เอไอ'}]);
  assert.equal(numberToThaiWords('21'),'ยี่สิบเอ็ด');
  assert.equal(numberToThaiWords('12.5'),'สิบสองจุดห้า');
  assert.equal(prepareTtsText('SubLabs มี 12.5 คลิป ใช้ AI',rules),'ซับแล็บส์ มี สิบสองจุดห้า คลิป ใช้ เอไอ');
});

test('dub controls stay inside natural limits and reserve speech time',()=>{
  assert.deepEqual(validateDubControls({speed:2,pauseBefore:-1,pauseAfter:.4,slotDuration:2}),{speed:1.15,pauseBefore:0,pauseAfter:.4});
  assert.throws(()=>validateDubControls({pauseBefore:.5,pauseAfter:.4,slotDuration:1}),/ยาวเกินพื้นที่/);
});

test('dub export rejects unfinished, oversized and overlapping clips',()=>{
  const ready={id:'a',start_time:0,end_time:1,status:'ready',fit_status:'fit',audio_path:'a.wav'};
  assert.deepEqual(validateDubExport([ready]).map(item=>item.id),['a']);
  assert.throws(()=>validateDubExport([{...ready,status:'failed'}]),/ยังไม่พร้อม/);
  assert.throws(()=>validateDubExport([{...ready,fit_status:'needs_edit'}]),/ยาวเกินช่วง/);
  assert.throws(()=>validateDubExport([ready,{...ready,id:'b',start_time:.5,end_time:1.5,audio_path:'b.wav'}]),/ซ้อน/);
});

test('voice presets, dub clips and jobs persist and recover independently from captions',async()=>{
  const directory=await mkdtemp(path.join(tmpdir(),'sublabs-dub-')),file=path.join(directory,'test.db'),now=new Date().toISOString();
  let db=openDatabase(file),store=projectStore(db);
  store.create({id:'p',name:'x.mp4',file:'x',mediaUrl:'/x',width:640,height:360,duration:5,hasAudio:false,createdAt:now});
  store.createVoice({id:'v',name:'ลุง',createdAt:now});
  store.createVoiceStyle({id:'s',voiceId:'v',emotion:'กวน',referenceText:'ข้อความอ้างอิง',referencePath:'ref.wav',previewUrl:'/ref.wav',createdAt:now});
  store.updateDubSettings('p',{pronunciations:[{from:'SubLabs',to:'ซับแล็บส์'}]});
  store.createDubClip({id:'c',projectId:'p',start:1,end:2,text:'SubLabs 21',spokenText:'ซับแล็บส์ ยี่สิบเอ็ด',voiceStyleId:'s',speed:1.1,pauseBefore:.1,pauseAfter:.2,createdAt:now});
  store.createDubTake({id:'t1',clipId:'c',takeIndex:1,status:'ready',audioPath:'take-1.wav',audioUrl:'/take-1.wav',actualDuration:.6,fitStatus:'fit',seed:123,createdAt:now});
  store.createDubTake({id:'t2',clipId:'c',takeIndex:2,status:'generating',seed:456,createdAt:now});
  store.updateDubClip('c',{selectedTakeId:'t1',audioPath:'take-1.wav',audioUrl:'/take-1.wav',actualDuration:.6,fitStatus:'fit',status:'ready'});
  store.createDubJob({id:'j',projectId:'p',clipId:'c',status:'running',progress:20,label:'running',createdAt:now});
  db.close();
  db=openDatabase(file);store=projectStore(db);
  assert.equal(store.get('p').has_audio,0);
  assert.equal(store.get('p').dubPronunciations[0].to,'ซับแล็บส์');
  assert.equal(store.getVoice('v').styles[0].emotion,'กวน');
  const clip=store.listDubClips('p')[0];
  assert.equal(clip.spoken_text,'ซับแล็บส์ ยี่สิบเอ็ด');
  assert.equal(clip.speed,1.1);
  assert.equal(clip.pause_before,.1);
  assert.equal(clip.selected_take_id,'t1');
  assert.equal(clip.takes.length,2);
  store.recoverJobs();
  assert.equal(store.getDubJob('j').status,'failed');
  assert.equal(store.getDubClip('c').status,'ready');
  assert.equal(store.getDubTake('t2').status,'failed');
  db.close();await rm(directory,{recursive:true,force:true});
});

test('custom style presets persist and can be deleted independently from main presets',async()=>{
  const directory=await mkdtemp(path.join(tmpdir(),'sublabs-style-preset-')),file=path.join(directory,'test.db'),now=new Date().toISOString();
  const db=openDatabase(file),store=projectStore(db);
  store.createStylePreset({id:'custom',name:'สไตล์ของฉัน',style:{font:'Tahoma',fontSizePct:8},source:'user',createdAt:now});
  const saved=store.getStylePreset('custom');
  assert.equal(saved.name,'สไตล์ของฉัน');
  assert.deepEqual(saved.style,{font:'Tahoma',fontSizePct:8});
  assert.equal(store.listStylePresets().length,1);
  store.deleteStylePreset('custom');
  assert.equal(store.getStylePreset('custom'),undefined);
  db.close();await rm(directory,{recursive:true,force:true});
});
